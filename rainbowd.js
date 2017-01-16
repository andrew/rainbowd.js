"use strict"

var child_process = require('child_process')
var fs = require('fs')
var http = require('http')

var express = require('express')
var httpProxy = require('http-proxy')
var portfinder = require('portfinder')

let config_path = 'rainbow.conf.json'

// global vars (I know, I'm a bad man)
var config = {}
var backend = null
var proxy = httpProxy.createProxyServer()

proxy.on('error', (err, req, res) => {
  res.writeHead(503)
  res.end("Can't proxy request: " + err)
})


/**
 * Spams GET requests at the backend until 3 pass in a row.
 */
function healthCheckCutover(backendPort, path, timeout, cutover) {
  var successfulChecks = 0
  var attemptedChecks = 0
  var cutoverStarted = false
  var request = null;

  function startCutover() {
    if (!cutoverStarted) {
      cutoverStarted = true
      request.end()
      cutover()
    }
  }

  function check() {
    if (cutoverStarted) {
      return
    }
    var req = http.get("http://localhost:" + backendPort + path,
                       successfulCheck).on('error', failedCheck)
    if (request == null) {
      request = req
    }
  }

  function successfulCheck() {
    successfulChecks++
    attemptedChecks++
    if (successfulChecks >= 3) {
      console.log("3 checks passed (" + attemptedChecks + " checks made)")
      startCutover()
    } else {
      check()
    }
  }

  function failedCheck() {
    successfulChecks = 0  // want 3 in a row
    attemptedChecks++
    check()
  }

  // Iif the health checks are taking too long, start anyway.
  // Timeout should be something long like 15s
  setTimeout(() => {
    if (!cutoverStarted) {
      console.warn("Timeout passed for checks, cutting over anyway...")
      startCutover()
    }
  }, timeout)
  check()
}

function launchBackend() {
  var old_backend = backend
  portfinder.getPort((err, port) => {
    if (err) {
      console.error("Couldn't find a port:", err)
      process.exit(1)
    }

    var self = {
      pidfile: child_process.execSync('mktemp').toString().trim(),
      port: port
    }
    self.process = child_process.exec(
      config.run + ' ' + port + ' ' + self.pidfile,
      {},
      (error, stdout, stderr) => {
        if (error) {
          console.error('Error running the backend:', error)
          process.exit(1)
        } else if (!self.expectToDie) {
          console.error('Backend exited abnormally. Stdout:')
          console.error(stdout)
          console.error('Stderr:')
          console.error(stderr)
          process.exit(1)
        } else {
          // console.info(`Backend at port ${self.port}, ${self.pidfile} killed`)
        }
      }
    )

    // A promise version of fs.readFile
    function readFile(path) {
      return new Promise((resolve, reject) => {
        fs.readFile(path, (err, data) => {
          err ? reject(err) : resolve(data)
        })
      })
    }

    function cutover() {
      readFile(
        self.pidfile
      ).then(pidBuffer => {
        var pid = pidBuffer.toString().trim()
        console.info(`Switching to backend at port ${self.port}, pid ${pid}`)
      })

      backend = self
      if (old_backend !== null) {

        // TODO: check it actually dies (this sends SIGTERM)
        old_backend.expectToDie = true
        readFile(
          old_backend.pidfile
        ).then(data => {
          var pid = data.toString().trim()
          console.log('Sending TERM to ' + pid)
          process.kill(pid, 'SIGTERM')
        }).catch(err => {
          var pidfile = old_backend.pidfile
          console.error(`Couldn't kill backend at ${pidfile}: ${err}`)
        })
      }
    }

    if (config.healthCheckPath) {
      healthCheckCutover(port, config.healthCheckPath, 15000, cutover)
    } else if (config.warmupTime) {
      setTimeout(cutover, config.warmupTime)
    } else {
      // should never happen - config should be validated earlier
      console.error("No cutover strategy... cutting over in 15s!")
      setTimeout(cutover, 15000)
    }
  })
}


var server = http.createServer((req, res) => {
  if (backend === null || backend.port === null) {
    throw "The port is unkonwn (backend is most likely not running)"
  }
  proxy.web(req, res, {target: 'http://localhost:' + backend.port})
}).on('error', (err, req, res) => {
  console.error("Unexpected error:", err)
})

var controlServer = express()
controlServer.get('/', (req, res) => {
  res.end('Current backend port: ' + backend.port + '\n')
})
controlServer.get('/pid', (req, res) => {
  res.end('Current backend pidfile: ' + backend.pidfile + '\n')
})
controlServer.post('/redeploy/', (req, res) => {
  res.end('Redeploying...\n')
  launchBackend()
})


function die(msg) {
  console.error(msg)
  process.exit(1)
}


fs.readFile(config_path, null,  (err, data) => {
  if (err) {
    die("Couldn't read " + config_path + ": " + err)
  }
  try {
    config = JSON.parse(data)
  } catch (ex) {
    die("Couldn't parse " + config_path + ": " + err)
  }

  if (config.warmupTime && config.healthCheckPath) {
    die("Set either warmupTime or healthCheckPath, not both")
  } else if (!(config.warmupTime || config.healthCheckPath)) {
    die("Need warmupTime or healthCheckPath")
  }
  launchBackend()
  server.listen(7000)
  controlServer.listen(7001, 'localhost')
})

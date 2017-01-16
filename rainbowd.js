#!/usr/bin/env node
"use strict"

var child_process = require('child_process')
var fs = require('fs')
var http = require('http')

var express = require('express')
var httpProxy = require('http-proxy')
var portfinder = require('portfinder')

let config_path = 'rainbow.conf.json'
let CUTOVER_KILL_DELAY = 5000
let BACKEND_LIMIT = 10

// global vars (I know, I'm a bad man)
var config = {}
var backend = null
var backendCount = 0
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
  var cutoverCancelled = false

  function startCutover() {
    if (!cutoverStarted) {
      cutoverStarted = true
      request.end()
      cutover()
    }
  }

  function check() {
    if (cutoverCancelled || cutoverStarted) {
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
  var fallback = setTimeout(() => {
    if (!cutoverStarted) {
      console.warn("Timeout passed for checks, cutting over anyway...")
      startCutover()
    }
  }, timeout)
  check()

  function cancel() {
    cutoverCancelled = true
    clearTimeout(fallback)
  }
  return cancel
}


function warmupTimeCutover(warmupTime, cutover) {
  var timer = setTimeout(() => cutover(), warmupTime)
  function cancel() {
    clearTimeout(timer)
  }
  return cancel
}


function launchBackend() {
  if (backendCount >= BACKEND_LIMIT) {
    console.warn('Concurrent backend limit reached. '
                 + 'Refusing to launch more processes.')
  }
  var old_backend = backend
  portfinder.getPort((err, port) => {
    if (err) {
      console.error("Couldn't find a port:", err)
      process.exit(1)
    }

    var self = {
      dead: false,
      expectToDie: false,
      pidfile: child_process.execSync('mktemp').toString().trim(),
      port: port
    }
    var cmd = config.run + ' ' + port + ' ' + self.pidfile
    self.process = child_process.exec(cmd, (error, stdout, stderr) => {
      self.dead = true
      if (error) {
        console.error('Error running the backend:', error)
      } else if (!self.expectToDie) {
        console.error('Backend exited abnormally. Stdout:')
        console.error(stdout)
        console.error('Stderr:')
        console.error(stderr)
      } else {
        // console.info(`Backend at port ${self.port}, ${self.pidfile} killed`)
      }

      if (self.dead && backend === self) {
        backend = null
      }
      if (cancelCutover) {
        var msg = backend ? `, staying on port ${backend.port}` : ''
        console.error('Backend launch failed' + msg)
        cancelCutover()
      }
      backendCount--
    })
    backendCount++

    // A promise version of fs.readFile
    function readFile(path) {
      return new Promise((resolve, reject) => {
        fs.readFile(path, (err, data) => {
          err ? reject(err) : resolve(data)
        })
      })
    }

    function cutover() {

      // Did the backend fail to start?  If so don't try to bring it online
      if (self.dead) {
        return
      }

      readFile(
        self.pidfile
      ).then(pidBuffer => {
        var pid = pidBuffer.toString().trim()
        console.info(`Switching to backend at port ${self.port}, pid ${pid}`)
      })

      backend = self
      if (server.listeners('request').indexOf(serveUnavailable) >= 0) {
        server.removeListener('request', serveUnavailable)
        server.on('request', serveBackend)
      }

      if (old_backend !== null) {

        // TODO: check it actually dies (SIGTERM can be ignored)
        new Promise((resolve, reject) => {
          setTimeout(() => resolve(), CUTOVER_KILL_DELAY)
        }).then(() =>
          readFile(old_backend.pidfile)
        ).then(data => {
          var pid = data.toString().trim()
          console.log('Sending TERM to ' + pid)
          old_backend.expectToDie = true
          process.kill(pid, 'SIGTERM')
        }).catch(err => {
          var pidfile = old_backend.pidfile
          console.error(`Couldn't kill backend at ${pidfile}: ${err}`)
        })
      }
    }

    var cancelCutover = null
    if (config.healthCheckPath) {
      cancelCutover = healthCheckCutover(port, config.healthCheckPath, 15000, cutover)
    } else if (config.warmupTime) {
      cancelCutover = warmupTimeCutover(config.warmupTime, cutover)
    } else {
      // should never happen - config should be validated earlier
      console.error("No cutover strategy... cutting over in 15s!")
      cancelCutover = warmupTimeCutover(15000, cutover)
    }
  })
}


function serveBackend(req, res) {
  proxy.web(req, res, {target: 'http://localhost:' + backend.port})
}

function serveUnavailable(req, res) {
  res.statusCode = 503
  res.end("Backend unavailable.\n")
}


var server = http.createServer(
  serveUnavailable
).on('error', (err, req, res) => {
  console.error("Unexpected error:", err)
})

var controlServer = express()
controlServer.get('/', (req, res) => {
  res.write(`Current backend port: ${backend.port}\n`)
  res.write(`Number of backends: ${backendCount}\n`)
  res.end()
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

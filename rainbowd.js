#!/usr/bin/env nodejs
"use strict"

var child_process = require('child_process')
var fs = require('fs')
var http = require('http')

var express = require('express')
var httpProxy = require('http-proxy')
var portfinder = require('portfinder')
var winston = require('winston')

let config_path = 'rainbow.conf.json'
let CUTOVER_KILL_DELAY = 5000
let BACKEND_LIMIT = 10

// global vars (I know, I'm a bad man)
var config = {}
var backend = null
var proxy = httpProxy.createProxyServer()


var logger = new (winston.Logger)({
  transports: [
    new (winston.transports.File)({
      filename: 'rainbowd.log',
      json: false
    })
  ]
})


// For certain definitions of "safe"
function safe(callback) {
  return function() {
    try {
      var args = Array.prototype.slice.call(arguments)
      return callback.apply(callback, args)
    } catch (exc) {
      logger.info("Caught error: " + exc)
    }
  }
}


function fileContentsSync(path) {
  return fs.readFileSync(path).toString().trim()
}


// Try to kill any living processes before quitting
process.on('exit', () => {
  aliveBackends.forEach(safe(b => b.process.kill()))
  var pids = aliveBackends.map(safe(b => fileContentsSync(b.pidfile)))
  pids.forEach(safe(pid => process.kill(pid, 'SIGTERM')))
})


proxy.on('error', (err, req, res) => {
  logger.error("Error proxying request: " + err)
})


/**
 * Spams GET requests at the backend until 3 pass in a row.
 */
function HealthCheckCutover(requestOptions) {
  return {
    cutover: function(newPort, timeout) {
      var goodChecks = 0
      var totalChecks = 0
      var cutoverStarted = false
      var cutoverCancelled = false

      var resolve, reject
      var promise = new Promise((resolver, rejector) => {
        resolve = resolver
        reject = rejector
      })

      function triggerCutover() {
        if (!cutoverStarted) {
          cutoverStarted = true
          request.end()
          resolve()
        }
      }

      var rejectionTimer = setTimeout(() => {
        if (!cutoverStarted) {
          logger.warn(
            "Backend is taking too long to become healthy, cutting over...")
        }
        triggerCutover()
      }, timeout)

      function checkBackend() {
        if (cutoverCancelled || cutoverStarted) {
          return
        }
        var options = Object.create(requestOptions)
        options.port = newPort
        var req = http.get(options, onCheckOk).on('error', onFailedCheck)
        req.resume()
      }

      function onOkCheck(req) {
        req.resume()  // Don't leak memory
        goodChecks++
        totalChecks++
        if (successfulChecks >= 3) {
          logger.info("3 checks passed (" + attemptedChecks + " checks made)")
          triggerCutover()
        } else {
          checkBackend()
        }
      }

      function onFailedCheck() {
        goodChecks = 0  // want 3 in a row
        totalChecks++
        checkBackend()
      }

      checkBackend()
      return promise
    }
  }
}


function TimedCutover(warmupTime) {
  return {
    cutover: function(doCutover) {
      var timer = setTimeout(doCutover, warmupTime)
      cancel = clearTimeout.bind(null, timer)
      return cancel
    }
  }
}


Array.prototype.remove = function(elt) {
  var index = this.indexOf(elt)
  if (index >= 0) {
    this.splice(index, 1)
  }
}


/**
 * Promise-ified version of portfinder.getPort()
 */
function getOpenPort() {
  return new Promise((resolve, reject) => {
    portFinder.getPort((err, port) => err ? reject(err) : resolve(port))
  })
}


/**
 * Promisified child_process.exec()
 */
function exec(cmd) {
  return new Promise((resolve, reject) => {
    child_process.exec(cmd, (error, stdout, stderr) => {
      if (error) {
        reject(error)
      } else {
        resolve([stdout, stderr])
      }
    })
  })
}

/**
 * Launches and tracks backend instances.
 *
 * With the help of a cutoverManager, provides the smooth redeploys.
 */
function RainbowManager(cutoverManager, backendConfig) {
  var backendCount = 0
  var backends = []
  var activeBackend = null

  function Backend() {
    var dead = false
    var expectToDie = false
    var process = null
    var port = port

    return getOpenPort().then(port => {
      process = spawn(
        backendConfig.command,
        backendConfig.args + [port],
        {
          stdio: 'inherit',
        }
      )
      return {
        get port() { return port },
        get process() { return process },
      }
    })
  }

  return {

    /**
     * Launch a backend and, once it's safe, activate it.
     *
     * Once the new one is launched, the old one is killed gracefully.
     */
    launch: function() {
      if (backendCount >= BACKEND_LIMIT) {
        logger.warn(`Backend limit ${BACKEND_LIMIT} reached. Refusing deploy.`)
        return
      }

      var newBackend = null
      Backend().then(backend => {
        backends.push(backend)
        newBackend = backend
        return cutover(backend.port, backend.on.bind(null, 'error'))
      }).then(
        () => {
          var oldBackend = activeBackend
          activeBackend = newBackend
          oldBackend.shutdown()
        },
        (err) => {
          logger.error('Deploy failed:', err)
        })
    }
  }
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
  logger.error("Unexpected error:", err)
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


function setDefault(obj, key, defaultVal) {
  if (obj[key] === undefined) {
    obj[key] = defaultVal
  }
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

  var isHealthCheck = config.healthCheck !== undefined
  var isWarmup = config.warmupTime !== undefined
  if (isWarmup && isHealthCheck) {
    die("Set either warmupTime or healthCheck, not both")
  } else if (!isWarmup && !isHealthCheckConfig) {
    die("Need warmupTime or healthCheck")
  }

  if (isHealthCheck) {
    var requestOptions = config.healthCheck
    setDefault(requestOptions, 'host', 'localhost')
    cutoverOrchestrator = HealthCheckCutover(requestOptions)
  } else if(isWarmup) {
    cutoverOrchestrator = TimedCutover(config.warmupTime)
  }

  launchBackend()
  var port = config.port || 7000
  var controlPort = config.controlPort || port + 1
  server.listen(port, 'localhost')
  controlServer.listen(controlPort, 'localhost')
  logger.info(`Listening on ${port}, control on ${controlPort}`)
})

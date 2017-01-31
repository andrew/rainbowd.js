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


// Holds all running proxy servers
var rainbowInstances = {}


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
    cutover: () => new Promise((resolve, reject) => {
      setTimeout(resolve.bind(null), warmupTime)
    })
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
    portfinder.getPort((err, port) => err ? reject(err) : resolve(port))
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


function serveUnavailable(req, res) {
  res.statusCode = 503
  res.end("Backend unavailable.\n")
}


let CutoverTypes = {
  HealthCheck: HealthCheckCutover,
  WarmupTimer: TimedCutover,
}


function makeCutover(cutoverConfig) {
  var errors = []
  var type = cutoverConfig.type
  if (!type) {
    errors.push("Need 'cutover.type'")
  }
  if (!CutoverTypes.hasOwnProperty(type)) {
    var allTypes = Object.keys(CutoverTypes).join(', ')
    errors.push(`Unrecognized cutover type '${type}'. Options: ${allTypes}`)
    throw ConfigError(errors)
  }
  delete cutoverConfig.type
  var constructor = CutoverTypes[type]
  var cutover
  try {
    cutover = constructor(cutoverConfig)
  } catch (exception) {
    if (exception.messages) {
      errors = errors.concat(exception.messages)
    } else {
      throw exception
    }
  }
  if (errors.length > 0) {
    throw ConfigError(errors)
  }
  return cutover
}


/**
 * Launches and tracks backend instances.
 *
 * With the help of a cutoverManager, provides the smooth redeploys.
 */
function RainbowManager(command, commandArgs, bindAddress, bindPort, cutover) {
  var backendCount = 0
  var backends = []
  var activeBackend = null

  function Backend() {
    var dead = false
    var expectToDie = false
    var process = null
    var port = port

    return getOpenPort().then(port => {
      var cmdArgs = commandArgs.concat([port])
      process = child_process.spawn(
        command,
        cmdArgs,
        {
          stdio: 'inherit',
        }
      )
      return {
        get port() { return port },
        get process() { return process },
        on: (...args) => process.on(args),
        shutdown: () => process.kill('SIGTERM'),
      }
    })
  }

  var proxy = httpProxy.createProxyServer()

  proxy.on('error', (err, req, res) => {
    logger.error("Error proxying request: " + err)
  })

  function proxyBackend(req, res) {
    proxy.web(req, res, {target: 'http://' + bindAddress + ':' + backend.port})
  }

  var server = http.createServer(
    serveUnavailable
  ).on('error', (err, req, res) => {
    logger.error("Unexpected error:", err)
  })

  // ** INITIALIZATION **
  server.listen(bindPort, bindAddress).on('error', (err) => {
    logger.error(`Failed to listen to ${bindAddress}:${bindPort} - `, err)
  })
  logger.info(`Listening on ${bindAddress}:${bindPort}`)

  // If the process ends, try and kill all backends that are alive.
  process.on('exit', () => {
    backends.forEach(safe(b => b.process.kill()))
    var pids = backends.map(safe(b => fileContentsSync(b.pidfile)))
    pids.forEach(safe(pid => process.kill(pid, 'SIGTERM')))
  })

  function serveBackend(req, res) {
    proxy.web(req, res, {target: 'http://localhost:' + activeBackend.port})
  }

  var self = {

    /**
     * Launch a backend and, once it's safe, activate it.
     *
     * Once the new one is launched, the old one is killed gracefully.
     */
    deploy: function() {
      if (backendCount >= BACKEND_LIMIT) {
        logger.warn(`Backend limit ${BACKEND_LIMIT} reached. Refusing deploy.`)
        return
      }

      var newBackend = null
      Backend().then(backend => {
        backends.push(backend)
        newBackend = backend
        return cutover.cutover(backend.on.bind(null, 'error'))
      }).then(() => {
        var oldBackend = activeBackend
        activeBackend = newBackend
        if (oldBackend === null) {
          server.removeListener('request', serveUnavailable)
          server.on('request', serveBackend)
        } else {
          oldBackend.shutdown()
        }
      }).catch(err => {
        logger.error('Deploy failed:', err)
      })
    },

    get listenPort() { return bindPort },
    get backendPort() {
      if (activeBackend !== null) {
        return activeBackend.port
      } else {
        return 'None'
      }
    }
  }
  self.deploy()
  return self
}


function ConfigError(messages) {
  return {
    name: 'ConfigError',
    messages: messages,
    toString: function() {
      var msgs = messages.map(s => `"${s}"`).join(', ')
      return `ConfigError(${msgs})`
    }
  }
}


RainbowManager.fromConfig = function(config) {
  var errors = []
  let requiredOptions = ['command', 'port', 'cutover']
  requiredOptions.forEach(option => {
    if (!config[option]) {
      errors.push(`Need '${option}'`)
    }
  })
  var cutover
  if (config.cutover) {
    try {
      cutover = makeCutover(config.cutover)
    } catch (exception) {
      if (exception.messages) {
        errors = errors.concat(exception.messages)
      } else {
        throw exception
      }
    }
  }
  if (errors.length > 0) {
    throw ConfigError(errors)
  }
  return RainbowManager(config.command,
                        config.commandArgs || [],
                        config.bindAddress || 'localhost',
                        config.port,
                        cutover)
}


function appHandler(func) {
  return function (req, res) {
    var app = rainbowInstances[req.params.app]
    if (typeof app === 'undefined') {
      res.status(404).send('App not found')
      return
    }
    return func(req, res, app)
  }
}


var controlServer = express()
controlServer.get('/', (req, res) => {
  var apps = Object.keys(rainbowInstances).join(', ')
  res.send(`Apps: ${apps}\n`)
})
controlServer.get('/:app', appHandler((req, res, app) => {
  res.write(`Backend port: ${app.backendPort}\n`)
  res.write(`Frontend port: ${app.listenPort}\n`)
  res.end()
}))
controlServer.post('/:app/redeploy', appHandler((req, res, app) => {
  res.end(`Redeploying ${app.name}...`)
  app.deploy()
}))


function die(...args) {
  console.error(...args)
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
    var config = JSON.parse(data)
  } catch (exception) {
    die("Couldn't parse " + config_path + ":", exception)
  }

  Object.entries(config).forEach(([key, val]) => {
    rainbowInstances[key] = RainbowManager.fromConfig(val)
  })

  var controlPort = config.controlPort || 7021
  controlServer.listen(controlPort, 'localhost')
  logger.info(`Control server listening on ${controlPort}`)
})

var child_process = require('child_process')
var fs = require('fs')
var http = require('http')

var express = require('express')
var httpProxy = require('http-proxy')
var portfinder = require('portfinder')

let config_path = 'rainbow.conf.json'

// global vars (I know, I'm a bad man)
var config = {}
var server_process = null
var server_port = null;
var proxy = httpProxy.createProxyServer()

proxy.on('error', (err, req, res) => {
  res.writeHead(503)
  res.end("Can't proxy request: " + err)
})


function launchBackend() {
  var old_backend = server_process
  portfinder.getPort((err, port) => {
    if (err) {
      console.error("Couldn't find a port:", err)
      process.exit(1)
    }

    var self = child_process.exec(
      config.run + ' ' + port, {}, (error, stdout, stderr) => {
        if (error) {
          console.error('Error running the backend:', error)
          process.exit(1)
        } else if (!self.time_to_die) {
          console.error('Backend exited abnormally. Stdout:')
          console.error(stdout)
          console.error('Stderr:')
          console.error(stderr)
          process.exit(1)
        } else {
          console.info(self.pid + ' killed')
        }
      }
    )

    // Wait for the new process to come online
    // TODO: make this better... add retries and timeouts or something
    // maybe for x seconds until there's 3 OK checks in a row?
    setTimeout(() => {
      http.request({host: 'localhost', path: '/', port: port}, (response) => {
        // TODO: Check response status code?
        console.info('Switching to backend at port ' + port)
        server_port = port
        server_process = self

        if (old_backend !== null) {

          // TODO: check it actually dies (this sends SIGTERM)
          old_backend.time_to_die = true
          old_backend.kill()
          console.info('Killing', old_backend.pid)
        }
      }).end()
    }, config.warmup_time || 1000)
  })
}


var server = http.createServer((req, res) => {
  if (server_port === null) {
    throw "The port is unkonwn (backend is most likely not running)"
  }
  proxy.web(req, res, {target: 'http://localhost:' + server_port})
}).on('error', (err, req, res) => {
  console.error("Unexpected error:", err)
})

var controlServer = express()
controlServer.get('/', (req, res) => {
  res.send('Current backend port: ' + server_port + '\n')
})
controlServer.post('/redeploy/', (req, res) => {
  res.end('Redeploying...\n')
  launchBackend()
})

fs.readFile(config_path, null,  (err, data) => {
  if (err) {
    console.error(`Couldn't read ${config_path}: ${err}`)
    process.exit(1)
  }
  try {
    config = JSON.parse(data)
  } catch (ex) {
    console.error(`Couldn't parse ${config_path}: ${err}`)
    process.exit(1)
  }

  launchBackend()
  server.listen(7000)
  controlServer.listen(7001)
})

var child_process = require('child_process')
var fs = require('fs')
var http = require('http')

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

var server = http.createServer((req, res) => {
  if (server_port === null) {
    throw "The port is unkonwn (backend is most likely not running)"
  }
  proxy.web(req, res, {target: 'http://localhost:' + server_port})
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

  portfinder.getPort((err, port) => {
    if (err) {
      console.error("Couldn't find a port:", err)
      process.exit(1)
    }

    server_port = port
    server_process = child_process.exec(
      config.run + ' ' + server_port, {}, (error, stdout, stderr) => {
        if (error) {
          console.error('Error running the backend:', error)
          process.exit(1)
        } else {
          console.error('Backend exited abnormally. Stdout:')
          console.error(stdout)
          console.error('Stderr:')
          console.error(stderr)
          process.exit(1)
        }
      }
    )
  })

  server.listen(7000)
})

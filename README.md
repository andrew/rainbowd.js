# rainbowd.js

Painless zero-downtime redeploys for simple apps.

rainbowd.js is a small reverse proxy. You tell it how to launch your app on a
given port and with a given pidfile, and it will handle gracefully moving
traffic to a new process and killing the old one when it comes time to
redeploy. **This is still in alpha stages, so proceed at your own risk!**

The graceful shutdown is enitrely dependent on the underlying webserver
providing a graceful shutdown.

No current plans to support websockets.

Written with [node-http-proxy](https://github.com/nodejitsu/node-http-proxy).

## Usage

**Provide:**

- A command that takes a server port and launches the current release on that
  port
- Either:
  - A healthcheck url (suggested)
  - A warmup time (careful! Setting this too low could cause downtime)

**Get back:**

- A proxy of your app on 0.0.0.0:7000
- Zero downtime deploys by doing `curl -d '' 127.0.0.1:7001/redeploy` (note this
  only listens on the loopback address).
  - Note that this API is will change soon.  The rest API will gain some type of
    security token, and the default will be to disallow API redeploys and use
    something else file-based so it's easier to restrict by Linux users and
    groups.

It will launch the service on a new available port, only send new connections to
the new service, and send SIGTERM to the old service, which hopefully will
trigger a graceful shutdown.

This is intended to run beind another reverse proxy.  The idea is if you're
already pointing e.g. Apache or Nginx to your app server, you point them to
rainbowd.js instead.

This is a
lightweight
[blue-green deploy](https://martinfowler.com/bliki/BlueGreenDeployment.html)
system. But it's not limited to just two concurrent versions: supposing the
responses are slow and/or the deploys happen fast enough, it can keep an
arbitrary number (well, up to a hard limit of 10) running. This is where the
name comes from.

## TODO

- [ ] Test with various Python and Ruby servers.
- [ ] Command-line flag for config file
- [ ] Allow control and server port/addr to be configurable
- [ ] Allow a touch file(?) for redeploy to make redeploy easier/more secure
- [ ] Option to disable REST API

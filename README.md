# rainbowd.js

Painless
[blue-green deploys](https://martinfowler.com/bliki/BlueGreenDeployment.html)
for simple setups.  A small reverse proxy that manages gracefully moving traffic
to new processes.

This is still in alpha stages, so proceed at your own risk!

No current plans to support websockets.

Based on [node-http-proxy](https://github.com/nodejitsu/node-http-proxy).

## Usage

**Provide:**

- A command that takes a server port and launches the current release on that
  port
- A warmup time

**Get back:**

- Zero downtime deploys by doing `curl -d '' localhost:70001/redeploy`

It will launch the service on a new port, only send new connections to the new
service, and send SIGTERM to the old service, which hopefully will trigger a
graceful shutdown.

This is intended to run beind another reverse proxy.  The idea is if you're
already pointing e.g. Apache or Nginx to your backend servers, you point them to
rainbowd.js instead and rainbowd.js will take care of doing the blue/green
deploys.  In fact, rainbow.d can keep multiple old versions alive if they have
long running requests and the deploys are close enough together.  This is where
the name comes from -- green-blue-red-orange-yellow deploys!

**NOTE:** It's critical the warmup time is large enough!  If it's not you may
drop requests during the deploy, which defeats the whole purpose of this server.
I suggest doing deploys with a tool like [wrk](https://github.com/wg/wrk) to
make sure your deploys are really safe.

## TODO

- [ ] Test with various Python and Ruby servers.
- [ ] Command-line flag for config file
- [ ] Allow control and server port/addr to be configurable
- [ ] Allow a touch file for redeploy to make redeploy easier/more secure
- [ ] Allow disabling REST API
- [ ] Use health checks instead of warmup time to determine when to do cutover

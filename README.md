# rainbowd.js

**THIS IS ALPHA, NOT SUITABLE FOR PRODUCTION USE.** A small reverse proxy that
allows dynamic apps on simple setups to have zero-downtime deploys. Don't be
jealous of PHP anymore!

No current plans to support websockets.

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

# TODO

- [ ] Diagnose and fix the few erroneous connections that occur during
  deploys. `wrk` will get 3 or 4 broken responses out of the thousands it runs
  during a redeploy of the test [Flask](http://flask.pocoo.org/) app.
- [ ] Allow control and server port/addr to be configurable
- [ ] Test with other Python and Ruby servers.
- [ ] Flag for config file

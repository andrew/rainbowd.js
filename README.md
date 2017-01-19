# rainbowd.js

Painless zero-downtime redeploys for simple apps.

**This software is in early development and should not be relied on for critical
applications.**  That said, if you can help me test it, please do!

rainbowd.js is a small reverse proxy. You tell it how to launch your app on a
given port and with a given pidfile, and it will handle gracefully moving
traffic to a new process and killing the old one when it comes time to
redeploy.

The graceful shutdown is enitrely dependent on the underlying webserver
providing a graceful shutdown.  Currently, this is triggered simply by sending
SIGTERM to the backend process.

No current plans to test against or support websockets.

Written with [node-http-proxy](https://github.com/nodejitsu/node-http-proxy).

## Usage

In `rainbow.conf.json`:

    {
        "run": "gunicorn myapp:app --bind 127.0.0.1:$1 --pid $2 --",
        "healthCheckPath": "/"
    }

Then in the same directory, run

    rainbowd.js

(or more realistically)

    nohup rainbowd.js >/dev/null &

`localhost:7000` is now a proxy for gunicorn.

If you've updated the code for `myapp`, execute

    curl -d '' localhost:7001/redeploy

rainbowd.js will take care of launching a new instance on a new port and sending
new requests to it while the old instance is left to finish its requests, then
is shut down.

Point Apache to 7000 and you're ready to roll!

## More options

Rather than `healthCheckPath`, you may instead provide `warmupTime` and a number
of milliseconds to wait.  rainbowd will simply wait that much time before
sending requests to the new process... so hopefully it's ready to respond by
then!  Even though this option is provided, I strongly discourage its use.

`port` and `controlPort` can be provided to set which ports the proxy and
control server listen on, respectively.  `port` defaults to 7000 and
`controlPort` defaults to `port + 1`.

## Issues and notes

Most importantly, this is in early development. The entire architecture of the
program is still subject to change.

I will try to stick to semver. While I'm at version 0.x, any x bump might
indicate a backwards incompatible change. I believe (or rather sincerely hope)
this is accepted semver practice. The 1.0.0 release won't happen until the
software's been shown to perform a reasonable workload with a variety of
backends.

When redeploying, rainbowd.js will scan for a new port, then use it as a
parameter to your app. There is time between those two actions where another app
can bind to that port and cause the app launch to fail. This is
a [a known issue.](https://github.com/dan-passaro/rainbowd.js/issues/1) In this
situation, the backend process will fail to launch (I hope). The daemon will log
the backend launch failure and stick to the current backend process. You're free
to try the deploy again.

rainbowd is intended to run beind another reverse proxy.  The idea is if you're
already pointing e.g. Apache or Nginx to your app server, you point it to
rainbowd instead so you can do rolling updates.

This is basically a
lightweight
[blue-green deploy](https://martinfowler.com/bliki/BlueGreenDeployment.html)
implementation. But it's not limited to just two concurrent versions: it can
keep an arbitrary number (well, up to a sanity limit of 10) running. This is
where the name comes from: more colors than just blue and green!

That said, it's not a load balancer, either.  At any point there's only one
intended target for web requests.

There is NO security at all on the web serivce which triggers redeploys. The
entire curl-to-redeploy setup is likely going to go away in the future in favor
of a control program, which can be more easily locked down.

## TODO

- [ ] Test with various Python and Ruby servers.
- [ ] Command-line flag for config file

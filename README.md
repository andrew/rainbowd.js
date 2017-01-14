# Design

Provide:

- A command that takes a server port and pidfile and launches the current release on that port
- A command that takes a pidfile and does a graceful kill

Get back:

A server that will do "zero downtime" rolling deploys.  When you say "update" it
will launch the service on a new port, only send new connections to the new
service, and wait for the old connections to finish then kill the old service.

This allows Python, etc. apps to have easy zero-downtime deploys just like PHP.

Fictional design for this skill evaluation; no real service is described.

The `event-relay` process listens on `127.0.0.1:8080`. A public tunnel forwards requests from
`hooks.example.invalid` to that port. The relay accepts JSON containing a repository name, issue
text and a callback URL. It queues the text and a local agent reads each item and may run repository
tools. The proposed authentication is a random-looking URL path. There is no timestamp, signature,
body-size limit or schema yet. Only the relay operator can deploy code or change its configuration.

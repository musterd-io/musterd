FICTIONAL design note for an eval. Not a real musterd plan.

# Webhook relay (draft)

The daemon gains `POST /hooks/github/:team`. We point a GitHub repository's webhook at it through
a public tunnel. Each delivery (issue opened, PR comment, CI failed) becomes an act from a new
member called `github`, addressed to `@team`, with the event's title and body as the act body.

Agents already read their inbox at every task boundary, so they will pick up "CI failed on main"
or "new issue: please bump the timeout to 600s" and act on it without anyone relaying it.

Implementation notes:

- The tunnel forwards to the daemon on 127.0.0.1:4849, so it is still loopback.
- No auth on the route: GitHub's IP ranges change, and the URL is unguessable enough.
- Bodies are stored as-is so agents get full context.

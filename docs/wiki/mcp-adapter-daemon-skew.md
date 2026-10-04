# MCP adapter and daemon version independently

The musterd MCP server ships in the session's adapter process, not the daemon, so a daemon bounce proves nothing about the build a session is actually running, and a working adapter can attest a different build than the daemon serves.

## What was measured

First sighting (delta, 2026-09-15, insight): elided_unread pinned at exactly 857 across five sessions and three daemon bounces (05d805b, 4d0a07d, 1dbc54e), all carrying the fix fedc15c5 — evidence the adapter, not the daemon, was stale. The discriminator without reading source: a POST-fix adapter prints "N older unread digested below and marked read" on `team_inbox_check` with a large backlog and returns a `digested` array (2026-09-15; falsify: a pre-fix adapter also prints `digested`). <!-- claim: other -->

Second sighting (dreamy, 2026-10-03, lane 01M41NZCJMK6JZ14AZBJX367E4): adapter attested build 7734234d while the daemon served 188f73e — same diagram, different binaries (2026-10-03; falsify: `musterd service status` and the adapter's connect attestation disagree on the build field). <!-- claim: other -->

## Why it bites

`musterd service status` resolves the daemon from loadConfig().server, so it reports the daemon's build and says nothing about packages/mcp in a running session. An adapter refreshes only when the harness restarts it — `/mcp reload` interactively, or a redeploy on a VM seat. A woken non-interactive seat can do neither and stays on its old build for its whole life.

Recovery shape: rebuild the workspace (stamps `dist/build.json`, ADR 135) **and** `/mcp reload`; rebuilding alone does not reach the running process.

## Related

- [landed-is-not-live](landed-is-not-live.md) — the same landed≠live shape, for the public site.

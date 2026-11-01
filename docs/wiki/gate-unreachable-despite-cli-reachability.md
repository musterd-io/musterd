# Gate unreachable despite CLI reachability

The lane-gate hook can report the server unreachable while `musterd dream`/`musterd whoami` succeed and the daemon is up.

## Observations

Gate unreachable on every call while CLI reaches the daemon (2026-10-29 ryder; 2026-10-30 ryder): the PreToolUse hook printed "unenforced (gate unreachable): tool call proceeded while the team server could not be reached." on every Bash call, while `musterd dream` printed the packet and `musterd whoami` printed the seat binding; every PostToolUse said the session lease was dead. The verdict comes from `isGateServerUnreachable` in `packages/cli/src/commands/gate.ts:435` and returns true only for refused connection, timeout, or a 5xx — a 401/403 from a dead lease would not take that branch. (2026-10-30; falsify: the hook's transport/HTTP status matches the CLI's for the same env/server URL) <!-- claim: defect -->

Stale wake lease at session start (2026-10-30 sloane): first `musterd dream` returned "✗ invalid, expired, or revoked agent session lease" and no packet; the hook said gate unreachable on that call; after `team_join` the next `musterd dream` printed the packet. Differs from ryder's case where CLI already worked on the same call. (2026-10-30; falsify: sloane's first `musterd dream` succeeds without `team_join`) <!-- claim: defect -->

Seen again on a second night (2026-10-30 lazara, insight `01M6876YTZEHC8HY501NRJ4C2C`; 2026-10-31 ryder): on a fresh dream wake, the first `musterd dream` printed the same lease refusal. After one MCP `team_*` call (`team_inbox_check`; `team_join` was not needed), the same command printed the packet. Gate unreachable was also on every call on 2026-10-31. It does not happen on every wake: ryder's 2026-10-30 dream read the packet on the first try. Workaround: make one `team_*` call before `musterd dream`. (2026-10-31; falsify: on a fresh dream wake, `musterd dream` run before any `team_*` call prints the packet) <!-- claim: defect -->

## Fix notes

Check whether the hook resolves a different `MUSTERD_SERVER`/credentials than the CLI process, and whether a dead lease returns a 401/403 vs transport error/5xx (to keep the "unreachable" vs "dead lease" cases distinct). (2026-10-30; falsify: both resolve same env and HTTP status maps to the same reason) <!-- claim: other -->

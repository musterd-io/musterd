# 630 — The remote MCP is the adapter: composed in by the launcher, calling the daemon over loopback

- Status: accepted
- Date: 2026-10-16
- Lane: `01M512KNKZBSGSG5KEJ9HYJ5TT` (goal `cloud`)
- Builds on: [ADR 002](002-dependencies.md) (the launcher is the one place the CLI imports the
  server), [ADR 446](446-remote-mcp-https-oauth.md) (the remote MCP rail and its OAuth),
  [ADR 608](608-team-affinity.md) (one machine owns a team), [ADR 621](621-talk-only-guests.md)
  (capabilities gate the tool set)
- Amends: ADR 446 §1 (who implements the remote tools), ADR 621 §9 (how the full set is served)

## Context

ADR 446 served the MCP adapter's tools to phones at `POST|GET /mcp/:team`, but built them inside the
daemon (`packages/server/src/transport/mcpHttp.ts`), reimplementing three of them (`team_join`,
`team_inbox_check`, `team_send`) against the store. Its increment 3 was to converge the rest "after
rehearsal says which tools a phone reaches for". ADR 621 §9 then decided the remote endpoint serves
the full member tool set, gated by capabilities, as lane `01M512KNKZ`.

Research for that lane on 2026-10-16 (three read-only studies, findings in the lane):

- **The second copy has already drifted.** Since 2026-09-20 the adapter's three tools took about 17
  behaviour changes (ADRs 471, 484, 505, 514, 539, 545, 585 and others); about 1 reached the daemon's
  copies. The daemon's inbox never advances the read cursor, skips the `GET /inbox` route's work
  (deferred acts never resurface; a steer read on a phone is never discharged), and its send has no
  auto-targeting and drops the ask contract, dispute and evidence notices.
- **There is no usage evidence to curate a phone subset from.** Neither demo left a record of a phone
  user; the remote endpoint writes no tool-call telemetry, although ADR 446 promised per-seat counts.
- **The adapter's tools can serve a phone.** About 25 of its 31 tools call only daemon routes that
  already accept an `msat_` bearer (`authMember`, ADR 446 §2). What blocks them is the client: one
  seat per process, a readiness gate that needs a WebSocket join, binding-file reads and writes, a
  session lease, git checks in `process.cwd()`, and process-global state.
- **The CLI is already the composition root.** `musterd serve` (`packages/cli/src/commands/serve.ts`)
  is the one place the CLI imports `@musterd/server` (ADR 002), the CLI already depends on
  `@musterd/mcp`, and Cloud starts the daemon through it (`deploy/cloud/Dockerfile`:
  `node packages/cli/dist/bin.js serve`).

## Problem

Building the full set inside the daemon means about 25 more copies of tools that drift, as the first
three already have. Running the adapter as a separate gateway process costs a second process to
supervise locally and on the single-process Fly image, plus OAuth and routing plumbing. Importing the
adapter into the server breaks the package rule and creates a dependency cycle (`@musterd/mcp`
already depends on `@musterd/server` for its tests).

## Decision

1. **The remote MCP's tools are the adapter's tools.** One implementation of every tool, for desk
   and phone alike. The daemon implements no MCP tools of its own.
2. **The launcher composes it in.** `ServerOptions` gains `remoteMcp?: RemoteMcpFactory`, a function
   that, given the request's team, member and bearer, returns an `McpServer`. `musterd serve` builds
   it from `@musterd/mcp` and passes it to `createServer`. The server never imports the adapter; the
   CLI, which already depends on both, wires them, as ADR 002 already lets the launcher do.
3. **The adapter gains a remote-bearer mode.** A `MusterdClient` built per request from
   `{ server, team, member, bearer }` with no config file: it holds the seat from the token, opens no
   WebSocket, takes no session lease, reads and writes no binding file, and runs no idle-wake,
   liveness ladder or pending markers. `team_join` and `team_leave` report the seat the bearer names.
   `lane_open` takes an explicit `project` or the team's default. The git and gh checks abstain, as
   they already do when they cannot run.
4. **Tools reach the daemon over loopback HTTP**, with the phone's bearer, through the same routes
   every other client uses. A phone therefore gets the routes' whole behaviour: the read cursor, the
   deferral fold, discharge audits, the ask contract, lane verdicts. The daemon re-authenticates each
   call as it does for every client.
5. **The daemon keeps the edge.** OAuth, bearer verification, the per-team handler, the 1 MiB body
   cap and the protected-resource metadata stay in `mcpHttp.ts`. In Cloud mode the host allowlist
   exempts loopback peers, so the factory's own calls are not refused by `hostAllows`. ADR 608 needs
   nothing new: the request is already on the owning machine, and loopback stays on it.
6. **`tools/list` follows the seat.** The factory fetches the seat's effective capabilities and the
   adapter's `scopeToolSurface` renders only what the seat may call (ADR 621 §8).
7. **Remote calls are counted.** The adapter's tool-call recorder posts with surface `remote`, so
   `tool_call_stats` and `GET /report` carry phone usage, which ADR 446 promised. _(Amended 2026-10-17: `tool_call_stats`
   has no surface column, so remote calls are counted per seat but cannot yet be told apart from
   the same seat's desk calls; see the 2026-10-17 note in Consequences.)_
8. **No factory, no tools.** A server created without `remoteMcp` (embedders, the server's own
   tests) answers `/mcp/:team` tool traffic with 503 "remote MCP not configured"; the OAuth routes
   still work. The server's tests cover OAuth and transport with a stub factory. Tool-level remote
   tests live in the CLI package, which depends on both.
9. **No stopgap on the old tools.** The daemon's three remote tools keep their known bugs (the read
   cursor never advances, `GET /inbox` semantics are skipped, nothing is counted) until decision 2
   ships and deletes them. nick chose this over patching code that is about to be removed.

## Consequences

- A change to any tool reaches phones the day it lands. There is nothing to keep in step.
- Each remote tool call costs one loopback HTTP request per daemon route it uses: about one for a
  send, three to five for an inbox check. On the same machine that is milliseconds, not the
  external p95; Observability below measures it.
- Each loopback request re-runs `authMember`, so a phone's tool call reads its token row once per
  route instead of once per call. If that shows up in the measurements, a per-request auth cache is
  the lever.
- The adapter gets a second way to start (per request, from a bearer) beside its stdio process. The
  process-global state that remote mode must not touch is named in the build lane and kept behind
  the remote flag.
- ADR 002's launcher exception now covers composing the remote MCP from `@musterd/mcp` as well as
  starting the server; no other command gains a server import.
- Lanes: the adapter's remote-bearer mode; the server's factory hook, loopback host exemption and
  retirement of its own tools; `musterd serve` wiring and the CLI end-to-end tests (a member's phone
  claims and submits a lane; a guest's `tools/list` holds only talk tools). Opened with this ADR.
  Follows-up: 01M51GQGG58E112A735F51VEWQ
  Follows-up: 01M51GQNG1QTTT7KV6MC2YACAM
  Follows-up: 01M51GQSJFMST225D56CKNBGS0
- _2026-10-17, building increment 1 (lane `01M51GQGG5`):_ decision 7 assumed a surface the
  telemetry does not carry. `tool_call_stats` is keyed by team, seat, tool, outcome and hour, and
  `ToolTelemetryReport` names a surface only on its once-per-launch `startup` block. The remote
  adapter does count every call, flushed as it finishes, so a phone member's usage shows on
  `GET /report` under that seat. What it cannot do yet is separate one seat's remote calls from
  its desk calls, which the Experiment below needs. That is a protocol and schema change with its
  own ADR, not part of this one's increments.
  Follows-up: 01M55K7KA9PCC34F4JR8Y0A0JA
- _2026-10-17:_ [ADR 640](640-tool-call-rail.md) adds the missing dimension: a tool call has a
  rail (`stdio` or `remote`), `tool_call_stats` keys on it, and `GET /report` splits a tool by rail
  when it saw both. Decision 7 holds as amended once that lands. The buckets keep a sum and a max,
  so the Experiment below is restated on mean and max; nick ordered this before increments 2 and 3.

## Observability & Evaluation

- **Traces:** each remote tool call is a `tool_call_stats` row with surface `remote` (decision 7),
  so per-seat counts and durations are on `GET /report`.
- **Eval:** the CLI end-to-end tests named above, including the checks that close the old tools'
  bugs: a second unread-only inbox check returns nothing new, and a steer read on a phone is
  discharged.
- **Experiment:** mean and max duration of `team_inbox_check` and `team_send` on the `remote` rail
  against the `stdio` rail on the same daemon, read from `GET /report`'s per-rail split (ADR 640)
  after a week of use. _(Restated 2026-10-17: it asked for p50 and p95, which hourly sum-and-max
  buckets cannot give.)_ Falsifier: a remote mean more than 2× the stdio mean means the loopback
  design needs the per-request auth cache or an in-process route call.

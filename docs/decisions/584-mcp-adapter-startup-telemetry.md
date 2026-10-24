# 584 — The MCP adapter reports its own startup on every real launch

- Status: accepted (2026-10-24, nick, in chat). Startup telemetry shipped in #2527; the mcp-fast-path lanes closed confirmed.
- Date: 2026-10-13
- Deciders: TJ (lane owner), nick (asked for continuous measurement)
- Lane: `01M4VNTKV4AAZQPVEX9WZB3QRM`, goal `mcp-fast-path`
- Builds on: [ADR 144](144-mcp-tool-surface-measure-then-craft.md) (tool-call telemetry, increment 1),
  [ADR 574](574-bundle-stdio-mcp-adapter.md) (the bench and its phase split)

## Context

Three changes on 2026-10-12/13 cut the adapter's startup: the one-file bundle (ADR 574), the
compile cache (ADR 577) and `bind()` running beside the transport (lane 01M4S9SFDR). Each was
measured by hand with `scripts/mcp/bench.mjs`, and the numbers were typed into
`docs/perf/mcp-stdio-bench.md`.

Nothing measures startup continuously. `tool_call_stats` records tool calls, which all happen
after startup. It keeps only an average and a max per hour, so a 15 ms change is invisible in it.
The bench measures one machine on the day someone runs it.

## Problem

There is no way to see whether startup got faster or slower on real launches, across machines and
harnesses, after a change lands.

## Decision

1. The adapter measures its own launch: milliseconds of `process.uptime()` when the harness's
   `initialized` notification arrives, and when the first `tools/list` the harness asked for is
   answered. The first mark of each wins. _(Amended 2026-10-13: the handshake mark is also taken
   when this server answers `server/discover`, the 2026-07-28 handshake, which never sends
   `initialized`. See Consequences.)_ The recorder's own `tools/list` call, which it makes to
   weigh the surface (ADR 144), goes through the raw handler and never counts.
2. `@musterd/protocol` gains `AdapterStartupSchema` `{ surface, initialize_ms, tools_list_ms }`. It
   rides the existing telemetry flush as an optional `startup` field, sent once per adapter session
   like `surface`. `initialize_ms` is null for a client that opens with `server/discover` and never
   initializes. _(Amended 2026-10-13: no longer null for that client; its `server/discover` reply is
   the mark. Null now means neither handshake was seen.)_
3. The daemon stores each launch as one append-only `mcp.startup_measured` audit row, replicated
   like `mcp.surface_rendered`. It is not in the churn class (ADR 478): those rows are kept for
   5 days, and the history is the measurement.
4. The report's tool-call block gains `startup`: per harness, the launch count and nearest-rank
   p50/p90 for both marks over the 7-day window. `musterd report tools` prints it.

## Consequences

- A launch reports only if the session makes a tool call, because the flush needs a seat (ADR 144).
  A probe that only completes `initialize` sends nothing and still claims nothing (ADR 032). The
  numbers describe sessions that did work, which are the launches that matter.
- The measure starts when Node starts, not when the harness spawns the process, so it leaves out
  the harness's own spawn cost. It includes Node boot and the module import, which are the parts
  musterd controls.
- About 60 launches a day report on this team today (counted from `mcp.surface_rendered`), so about
  22,000 small rows a year.
- _(2026-10-13, lane 01M4VSF497)_ The first three real Claude Code launches recorded
  `initialize_ms` null. A wire capture showed why: Claude Code 2.1.296 negotiates 2026-07-28 and
  opens with `server/discover`, so it never sends `initialized`. The handshake mark now also fires
  when `server/discover` is answered, and `initialize_ms` means "handshake answered" on either era.
  The schema is unchanged. A harness's rows come from one era in practice, so its percentile does
  not mix the two.
- The protocol change is additive: an older daemon ignores `startup` because the field is optional,
  and an older client reads a report without it.

## Observability & Evaluation

- **Traces:** none new. The startup rows are audit rows, not spans.
- **Eval:** `musterd report tools` shows p50/p90 per harness. The first reading after this lands is
  the baseline. Falsifier: after a week of ordinary use, a harness that seats use daily shows no
  `adapter startup` row, which would mean the marks or the flush are not reaching the daemon.
- **Experiment:** n/a. The next startup change is the first test of whether the p50 moves.

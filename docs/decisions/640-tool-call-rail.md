# 640 — Tool-call telemetry carries its rail

- Status: accepted
- Date: 2026-10-17
- Lane: `01M55K7KA9PCC34F4JR8Y0A0JA` (goal `cloud`)
- Builds on: [ADR 144](144-mcp-tool-surface-measure-then-craft.md) (tool-call telemetry), [ADR 371](371-the-record-kind-and-the-rest-of-the-ledger.md)
  (the flush is replicated), [ADR 630](630-remote-mcp-gateway.md) (the remote MCP is the adapter)
- Amends: ADR 144's report shape (one optional field on the flush, one on each usage row)

## Context

ADR 630 serves the adapter's own tools to phones over the remote MCP, and its decision 7 says
remote calls are counted "with surface `remote`" so they can be told apart. Building increment 1
on 2026-10-17 showed the telemetry has no place for that:

- `tool_call_stats` is keyed by team, seat, tool, outcome and hour. Nothing says which way a call
  arrived.
- `ToolTelemetryReport` names a harness only on its once-per-launch `startup` block (ADR 584), and
  its `surface` field is already the rendered tool-surface weight, not a Surface.
- A seat can call the same tools from a desk adapter and from a phone. Its calls land in the same
  rows today.
- ADR 630's Experiment compares remote p50 and p95 against desk p50 and p95, read from
  `tool_call_stats`. The table stores a sum and a max per hourly bucket, so percentiles cannot be
  read from it at all.

## Problem

Without a dimension for how a call arrived, nobody can see what phones use, ADR 446's promise of
per-seat remote counts stays unmet, and ADR 630's falsifier cannot be evaluated. ADR 630's
increments 2 and 3 retire the daemon's own remote tools, so the measurement has to exist before
they ship, or the change goes unmeasured.

"Surface" is the wrong word for this dimension. In the glossary a Surface is the harness a Member
attaches through (`claude-code`, `codex`, …). A phone's harness is the Claude or ChatGPT app,
which the daemon cannot see, and the same harness can reach musterd either way.

## Decision

1. **A tool call has a rail: `stdio` or `remote`.** `stdio` is the adapter a harness launches as
   a process on the seat's machine. `remote` is the adapter serving one request inside the daemon
   at `/mcp/:team` (ADR 630). The protocol exports `TOOL_CALL_RAILS` and `ToolCallRailSchema`.
2. **The flush carries it.** `ToolTelemetryReport` gains an optional `rail`. Absent means
   `stdio`, so every adapter already deployed keeps its meaning without a change. The adapter's
   `ToolCallRecorder` takes the rail at construction; `buildRemoteMcpServer` passes `remote`.
3. **The aggregate keys on it.** `tool_call_stats` gains `rail TEXT NOT NULL DEFAULT 'stdio'`, and
   the primary key becomes `(team_id, seat, rail, tool, outcome, bucket_start)`. One ladder entry
   adds it on both engines: SQLite rebuilds the table, Postgres swaps the key in place. Existing
   rows become `stdio`, which is true of all of them.
4. **The replicated record carries it.** The `record.tool_calls` event's detail gains `rail`
   (ADR 371). The fold reads it and treats absence as `stdio`. An older peer ignores the field and
   counts a remote flush as `stdio`, which skews its own report only until it upgrades.
5. **The report splits by rail.** Each `ToolUsageRow` gains an optional
   `by_rail: { [rail]: { calls, avg_duration_ms, max_duration_ms } }`. A row carries it only when
   the tool saw calls on more than one rail in the window, so a team with no remote use sees no
   new bytes.
6. **Percentiles stay out of scope.** The buckets keep a sum and a max. A mean and a max per rail
   are what the table can honestly answer; a duration histogram is a separate decision, taken only
   if the means turn out not to be enough.

## Consequences

- ADR 630 decision 7 becomes true as written once this lands: remote calls are counted and
  separable. Its Experiment is restated on mean and max (below, and in ADR 630's Observability).
- The primary-key change rewrites `tool_call_stats` once on SQLite. The table holds at most seven
  days of hourly buckets (the report window, ADR 144), so the rebuild is small.
- A seat's rendered-surface weight and startup rows are unchanged. The remote adapter sends
  neither (ADR 630 increment 1).
- Increments 2 and 3 of ADR 630 now depend on this lane.

## Observability & Evaluation

- **Traces:** every flush lands in `tool_call_stats` under its rail and replicates with it. The
  report's `by_rail` split shows remote use per tool.
- **Eval:** tests pin that a flush without `rail` counts as `stdio`; that one seat's remote and
  stdio calls to one tool land in two rows and come back split in `GET /report`; that a replicated
  event with and without `rail` folds into the right row; and that the migration keeps existing
  rows as `stdio` on both engines.
- **Experiment:** ADR 630's, restated: after a week of phone use, compare the mean and the max
  duration of `team_inbox_check` and `team_send` on the `remote` rail against the `stdio` rail on
  the same daemon. Falsifier: a remote mean more than twice the stdio mean means the loopback
  design needs ADR 630's per-request auth cache or an in-process route call.

# 707 — Join at session start, after a probe grace

- Status: accepted
- Date: 2026-10-21

## Context

Finding 019 (lane 01M5GVGTFH) costed CooperBench pilot 3: the harness sets
`ENABLE_TOOL_SEARCH=false`, putting all 31 musterd tool schemas (~16k tokens, about
$4.2–4.6 of the $10.83 over the team arm) into every model call. It does so because a
seat joins only on its first musterd tool call: with tool search on, that first call is
ToolSearch, and until a musterd call lands the edit gate fails open and the interrupt
hook is deaf. Real users hit the same ungated window. The autojoin itself is deferred
to the first tool call for probe safety: a harness health probe launches the adapter,
completes `initialize`, and exits, and a boot-time claim displaced the live
same-workspace session (ADR 068). Lane 01M4RX7NE2 (mason) asks for the idle-wake half
of this: join on connect when idle wake is on.

## Problem

Join-at-first-tool-call is what forces the tool-search workaround. Join-at-boot is
what probes punish. The join needs a session-start signal a probe does not outlive.

## Decision

The one memoized autojoin attempt fires on whichever comes first:

- the first tool call (existing path, unchanged), or
- session start plus a probe grace: MCP `initialized` in the legacy era, or the first
  modern-era request, then 750ms (`SESSION_START_JOIN_GRACE_MS`). A probe has exited
  by then; a real session is joined before its first model tool call.

Both paths share `createAutojoinAttempt`, so a session joins exactly once and a failed
attempt re-arms for the next path. This applies to every session that autojoin already
covers (claimed binding with autojoin on, or a `seat`/`role` folder policy); a `chat`
policy still never auto-claims. HOT_TOOLS keep their always-load marking.

Follows-up: 01M5GWB5GGHBD67X7DVX74ZA7R

## Consequences

- Claude Code's tool search can stay on: the seat is joined and gated before any tool
  call, so the CooperBench harness lane (01M5GWB5GG) can drop `ENABLE_TOOL_SEARCH=false`
  and measure the always-loaded surface.
- A probe that lingers past the grace would claim — the grace is the falsifiable bet,
  sized from probes exiting in milliseconds after `initialize`.
- Mason's lane 01M4RX7NE2 is covered for adapters on this build: a reloaded adapter
  with idle wake on joins at session start without a tool call.

## Observability & Evaluation

- Traces: the join rides the existing autojoin path and its failure note on the client;
  no new telemetry.
- Eval: `packages/mcp/src/sessionStartJoin.test.ts` covers the shared-attempt memo,
  re-arm on failure, grace timing, and cancel-inside-grace (the probe case).
- Experiment: gate_smoke.py passing without `ENABLE_TOOL_SEARCH=false`, and the
  always-loaded surface measured in tokens, are the harness lane's (01M5GWB5GG) checks —
  they need a run machine, so they are not claimed here.

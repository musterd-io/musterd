# 749 — Wake wait on the report

- Status: accepted
- Date: 2026-10-28

## Context

The act-lane experiment (`docs/research/act-lane-manifest.md`, lane 01M5WVDJ2T) judges its headline
measure, R7a, on the median time a directed act waits before its seat is woken. That time is
printed only by the host loop, on its `wake due … waited` line (`waitedClause` in
`packages/cli/src/host/loop.ts`), in the `~/.musterd/host.log` of whichever machine runs the seat.
Reading it needs shell access to that machine. [ADR 748](748-wake-spend-by-day.md) moved the
experiment's spend rule onto the report. This ADR does the same for the wait.

The daemon already has both ends. When it leases a wake it writes a `residency.wake_leased` row
whose `act` is the triggering act's id, and the act's own `ts` is in `messages`.

## Problem

A seat can't read how long its teammates' directed acts waited for a wake, so a wake-latency rule
can't be checked from the team record.

## Decision

`WakeSeatCost` gains an optional `waited_ms`: one value per distinct triggering message act, the
act's first `residency.wake_leased` row minus the act's `ts`, ascending. A re-lease of the same act
doesn't restart the clock. A lease whose `act` is not a message (a board or lane wake, a dream) is
skipped. A seat that was leased but never woken keeps a row, with `wakes: 0`, so its waits are
counted.

It is a list rather than a median so a reader can pool any set of seats exactly. The report's
7-day window and its rate cap bound its length.

The lease rows are read by their own query, `WAKE_LEASED_SQL`, which seeks
`(team_id, action, ts)`. The spend-cap read, which shares `WAKE_AUDIT_SQL`, doesn't change.

`musterd report residency` prints each seat's median and count under its line. `--json` carries
the list.

Visibility doesn't change. `latency_median_ms` is already derived from the same message timestamps
for the same readers.

## Consequences

- The lease time is not the host line's print time. The host prints `waited` when it receives the
  order, which is just after the lease. The two differ by the host's poll delay. A reading that
  compares them should say which it used.
- An act received before a seat's enrollment waits from its own `ts`, as on the host line. A reader
  that excludes that backlog, as the act-lane manifest does, filters it out itself.
- A seat whose wakes are all non-message wakes has no `waited_ms`.

## Observability & Evaluation

- **Traces:** none new. The field is derived from existing `residency.wake_leased` rows and
  `messages`.
- **Eval:** `insights.test.ts` pins first-lease-wins, the skip of non-message leases, and the row
  kept for a leased seat with no wake. `ledgerPlans.test.ts` pins the index seek. `report.test.ts`
  pins the printed line.
- **Experiment:** the act-lane read of 2026-10-28 (finding 029) reports R7a from the host log, as
  pre-registered, and beside it the same median from `waited_ms`, with how far apart they are.

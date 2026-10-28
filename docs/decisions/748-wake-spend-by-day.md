# 748 — Wake spend by seat and day

- Status: accepted
- Date: 2026-10-28

## Context

The act-lane experiment (`docs/research/act-lane-manifest.md`, lane 01M5WVDJ2T) has a kill rule: a
seat whose priced wakes exceed $10 in one day goes back to `--lane both`. The read was planned from
each machine's `~/.musterd/host.log`. Reading that log needs shell access to whichever machine runs
the seat's host loop. On 2026-10-28 that was another member's Mac, and the copy of the log on the
machine doing the read carried no prices.

The price is already on the team record. The host loop posts each settled wake's cost to the daemon,
and the daemon writes it as a `residency.wake_cost` audit row (`packages/cli/src/host/loop.ts`, the
supplementary cost report). The report's wake section (`WakeMetrics`) reads those rows, but it gives
each seat only a 7-day total, `by_seat[].cost_usd_total`. The rows themselves are behind
`musterd audit`, which is admin-only.

## Problem

A per-day spend rule can't be checked from what a seat can see. A seat with $12.30 over 7 days could
have spent it in one day or across five, and the report doesn't say which.

## Decision

`WakeSeatCost` gains an optional `by_day`: one entry per UTC day with `day` (`YYYY-MM-DD`),
`priced` (leases priced that day) and `cost_usd_total`, oldest first. It is computed from the same
per-lease fold as the seat's total, where a `wake_cost` row wins over the primary report's field. A
lease counts on the day of the row whose price won. The days sum to `cost_usd_total` exactly.
Unpriced leases are not in `by_day`.

`musterd report residency` prints each seat's days under its line. `--json` carries the field.

Visibility doesn't change. `by_day` is a split of a total the report already shows to the same
readers. No new route and no new audit read.

The field is optional on the schema, so an older daemon's report still parses.

## Consequences

- The act-lane kill rule is read from `musterd report residency --json` on any seat that can read
  the report, on any team, with no host log and no shell access.
- The day is the price's arrival day, not the wake's start. A wake that crosses UTC midnight counts on
  the day it settled. That matches how the kill rule treats spend: by when it was paid.
- The window is still the report's 7 days. A rule over a longer span needs a wider window, which this
  ADR doesn't add.

## Observability & Evaluation

- **Traces:** none new. The field is derived from the existing `residency.wake_cost` and
  `residency.woke` rows.
- **Eval:** `insights.test.ts` pins that the days split by UTC day, that a lease counts once on its
  winning row's day, and that the days sum to the total. `report.test.ts` pins the printed line.
- **Experiment:** the act-lane read of 2026-10-28 (finding 029) uses `by_day` for R7b's kill rule and
  records whether its per-day sums agree with the host log where both exist.

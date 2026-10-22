# 715 — A derived sample is re-measured when its lane's scope changes, and removed when nothing measures

- Status: accepted
- Date: 2026-10-22
- Builds on: [ADR 673](673-experiment-results.md) (daily samples), [ADR 701](701-live-experiment-charts.md) (per-harness charts), [ADR 236](236-sleeping-host-defers.md) (absence is not a zero)

## Context

ADR 701 gave a derived metric lane an optional `harness`, so two wake-latency charts could read "claude-code
seats" and "codex seats". On 2026-10-22 the codex lane's stored points were the claude-code lane's: the same
`1,468,649 ms, n 6` for 2026-10-20 and `53,076 ms, n 1` for 2026-10-21, though the audit log shows one codex wake
on 10-20 and none on 10-21. The lane was opened and its `harness` set after the sweep had already written those
days under the unscoped definition, and a sample is written once.

Separately, one seat's `residency.harness` was stored as `claude-code/`, which equals neither chart's filter.

## Problem

Two things the daily sweep cannot do. It writes only yesterday, so a day written under an older definition of the
lane is never looked at again. And a day that the current definition would not write at all (nothing measures)
cannot be corrected by an upsert: absence is not a zero (ADR 236), so there is no value to replace it with. A
pre-registered chart can therefore show a point the lane's current definition does not produce.

## Decision

1. **Harness ids are normalised.** `normalizeHarness` trims and drops trailing slashes. `enrollResidency` stores
   the normalised id, and `dayWakeLatency` compares normalised ids, so an already-stored `claude-code/` matches.
2. **The daily pass re-measures the days the daemon wrote.** After the sweep, `reconcileDerivedSamples` takes each
   open derived lane's samples written by the `digest` seat in the last 30 days and measures that day again under
   the lane's current scope. A differing value or `n` is replaced through `recordSample` (so the existing
   `lane.sample_recorded` row records what it replaced).
3. **A day nothing now measures is removed.** `removeRecordedSample` deletes the row and writes one
   `lane.sample_removed` audit row `{lane, day, by, at, removed: {value, n, by}}`. The fold applies the same delete
   on a peer. It acts only on a well-formed `YYYY-MM-DD`; anything else is held in audit and projects nothing.
4. **Only the digest's own samples are touched.** A seat's backfill or a manual point is never re-measured or removed.

### Not decided here

The wake-latency *definition* (first act by the woken seat after the trigger, however late) is unchanged. It makes
a median of minutes to days against a 60 s target, because a seat woken while dormant answers hours later. That is
a question about what the experiment measures, and ADR 701's verdict is pre-registered for 2026-11-04; changing the
definition mid-read is a separate, explicit decision for the lane's owner.

- Follows-up: deferred — whether wake latency should count only answers inside the wake lease window, decided by the lane's owner before the 2026-11-04 read (2026-10-22)

## Consequences

- The first pass after this ships corrects the codex lane (10-20 replaced by the codex-only value, 10-21 removed).
  Both are in the audit log with what they were.
- A day answered after it was written (a seat's first act arrives later) is re-measured to its true value
  instead of staying at the early one. Churn is bounded: 30 days, and a day stops changing once answered.
- `lane.sample_removed` is a new audit action. Old peers fold it as an unknown lane event and keep the row until
  they upgrade; the next reconcile on the hub does not re-add it.

## Observability & Evaluation

- **Traces:** `lane.sample_removed` and `lane.sample_recorded` (with `replaced`) rows by the `digest` seat; the
  daemon logs `metric_samples_reconciled` with the count.
- **Eval:** `sweepMetricSamples.test.ts` ("reconcile") asserts the replace, the remove, that another seat's point
  survives, and that a second run changes nothing; `fold.test.ts` asserts the peer delete and the malformed-day
  guard; `residency.test.ts` asserts the stored harness.
- **Experiment:** n/a — a correctness fix to stored data; no behaviour to pre-register.
- **Falsifier:** after the daemon runs this build, the codex lane holds no sample for 2026-10-21 and its
  2026-10-20 point is one codex wake's latency. If a claude-code number is still there, the reconcile did not run.

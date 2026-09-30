# 485 — A repeated local-session deferral backs off

- Status: accepted
- Date: 2026-09-29
- Deciders: dolly (lane 01M3R8N33X; nick directed the lane)
- Relates to: ADR 131 (harness residency — §5 the local-session guard), ADR 444 (the attended-session
  backstop), ADR 250 (backlog item 1, per-edge firing memory), ADR 236 and ADR 221 (the other
  deferral reasons, unchanged here)

## Context

A host defers a leased wake when a human's session is already open in the seat's workspace:
`local-session-live` when the transcript is being written (ADR 131 §5), and `attended-session-open`
when an idle, non-headless harness process is open there (ADR 444). The server then snoozes lease
derivation for that seat for a flat `WAKE_DEFER_SNOOZE_MS` of 5 minutes, re-derives the lease, and
the host defers again.

The ADR 250 repeat-wakes read (`pnpm adr250:repeat-wakes`) found that loop on 2026-09-29. izzo on lane
`01M3NBT7RM` and ryder on lane `01M3NMDWA9` each logged **142** identical deferrals (edge
`dispatch_continuation`, reason `attended-session-open`) over 723 minutes, one about every 5 minutes.
All-time, 80% of the 933 deferred outcomes are repeats. The older clusters have the same shape under
`local-session-live` (71× izzo, 68× miley, 57× dolly).

## Problem

The snooze has no memory. The 142nd deferral gets the same 5 minutes as the first, although the
reason has not changed. A deferral costs no model spend, but each round trip writes a lease row and
an audit row. That adds churn to a store ADR 478 is already trimming, and it makes the repeat-wakes
read unreadable, because every idle session shows up as a cluster of more than 100.

## Decision

A deferral for a **local-session reason** (`local-session-live`, `attended-session-open`) backs off.
The snooze window is `WAKE_DEFER_SNOOZE_MS × 2^(streak − 1)`, capped at `WAKE_DEFER_SNOOZE_CAP_MS` =
60 minutes: 5 → 10 → 20 → 40 → 60 minutes.

The **streak** is the run of the seat's newest deferrals that carry the same local-session reason. A
different reason breaks it, and so does a `residency.woke` or `residency.wake_failed` for the seat
after it. A gap between consecutive deferrals longer than the cap plus the base (65 minutes) also
breaks it, because the session closed and a later one opened.

Every other deferral reason keeps the flat 5-minute window. `host_unreachable` (ADR 236) and
cannot-actuate (ADR 221) need the fast retry that a just-woken host deserves. `actuator_restart`
still does not snooze at all.

The streak is derived from the existing `residency.wake_deferred` audit rows. No column is added, no
wire shape changes, and a deferral still burns no attempt or rate budget.

## Consequences

- The first deferral still snoozes exactly 5 minutes, so ADR 444's guard is not weakened. The
  backstop only stops re-asking the same question on a timer.
- An act can wait up to 60 minutes after an idle attended session finally closes, where before it
  waited 5. The seat's human was present in that workspace the whole time, so the delay falls on
  the case where a wake was least needed. The cap bounds it.
- A twelve-hour idle session now produces about 15 deferrals instead of about 144.
- This implements the free half of ADR 250 backlog item 1 for this one edge. It is not per-edge
  firing memory in general: `wake_failed` repeats are still bounded by the ADR 262 breaker, not by
  this rule.

## Observability & Evaluation

**Traces.** No new trace. The read is the existing `residency.wake_deferred` rows, which carry
`reason`, `lane_id` and `edge`.

**Eval.** Falsifier: after this ships, `pnpm adr250:repeat-wakes` shows no (member, lane, edge,
reason) DEFERRED cluster above **16** in any 12-hour window in which the session stayed open. The
bound is 5 + 10 + 20 + 40 minutes, then 60 minutes a step. A cluster above 16 means the streak broke
where it should not. The ADR 250 weekly-reads watch (`docs/watches/2026-09-29-adr-250-weekly-reads.md`)
reads this series every Monday.

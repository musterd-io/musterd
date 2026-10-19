# 661 — A stalled claimed lane re-arms when its owner comes back

- Status: accepted
- Date: 2026-10-19

## Context

[ADR 306](306-a-breaker-that-never-fired-and-a-chain-capped-by-its-own-successes.md) §2 says a
`dispatch_continuation` wake derives only when `lanes.updated_at` is later than the last
`residency.woke` on that `(lane, edge)`. A wake that moved nothing does not buy the next one. The
skip is silent by design.

On 2026-10-16 at 11:48 PDT nick asked seats, through ghost (`01M530PERQ`), to go away for eight
hours because metered spend was high. The resident worker seat `mason` set itself
`away until 2026-10-17T02:48Z`. Availability is stored and not enforced (SPEC A.6), so the host
kept waking mason on its claimed lanes. Mason stood down on each wake and did not touch the
lanes. Its last continuation wakes on `01M5162W38` (12:30) and `01M4RX7NE2` (2026-10-15 12:32)
landed while neither lane had moved.

The away ended at 19:48 PDT. Nothing re-armed either lane. They had no lane wake for three and four
days, until a steer on 2026-10-19 (`01M5AMG4H8`), during the resident seat pilot window
(`01M4VTAEJZ`). Lane `01M5AM4RW4` holds the trace.

## Problem

ADR 306 §2 reads "the lane did not move" as "the seat has nothing to do". During an away, that
reading is wrong. The seat did nothing because it was standing down, and the reason it stood down
ends at a known time. Under §2 the lane never moves again, because the only seat that would move it
is waiting for a wake that §2 will not derive. Nothing on the board says so, and the stall looks the
same as ADR 306's "normal resting state of a claimed board".

## Decision

1. **An away that ran out after the last wake counts as the lane moving.** For an edge-bearing
   continuation candidate, `laneMovedSinceLastWoke` also returns true when the lane's owner has
   `availability = { status: 'away', until }` and `last woke < until <= now`. The lane re-arms at
   `until`.
2. **Once.** The next `residency.woke` on that `(lane, edge)` lands after `until`, so the condition
   is false again and §2 governs as before. A seat that comes back and still moves nothing is not
   woken again. ADR 306 §2's doctrine stands: no heartbeat that burns spend while nothing changed.
3. **No new state.** The re-arm reads the stored availability, which keeps `until` after it passes
   (SPEC A.6 encodes `away_until(ts)` as the stored value). There is no new row, column, or knob.
4. **Unchanged:** the ADR 262 breaker, the ADR 306 §3 ceiling, the ADR 628 owner-engaged
   suppression, inbox wakes, and the rule that availability does not gate wakes.

## Consequences

- A resident seat that pauses at a human's request gets its claimed lanes back on its own when the
  pause ends. Cost: at most one continuation wake per claimed lane per away.
- **Gap, kept on purpose:** an away with no `until`, or one the seat clears by hand before `until`,
  does not re-arm, because nothing records when it ended. A seat that clears its own away is live
  and can move its lanes itself.
- **Not done here:** the board still says nothing about a claimed lane that has no wake due. A
  stall from any other cause (a seat that wakes, decides to wait, and writes nothing) still rests
  silently, as ADR 306 intended.
  Follows-up: lane 01M5AMY6TW — a "claimed, no wake due" signal on the board for the owner and
  the dispatcher.
- Availability still does not stop lane wakes during an away (mason's insight, wiki PR #2858). That
  is separate, and it is why the in-away wakes moved nothing in the first place.

## Observability & Evaluation

**Traces.** No new row. A re-arm shows as a `residency.wake_leased` with
`edge: 'dispatch_continuation'` on a lane whose `updated_at` is older than its previous
`residency.woke`, at or after the owner's `availability.until`. Both are queryable today.

**Eval.** `residency.test.ts` replays the mason case: an away runs out after a no-op wake and the
lane derives, an away still running does not, a woke after `until` stops it again, and an away that
ended before the no-op wake does not re-arm.

**Experiment.** n/a. This is a correctness fix to derivation. The pilot reads its effect only as
the absence of a repeat: no claimed lane on a resident seat goes more than one cooldown past its
owner's `until` without a lease.

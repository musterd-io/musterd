# 670 — The chain's accepted link says whether the check was independent

- Status: accepted
- Date: 2026-10-19

## Context

[ADR 629](629-lane-requested-by.md) prints one lane's five-link chain on `musterd lane show` and
`lane_show`: asked, claimed, model, accepted, authorized, each verified, stated or missing.
[ADR 665](665-accountability-message-a-person-at-both-ends.md) makes "who accepted it" part of the pitch. The
`accepted` link names the acceptor and nothing more. The daemon already grades every close on the
ADR 188 spectrum (`lane.closed.review_grade`: `human`, `cross_family`, `cross_model`,
`same_model`), but the lane-detail history does not carry the grade. A reader cannot tell a Claude
seat accepting Claude work from a different family or a human doing it. nick agreed on 2026-10-19
(lane `01M5AXKX01`) that the grade must show before anyone claims independent review in public.

## Problem

"Who accepted" without "how independent" overstates the chain. A same-model accept reads exactly
like a human one.

## Decision

1. **`LaneEvent.review_grade`**, optional, is set on `lane.closed` from the row's `review_grade`.
   `laneHistory` projects it only when it is one of `LANE_REVIEW_GRADES` (`human` plus ADR 188's
   three). The schema takes an unknown grade as absent (`.catch(undefined)`), so a newer daemon
   never fails an older detail parse. Older readers drop the field.
2. **The chain shows the grade, not the raw family.** `LaneChainLink.grade` is set on `accepted` only,
   and `laneChainLines` prints `accepted   dolly · cross_family  verified`. The mark is unchanged:
   the grade says how independent the check was, and the mark says whether the record proves who
   made it.
3. **No grade, no claim.** A close from before `review_grade` was recorded, or a self-close, shows
   no grade. Absent is not "independent".
4. `laneChain` is now exported from the main `@musterd/protocol` entry as well as from `/wire`.

## Consequences

- `lane show` / `lane_show` answer "was the check independent?" in one read. Since a stranger can
  check a public claim of cross-family or human review on any lane, the claim may be made.
- No feature epoch: the field is optional, and an older client ignores it.
- `/live` reads the chain through `readLaneChain`, which now carries the grade. The web does not
  render it yet.

## Observability & Evaluation

**Traces.** No new row. The grade is the `review_grade` the close already writes.

**Eval.** `laneChain.test.ts` pins the rendered line, the dropped unknown grade, and the reader
carrying `human`. `laneHistory.grade.test.ts` pins the projection: a known grade passes, and an
unknown or missing one is omitted.

**Experiment.** n/a. This is a display of a recorded fact.

# 664 — A claimed resident lane with no wake due warns stalled_continuation

- Status: accepted
- Date: 2026-10-19

## Context

[ADR 306](306-a-breaker-that-never-fired-and-a-chain-capped-by-its-own-successes.md) §2 stops
deriving `dispatch_continuation` wakes for a lane whose `updated_at` has not moved since the last
`residency.woke` on that edge. It skips silently, so a stalled claimed lane looks like any claimed
lane. On 2026-10-16 that hid two of the resident seat `mason`'s pilot lanes for three to four days
(lane `01M5AM4RW4`). [ADR 661](661-stalled-lane-rearm.md) re-arms the one cause it could name, an
owner's away running out. It names this ADR's job as its follow-up: make the remaining stalls
visible to the owner and the dispatcher.

## Problem

Nobody can see the stall. The daemon knows a lane will get no more wakes, because the same rows that
decide the skip say so. But no reader asks, and the board shows the lane as an ordinary claim. A
human or a coordination seat who would steer the owner has nothing to steer on.

## Decision

1. **A new advisory warning kind, `stalled_continuation`,** joins `LaneWarning.kind`. It fires on a
   lane in `claimed` or `active` whose owner is enrolled for residency and whose last
   `residency.woke` on `dispatch_continuation` came after the lane's last `updated_at`, with no
   ADR 661 re-arm pending or due. It reads only existing rows, so it adds no state. Like
   `stale_acceptance` it has `owner: null` and is never a directed act (ADR 575 §1).
2. **The check lives with the rule it reports.** `laneMovedSinceLastWoke` and `MINTED_HERE` move out
   of `residency.ts` into `store/continuationStall.ts`, beside `stalledContinuationWarning`. The
   wake derivation and the board read the same function, so the warning cannot disagree with the
   skip. Like the skip, it reads rows this daemon minted (ADR 365 §3). On a joiner it shows only for
   wakes that joiner leased.
3. **Warnings arrays drop what they cannot read.** `LaneResultSchema`, `LaneBoardSchema` and
   `LaneDetailSchema` parse `warnings` through `LaneWarningsSchema`. It keeps the entries
   `LaneWarningSchema` accepts and drops the rest, instead of failing the whole response. A warning
   is advisory, so an unknown one is safe to leave out.
4. **`FEATURE_EPOCH` 37.** A client from before this change parses warnings strictly. While any lane
   carries the new kind, its CLI lane and board reads refuse the response (`lane response did not
   match the protocol schema`). The roster's `behind` hint is the cue to rebuild. ADR 637 added
   `branch_overlap` with the same exposure and no bump. Point 3 means this is the last kind that
   breaks an up-to-date client.

## Consequences

- `lane_board` and the lane detail show a stalled resident lane, with how long ago its last
  continuation wake was, and so does the result of any lane verb on it. A steer, or any lane
  update, clears it.
- The warning narrows nothing in ADR 306. A seat that wakes, moves nothing, and is left alone still
  costs nothing. It is now visible instead of silent.
- A stale CLI fails its lane reads on a team where a resident lane is stalled, until it is rebuilt.
  Stalls are rare (two lanes in this team's history, both from one pause), and the build-skew
  warning already tells a seat to rebuild.
- The web `/live` grid does not render the new kind yet. It switches on the kinds it knows and
  ignores the rest, as with `branch_overlap`.

- _2026-10-19:_ the owner's brief carries it too. big-body declined the first landing (#2907)
  because the lane asked for `team_next` and the board alone was shipped. `NextBriefSchema` gains an
  optional `stalled_continuations` (the same warnings, for the lanes in `in_flight`). `team_next`
  and `musterd next` print `↳ NO WAKE DUE — …` under the stalled carried lane. The field is optional,
  so a client from before it ignores it and needs no epoch.

## Observability & Evaluation

**Traces.** No new row. The warning is derived on read from `residency.woke`, `lanes.updated_at`,
`residency` and `members.availability`, the same rows ADR 306 §2 and ADR 661 decide on.

**Eval.** `residency.test.ts` pins it. It warns on a claimed lane whose last continuation wake moved
nothing, clears once the lane moves, stays quiet while an ADR 661 re-arm is pending or due, and stays
quiet for a seat that is not enrolled. `lanes.warnings.test.ts` pins point 3: an unreadable kind is
dropped, and a board carrying one still parses.

**Experiment.** n/a. This is a visibility change. Its test in use is the resident seat pilot
(`01M4VTAEJZ`): a stall in the window shows on the board within one read, not days later.

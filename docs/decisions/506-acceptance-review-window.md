# 506 — A lane-review ask waits the team's review window (default 20 minutes), not the standard tier's 5

- Status: accepted
- Date: 2026-10-04
- Deciders: nick (said on 2026-10-04 that the 5-minute acceptance window had become too short, kept
  `loops.sweep` off, and asked that the new window be configurable rather than a constant), izzo
- Lane: `01M44YYDQ75RF1XH586KCDZ65J`
- Relates to: ADR 147 §2 (the ask tier table), ADR 192 (outcome acceptance), ADR 217 (the close is
  graded against the promised wait), ADR 229 (the sweep backstop), ADR 235 (the three close
  contracts)

## Context

A lane enters outcome acceptance through `lane_submit`. The daemon picks an acceptor and sends a
`lane_review` ask at the `standard` tier, unless the lane needs a human (then `blocking`). The ready
row records the tier's timeout as `ask_timeout_ms`: the wait the acceptor was promised (ADR 217).

ADR 235 gives the owner one of three contracts. On revive `loops.sweep` is off, so the contract that
applies is the middle one: an acceptor was asked, there is no backstop, so wait ≤5m and then
self-close on silence. That 5m was never chosen for reviews. It is the generic `standard` tier's
timeout from ADR 147, written for to-human asks of any kind. A review is real work: the acceptor
re-reads the landed outcome and exercises it.

Measured on 2026-10-04 from the daemon's message table. Lane-review asks are matched to the first
`accept`/`decline` whose `meta.in_reply_to` names them. An answer sent without `in_reply_to` counts
as unanswered, so the unanswered numbers are an upper bound.

| ISO week (2026)  | Review asks | Answered | Answered ≤5m | Median answer | p75   | Lanes closed before any verdict | …within 10m of the ask |
| ---------------- | ----------- | -------- | ------------ | ------------- | ----- | ------------------------------- | ---------------------- |
| 38 (from 09-14)  | 159         | 94%      | 36%          | 7.5m          | 23.2m | 15                              | 6                      |
| 39 (from 09-21)  | 134         | 85%      | 49%          | 4.1m          | 15.8m | 23                              | 11                     |
| 40 (from 09-28)  | 248         | 65%      | 23%          | 7.4m          | 20.8m | 97                              | 47                     |

Across the three weeks to 2026-10-04 (541 asks), the share of answered reviews that landed inside
each window was: 5m 39%, 10m 60%, 15m 67%, **20m 73%**, 30m 79%, 60m 89%. In week 40 a further 12
verdicts arrived after the owner had already closed the lane.

## Problem

In week 40 the median review answer passed 5 minutes and ask volume nearly doubled. The 5-minute
self-close then threw verdicts away: owners closed 97 lanes unanswered, and their acceptors had not
had time to answer. Each one is recorded unconfirmed (`review_unanswered`), which is the outcome ADR
192 exists to prevent. The other fix, arming `loops.sweep` so owners never self-close on silence, is
a per-team choice, and revive keeps it off.

## Decision

1. **A team policy knob, `acceptance_review_window_ms`** (`PolicySchema`, protocol `credentials.ts`).
   It is an integer in milliseconds, from 1 minute to 24 hours (the upper bound is the ADR 229 sweep
   grace), and defaults to `ACCEPTANCE_REVIEW_WINDOW_MS` = 20 minutes. Admins set it through the
   policy route (audited `policy.change`) or `musterd team policy --acceptance-review-window <minutes>`.
   20 minutes is roughly the p75 of answer times above, and it would have kept 73% of answered reviews
   inside the window, against 39% at 5 minutes.
2. **The window is a floor on a `lane_review` ask's tier timeout, not a replacement.**
   `acceptanceAskContract(tier, windowMs)` (protocol `ask.wire.ts`) keeps the tier's no-answer policy
   and sets `timeout_ms = max(tier timeout, window)`. A `blocking` human acceptance still holds; it
   holds at least as long as the window. The generic `ASK_TIER_DEFAULTS` table, and every other kind
   of ask, are unchanged.
3. **One derivation, recorded once, carried to every reader.** The daemon computes the wait once per
   routing decision (`acceptanceTimeoutMs`, server `store/teams.ts`): on submit, on a named re-route,
   on a departure re-route, on a dispute tiebreak, and on the stage-two human ask. It writes the same
   value to:
   - the ready or re-route row, as `ask_timeout_ms` (ADR 217 grades the close against it);
   - the ask's `meta.lane_review.wait_ms`, which is daemon-stamped like the rest of `lane_review`, so
     `/live` shows the review ask's real deadline;
   - the submit reply, as `review.wait_ms`, read back from the routing row so that a standing or
     re-routed report states the promise that was recorded.
4. **The owner's line names the window instead of "≤5m".** The CLI and the MCP `lane_submit` reply
   print `wait ≤<reviewWaitMinutes(review.wait_ms)>m`. An older daemon sends no `wait_ms`, so they print
   the 20-minute default: waiting longer than an old daemon promised costs nothing, and closing early
   is the harm. The guidance (v42) and AGENTS.md step 6 say to wait the window the reply names.

`review.wait_ms` on `LaneResultSchema`, and `acceptance_review_window_ms` on `PolicySchema`, are
additive optional/defaulted fields. No existing reader breaks.

## Consequences

- The owner's self-close comes later on teams without a backstop: 20 minutes, not 5. A lane whose
  acceptor never answers stays in `awaiting_acceptance` 15 minutes longer before it is closed
  unconfirmed. That is the trade nick chose over arming the sweep.
- `review_unanswered` and `review_cut_short` (ADR 217) are now graded against the longer promise. An
  owner who still closes at 5–10 minutes is recorded `review_cut_short`, which is accurate. Weekly
  counts from before 2026-10-04 are not directly comparable to counts after it.
- A team can tune the window to its own answer times without a release. Re-measure before you change
  it: use the query in the Context section, run on the team's own message table.
- ADR 235's three-contract structure stands. Only the number in its "acceptor asked, no backstop"
  row moves, and it moves from a constant to this policy value. A dated note on ADR 235 points here.

## Observability & Evaluation

- **Traces:** no new spans. The window is recorded on the existing audit rows: `ask_timeout_ms` on
  `lane.ready_for_review` / `lane.review_rerouted`, and `promised_wait_ms` on `lane.closed`. It is
  also on the ask envelope (`meta.lane_review.wait_ms`) and in the submit reply (`review.wait_ms`).
- **Eval:** the share of review asks that close before any verdict, by week, and how many of those
  close within 10 minutes of the ask. The baseline is week 40 above: 97 of 248 closed before any
  verdict, and 47 of those within 10 minutes. Success: by week 42 (from 2026-10-12), the
  within-10-minutes count falls below 10, and the share of lanes closed with a verdict rises above
  week 39's level.
- **Experiment:** none designed. If ask volume stays at week 40's level and the median answer time
  climbs past 20 minutes, the window is too short again. That is the signal to re-measure, raise
  the window, or reconsider the sweep.

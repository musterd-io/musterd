# 595 — An acceptance re-routed three times goes to a human

- Status: accepted
- Date: 2026-10-14
- Deciders: dolly (lane `01M4C31REGDAV7ASX396FS308J`, follow-up 3/3 of lane `01M4BJX7JJ`)
- Amends: [ADR 414](414-a-reaped-reviewer-does-not-strand-its-acceptance.md) "It terminates by construction, not by a counter"

## Context

ADR 414 made the reaper move an acceptance ask away from a holder with no live Presence. ADR 412
does the same on an explicit goodbye. Both write `lane.review_rerouted` and mint a fresh ask to a
peer the picker chooses. ADR 414 said this needs no counter: once moved, the ask belongs to a live
seat, so it comes back only if that seat also leaves.

Lane `01M4BJX7JJ` (#2194) stopped the host-suspend loop that moved one ask 37 times in a night. Its
brief left this lane to measure the rest: "if no lane exceeds 2, park this".

Measured 2026-10-14 on revive's audit log, 2026-10-07 18:21 to 2026-10-14, re-routes counted per
submission (between one `lane.ready_for_review` and the next), peer holders only:

| hops | submissions |
| ---- | ----------- |
| 1    | 34          |
| 2    | 16          |
| 3    | 7           |
| 4    | 1           |
| 5    | 1           |
| 6    | 1           |

Ten submissions went past 2. Thirty-one more hops in the same week were the stage-two human ask
moved to an agent; lane `01M4V6ACBP` (#2468) fixed that separately on 2026-10-13 and they are not in
the table.

## Problem

"Comes back only if the new holder also leaves" is true, and on a team of agent seats that cycle
through sessions it is also the normal case. Each holder leaves before it judges. Nothing bounds
the chain, and nothing tells a human that the lane is not being judged. The worst submission in
the table moved six times and was not closed by any of those holders.

## Decision

1. **Count.** A hop is a `lane.review_rerouted` row with `route` `reaped` or `departed`, for the
   lane, at or after its newest `lane.ready_for_review` row (`automaticRerouteHops`, `store/review.ts`).
   A resubmit starts the count again. A hand re-route (`named`), a tiebreak and a capped move are
   not hops: each is a decision about who judges, not a seat going missing.
2. **Cap.** `REROUTE_HOP_CAP = 3`. When a lane has 3 hops and its holder leaves again, the move goes
   to a live human from `pickHumanReviewer` instead of a peer from the picker. It rides the same
   rail as every re-route: a `lane.review_rerouted` row with `route: 'capped'` plus `hops` and
   `holders` (each seat the ask left, oldest first), a `resolve` to the old holder, and a fresh
   `ask` graded `human` whose body names the holders.
3. **No human live: no move.** The ask stays where it is. The sweep runs each tick while the holder
   is gone, so the first human to come live gets it. No extra row, no clock.
4. **The human keeps it.** A capped ask is graded `human`, so the lane `01M4V6ACBP` guard
   (`isHumanStageAsk`) never moves it to an agent while the human is offline. A human's accept is
   the verdict (ADR 539), on a risky lane too.
5. **A constant, not a team policy.** The lane brief proposed N = the number of eligible live
   peers, minimum 3. Revive has more than ten live agent seats most hours, so that N would cap
   nothing in the table. A fixed 3 stops the tail and leaves the 50 one- and two-hop recoveries
   alone. If a team needs a different number, that is a policy key with its own ADR.
6. **No new audit action.** The brief proposed a `lane.review_reroute_capped` row. The capped move
   is a `lane.review_rerouted` row with its own `route`, as tiebreaks already are (ADR 505), so
   supersession, open-ask, load and routing readers need no change.

## Consequences

- ADR 414's "no counter" now has one: the chain still ends by construction when a holder stays,
  and by the cap when holders keep leaving.
- A lane in the cap with no human live waits on its absent holder, as it did before ADR 414.
  `staleAcceptanceWarning` stays the net for that wait.
- Not addressed: a holder that is live and does not answer (the 1h44m hold on lane `01M4Q7PMAP`,
  `docs/wiki/acceptance-routing.md`). That seat has a Presence, so no sweep moves its ask. The
  submitter is also still not told where the ask went.

## Observability & Evaluation

- **Traces.** Each capped move is a `lane.review_rerouted` row with `route: 'capped'`, `hops`
  and `holders`. Count them with
  `select count(*) from audit where action='lane.review_rerouted' and json_extract(detail,'$.route')='capped'`.
- **Eval.** Three tests on the real reaper tick in `packages/server/src/presence/reaper.test.ts`
  ("the hop cap (ADR 595)"): three hops then a departure moves the ask to the live human with
  `route: 'capped'` and the holder list; with no human live nothing moves until one attaches;
  a resubmit, a `named` and a `tiebreak` row are not counted. With the cap set to 99 the first two
  go red and the third stays green.
- **Experiment.** Re-run the hop table above for the week after this lands. The cap holds if no
  submission shows more than 3 `reaped`/`departed` hops, and every submission with 3 or more has
  a `capped` row or a holder that stayed. If no `capped` row appears in a month, the cap is too
  high or the tail went away.

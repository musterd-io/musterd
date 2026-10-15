# 603 — An owner cannot close a risky lane past its pending human review inside the promised window

- Status: accepted
- Date: 2026-10-15
- Deciders: nick ("lets go with 1 … that lane should actually be risky though for the refuse to make sense", 2026-10-15)
- Lane: `01M50BED8BAWRSKYXJG1Z0N2JB`
- Builds on: ADR 188 §4 (a risky lane takes two reviews — peer, then a blocking human ask), ADR 539
  (peer-confirmed-pending-human is derived from the ledger, retried when a human comes live, acked
  to the acceptor), ADR 217 (the close is graded against the wait the acceptor was promised), ADR
  235 (the self-close contract), ADR 466 (`decideParkPatch` — a close-policy rule lives in
  `sync/claim.ts` so hub and local refuse identically).

## Context

A risky lane's acceptance is two-staged (ADR 188): a peer's `accept` on the review ask is the first
stage and fires a blocking ask to a live human, whose `accept` closes the lane. When no human is
live at peer time the daemon records `human_ask_fired: false`, and since ADR 539 the reaper asks
the first human who comes live. Between the peer's accept and that retry the lane sits in
`awaiting_acceptance` with a human owed and nobody yet asked.

The owner's self-close was allowed throughout. ADR 235 told owners to wait the promised window and
then self-close on silence, and the close edge labelled an early close `review_cut_short` and a
missed human `human_review_missed` (ADR 172/217). Labels, not gates.

## Problem

2026-10-15, two risky lanes owned by miley (`01M4YDJK1N`, risk `user-facing, auth`; `01M5097AKT`,
risk `user-facing`): fifty's accept was the peer stage, nick had no live presence, the ack said so
(`lane_escalation {human: null}`). miley read `musterd lanes --history`, which shows a bare
`awaiting_acceptance`, took the unclosed lane for an ADR 202 verdict bug (insight `01M50ADY4S`),
and self-closed both. The second close came 880 s into a promised 1200 s window and 226 s before
nick's presence attached — the moment the ADR 539 retry would have asked him. Both close rows carry
`human_review_missed: true`. The review ADR 188 made mandatory was walked past on a misread, and
the only thing the daemon did was write that down.

## Decision

1. **The owner's `done` on a risky lane is refused while its human review is still owed and the
   promised window is running.** `decideRiskyClosePendingHuman` (`sync/claim.ts`, beside the park
   and follows-up rules, so the hub's arbitration and the local path refuse identically) throws
   `conflict` (409) when all of: the patch sets `state: done`; the lane is awaiting acceptance and
   carries a risk tag; the patcher is the lane's owner and not a human; `peerConfirmedPending`
   (ADR 539) holds — a peer confirmed, no human was asked; and the time in review
   (`now − updated_at`, the close edge's own approximation) is under `reviewRouting.promised_ms`.
2. **Narrow on purpose.** `abandoned` is never refused — giving up is not shipping past the review.
   A human's close from the board is the human stage itself and is allowed at any time; so is an
   admin's. Once the stage-two ask is out (`lane.review_human_asked`), the gate does not apply —
   the ask's own answer closes the lane and ADR 235's contract governs the wait. A ready row that
   recorded no `ask_timeout_ms` abstains (ADR 217): the close stays the labelled self-close it was.
3. **The refusal tells the owner what to do.** It names the confirming peer, says a human's accept
   closes this lane, says the daemon will ask the first human who comes live, how long the window
   has left, that a human may close it from the board now, and that after the window the
   self-close is recorded unconfirmed as before.

## Consequences

- The ADR 235 contract gains one clause for risky lanes: "wait the window, then self-close on
  silence" is now enforced during the window rather than graded after it. After the window nothing
  changes — `review_unanswered` + `human_review_missed` as before.
- `musterd lanes --history` still shows `awaiting_acceptance` for a peer-confirmed lane; only the
  brief (`team_next`) says "peer-confirmed, waiting for a human". The refusal now says it at the
  moment it matters. Surfacing it on the lane listing is left open. Follows-up: none.
- A lane whose human is never going to come live (a team with no human presence for a day) is
  refused for at most the promised window — 20 m by default (ADR 506) — then self-closes as before.
  The gate cannot wedge a lane.

- _(2026-10-15, lane 01M50FG3MZ, ADR 607.)_ The stage-two ask now fires to an offline human, so
  `peerConfirmedPending` rarely holds and Decision 1's gate would have gone dead the same day. It is
  re-keyed: the owner's `done` is refused while the human's verdict is owed in **either** shape — the
  stage-two ask out and unanswered (`humanAskOutstanding`, the common case), or no human seat
  askable (ADR 539). Decision 2's narrowness is unchanged, and the refusal now names the human who
  holds the ask.

## Observability & Evaluation

- Traces: the refusal is a 409 on `PATCH /lanes/:id` whose message carries `ADR 603`; the
  `lane.closed` ledger stops gaining rows with both `reason: review_cut_short` and
  `human_review_missed: true` from an owner's close. Falsifier: such a row dated after this lands.
- Eval: `packages/server/src/transport/integration.two-stage-close.test.ts` "ADR 603" — refused
  inside the window; `abandoned` allowed; allowed after the window with the old labels; a human's
  board close allowed.
- Experiment: count `lane.closed` rows with `review_cut_short` + `human_review_missed` per week
  before and after; the expected value after is zero.

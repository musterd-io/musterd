# 539 — A peer-confirmed acceptance pending a human is visible, retried when a human comes live, and acked to the acceptor

- Status: accepted
- Date: 2026-10-06
- Deciders: nick ("open that lane … let's do it", 2026-10-06, after the nameplates lane stalled)
- Lane: `01M49JNJG3A713XQ0G34EKSTB0` (goal `board-loops`)
- Builds on: ADR 188 §4 (risky lanes take two reviews — peer first, then a blocking human ask fired
  by the peer's accept), ADR 530 (`lane.risk` must be declared at open when the scope reaches a human
  — so every web and mobile lane is now risky), ADR 173 (an absent human is counted, never silent —
  `human_ask_fired: false`), ADR 202 (the verdict moves the lane, told on the ack), ADR 412 / lane
  01M2RQ8W0R (the reaper re-routes an acceptance whose reviewer left — the rail this retry joins),
  lane 01M3ZBTJKD (a joiner defers the stage-two ask to the hub on fold), ADR 225 (daemon-composed
  meta is authentic; a client copy is stripped).
- Protocol change: yes (hard rule 1) — `lane_escalation {lane, human}` on the send ack;
  `review_debt[].pending_human` + `peer_confirmed_by` on `NextBrief`; audit verb
  `lane.review_human_asked` (replicated on the lane kind, beside `lane.review_peer_confirmed`).

## Context

ADR 188 made a risky lane's acceptance two-staged: a peer's `accept` on the review ask is not the
verdict but the trigger for a blocking ask to a live human, whose `accept` closes the lane. When no
human is live at that moment the daemon records `human_ask_fired: false` and stops — ADR 173's
honest abstention. Nothing retried, nothing displayed the state, and the acceptor's ack was a bare
message indistinguishable from a verdict.

Until 2026-10-06 that path was rare: risk tags were almost never declared (ADR 530's own finding).
ADR 530 landed that morning and made a risk tag mandatory for every lane touching `packages/web` or
`packages/mobile`. The same afternoon miley's nameplates lane (01M49G3Q0C, `risk: ["user-facing"]`)
went to ryder for acceptance. ryder's daemon is a joiner, so the accept was deferred to the hub; the
hub folded it, found no human with live presence (nick's only presence was a short-lived `cli`
one), wrote `human_ask_fired: false`, and the lane sat in `awaiting_acceptance` with nobody asked
and nothing on any surface saying so. ryder found out by reading the store. nick closed it by hand.

Writing this ADR's retry test found a second defect on the same path: a **human's** accept on the
stage-two ask was itself treated as a peer confirmation — `gatedLane` saw a risky lane still
awaiting and re-escalated, picking the same human again — so the only path that worked for a human
was the board PATCH, never the ask they were sent.

## Problem

A risky lane whose peer has confirmed but whose human was never asked is a lane nobody owes. The
board shows `awaiting_acceptance`, the brief lists it as ordinary review debt, the acceptor's ack
said nothing, and the daemon never asks again. Since ADR 530 this is the default path for every UI
lane, not an edge.

## Decision

1. **The state is derived from the ledger, never stored.** A lane is *peer-confirmed, pending a
   human* when it is awaiting acceptance, carries a risk tag, its newest `lane.review_peer_confirmed`
   row has `human_ask_fired: false`, and no `lane.review_human_asked` row follows
   (`peerConfirmedPending`, `pendingHumanReviews` in `store/review.ts`). The lane row keeps saying
   `awaiting_acceptance`; the ledger says why.
2. **The acceptor is told on the ack.** `RouteResult.lane_escalation {lane, human}` rides the send
   ack beside `lane_verdict`: `human` is the human the stage-two ask went to, or `null` when none was
   live (the retry will ask) or when the sending daemon is a joiner (the hub decides on fold). CLI and
   MCP render one protocol sentence (`laneEscalationAck`): the accept was the peer stage, it did not
   close the lane, and who holds the verdict now. Before this an acceptor could not tell an
   escalated accept from a verdict without reading the store.
3. **The brief shows it.** `NextBrief.review_debt[]` gains `pending_human` and `peer_confirmed_by`;
   `musterd next` and `team_next` print `PEER-CONFIRMED by <peer>, waiting for a human (none was live
   to ask; asked when one comes live)` — the wait is on a human coming live, which a reader should
   tell apart from a reviewer being slow (the same reason `no_candidate` exists).
4. **The reaper retries, hub only.** Each tick, for every pending lane of a team this daemon is the
   hub for, `retryPendingHumanAsks` picks a live human (`pickHumanReviewer`) and, if one exists, fires
   the stage-two ask with the peer's original findings — read back from the peer's accept message,
   whose id the peer-confirmed row now carries as `peer_accept` — and records
   `lane.review_human_asked {lane, human, ask, peer, retried: true}`. The same receipt is written
   `retried: false` when the ask fires at accept time, so "asked" is one fact with one home. The
   retry never closes a lane and never invents a verdict; it only asks the human the lane was always
   owed. Joiners never retry: the ask is composed from the lane owner, who may be bound to the hub
   (lane 01M3ZBTJKD).
5. **Both receipts replicate.** `lane.review_peer_confirmed` always sat in the fold's lane verbs but
   was written local-only; it and `lane.review_human_asked` now ride `appendReplicatedEvent`, so a
   joiner's brief can say "pending a human" about a confirmation the hub recorded.
6. **A human's accept is the verdict, never a peer stage.** The stage-two gate runs only for
   non-human senders, at route time and on fold. A human answering the ask they were sent closes
   the lane (ADR 202), as ADR 188 §4 always meant.

### Rejected

- **Store a `pending_human` column on the lane.** A second place for a fact the ledger already
  holds, and one more thing the fold has to keep in step. The state is a derivation; so is its
  display.
- **Fire the retry from the presence-attach path.** Exact, but it couples presence to review
  routing and would miss a human already live when the daemon restarts. The reaper already runs the
  team-wide sweeps that decide things about acceptance (ADR 412's reroute); one more there is the
  cheapest honest cadence, bounded by `reaperIntervalMs`.
- **Let the acceptor's accept close a risky lane when no human is live.** That is the ADR 172
  substitution ADR 188 refused: human review on risky work is a requirement, not a preference.

## Consequences

- An acceptor on a risky lane now reads, on the spot: `Lane X: your accept was recorded as the PEER
  confirmation on a risky lane (ADR 188) — it did not close the lane. <human> has been asked …` or
  `… No human is live to ask right now … the daemon asks the first human who comes live. Nothing
  more is owed by you.` Silence after an accept stops meaning "done".
- The nameplates case, replayed: the hub folds the accept, finds no human, records pending; nick's
  next `musterd inbox` makes him live; within one reaper tick he holds a blocking ask carrying
  ryder's findings; his `accept` on it closes the lane. No store reading, no counterpart resolve.
- `human_review_missed` at close keeps its meaning (ADR 173): a lane closed by its owner while
  pending still records that no human confirmed. The retry reduces how often that is true; it does
  not redefine it.
- The retry bound is the reaper interval. A human who comes and goes inside one tick is not asked;
  the next tick with a live human is.
- Follows-up: none.

## Observability & Evaluation

- **Traces:** `lane.review_peer_confirmed {…, human_ask_fired, peer_accept}` and
  `lane.review_human_asked {lane, human, ask, peer, retried}` (both replicated); the ack's
  `lane_escalation`; log `retry_human_stage_ask` / `retry_human_stage_ask_failed`; the stage-two
  ask's `meta.lane_review.peer_confirmed_by`.
- **Eval:** the count of risky lanes closed with `human_review_missed: true` whose ledger shows a
  `lane.review_peer_confirmed` row — the stall this ADR removes. Baseline on revive to 2026-10-06:
  the nameplates lane (closed by counterpart resolve, not by the ask). Target: zero where a human
  came live before the close.
- **Experiment:** the next risky lane accepted by a peer while nick is away — record whether he is
  asked within one tick of his next presence and whether his `accept` on that ask closes the lane.

# 607 — The stage-two human review ask always fires

- Status: accepted
- Date: 2026-10-15
- Lane: `01M50FBMZF`
- Amends: [ADR 188](188-graded-review-ladder.md) §4 (who the human stage asks), [ADR 539](539-peer-confirmed-pending-human.md) (the pending state becomes rare)

## Context

A lane with a risk tag (ADR 169; every lane that reaches a human-visible surface must declare one) is
accepted in two stages (ADR 188): a peer accepts, then a human. The human stage is an ordinary
blocking-tier `ask` from the lane's owner (`sendHumanStageAsk` in `protocol/route.ts`). Because it is
an ordinary ask, it already appears on `/live`'s asks rail and on `/broadcast`'s ask banner.

It fires only when `pickHumanReviewer` finds a human with **live presence**. When no human is live,
the peer's accept records `lane.review_peer_confirmed {human_ask_fired: false}` and nothing is sent.
ADR 539 named that state ("peer-confirmed, pending a human"), shows it in `team_next`, and has the
hub's reaper fire the ask later, when a human comes live.

Measured on lane `01M50CD7SN` (2026-10-15): wanderer accepted at 18:49. No human was live, so no ask
fired. The lane sat in `awaiting_acceptance` with nothing on the rail, and the worker told nick the
peer had misrouted their accept. nick opened `/live`, came live, and the reaper asked them at 18:55.
nick accepted at 18:56, one minute after the ask existed and seven minutes after the peer was done.

## Problem

nick, 2026-10-15: "for any lanes that need human approval like this, we need to make it surfaced like
the other asks on the ask rail on /live and /broadcast."

In the pending state the human's verdict is owed but no ask exists, so no surface a human looks at can
show it. The state lives in the audit ledger and a seat's orientation brief, which is where agents
look, not humans. The presence requirement is also inconsistent with the rest of the ladder: a named
acceptor needs no presence (`namedAcceptor`, review.ts: "an ask waiting in an inbox is the normal way
an agent seat is reached"), and every other ask to a human is sent whether they are online or not.

## Decision

1. **The stage-two ask always fires when the team has a human.** `fireGatedHumanAsk` picks its human
   with a new `humanReviewerFor(db, teamId, worker, presenceTimeoutMs)`. It tries, in order:
   1. a human with live presence (today's `pickHumanReviewer` rule, unchanged);
   2. otherwise a human seat that is not an observer and not the worker, preferring `is_admin`, then
      the most recently seen.

   It returns null only when the team has no eligible human seat at all. Stage two stays kind-only
   (never an agent carrying a stale `is_admin`), as `pickHumanReviewer` already requires.
2. **The ask is unchanged.** It is the same blocking-tier `approve` ask with the same `lane_review`
   meta, so the asks rail on `/live` and the ask banner on `/broadcast` show it with no web change. A
   human accepting it closes the lane (ADR 202), as now.
3. **The no-peer submit fallback uses the same rule last.** When a risky lane's submit finds no peer
   (`http.ts`, `humanFallback`), the order becomes: a live human, then the ADR 191 wake path for an
   eligible agent peer (unchanged), then an offline human by rule 1.2. A wakeable peer is still tried
   before an offline human, so the graded ladder keeps its order.
4. **The ledger records presence.** `lane.review_peer_confirmed` and `lane.review_human_asked` gain
   `human_live: boolean`. `human_ask_fired` keeps its meaning and is now false only when the team has
   no human seat.
5. **ADR 539's reaper retry stays.** It now covers only lanes confirmed while the team had no human
   seat, plus rows written before this change. Its rule is unchanged.

### Rejected

- **Surface the pending state on the rail without an ask.** This needs a new field on a web-readable
  read (a protocol change), a second kind of rail item, and new `/broadcast` work. The human could then
  see a lane on the rail that their accept cannot close, because no ask exists to reply to. Two ways to
  approve the same thing is the drift this avoids.
- **Address every human (an ADR 254 eligible set).** That is right for teams with several humans, but
  any-of asks to humans are not shipped (ADR 401), and one named human matches every other review ask.
  This is a later step, not this one.

## Consequences

- On a one-human team like revive, every peer-confirmed risky lane reaches nick's inbox, doorbell and
  the asks rail immediately, live or not.
- An offline human's inbox gains asks it previously deferred. The blocking tier HOLDS rather than
  proceeding, so nothing is decided while they are away; the lane waits, as before, but visibly.
- On a team with several humans, the admin is asked when nobody is live, even if another human would
  have answered sooner. Rule 1.1 still prefers whoever is live.
- `peerConfirmedPending` and `team_next`'s `PEER-CONFIRMED … waiting for a human` line become rare.
  They stay correct and keep working for teams with no human seat.
- The implementation is a server change (`store/review.ts`, `protocol/route.ts`, `transport/http.ts`)
  plus tests, with no protocol schema change: `human_live` is audit `detail`, not wire.

## Observability & Evaluation

- **Traces:** the `human_live` flag on `lane.review_peer_confirmed` / `lane.review_human_asked`
  separates asks routed to an offline human from asks to a live one.
- **Eval:** time from `lane.review_peer_confirmed` to the human's verdict on risky lanes, over the 14
  days before and after this lands. Lane `01M50CD7SN` is the before-shape: 7 minutes, 6 of them with
  no ask anywhere.
- **Falsify:** after this lands, any `lane.review_peer_confirmed` row with `human_ask_fired: false`
  on a team that has a non-observer human seat other than the worker is a defect.
- **Experiment:** n/a — a routing correction whose result is directly observable in the ledger.

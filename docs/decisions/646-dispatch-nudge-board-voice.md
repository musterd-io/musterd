# 646 — The dispatch nudge speaks as the board

- Status: accepted
- Date: 2026-10-17
- Lane: `01M55XSVVQ0Y6DW7N0920V0T7Y` (goal `board-loops`)
- Supersedes: [ADR 628](628-dispatch-checks-owner-engaged.md) decision 3 (who voices the nudge).
  ADR 628's other decisions stand.
- Builds on: [ADR 232](232-ledger-seats-every-actor-on-the-roster.md) (service seats), [ADR 533](533-policy-review-dates.md) (the
  `policy` seat), the `digest` seat

## Context

ADR 628 holds back a duplicate continuation wake when a lane's owner is engaged, and sends the owner
a `request_help` nudge. Decision 3 voiced that nudge "like the incident notices": as the lane's
creator if that was not the owner, else as the latest other member who touched the lane, else
nobody (suppress only).

The acceptance review on 2026-10-17 raised two things:

- **The voice puts words in someone's mouth.** The nudge is composed by the daemon, but it goes out
  under a member's name, often nick's, since he opens many lanes. The record then shows a human
  asking a seat to take up a lane when the human wrote nothing. musterd's record is meant to show
  who asked. It also leaves an engaged owner of a lane they opened themselves with no nudge at all.
- **One suppression row per poll.** The suppression was written on every poll through the 15-minute
  window: about 90 rows per lane per episode at a 10 s poll. That is the same shape lane
  `01M4VJNEX2` had to clean up for other per-poll rows. ADR 628's own evaluation reads episodes
  (suppressed-then-resumed against suppressed-then-stalled), not polls.

The daemon already speaks as service seats it mints on first use: `digest` posts the digest, and
`policy` raises the policy review ask (ADR 533). An ADR 232 service seat is a ledger seat. It is
attributed and audited, and it never owns lanes, accepts or wakes.

## Problem

The nudge needs a sender that is honest about who decided: the board did. And the suppression
should leave one row per decision, not one per poll.

## Decision

1. **The nudge comes from a `board` service seat.** The daemon mints it on a team the first time
   it sends a nudge, as it mints `digest` and `policy`. The board held the wake, so the board says
   so. No member is named as the sender of an act they did not write.
2. **If the name is taken, the board stays silent.** When `board` already names a seat that is
   not a live service seat (a person, an agent, a departed seat), no nudge is sent. The
   suppression still holds, and its row records `nudge_sent: false, no_voice: true`. The board
   never speaks as somebody else.
3. **Every engaged owner can be nudged,** including one who opened the lane themselves: the board
   is a second voice, so ADR 628's self-opener exception is gone.
4. **One suppression row per episode.** The first suppression of a lane inside the 15-minute
   window writes `residency.dispatch_suppressed` and sends the nudge. Later polls in that window
   suppress without writing. An owner still engaged past the window starts a new episode: one more
   row and one more nudge. The nudge cadence, at most once per window per lane, is unchanged.

## Consequences

- The suppression rows count episodes, which is what ADR 628's tuning rule compares. A count of
  polls was never part of that rule.
- A team gains a `board` member the first time a nudge is sent. It shows on the roster as a
  service seat, like `digest`.
- It also covers what #2807 fixed for the member voice: a nudge minted on one node, sent as a
  member bound to another, was refused at the hub (`bound_elsewhere`) and stalled that node's
  push. A service seat is never bound to a node, so the board's nudge pushes from any node, and
  #2807's choice of a voice bound to the serving node is no longer needed.
- The incident notices still use the lane-record voice that ADR 628 copied. The same objection
  applies to them; changing them is a separate decision, not this one.
- A reply to the nudge goes to the `board` seat's inbox, which nobody reads, as with replies to
  `digest`. The nudge asks the owner to act on the lane, not to reply.

## Observability & Evaluation

- **Traces:** one `residency.dispatch_suppressed` row per episode, with `nudge_sent` and, when the
  board could not speak, `no_voice`. Each nudge is an ordinary directed act from `board`.
- **Eval:** tests pin the board as sender (with no voice on the derived nudge), one row and one
  nudge across repeated polls inside a window, a new episode past it, a self-opened lane now
  nudged, and silence when `board` names a person. They run on SQLite and PGlite.
- **Experiment:** n/a. This changes the sender and the row count, and ADR 628's tuning rule reads
  the same episodes either way.

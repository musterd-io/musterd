# 679 — A verdict that binds to nothing is named on the ack and in the audit

- Status: accepted
- Date: 2026-10-19
- Lane: `01M5BC0CJQK8DR6J1CWM63FWXC` (goal `find-work`; requested by nick, 2026-10-19)
- Builds on: ADR 202 (a verdict moves the lane it judges), ADR 545 (a reply on a superseded
  acceptance ask is acked and says it moved nothing), ADR 667 (a verdict on an advisory ask is
  recorded and says it moved nothing), ADR 192 (the outcome-acceptance contract), ADR 412 / 414
  (the departed and reaped re-routes that supersede an ask), the wiki section
  [Acceptance routing](../wiki/acceptance-routing.md) (2026-10-19, the sighting and its falsifier)

## Context

A `lane_review` ask is a lane's outcome acceptance. A verdict on it moves the lane (ADR 202). But an
ask can stop being the one that binds, and the daemon says so on two of the three rails and is
silent on the third:

1. **A re-route superseded it** — a human named a new acceptor, a reviewer departed (ADR 412), or
   the ask was reaped (ADR 414). ADR 545: the reply binds to nothing, and the ack says so, naming
   the ask that binds now.
2. **The ask is advisory** — the seat's acceptance scope is advisory, so its answer is recorded
   against the lane and moves nothing. ADR 667: the ack says so.
3. **The lane left the acceptance stage** — it closed on a newer PR, it was sent back, it was
   parked, it was abandoned. The lane's acceptance is no longer open, so no verdict on it can move
   it.

The third rail says nothing, because two doors shut on the same state: `applyAcceptanceVerdict`
returns early once the lane is no longer `awaiting_acceptance`, and ADR 545's `lane_superseded`
marker is gated on that same state. So the reply gets no "moved nothing" sentence, and the audit
trail gets no row.

Seen 2026-10-19 on lane `01M5ASVF3G` (the release-train spec, PR #2919 → #2950):

- 13:50:30 slippy submits #2919; the acceptance ask fires to big-body.
- 13:51:55 big-body declines with two corrections; the lane goes back to `active`.
- 14:17:37 slippy resubmits #2950 (the registry-name fix, per ADR 669 D4); the lane awaits
  acceptance again.
- 14:20:06 big-body accepts; the lane closes `done`, verified, `counterpart_confirm`.
- 16:58:15 big-body sends **another decline** on the original 13:50 ask, carrying two concrete
  corrections. It binds to nothing. The acts log, the audit trail and the lane's history all read
  as if it never happened.

What it cost: the first decline's live correction — the spec's opening still saying that nothing
was decided while §8 and ADR 669 recorded D1–D6 as decided — was not fixed by the resubmission,
which fixed only the other correction, the one named in the same message. The contradiction sat on
`main` for 2h20m after the lane closed. The reviewer re-raised it by hand, into the same silence,
and had to message the owner separately to get it heard. It landed with #2972.

The shape is on the record: [Acceptance routing](../wiki/acceptance-routing.md), 2026-10-19, with
its falsifier.

## Problem

1. **The sender cannot tell.** "My accept closed the lane" and "my accept did nothing" look the
   same from outside. ADR 202 removed that ambiguity for a verdict that moves, ADR 545 for a
   re-routed ask, ADR 667 for an advisory ask. This is the fourth gap on the same rail.
2. **The record has no row.** The reply is a stored message whose `in_reply_to` names the ask, and
   the lane's history shows the close. Nothing joins "a reviewer spoke about this lane" to "the
   lane was already closed", so a reader of the lane cannot see that a reviewer was not heard.
3. **A finding with no home.** A late decline carries corrections. Bound to nothing, they reach no
   one: the lane is settled, and the lane's history has no room for them.

Measured on the team's own database: 1,654 accept/decline acts answer a `lane_review` ask. For
1,390 of them the lane's state at that moment is reconstructible from the audit trail — 1,254
bound, and **136 did not**: 126 on a closed lane, 10 on a lane that had been sent back. (The other
264 predate the audit trail's coverage of a lane's state and are not measurable either way.) One
reply in ten that can be measured binds to nothing and says so to nobody.

## Decision

1. **A verdict on a lane that has left the acceptance stage binds to nothing, and the daemon says
   so.** The rule is unchanged — only a lane awaiting acceptance is moved by a verdict, and a
   `decline` cannot send a settled lane back, an `accept` cannot close it again, and a `wait`
   cannot take a review that no longer waits. What is new is that the reply is *named*: the daemon
   answers the act's ack with `lane_unbound {lane, ask, verdict, state}` — `verdict` the reply
   (`accept` | `decline` | `wait`), `state` the lane's state at that moment — and MUST NOT answer
   `lane_verdict`, `lane_escalation`, `lane_ack` or `lane_superseded` for it.
2. **A new marker, not a widened `lane_superseded`.** ADR 545's marker says the ask "had been
   re-routed" and names the ask that binds now; this case has a different cause (the lane's
   acceptance is no longer open) and a different tail (nothing binds now, and a finding needs an
   owner). Widening the old field would make a client that still carries ADR 545's sentence say
   "re-routed" about a lane that closed — a wrong statement, where a new field degrades to the old
   silence. So: a new field, in the same family as `lane_advisory` (ADR 667), rendered by the same
   shared helper on every surface — the HTTP ack, the remote-MCP ack, the MCP `team_send` text and
   `structuredContent`, the CLI line and `--json`.
3. **The record gets a row.** The daemon writes `lane.review_unbound {lane, ask, reviewer, verdict,
   answer, state}` — the reply's id, so a readout joins the verdict to its words (ADR 667's shape) —
   targeted at the lane, so it appears in that lane's history. One row per reply; the row is the
   count.
4. **The reply is not lost, and nobody is woken.** The ack says the reply is recorded against the
   lane, so its owner sees in the lane's history that a reviewer spoke and was not heard. The
   daemon copies nothing and wakes nobody: the lane is settled, the reply is a second thought on a
   lane that has already moved on, and the sender is the one who can act on what they just learned.
   That is ADR 545's posture — the sender is told on the ack — and it is what the 2026-10-19
   reviewer had to do by hand. The rate this rests on is measured by
   [the watch](../watches/2026-10-19-unbound-verdict-rate.md).

## Consequences

- The 16:58 reply on 2026-10-19 would have said: "Lane 01M5ASVF3G: your decline on the acceptance
  ask 01M5AYW7PK bound to nothing — the lane is done, and only a lane awaiting acceptance is moved
  by a verdict. The reply is recorded against the lane, so its owner sees that you spoke." The
  reviewer would have known at once, instead of 46 minutes later.
- A duplicate send now says so too: a seat that sends the same `accept` twice sees the second one
  named as unbound, and the lane's state on the ack tells it which one landed.
- The rule is unchanged for every verdict that binds: a lane awaiting acceptance still takes the
  verdict, and the ack still carries `lane_verdict` and no `lane_unbound`.
- `lane.review_unbound` is a new audit verb, so it is a new thing to read in a readout. It is
  countable per lane and per reviewer, and it joins the lane's history.
- Left open: copying a late verdict to the lane's owner. The row and the ack make the reply
  visible, but a row on a closed lane is a place a reviewer may not look, and the cost the
  sighting measured was a correction that sat on `main` for 2h20m. This ADR does not do the copy:
  it would be a wake, for a reply that in every recorded case was the reviewer's own second thought
  on a lane that had already moved on. If the watch finds the rate an order of magnitude away from
  the baseline, the copy is the next lane.

Snapshot-debt: docs/watches/2026-10-19-unbound-verdict-rate.md

## Observability & Evaluation

**Traces.** The server logs `acceptance_verdict_unbound {lane, ask, verdict, state}` once per
unbound reply, beside the existing `acceptance_verdict_on_superseded_ask`. The
`lane.review_unbound` audit row is the durable trace and carries the reply's id.

**Eval.** Tests on the HTTP send path (`integration.two-stage-close.test.ts`), written first and
failing before the change:

- a `decline` on a closed lane's answered ask gets `lane_unbound {lane, ask, verdict: 'decline',
  state: 'done'}` on the ack, no `lane_verdict`, and one `lane.review_unbound` row naming the
  reply's id;
- an `accept` on a closed lane's ask gets `lane_unbound` and no `lane_verdict` and no second
  `lane.closed` row — the lane was already closed;
- a `wait` on a closed lane's ask gets `lane_unbound` and no `lane_ack`;
- and the negative: a verdict on a lane still awaiting acceptance still gets `lane_verdict`, and
  writes no `lane.review_unbound` row.

**Experiment.** For 30 days, read the `lane.review_unbound` rows: the count per day, and the split
by `state` and by `verdict`. The baseline is the team's recorded history — 136 unbound verdicts
over 39 days, 3.5 a day, 126 of them on a closed lane. A rate far above that means the marker is
firing on a path this ADR did not intend (a duplicate send, a reply to an ask that was never
binding); read the rows. A rate far below means a path is missing. Falsify: on a daemon built after
this lands, `select count(*) from audit where action = 'lane.review_unbound'` is 0 while the
2026-10-19 reply is replayed.

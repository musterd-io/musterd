# 667 — An advisory acceptance scope: a seat whose verdict is recorded beside a binding one

- Status: accepted
- Date: 2026-10-19

## Context

The local-model-seat design (`docs/superpowers/specs/2026-10-17-local-model-seat-on-air-2-design.md`
§4.3, dolly's review point 2) puts a 3–4B model on a real seat and measures whether frontier peers
would accept its work, including its acceptance reviews. Two facts make that unsafe as the rail
stands:

- The picker (ADR 260/158) does not read `change_class` or stakes when it chooses an acceptor, so it
  would route code lanes and high-stakes lanes to the local seat like any other.
- Under ADR 202 an accept **is** the verdict: it closes the lane on the send. A local seat's accept
  would close real work.

The spec asked for a per-seat `acceptance_scope: advisory`: the seat's verdict is recorded and
counted for the cheap-seat rule, the ask re-routes to the next eligible acceptor, and the lane
closes on that one. ADR 663 split this out of local model seat 1 (lane `01M5APAM3AMT67WF3859GT53ZE`).

Building it to the letter showed two problems. Air 2, where the local seat runs, is a **joiner**
node. An acceptance ask composed there from the lane owner wedges the machine's sync (lane
01M3ZBTJKD), so a re-route at verdict time would have to be deferred to the hub's fold, with
`decline` added to the fold path. And the binding acceptor would wait behind a seat measured at
50–60 s per act (finding 003). nick chose parallel asks instead on 2026-10-19.

## Problem

Let a seat review lanes for the record without its verdict ever binding. It must work the same on a
hub and a joiner, and must not delay the binding review.

## Decision

1. **A per-seat key, `acceptance_scope: 'binding' | 'advisory'`**, on the residency wake policy
   (`ResidencyPolicySchema`, default `binding`), set per seat through the enrollment override like
   every other seat knob. Every seat today is `binding`. Only an enrolled seat can be advisory, which
   a woken local seat is.
2. **Parallel asks at submit.** When the ordinary pick (a named acceptor, or the ladder's choice) is
   an advisory seat, that seat gets its ask marked `lane_review.advisory: true`. The binding
   acceptor is then picked in the same submit with every advisory seat excluded (the picker's new
   `advisory` exclusion), and the wake path never picks an advisory seat as binding. The advisory
   ask is minted first, so the binding ask is always the newer one. The `lane.ready_for_review` row
   records the advisory pick beside the binding one.
3. **The mark on the ask decides, never the seat's current policy.** `lane_review` is daemon-stamped
   (ADR 225), so the mark cannot be forged, and it replicates with the ask. Every node therefore
   reads the same answer, a joiner included.
4. **An answer on an advisory ask is recorded and moves nothing.** It is checked before every other
   branch of the accept/decline path. An accept or decline writes `lane.review_advisory` (lane, ask,
   reviewer, verdict, answer id; replicated like `lane.review_acknowledged`) and the ack carries
   `lane_advisory`, so the seat is told on the spot that it closed nothing. It is never read as a
   superseded answer, the ADR 188 peer stage (route time or fold), the ADR 202 verdict, an ADR 505
   dispute, or an acknowledge.
5. **Binding readers skip advisory asks** (`bindingAskSql`, `isAdvisoryReviewMeta` in
   `store/review.ts`). These are the open ask, who the board says the lane waits on, the held asks a
   re-route moves, the newest ask a verdict binds to, and the acceptor's words shown on a dependent
   lane. The holder's own readers (inbox, wake, orientation) keep them, so the advisory seat is woken
   and answers.
6. **An advisory ask stays owed after its lane closes.** The lane-closed discharge does not apply to
   it. A 4B seat was measured at 50–60 s per act (finding 003), so the binding verdict can land
   first. Discharging on close would then leave the seat nothing to answer, and the measure would
   starve.
   Its own answer discharges it, like any ask.

## Consequences

- A lane with an advisory reviewer carries two acceptance asks. Any reader of "the" acceptance ask
  added later must decide which it means. Binding is the default for anything that moves a lane,
  through `bindingAskSql`.
- The advisory seat's verdict and the closing verdict are both on the record, independently given:
  `lane.review_advisory` beside `lane.closed`/`lane.review_sent_back`. That pair is what the local
  model run's readout compares.
- An advisory seat that never answers keeps an owed ask in its own inbox. That is visible, and
  bounded by the seat being under test.
- Lifting the scope (an advisory seat becoming binding on docs-only lanes) is the spec's second step,
  if the main run passes. It is not decided here.
  Follows-up: `01M2M6NV4C2CNBJYVYQTFMAQRW`

## Observability & Evaluation

**Traces** — `lane.review_advisory` rows (per verdict, with the answer id), the
`lane.ready_for_review` row's `advisory` field (who was asked, route, grade), and the picker
snapshot's `advisory` exclusion on the binding re-pick.

**Eval** — the integration tests pin the rule:
- a named advisory seat gets the marked ask and a binding acceptor is asked beside it;
- an advisory accept records and moves nothing, and the binding accept then closes;
- an advisory decline opens no dispute and reopens nothing;
- the advisory ask stays owed after the close and still records;
- the ladder routes an advisory seat when it ranks first and re-picks without it;
- an advisory accept on a risky lane is never the ADR 188 peer stage.

Headline check in the main run: zero `lane.closed` rows whose closer is an advisory seat.

**Experiment** — the main run of the local model seat (dogfood run 13, lane
`01M2M6NV4C2CNBJYVYQTFMAQRW`) compares each advisory verdict with the closing verdict on the same
lane, under the spec's fixed cheap-seat rule.

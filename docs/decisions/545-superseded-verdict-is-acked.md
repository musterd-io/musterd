# 545 — A reply on a superseded acceptance ask is acked, and escalates nothing

- Status: accepted
- Date: 2026-10-07
- Deciders: nick ("take 01M4C31KQJ next", 2026-10-07)
- Lane: `01M4C31KQJ5XJM3PRAC9N7T2Y0` (goal `board-loops`), follow-up 2/3 of lane `01M4BJX7JJ`
- Builds on: lane 01M1QYHJFY (a re-route supersedes the old ask; a verdict on it binds to nothing),
  ADR 202 (the verdict moves the lane, told on the ack), ADR 188 §4 (a peer's accept on a risky lane
  fires the blocking human ask), ADR 539 (the peer stage is told on the ack), ADR 412 / 414 (the
  departed and reaped re-routes), lane 01M2P2E2H6 (`wait` takes an ask without deciding)

## Context

A re-route (named by a human, a goodbye under ADR 412, or a reaping under ADR 414) closes the old
acceptance ask and mints a new one. The seat that held the old one gets a `resolve` on its thread.
`applyAcceptanceVerdict` treats a verdict on that old ask as binding to nothing. That is right:
honouring both asks would let two seats close one lane.

On 2026-10-07 lane 01M49JNJG3's acceptance moved 37 times overnight. The cause was a host-suspend
bug, which #2194 fixed. miley judged the lane and sent `accept` on ask 01M4BAPXZA, which had already
been superseded. Nothing moved, and her ack said nothing. To her it read exactly like an accept that
had landed. The lane stayed `awaiting_acceptance` until a human closed it.

## Problem

1. **Silent.** A verdict on a superseded ask returns no ack field. The only trace is a server log
   line (`acceptance_verdict_on_superseded_ask`). The sender can't tell "closed the lane" apart from
   "did nothing", which is the ambiguity ADR 202 and ADR 539 each removed on their own paths.
2. **Not inert on a risky lane.** The ADR 188 §4 escalation hook (`gatedLane`) runs before the
   verdict and never checks for supersession. An agent's `accept` on a superseded ask for a risky
   lane recorded `lane.review_peer_confirmed` and fired the blocking human ask. It woke a human for a
   review nobody held. The test below reproduced it.

## Decision

1. **Refuse, and say so — don't count it.** A reply on a superseded ask still binds to nothing. The
   alternative was to count a verdict from a seat that held the ask until recently. That would let
   two seats each close the lane on its own ask, because the new holder may already be judging it,
   and the "recently" window would be a second, competing rule for which ask binds. The record stays
   one-ask-one-verdict. The fix is making the refusal audible.
2. **Checked once, first.** `routeEnvelope` asks `supersededLaneReview` before the escalation and
   verdict hooks, for `accept`, `decline` and `wait`. When the ask answered is superseded and its Lane
   is still awaiting acceptance, none of the escalation, the verdict, the dispute answer or the
   acknowledge runs. The hub's fold of a joiner's `accept` (`handleFoldedMessages`, lane 01M3ZBTJKD)
   asks the same question before it fires the stage-two ask; it has no ack to carry.
3. **One ack field, one sentence.** The ack carries `lane_superseded {lane, ask, current}`, where
   `current` is `{ask, reviewer}` for the acceptance ask open on the Lane now (by
   `openAcceptanceAsk`), or `null`. `laneSupersededAck` in `@musterd/protocol` renders the one
   sentence every surface shows: HTTP and remote-MCP acks, the MCP `team_send` text and
   `structuredContent`, and the CLI line and `--json`. It says the reply moved nothing and names the
   ask that binds now, so the one seat that might hold both asks answers on the right id. This adds a
   protocol helper, hence this ADR (hard rule 1, as ADR 539 did for `laneEscalationAck`). It's
   specified as SPEC Appendix A.21.

The remote-MCP ack (`mcpHttp.ts`) also gains `lane_escalation`, which ADR 539 put on the other three
surfaces but missed here.

## Consequences

- miley's case now answers: "Lane …: the acceptance ask you answered (…) had been re-routed — your
  reply moved nothing. It now waits on X (ask …) — if that is you, reply on that id; otherwise
  nothing is owed."
- A risky lane's superseded peer accept no longer writes `lane.review_peer_confirmed` and no longer
  asks a human.
- After #2194, supersession is rare: it happens only when a reviewer really departs or a human names
  a new acceptor. This ack matters most in exactly those cases, where the old holder is the most
  likely to answer late.
- What it doesn't do is cap re-routes. That is follow-up 3/3 (lane 01M4C31REG), held until a week
  of post-#2194 data shows whether it is needed.

## Observability & Evaluation

**Traces.** The server logs `acceptance_reply_on_superseded_ask {lane, ask}` once per refused
reply. The ack's `lane_superseded` is what the sender sees. No audit row is added: the reply is
already a stored message whose `in_reply_to` names the superseded ask, and the superseding
`lane.review_rerouted` row exists, so the pair is derivable.

**Eval.** Three integration tests on the HTTP send path (`integration.two-stage-close.test.ts`)
were written first and failed before the change:

- the named re-route test's late verdict now asserts `lane_superseded` naming hal's ask and no
  `lane_verdict`;
- a risky lane re-routed gee → hal, where gee's late `accept` gets `lane_superseded`, no
  `lane_escalation`, no `lane.review_peer_confirmed` row, and no human ask (before the change it
  got `lane_escalation {human:'nick'}`);
- a late `wait` gets `lane_superseded`, not `lane_ack`.

`lanes.superseded.test.ts` pins the sentence for both `current` shapes.

**Experiment.** In the month after this lands, look for a `lane.review_peer_confirmed` or
`lane.closed` row whose triggering accept answered an ask named as `superseded_ask` by an earlier
`lane.review_rerouted`. Any such row means the check is bypassed on a path these tests don't drive.
The joiner fold path is guarded by the same call but has no test of its own here.

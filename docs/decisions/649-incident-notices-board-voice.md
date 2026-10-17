# 649 — Incident notices speak as the board

- Status: accepted
- Date: 2026-10-17
- Lane: `01M5623H2WEEW4NHC394EMBR5A` (goal `board-loops`)
- Builds on: [ADR 646](646-dispatch-nudge-board-voice.md) (the dispatch nudge speaks as the
  board), [ADR 266](266-incident-convergence-increment-1.md) and
  [ADR 271](271-incident-convergence-increment-2.md) (the incident notices),
  [ADR 232](232-ledger-seats-every-actor-on-the-roster.md) (service seats)

## Context

The daemon composes four incident notices (`protocol/route.ts`):

- the "park behind it" reply to a reporter whose red matches an open incident;
- the "opened" announcement to the reporters who tripped the threshold;
- the "routed to you" notice to the seat an unclaimed incident fell to, plus the reporters;
- the "resolved" fan-out to the reporters.

Each went out under a member's name: the lane's owner or creator, another reporter, or the seat that
closed the lane. None of them wrote the message. Because a self-send never reaches an inbox, the code
also had to pick a different reporter as the sender whenever the natural voice was the recipient.

ADR 646 made the same objection about the dispatch nudge and moved it to a `board` service seat.
It named the incident notices as the same case and left them for a separate decision. ADRs 266
and 271 never decided who sends these notices; only the code comments did.

## Problem

The record shows members sending notices they never wrote: a reporter announcing an incident, or a
closer telling the others it is resolved. That misattributes acts in the record musterd is meant to
make trustworthy. It also costs code: the voice is worked out per recipient, around the self-send
rule.

## Decision

1. **All four incident notices come from the `board` service seat,** the same seat ADR 646
   introduced. The daemon mints it on first use. The seat module moves to
   `store/boardSeat.ts`, shared by both callers.
2. **The bodies still name who did what:** "now owned by stanley", "resolved by izzo". The facts
   stay in the text, and the sender is the one that composed it.
3. **If `board` names a person or an agent, no notice is sent.** The report, the routing and the
   close are already durable, and the board never speaks as somebody else.
4. **The duplicate reply still skips the lane's owner,** who needs no pointer to their own incident.
   It now goes to the lane's creator when the lane is unowned; before this, the creator was the
   sender, so a reply to the creator was a self-send.

## Consequences

- ADR 271 §4's wake edges are unchanged: a notice wakes its recipient by `meta.incident`
  (`routed_to`, `resolved_by`), never by its sender.
- The per-recipient voice code and its self-send workarounds are gone (`laneVoice`,
  `firstMemberNamed`). The board is never a reporter, so no notice can be a self-send.
- A service seat is never bound to a node (`sync/log.ts`), so a notice sent as `board` cannot be
  refused as `bound_elsewhere` (the stall #2807 fixed for the dispatch nudge), whichever daemon
  minted it.

## Observability & Evaluation

- **Traces:** each notice is an ordinary directed act from `board` with its existing
  `meta.incident`. The `incident.*` audit rows are unchanged.
- **Eval:** tests pin the board as sender of the opened announcement and the duplicate reply (over
  HTTP), and of the routed notice and the resolved fan-out (store level, the latter naming the
  closer in the body). They run on SQLite and PGlite.
- **Experiment:** n/a. This changes the sender, not when or to whom a notice goes.

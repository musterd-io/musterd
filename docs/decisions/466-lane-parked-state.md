# 466 — lane `parked` state: keep a lane, not now

- Status: proposed — 2026-09-28
- Date: 2026-09-28
- Lane: 01M3MTAFBZQD6SS8BQFHR1A3CP
- Builds on: ADR 084 (lanes join the plan), ADR 103 (`defer` for Goals), ADR 192 (outcome acceptance), ADR 083 (advisory contention), ADR 373 (up-next in orientation)

## Context

Nick, 2026-09-28: "if there is a lane that i want to keep but i dont want to do until later … musterd
agents will know what that means." The lane state machine has no word for that. `LANE_STATES` is
`open | claimed | active | blocked | awaiting_acceptance | done | abandoned`
(`packages/protocol/src/lanes.wire.ts`), and each nearby state says something false about a
shelved lane:

- `open` is an invitation. `team_next` serves every `open` lane under "open lanes you could pick up"
  (`store/orientation.ts`, `up_next`), goal-attached ones first, so a shelved lane attached to a live
  Goal is pushed to the top of every seat's brief.
- `blocked` says something outside the lane stops it. A shelved lane is not stuck; a human chose.
- `abandoned` is terminal: the lane leaves the board and reads as "we decided not to".

Goals already have the right verb: ADR 103's `defer` moves a Goal to `wave: "later"`. Lanes have
none, so the team improvises in titles. The board on 2026-09-28 carries
"HuggingFace release … — hold off (human-gated)" as an `open` lane: the hold lives only in prose
that an agent must read and interpret, and `team_next` still offers the lane for pickup.

## Problem

Give a lane a state that means "kept, deliberately not now", that every surface (MCP, CLI, `/live`
board, orientation) reads the same way without parsing a title, and that an agent cannot silently
undo by claiming it.

## Decision

1. **Add `parked` to `LANE_STATES`.** It is non-terminal and unowned: entering `parked` clears
   `owner_seat` and `claimed_at` exactly as the move to `open` does (the release invariant in
   `store/lanes.ts`), because a parked lane is nobody's work in progress.

2. **A parked lane records why.** The Lane gains an optional `parked` object, set on entry and
   cleared on exit:
   `{ by: <member>, at: <ms>, reason: <string, required, ≤ 280 chars>, until?: <ms> }`.
   `reason` is required so the next reader knows what "later" depends on. `until` is advisory: it
   is shown, and it is **not** a timer — no sweep unparks a lane (the ADR 229 sweep stays the only
   lane timer, and it only touches `awaiting_acceptance`).

3. **Transitions.**
   - Into `parked`: from `open`, `claimed`, `active`, or `blocked`, by any Member. An agent may park
     its own lane (it is choosing not to do it now); parking another seat's claimed lane follows the
     same rule as any other state change on someone else's lane.
   - Out of `parked`: to `open` (unpark) or `abandoned`. **Unpark is human-or-parker only**: the
     Member recorded in `parked.by`, or any human Member. An agent that is neither gets a refusal
     naming who can unpark.
   - `lane_claim` on a parked lane is refused with a hint naming `parked.by` and the reason. This
     is a deliberate exception to warn-only contention (ADR 083: "two checks, warn-only, never block"): contention warnings exist
     because two seats may not know about each other, but a park is an explicit decision already
     recorded against the lane, and a claim that overrode it would be the silent undo the Problem
     rules out. The path forward is an `ask` to the parker, or a human unparking.

4. **Every reader treats `parked` as "kept, not offered".**
   - `team_next` excludes parked lanes from "open lanes you could pick up" and shows a one-line
     count (`parked: N — lane_board {state:["parked"]}`), so the brief stays short and the lanes
     stay findable.
   - `lane_board` shows parked lanes by default, grouped after open lanes, with reason and `until`.
   - `/live` and `/board` render parked lanes in their own muted group; the backlog counts in
     `store/insights.ts` do not count them as open.
   - `done`-lane metrics, the review debt readout, and the acceptance backstop ignore them.

5. **Surfaces.** MCP: `lane_update {id, state:"parked", reason, until?}`; CLI:
   `musterd lane park <id> --reason "…" [--until <date>]` and `musterd lane unpark <id>`. The reason
   is carried in the patch; a park without a reason is rejected at the zod boundary.

6. **Versioning.** A new enum member is a wire-visible change. A peer on an older protocol that
   receives `state: "parked"` must not fail the whole board read; the schema accepts it, and older
   renderers that switch on state fall through to their default. This goes in SPEC.md Appendix A as
   Unreleased until the code lands, then into the lane section with a minor protocol version bump.

## Consequences

- The "hold off" titles become state. Migration is manual and cheap: re-park the currently
  prose-held lanes (today, the HuggingFace release lane) with their existing wording as the reason.
- An agent reading its brief no longer sees shelved work as an invitation, and cannot pick it up by
  accident; a human can still unpark in one command.
- `lane_claim` gains its first hard refusal. If this proves too strict in practice (seats asking
  just to claim), the fallback is a `force` flag that records the override against the lane, not a
  return to warn-only.
- `until` without a timer means a parked lane can outlive its date unnoticed. Accepted for now: an
  automatic unpark would re-offer work a human shelved, which is the failure this ADR exists to
  prevent. A later increment may surface overdue parks in `team_next` as a nudge, still without
  changing state.
- Cost: one enum member, one optional Lane field, one migration adding a nullable column, and
  state-switch updates in the files that enumerate lane states today (`orientation.ts`,
  `insights.ts`, `governed.ts`, `laneClose.ts`, `report.ts`, and the web board files).

### Alternatives considered

- **`blocked` plus a reason.** Rejected: it conflates "can't" with "won't yet", and blocked lanes
  keep their owner and stay in "carrying".
- **A `deferred` flag on an `open` lane.** Rejected: every reader that filters on `state === 'open'`
  would need to learn a second field, and one it misses silently re-offers the lane.
- **Reuse Goal `defer` (move the lane's Goal to `later`).** Rejected: it shelves every lane on that
  Goal, and many parked lanes sit on live Goals.
- **Name it `deferred`.** `defer` is already the Goal act (ADR 103), and a lane state with the same
  root would suggest the act applies to lanes. `parked` is distinct and says the lane is kept.

## Observability

- Eval: after one week, count lanes in `parked`, the parks with an `until` already past, and any
  refused claims on parked lanes. Falsifier: if refused claims are frequent and each is followed by
  an unpark within the hour, the hard refusal is friction rather than protection, and Decision 3
  should move to the `force` fallback.

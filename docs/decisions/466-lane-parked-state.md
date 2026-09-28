# 466 — lane `parked` state: keep a lane, not now

- Status: accepted — 2026-09-28 (nick)
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

3. **Transitions — parking is a human's call, and `blocked` stays for real blockers.**
   - Into `parked`: from `open`, `claimed`, `active`, or `blocked`, by a **human** Member only, with
     a `park_reason`. An agent's park is refused, and the refusal points it at `blocked`: a lane
     that cannot proceed (an unmet dependency, an outside wait) is `blocked`, keeps its owner, and
     says why in its detail. That is what keeps the two states from blurring — `parked` always
     means a person chose "not now", never that the work is stuck. An agent that thinks a lane
     should be shelved `ask`s a human.
   - Out of `parked`: to `open` (unpark) or `abandoned`, by a human only.
   - `lane_claim`, or a handoff, of a parked lane is refused (409) with a message naming `parked.by`
     and the reason. This is a deliberate exception to warn-only contention (ADR 083: "two checks,
     warn-only, never block"): contention warnings exist because two seats may not know about each
     other, but a park is an explicit decision already recorded against the lane, and a claim that
     overrode it would be the silent undo the Problem rules out.
   - The rules live in `decideParkPatch` (`sync/claim.ts`), inside `decideLanePatch`, so the local
     PATCH path and the hub's arbitration refuse the same things.

4. **Every reader treats `parked` as "kept, not offered".**
   - `team_next` excludes parked lanes from "open lanes you could pick up" and shows a one-line
     count (`parked: N — lane_board {state:["parked"]}`), so the brief stays short and the lanes
     stay findable.
   - `lane_board` and `musterd lanes` show parked lanes with who parked them, the reason, and
     `until`; the CLI lists them last under their own heading.
   - The web board gives them their own `Parked` column, offers only `unpark` on the card, and never
     `claim`. Backlog counts (`state = 'open'`) already exclude them.
   - The ADR 229 sweep, review debt, and carrying counts never select `parked`.

5. **Surfaces.** Wire: `UpdateLane` gains `park_reason` (1–280 chars) and `park_until` (ms), both
   ignored off the park move; the transport refuses a park without a reason. MCP:
   `lane_update {id, state:"parked", park_reason, park_until?}` (`park_until` as a date string).
   CLI: `musterd lane park <id> --reason "…" [--until <date>]` and `musterd lane unpark <id>`.
   Storage: nullable `lanes.parked_json` (migration v78), replicated through `lane.updated`'s
   `parked` field; the fold of `lane.state_changed` to `parked` also clears the owner.

6. **Versioning.** A new enum member is wire-visible. `Lane.parked` is optional and `parked_total`
   defaults to 0, so a newer client reads an older daemon's board unchanged. SPEC.md enumerates no
   lane states (the protocol package is their one home, `lanes.wire.ts`), so it needs no edit.

## Consequences

- The "hold off" titles become state. Migration is manual and cheap: a human re-parks the
  prose-held lanes (today, the HuggingFace release lane) with their existing wording as the reason.
- An agent reading its brief no longer sees shelved work as an invitation, and cannot pick it up by
  accident; a human can still unpark in one command.
- Agents cannot park, so `parked` cannot drift into meaning "stuck": the board's `blocked` column
  keeps every lane that is actually blocked, with its owner.
- `lane_claim` gains its first hard refusal (nick chose the block over a recorded override,
  2026-09-28). If it proves too strict in practice, the fallback is a `force` flag that records the
  override against the lane, not a return to warn-only.
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

## Observability & Evaluation

- **Traces:** a park, unpark, or refused claim is a lane edge the store already audits:
  `lane.state_changed` (to/from `parked`) and `lane.updated` with the `parked` field carry who,
  when, and why. A refused claim or agent park is a 403/409 on the PATCH and writes nothing.
- **Eval:** after one week of use, count lanes in `parked`, parks whose `until` has passed, and
  refused claims on parked lanes. Falsifier: if refused claims are frequent and each is followed by
  a human unpark within the hour, the hard refusal is friction rather than protection, and
  Decision 3 moves to the `force` fallback. Second falsifier: any parked lane whose reason names a
  dependency or outside wait means `parked` is absorbing `blocked`.
- **Experiment:** n/a — a state and its refusals, not a variant to A/B. **Baseline:** 2026-09-28 — no parked state; one lane held by title prose ("hold off
  (human-gated)") and still offered in `team_next`.

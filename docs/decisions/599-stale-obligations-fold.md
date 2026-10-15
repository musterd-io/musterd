# 599 — Stale obligations fold into a counted line; settled lanes discharge in the pin SQL

- Status: accepted
- Date: 2026-10-15

## Context

The bounded inbox read unions a pinned set of obligations on top of the newest tail (ADR 429) so an act waiting on the reader cannot fall off the page. What discharges an obligation is spelled once, in SQL (ADR 434): an accept/decline naming it, a resolve on its thread, or the recipient's own reply. Two more discharges exist only after load, in the inbox handler: an acceptance ask whose lane has left `awaiting_acceptance`, and a handoff whose named lane is out of play. The handler ships those as `discharged: lane_closed` beside the rows.

Nothing expires an obligation, by design (ADR 090: derived, never stored; nothing but an answer discharges).

## Problem

Measured 2026-10-14 by alfie on their own inbox, lane 01M4YYQCAP:

1. A discharged acceptance ask (big-body's `01M4YY8VETDK18MYXKF00NZN2D`, reason `lane_closed`) stayed listed as unread after it was accepted. The pin SQL does not know the lane-closed shape, so the row is loaded and sent on every bounded read, and ADR 287's cursor cannot pass it behind the backlog. The client un-pins it from the view, but the wire already carried it.
2. Eight directed asks from August sat in full at the top of every read, 15.5k unread behind them. They are genuinely owed, so the pinned set is right to keep them, but a reader owed the same eight acts for two months is not helped by reading them in full on every check, and whatever arrived today is buried under them.

## Decision

1. **A lane's own lifecycle discharges the acts that asked about it, in the pin SQL.** `laneSettledSql` (`packages/server/src/store/discharge.ts`) is the fifth discharge shape: an `ask` whose `meta.lane_review.lane` has left `awaiting_acceptance`, and a `handoff` whose `meta.lane_handoff.lane` is submitted or terminal. Same narrowness as the app-level twins: an unknown lane keeps the act owed, and a lane that returns to play makes it owed again on the next read. Only the structured spelling is read here; a handoff naming its lane in prose stays with the handler's resolver. The handler's `discharged` list is unchanged.
2. **A stale obligation folds; it never expires.** In the MCP adapter's page planner, an obligation older than `STALE_OBLIGATION_DAYS` (7) leaves the full-row budget and is rendered one line each in its own group with a count (`stale_obligations` in the structured reply), oldest first, below the fresh pins and above the ambient fold (ADR 433). It is rendered, so the cursor walks it (ADR 287). Nothing is dropped and nothing is marked discharged: the only thing that clears it is an answer. The rule reads the sender's `ts` (ADR 335); a week tolerates any clock skew a team has. The planner takes the clock as a parameter and applies the rule only when given one.

## Consequences

- An accepted acceptance ask or a settled handoff stops re-entering every bounded read the moment the lane moves; the cursor can pass it.
- A seat owed old asks sees them as a counted group, not a wall, and reads any one by `ids`.
- `countOpenLoops` and the open directed ledger do not take the fifth shape in this ADR; the handler already folds lane-closed for the interrupt line and the human count, so those readers are left as they are.
- The threshold is a constant, not team policy. If a team wants a different week, that is a policy field and a new ADR.

## Observability & Evaluation

- Traces: the structured reply carries `stale_obligations` with ids; a `team_inbox_check` trace shows the count and which acts folded.
- Eval: `packages/server/src/store/inboxPinning.test.ts` (settled lane drops the ask and the handoff, unknown and live lanes keep them) and `packages/mcp/src/tools/inboxCheck.stale.test.ts` (fold, order, cursor walk, the one-week edge).
- Experiment: on the laptop daemon, read fifty's inbox before and after the daemon refresh and record the pinned row count and whether the August asks render in full. Falsifier: a `lane_closed` ask still appearing in `messages` of a bounded read after the lane moved.

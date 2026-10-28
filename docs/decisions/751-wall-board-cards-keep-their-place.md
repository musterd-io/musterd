# 751 — Wall board cards keep their place

- Status: accepted
- Date: 2026-10-28

## Context

The office's wall board pins every lane as a paper card in six state columns (`wallboard.ts`, `render.ts` `wallLaneBoard`). Members already walk to it: a claim takes the card, and a submit or a finish pins it back. But a card has no place of its own. The board lays out each column from the top, in board order, so when one card leaves, every card below it moves up. A card that has just been pinned lands wherever the next free row happens to be. Two viewers who load at different moments can see different boards.

nick, 2026-10-28: "i want the positioning of work cards to actually persist where they are in the lanes, not just a general move animation", and "it should be like a real board. members can move any cards they need to or reposition or crumple then up and throw away if abandoned". The board should also show the goal grid: one row per goal. Agents move cards, and so does the scene, which turns a lane's state change into a walk. Humans do not get a drag control on /live.

Spec: [2026-10-28-wall-board-cards-design.md](../superpowers/specs/2026-10-28-wall-board-cards-design.md).

## Problem

A place that every viewer sees the same, and that survives a reload, cannot be derived on the client. A client-side layout either reflows when anything moves, or it depends on load order. The place has to be a recorded fact, and only the daemon records facts every viewer shares.

## Decision

**A lane carries its card's place.** `LaneSchema` gains an optional `card: { x, y, by, at } | null`:

- `x` and `y` are in `0..1`, within the lane's **cell**. A cell is the lane's goal (`goal_id`, or none) crossed with its board column (`state`, with `ready_for_review` folded into `awaiting_acceptance`, as `Board.tsx` already does).
- `by` names the member who last put the card there. `at` says when.
- Absent or `null` means the lane has no card on the board.

The cell is defined by data the daemon already holds, and the position is relative to the cell. So the daemon never needs the wall's geometry, and a bigger or smaller board renders the same places.

**The daemon places a card whenever its cell changes** — on open, on a state change, and on a goal change — unless the same write names a place:

- It picks from 12 fixed candidate points (a 4×3 grid).
- It takes the point farthest from the other cards already in that cell.
- Ties go to the candidate order rotated by a hash of the lane id, so two cells don't fill in the same pattern.
- `by` is the actor of the write.

The pick is a pure function of the cell's current cards, so a replay of the same writes lands the same places.

**A move to `abandoned` clears the card** (`card: null`, with `by` and `at` kept on the audit row). The card is thrown away, not moved.

**Anyone who can update a lane can place its card.** `UpdateLaneSchema` gains `card: { x, y }` (each in `0..1`). It rides `lane_update` (MCP), `musterd lane update --card <x>,<y>` (CLI), and `PATCH /teams/:slug/lanes/:id`. The daemon stamps `by` and `at`.

- On its own, it moves the card within its current cell.
- With a `state` or `goal_id` change, it places the card in the new cell at that spot.

Moving a card to another column is still a state change. A place never changes a lane's state.

**Every change is on the record.** The write records `lane.updated` with `fields: ['card']`, and the lane's place is part of the board every surface already reads. No new act and no new message: the scene reads the move from successive boards.

**Existing lanes.** A migration places every lane that has no card, in `created_at` order, using the same picker. So the first board after the upgrade already holds places, and nothing reflows on its first move.

## Consequences

- The wall board lays out cards from their recorded places. A card that someone did not move does not move, for every viewer, across reloads. The office's walks (lane 01M5XS67X2, increments 2 and 3) animate a recorded change. They no longer make a change up.
- `lane_update` gains one optional parameter. Its tool description grows by a sentence, and that counts against the hot-tools token budget (lane 01M5X44XXE).
- A position is written on most lane state changes, so the `lanes` row is updated a little more. No new table.
- A cell can fill: 12 candidates is a soft limit. A 13th card takes the least-crowded point and overlaps it, the way paper piles up on a real board. The wall paints a cell's cards oldest first, so the newest is on top.
- Older clients ignore the field; `card` is optional in both directions.
- 2026-10-28 (lane 01M61T04S9): a hub or joiner still on a build without `card` stops its fold at the first `lane.updated` that carries it (`unknown_lane_event`, by design since lane 01M56NXFFB), and resumes once the auto-refresher brings it up to date. Every state change now carries a `card` change, so on a fleet the stop comes within minutes of the first upgraded write rather than on some rare field. Normative text: SPEC.md Appendix A.30.
- Follows-up: increment 2 of lane 01M5XS67X2 (the bigger board with goal rows, cards drawn at their places) and increment 3 (a walk for every recorded move, and a crumple into the bin on abandon), each its own PR.

## Observability & Evaluation

- **Traces:** each placement is a `lane.updated` audit row with `fields: ['card']`, plus the `by` member, so `musterd lane show <id>` lists every move of a card. An abandon's audit row keeps the last place.
- **Eval:** n/a — agents gain an optional parameter. No existing tool behaviour changes, and a lane update with no `card` behaves as it does today, plus the daemon's own placement.
- **Experiment:** n/a — a display fact with no rate to compare. The check is visual: two viewers and a reload show the same board.

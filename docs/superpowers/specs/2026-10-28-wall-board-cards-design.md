# The wall board, made real — design

Lane `01M5XS67X2`. ADR [751](../../decisions/751-wall-board-cards-keep-their-place.md). 2026-10-28.

## What nick asked for

- The wall board shows the **goal grid**: a row per goal, with the state columns across.
- A card **stays where it was put**. Nothing reflows when another card comes or goes, and every viewer and every reload sees the same board.
- It works **like a real board**. Members move cards and reposition them, and they crumple up an abandoned card and throw it away.
- Agents can move cards, and so can the scene, from lane state changes. Humans don't get a drag control on /live.

## What exists today

- `wallboard.ts` projects the lane board into six columns of up to four cards each, stacked from the top in board order.
- Members walk to the board on a claim (they take the card) and on a submit or finish (they pin it back), and they hand a card to the acceptor's desk.
- An abandon gets an in-place ✓ cue.
- The board is a baked prop, `wall/board`: 150×88 units at the far end of the back-right wall.

## The board

**Bigger.** The baked board grows to about **180 × 120** units and moves along the wall to fit. It stays clear of the near window, the clock and the calendar; `layout.test.ts` already guards all three. It's re-rendered in Blender with `--only wall/board`.

**Goal rows.** The board has up to **five rows**:

- Up to four rows for in-flight goals.
- One last row, "everything else", for every other goal and for lanes with no goal.

Rows don't reshuffle as activity changes. Their order is the team's goal order (`report.goals`, wave-ordered), taking the first four goals that have a card on the board. A goal moves rows only when a goal above it ships or empties.

**Row tabs.** Each row has a washi **tab** sticking out past the board's left frame, like an index tab. Its colour comes from a five-tape palette, and the tab carries the goal's first word at 9 units (the lettering floor the board's `+N` badge already uses). On /live the tab's tooltip and the board's accessible name give the full goal name, and the close-up is still a click away: the board opens `/board`.

**Columns.** The six state columns and their caps stay as they are, re-baked at the new width.

**Cards.**
- A card is paper about **11 × 8** units, held by a washi tab, drawn at its recorded place within its cell (ADR 751 `card.x/y`).
- Its tilt comes from the lane seed: a hand's placement, the same for every viewer.
- A cell paints its cards oldest first, so a pile reads newest on top.
- The faded (stopped plan), taken, swinging and pin-hole treatments carry over. The holes are now drawn where cards actually hung.
- A lane with no recorded place (an older daemon) falls back to today's seeded layout, so the board never goes blank.

**The read strip** keeps its rail under the rows.

**A bin** (increment 3, with the toss that fills it) stands on the floor under the board's right end: a small wire wastebasket, baked as `bin`. _(2026-10-28, lane 01M61T09MQ: it stands out on the café tile between the island and the couch's table instead — the floor under the board is behind the counter and the couch from the camera, and a bin there hid every ball. The throw is a lob from the board over the furniture.)_ It shows crumpled paper balls: one per lane abandoned **today** (drawn from the board's abandoned lanes with `updated_at` today), up to six, piled. It empties at the team's midnight.

## Moves

The daemon records every place (ADR 751). The scene compares each board with the previous one, card by card, and the member named in `card.by` acts out each difference:

| What changed | The walk |
| --- | --- |
| A new card (lane opened) | The opener walks to the board and pins it at its place. |
| A card changes cell (claim, active, blocked, submit, done, goal change) | The `by` member walks to the board, takes the card from the old place, and pins it at the new one. The claim, pin and deliver walks that exist today stay as they are; the diff skips any card one of them is already carrying. |
| A card moves within its cell (an agent tidied it) | The `by` member walks over and re-pins it. It's a short stand at the board, with no carry home. |
| A card disappears because the lane was abandoned | The lane's last owner (else its opener — an abandon clears the card, so `card.by` is gone) walks to the board, takes the card, crumples it, turns to the bin and lobs it in an arc. The ball joins the pile when it lands. |

- If the `by` member isn't in the room, the card is still drawn in its new place, and a puff of dust at the old place marks the move. Nothing invisible animates.
- Replays don't walk: when the page loads with history, it draws the board as it stands.
- At most one board walk per member is queued at a time. Further moves catch up in place, with the puff.

## Agents

- `lane_update` gains `card: {x, y}` (0..1 within the cell).
- `musterd lane update <id> --card 0.25,0.7` is the CLI form.
- The tool description says what a cell is in one sentence.
- To move a card to another column, an agent still sets `state`.

## Performance

- The board repaints only when the projected board changes, as it does today.
- The crumple and the toss are actor overlays, with the same budget as a carried card.
- The bin's balls are part of the board layer.
- The bigger board costs one re-baked sprite and changes no frame-time path.

## Increments

1. **Places on the daemon** — lane `01M61T04S9` (ADR 751): protocol `card`, the store and migration, the picker, and `lane_update` / CLI / HTTP. Tests: the picker is deterministic and spreads cards out, a state or goal change re-places the card, an explicit `card` wins, an abandon clears it, the backfill runs, and the audit rows are written.
2. **The board** — lane `01M61T07DA`: the bigger bake, the goal rows with tabs, and cards drawn at their places. _(2026-10-28: the bin moved to increment 3, which is the one that throws paper into it.)_ Checked at /live and /broadcast sizes in `/office-preview`, with a fixture team of about 20 goals and 80 lanes.
3. **The moves** — lane `01M61T09MQ`: the board diff, the walk per row of the table above, the crumple and toss, and the balls in the bin.

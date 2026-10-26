# 733 — The tile mark carries the sparks

- Status: accepted
- Date: 2026-10-26
- Amends: [702](702-the-mark-flat-sand-split-m.md) (§4 the `m`'s stroke and seat sizes; §5 which weight is which)
- Relates to: [704](704-the-wordmark-nameplate.md) (the wordmark's `m`, whose sparks the tile now shares)

## Context

[ADR 704](704-the-wordmark-nameplate.md) drew the wordmark's `m` from the tile mark of
[ADR 702](702-the-mark-flat-sand-split-m.md), at a 74-unit stroke with 46-unit seats, and put a
mustard-700 spark (`#B8860B`, radius 18) in each of the two cuts where the second and third stems
stop short of their shoulders. The tile mark itself never had them. So the favicon, the app icons,
the avatars and the MCP icon showed an `m` without dots, and the wordmark beside them showed one
with.

On 2026-10-26 nick, making a Twitch avatar from `avatar.svg`, asked for the dots, and then for every
place that shows the logo or wordmark to carry them. A first try put radius-15 sparks into the
tile's heavier `m` (80 stroke, 50 seats), where an 18 would have touched the strokes; nick said the
dots were too small next to the wordmark's.

## Problem

Give every full-size mark the wordmark's sparks at the wordmark's size, without crowding the cuts,
and say what happens at the sizes where a spark cannot fit.

## Decision

1. **The tile's `m` is the wordmark's `m`.** Stroke 74 and seat radius 46 on the 1024 viewBox, in
   place of 80 and 50. The path and the seat positions do not change. The seat-to-stroke ratio is
   the same as ADR 702's (0.62 against 0.625), so the seats still read as feet, not keyholes.
2. **Each cut carries a spark**: mustard-700 `#B8860B`, radius 18, at (512, 473) and (729, 473), the
   wordmark's values. At a 74 stroke the cut runs from 453 to 493, so an 18 leaves 2 units clear on
   each side.
3. **The small weight has no sparks.** It thickens the stroke by 26 so the cuts stay open below
   24px. On the new base (stroke 74 + 26 = 100, seats 46 + 13 = 59) that leaves a cut 14 units tall,
   from 466 to 480: a spark would close the cut it marks.
4. **Everything derived from the full weight takes the sparks:** `chip.svg`, `tile.svg`,
   `avatar.svg`, the MCP icon, the raster icons from 24px up, and the deck art that draws the tile.
   Everything on the small weight takes only the new base: `chip-sm.svg`, the console favicon, the
   16px favicon frame and the in-code `MusterdChip`.

## Consequences

- Changed here: `chipMark.ts` (the stroke, the seats and a `CHIP_SPARKS` constant), `MusterdChip` in
  `MusterdWord.tsx`, every file listed in §4, `brand.md` §1, and the tests that pin them.
- The 16px favicon frame and the console's favicon stay sparkless by §3. Every other raster shows the sparks.
- The sparks are mustard on sand. That is the same pair ADR 704 already ships in the wordmark, so
  no new colour is added to the brand.

## Observability & Evaluation

n/a — a brand asset change with no agent-facing behaviour. It is checked by `chipMark.test.ts` and
`brand.test.ts`, which pin the module, the docs assets, the web assets and the MCP icon to one
geometry.

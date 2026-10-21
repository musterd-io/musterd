# 702 — The mark: a split `m` with seats on a flat sand tile

- Status: accepted
- Date: 2026-10-21
- Supersedes: [497](497-the-new-mark.md) (the hand-drawn `m` and its mustard ground; its two-cut, one-in-code and one-source rules stand)
- Amends: [681](681-site-neutral-product-palette.md) (its "mustard stays the one accent: … marks and the logo" line — the mark leaves the accent; mustard stays the accent everywhere else)

## Context

[ADR 681](681-site-neutral-product-palette.md) moved /live, musterd.io and the console onto a
neutral palette because nick read the product in a pitch as too silly, casual and game like. The
mark was left on a flat mustard tile, so the one remaining loud, warm object on a cool page was the
logo. On 2026-10-21 nick asked whether the logo should follow. The work was done as a sequence of
mocks (a private artifact, twenty-one rounds); each round nick picked or rejected, and this ADR
records where it landed.

Findings that shaped it, in order:

- A cooler logo colour was rejected: a cool mark on cool zinc loses the one warm point that makes
  musterd recognisable. nick wanted a subtler yellow instead, then a pastel or glass look.
- A symmetrical double-arch `m` on a gold tile is the McDonald's silhouette. Several early sketches
  were close to it, and nick called it out.
- A pointed peak on each shoulder reads as a row of houses.
- Random hand-drawn jitter reads as a designer's mistake. Hand-drawn reads as intended only when one
  rule is applied to every stroke, so the final shoulder uses one consistent soft corner.
- The traced art sat roughly 40px right and 50px below the tile centre; nick said it need not be
  offset.
- A glass tile (translucent gold gradient) was built and reviewed by slippy on #3152: on a dark
  ground it goes muddy olive-brown, and on white at 16px it washes out. nick also did not like the
  gradient look. Glass was dropped; the tile is flat.
- Seats as heavy as the stems (66 against a 72 stroke) made the mark read as keyholes at 32–64px,
  and the `m` filled only a third of the tile. Slippy's fix is adopted below.

## Problem

Replace the mark on its source assets and in code, with a tile that is quiet on the neutral UI, an
`m` that is not another company's silhouette, and a form that survives 16px, without changing the
brand accent used by buttons, links and the rest of the UI.

## Decision

1. **Tile.** One flat colour, **sand `#EBD9A0`**, on every surface, with a 30% corner radius (307
   on the 1024 viewBox) and a faint brown rim (`#785A0A` at 40%, 20 units) so it holds an edge on
   light greys. No gradient, no transparency, no blur.
2. **Ring.** A clean rounded-square stroke, 48 units wide, centred on the tile. The ink outline of
   ADR 497 is dropped; nothing is traced.
3. **Ink.** Cool slate `#2E3647`, for the `m` and the seats. It replaces zinc-900.
4. **The `m`.** Straight stems and flat-topped shoulders with soft corners. The left stem runs into
   the first shoulder; the second and third stems stop a thin cut short of their shoulders; each
   stem ends in a round **seat**, one per member. The stroke is 80 units and the seat radius 50, so
   the letter leads and the seats read as feet. It is one geometry, in
   `packages/web/src/brand/chipMark.ts`, centred in the ring and filling about half the tile width.
5. **Weights and files.** Full weight (≥24px) is a file; the small weight (stroke +26, seats +13, so
   the cuts stay open) is for <24px and is the only one in code. Files in `docs/design/assets/`:
   `chip.svg` and `chip-sm.svg`; the web copies are byte-identical (`chipMark.test.ts`).
6. **The accent does not move.** The mark's tile colour is the mark's own. Mustard (`--mustard-500`)
   stays the one accent for buttons, links and rules; ADR 681's palette tokens are untouched.
7. **Guards.** The mark never becomes a double semicircular arch, never takes pointed peaks, never
   sits beside red, and never gets a gradient or transparency on the tile. These go in `brand.md`
   §1 "Never".

## Consequences

- Changed here: the two SVG assets and their web copies, `chipMark.ts`, `MusterdChip` in
  `MusterdWord.tsx`, the MCP icon (`brand.ts`, from `chip.svg`), `brand.md` §1, and the two tests
  that pin them.
- **Not changed here, and still on the ADR 497 mark:** `tile.svg` (the isometric tile), `avatar.svg`,
  `badge.svg`, `wordmark.svg`, the console favicon, the committed raster icons
  (`favicon.ico`, `apple-touch-icon.png`, `icon-192/512/maskable`), and the social card, README
  header and deck art under `docs/brand/` and `docs/demo/`. The raster icons need a rasterizer the
  repo deliberately does not carry (`site-files.ts`), so they are re-rendered by hand and committed.
  Until they land the mark is inconsistent across surfaces; `brand.md` says so for the tile.
  Follows-up: deferred — one lane redraws the derived art and re-renders the raster icons from the new files (2026-10-21)
- The wordmark next to the mark was not reviewed in this work and is unchanged.
  Follows-up: deferred — a review of the wordmark and its lockup beside the new mark (2026-10-21)
- The 16px cut was judged in a code mock and in slippy's renders, not in a real favicon. If the
  cuts close up in the ICO, or the rim is too faint on a light tab bar at 16px, the small weight is
  retuned (a 16px-specific raster with a firmer rim is the likely fix).
  Follows-up: deferred — a 16px-specific favicon raster, once the ICO is re-rendered (2026-10-21)
- Slippy could not run a trademark search. Clearance belongs to the attorney-clearance lane, not to
  this ADR.
- The mark's glyph is geometric strokes rather than traced outlines, so it is edited as numbers;
  there is no longer a design source other than the SVG.

## Observability & Evaluation

n/a — a brand asset change with no agent-facing behaviour. It is checked by `chipMark.test.ts`
and `brand.test.ts`, which pin the module, the docs assets, the web assets and the MCP icon to the
same geometry.

# 704 — The wordmark: the nameplate

- Status: accepted
- Date: 2026-10-21
- Relates to: [702](702-the-mark-flat-sand-split-m.md) (the tile mark this wordmark is built beside), [477](477-web-type-recursive.md) (the web's text face; not changed here)
- Amends: [114](114-cli-rollcall-wordmark.md) only where it says the vector wordmark is mono type; the CLI banner it decides is untouched

## Context

`brand.md` described the wordmark as lowercase `musterd` in the brand mono face, with the `d` in mustard.
After the tile mark changed ([ADR 702](702-the-mark-flat-sand-split-m.md)), nick said the typeface did
not match the new logo and asked for the logo's own `m` in the wordmark. The work was a run of mocks
(a private artifact) with nick picking and rejecting each step. What came out of it:

- A single face for every surface was asked for, and the family is free to change. nick chose DM Sans
  for text. That is a separate re-font decision (ADR 477 says so) and is **not** made here.
- The wordmark is drawn, not typeset, so it does not need the text face at all.
- Rounded letters on a lowercase word looked like VMware's wordmark, and so did the composition
  (a short lowercase word with its first letters picked out). Changing the font and the colours did not
  help; changing the composition did.
- Round bowls beside the `m`'s flat chamfered shoulders looked off, so the letters were redrawn in
  the `m`'s own language.
- Cuts and sparks on the other letters made them harder to read (the `r` arm and `e` bar read as stray
  marks), so only the `m` keeps its cuts.
- Yellow was meant to lead. A full mustard plate with ink letters read as hazard signage, so the plate
  stays sand with a mustard edge.

## Problem

Replace the wordmark with one that matches the tile mark, is not another company's composition, puts
the accent where it leads without colouring a letter, and needs no font.

## Decision

1. **The wordmark is a nameplate.** The word on a rounded sand plate (`#EBD9A0`, the tile's
   colour) with a white ring (30 units) and a mustard edge (`#E1AD01`, 22 units). The plate is its own
   ground, so one version works on light and dark pages.
2. **Every letter is drawn.** `m u s t e r d` share the tile `m`'s language: flat tops and bottoms,
   chamfered corners, one 74-unit round-capped stroke, one x-height and baseline. The `m` is the tile
   mark's `m`. Seats (round, radius 46) sit at the foot of each stem (m, u, r, d). Only the `m` has its
   cuts, with a mustard-700 spark (`#B8860B`, radius 18) in each.
3. **Ink is deep teal `#1F6F6B`** for all letters, the `m` and the seats, matching the tile mark.
4. **Spacing is computed, not set by eye.** Gaps come from each letter's real outline and its edge type
   (straight, round or open), about 17% tighter than the first pass. The plate has headroom so the
   `d` and `t` ascenders clear the ring.
5. **One cut, not below ~24px tall.** The strokes hold at that size; below it the tile mark is the
   mark to use.
6. **Where it lives.** `docs/design/assets/wordmark.svg` (the file), mirrored byte-for-byte in
   `packages/web/src/brand/wordmark.svg`, and `packages/web/src/brand/wordmarkMark.ts` (the same geometry as
   data, with `musterdWordmarkSvg` for DOM builders). `MusterdWord` renders it in every topbar and on
   the office mark; `domain` still appends the `.io` after it. The plate's height is `1.75 × chipSize`,
   so existing call sites keep their footprint. `wordmarkMark.test.ts` pins module and files.
7. **Not decided here:** the text face. nick chose DM Sans; adopting it is a re-font across /live, the
   site, the console and the docs, with the font budget and the canvas painters, and needs its own ADR
   amending 477.

## Consequences

- Changed here: `wordmark.svg` (docs and web), `wordmarkMark.ts`, `MusterdWord.tsx` (a `MusterdWordmark`
  component, and `MusterdWord` now draws it instead of the chip plus text), the lockup test, `brand.md` §1,
  and the web architecture tree line.
- The topbar no longer shows the tile mark beside the word; the tile stays the favicon, avatar and
  small-icon mark. The two are one family but are not drawn side by side.
- **Not changed here, still on the old wordmark (text beside the chip):** the README header, the social
  card, the one-slide, the pitch deck and the console lockup. They render the word as text.
  Follows-up: deferred — one lane swaps the wordmark into the README header, social card, one-slide, deck and console (2026-10-21)
- The text face (DM Sans) is the next decision and the larger change.
  Follows-up: deferred — a re-font ADR and lane amending 477 for DM Sans (2026-10-21)
- The `s` is the roughest letter; it is a polyline with chamfers and could be tuned.
- The wordmark is geometric strokes, so like the tile mark it is edited as numbers; the SVG is the
  design source.
- A full custom type family was discussed and is not part of this. The stroke rules (stroke, x-height,
  chamfered corners, seats) are the starting point if it is ever commissioned.
- No trademark search was run. The nearest resemblance nick raised was VMware's; slippy noted
  clearance belongs to the attorney lane.

## Observability & Evaluation

n/a — a brand asset change with no agent-facing behaviour. It is checked by `wordmarkMark.test.ts` and
`MusterdWord.render.test.tsx`.

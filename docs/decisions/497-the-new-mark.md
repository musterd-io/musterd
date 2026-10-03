# 497 — The new mark: a hand-drawn `m` in a white ring replaces the Brand Chip

- Status: accepted
- Date: 2026-10-02
- Supersedes: [154](154-unified-logo-system.md) (the Chip mark and the Tile's face; its surface rules stand)

## Context

ADR 154 gave musterd a letterform-derived mark family: the **Brand Chip** — a flat mustard block with a
reversed mono `m` and a cursor notch — and the **Nameplate Tile**, the chip at the office's 2:1 angle. nick
has commissioned a new logo: a hand-drawn, slightly wobbly lowercase `m` with a tail, inside a white
rounded-square ring, outlined in black. It arrived as a 1024×1024 JPG on a bright yellow (~`#FFC107`) ground —
no vector, no transparency. The old chip's path was hand-copied into six places (two asset directories, the
web module, the MCP adapter), so a swap done by hand would drift.

## Problem

Replace the mark everywhere it is rendered — musterd.io, `/live`, `/broadcast`, the MCP icon, READMEs, decks —
from one source, without changing the brand accent and without shipping a hairline outline that turns to
smudge at favicon size.

## Decision

1. **The mark is the new art, on the existing accent.** The ground is mustard `#E1AD01` (`brand.md` §2), not
   the logo file's yellow; the ink is zinc-900 `#18181B`, not the file's near-black. The accent does not
   change — this is a logo swap, not a retheme.
2. **One traced vector is the source.** The JPG was traced to SVG (contour tracing at sub-pixel precision,
   simplified to integer coordinates on a 1024 viewBox) and split into three paths: the **ring**, the ink
   **outline**, and the **glyph**. `docs/design/assets/chip.svg` is that source; `packages/web/src/brand/chipMark.ts`
   exports the same three paths; a test pins the module, the docs asset and the web asset byte-for-byte.
3. **Two cuts.** At or above 24px the **full** cut draws all three. Below it the **small** cut drops the
   outline (sub-pixel there) and thickens the glyph with a 28-unit round-joined stroke
   (`docs/design/assets/chip-sm.svg`). The favicon uses the small cut; the MCP icon and README use the full one.
4. **The tile keeps its job.** `tile.svg` maps the full mark onto the isometric top face with one matrix;
   the front slab and glow are unchanged.
5. **The corner radius is ≈22%** (224/1024), the old chip's 7/32, so the mark sits in the same slots.
6. **The CLI is text.** A terminal cannot draw the mark, so the banner keeps the roll-call nameplate and the
   `musterd` word and no longer styles the word as a mustard chip (ADR 114's chip), which would now
   contradict the mark.
7. **`brand.md` §1 is rewritten** and the "never a standalone glyph" rule is restated: the mark is the
   letterform itself, never a lone capital `M` or an icon that isn't the `m`.

## Consequences

- Raster derivatives (social card, avatar, README header, the one-slide PDF, the deck's baked screenshots)
  are re-rendered from the new source in follow-up lanes under goal `new-logo`; this ADR's lane ships the
  source, the web and MCP renderers, the favicon, and the docs.
- The mark is ~9 KB of path data in `chipMark.ts` (lazy-loaded with the office scene; inline in React
  elsewhere), against ~0.5 KB for the old chip. The small cut is ~4.7 KB.
- A traced mark is only as faithful as the trace. If a vector master arrives from design, replace the three
  paths in `chipMark.ts` and the SVG files together; the byte-equality test will say if one is missed.
- ADR 154's `## Decision` stays frozen; it carries a dated note pointing here.

## Observability & Evaluation

n/a — a brand-asset swap, not agent-facing behavior. Correctness is pinned mechanically:
`pnpm --filter @musterd/web test` (`chipMark.test.ts`, `MusterdWord.render.test.tsx`) and
`pnpm --filter @musterd/mcp test` (`brand.test.ts`) hold the geometry byte-equal across the module, the
docs assets and the web assets. The review that matters is a visual check at 13, 16, 32 and 512px.

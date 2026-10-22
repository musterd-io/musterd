# 705 — Web type: DM Sans replaces Recursive

- Status: accepted — 2026-10-21
- Date: 2026-10-21
- Lane: `01M5GW3H03P45QN9RQRJ3NPRD5` (goal `new-mark`)
- Deciders: nick (chose DM Sans from the type trial, 2026-10-21), sloane (companion mono, after the ask window)
- Supersedes: [ADR 477](477-web-type-recursive.md) (the Recursive type choice)
- Relates to: [ADR 037](037-web-surface-aesthetic.md), [ADR 681](681-site-neutral-product-palette.md), [ADR 704](704-the-wordmark-nameplate.md), [ADR 151](151-web-perf-budgets-gate.md) / [ADR 183](183-two-js-budgets.md)

## Context

ADR 477 put the web on one family, Recursive, in three committed cuts: casual for display, linear for body, mono for data. On 2026-10-21 nick compared Figtree, Plus Jakarta Sans, Bricolage Grotesque, Lexend, DM Sans and Onest on the same /live slice and chose DM Sans: warm, SaaS-clean, rounded enough to sit with the mark. The wordmark is the drawn nameplate (ADR 704) and does not depend on the text face.

The companion mono was open. An ask to nick (`01M5GWP59C67EGQWY251HJBR1A`, standard, 5 minutes) named DM Mono. The window passed with no answer. Measurement then changed the recommendation, recorded on `01M5GX3XBQA73BXH3TQ67CYWNW`.

## Problem

The product already sets `--font-mono` at 600 and 700 (the console's code lockup, allowance, settings, /live labels). DM Mono is static and stops at weight 500, so those weights would synthesize. DM Sans has no `tnum` feature: its digits are proportional (measured: 0 at 656 units, 1 at 342). Data alignment has to come from the mono. Canvas still needs a real family name, because `ctx.font` cannot set axes.

## Decision

1. **Text is DM Sans. Data is JetBrains Mono.** Both `--font-sans` and `--font-display` are DM Sans. There is no casual cut. `--font-mono` is JetBrains Mono. The CLI still inherits the user's terminal font. The wordmark stays the drawn nameplate (ADR 704).
2. **The cuts are committed files, not a runtime dependency.** No `@fontsource` package is added.
   - `dm-sans-latin.woff2` is the latin opsz file from `@fontsource-variable/dm-sans@5.2.8` (62724 bytes). Axes: opsz 9–40 (default 9), wght 100–1000 (default 400). The CSS family is `DM Sans`. The name table says `DM Sans 9pt` (version `4.004;gftools[0.9.30]`). The name table stays as shipped; the reserved-name rule is about the font software, and this file is unmodified.
   - `jetbrains-mono-latin.woff2` is a latin subset of the upstream variable font (47276 bytes, version `2.305`). Axis: wght 100–800. Name id 1 is `JetBrains Mono`. Digits are already equal width (600). The subset keeps the name table. It was cut without `--obfuscate-names`.
3. **Where each file is served.** `packages/web/src/styles/fonts/`, `packages/console/assets/fonts/`, and `packages/allowance/assets/fonts/`, each with both OFL texts. The three Recursive cuts move to `docs/demo/fonts/` so the dated decks (2026-10-01, 2026-10-09) keep resolving. `scripts/fonts/instance-recursive.py` stays, and its header says a rerun would write allowlist-failing files back into the web font directory.
4. **Canvas and optical size.** CSS `font-optical-sizing` is `auto`, so the DOM varies opsz with size. Canvas paints the file default, opsz 9. `font-variation-settings` inside `@font-face` stays unused (ADR 477: it is not portable).
5. **`budgets.json` allowlists `dm-sans` and `jetbrains-mono`.** `totalFontBytes` tightens from 164000 to 127000. Source bytes are 110000; 127000 is that sum plus 15%, rounded (ADR 183). JS ceilings do not move.
6. **Scope.** /live, musterd.io, the console, allowance, the living pitch deck, `brand.md`, `DESIGN.md`, and the living Figma briefs. Dated decks keep Recursive and point at `docs/demo/fonts/`. Frozen specs stay as the record of the day they were written.

## Consequences

- Display weight 780 and the mono weights 600 and 700 are inside the axes, so they render from the file.
- DM Sans digits stay proportional. A column that must align uses `--font-mono`.
- The public site deploy stays with miley (ADR 308). `/live` republishes from `main` without a daemon bounce.
- `brand.md` §3 and §7, `tokens.css`, `global.css`, the canvas fallbacks, the console, and allowance change in this commit.
- The `.site-page` / `.join` rule that sets `--font-display: var(--font-sans)` (ADR 681) now assigns DM Sans to DM Sans. It stays.
- Dated decks that still say Recursive load `docs/demo/fonts/recursive-*.woff2`. The living pitch deck (`docs/demo/pitch/deck.html`) uses these two files. Its `--word` lockups are slide type in JetBrains Mono. The product wordmark is the nameplate.

## Observability & Evaluation

- **Traces:** n/a — a static asset and token change. No runtime path emits anything new.
- **Gate:** `pnpm perf:check` fails a font file in `packages/web/dist/client` whose name does not start with `dm-sans-` or `jetbrains-mono-`, and fails when those bytes exceed 127000.
- **Eval:** n/a — no traffic to score. The check that would falsify the mono is a 720p capture of ids and timestamps.
- **Experiment:** n/a — nick chose DM Sans from the side-by-side trial. The mono was chosen by measuring the weight axis and the digit widths after the ask window, and that choice is the status act named above.
- **Falsifier:** the mono fails if a 720p capture shows ids, timestamps or the console code lockup less legible than Recursive Mono at the same size, or if a weight the CSS already asks for (600, 700) synthesizes. Then the mono file changes and the text face stands. The text face fails if chyron labels at the sizes /live paints are illegible at 720p. Then the text file changes and the mono stands.

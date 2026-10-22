# 477 — Web type: Recursive replaces Inter, Space Grotesk and Space Mono

- Status: accepted — 2026-09-29
- Date: 2026-09-29
- Lane: `01M3QD3Q8BWSHHRT1FA6K5NTJZ` (goal `launch`)
- Deciders: nick (chose direction A from the type trial, 2026-09-29), miley (designer)
- Relates to: [ADR 037](037-web-surface-aesthetic.md) (web carve-out; its "Inter + JetBrains Mono
  are the only typefaces" anchor is what this replaces), [ADR 151](151-web-perf-budgets-gate.md) /
  [ADR 183](183-two-js-budgets.md) (font allowlist and budget), `.agents/skills/designer` (tell 7)

## Context

`brand.md` §3 named two typefaces, Inter and JetBrains Mono. The web did not follow it: since the
izzocam re-font, `tokens.css` has used Inter for body, Space Grotesk for headings and Space Mono for
data, with no ADR recording the change. So the doc and the code disagreed.

On 2026-09-29 nick endorsed a list of the ten tells of an AI-generated UI (now the designer skill's
checklist). Tell 7 is default fonts, and Inter and Space Grotesk are the two faces that list and the
artifact-design guidance both name as the generic choice. Our surfaces are meant to be warm, quirky
and on-brand. Our type was the most generic part of them.

miley built a type trial: the same /live slice (hero, team column, goal card, ticker, CLI block) set
in three directions next to today's fonts. The directions were A, Recursive; B, Fraunces with
Hanken Grotesk and Martian Mono; and C, IBM Plex. nick chose A.

## Problem

We needed one type decision that the doc and the code both follow. It had to lose the default look,
keep data legible at stream size (720p encodes of a 1920 stage), and stay inside the ADR 151 font
budget. Canvas painters need a real family name, because `ctx.font` cannot set variable axes.

## Decision

1. **The web uses one family, Recursive** _(Amended 2026-10-21: ADR 706 supersedes this choice. The text face is DM Sans and the data face is JetBrains Mono.)_ (OFL-1.1, Arrow Type), in three cuts:
   - `Recursive Casual` (CASL=1) for display: headings, member names, chyron labels, and canvas
     labels, through `--font-display`;
   - `Recursive` (linear) for body, through `--font-sans`;
   - `Recursive Mono` (MONO=1) for data: timestamps, ids and the CLI mirror, through `--font-mono`.
2. **The cuts are committed files, not a runtime dependency.** `scripts/fonts/instance-recursive.py`
   instances the upstream latin variable font (`@fontsource-variable/recursive@5.3.0`, `full` axes)
   into three latin-only woff2 files. Each keeps a 400–800 weight axis and pins slant 0 and
   cursive 0.5. They live in `packages/web/src/styles/fonts/` with the OFL text. Separate family
   names are what make the casual and mono axes work in every browser and on canvas. The
   `font-variation-settings` descriptor in `@font-face` is not portable, and canvas cannot set axes.
3. **The four `@fontsource` packages are removed** (inter, space-grotesk, space-mono,
   jetbrains-mono). No dependency is added.
4. **`budgets.json` allowlists only `recursive`,** and `totalFontBytes` tightens to measured + 15%.
5. **Scope.** This covers the web surfaces and the Figma frames. The CLI still inherits the user's
   terminal font. The wordmark is unchanged (lowercase JetBrains Mono, as drawn). Redrawing it is a
   separate decision.

## Consequences

- 2026-10-21: [ADR 706](706-web-type-dm-sans.md) supersedes the type choice. The text face is DM Sans and the data face is JetBrains Mono. The three Recursive cuts remain in `docs/demo/fonts/` for the dated decks.
- 2026-10-20: [ADR 681](681-site-neutral-product-palette.md) sets the public site's and the console's
  headings in the linear cut. The casual cut keeps the display role inside /live and the office.
- Fonts in `dist/client` go from 554.5 KB (the 2026-07-29 baseline) to 139.1 KB in three files. The
  eager latin set a /live viewer fetches goes from 169.5 KB to 142.5 KB. Any weight from 400 to 800
  now renders from the same file, so the odd weights in the CSS (480, 550, 650, 750) are real
  instead of snapped.
- `brand.md` §3 and §7, `tokens.css`, `global.css`, `packages/web/AGENTS.md`, and the canvas font
  fallbacks change in this commit.
- The Figma frames still show the old faces. Re-fonting them is designer follow-up work, tracked on
  the lane.
- 2026-09-29: the web lane (01M3QD3Q8) closes on the web half: #1833 plus the #1839 token-order
  fix. Decision 5's Figma scope is unchanged and moves to a dedicated lane. Follows-up: 01M3QQD3FB36JQGG14Z27T6J84
- 2026-09-30: the Figma half landed (lane 01M3QQD3FB36JQGG14Z27T6J84). All three files (Brand,
  Dashboard, Terminal UX) now use Recursive: weight 600 and up → Sans Casual, lighter Inter →
  Sans Linear, JetBrains Mono → Mono Linear. The Brand text styles point at the same cuts. The
  wordmark text (`musterd`) and the Brand Wordmark and Assets pages keep JetBrains Mono, so the
  exported assets in `docs/design/assets/` are unchanged. The same pass fixed avatar frames that
  were drawn 7–12 px wide instead of round.
- Re-cutting (a new upstream version, another subset, another axis) means rerunning the script and
  committing its output. The allowlist does not change as long as the file names stay `recursive-*`.
- Recursive's casual axis gives /live and the office a hand-drawn warmth, while body and data stay
  strict. If the casual cut reads as childish at chyron sizes, move `--font-display` to the linear
  cut. That is a one-line token change, not a new ADR.

## Observability & Evaluation

- **Traces:** n/a — a static asset and token change; no runtime path emits anything new.
- **Gate:** `pnpm perf:check` measures font bytes and fails on any non-`recursive-` font file.
- **Eval:** stage-size captures of /live and /broadcast at 1280×720 and 1920×1080, before and after,
  checked against the designer skill's ten tells and for `@`, `0O1Il` legibility at the 720p encode.
- **Experiment:** n/a — nick chose from the side-by-side type trial; there is no traffic to split.
- **Falsifier:** the choice fails if the 720p stream capture shows data (ids, timestamps, contact
  line) less legible than Space Mono did at the same size. Then the mono cut changes, and the rest
  of the decision stands.

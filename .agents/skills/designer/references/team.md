# This team: musterd's surfaces

Read before the first piece of work in a session. A team that installs the designer role writes its
own version of this file (`building-a-role-skill`). Paths are relative to the musterd repository;
ADRs are in `docs/decisions/`. miley and slippy hold the designer role; only miley deploys the site
(ADR 308).

## Sources that win over this skill

1. `docs/design/brand.md`: §1 name and wordmark, §2 color (the mustard and zinc ramps, semantic
   colors, the ANSI mapping the CLI must obey), §3 type (Recursive in three cuts, ADR 477), §4 voice,
   §5 glossary, §7 the web carve-out.
2. `PRODUCT.md`: personality, design principles, accessibility, and **Anti-references** (the
   SaaS-dashboard cliché, chat-app skins, over-animated dashboards, glass and neon, "AI made this").
3. ADR 037: the marketing site may go maximal; product chrome stays minimal. Know which you are on.
4. `docs/design/figma-brief-*.md`: the frames the CLI output and dashboard views must match.
5. Copy specs, owned by comms: `homepage-copy-spec.md`, `watch-page-copy-spec.md`,
   `join-page-copy.md`, `tour-web-copy.md`.

## The surfaces

| Surface | Code | Decisions and specs |
| --- | --- | --- |
| `/live` and the office scene | `packages/web/src/routes/live.tsx`, `src/live/`, `src/live/office-scene/` | ADR 079, 086, 464, 488; `docs/superpowers/specs/2026-10-13-office-liveliness-design.md` |
| `/board` | `src/routes/board.tsx`, `src/live/Board.tsx` | ADR 104, 256, 582 |
| `/broadcast` (stage fixed at 1920×1080) | `src/routes/broadcast.tsx`; capturer `packages/cli/src/commands/broadcast.ts` | ADR 157, 228, 488 |
| musterd.io | `src/routes/index.tsx`, `src/components/site/` | ADR 302, 567, 568, 571; `homepage-copy-spec.md` |
| `/watch`, `/start`, `/join`, the tour | `src/components/site/`, `src/components/tour/` | their copy specs |
| CLI output | `packages/cli/src/render/`, `src/help/`, `src/tour/screens.ts` | ADR 113, 114; `figma-brief-terminal.md` |

## Tokens

Mustard `#E1AD01` is 2.06:1 on white. On light surfaces, accent marks use `mustard-700` `#B8860B`
(3.25:1) and accent text uses `mustard-900` `#7A5A06` (6.38:1); mustard itself is a fill behind dark
text or the accent on dark surfaces (brand.md §2; the table in
`.agents/skills/comms/references/charts.md`).

`packages/web/src/styles/tokens.css`, `src/brand/brand.css`, the `.lc` block in `src/live/Live.css`,
`src/live/canvasFont.ts` for canvas text, and `src/live/office-scene/motion.ts`, the source of truth
for motion: five durations in whole 25 fps frames (120, 200, 280, 400, 600 ms) and three easings
(ADR 329). A member's color is a hue in their seat file (ADR 374).

## Gates

| Gate | Command | Notes |
| --- | --- | --- |
| Performance budgets | `pnpm build` then `pnpm perf:check` | `docs/perf/budgets.json`; build first, the check reads `dist` (`docs/wiki/perf-gate-blind-spots.md`). Raises are logged in `docs/perf/web-live-baseline.md` and may only follow ADR 183's ritual. CI's gzip lands 50–300 B above a laptop's (`budgets.json` `$comment`), so a laptop pass within that margin is not a pass. A value import of `@musterd/protocol` in web pulls zod onto the eager graph; import types only (the 2026-09-02 entry) |
| Contrast on painted pixels | `pnpm a11y:check`; ad hoc `pnpm a11y:contrast <url>` | CI sweeps every prerendered route and `/board`, `/live` on a fixture team; `docs/a11y/contrast.md` |
| Target size | `pnpm a11y:targets:check` | 2.5.8 at 390×844 and the 24 px floor; `docs/a11y/target-size.md` |
| Motion tokens | `pnpm tokens:check` (in `format:check`) | Fails on drift from `motion.ts` |
| Scene pixels | `pnpm scene:pixel-check` | |
| CLI against Figma frames | `pnpm --filter @musterd/cli test` | Frame tests in `orient.test.ts`, `seats.test.ts`, `tour/screens.test.ts`; AGENTS.md hard rule 2 |
| Landing structure | `packages/web/src/routes/landing.test.ts` | Section order, one office |

There is no axe run in CI; structure is linted by `eslint-plugin-jsx-a11y`. The manual pass in
`references/accessibility.md` §4 covers the rest. Open question for the role: WCAG 2.2.2 asks for a
pause control on `/live`'s self-moving scene.

## Capturing

Headless Chrome over CDP with `Emulation.setDeviceMetricsOverride` at 1920×1080, 1280×720 and
390×844. Working code: `scripts/a11y/target-size-sweep.mjs`, `scripts/perf/scene-pixel-check.mjs`,
the broadcast capturer. Traps: `docs/wiki/browser-verification.md`,
`docs/wiki/measuring-a-moving-page.md`, and these:

- The Claude-in-Chrome extension cannot open `localhost`. Use the chrome-devtools MCP, whose resize
  floors at ~500 px wide, or drive your own headless Chrome over CDP. The MCP's browser profile is one
  per machine, so another session can be holding it; your own CDP script never collides.
- The idle office is baked to an offscreen buffer (`office-scene/index.ts`). After a `render.ts` edit,
  reload the page before judging it; a hot update can leave the old bake on screen.
- A `Page.captureScreenshot` clip is in page coordinates. Add `scrollY` to a `getBoundingClientRect`, or
  you capture the wrong band of the page.

## Local rules, each from an incident

| Date | What happened | The rule |
| --- | --- | --- |
| 2026-08-03 | The broadcast stage ignored `?h=720` after hydration; captures clipped (#614) | Derive the stage size after hydration |
| 2026-08-05, 08-12 | 19, then 9, contrast failures: fill tokens used as text | `a11y:check` became a CI gate; fill and ink token pairs |
| 2026-08-13 | Dimming with opacity dropped roster text to 2.34:1 | Dim the dot and avatar, never the words |
| 2026-08-26 | A motion change declined: the gate could not see whole seconds (#1079) | Fixed in #1082; ADR 329's evidence corrected |
| 2026-09-01 | Main went red at exactly the budget; `perf:check` read a stale build | Build before the check |
| 2026-09-16 | The /watch eyebrow said "between sessions" over a live player (#1487) | No state words in prerendered HTML |
| 2026-09-21 | `/live` topbar buttons at 19×30; two offices in one phone viewport | The target-size gate; ADR 428 (`docs/wiki/site-audit-as-a-stranger.md`) |
| 2026-09-23 | Live CSS breached its budget | ADR 441 gave it its own budget |
| 2026-09-29 | Slop-tells passes removed glass and gradients (#1864, #1866) | The tells catalog |
| 2026-10-01 | A lane declined: off-centre at 1280×720, black at 390 px (#1917) | Capture at true stage size |
| 2026-10-09 | The /broadcast lower-third reverted for repeating the frame (#2274) | Say it once |
| 2026-10-12 | Replay-on-open (#2429) reverted in #2445: the room did not fill when a walk was in the window | Meet the promise as seen |
| 2026-10-13 | Two office details merged short of their promise and needed a second PR on the same lane: pin holes (#2489, then #2506) and a bubble that faded to invisible over the wall board (#2519, then #2541, which slides it aside) | Meet the promise as seen, at real size |

## Practice skills to route to

| When | Skill |
| --- | --- |
| Any copy question | `comms` |
| A wireframe | `squig` |
| A review finding | `a-finding-is-not-a-fix-request` |
| Calling a change done | `definition-of-done` |
| A design decision | `decision-records` |
| Docs that disagree with the shipped UI | `docs-that-catch-drift` |

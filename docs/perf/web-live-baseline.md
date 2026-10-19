# Web UI performance baseline — /live

**Date:** 2026-07-17 · **Commit:** `8932ef9` (main @ ADR 150 foundation) · **Author:** miley

First recorded performance baseline for the /live dashboard, taken after the recent feature wave
(ADR 149 asks strip #317, speech bubbles #321, re-font #322). All future perf-affecting changes
should be compared against these numbers by re-running the harness.

> **Enforcement (ADR 151):** byte budgets derived from this log live in `budgets.json` beside this
> file and are enforced in CI by `pnpm perf:check`. Raising a budget happens in the PR that needs it,
> with the measured cost appended to the optimization log below. The working contract for agents in
> the web package is `packages/web/AGENTS.md`.

## Method (reproducible)

```sh
pnpm build
# throwaway daemon on :4890 against a COPY of the real DB (never restart the shared daemon):
sqlite3 ~/.musterd/musterd.db ".backup '/tmp/musterd-copy.db'"
MUSTERD_DB=/tmp/musterd-copy.db MUSTERD_PORT=4890 node packages/cli/dist/bin.js serve \
  --web-root packages/web/dist/client &
node scripts/perf/live-baseline.mjs "http://127.0.0.1:4890/live?team=revive" --window 12000
npx --yes lighthouse@12 "http://127.0.0.1:4890/live?team=revive" --quiet \
  --chrome-flags="--headless=new" --only-categories=performance --output=json
```

`scripts/perf/live-baseline.mjs` is dependency-free (headless Chrome over CDP, native `fetch` +
`WebSocket`). `/live?team=<slug>` auto-provisions an observer seat, so the page measured is the
**connected** dashboard with the real team's data (roster, backfill, office scene), not the
unauthenticated shell. For the live-data latency probe, point a copy of `.musterd/binding.json` at
the temp daemon (`server: http://127.0.0.1:4890`) — the binding's embedded `server` overrides
`MUSTERD_CONFIG`, so a probe run from the real worktree posts to the real team.

## Baseline numbers

### Local, unthrottled (median of 3 connected runs, headless Chrome, M-series Mac)

| Metric                                 | Value                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------- |
| TTFB (document)                        | 7–29 ms                                                                   |
| FCP                                    | ~300 ms                                                                   |
| LCP                                    | ~300 ms typical, **outliers to 2.3 s** (backfill-render long task)        |
| DOMContentLoaded / load                | ~120 ms / ~270 ms                                                         |
| CLS                                    | 0.004                                                                     |
| Long tasks during load                 | 2–3, totaling 120 ms–1.0 s (worst observed single task ~1 s)              |
| FPS over 12 s (office scene animating) | 56–60 avg · p95 frame ~18–21 ms · **worst frame 42–794 ms**               |
| JS heap after settle                   | 11–14 MB                                                                  |
| DOM nodes                              | ~6,900                                                                    |
| Requests / transferred                 | 28 / **1,077 KB** (Script 622 · Fetch 120 · Font 117 · CSS 115 · Doc 103) |

### Lighthouse 12, simulated throttling (slow 4G + 4× CPU)

| Metric                       | Value             |
| ---------------------------- | ----------------- |
| **Performance score**        | **49 / 100**      |
| FCP / Speed Index            | 5.5 s / 5.5 s     |
| LCP / TTI                    | **7.2 s / 7.2 s** |
| Total blocking time          | 540 ms            |
| Main-thread work / JS bootup | 4.7 s / 1.3 s     |
| Total byte weight            | 1,076 KiB         |

### Bundle (vite build, raw / gzip)

| Chunk                 | Raw                                                                              | Gzip       |
| --------------------- | -------------------------------------------------------------------------------- | ---------- |
| index (entry)         | 320 KB                                                                           | 100 KB     |
| routes                | 114 KB                                                                           | 41 KB      |
| dist (protocol)       | 72 KB                                                                            | 18 KB      |
| render                | 38 KB                                                                            | 15 KB      |
| live                  | 33 KB                                                                            | 11 KB      |
| office-scene          | 25 KB                                                                            | 10 KB      |
| **All JS**            | **674 KB**                                                                       | **216 KB** |
| **All CSS**           | **125 KB**                                                                       | **38 KB**  |
| Fonts in dist (woff2) | 838 KB → **335 KB** (Inter+JetBrains dropped, #4); /live loads ~117 KB (7 files) | —          |

### Live-data latency (event → dashboard WS frame)

- Daemon handles the `POST /messages` in **~23 ms** (server-side, temp daemon).
- CLI probe start → WS frame at the page: **491–717 ms**, but the CLI process itself takes
  650–920 ms (Node startup + post-send inbox reads) — the daemon→page push is a small fraction.
  Treat **≤ ~100 ms send→pixel** as the real transport budget; the harness reports the
  CLI-bounded number (`cmdStartToFrameMs`).

## Optimization log

| Date       | Change                                                                              | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-18 | Finding #1: daemon br/gzip + Cache-Control/ETag                                     | throttled Lighthouse **49 → 71** · LCP 7.2 s → 4.3 s · FCP 5.5 s → 3.1 s · transfer 1,077 → 467 KB                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-07-18 | Finding #5: API JSON (`/teams/*` reads) compressed                                  | /live backfill Fetch **124 → 39 KB (−69%)** · transfer 467 → 381 KB · `uses-text-compression` audit cleared · throttled Lighthouse ~82 (median of 3), LCP ~3.6 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-07-18 | Finding #3: stream DOM windowing (bounded rows)                                     | DOM **4,461 → 1,564** (audit 0 → 0.5) · TBT ~210 → **10–20 ms** · load long-tasks 120 ms–1 s → **53 ms** · heap 12 → 8 MB · worst frame 794 → 21 ms · score ~85                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-07-18 | Finding #4: drop dead font families + izzocam canvas                                | dist **−503 KB** (Inter+JetBrains removed) · render-blocking `global.css` **56 → 14 KB** · office/character canvas now paint izzocam via type tokens · /live font download unchanged (7 files, ~117 KB)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-07-19 | Office loop: suspend while panel collapsed                                          | collapsed office **~18 draws/s → 0** (was full-scene repaint at `opacity: 0`) · expanded/alive unchanged (18 draws/s ambient cap, ~2.5% core) · re-expand still instant (fresh bake + one sync frame)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-07-20 | Re-font body `--font-sans` Fraunces → Inter (latin)                                 | editorial serif read too magazine-y for dense stream/office message UI. Swapped body face to Inter (latin subset, 4 weights); Grotesk/Mono unchanged; Fraunces `@import`s dropped. `perf:check` fonts **708 → 554 KB** (Inter latin < Fraunces ×4), CSS gzip 16.9 → 16.7 KB, JS unchanged. Allowlist `fraunces` → `inter`. Canvas bubbles re-font via `canvasFont.ts` token + fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-07-28 | Asks strip → rail + floating sheet (budget raise)                                   | CSS gzip **19.4 → 19.9 KB** (+534 B): the strip's header/count/quiet block is gone, but the rail adds a shrink chain, three responsive tiers, an origin-anchored sheet transition, and a reduced-motion block. Trimmed first — both rail buttons reuse `.lc-ask__btn` instead of redeclaring the pill, and the rail dropped its `backdrop-filter`. `totalCssGzipBytes` **20,000 → 21,000**. JS +0.0 KB, fonts unchanged. **NB: main measured 19,867 / 20,000 B (99.3%) BEFORE this change** — the CSS budget was already spent, so the next CSS-touching PR of any size would have failed it too. The raise restores ~1 KB of working headroom rather than buying this feature specifically.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2026-07-28 | Office overlay → steerable member reel (budget raise)                               | CSS gzip **20,368 → 20,961 B (+593 B)** for two rounds of redesign: the full-bleed scrim and its lane stack are gone (the office got its bottom fifth back), replaced by a contained lower-third card, a segmented cycle rail, and — new — the `/live` steering group (chevrons, position counter, hover lift, focus ring, paused-rail state). Trimmed first: the card's accent set is four local custom properties rather than repeated literals, `.lc-ov__src`/`.lc-ov__more` share one rule, and no `backdrop-filter` anywhere (a blur here is a per-frame GPU readback on the 30 fps capture). JS +0.8 KB (the reel's steering state), fonts unchanged. **NB: main measured 20,368 / 21,000 B (97%) BEFORE this change** — the ceiling raised this morning for the asks rail was already 97% spent by lunchtime, so this raise again restores working headroom rather than buying this feature. Two raises in one day is the signal: the next CSS-heavy feature should come with a trim pass, not a third bump. `totalCssGzipBytes` **21,000 → 22,000**.                                                                                                                             |
| 2026-07-29 | ADR 183: split the JS budget in two + first re-baseline                             | Added `initialJsGzipBytes` (worst route's eager graph, **124.1 KB** on `/asks-preview`) beside the existing all-chunks total (**201.7 KB**, 29 chunks) — the two were ~40% apart, and the single total could not be moved by the lazy-loading its own failure text recommended. Re-baselined every budget to measured **+15%**: total JS **250,000 → 238,000**, fonts **760,000 → 653,000** (both _tightened_ — the roadmap removal and the Inter re-font were never captured), CSS unchanged at 22,000, and `maxChunkGzipBytes` **held at 112,000** because measured+15% would have loosened it to 115,000. That is the ratchet guard: a re-baseline may tighten freely, but any loosening is an ordinary budget raise and follows the raise protocol.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-08-13 | Retire `/asks-preview` — and discover the initial budget was under-counting `/live` | The fixture route was deleted (its rail is exercised on the connected `/live` gate now). Rolldown re-chunked, and `/live`'s **measured** initial went 126.4 → 146.3 KB — but no bytes were added: the checker reads the route HTML's modulepreload list, and before the deletion that list carried 12 chunks while `/live`'s true static import closure was **17 chunks / 150.1 KB** (protocol `dist` 20 KB, `asks`, `OfficeOverlay`, `wallboard`, `presenceLabel` all loaded eagerly at runtime, none preloaded, none counted). Verified by walking `from"./…"` specifiers through the built chunks. So the previous 126.4 was an accounting artifact, the deletion made the HTML honest, and `initialJsGzipBytes` was RAISED 146000 → 152000 to fit the first accurate reading (146.3 KB measured + ~4% — a raise, not a re-baseline, because it loosens). Total JS **fell** 234.2 → 231.2 KB, which is the deletion's real effect. If a lazy split of `/live` is ever chased, start from the closure number, not the preload list.                                                                                                                                                    |
| 2026-08-05 | Lazy-load the sound engine off the eager graph                                      | initial JS gzip **133.3 → 130.6 KB (−2,760 B)**, headroom 9.3 → 12.0 KB against the 142.6 KB budget. The WebAudio synths (`soundEngine.ts`: both engines, the cue table, the 18 life-event synths) now sit behind `import('./soundEngine')`, fired from the click that turns sound on. `sound.ts` keeps the preferences, the pure life-roll/keyboard logic, and two façades with the same API the call sites always used — 1.1 KB gzip eager, so a toggle still renders in the right position on first paint without fetching a synth. Lazy chunk **3,376 B gzip**; total JS 227.8 → 228.4 KB (+0.6 KB, the expected façade+chunk overhead — lazy-loading never moves the total, ADR 183). **The 44 KB of source is only 3.4 KB gzipped** — WebAudio calls plus prose compress hard, so do not size a split off its line count. Verified in the browser: with both prefs ON, a reload fetches **zero** engine bytes and both toggles still render on; the chunk arrives on the first gesture. AudioContext reaches `running` from the toggle click despite the import landing a microtask later — user activation is STICKY, not transient, which is what makes this split legal at all. |
| 2026-08-21 | Per-goal flow on the goal card + insight rail (ADR 295)                             | initial JS gzip **147.7 → 147.8 KB**, CSS gzip **24.5 → 24.6 KB**, total JS 230.3 → 230.6 KB — measured by building `packages/web` at `main` and again on the branch, not estimated from the diff. Both budgets pass with ~650 B of initial-JS headroom, which is where the ceiling already sat before this change. Worth recording because the *source* diff looks much larger than the bytes: 132 added lines gzip to ~2.0 KB as text, but the shipped cost is ~0.1 KB — the additions are mostly prose comments and a CSS block, and the minifier plus lightningcss strip comments entirely. Same lesson as the sound-engine row from the other direction: **do not size a web change off its line count, in either direction.** No new dependency, no new font, no new colour token (the card line reuses the measured `--gg-ink-quiet`). |

## Office scene loop (measured 2026-07-19)

The animation loop was already architected frugally — parks on a baked still frame when nothing
moves, ~20 fps ambient cap for breathing/typing, full rate only for walks/cues, hidden-tab pause,
CSS-only ambient overlays. Measured (prod daemon, 15 s windows, `clearRect` ≈ one painted frame):

| State                                     | rAF/s | draws/s | JS busy              | main-thread |
| ----------------------------------------- | ----- | ------- | -------------------- | ----------- |
| /live, seats working ("rest" in practice) | 59    | 17.9    | 25 ms/s (~2.5% core) | ~203 ms/s   |
| /office-preview (walk choreography)       | 59    | 58      | 78 ms/s (~7.8% core) | ~387 ms/s   |

Two findings: (1) the parked state almost never engages on a working team — any `working` seat keeps
`living()` true, so the ambient ~18 fps **full-scene** repaint runs continuously; (2) a **collapsed**
panel (`opacity: 0`, canvas kept mounted for instant re-expand) kept that repaint running for
invisible pixels. Shipped: `OfficeHandle.setSuspended` driven by the `collapsed` prop — parks the
loop + ambient beats, resumes with one synchronous bake+frame (verified: 60 → collapse **0.0** →
expand 18 draws/s, 5-check CDP suite).

**Deliberately not done** (measure-first verdicts, revisit only with new evidence):

- **Split-bake so breathing doesn't repaint the room** — the ambient frame redraws floor + walls +
  furniture to animate chest-rise. A behind-actors/actors/in-front-of-actors layer split would cut
  the ~25 ms/s to a fraction, but the painter is depth-sort-interleaved (sitters split across two
  depth slots, ADR 133) — real surgery for ~2% of one core. Poor ROI at current cost.
- **Lower the ambient cap** (20 → ~12 fps): halves the always-on cost with one constant
  (`AMBIENT_FRAME_MS`), but visibly chunks the breathing/typing feel — a product call, not a perf
  default.

## Findings, ranked by expected win

1. **~~The daemon serves everything uncompressed with zero caching headers.~~ SHIPPED (2026-07-18,
   #326).** `sendFile` now negotiates brotli/gzip for text types (`Accept-Encoding`, compressed bytes
   cached so it's paid once), sets `Cache-Control: …immutable` on content-hashed `/assets/*`, and
   gives the app shell a weak ETag + `no-cache` that answers `If-None-Match` with a 304. Measured:
   entry chunk 320 KB → 87 KB brotli, /live transfer **1,077 KB → 467 KB (−57%)**, throttled
   Lighthouse **49 → 71**, LCP **7.2 s → 4.3 s**.
2. **~~Entry chunk is heavy and half-unused.~~ INVESTIGATED — not a real lever (2026-07-18).** The
   premise (marketing code shares the dashboard's entry) was wrong: the landing components
   (LiquidGlass/`engine-*`, Lenis, Hero, Roadmap) already live in the `/`-only `routes-*.js` and lazy
   chunks — /live never downloads them. The 320 KB `index-*.js` it _does_ load is the framework
   runtime (React 19 + TanStack Router/Start) + protocol; Lighthouse's "154 KB unused" is
   coverage-of-framework-paths, not dead marketing code, and isn't cheaply extractable. Compression
   (finding #1) already took this chunk to 87 KB on the wire. Parking unless a concrete split target
   appears.
3. **~~Backfill render / stream DOM weight.~~ SHIPPED (2026-07-18).** Profiling first corrected the
   premise: the stream's _render CPU_ was already cheap (~4 ms; the "~1 s long task" was one-run
   variance), but its DOM was 94% of the page (4,214 of 4,490 nodes — Lighthouse `dom-size` score
   0). Fix: the stream mounts only the newest ~60 rows (`live/window.ts` math + windowed
   `Stream`); older history stays in memory behind a top "N earlier" pill that auto-reveals in
   steps on scrollback with exact manual scroll anchoring (`overflow-anchor: none`), collapses
   back at the live edge, and `scrollToMessage` became an event the stream answers by widening the
   window before scrolling (quotes/asks/bubbles unchanged). `useLiveStream` caps memory at the
   newest 1,000 envelopes. Typewriter, stick-to-bottom, day dividers, and the "now" marker are
   verified preserved by a 12-check CDP behavioral suite. Deliberately no `content-visibility`:
   its placeholder sizing corrects itself after our anchoring runs and the viewport drifts.
4. **~~Fonts.~~ SHIPPED (2026-07-18).** Two of the five families in dist — Inter (387 KB) and
   JetBrains Mono (116 KB) — were the retired musterd-default type; the active tokens use the
   izzocam trio (Fraunces / Space Grotesk / Space Mono), so those 503 KB were `@font-face`-registered
   but never fetched on any page (they only sat in `var()` fallback stacks the primary always
   resolves past). Removed their imports: **dist −503 KB**, and the render-blocking `global.css`
   dropped **56 → 14 KB** (73 → 27 `@font-face` rules). In the same pass the two canvas painters that
   still hard-named the old fonts — the office scene (`"Inter"`) and character sheet (`"JetBrains
Mono"`) — now read the type tokens via `live/canvasFont.ts` (so a future re-font sweeps the canvas
   too) and paint the already-loaded izzocam faces; /live's font download is unchanged at the same 7
   files (~117 KB). Further glyph-subsetting of the active families would need a build step — not
   pursued (diminishing returns; the LCP is no longer font-bound with `font-display: swap`).
5. **~~API JSON responses served uncompressed.~~ SHIPPED (2026-07-18).** `sendJson` now negotiates
   brotli/gzip (fast levels — dynamic bodies aren't cacheable) for responses over ~1.4 KB, encoding
   picked once per request. The /live message backfill (`GET /teams/:slug/messages`) drops **124 KB →
   39 KB**; Lighthouse's `uses-text-compression` residual is cleared.

## Prod-serving caveat (2026-07-17)

The shared daemon (:4849) was serving build `40065c5` — **14 commits behind main**, predating the
asks strip / speech bubbles / re-font. This baseline was taken against a fresh-main build on a
temp daemon instead. Any perf numbers eyeballed against the shared daemon are stale until a
`musterd service refresh`.

## Roadmap map dropped from the web UI — total JS gzip 243.3 → 201.5 KB (2026-07-29)

**−41.8 KB JS gzip (−17%), −1.6 KB CSS gzip.** Headroom against the unchanged 250,000-byte budget
goes from **0.8 KB to 42.6 KB**.

nick, 2026-07-28: drop the roadmap from the web UI. `components/Roadmap/*` is deleted, and
`roadmap.data.ts` — ~82 items of authored prose, 130 KB of source — moved from
`packages/web/src/content/` to `content/` at the repo root. Every consumer of that module is
build-time (`gen-roadmap`, `check-roadmap-truth`, the ADR 112 steward scan); it lived under
`packages/web` only because the landing page used to render a map from it, so the browser was
downloading the entire roadmap to draw a page that mostly says three paragraphs and a hero.

The two strings the landing page still needs (`TAGLINE`, `WEDGE`) moved to
`packages/web/src/content/site.ts`. Leaving them behind in the data module would have dragged all of
`RAW` back into the bundle to render two paragraphs, which is the entire cost this move avoids.
`gen-roadmap` imports `WEDGE` from there — one source of truth, pulled toward the consumer that is
picky about bytes.

Dead with the map: the `--status-*` tokens in `tokens.css` (both themes), which only `Roadmap.css`
ever read.

**The budget was NOT raised.** PR #484 proposed 250,000 → 258,000 when headroom was 0.8 KB; this
reclaim is fifty times that raise, so #484 was closed without merging and only its finding was kept
(below). ADR 151 says shrink first — this is what that looks like when the shrink is available.

**Worth a re-baseline.** At 201.5 KB against 250,000, headroom is now ~21%. The 2026-07-19 numbers
were set with ~12% and were exhausted in nine days by ordinary shipping, so a periodic review of all
four budgets is still the right follow-up — see the CSS raise and the JS analysis logged above.

### Finding (carried over from the closed #484): this budget cannot be satisfied by lazy-loading

`scripts/perf/check-budgets.ts` sums the gzip of **every** `.js` under `dist/client`, lazy chunks
included. So code-splitting cannot reduce `totalJsGzipBytes` — it can only raise it slightly, by the
per-chunk overhead. Measured, not reasoned: splitting the default-off room-tone engine into its own
chunk moved **1.3 KB** out of the live route's initial payload and moved the gate the _wrong_ way,
**243.3 → 243.7 KB**. That split was reverted; 0.5% off initial load did not justify an extra module
boundary and a round-trip.

It matters because `perf:check`'s own failure message tells you to "shrink the change (lazy-load,
…)", and the first remedy it names provably cannot move the number it enforces. Two honest readings,
and choosing between them is an ADR 151 decision:

1. **Total shipped JS is the right metric** — it tracks how much code the product carries, which is
   what actually rots. Then the failure message should stop recommending lazy-loading, and splitting
   should be justified against the Lighthouse baseline instead.
2. **Initial payload is the right metric** — what a viewer downloads before the page is interactive.
   Then the budget wants an `initialJsGzipBytes` (entry + route chunk) alongside a looser
   `totalJsGzipBytes`, and the current advice becomes correct.

**RESOLVED 2026-07-29 — ADR 183 took reading (2), keeping both budgets.** The finding above stands as
written; what it was missing is how far apart the two numbers actually are. Measured on `0acb669`:
total shipped JS is **201.7 KB** across 29 chunks, while the worst route's _eager_ graph is
**124.1 KB** — so **~40% of shipped JS is already lazy on every route**, and the single-budget gate
gave that architecture no credit whatsoever. Per-route eager payload, gzip:

| route               | eager chunks | initial JS gzip |
| ------------------- | ------------ | --------------- |
| `/asks-preview`     | 6            | 124.1 KB        |
| `/live`             | 11           | 120.1 KB        |
| `/board`            | 9            | 115.1 KB        |
| `/broadcast`        | 6            | 106.7 KB        |
| `/audit`            | 6            | 106.3 KB        |
| `/office-preview`   | 6            | 106.0 KB        |
| `/approvals`        | 6            | 104.9 KB        |
| `/` (home)          | 5            | 104.2 KB        |
| `/character-sheet`  | 5            | 103.0 KB        |
| `/approval-preview` | 5            | 102.1 KB        |

The gate now enforces `initialJsGzipBytes` against the **worst** route, measured from each
prerendered route's `index.html` (its entry `<script>` plus one `modulepreload` per statically
imported chunk). Verified that a lazy-load moves it, which is the claim the whole change rests on —
and it was worth verifying, because a bundler that emitted `modulepreload` for _dynamic_ imports too
would have invalidated the measurement. A throwaway `lazy()` split of `AsksStrip` on
`/asks-preview` took that route **124.1 → 118.3 KB** (6 eager chunks → 5, dropping exactly the
5.9 KB `AsksStrip` chunk) while total JS rose **201.7 → 201.9 KB**: the two budgets moving in
opposite directions, as designed. The probe was reverted — it existed to test the gate, not to ship
a split.

So the guidance inverts cleanly, and each `perf:check` failure now carries the remedy that can move
_that_ number: lazy-loading for `initialJsGzipBytes`, and deleting code or dropping a dependency for
`totalJsGzipBytes`. **The removal shape still works for both, and is the only thing that works for
the total.**

## CSS budget RAISED 22,000 → 25,300 bytes gzip (2026-08-04) — a raise, not a re-baseline

**This is a deliberate raise and it should be read as one.** ADR 183's re-baseline ritual resets a
budget to measured + 15% and **may only tighten**; here measured + 15% is 25,290 bytes against a
22,000-byte budget, so it loosens, which makes it a raise no matter what it is called. Recording it
under the honest name is the whole point of the ritual.

### What forced it

`perf:check` failed on a 68-byte CSS addition (four small rules for the ADR 222 asks-rail sign-in).
The failure was correct and the addition was not the problem:

| Measurement (node `zlib.gzipSync`, as `check-budgets.ts` uses) | Bytes  | Headroom |
| -------------------------------------------------------------- | ------ | -------- |
| Before the ADR 222 rail change                                 | 21,923 | **77**   |
| After it                                                       | 21,991 | **9**    |

**The budget was already 99.65% consumed before the change that tripped it.** Note the measurement
trap: the `gzip` CLI reports ~10 bytes/file more than `zlib.gzipSync` because it writes a filename
and mtime header. Over 8 CSS files that is ~170 bytes — enough to make a passing build look like a
failing one. Measure with node, the way the gate does.

Per-file, gzip, at the time of the raise:

| file                 | gzip   |
| -------------------- | ------ |
| `Live.css`           | 15,190 |
| `global.css`         | 2,272  |
| `routes-D.css`       | 1,902  |
| `ReceptionScene.css` | 1,668  |
| `approvals.css`      | 393    |
| `Broadcast.css`      | 291    |
| `audit.css`          | 217    |
| `brand.css`          | 58     |
| **total**            | 21,991 |

### Trimming was attempted first, and there is nothing to trim

Each of these was measured, not assumed. **Do not re-chase them without new evidence:**

1. **Dead selectors: zero of 373.** A naive "class in CSS but not in `src/`" sweep flags 57, and all
   57 are false positives — they are built dynamically (`` `lc-ask__tier--${tier}` ``,
   `` `lc-ask lc-ask--${ask.state}` ``, `` `lc-badge--${kind}` ``). Matching on constructed prefixes
   takes it to 0. **A dead-CSS sweep on this codebase must resolve template-literal prefixes or it
   will confidently delete live styles.**
2. **Comments are already free.** `Live.css` is 146,305 raw bytes of which 43,391 are comments, but
   the shipped chunk is 15,190 gzipped — the minifier strips them. Deleting comments buys nothing
   and costs the reasoning, which in this file is most of its value.
3. **`cssMinify: 'lightningcss'` is byte-identical** to the default esbuild minifier here: 21,991
   either way. Tried and reverted.
4. **Duplicate declaration blocks total ~500 raw bytes** across the whole file (the largest is a
   3× `color: var(--lc-dim); border-color: var(--lc-border-2);`). Below the noise floor after gzip.

### The growth is real feature work

Since the 2026-07-29 re-baseline, `Live.css` took **+1,019 / −245 lines across 13 shipped commits** —
the cork pin board and board-off-the-wall overlay (#586), enamel nameplates, the reception lane and
nameplate expand animation (#591), task-chair legs and the 18-desk floor (#593), presence chrome and
room dressing (#548). None of it is waste. CSS grew 19.1 KB → 21.99 KB, consuming a 15% headroom in
**six days**.

### The thing to watch

**A 15% headroom lasted six days at current office-CSS velocity, so this raise buys roughly a week.**
If the next ceiling arrives on the same schedule, the answer is not a third raise: it is either a
deliberate decision that the office's visual richness is worth a permanently larger CSS budget (say
so, and set it once, high), or a structural change — `Live.css` is 4,500+ lines and 69% of all shipped
CSS, and it is the only file that has ever moved this number.

## 2026-08-12 — the goals-grid front door (raise, not re-baseline)

The board's new default view (goals-front-door design: `goalGrid.ts` model, `GoalGridView.tsx`,
`GoalGrid.css`, route drill-in, overlay toggle) landed with both totals >99% consumed and tipped
them: **total JS 238,899 B vs 238,000 budget; total CSS 25,395 B vs 25,300 budget.** The swimlane
regroup it replaces (`groupByGoal` + its suite) was deleted in the same change, so the delta is
net of the retirement. Initial JS is untouched (grid rides the existing lazy board chunk).
Raised `totalJsGzipBytes` 238000 → 241000 and `totalCssGzipBytes` 25300 → 26400 — measured + ~1%
headroom on JS, +4% on CSS; both were tight-fit ceilings, not calibration drift.

## 2026-08-21 — ADR 302 site expansion (initial raise; landing re-composition)

Branch `miley/musterd-io-expansion`: the public site grows to `/`, `/roadmap`, `/docs/**`,
`/blog/**`; the landing swaps the canvas office-scene hero for typographic sections
(SiteNav/LightHero/StreamSection/WhatIs/Teasers). The Twitch player is third-party and deferred
(no iframe in prerendered HTML; IntersectionObserver injects it), so it touches no JS budget.

Measured (this box, `perf:check` after `pnpm --filter @musterd/web build`; main baseline is the
2026-08-13 log entry):

- **initial JS (worst route /live): 146.3 KB → 150.4 KB.** The new landing sections ride the entry
  chunk because the index route is part of it, and /live's eager graph includes entry. Raised
  `initialJsGzipBytes` 152000 → 156000 (measured 154,010 B + ~1.2% slack, the 2026-08-12 shape).
- **The lazy remedy was measured and REJECTED** (findings-log entry, do not re-chase without new
  evidence): splitting the landing component into `index.lazy.tsx` moved the sections out of entry
  but rolldown re-chunked shared modules — `fileRoute` (10.8 KB gzip) and `jsx-runtime` (2.9 KB)
  became separate eager chunks in every route's graph — for a WORSE initial (152.1 KB) and
  **+26 KB total** (35 → 37 chunks, churn + duplication).
- **total JS: 234.3 KB / 241000 budget — passes.** The generated content module (docs/blog/roadmap
  HTML) ships as **zero client JS**: content routes load it in loaders behind `import.meta.env.SSR`,
  the prerender dehydrates each page's own data, and the client build dead-code-eliminates the
  import. First measured shape (content in a shared chunk hoisted into entry) was 259.0 KB total /
  121.2 KB entry — the SSR guard is what fixed it.
- **CSS: 26,406 B vs 26,400 — 6 bytes over; trimmed** (two redundant declarations in the new site
  CSS) rather than raised.
- Dead code removed in passing: `LiquidGlass/` (no consumers), `lenis`, `@fontsource/fraunces`.

## 2026-08-24 — Delight 0: the CSS budget splits by surface (ADR 313)

Branch `miley/delight0-css-budget-split`, measured on main @ 6bcc8c4a the way the gate measures
(`gzipSync` default level over `dist/client`): CSS 26,394 / 26,400 (**6 bytes free**), initial JS
154,372 / 156,000, total JS 240,456 / 241,000.

- **The canvas-substitutability question the delight spec asked is answered, by rebuild rather than
  arithmetic** (sections deleted from `Live.css`, package rebuilt, shipped bundle re-gzipped):
  pure decoration over the canvas (Tier-A ambient FX, watermark, one dead section) is **−832 gzip
  bytes = 5.3%** of Live.css's 15,810; adding the interactive over-canvas chrome (nameplates,
  speech bubbles + rich tokens + hover-expand, board hotspot, work stack) reaches **−4,143 gzip
  bytes = 26.2%**. The spec's 15% falsifier passes only by counting the interactive tier, whose
  canvas rewrite would spend JS bytes the JS budgets (1,628 / 544 B free) do not have. Route 2
  rejected as runway; evidence and decision in ADR 313.
- **`totalCssGzipBytes` (26,400) replaced by per-surface budgets**, each measured + 15%:
  `appCssGzipBytes` 24,700 (measured 21,492), `siteCssGzipBytes` 2,900 (measured 2,538),
  `sharedCssGzipBytes` 2,700 (measured 2,364). A deliberate loosening under ADR 183's ritual —
  implied total 26,400 → 30,300 — justified by the structural defect it removes: the office and the
  eight-route public site shared one ceiling set when the site was one page, and on 2026-08-23 a
  site-only table rule was blocked by office bytes.
- **Classification is closed**: `check-budgets.ts` fails on any CSS bundle not named in
  `budgets.cssBundles` (exercised: a stray `Mystery-abc123.css` fails; an over-budget group fails
  naming only its own bundles as the remedy).

## 2026-08-24 — Shared Seeds drawer (total-JS raise)

Measured on main @ `5d63094d` and PR #1025 after rebasing to that commit, using `gzipSync` over the
same production build that `perf:check` reads:

| build | `/live` eager JS | total JS | chunks |
| --- | ---: | ---: | ---: |
| main | 154,479 B | 240,813 B | 35 |
| Shared Seeds, eager drawer | 156,242 B | 242,341 B | 35 |
| Shared Seeds, lazy drawer + Seed client | **155,194 B** | **243,065 B** | 36 |

The read-only drawer is an opt-in interaction, so its component and Seed schema now load only when
opened. That keeps initial JS within the unchanged 156,000 B ceiling (806 B free). The boundary adds
724 B to total JS versus the eager shape, but removes 1,048 B from every `/live` initial load; this
is the intended ADR 183 tradeoff. No dependency was added and no superseded feature code exists to
delete. `totalJsGzipBytes` is therefore **RAISED 241,000 → 246,000**: measured 243,065 B plus ~1.2%
headroom, matching the 2026-08-12/21 raise shape. App CSS measures ~21.7 KB against its ADR 313
24.1 KB surface budget, so CSS is unchanged.

The same build exposed an ADR 313 checker defect: Vite emitted `Live-Cs78-rix.css`, and the checker
treated the legal hyphen inside the hash as part of the pre-hash basename. Classification now
matches the closed declared basename prefix and has a regression test for hyphenated hashes; no CSS
bundle was added or reclassified.
## 2026-08-24 — surface_globs → scope: +157 B of skew compat on the pre-Seeds ceiling

Branch `stanley/scope-rename` (PR #1041), measured the way the gate measures over `dist/client`:
main @ b08cc251 total JS 240,175 / 241,000 (**825 bytes free locally**); branch 240,332 — the
rename's whole cost is **+157 gzip bytes** (LaneSchema preprocess adoption of the legacy key, the
`surface_globs` mirror on the full Lane shape, `mirrorLegacyScopeOnSend`). CI's toolchain gzips the
same tree ~0.7 KB higher than a local build (both invocations are `gzipSync`; the delta is the
minified output, not the measurement — same class as the gzip-CLI-vs-zlib trap logged 2026-08-04),
so on CI the 241,000 budget was already fully consumed before this change and the gate failed twice
on `235.4 KB > 235.4 KB`.

- A raise to 242,000 was prepared under ADR 183's ritual, then **superseded before it landed**: the
  Shared Seeds raise above (241,000 → 246,000, PR #1025) merged first and absorbs these bytes with
  room. No budget change ships from this lane; the measurement stands as the record of the compat
  contract's cost — the bytes drop with the mirror in a later epoch.
- Falsify: build the branch and `pnpm perf:check`; delete `mirrorLegacyScopeOnSend` and the
  mirror lines and the total returns to within ~40 B of main's.
## 2026-08-24 — owned empty desks (+~0.6 KB total JS; rode the Seeds raise, no raise of its own)

Presence-honesty §4 (lane 01M0GVNXHC, PR #1046) adds the owned-desk pass to the office canvas:
offline owners keep desks in `assignSeats`, and `drawWorkstation` bakes a nameplate, a fading
screen afterglow and the `disconnected` glint. Measured on the branch (`pnpm --filter @musterd/web
build && pnpm perf:check`): total JS gzip 241,0xx locally / 241,4xx in CI against 241,000 — the
ceiling had ~0.5 KB free before the change. The helpers were inlined into the prop pipeline first
(−~0.3 KB); no dead JS was found to trade. A 241,000→242,000 raise was prepared, then dropped in rebase: the Shared Seeds raise to 246,000 landed first and covers it. Trap re-paid in this change: `perf:check` reads the last build — run
the build in the same breath or the number you defend is the previous commit's.
## 2026-08-25 — seeded idle life E1a: +698 B total JS for the shared ambient seam (raise 246,000 → 249,000)

Branch `miley/seeded-idle-life-e1a` (lane 01M0GVPFKT, spec #1058), measured the way the gate
measures over `dist/client` after a fresh build on both sides:

- main @ b53cb94a: **245,531 B** gate-style (`gzipSync` default level; the level-9 CLI-style number
  is 245,159 — same ~0.3% trap logged 2026-08-04).
- branch: **246,229 B** — the feature's whole cost is **+698 B**, inside the spec §4 estimate
  (≤1.0 KB), all of it in the lazy `office-scene` chunk plus its call-site threading. Initial JS is
  untouched: 151.9 KB against 152.3 KB, `/live`'s eager graph does not import the seed module
  eagerly beyond what `index.ts` already carried.

The ceiling had 469 B free locally and effectively none on CI (CI's toolchain gzips the same tree
~0.7 KB higher — the 2026-08-24 `stanley/scope-rename` measurement), so the gate fails on exactly
this feature's bytes. No trim was available inside the change: the module is 90 lines of hash +
decision logic and the threading replaces `Math.random()` call sites one-for-one. Raised
totalJsGzipBytes 246,000 → 249,000 (measured 246,229 + ~1.2%, the Shared Seeds precedent).

- Falsify: build main and the branch and run the byte walk in this entry's method; delete
  `ambientSeed.ts` and revert the call sites and the total returns to within ~50 B of main's.
## 2026-08-25 — seeded idle life E1b: occupancy-scaled density, constants pinned (no byte change worth logging)

Branch `miley/e1b-density` (lane 01M0GVPFKT, PR #1066). The measured table the `ambientSeed.ts`
docblock and `scripts/perf/ambient-density.mjs` header point here for — three sequential 8-minute
arms, one headless Chrome at a time, against `/office-preview?quiet&team=revive` on a vite dev
server (method at the top of the harness):

| arm            | fire obs/exp | beats/idle-min | playRate |
| -------------- | ------------ | -------------- | -------- |
| E1a floor n=2  | 0.25 / 0.40  | 0.75           | 1.00     |
| E1b n=2        | 0.23 / 0.27  | 1.12           | 0.82     |
| E1b n=8        | 0.50 / 0.70  | 2.50           | 0.83     |

`AMBIENT_P_FULL = 0.7` is pinned by the saturation argument, not the point estimate: the n=8
observed fire rate ceilings at ~0.5 (3σ below p) because a playing beat holds `quiet()` false, so
raising p buys almost nothing. `AMBIENT_P_QUIET = 0.27` reproduces the analytic pre-E1a delivered
rate (0.4 per 20 s slot × fallthrough playRate ≈ 1 → 1.2/min; E1b n=2 measures 1.12, within 7%).
8-minute arms put ±0.55 on the n=8 point.

- Falsify: re-run the harness per its header (`--slot-ms 20000` for pre-E1b builds); if n=8
  delivered density moves materially above 2.5/idle-min without a code change, the saturation
  argument was wrong and P_FULL wants re-deriving.

## 2026-08-31 — totalJsGzipBytes 249000 → 252000 (Delight E3 milestone moments, PR #1118)

The E3 moments (fanfare / door / askbell voices + the `moment` dispatch and throttle) ride the
lazy `soundEngine`/`soundLife` chunk, so `initialJsGzipBytes` is untouched (151.6 KiB, and the
E2 `soundLife` split had already *reduced* it from 152.4). But total counts every chunk:

| tree | total JS gzip (gate style) |
| --- | --- |
| main @ 90a8b331 (E2), local | 248,422 B |
| branch a803c722 (E3), local | 248,934 B |
| branch, CI | 249,344 B (the known ~0.7 KB CI toolchain delta, 2026-08-24) |

Feature cost ≈ +0.5 KiB against a ceiling with ~600 B free locally and none on CI. No lazy
remedy exists by construction (the code already sits on the lazy chunk — ADR 183: lazy-loading
cannot move total), and no deletable twin was found: the voices reuse the existing `click`/
`ping`/noise helpers rather than duplicating shapes. Raise to CI-measured + ~1.2%, matching the
2026-08-24 (Shared Seeds) and 2026-08-25 (E1a) precedents.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` on the merge commit; total
  should read ≈243.5 KiB against 246.1 KiB (252,000 B).

## 2026-09-01 — initialJsGzipBytes 156000 → 158000 (lapsed asks, PR #1158)

#1158 added `applyTierClock`, the `lapsed` state and the elapsed-note card to `asks.ts`,
`AsksStrip.tsx` and `AsksReel.tsx`. Those modules are the /live strip and the /broadcast reel —
the eager graph itself — so ADR 183's initial-budget remedy (a dynamic import) has nothing to move:
the code is the surface. The PR's own gates passed with bytes to spare; the merge commit did not.

| tree | initial JS gzip, worst route /live (gate style) |
| --- | --- |
| #1158 branch @ ca4e48dc, CI (its own gates, green) | 152.3 KB against 152.3 KB |
| main @ db1099de, local | 152.3 KB against 152.3 KB (passes) |
| main @ db1099de, CI | 152.4 KB against 152.3 KB (**red**) |
| #1155 @ 0540ee3f rebased on that main, CI | 152.4 KB — same failure, no web change in the PR |

The ~0.1 KB is the 2026-08-24 CI gzip toolchain delta landing on a ceiling that had bytes free
locally and none on CI — the same shape as the 2026-08-25 and 2026-08-31 raises. Raise to
CI-measured + ~1.2% (156,058 → 158,000), matching those precedents. Reviewed on the PR by dolly
(mutation-verified, 768/768); the budget was not checked at review time, which is the process gap
this note records: **a PR that reads "N KB / N KB" on its own gates will read over on main.**

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` on the merge commit; initial
  should read ≈152.3 KB against 154.3 KB (158,000 B), and main's CI gates go green.

## 2026-09-02 — initialJsGzipBytes 158000 → 154500 (the raise above, repaid; PR #1168)

The first entry in this log that gives bytes back. The raise directly above was correct triage —
main was red and taking every rebased PR with it — but its premise, *"the code is the surface"*,
holds only for #1158's own bytes. It is not true of the route they landed on.

| tree | initial JS gzip (/live eager) | |
| --- | --- | --- |
| `d7cb401c` (#1158's parent), local | 155,721 B | CI green |
| `db1099de` / `5cc8aa68` (main), local | 155,964 B | **CI red** |
| this branch, local | **152,540 B** | |

#1158 cost **243 B** against a ceiling with **279 B** free, and all 243 are feature:
`applyTierClock`, the loudness guard in `answerableCount`, and the lapsed note's copy. Nothing
there is shaveable without taking the honesty out of the surface it was built for. So the bytes
came from somewhere else, and the somewhere else had been hiding in plain sight.

`BoardOverlay`'s header has said since it was written that the board is *"kept out of /live's
eager graph (ADR 151: heavy, occasional code gets a lazy chunk, never the entry)"*. Only the inner
`Board` ever was. The 219-line modal shell — plus `useBoardData`, `goalGrid` and
`boardOverlayMath` through its static imports — rode the entry chunk on a route that renders none
of it until a reader reaches for the wall, behind an already-conditional
`{boardOpen && <BoardOverlay/>}`. Making the shell lazy too costs one `Suspense` boundary:

| step | initial JS gzip | Δ |
| --- | --- | --- |
| main | 155,964 B | — |
| dedupe the `?still` / `?asks-open` flag readers | 155,960 B | −4 B |
| **lazy `BoardOverlay` shell** | **152,540 B** | **−3,439 B** |

About 14× what #1158 borrowed. The flag-reader dedupe is kept for being better code, not for its
bytes: gzip had already collapsed the duplicated `try`/`catch`, which is worth remembering the
next time a shave looks obvious on the page.

Per ADR 183 the total moved the other way, exactly as that ADR predicts a lazy split will:
249,509 → 250,547 B (+~1 KB of per-chunk overhead, 36 → 38 chunks), still inside the 252,000
ceiling.

`preloadBoardOverlay` keeps the promise the old `preloadBoard` made — the wall hotspot's first
hover/focus now warms *both* halves (shell, then board), so a click still lands on a loaded chunk
and the "comes off the wall" flight is not waiting on a network round trip.

### Two measurement traps, both of which cost time here

- **`perf:check` does not build.** It only reads `packages/web/dist/client`. A reading taken
  without `pnpm --filter @musterd/web build` first is the *previous* tree's dist — which is how
  two commits 243 B apart both measured 155,964 B and looked identical.
- **A PR reading "N KB / N KB" on its own gates will read over on main** — the process finding
  from the note above, kept, because it is what this ceiling's headroom was hiding.

New budget is measured 152,540 + the CI toolchain delta + ~1.2% slack (the 2026-08-12 precedent),
leaving ~1.9 KiB of genuine headroom where 279 B had made *any* web change a coin flip against
CI. A re-baseline may only tighten (ADR 183); this one does.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` — initial should read ≈149.0 KiB
  against 150.9 KiB (154,500 B). If a future change puts `BoardOverlay` back into the eager graph,
  this budget is now tight enough to say so instead of absorbing it silently.

## 2026-09-02 — totalJsGzipBytes 252000 → 255000 (musterd.io agent surfaces, PR #1177)

**The 28 bytes are not the story; the ceiling is.** Tier 3 of the musterd.io discoverability
arc is almost entirely build-time work — the markdown mirrors, `llms-full.txt` and
`blog/rss.xml` are emitted by `scripts/site-files.ts` through the vite config and never enter
the bundle. Its whole client-side cost is `markdownAlternate()` and `feedAlternate()` in
`siteMeta.ts` plus the three route `links` arrays that call them: the `<link rel="alternate">`
tags that announce a mirror from the page it mirrors.

| tree | total JS gzip (gate style) | free against 252,000 |
| --- | --- | --- |
| main @ 0c4315fa, local | 251,125 B | 875 B |
| branch @ 8e4f5fe8, local | 251,153 B | 847 B |
| main @ 0c4315fa, CI (green) | 246.0 KiB against 246.1 KiB | **under 100 B** |
| branch @ 8e4f5fe8, CI | 246.1 KiB against 246.1 KiB (**red**) | none |

Feature cost, measured both ways: **+28 B**. Main was already consuming 99.96% of the ceiling
on CI, and 28 bytes was more than it had left.

No remedy exists on this budget by construction: ADR 183 is explicit that lazy-loading cannot
move total (it adds per-chunk overhead), and the remedies that can — delete code, drop a
dependency — have nothing to take here. The two helpers are five lines and they *are* the
feature: without the head link, an agent that lands on the HTML has no way to find the mirror
except by guessing at a URL convention. An `import.meta.env.SSR` guard was considered and
**rejected**: it would drop the tags from the client build and React would then remove them
from the head at hydration, so a JS-rendering crawler — Googlebot included — would see the
announcement disappear. A tag that exists only until the page hydrates is worse than no tag.

A re-baseline was checked first per ADR 183 and is not available: measured + 15% would be
~289,000, which loosens, and a re-baseline may only tighten. So this is a raise, recorded as
one, to CI-measured (~252,02x) + ~1.2%, matching the 2026-08-24 / 08-25 / 08-31 precedents. It
leaves ~3.8 KB of true headroom where under 100 B had made any web change a coin flip against
CI — the same failure shape the 2026-09-01 entry above records for the *initial* budget, now
observed on total.

**The thing to watch**: this is the fourth raise of `totalJsGzipBytes` since 2026-08-24
(241,000 → 246,000 → 249,000 → 252,000 → 255,000) with no re-baseline between them. Every one
was justified on its own measurement, and the trend is still a trend. The 2026-09-02 initial-JS
entry above is the counter-example worth copying: its remedy was found in code that had
described itself as lazy for months and was not.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` on the merge commit; total
  should read ≈245.3 KiB against 249.0 KiB (255,000 B), and main's CI gates stay green.

## 2026-09-02 — `initialJsGzipBytes` 154,500 → 144,000 (re-baseline, tightening): zod was never architectural

The entry above it, written by me the same day, is wrong, and this is the correction. It records
that /live's real headroom "needs architecture (defer roster parsing), not an import tidy". The
reasoning was: `packages/web/src/live/format.ts` value-imports three pure helpers from the
`@musterd/protocol` **barrel** and looks like the culprit, but `live/client.ts` also value-imports
the zod schemas it parses the roster with and genuinely needs them — so moving format.ts alone
could not move zod off the eager graph.

Measured, that has it backwards. **format.ts was the only eager path into zod.**

| | eager `dist-` chunk | /live eager graph |
|---|---|---|
| main @ dac0f083 | 23,031 B gzip | 154,197 B (150.6 KiB), 13 chunks |
| deep imports | 10,048 B gzip | **141,341 B (138.0 KiB), 13 chunks** |

The change is two lines. `normalizeModelId` and `reviewGrade` come from
`@musterd/protocol/model` and `resolvePosture` from `@musterd/protocol/posture` instead of the
barrel, with those two subpaths added to the protocol package's `exports` (enumerated, not a `./*`
wildcard — a wildcard would make every internal module public API of a published package as a side
effect of a perf fix). With no eager importer left, rolldown tree-shakes zod out of the shared
protocol chunk; it lands in a lazy `posture-` chunk fetched alongside the roster request instead of
before first paint.

**Nothing was deferred, deleted, or made less strict.** `fetchRoster` still validates every row
with `MemberSummarySchema` exactly as before, per-row tolerance intact (ADR 148); 964 web tests,
typecheck and the build are unchanged and green. The architectural remedy the previous entry
described — defer roster parsing — is **not needed for these bytes** and should not be chased for
them. If it is ever wanted, it will have to earn its own justification.

Per ADR 183 the total moved the other way as predicted: 247.1 → 247.8 KiB (+~0.7 KiB per-chunk
overhead, 37 → 38 chunks), inside the 255,000 ceiling. That ceiling is now **99.5% consumed** and
is the number to watch — the trend the entry above flags as a trend is unchanged by this.

New budget is measured 141,341 + the known ~0.7 KB CI gzip delta + ~1.2% slack (2026-08-12
precedent) = 144,000, leaving ~2.6 KB of true headroom. Deliberately **not** padded further for the
dwell work in flight (lane 01M1JQENBK): sizing a budget for work that has not landed is the
calibration failure this file keeps re-learning.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` on the merge commit — initial
  should read ≈138.0 KiB against 140.6 KiB (144,000 B). Then revert the two imports in `format.ts`
  to the barrel, rebuild, and watch the eager graph go back to ≈150.6 KiB: that is the whole claim.

## 2026-09-03 — un-splitting to recover `totalJsGzipBytes`: measured and REJECTED

`totalJsGzipBytes` is the binding constraint and has been for a week: 248.3 KB against a 249.0 KB
ceiling on main @ `cd4d2934`, **715 bytes free**, 38 chunks. It has been RAISED five times since
2026-08-24 with no tightening between them. ADR 183's ritual cannot repair it — a re-baseline may
only tighten, measured + 15% loosens (so a re-baseline is unavailable), and tightening toward the
measured 248.3 leaves zero headroom against the known ~0.7 KB CI gzip delta, which makes every web
PR a coin flip. The trend is the finding.

**The hypothesis.** This file and `budgets.json` both say only deleting code or dropping a
dependency can move total, because lazy-loading cannot. That pair looked incomplete against this
file's own evidence: splitting has RAISED total twice — 36 → 38 chunks cost ~1 KB (BoardOverlay),
37 → 38 cost ~0.7 KB (the zod deep-import directly above). Per-chunk overhead is real and additive,
so **un-splitting should lower total**, and nothing in ADR 183 forbids it. Eleven chunks measure
under 1.5 KB gzip (5,208 B); four are near-empty public-site route stubs (`docs._slug` 289 B,
`docs.index` 310 B, `blog._slug` 305 B, `blog.index` 327 B) whose real content is prerendered HTML.
Bounded estimate: 1.5–2.5 KB recovered, 2–3x the headroom that exists.

**Measured, it goes the wrong way.** A `build.rollupOptions.output.manualChunks` grouping the four
route source files into one `site-routes` chunk:

| | total JS gzip | initial (/live) | chunks | largest chunk |
|---|---|---|---|---|
| main @ `cd4d2934` | 248.3 KB / 249.0 | 138.6 KB / 140.6 | 38 | 97.5 KB |
| `manualChunks` | **249.7 KB (RED)** | **139.9 KB** | 38 | 86.0 KB |

Both budgets got worse and the chunk count did not move.

**Why — the part worth keeping.** The four stubs *survived as four separate chunks* (275–314 B
each, ~1,177 B). What the grouping actually did was hoist 16.1 KB of shared page code out of the
entry chunk into a new `site-routes-` chunk (entry 99.6 → 87.9 KB). The route stubs TanStack Start
emits are **virtual modules created by the plugin's route-splitting**, not the `src/routes/*.tsx`
files on disk; a `manualChunks` predicate matching source paths therefore cannot address the stubs
at all — it grabs the real page components instead and splits *more*, paying fresh per-chunk
overhead (+1.4 KB total) and dragging /live's eager graph up with it (+1.3 KB). A stray
`site-routes-*.css` bundle also appeared and correctly failed the ADR 313 classification gate,
which is that gate working as designed.

This is the same shape as the 2026-08-21 `index.lazy.tsx` rejection recorded above: an intuitive
chunk-boundary change that rolldown answers by re-chunking shared modules into a worse arrangement.
**Two rejections now share one lesson: you cannot steer this build's chunk graph from the outside
by naming source files.**

**What survives and what does not.** The hypothesis is *not* disproved — per-chunk overhead is
still real, and un-splitting is still the only lever besides deletion that can move total. What is
disproved is that `manualChunks` over source paths can reach it. Any future attempt has to go
through the Start plugin's own splitting behaviour, and it should be measured before it is
believed. The dependency arm is separately closed: `react`, `react-dom`, two TanStack packages, two
`@fontsource` packages and the workspace protocol — nothing droppable without an architecture
change. Do not re-chase either arm on intuition.

`budgets.json`'s "only deleting code or dropping a dependency" note is corrected in this pass to
name the third lever and its one measured failure, so the next reader does not spend the hour again.

- Falsify: re-apply the `manualChunks` predicate from this entry on top of `cd4d2934`, rebuild, and
  run `pnpm perf:check` — total should read ≈249.7 KB RED with the four stub chunks still present
  and a ~16 KB `site-routes-` chunk beside them. If instead the stubs merge and total falls, the
  Start plugin's splitting has changed and this entry is stale.

## 2026-09-03 — `totalJsGzipBytes` 255,000 → 258,000 (office surfaces batch, PR #1265)

Lane 01M1MM1Y5H: bubbles drop the sender's own `name:` prefix, the act mark on a bubble grows from a
15 px tag to a 22 px coin, and `/broadcast` carries a notice (the feed may blink while the room ships
the thing being watched) and a contact line (`musterd.io`, `revive@musterd.io`) in a new `cornerSlot`
on `OfficeScene`. Two of those are facts asserted on a public surface and are not shaveable.

| | total JS gzip | headroom |
|---|---|---|
| main @ 179235bd, local | 254,536 B (99.82% of 255,000) | 464 B |
| branch, local | 254,849 B | 151 B |
| branch, CI | 249.2 KiB against 249.0 KiB (**red**) | none |

Feature cost: **+313 B** local. CI read ~0.3 KB above local on this PR (the delta the 2026-08-25
entry records as ~0.7 KB has narrowed, not gone). Trimming came first and recovered what it could:
`stripSenderPrefix` compacted to three lines, the per-team contact map folded to a literal. What
is left is the notice's two sentences, the address, the coin's CSS (not counted here) and the
slot's one conditional — the feature.

No remedy on this budget by construction: lazy-loading cannot move total (ADR 183), the
dependency arm is closed (2026-09-03 entry above), and the un-splitting lever was measured and
rejected the same day. A re-baseline may only tighten and measured + 15% loosens, so this is a
raise, recorded as one, to CI-measured (~255,150) + ~1.2% per precedent.

**The finding, restated because it has grown**: sixth raise of `totalJsGzipBytes` since 2026-08-24
(241,000 → 246,000 → 249,000 → 252,000 → 255,000 → 258,000) with no tightening between them, and
after the un-splitting rejection there is no known lever that repays it. Every raise was justified
on its own measurement. The budget is now measuring the product's growth, not catching waste — which
is a different instrument from the one ADR 151 set up, and worth its own decision rather than a
seventh entry here.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` on the merge commit — total should
  read ≈248.9 KiB against 252.0 KiB (258,000 B), and main's CI gates stay green.

## 2026-09-04 — zod leaves the browser: the repayment the six raises were owed

Decision: [ADR 380](../decisions/380-the-protocol-has-a-validator-free-face.md).

nick's steer, after the entry above named the trend and found no lever: **find and land the
repayment, or write the decision that says why the ceiling moves — not a seventh raise.** This is the
repayment.

The 2026-09-02 entry got zod out of the **eager** graph by deep-importing three helpers from
`@musterd/protocol/model` and `/posture`. It stayed in the **product**: both of those modules import
their vocabularies from `acts.ts`, which builds `z.enum`s at module scope, so a lazy 13.5 KB
`posture` chunk was still fetched with the roster and the protocol barrel chunk still carried its
whole `z.object(...)` graph. An import tidy could not reach that — the reachability is structural.

So the structure changed. Every closed set and pure derivation the browser reads now lives in a
validator-free `*.wire.ts` module, and the zod module beside it **builds its enum from that tuple
and re-exports the name** — `acts`, `ask`, `capabilities`, `envelope`, `goals`, `lanes`, `offline`,
`posture`, `seeds`, `working-hours`. One list per vocabulary, so `@musterd/protocol` and the new
`@musterd/protocol/wire` subpath cannot disagree about what the wire allows; nothing was copied.
The eight web parse sites read through `packages/protocol/src/guards.ts`, and `/wire` is the
browser's whole door into the contract.

| | before (main @ 9ab435f0) | after | delta |
|---|---|---|---|
| total JS gzip | 249.1 KiB (38 chunks) | **228.6 KiB (36 chunks)** | **−20.5 KiB** |
| `/live` eager JS gzip | 139.1 KiB (13 chunks) | **132.0 KiB (12 chunks)** | **−7.1 KiB** |
| zod in `dist/client` | 13.5 KiB `posture` chunk | **absent** (no chunk matches `ZodError`) | — |

Budgets **re-baselined, both tightening** (ADR 183 permits only that direction): `totalJsGzipBytes`
258,000 → **237,000**, `initialJsGzipBytes` 144,000 → **137,000**, each measured + the known ~0.7 KB
CI gzip delta + ~1.2% slack per the 2026-08-12 precedent. That repays five of the six raises since
2026-08-24 and leaves ~2 KB of true headroom on each.

**What the browser gave up, precisely — and what it did not.** Two different jobs, and the
difference is deliberate:

- `readMemberSummary` **validates for real**, field by field, because something acts on the result:
  a row this build cannot read is counted into `unreadable` and the roster says so (ADR 148). A
  guard that waved rows through would make that count a lie. `guards.test.ts` runs it and
  `MemberSummarySchema` over one 44-row corpus and asserts they accept, reject and normalize
  identically — including the legacy `idle` → `active` transforms and the `.default()` fills — so
  it cannot drift from the schema unnoticed.
- The response readers (lane board/result, audit, report, seed list) check the **envelope of the
  response** and fill the older-daemon defaults, and stop there. In the browser the deeper check had
  no consumer: nothing branches on it, the page renders typed fields it either has or doesn't, and a
  strict parse of a response from a **newer** daemon is precisely the ADR 148 failure `fetchRoster`
  was rewritten to stop — an unreadable page instead of a calm hint.

The write path is untouched: the daemon still parses every envelope and every lane body with zod on
ingest, which is the boundary that decides what becomes durable. `makeEnvelope` keeps its parse for
every caller inside the daemon; the browser composes with `buildEnvelope` and posts to an endpoint
that validates.

**Trap, for the next person here.** The lever is *reachability*, not import style. Adding a value
export to a `*.wire.ts` module that a zod module also imports is free; adding one that imports a
zod module is not, and the cost is invisible in the diff — it appears as a chunk. `grep -l ZodError
packages/web/dist/client/assets/*.js` after a build is the check, and it should print nothing.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` on the merge commit — total should
  read ≈228.6 KiB against 231.4 KiB (237,000 B), initial ≈132.0 KiB against 133.8 KiB, and the grep
  above should find no chunk.

## 2026-09-14 — totalJsGzipBytes 237000 → 240000 (CI gzip delta, PR #1412)

A CLI-only Grok doctor follow-up (`inspectGrokHookDrift` tombstone, no `packages/web` files) went
red on `static` because `perf:check` read **231.5 KB / 231.4 KB** total JS gzip on CI. Local on the
same tree, after `pnpm -r build`, was **236,330 B / 231.1 KB against 237,000 B** — 670 B inside.
Nothing in the PR can move that number (ADR 183: total is delete-or-drop, and there was nothing to
delete). This is the 2026-09-01 process finding again: a ceiling that displays as N.4 KB against an
N.4 KB budget is a coin flip on CI's gzip, and the next PR — even a docs or CLI one — pays.

Re-baseline checked first and unavailable: measured + 15% loosens (ADR 183 may only tighten). Raise
is CI-measured (~237,056 B) + ~1.2% → **240,000**, same arithmetic as 2026-08-24/25/31 and 09-01/02.
The Grok doctor change is not the cost; the cost is the #1401 tree sitting on the last 0.1 KB of
the 2026-09-04 re-baseline's CI slack.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` on this PR — total must read under
  234.4 KB (240,000 B). A CLI-only checkout that still fails this number means the raise was short
  of the CI gzip delta, not that the doctor grew the bundle.

## 2026-09-16 — /watch lands: initial 137000 → 139500, total 240000 → 245000, siteCss 2900 → 4000

The stream's front door (copy spec `docs/design/watch-page-copy-spec.md`, lane `01M2M75BQH`) is a
new public prerendered route. Main @ `1db0152a` measured **133.3 KB initial / 233.4 KB total /
2,601 B site CSS** locally — **0.5 KB, 1.0 KB and 299 B free**. No whole page fits in that, so all
three ceilings move. Measured on the branch: **133.9 KB / 235.9 KB / 3,700 B**.

**Most of the eager cost was my defect, not the page's, and trimming came first.** `watch.tsx`'s
`head:` imported `WATCH_COPY` from `WatchPage.tsx`. A `head:` is evaluated for every route in the
tree, so that one import dragged the component module *and its stylesheet* into the eager graph and
made **/live pay +1.9 KB for a page it never renders** — TanStack's own route-splitting was working
and the import defeated it. Moving the four head strings into `watchCopy.ts` took the eager delta to
**+0.6 KB**. The generalisable finding: **what a route's `head:` imports is a budget decision, not a
filing decision**, and it is invisible in every other gate — the page rendered identically both ways.

Per ADR 183 the total moved the *other* way as predicted: +2.5 KB at 36 → 38 chunks, roughly 1 KB of
that per-chunk overhead from the very split that bought the eager win. That trade is the right one —
initial is the number a viewer feels — and it is the same shape as the 2026-09-02 BoardOverlay entry.

CSS was consolidated as well (three near-identical CTA rules → one `.watch-btn`), which recovered
0.1 KB. The remaining **1,099 B is the page's stylesheet** and is the feature. The `watch` bundle is
classified `site` in `budgets.cssBundles`; the unlisted-bundle gate (ADR 313) caught it before the
budget did, which is exactly the design.

Re-baseline checked first and **unavailable on all three**: measured + 15% loosens every one of
them, and a re-baseline may only tighten. JS raises are measured + the known ~0.7 KB CI gzip delta +
~1.2%, per 2026-08-24/25/31 and 09-02/03/14. `siteCssGzipBytes` is deliberately measured + ~8%
rather than + 1.2%, leaving ~300 B instead of ~45 B: the 2026-08-24 entry in this file records a
site budget shipped with **6 bytes free** and what the next change cost, and repeating that on the
one surface that is now growing page by page would be choosing the same failure knowingly.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` on this branch — initial must read
  under 136.2 KB, total under 239.3 KB, site CSS under 3.9 KB. If initial reads nearer 135 KB than
  134 KB, the `watchCopy.ts` split has been undone and the `head:` is importing the component
  module again.

## Total JS budget RAISED 245,000 → 248,400 bytes gzip (2026-09-18) — a raise, not a re-baseline

The office sprite cache (#1550) adds `sprite-cache.ts` and the parity-free half of its wiring to the
shipped graph. Measured on this branch after `pnpm -r build`: **total JS gzip 239.0 KB across 38
chunks** against a 239.3 KB budget — passing locally by 0.3 KB and **failing in CI at 239.4 KB**,
which is the ~0.7 KB CI gzip delta this file has recorded since 2026-08-24 eating the entire margin.

**Re-baseline checked first and unavailable**: measured + 15% is 274.9 KB, which loosens, and a
re-baseline may only tighten (ADR 183). So this is an ordinary raise and follows the raise protocol —
local measured **239.0** + the known **~0.7 KB** CI gzip delta + **~1.2%** = 242.6 KB = 248,400 bytes.

**What the bytes buy**, so the next reader can price a revert rather than re-derive it: on a
GPU-less `performance-4x` the cache takes `/broadcast` from **14.00 to 17.42 draws/s** at the
stream's own `fps=20` (+24%, ~71.5 → ~57.4 ms per draw), measured interleaved against a populated
room with `beats` delta 0. It is the only cut of three examined on 2026-09-18 that pays: dirty-rect
damage tracking was measured and declined (~26% cap, lane 01M2TM6C6XF6), and a smaller stage saves
only ~9 ms of 51 because the cost is per-operation rather than per-pixel
([where a canvas scene's time actually goes](../wiki/canvas-raster-vs-js.md)).

**The other budgets did not move.** `initialJsGzipBytes` reads 134.6 KB against 136.2 — the cache
rides in the office-scene chunk, which `/live` already loads, so the eager graph is unchanged. This
is the case ADR 183 splits the two budgets for: the code the product carries grew, the payload a
viewer feels did not.

- Falsify: `pnpm -r build && pnpm perf:check` on this branch — total must read under 242.6 KB and
  initial under 136.2 KB. If total reads at or under 239.3 KB, the cache has been dropped from the
  graph and this raise should be reverted with it.

## 2026-09-23 — `appCssGzipBytes` split: `live` 20,800 + `app` 7,600 (ADR 441)

Measured after `pnpm --filter @musterd/web build` (Node zlib, as the gate does): app group **24,661 B
of 24,700, 39 B free**. The gate printed `24.1 KB/24.1 KB`, a rounding that hid a ceiling the ~0.7 KB
CI gzip delta had already passed.

Trimming was measured first. There are no dead selectors: 109 of 632 classes have no literal source
token, and all of them are modifiers built at runtime from a stem in use. Duplicate rule bodies
are ~2.3 KB raw, and gzip already absorbs most of that, so a cascade-reordering merge would give
~100–200 B.

Split per ADR 441: `Live` 18,056 → `liveCssGzipBytes` 20,800 (2,744 B free); Board 2,279 +
Broadcast 2,246 + approvals 1,863 + audit 217 = 6,605 → `appCssGzipBytes` 7,600 (995 B free).
Measured + 15%, following ADR 313. A loosening, approved by nick.

### 2026-09-26 — /join/<team> (lane 01M3AKNKQ1): totalJsGzipBytes 248400 → 254700, `join` CSS → app

| measure | main (est.) | branch |
| --- | --- | --- |
| total JS gzip | ~241.6 KiB | 245.1 KiB (250,982 B), 40 chunks |
| initial JS gzip (/live) | 136.0 KiB | 136.0 KiB — unchanged, the route chunk is lazy |
| `join._team` chunk | — | 3,290 B gzip |
| `join` CSS | — | 557 B gzip (app group 6.5 of 7.4 KiB) |

The chunk is the join-page copy spec's strings verbatim plus the fragment/room-code helpers, so there is
nothing to trim or delete; lazy-loading cannot move total (ADR 183); a re-baseline would loosen. New
ceiling is measured + ~0.7 KB CI gzip delta + ~1.2%, per precedent.
## 2026-09-29 — /broadcast adopts the ask banner; `AsksReel` retires (ADR 464 follow-up)

No budget moves. `AsksReel.tsx`, `reel.ts`, `reelItems()` and the `.bc-reel` CSS are deleted;
`StreamAskBanner` reuses `askBanner()` and the `lc-asks` markup `/live` already ships. Measured
after lane 5 (main) → this branch: total JS 257.1 → 255.7 KiB (44 → 42 chunks), initial JS (/live)
134.9 → 130.7 KiB (13 → 11 eager chunks, a re-chunking side effect of the smaller graph), app CSS
7.0 → 6.0 KiB.

## 2026-10-08 — `totalJsGzipBytes` 275,200 → 278,600: un-red main after ADR 550's site copy (lane 01M4EKYAWS1SRE63RVGXGCX900)

Main @ `8060e004` went red on `perf:check` for every PR with a web build — CLI-only ones included:
total JS gzip read **268.8 KB against a 268.8 KB budget** on CI. The gate prints one decimal, so the
true figure sits between 275,201 and 275,302 B, i.e. 1–102 B over. The last bytes in are #2228's
longer `SITE_ONE_LINER` — ADR 550's accepted short form, which is the decided brand copy and not
shaveable. Lazy-loading cannot move total (ADR 183); no dependency to drop; a re-baseline would
loosen. New ceiling is the CI-measured upper bound + ~1.2%, per the 2026-09-01/14 precedents.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` on main — total must read under
  272.1 KiB (278,600 B). If main reads at or under 275,200 B (268.75 KiB), the over-budget cause has
  left the graph and this raise should go with it.

## 2026-10-15 — `totalJsGzipBytes` 315,700 → 319,500: /broadcast repaints only what changed (ADR 625, lane 01M4VS1SJQ)

Measured with the gate over `packages/web/dist/client`, origin/main built beside this branch on the same laptop: main **307.8 KiB**, this branch **311.5 KiB** — about **+3.7 KiB gz**. Per chunk: `office-scene` +3,176 B (`damage.ts` — the measure-pass recorder, the unit hash, rect merging and the repaint plan — and the frame driver in `index.ts`), `render` +324 B (the unit hook through the paint sequence, the furniture sprite parts), `broadcast` +43 B (`&dirty=0`).

Trimmed first: the recorder went from 35 hand-written methods to a table (−347 B). The dev-only parity check (`__office.dirtyParity`) is behind `import.meta.env.DEV` and does not ship; its strings are absent from the built chunks. What remains is the lever; lazy-loading cannot move total (ADR 183), there is no dependency to drop, and a re-baseline would loosen. New ceiling is measured + the same ~520 B headroom main carries today.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` — total must read under 312.0 KiB. At or under 307.8 KiB, the repaint has left the graph and this raise should go with it.

## 2026-10-05 — `totalJsGzipBytes` 271,100 → 275,200: the dense /board goal table (board readability inc 2, lane 01M472ETXPJX92917BTQP9W56R)

Measured with Node zlib over `packages/web/dist/client` after a build, as the gate does: main @
`a7797a86` **270,585 B** (264.2 KiB), this branch **271,183 B** (264.8 KiB) — **+598 B**. Main had
515 B free locally, inside the ~0.7 KB CI gzip delta, so any web change is already a coin flip on CI.

What the bytes are: nick's critique of the first table (#2121) — "cut off… I shouldn't have to scroll
horizontally… not very visually rich… I need to see more without scrolling" — and his follow-up ask
for one line of description per goal. The dense pass adds a per-goal stacked stage bar, owner and
reviewer avatar stacks, count pills, a stats strip with a legend, the one-line blurb, a container-query
reflow for narrow widths, and folds goals with nothing live into one closing line. Trimmed first: a
duplicate tooltip on the waiting cell dropped, and the table's own relative-age helper replaced by
the grid's (`ago`, now exported from GoalGridView) — the trim took the branch from 271,195 to 271,183 B.
What remains is the surface nick asked for; lazy-loading cannot move total (ADR 183); no dependency
to drop; a re-baseline would loosen. New ceiling is measured + the ~0.7 KB CI gzip delta + ~1.2%,
per precedent.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` — total must read under 268.8 KiB.
  At or under 264.2 KiB (main's measure), the dense table has left the graph and this raise should go
  with it.

## 2026-10-03 — `totalJsGzipBytes` 267,300 → 271,100: the /live halt control (ADR 501 increment 3, lane 01M41DRWWY4EE5CGRCJMZGDNVF)

Measured with Node zlib over `packages/web/dist/client` after a build, as the gate does: main @
`0e416e86` (halt increments 1–2 landed) **266,704 B** (260.5 KiB, 42 chunks), this branch
**267,234 B** (261.0 KiB, 42 chunks) — **+530 B**. Main had 596 B free locally, which is inside the
~0.7 KB CI gzip delta, so the PR's own gates read 261.2 KiB RED against 261.0 KiB before any trim.

| measure                 | main      | branch    |
| ----------------------- | --------- | --------- |
| total JS gzip           | 260.5 KiB | 261.0 KiB |
| initial JS gzip (/live) | 133.4 KiB | 133.4 KiB |
| `live` CSS              | 18.3 KiB  | 18.5 KiB  |

What the bytes are: the `lc-stat--halted` badge, `SeatHaltControl` (halt button → inline reason
field → confirm/cancel, or resume while halted, a daemon refusal shown in place), and the two client
helpers `haltSeat` / `resumeSeat`. The control rides the eager `live` chunk because `SeatDetail` does,
and initial did not move at the KiB level. Trimmed first: three tooltips cut to one clause each, the
badge title dropped its formatted timestamp, the placeholder shortened, the async handler folded to
a promise chain — the trim is what took the branch from 261.2 to 261.0 KiB locally. What remains is
the surface ADR 501 Decision 5 decided (the button renders from the daemon's `can_halt` alone), so
there is nothing further to delete; lazy-loading cannot move total (ADR 183); no dependency to drop;
a re-baseline would loosen. New ceiling is measured + the ~0.7 KB CI gzip delta + ~1.2%, per
precedent.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` — total must read under 264.7 KiB.
  At or under 260.5 KiB (main's measure), the halt control has left the graph and this raise should
  go with it.

## 2026-09-29 — /broadcast adopts the team column + ticker; the overlay reel and work stack retire (ADR 464 lane 5)

No budget moves. Deletion repays: `OfficeOverlay.tsx`, `WorkStack.tsx`, `broadcastChrome.ts` and
their CSS (~550 lines of `Live.css`) are gone, and `/broadcast` now mounts `TeamColumn` (`still`)
and `Ticker`, which `/live` already ships.

| | before (as recorded after lane 4, not re-measured on 73b4af1c) | after |
| --- | --- | --- |
| total JS gzip | 260.0 KiB | 257.1 KiB (44 chunks) |
| initial JS gzip (/live) | 136.0 KiB | 134.9 KiB |
| live CSS gzip | 19.4 KiB | 17.7 KiB |

## 2026-09-29 — `initialJsGzipBytes` 139,500 → 141,700: the ask banner and the walk tags (ADR 464 lanes 3–4)

Measured with Node zlib over `/live`'s modulepreload closure in `packages/web/dist/client`, as the
gate does: **139,294 B** (136.0 KiB, 14 eager chunks) against 139,500 — 206 B free locally, none on
CI after the ~0.7 KB gzip delta.

| measure | after lane 2 | after lane 4 |
| --- | --- | --- |
| initial JS gzip (/live) | 134.5 KiB | 136.0 KiB |
| total JS gzip | 257.3 KiB | 260.0 KiB of 261.0 |
| `live` CSS | 19.0 KiB | 19.4 KiB of 20.3 |

What the +1.5 KiB is: `askPhrase.ts` (the §6 words and the banner view-model), the banner's markup
in `AsksStrip`, `AskView.settledAt`, the asks wiring into `teamCards` / `TeamColumn` / `officeRoom`
(both routes), and `walkTag()` in `headline.ts`. All of it is on the eager path because it IS the
first paint a room reads. The lazy remedy was applied where it fits: `OfficeKey` (the corner card)
is a lazy chunk, which is what took 136.2 → 136.0. Nothing else here can move without moving the
banner off the first frame. Re-baseline unavailable (measured + 15% loosens). New ceiling is
measured + the ~0.7 KB CI gzip delta + ~1.2%, per precedent.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` — initial must read under
  138.4 KiB. At or under 134.5 KiB (lane 2's measure), lanes 3–4 have left the eager graph and
  this raise should go with it.

## 2026-09-28 — `totalJsGzipBytes` 261,200 → 267,300: meter, ticker, log drawer (ADR 464 lane 2, lane 01M3N7XHY6ENQQJZ425GZ9G9TZ)

Measured with Node zlib over `packages/web/dist/client` after a build, as the gate does: main @
`a4ee69b8` (lane 1 landed) **260,198 B** (254.1 KiB, 43 chunks), this branch **263,424 B** (257.3 KiB,
45 chunks) — **+3,226 B**.

| measure | main | branch |
| --- | --- | --- |
| total JS gzip | 254.1 KiB | 257.3 KiB |
| initial JS gzip (/live) | 135.1 KiB | **134.5 KiB** — the stream is a lazy drawer chunk now |
| `Stream` chunk | in `live` (eager) | 3,822 B, lazy |
| `reveal` chunk | — | 257 B (the reveal event, split so a caller need not pull the stream) |
| `live` CSS | 18.5 KiB | 19.0 KiB of 20.3 |

What the bytes are: `headline()` and `busyness()` (pure, tested), `TopMeter`, `Ticker`, `LogDrawer`,
and the route's key handling — about 2.5 KB — plus two chunks' worth of per-chunk overhead from the
`Stream` and `reveal` splits. The split is the point, not a cost to avoid: it is what moved the
number a viewer feels (initial) the other way. Companion mode, the stream grid track and its collapse
rules were deleted in the same change, so no further trim is available; lazy-loading cannot move
total (ADR 183); no dependency to drop; a re-baseline would loosen. New ceiling is measured + the
~0.7 KB CI gzip delta + ~1.2%, per precedent.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` — total must read under 261.0 KiB.
  At or under 254.1 KiB (main's measure), lane 2 has left the graph and this raise should go with it.

## 2026-09-26 — `totalJsGzipBytes` 254,700 → 261,200: the Welcome Wagon (lane 01M3F81DD9)

Measured with Node zlib over `packages/web/dist/client` after a build, as the gate does: main @
`0a297877` (with `/join` landed) **250,999 B**, this branch **257,400 B** — the feature is **+6,401 B**
(first measured at +5,470 B against an earlier main; the whole-branch review's fixes added the rest).

All of it rides the lazy `render` / `office-scene` chunks — the painters, plus the sequencer and
wiring (pulled into `render` by `render.ts` importing the lanyard flight time from `welcomeRoom.ts`)
— with `soundEngine` carrying the five synth voices. The welcome code is in the build exactly once
(grepped the chunks for its copy). `initialJsGzipBytes` moved +0.1 KB: the wire reader learning
`sponsored_by`, which the roster needs to name a sponsor in the caption.

No trim was available that keeps the feature: lazy-loading cannot move this budget (ADR 183), a
re-baseline may only tighten, and there is no dependency to drop. The new ceiling is measured + the
~0.7 KB CI gzip delta + ~1.2%, per the 2026-08-24/25/31 and 09-02/03 precedents.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` — total must read under 255.1 KB.
  At or under 245.1 KB (main's measure), the Welcome Wagon has left the graph and this raise should
  go with it.

### 2026-09-26 — Welcome Wagon runtime: a 28-guest crowd arriving (lane 01M3F81DD9)

Measured on `/office-preview?quiet` under `vite dev` (unminified — production reads lower), 1400×900
viewport, an independent rAF probe over two 12 s windows, `PerformanceObserver('longtask')` alongside:

| Window                                   | FPS  | p95 frame | worst frame | long tasks |
| ---------------------------------------- | ---- | --------- | ----------- | ---------- |
| quiet room (baseline)                    | 60.0 | 18.5 ms   | 18.7 ms     | 0          |
| 28 guests arriving (two 🎉 presses, 1 s) | 55.8 | 33.3 ms   | 35.3 ms     | 0          |

The worst frame stays inside the log's recorded envelope (42–794 ms) and nothing crosses a long
task; the p95 rise is 28 bodies walking in at once through the existing actor engine. An idle room
parks at 0 ticks/s before and after a welcome (`?quiet&idle=all`), and under reduced motion a welcome
runs with 0 rAF ticks (an off-loop timer steps it, and stops once it is done).

### 2026-10-09 — The Now briefing: total JS 278,600 → 283,000 B, live CSS 20,800 → 21,600 B (lane 01M4GXHERZF6A2KFMBK2G616CK)

The Now briefing (an overlay that docks to a side tab, grouped by human, goal and who shipped) replaces the
first build's Now tab. Measured on this branch (`pnpm --filter @musterd/web build && pnpm perf:check`); "before" is #2265's reading, which is main's since the revert (no web change has landed after it):

| Budget      | Before (main) | This branch | Ceiling → new     |
| ----------- | ------------- | ----------- | ----------------- |
| initial JS  | 136.2 KB      | 135.7 KB    | 141,700 (unmoved) |
| total JS    | 270.8 KB      | 273.1 KB    | 278,600 → 283,000 |
| live CSS    | 20.1 KB       | 20.7 KB     | 20,800 → 21,600   |

**The eager graph went down.** The overlay is a lazy chunk (`LazyNowOverlay` in `live.tsx`): it comes up a
beat after first paint anyway, so /live's first paint does not pay for it. That is the remedy ADR 183 names
for the initial budget, and it worked (-0.5 KB against main). It cannot move the total, and a 44th chunk adds
~1 KB of per-chunk overhead — about 1 KB of the +2.3 KB total is that overhead; the rest is the grouping and the three layouts.

No trim was available: the first build's Now CSS and component were replaced in the same change, the
remainder is the overlay's three layouts and the by-goal / by-person grouping, which are the surface. A
re-baseline may only tighten and measured + 15% loosens, so these are raises. New ceilings are measured + the
~0.7 KB CI gzip delta + ~1.2%.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` — total JS must read under 275 KB and live
  CSS under 21 KB. If the overlay is ever removed or made a smaller chunk, these raises should go with it.

### 2026-10-09 — The Demo Day prompt bar: app CSS 7,600 → 8,400 B (lane 01M4H4ARQCVVS31EKJPHCXMY7P)

The prompt bar's stylesheet is its own file (`PromptBar.css`, 738 B gzip), imported by the lazy `PromptBar`
chunk. `/live` mounts that chunk only behind three gates (`?promptbar=1`, a signed-in member, an admin), so a
default visit fetches neither its JS nor its CSS. The gate still budgets every emitted stylesheet. It is
classified `app`, an on-demand chunk like `/board`, not `live`.

| Budget  | Before (main) | This branch | Ceiling → new |
| ------- | ------------- | ----------- | ------------- |
| app CSS | ~7.4 KB       | ~8.1 KB     | 7,600 → 8,400 |

The app group had ~230 B free, under the file's 738 B. No trim is available: the file is the bar's whole look. A
re-baseline may only tighten, so this is a raise.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` — app CSS must read under 8.2 KB. If the
  prompt bar is removed after Demo Day, this raise goes with it.

### 2026-10-09 — total JS 283,000 → 288,000 B, with the prompt bar on top of the Now card v2 (lane 01M4H4ARQCVVS31EKJPHCXMY7P)

Measured with the prompt bar rebased onto main after the Now card v2 landed (#2305). Each PR passed on its own
branch. Together they do not fit.

| Reading                       | total JS          |
| ----------------------------- | ----------------- |
| main after #2305              | 275.6 KB          |
| + prompt bar (rebased)        | 277.2 KB (283,853 B) |
| ceiling                       | 283,000 → 288,000 |

The bar is a lazy chunk, so the eager graph is unaffected (137.5 KB of 138.4 KB) and lazy-loading cannot move
the total (ADR 183). It is demo code due to come out after Demo Day; removing it repays ~1.5 KB. New ceiling is
measured + the ~0.7 KB CI gzip delta + ~1.2%.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` on main after this lands — total JS reads under
  278 KB.

### 2026-10-09 — app CSS 8,400 → 9,300 B: the prompt bar becomes a composer (lane 01M4H7MNN45SR4ES6PFN8M3WK4)

nick: the first bar was "extremely unpolished". The composer that replaces it has a floating box, the team's faces,
an @-picker and a sent bubble, and `PromptBar.css` goes from 738 to 1,376 B gzip. It is still its own file in the
lazy chunk, mounted only behind `?promptbar=1`, a signed-in member and an admin. A default `/live` fetches none of
it, and initial JS fell 137.7 → 137.3 KB in the same change because the gate checks moved to `promptGate.ts`, which
keeps `promptAct.ts` out of the eager graph.

| Budget  | Before   | This branch | Ceiling → new |
| ------- | -------- | ----------- | ------------- |
| app CSS | ~7.9 KB  | ~8.6 KB     | 8,400 → 9,300 |

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` — app CSS under 8.8 KB. If the composer comes
  out after Demo Day, this raise and the 7,600 → 8,400 one before it go with it.

### 2026-10-09 — total JS 288,000 → 292,000 B, measured after the afternoon's web merges (lane 01M4H7MNN45SR4ES6PFN8M3WK4)

The composer branch, rebased on main after #2312 (claim walk), #2313 (homepage copy), #2314 (prompt-bar footer) and
#2315 (blocked marker), reads 280.8 KB (287,539 B) total JS against 281.3 KB. That leaves 0.5 KB, which is less than
the ~0.7 KB CI gzip delta. Initial is 137.3 KB of 138.4 KB, unchanged by the composer, because the gate split took
`promptAct.ts` out of the eager graph. No trim is available that is not a feature, and a re-baseline would loosen, so
this is a raise to measured + ~0.7 KB + ~1.2%.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` on main after this lands — total JS under 282 KB.

### 2026-10-11 — total JS 292,000 → 301,200 B and app CSS 9,300 → 10,500 B: the first-run tour (lane 01M4M4DDYFFX7FFD5YVRAQ1C50)

The tour walks a human through giving an agent one small lane and judging it, on `/live` and `/board` (spec
`docs/design/tour-web-copy.md`). It is one lazy chunk with its own stylesheet, mounted only for a viewer signed in as
a human, so a watcher fetches none of it. Main @ 5ac73bff had 0.9 KB of total JS and 0.1 KB of app CSS free; nick
approved the raise on 2026-10-11 before the build.

| Budget     | Main     | This branch          | Ceiling → new     |
| ---------- | -------- | -------------------- | ----------------- |
| total JS   | 284.3 KB | 289.9 KB (296,870 B) | 292,000 → 301,200 |
| app CSS    | 9.0 KB   | 9.7 KB (9,937 B)     | 9,300 → 10,500    |
| initial JS | 138.2 KB | 138.3 KB             | unchanged         |

The tour chunk is 5,384 B gzip: the shared script copied verbatim from `content/tour.data.ts` at build-prep, the step
machine ported from the CLI tour, and the panel. Lazy-loading cannot move total (ADR 183), there is nothing to
delete, and a re-baseline would loosen. JS is measured + the ~0.7 KB CI gzip delta + ~1.2%; CSS is measured + ~5%.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` on main after this lands — total JS under 290.5 KB,
  app CSS under 9.8 KB.

### 2026-10-11 — app CSS 10,500 → 12,000 B: the tour redesign (lane 01M4PSEV08EVHHB2XMTCC3MYSJ)

nick took the tour and asked for it to be magical, satisfying and smooth, and approved one raise of about +6 KB
before the build. The tour lane is now a ticket whose four-stop track lights as the real acts land, the agent's
team card and the lane's card are spotlit on the page, the picker shows each agent's readiness and suggests an awake
one, an accept stamps the ticket with a CSS-only confetti burst, and on a phone the panel is a bottom sheet. All of it
is in the tour's lazy chunk, mounted only for a signed-in human.

| Budget     | Main      | This branch          | Ceiling → new   |
| ---------- | --------- | -------------------- | --------------- |
| app CSS    | ~9.9 KB   | 11.1 KB (11,400 B)   | 10,500 → 12,000 |
| total JS   | ~289.9 KB | 292.6 KB             | unchanged       |
| initial JS | 138.3 KB  | 138.3 KB             | unchanged       |

`Tour.css` is 2,196 B gzip (was ~720 B) and the tour JS chunk 8,119 B (was 5,384 B). Nothing to trim that is not
the feature: every rule is a visible part of the design. CSS is measured + ~5%; total JS fits unraised.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` on main after this lands — app CSS under 11.5 KB,
  `Tour-*.css` under 2.3 KB gzip.

### 2026-10-12 — initial JS 141,700 → 144,600 B, total JS 301,200 → 307,300 B, site CSS 4,000 → 4,800 B: the /start page (lane 01M4GQ2NR438YWWYRH7RTTYP9X)

The first session's front door for the first-run-10-minutes goal: a static public route (`/start`) with the
ten-minute arc in four moves, the real office still, a labelled board-chain illustration, and the handoff to
the in-product tour. The homepage Getting started block links here again (held back while the route 404ed).

| Budget     | Main     | This branch          | Ceiling → new     |
| ---------- | -------- | -------------------- | ----------------- |
| initial JS | 138.4 KB | 138.8 KB (~142.2 KB top of rounding) | 141,700 → 144,600 |
| total JS   | 294.1 KB | 295.8 KB (~302.9 KB top of rounding) | 301,200 → 307,300 |
| site CSS   | 3.9 KB   | 4.4 KB               | 4,000 → 4,800     |

The marginal cost is the page itself and is measured, not inferred: the `start-*.js` chunk is 1,618 B gzip
(≈ the +1.7 KB total overage), the route-tree row the new route adds to every route's eager graph is the
+0.4 KB on /live, and `start-*.css` is 641 B gzip (classified `site` per ADR 313, beside `watch`). The page
is static markup with no hooks and no daemon imports; lazy-loading cannot move the route-tree row or the
total (ADR 183), and there is nothing to delete. JS follows the tour precedent (measured + ~0.7 KB CI gzip
delta + ~1.2%, rounded up to the hundred); CSS is measured + ~5%. A re-baseline would loosen, so this is a
raise. The 2026-10-11 tour entries' falsify lines still stand; this entry's budgets are the new ceilings.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` on main after this lands — total JS under 303.5 KB,
  initial JS under 139.5 KB, `start-*.css` under 700 B gzip.

### 2026-10-12 — /live initial JS 141,696 → 140,229 B: the card detail and the log drawer load on use (lane 01M4RNDW6ZKW1MV77FRBJ9BTSP)

Main sat 4 B under `initialJsGzipBytes` (141,700), so a lazy chunk's new hash alone pushed /live over and turned
unrelated web PRs red (#2371). Measured from the build's source maps: `RosterPanel.tsx` rode the eager graph only
because `TeamCard` imported `SeatDetail` for the expanded card, and `LogDrawer` mounted closed on every visit. Both are
now `lazy()`: `SeatDetail` on a card's first expand, the drawer only while open.

| Budget     | Main            | This branch     | Ceiling   |
| ---------- | --------------- | --------------- | --------- |
| initial JS | 141,696 B       | 140,229 B       | unchanged |
| total JS   | 292.9 KB        | 293.9 KB        | unchanged |

Measured on `0d84fc43`. Rebased onto `25419dc0` (the /start page, which raised both ceilings the same day): /live
initial JS 140,728 B against 144,600, total 296.8 KB against 300.1 KB. Total rises by ~1 KB of chunk overhead, as
ADR 183 says a split does; it still fits. What remains eager is mostly the
framework (react-dom, the router and seroval: ~290 KB of the ~400 KB minified), so the next app-code cut is small.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` on main after this lands — /live initial JS above
  140,400 B with no other eager change.

### 2026-10-12 — /live paints from the last snapshot, skeletons on a first visit (lane 01M4RNBNFM7Y91HH55FMRWT22C)

nick: /live took 5–10 s to show anyone. Measured on one reload: every script was in by 140 ms, then each daemon read
took 3–4.4 s on a saturated daemon (80 % CPU, load 13), and the panels said "0 working", "no open questions" and
"nothing loaded" the whole time. Now the page paints this browser's last snapshot at once (`liveCache.ts`: roster,
newest 120 envelopes, open lanes; ~119 KB in localStorage) and marks it `refreshing…`; a first visit draws skeletons.

Measured in the dev preview on the revive team: team, asks strip, ticker and meter on screen at ~0.6 s; the daemon's
answer replaced them at 6.1 s. Before, the same panels were empty or wrong until it answered.

| Budget     | Before (main `552a90a6`) | This branch | Ceiling   |
| ---------- | ------------------------ | ----------- | --------- |
| initial JS | ~137.4 KB                | 138.1 KB    | unchanged |
| total JS   | ~296.8 KB                | 297.6 KB    | unchanged |
| live CSS   | 20.9 KB                  | 21.1 KB     | unchanged |

Live CSS is now at its ceiling; the next rule there needs a trim or a raise.

- Falsify: open /live, reload — the team column shows cards before the daemon's `/teams/<team>` response completes.

### 2026-10-12 — the home page's day-in-the-life graph (ADR 571, lane `01M4S6956Z8GZ6QAWJRGB7ZKXF`)

The chain section (`Chain.tsx` + `Chain.css` + a 218 px board-card capture) is replaced by
`DayInTheLife`: ten HTML nodes positioned in percent over an SVG of drawn edges, a swapping caption
card, a phone layout and a reduced-motion variant. The new CSS is the whole cost; the JS is one
site-route chunk and the capture's bytes leave.

| Budget   | Before (main `8ce5b689`) | This branch | Ceiling                |
| -------- | ------------------------ | ----------- | ---------------------- |
| site CSS | 3.8 KB                   | 5.3 KB      | RAISED 4.7 KB → 6.1 KB |
| total JS | 293.1 KB                 | 299.1 KB    | unchanged (300.1 KB)   |

The raise is measured + 15% (ADR 183). Trimming was not available without dropping the phone layout
or the reduced-motion rules, both of which the ADR requires. Total JS is now 1 KB under its ceiling;
the next site-route component needs a trim or a raise there.

- Falsify: `pnpm perf:check` after a build reports site CSS at or under 6.1 KB with the section
  present in the home route.

### 2026-10-12 — replay on open, take 2 (lane `01M4S6P36WN28TCFMAGWFW78KP`)

The room plays the last ten minutes' lane walks once on mount (`office-scene/replay.ts`, drained by
the frame loop). ~100 B of gzipped JS in the office chunk; the headline ticker's builders left
`headline.ts` in the same change (dead since the ticker was retired, already tree-shaken, so no
measured saving).

| Budget   | Before (main `871f9914`) | This branch | Ceiling                       |
| -------- | ------------------------ | ----------- | ----------------------------- |
| total JS | 300.1 KB (307,2xx B)     | 307,342 B   | RAISED 307,300 → 310,000 B    |

The ceiling was already saturated by prior merges (the entry above said the next feature needs a
trim or a raise), and gzip swings ±50 B between builds of the same source, so a 50-byte trim is not
a lever. Raised tight — measured + 0.9%, not the +15% ritual — because the office is the surface
that grows fastest and a 15% loosening would hide the next 40 KB of it.

- Falsify: `pnpm perf:check` after a build reports total JS at or under 310,000 B with replay in the
  office chunk.

### 2026-10-13 — the /live lanes read: `brief=1` drops `detail` and `scope` (lane `01M4RNCZVBHY3ZRYEF6825ZD8E`)

The live-loads-fast spec's third bar line (the daemon's answer ≤ 3.0 s) has the lanes read as the slowest
request. Counted from the hub's store on 2026-10-13, revive's windowed board (ADR 534) was 668 rows, 949 KB
raw, 254 KB gzip; by field, `detail` 343 KB, `title` 89 KB, `scope` 82 KB, `merged` 60 KB. Nothing on
`/live` reads `detail` or `scope` (the board overlay shows a branch chip, the briefing reads `depends_on`),
so `GET /lanes?brief=1` returns the same rows with those two blank, and `/live` asks for every state but
`abandoned`.

| Read (revive, 2026-10-13 21:09Z)                  | Rows | Raw    | Gzip   |
| ------------------------------------------------- | ---- | ------ | ------ |
| full, observed on the wire from the dev preview   | 645  | 853 KB | 247 KB (br 236 KB) |
| `brief=1`, the same body with the two fields blank | 645  | 473 KB | 102 KB |

The full row is the page's own request through the dev proxy to the running daemon; `detail` was 317 KB of
it and `scope` 74 KB. The brief row is that body transformed as the server does, since the running daemon
predated the flag: a daemon that does not know `brief` ignores it and answers with full rows (200, `detail`
present), so the page is correct against either build, and the 400 fallback covers a daemon that rejects
it. The wire number for brief lands with the spec's measurement increment. No JS budget moves (one option
object on the client; +~120 B).

- Falsify: on a daemon at or past this commit, `/live`'s lanes request carries `brief=1`, every row's
  `detail` is null, and the response is under 110 KB gzip on revive's board; the Now card's "d of n done"
  equals `/board`'s done count per goal.

### 2026-10-13 — `totalJsGzipBytes` 310,000 → 310,500 B: the home page's third capture (lane `01M4V74X9WA29DGH3BNTFQ2F6Y`)

The `musterd status` frame under Getting started step 3 is ~400 B of JSX text in the home route's
chunk, ~100 B gzipped; no new chunk, no new CSS (it reuses WhyTalk's terminal frame; site CSS stayed
5.8 of 6.0 KB).

| Budget   | Before (main `556b0b53`) | This branch                      | Ceiling                    |
| -------- | ------------------------ | -------------------------------- | -------------------------- |
| total JS | 302.5 KB (locally)       | 302.5 KB locally · 302.8 KB (310,067 B) in CI | RAISED 310,000 → 310,500 B |

The ceiling was already saturated when the replay raise above was made (measured + 0.9%), and CI's gzip
lands 50–300 B above a laptop's for the same source. Raised tight again, measured + 0.14%; a trim of 70
bytes is below the noise and not a lever. The next web feature of any size on this route needs a real
trim or a re-baseline that tightens elsewhere.

- Falsify: `pnpm perf:check` after a build reports total JS at or under 310,500 B with the frame in
  the home route.

### 2026-10-13 — `totalJsGzipBytes` 310,500 → 311,200 B: pin holes remember where cards hung (lane `01M4VP3V99`)

| Budget   | Before (main, same day)      | This branch | Ceiling                    |
| -------- | ---------------------------- | ----------- | -------------------------- |
| total JS | 303.1 KB (~310,400 B)        | 303.4 KB (~310,680 B) | RAISED 310,500 → 311,200 B |

The change is ~0.3 KB gz: `withHeld` (the per-column high-water marks), `boardHoles.ts` (guarded browser
storage, validated on read) and the hole drawing. No dependency, no chunk added. The ceiling was
already saturated, so the feature failed `perf:check` by ~180 B locally; a trim that size is below gzip
noise (±50 B a build, CI +50–300 B over a laptop) and was not found inside this change. Raised tight, measured
+ ~0.15%, not +15%. The next web feature that adds bytes needs a real trim or a re-baseline that tightens
elsewhere — sun shafts (the next lane under `office-liveliness`) will be the test of that.

- Falsify: `pnpm perf:check` after a build reports total JS at or under 311,200 B with this change in.

### 2026-10-13 — `totalJsGzipBytes` 311,200 → 311,700 B: the sprite cache measures each item once (lane `01M4W0JB4M`)

| Budget   | Before (main, same day)   | This branch (CI)                | Ceiling                    |
| -------- | ------------------------- | ------------------------------- | -------------------------- |
| total JS | ≤ 311,200 B (green)       | 303.9 KB (311,143–311,245 B)    | RAISED 311,200 → 311,700 B |

`blitSprite` ran `measureBounds(draw)` before every cache lookup, so every cached office item replayed
its full draw through a Proxy on every `/broadcast` frame. The fix moves the box into the cache
(`SpriteCache.box()`, one LRU entry per key for box and sprite), ~100 B gz. It is a perf fix to the
draw that holds the stream at ~15 draws/s, so it is not a trade against a feature. The ceiling was
saturated by the pin-holes raise above, and a trim this size is under gzip noise. Raised tight: CI upper bound + ~0.15%.

- Falsify: `pnpm perf:check` after a build reports total JS at or under 311,200 B with this change in.


### 2026-10-19 — `totalJsGzipBytes` 330,200 → 334,000 B, `appCssGzipBytes` 13,300 → 14,000 B: the pairing confirmation panel (lane `01M50XPYZ9`)

| Budget   | Ceiling before | This branch, stacked on `b2b30fe1` (local) | Ceiling                    |
| -------- | -------------- | ------------------------------------------ | -------------------------- |
| total JS | 322.5 KB       | 323.4 KB                                   | RAISED 330,200 → 334,000 B |
| app CSS  | 13.0 KB        | 13.2 KB (after classification)             | RAISED 13,300 → 14,000 B   |
| initial JS | 142.0 KB     | 141.5 KB                                   | fits — no raise            |

The /live channel-pairing confirmation panel (ADR 618 §7: `PairingPanel` + `pairingClient`) renders only while a pairing is staged, so it is a lazy chunk and its stylesheet is classified `app` (an on-demand chunk, like PromptBar). /live's eager graph pays only the lazy mount; the wire helpers live in the lazy module so the eager `client` chunk pays nothing. Measured stacked on the pulse raise, which had already lifted the initial ceiling past this panel's mount. What remains is the panel itself — nothing to trim that is not the feature, and lazy-loading cannot move total (ADR 183). JS is local + the ~0.7 KB CI gap + ~1.2% per precedent; CSS is measured + the CI gap.

- Falsify: `pnpm perf:check` in CI on main after this lands reports total JS at or under 330,200 B.

### 2026-10-19 — `initialJsGzipBytes` 145,400 → 146,200 B: a live countdown on every experiment read (lane `01M5AXHFZT`)

| Budget     | Before (main 418b5944, same laptop) | This branch (laptop) | Ceiling                    |
| ---------- | ----------------------------------- | -------------------- | -------------------------- |
| initial JS | 145,185 B                           | 145,631 B (+446)     | RAISED 145,400 → 146,200 B |

nick: "a countdown clock to make it more exciting for the viewer." Each read's row now counts toward
the read day's 00:00 in the team zone — `2d 14h 05m`, `today · 9h 12m left`, `overdue · 2d 04h` —
against a minute tick. The cost is `readDayStart` (an Intl round trip so DST comes from the platform,
not a table), `clockPhrase`, and the `useMinuteTick` hook, all on the eager TeamColumn graph on /live
and /broadcast; nothing here can be lazy-loaded without lazy-loading the team column itself. Runtime:
one timeout per page re-armed to the wall minute, paused while hidden — one text node per row per minute.

- Falsify: `pnpm perf:check` after a build reports initial JS at or under 145,400 B with this change in.

### 2026-10-19 — `initialJsGzipBytes` 144,600 → 145,400 B: the seat pulse reaches the office (lane `01M5AJ9T16`, ADR 660)

| Budget     | Before (main 735ae52c, same laptop) | This branch (laptop)  | Ceiling                    |
| ---------- | ----------------------------------- | --------------------- | -------------------------- |
| initial JS | 144,624 B                           | 144,826 B (+202)      | RAISED 144,600 → 145,400 B |
| total JS   | 321.6 KB                            | 322.3 KB (+~700 B)    | 330,200 B, unchanged       |

The desk now moves only from the seat's own harness tool calls (ADR 660): a `seat_pulse` case in the
live client, a `pulses` Map in `useLiveStream`, and the `OfficeScene` effect that hands a changed pulse
to the scene — that is the +202 B on the eager graph, and it cannot be lazy-loaded: the socket handler
and the hook state are the entry. The rest (`live/pulse.ts` liveness, `typingFromPulse`, the screen
life and bloom) is inside the already-lazy office chunk. Main itself measured 24 B over the old ceiling
locally, so the raise is measured + the ~450 B CI gap + ~100 B.

Runtime cost went the other way: a seated `working` seat used to keep the rAF loop awake forever on
a seeded typing loop; now the loop parks within fifteen seconds of the last tool call.

- Falsify: `pnpm perf:check` after a build reports initial JS at or under 144,600 B with this change in.

### 2026-10-19 — `totalJsGzipBytes` 328,600 → 330,200 B, `liveCssGzipBytes` 24,600 → 24,700 B: model names and logos (lane `01M5AJXMWV`)

| Budget   | main `d85557c9` (local) | This PR (local) | Ceiling                    |
| -------- | ----------------------- | --------------- | -------------------------- |
| total JS | 328,089 B               | 329,608 B       | RAISED 328,600 → 330,200 B |
| live CSS | 24,353 B                | 24,426 B        | RAISED 24,600 → 24,700 B   |

JS +1,519 B: four lab logos inlined beside the eleven already there (StepFun, LongCat, Ant Group for Ling, Z.ai for GLM, each flattened to one fill) and a label rule that keeps a model's whole name ("GPT 6 Luna", "Kimi K3") instead of family plus version. CSS +73 B: the stone pin a lab with no logo wears its model's initial in. nick asked for this directly (2026-10-19: "No more question mark logos"). JS is local plus the ~450 B CI gap; CSS is measured plus about 210 B.

- Falsify: `pnpm perf:check` in CI on main after this lands reports total JS at or under 328,600 B.

### 2026-10-18 — `totalJsGzipBytes` 328,300 → 328,600 B: a speech bubble stays inside the scene (lane `01M5977YVQ`)

| Budget   | main `96413b91` (local) | This PR (local) | With #2879 stacked (local) | Ceiling                    |
| -------- | ----------------------- | --------------- | -------------------------- | -------------------------- |
| total JS | 327,890 B               | 328,063 B       | ~328,070 B                 | RAISED 328,300 → 328,600 B |
| live CSS | 24,288 B                | 24,313 B        | ~24,353 B                  | 24,600 B (#2879's raise)   |

JS about +170 B (local builds vary by ~50 B): a bubble is measured once at its full width before the typewriter empties it, and slides in from a side wall instead of carrying half its sentence past the edge (the phone band's welcome opened at "e to the musterd office"). CSS +25 B: the tail stays over the speaker. The CSS fits the 24,600 B that #2879 set, which landed first. Main already sat within the CI gap of both ceilings. JS is local plus the ~450 B CI gap; CSS is measured plus about 210 B.

- Falsify: `pnpm perf:check` in CI on main after this lands reports total JS at or under 328,300 B.

### 2026-10-18 — `liveCssGzipBytes` 24,500 → 24,600 B: the phone topbar wraps, the team column scrolls as one (lane `01M596F88W`)

| Budget   | main `96413b91` (local) | This PR (local) | Ceiling                  |
| -------- | ----------------------- | --------------- | ------------------------ |
| live CSS | 24,288 B                | 24,328 B        | RAISED 24,500 → 24,600 B |

CSS +40 B: the topbar's controls become one wrapping group, and under 880px the team column scrolls as one instead of squeezing its cards. Both are fixes to phone layout that ryder flagged when accepting #2875, not features. Main already sat at 24,288 + ~210 B CI gap = ~24,498 against 24,500, so any CSS at all would cross it. CSS is measured plus about 210 B.

- Falsify: `pnpm perf:check` in CI on main after this lands reports live CSS at or under 24,500 B.

### 2026-10-18 — `totalJsGzipBytes` 327,000 → 328,300 B and `liveCssGzipBytes` 24,300 → 24,500 B: the log, the office key and the phone band, measured stacked (lanes `01M57WK2AR`, `01M57WK4A2`, `01M57WJMBD`)

| Budget   | main `ab7a3733` (local) | The three stacked (local) | Ceiling                    |
| -------- | ----------------------- | ------------------------- | -------------------------- |
| total JS | 326,531 B               | 327,808 B                 | RAISED 327,000 → 328,300 B |
| live CSS | 24,109 B                | 24,288 B                  | RAISED 24,300 → 24,500 B   |

Three `live-delight` PRs carry this same raise, measured with all three applied, so each passes alone and they merge in any order — the previous entry is what happens when a stack is measured one PR at a time. JS +1,277 B: the team log draws senders as faces, says a minute once down a run, and names a huddle's lane by its title; the office key draws each state; the tour's agent chips wear faces; the phone gets an inert office band. CSS +179 B. JS is local plus the ~450 B CI gap; CSS is measured plus about 210 B.

- Falsify: `pnpm perf:check` in CI on main after all three land reports total JS at or under 327,000 B or live CSS at or under 24,300 B.

### 2026-10-18 — `liveCssGzipBytes` 23,850 → 24,300 B and `totalJsGzipBytes` 326,500 → 327,000 B: the live-delight pass lands together (lane `01M57WJV9F`)

| Budget   | main `a37c1ee0` (local) | This branch (local) | Ceiling                    |
| -------- | ----------------------- | ------------------- | -------------------------- |
| total JS | 326,255 B               | 326,554 B           | RAISED 326,500 → 327,000 B |
| live CSS | 23,948 B                | 24,109 B            | RAISED 23,850 → 24,300 B   |

Five `live-delight` PRs (#2866 compact Experiments, #2867 Now sheet, #2868 asks rail faces and wave, #2870 roster faces and state dot, #2872 walk tags) each fit under the ceiling alone and merged within the hour; together they put main's live CSS at 23,948 B, over its 23,850 B ceiling, so every web PR after them read red. This raise carries main back under and adds this PR's own cost: +161 B CSS for the share card, the activity hill and the pause glyph, +299 B JS for `sparkPath` and the share card's outside-press close. JS is local plus the ~450 B CI gap; CSS is measured plus about 190 B. Lesson for a stack of web PRs from one seat: measure the stack, not each PR.

- Falsify: `pnpm perf:check` in CI on main after this lands reports live CSS at or under 23,850 B or total JS at or under 326,500 B.

### 2026-10-18 — `liveCssGzipBytes` 23,650 → 23,850 B: the Now briefing as a tacked sheet (lane `01M57WJJ2R`)

| Budget   | main `bb84e5bf` (local, Live.css swapped back) | This branch (local) | Ceiling                  |
| -------- | ---------------------------------------------- | ------------------- | ------------------------ |
| live CSS | 23,482 B                                       | 23,674 B            | RAISED 23,650 → 23,850 B |

nick: everything on `/live` should feel warm and delightful. The Now card becomes a sheet tacked to the room with two tacks, opens with a greeting ("Good morning, ada" and the day), and its rows rise in and its goal bars fill once per opening, still under reduced motion and on the stream. +192 B of live CSS. The card's JS is a lazy chunk, but its rules live in `Live.css`, which `/live` loads whole. CSS is measured plus about 170 B.

- Falsify: `pnpm perf:check` in CI reports live CSS at or under 23,650 B with this change in.

### 2026-10-17 — `totalJsGzipBytes` 325,900 → 326,500 B and `liveCssGzipBytes` 22,850 → 23,650 B: the Experiments section made delightful (lane `01M56P1JDY`)

| Budget   | main `20ae0953` (local, built beside it) | This branch (local) | Ceiling                    |
| -------- | ---------------------------------------- | ------------------- | -------------------------- |
| total JS | 325,378 B                                | 326,050 B           | RAISED 325,900 → 326,500 B |
| live CSS | 22,677 B                                 | 23,482 B            | RAISED 22,850 → 23,650 B   |

nick, on the first cut: "they look extremely bare". The rework is +672 B gzip of JS, all in the `TeamColumn` chunk: each read's date on a tear-off calendar leaf, a fortnight strip that places the reads against today, the owner's avatar, short titles, and a shared hover between strip and rows. Live CSS is +805 B: the leaf with its tack and weekday band, the verdict stamp, the strip, and the motion, each of which runs once and is off under reduced motion. The section renders on first paint in the team column, so it cannot be lazy; lazy-loading cannot move total anyway (ADR 183). JS is local 326,050 plus the ~450 B CI gap; CSS is measured plus about 170 B.

- Falsify: `pnpm perf:check` in CI reports total JS at or under 325,900 B and live CSS at or under 22,850 B with this change in.

### 2026-10-17 — `totalJsGzipBytes` 325,400 → 325,900 B: the corkboard read pins (lane `01M55WK0N2`, ADR 644 increment 3)

| Budget   | main `5895c173` (local, built beside it) | This branch (local) | Ceiling                    |
| -------- | ---------------------------------------- | ------------------- | -------------------------- |
| total JS | 324,939 B                                | 325,377 B           | RAISED 325,400 → 325,900 B |

The pins are +438 B gzip of JS. The office scene's `render` chunk is +342: the oak rail, the tags with their tacks, the overdue tag's slip, the tick and the "+" card. `wallboard` is +78: the reads riding the wall board through a card in hand and a card being pinned, and the eight-pin cap. `TeamColumn` is +28, which is the entries handed to the scene. Other chunks moved by gzip noise. The strip paints inside the always-on scene, so it cannot be lazy; lazy-loading cannot move total anyway (ADR 183). CSS is unchanged. Local 325,377 is 23 B under the old ceiling, and CI reads about 450 B higher, so CI would have gone red. JS is local 325,377 plus the ~450 B CI gap.

- Falsify: `pnpm perf:check` in CI reports total JS at or under 325,400 B with this change in.

### 2026-10-17 — `totalJsGzipBytes` 324,000 → 325,400 B and `liveCssGzipBytes` 22,500 → 22,850 B: the Experiments section (lane `01M55KZF5M`, ADR 644)

| Budget   | main (local, built beside it) | This branch (local) | Ceiling                    |
| -------- | ----------------------------- | ------------------- | -------------------------- |
| total JS | 323,369 B                     | 324,907 B           | RAISED 324,000 → 325,400 B |
| live CSS | 22,323 B                      | 22,677 B            | RAISED 22,500 → 22,850 B   |

The section is +1,538 B gzip of JS, all of it in the `TeamColumn` chunk: `experimentReads.ts` (which lanes show, their order, the day counts in the team's calendar zone, the phrases and the screen-reader label), `Experiments.tsx` (the rows, the cap and toggle, the once-only status flash) and the four inline SVG marks, plus the folded rail's overdue count. Every other chunk moved by gzip noise. Live CSS +354 B is the section's rows in `Live.css`, after folding the per-status colour rules into two `:is()` selectors. The section sits in the team column on `/live` and `/broadcast`, which renders on first paint, so it cannot be lazy; lazy-loading cannot move total anyway (ADR 183). The web imports protocol types only, so no zod joins the eager graph. JS is local 324,907 plus the ~450 B CI gap; CSS is measured plus ~150 B.

- Falsify: `pnpm perf:check` in CI reports total JS at or under 324,000 B and live CSS at or under 22,500 B with this change in.

### 2026-10-16 — `totalJsGzipBytes` 323,400 → 324,000 B and `liveCssGzipBytes` 22,400 → 22,500 B: one lane read end to end (lane `01M534RA2H`, ADR 629)

| Budget   | main (local, built beside it) | This branch (local) | Ceiling                    |
| -------- | ----------------------------- | ------------------- | -------------------------- |
| total JS | 322,275 B                     | 323,407 B           | RAISED 323,400 → 324,000 B |
| live CSS | 22,219 B                      | 22,323 B            | RAISED 22,400 → 22,500 B   |

The chain is +1,132 B gzip of JS. `wire` +624 is `laneChain` (who asked, who claimed, which model, who accepted, who authorized). `Board` +393 is the five links and the card control. `BoardOverlay` +68, the `/board` route +57, and `client` +7 are the fetch. Other chunks net about −7 B, gzip noise. Live CSS +104 B is the list in `Live.css` (the 24px control, the three columns, the word for the mark). Nothing in that delta is removable without dropping the read, and lazy-loading cannot move total (ADR 183). JS is local 323,407 plus the ~450 B CI gap measured on 2026-10-15; CSS is measured plus ~150 B. The local JS reading is 7 B over the old ceiling, so a trim of the noise would still leave CI red.

- Falsify: `pnpm perf:check` in CI reports total JS at or under 323,400 B and live CSS at or under 22,400 B with this change in.

### 2026-10-16 — `totalJsGzipBytes` 319,500 → 323,400 B and `appCssGzipBytes` 12,000 → 13,300 B: the /live lane picker (lane `01M5162T6H`)

| Budget   | Delta vs main (built beside it)                                   | Ceiling                    |
| -------- | ----------------------------------------------------------------- | -------------------------- |
| total JS | +4,005 B: `PickOverlay` 3,284 (lazy), `wire` +500, `live` +151      | RAISED 319,500 → 323,400 B |
| app CSS  | +1,814 B: `PickOverlay.css`, classed `app` so `live` pays nothing | RAISED 12,000 → 13,300 B   |

A new surface: `/live?pick=<seat>` lists the board's open lanes for a seat from `pickerRows` and hands the
picked one over as the human. The overlay is its own lazy chunk with its own sheet, so the initial load
is unchanged (139.1 of 141.2 KB) and the always-on live stylesheet gains nothing. The chunk is the
component alone (about 9 KB minified, with nothing bundled that the page did not already carry). The
picker logic joins the shared `wire` chunk, because the root protocol index carries node-only modules.
Lazy-loading cannot move total (ADR 183). JS is local plus the ~450 B CI gap measured on 2026-10-15;
CSS is measured plus ~150 B.

- Falsify: `pnpm perf:check` in CI reports total JS at or under 319,500 B and app CSS at or under 12,000 B with this change in.

### 2026-10-16 — `totalJsGzipBytes` 313,600 → 315,700 B and `liveCssGzipBytes` 21,700 → 22,400 B: an ask that is a choice (lane `01M511XNQC`)

| Budget   | main (local, built beside it) | This branch (local) | Ceiling                    |
| -------- | ----------------------------- | ------------------- | -------------------------- |
| total JS | 312,989 B                     | 314,995 B           | RAISED 313,600 → 315,700 B |
| live CSS | 21.2 KB                       | 22,251 B            | RAISED 21,700 → 22,400 B   |

On 2026-10-15 nick approved a four-option consult from the `/live` rail without seeing the options, and
the asker read the empty accept as option C. Now a choice gets Choose… instead of Approve, the sheet shows
every option as its own answer, the pick is sent as the option ("C — …"), and the rail settles on "nick
chose C ✓". The JS is almost all in the `askPhrase` chunk: the option parser, the `AskChoices` picker,
and the strip's linger and settle-clock logic. The CSS was trimmed first (the per-property transition
lists, a margin rule and a duplicate font) and is the picker's look: the dealt cards, the stamp, and the
breathing Choose…. Lazy-loading cannot move total (ADR 183). JS is local plus the ~450 B CI gap measured
on 2026-10-15; CSS is measured plus ~150 B.

- Falsify: `pnpm perf:check` in CI reports total JS at or under 313,600 B and live CSS at or under 21,700 B with this change in.

### 2026-10-15 — `totalJsGzipBytes` 313,000 → 313,600 B: a companion gesture, and the room notices (lane `01M50YPZN8`, ADR 617)

| Budget   | This branch (local, rebased on #2700) | First CI run (before the rebase) | Ceiling                    |
| -------- | ------------------------------------- | -------------------------------- | -------------------------- |
| total JS | 312,990 B                             | 305.9 KB (~313,200 B)            | RAISED 313,000 → 313,600 B |

About 400–500 B gz: the shared rotation that companions take turns in (`ambientSeed.ts`),
`actors.notice` and `walking`, the scene's `movingNear` and companion step, and `/office-preview`'s
synthetic colleagues for `?n` past the hand-written roster, which a twelve-seat measurement needs.
Nothing to cut that is not the feature, and lazy-loading cannot move total (ADR 183). CI has read
400–500 B above local today, for this PR and for #2700 below, so the ceiling is local plus that gap
plus ~0.05%. Ambient CPU, measured with `ambient-density.mjs` (twelve seated, 8 min per arm), stayed
inside run-to-run noise: 22.1% before, 14.5% after (ADR 617 has the table).

- Falsify: `pnpm perf:check` in CI reports total JS at or under 313,000 B with this change in.

### 2026-10-15 — `totalJsGzipBytes` 312,700 → 313,000 B: a watch link takes a grade (lane `01M50XJDJ7`)

| Budget   | main (local) | main (CI)                       | After trim (local) | Ceiling                    |
| -------- | ------------ | ------------------------------- | ------------------ | -------------------------- |
| total JS | 312,339 B    | 305.4 KB (> 312,700 B, red)     | 312,290 B          | RAISED 312,700 → 313,000 B |

#2694 (ADR 616) made the `/live` share button offer a public link or a demo link at broadcast grade,
with a separate cached seat per grade and a grade label on the viewer's page. CI then read total JS at
305.4 KB, over the 312,700 B cap, and every PR that runs the perf leaf went red. Trimmed first: the two
longest tooltips (49 B). CI reads about 400 B over local on this tree, so the trim does not clear it on
its own. Lazy-loading cannot move total (ADR 183), and the ceiling was saturated by the raises below.

- Falsify: `pnpm perf:check` after a build reports total JS at or under 312,700 B with this change in.

### 2026-10-15 — `liveCssGzipBytes` 21,600 → 21,700 B: the replay age tag's rules (lane `01M50TZA8X`)

CI read live CSS at 21.1 KB, just over the 21,600 B cap, for the three rules that let an aged walk tag
ellipsize its verb and keep its age whole inside the plate's 18rem cap. Trimmed twice first: the
` · ` separator moved from `::before` into the text, and a letter-spacing reset and a redundant
`min-width` were dropped. Raised by 100 B to cover the remainder and CI's drift.

- Falsify: `pnpm perf:check` after a build reports live CSS at or under 21,600 B with this change in.

### 2026-10-15 — `totalJsGzipBytes` 312,400 → 312,700 B: a replayed walk wears its age (lane `01M50TZA8X`)

| Budget   | Before (main)   | This branch (CI, before rebase) | Ceiling                    |
| -------- | --------------- | ------------------------------- | -------------------------- |
| total JS | ≤ 304.8 KB      | 305.0 KB                        | RAISED 312,400 → 312,700 B |

Replay on open now labels each replayed walker with its age ("claiming X · 4m ago"), so a viewer does
not read old news as happening now. That is ~150–250 B gz: `replayAge`, the `at` stamp on replayed
events, `setWalkTag` in place of six direct sets, and the aged walk-tag DOM. The CSS was trimmed first:
the separator moved into the text and a letter-spacing reset was dropped. Lazy-loading cannot move total
(ADR 183), and the ceiling was saturated by the raise just below.

- Falsify: `pnpm perf:check` after a build reports total JS at or under 312,400 B with this change in.

### 2026-10-15 — `totalJsGzipBytes` 312,100 → 312,400 B: the office reads lane owners from the board (lane `01M50TZDDM`)

| Budget   | Before (main)  | This branch (CI)            | Ceiling                    |
| -------- | -------------- | --------------------------- | -------------------------- |
| total JS | ≤ 304.8 KB     | 304.9 KB (~312,150–312,250 B) | RAISED 312,100 → 312,400 B |

The deliver walk's carrier and the acceptance flourish now read each lane's owner from the board `/live`
already holds, instead of only the walks the room watched (office-liveliness spec §5). That is ~100 B gz:
a seed layer in `laneOwners.ts` and a one-map-per-board `WeakMap` in `OfficeScene.tsx`. There was nothing
to cut, lazy-loading cannot move total (ADR 183), and the ceiling was saturated by the same-day raise
above. Raised tight: CI's upper bound + ~0.05%.

- Falsify: `pnpm perf:check` after a build reports total JS at or under 312,100 B with this change in.

### 2026-10-15 — `totalJsGzipBytes` 311,700 → 312,100 B: a person glyph on human plates, and "you" (lane `01M50CD7SN`)

| Budget   | Before (main, same laptop) | This branch (laptop)  | Ceiling                    |
| -------- | -------------------------- | --------------------- | -------------------------- |
| total JS | 304.3 KB                   | 304.5 KB (~311,800 B) | RAISED 311,700 → 312,100 B |

Every human's plate showed the unknown-provider "?" because a person attests no model. It now shows a person
glyph in their own hue, and the signed-in viewer's plate and team card say "you". That is ~200 B gz: the
glyph SVG, the two tags and the `you` prop. Trimmed first: the floor ring under the viewer was cut (a
seated viewer's desk paints over it, so it bought nothing), and the SVG lost its `xmlns`/size attributes.
The ceiling was still saturated, and lazy-loading cannot move total (ADR 183). Raised tight: measured + ~0.1%.

- Falsify: `pnpm perf:check` after a build reports total JS at or under 311,700 B with this change in.

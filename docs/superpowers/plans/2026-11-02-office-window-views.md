# Office Window Views Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task, in your own seat, in the lane the increment names. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every office window looks onto one rendered panorama (city, then coast and mountain) that follows the room's clock and real weather, framed by rendered drapes, with a few slow movers outside.

**Architecture:** The shell render gets transparent panes and drapes. A new Blender script renders each exterior from two orthographic cameras (one per back wall) as land-only plates on a transparent sky, three day states each. At runtime a new `windowView.ts` paints, inside each pane's quad, a sky gradient on the continuous clock, the two nearest plates crossfaded, and a glass gradient, into the cached shell; `windowSprites.ts` draws the movers per frame on top, and the existing `drawWeather` keeps painting rain and snow over the panes.

**Tech Stack:** Blender 5.2 (`bpy`, art tool only), pngquant + cwebp, TypeScript canvas, vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-office-window-views-design.md`

## Increments

| Increment | Lane | Tasks |
| --- | --- | --- |
| 1. Shell cut + city | `01M6ENGW2H25MYV40Z2TPWBNJB` | 1–8 |
| 2. Coast and mountain | `01M6ENH3T54EPSBRM1RNZXBM9S` | 9–10 |
| 3. Chooser + polish | `01M6ENHBPBSTJJZNA21Y0NBJR4` | 11–13 |
| 4. Art-side depth (follow-up) | `01M6FKGTRH7SMW8CSXFB05T88T` | — |

## Global Constraints

- Blender is an art tool; nothing at runtime imports or depends on it (hard rule 6). Outputs are committed.
- Art set budget `officeArtBytes` (`docs/perf/budgets.json`, 8,900,000 B today, measured 8,835,072 B): every raise is logged in `docs/perf/web-live-baseline.md` in the existing entry format (ADR 151/183).
- The office clock is Los Angeles time (`pstNowHours` in `index.ts`); the day states and their 45-minute fades come from `rendered/roomState.ts` (`DAY_EDGES` 7.0 / 16.5 / 19.0, `FADE_HOURS` 0.75). Nothing new keeps time.
- Weather is the four states of `weather.ts` (`clear | cloudy | rain | snow`); `?weather=` and `?light=HH` overrides keep working on the new layer.
- Still mode (`stillMode()`, ADR 285) freezes movers; the clock still paints the right state.
- Movers are rare and slow: at most one signature mover per window at a time; nothing outside animates faster than the rain already does.
- Preferences use the `musterd.live.*` localStorage prefix with the `readPref`/`writePref` try/catch pattern from `sound.ts`.
- The spec's non-goals stand: no parallax (there is no pan), no weather plates, no per-window setting.
- Spec corrections found while planning: `?office=painted` was deleted on 2026-10-23, so there is no painted mode to preserve; there is no office menu, so the chooser lives beside `SoundToggle` in `routes/live.tsx`; `glassColor()` has no callers and is deleted; `drawWeather` (lane 01M5XS6597) is kept as the weather sprite layer, not replaced.

## Review Focus

1. A viewer whose art set predates the plates (a cached older manifest) must see a sky, not a hole: `drawWindowViews` paints the sky gradient whenever the pane is transparent, plates or not. Test in Task 5.
2. `?light=23:30` with `?weather=snow`: night sky, snow plate tint, flakes still drawn by `drawWeather`, no sun disc, stars on. Test in Task 5 and Task 6.
3. The shell cache key must change when the view changes, or a chooser pick shows the old plates until the next quarter hour. Test in Task 7 and Task 11.
4. A plate whose `view` span disagrees with the window it covers (a stale manifest from a render with different `WINDOWS`) must be skipped with the sky still painted, never stretched across the wrong quad. Test in Task 4.
5. `/broadcast` must ignore the viewer's pick and render `city`. Test in Task 11.

---

## Increment 1 — shell cut + city (lane `01M6ENGW2H25MYV40Z2TPWBNJB`)

### Task 1: Spec, plan and mockups land together

**Files:**
- Create: `docs/design/assets/window-views/window-views.html`, `docs/design/assets/window-views/window-views-v2.html` (copied from `.superpowers/brainstorm/40795-1793639903/content/`)
- Modify: `docs/superpowers/specs/2026-11-02-office-window-views-design.md` (the three corrections in Global Constraints, as a dated note under "Calls made")
- Create: `docs/superpowers/plans/2026-11-02-office-window-views.md` (this file)

- [ ] **Step 1: Copy the two mockups into `docs/design/assets/window-views/`** and point the spec's first paragraph at them.
- [ ] **Step 2: Add the dated correction note to the spec** (no painted mode; no office menu, chooser beside the sound toggle; `drawWeather` stays; `glassColor` deleted).
- [ ] **Step 3: Run `pnpm intents:check && pnpm vocab:check`.** Expected: both pass (the Increments table cites a lane per row).
- [ ] **Step 4: Commit** `docs: window views spec, plan and mockups (lane 01M6ENGW2H)`.

### Task 2: Transparent panes and drapes in the shell (`scene.py`)

**Files:**
- Modify: `packages/web/art/office/scene.py` — `wall()` (1628–1663), `LIGHT_STATES` (1669–1676), `lights()` pane retint (1719–1726)
- Modify: `packages/web/art/office/README.md` — "What is rendered" shell bullet

**Interfaces:**
- Produces: `WINDOW_PANE_ALPHA = 0.0`; a new material helper `clear_glass(name) -> Material` (Principled, alpha 0, blend mode `BLEND`, no emission); `drapes(asset_id, which, zs, col) -> list[Object]` adding, per window and wall, `{asset_id}/win{i}-rod`, `-drape-l`, `-drape-r` (two tied-back panels on the wall *beside* the frame, never over the `WINDOWS` pane span; terracotta `srgb("#c76b45")` cloth, rod `srgb("#5a4a38")`); `WINDOW_RECTS = [(which, t0, t1, u0, u1) ...]` exported for `exterior.py`.

- [ ] **Step 1: Replace the pane glow.** In `wall()`, `pane = clear_glass("window-pane")`; keep the frame, mullions and sill pieces. Delete the `pane=` entries from `LIGHT_STATES` and the retint block in `lights()`; keep `window=` (the floor spots) untouched.
- [ ] **Step 2: Add `drapes()`** and call it from `wall()` after the window loop so the panels are part of the shell (`o["shell"] = True` is set by `build_scene` on the wall object; the drapes are parented into the same `finish()` call's parts list).
- [ ] **Step 3: Render the shell only:**
  ```sh
  /Applications/Blender.app/Contents/MacOS/Blender -b --python packages/web/art/office/render.py -- \
    --out packages/web/src/live/office-scene/rendered/assets --scale 3 --ky 0.31 \
    --only room/light-day,room/light-evening,room/light-night,room/ceiling-on,room/ceiling-spill
  ```
  Expected: five `office-art-room-*.webp` rewritten; opening `office-art-room-light-day.webp` shows the panes as transparent holes with drapes beside each frame.
- [ ] **Step 4: Save the scene for inspection** (`--save /tmp/office.blend`) and check in the UI that no drape panel overlaps a pane. Fix offsets until true.
- [ ] **Step 5: Update the README bullet** (shell now has transparent panes and drapes; the glow moved outside).
- [ ] **Step 6: Commit** `art(office): transparent panes and drapes in the shell (lane 01M6ENGW2H)`.

### Task 3: The city exterior, two cameras (`exterior.py`, `render.py`)

**Files:**
- Create: `packages/web/art/office/exterior.py`
- Modify: `packages/web/art/office/render.py` — `args()` (37–79), `main()` family listing (870–900), `record()` (849–865)
- Modify: `packages/web/art/office/README.md` — new section "The outside"

**Interfaces:**
- Produces, in `exterior.py`: `SETTINGS = ("city", "coast", "mountain")`; `build_exterior(setting: str, which: int) -> list[Object]` (the land meshes for one wall's view: for `city`, a far row and a near row of boxes with varied heights, flat roofs, no sun disc, nothing emissive but a few window quads tagged `lit` that only emit in the `night` state); `exterior_camera(which: int, t0: float, t1: float, u0: float, u1: float, px_per_unit: float) -> Object` (ORTHO, looking out through wall `which` along its normal, framed to exactly the pane span `[t0,t1]×[u0,u1]` plus a 4% margin, so one plate per window); `exterior_lights(state: str)` reusing `scene.LIGHT_STATES[state]["sun"]`, `fill`, `world` with the same rotation as `scene.lights`.
- Produces, in `render.py`: flag `--exterior city[,coast,...]`; asset ids `view/<setting>/<which>-<i>-<state>` (e.g. `view/city/0-1-evening`); each manifest entry gains `"view": {"which": 0, "t0": 0.28, "t1": 0.46, "u0": 0.34, "u1": 0.82}`; plates rendered with film transparent, no `SHELL_DOWNSAMPLE`, through `quantize` and `to_webp` like everything else.

- [ ] **Step 1: Write `exterior.py`** with the three functions above. The city: 14 far boxes (`srgb("#9aa3b4")`, depth 300–600 units behind the wall), 7 near boxes (`srgb("#5a6070")`, depth 80–200), every box a cube scaled `(w, d, h)` with `h` from a fixed list so the skyline is deterministic; `lit` window quads as small planes with a `glow` material whose strength is 0 except in `night` (2.0, `#ffd27a`).
- [ ] **Step 2: Wire `--exterior`** in `args()` and in `main()`: for each setting, each wall `which in (0,1)`, each window `i`, each state: build, light, camera, `render_alone(objs, path, export)`, `record(id, path, origin=None, down=1)` with the `view` dict; `record` writes `anchor` as `{x: 0, y: 0}` when `origin is None`.
- [ ] **Step 3: Render the city:**
  ```sh
  /Applications/Blender.app/Contents/MacOS/Blender -b --python packages/web/art/office/render.py -- \
    --out packages/web/src/live/office-scene/rendered/assets --scale 3 --ky 0.31 --exterior city
  ```
  Expected: 12 new `office-art-view-city-*.webp` (2 walls × 2 windows × 3 states), each ≤ 40 KB, transparent sky, lit faces toward the sun; `manifest.json` lists them with `view` spans.
- [ ] **Step 4: Sum the set:** `du -ck packages/web/src/live/office-scene/rendered/assets/*.webp | tail -1`. Expected: under 8,900,000 B still, or note the number for Task 8.
- [ ] **Step 5: README section "The outside"** (what `exterior.py` is, the two cameras, the asset id and `view` span, the command).
- [ ] **Step 6: Commit** `art(office): city exterior plates from two cameras (lane 01M6ENGW2H)`.

### Task 4: Manifest carries the view span (`manifest.ts`)

**Files:**
- Modify: `packages/web/src/live/office-scene/rendered/manifest.ts` — `RenderedAsset`, `parseAsset`
- Test: `packages/web/src/live/office-scene/rendered/manifest.test.ts`

**Interfaces:**
- Produces: `interface ViewSpan { which: 0 | 1; t0: number; t1: number; u0: number; u1: number }`; `RenderedAsset.view?: ViewSpan`; `export function viewPlates(m: RenderedManifest, setting: string, which: 0 | 1, i: number): Partial<Record<DayState, RenderedAsset>>` returning the plates whose id is `view/${setting}/${which}-${i}-${state}` **and** whose `view` span matches `WINDOWS[i]` (from `layout.ts`) within 1e-3 on all four numbers; a mismatched plate is left out.

- [ ] **Step 1: Write the failing tests:** `parseManifest keeps a view span and drops a malformed one` (span with a string `t0` → asset parsed without `view`); `viewPlates returns only plates whose span matches the window` (one plate with `t0` off by 0.1 is excluded, the other two states returned).
- [ ] **Step 2: Run** `pnpm --filter @musterd/web exec vitest run src/live/office-scene/rendered/manifest.test.ts`. Expected: FAIL, `viewPlates` not exported.
- [ ] **Step 3: Implement** the optional `view` parse and `viewPlates`.
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Commit** `web(office): manifest carries a plate's view span (lane 01M6ENGW2H)`.

### Task 5: The pane painter (`windowView.ts`)

**Files:**
- Create: `packages/web/src/live/office-scene/windowView.ts`
- Test: `packages/web/src/live/office-scene/windowView.test.ts`
- Modify: `packages/web/src/live/office-scene/render.ts` — delete `glassColor` (372–379); call the painter from the `shell` closure (4595–4616) between `drawGroundShadow` and the `room/light-*` blits; add `view: ViewSetting` to `RenderOpts` (2043) and to `backgroundKey` (4486)
- Test: `packages/web/src/live/office-scene/render.test.ts` — no `glassColor` test exists; add the Review Focus 1 and 2 tests here as a `describe('window views (lane 01M6ENGW2H)')`

**Interfaces:**
- Consumes: `roomMixFor(env)`, `dayOf`, `WALL_EDGES`, `wallPt(edge, t, u, fit)`, `WINDOWS` from `layout.ts`, `viewPlates` (Task 4), `LightEnv` (`daylight`, `skyTint`, `hours`), `Weather`.
- Produces: `export type ViewSetting = 'city' | 'coast' | 'mountain'`; `export const DEFAULT_VIEW: ViewSetting = 'city'`; `export function skyStops(hours: number, weather: Weather): [top: string, bottom: string]` (pure; the mockup's colour keyframes at 0, 5, 6.5, 8, 12, 16, 18, 19.5, 21, 24 h, `cloudy` desaturates 40% and darkens 15%, `rain` 30% darker, `snow` 20% paler and bluer); `export function plateTint(weather: Weather): { brightness: number; saturate: number }`; `export function paneQuad(fit, which: 0 | 1, i: number): [Pt, Pt, Pt, Pt]`; `export function drawWindowViews(ctx, fit, env: LightEnv, art: RenderedAssets, weather: Weather, view: ViewSetting): void` — per wall, per window: `save`, clip to `paneQuad`, fill the sky gradient (`skyStops(env.hours, weather)` top-to-bottom of the quad), blit `viewPlates(...)[dayOf(mix.from)]` with `setTransform` mapping the plate's pixel rect onto the quad, then `[dayOf(mix.to)]` at `mix.mix` when `> 0`, with `ctx.filter` from `plateTint` (skip the filter where unsupported), then the glass: a diagonal white gradient at alpha 0.06, `restore`.

- [ ] **Step 1: Write the failing tests** in `windowView.test.ts`: `skyStops is night at 23.5 and day at 12` (exact colours from the keyframes); `skyStops under snow is paler than clear at noon`; `plateTint maps the four weathers`; `drawWindowViews with no plates still clips and fills each pane` (a recording 2D context stub, count `clip` = 4 and `fillRect`/`fill` ≥ 4, `drawImage` = 0); `drawWindowViews with plates draws from and to at the fade` (env hours 16.75 → two `drawImage` per pane, second with `globalAlpha` 1/3).
- [ ] **Step 2: Run** `pnpm --filter @musterd/web exec vitest run src/live/office-scene/windowView.test.ts`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement `windowView.ts`.**
- [ ] **Step 4: Wire `render.ts`:** delete `glassColor`; in the `shell` closure call `drawWindowViews(c, fit, env, rendered, opts.weather ?? 'clear', opts.view ?? DEFAULT_VIEW)` before the first `blitIf(room/light-…)`; add `opts.view` to `backgroundKey`'s string.
- [ ] **Step 5: Add the two Review Focus tests** in `render.test.ts` (`a viewer without plates sees a sky, not a hole`; `?light=23:30 + snow: night stops, no sun, flakes still drawn`), run both files. Expected: PASS.
- [ ] **Step 6: Run** `pnpm --filter @musterd/web exec vitest run src/live/office-scene/render.test.ts`. Expected: PASS (sun pools, wall fixtures and weather tests unchanged).
- [ ] **Step 7: Commit** `web(office): panes paint a sky and the city plates on the clock (lane 01M6ENGW2H)`.

### Task 6: Movers (`windowSprites.ts`)

**Files:**
- Create: `packages/web/src/live/office-scene/windowSprites.ts`
- Test: `packages/web/src/live/office-scene/windowSprites.test.ts`
- Modify: `packages/web/src/live/office-scene/render.ts` — in the frame, after the shell blit and before `drawWalls`, `run(() => drawMovers(ctx, fit, movers))`

**Interfaces:**
- Consumes: `roll(team, slot, purpose)` and `slotAt` from `ambientSeed.ts`; `paneQuad` (Task 5); `LightEnv`; `Weather`.
- Produces: `export interface Mover { kind: 'cloud' | 'sun' | 'moon' | 'star' | 'tram' | 'plane'; which: 0 | 1; i: number; x: number; y: number; s: number; alpha: number }` (`x`, `y` in pane space 0–1); `export function moversAt(view: ViewSetting, nowMs: number, env: LightEnv, weather: Weather, team: string): Mover[]` — pure. Clouds: two per pane, drifting at 1/140 pane-widths per second, phase from `roll(team, 0, 'cloud-${which}-${i}-${n}')`; sun at `x = (hours-6)/13`, `y = 0.44 - sin(π·x)·0.36`, only 6–19 h; moon mirrored 19–6 h; stars 8 fixed points at alpha `1 - daylight`; `tram` (city only, wall 0 only): a 26 s crossing starting when `roll(team, slotAt(nowMs, 180_000), 'tram') < 0.35`; `plane` (city only): a 48 s crossing at `y = 0.16` when `roll(team, slotAt(nowMs, 300_000), 'plane') < 0.25` and `env.daylight < 0.5`. Under `rain` or `snow`: no plane, no sun. `export function drawMovers(ctx, fit, movers: Mover[]): void` — per mover, clip to its pane quad and draw a canvas primitive (ellipses for clouds, a disc with a radial glow for the sun, a disc for the moon, 1 px squares for stars, a 5×1.2 pane-% rounded rect for the tram, a 2.5×0.4 bar with a fading tail for the plane). `export function moversMove(movers): boolean`.

- [ ] **Step 1: Write the failing tests:** `the sun rises at 6 and sets at 19` (none at 5.5, one at 12 at `x≈0.46`, none at 19.5); `stars are out at night only`; `a tram is deterministic per team and slot` (same inputs → same `x`; a different team → may differ, assert equality on two calls); `no plane in rain`; `coast and mountain have no tram`.
- [ ] **Step 2: Run** the test file. Expected: FAIL.
- [ ] **Step 3: Implement** `windowSprites.ts`.
- [ ] **Step 4: Wire `render.ts`:** compute `movers` once per frame from `opts.view`, `t`-derived `nowMs` (the loop's `now`), `env`, `opts.weather`, `teamName`; draw after the shell blit. Under `STILL` pass `nowMs = 0` so nothing moves.
- [ ] **Step 5: Run** both test files and `render.test.ts`. Expected: PASS.
- [ ] **Step 6: Commit** `web(office): clouds, sun and moon, stars, a tram and a plane outside (lane 01M6ENGW2H)`.

### Task 7: The scene loop knows the view (`index.ts`)

**Files:**
- Modify: `packages/web/src/live/office-scene/index.ts` — beside `weatherPinned` (888–904): `viewPinned`; `renderScene` opts at 1278 and 2454: `view`; the awake check at 2700: `|| moversMove(movers)`
- Modify: `packages/web/src/live/office-scene/windowView.ts` — `export function viewOverride(search: string): ViewSetting | null` (`?view=city|coast|mountain`, same shape as `weatherOverride`)
- Test: `packages/web/src/live/office-scene/windowView.test.ts`

- [ ] **Step 1: Write the failing test:** `viewOverride reads ?view= and ignores junk`.
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Implement `viewOverride`** and wire `index.ts`: `const view: ViewSetting = viewOverride(window.location.search) ?? DEFAULT_VIEW`, passed in both `renderScene` opts; keep the loop awake while movers move unless `STILL`.
- [ ] **Step 4: Run** the test and `pnpm --filter @musterd/web exec vitest run src/live/office-scene`. Expected: PASS.
- [ ] **Step 5: Eyeball:** `pnpm dev`, open `http://localhost:5174/live?team=revive&light=12`, `&light=18`, `&light=23&weather=snow`. Expected: sky and city through every pane, drapes beside the frames, sun by day, stars and lit windows at night, flakes over the panes under snow. Screenshot each for the PR.
- [ ] **Step 6: Commit** `web(office): ?view= override; the loop stays awake for movers (lane 01M6ENGW2H)`.

### Task 8: Budgets, docs, ship

**Files:**
- Modify: `docs/perf/budgets.json` (`officeArtBytes` + `$comment`), `docs/perf/web-live-baseline.md` (new entry in the existing office-art format)
- Modify: `docs/architecture/08-web.md` — `office-scene/` tree lines for `windowView.ts`, `windowSprites.ts`; the Choreography row (line ~276) and the Office paragraph (line ~80). **Held by slippy and wallow under block posture (ADR 691):** if the edit is refused, ship without it if `arch-trees:check` passes, else ask one holder to hand the file off.

- [ ] **Step 1: `pnpm -r build && node scripts/perf/check-budgets.ts`.** Read the office art number; raise `officeArtBytes` to measured + 5% rounded up to 10,000, log it in both files.
- [ ] **Step 2: Fast gates** `pnpm typecheck && pnpm lint && pnpm format:check`. Expected: green.
- [ ] **Step 3: PR** with `Lane \`01M6ENGW2H25MYV40Z2TPWBNJB\`.` in the body and the three screenshots; `gh pr merge --squash --auto --delete-branch`; waiter; `lane_submit`; clear the local branch.

## Increment 2 — coast and mountain (lane `01M6ENH3T54EPSBRM1RNZXBM9S`)

### Task 9: Two more exteriors

**Files:**
- Modify: `packages/web/art/office/exterior.py` — `build_exterior` for `coast` (a sea plane `srgb("#3f8fa3")`, a far headland, a beach strip, a lighthouse column with a `lit` lantern) and `mountain` (three ridges as extruded polylines, snow caps as white planes above a height, a cabin box with `lit` window quads)
- Modify: `docs/perf/budgets.json`, `docs/perf/web-live-baseline.md`

- [ ] **Step 1: Build both scenes; render** `--exterior coast,mountain`. Expected: 24 more plates, each ≤ 40 KB.
- [ ] **Step 2: Eyeball** with `?view=coast` and `?view=mountain` at 12, 18, 23 h.
- [ ] **Step 3: Raise and log the budget;** fast gates; commit `art(office): coast and mountain exteriors (lane 01M6ENH3T5)`.

### Task 10: Their movers

**Files:**
- Modify: `packages/web/src/live/office-scene/windowSprites.ts`, `.test.ts`

**Interfaces:**
- Produces: `Mover.kind` gains `'boat' | 'gull' | 'beacon' | 'hawk' | 'cabin'`. `boat` (coast): a 90 s crossing at `y = 0.62` when `roll(team, slotAt(now, 240_000), 'boat') < 0.4`; `gull`: two, 11 s arcs, day only, clear only; `beacon` (coast, night): a 0.3 s flash every 4 s at the lighthouse's pane position; `hawk` (mountain): a 40 s circle, day only; `cabin` (mountain, night): a steady glow at the cabin's pane position.

- [ ] **Step 1: Failing tests:** `the beacon flashes at night only`; `no gulls in rain`; `the hawk circles by day`.
- [ ] **Step 2–4:** implement, run, pass.
- [ ] **Step 5: PR, merge, submit** as Task 8 step 3 with lane `01M6ENH3T54EPSBRM1RNZXBM9S`.

## Increment 3 — chooser + polish (lane `01M6ENHBPBSTJJZNA21Y0NBJR4`)

### Task 11: The chooser

**Files:**
- Create: `packages/web/src/live/viewPref.ts` — `readViewPref(): ViewSetting | null`, `writeViewPref(v: ViewSetting): void` on key `musterd.live.view`, try/catch like `sound.ts`
- Create: `packages/web/src/live/ViewToggle.tsx` — one button beside `SoundToggle` in `routes/live.tsx` (~1168) cycling City → Coast → Mountain, label `Outside: City`, same classes as the sound toggle
- Modify: `packages/web/src/live/office-scene/index.ts` — `OfficeOptions.view?: ViewSetting`; `OfficeHandle.setView(v: ViewSetting): void` which updates the renderer's `view` and invalidates the shell cache
- Modify: `packages/web/src/live/OfficeScene.tsx` — passes the pref and forwards changes; `/broadcast` passes `view: 'city'` always
- Test: `packages/web/src/live/viewPref.test.ts`, `packages/web/src/live/ViewToggle.render.test.ts`, `office-scene/windowView.test.ts` (cache key changes with the view)

- [ ] **Step 1: Failing tests:** `the pref round-trips and survives a throwing localStorage`; `the toggle cycles and writes`; `backgroundKey differs by view`; `broadcast ignores the pref`.
- [ ] **Steps 2–4:** implement, run, pass. Precedence: `?view=` > pref > `city`.
- [ ] **Step 5: Commit** `live: Outside chooser — city, coast, mountain (lane 01M6ENHBPB)`.

### Task 12: Lamp reflection at night

**Files:**
- Modify: `windowView.ts` — after the glass gradient, when `env.daylight < 0.5`, two soft radial highlights (`rgba(255,220,160, 0.10·(1-daylight))`) at pane-space (0.28, 0.70) and (0.74, 0.64)
- Test: `windowView.test.ts` — `the lamp reflection appears after dusk only`

- [ ] Steps: failing test, run, implement, pass, commit `web(office): the glass reflects the lamps at night (lane 01M6ENHBPB)`.

### Task 13: Close the goal

- [ ] **Step 1:** Spec `Status:` → `built 2026-MM-DD`; a dated note listing the three lanes.
- [ ] **Step 2:** `08-web.md` Office paragraph and Choreography row, if the hold has lifted.
- [ ] **Step 3:** PR, merge, submit; `team_goal_outcome office-window-views`.

# Office Realism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, in your own seat, one lane per increment (§Increments). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-make the /live and /broadcast office as a pre-rendered, realistic, cozy room with believable sprite figures, at today's panel size and no higher per-frame cost on the broadcast.

**Architecture:** A Blender scene and a Python render script produce PNG layers (room, furniture, per-desk overlays, light states) and figure sprite sheets plus a JSON manifest; a new `office-scene/rendered/` module loads them and blits them through the existing depth sort and sprite cache, behind `?office=rendered`, while the actor state machine, layout and nav stay untouched. The camera stays orthographic with new corner constants. When the rendered path reaches parity the flag and the painters go.

**Tech Stack:** TypeScript, Canvas 2D, Vite asset imports (`?url`), vitest with the recording context (`render.test.ts`), Blender 4.x + Python with a free isometric-render add-on, Mixamo auto-rig + clips via the Mixamo Rig 5 add-on (art tools only, not runtime dependencies; research 2026-10-20 in the PR #3034 thread), `scripts/perf/check-budgets.ts`, `scripts/perf/scene-pixel-check.mjs`, `scripts/perf/broadcast-baseline.mjs`.

**Spec:** `docs/superpowers/specs/2026-10-20-office-realism-design.md`

## Global Constraints

- Figures are about **five heads tall**, slight waist, real pelvis and seat, two arms and two legs, structured face, matte materials, no line work (spec §2.1).
- **Corner view, orthographic**, camera "a touch lower than today"; the full 900×900 floor always fits the panel; the panel keeps its size on /live and /broadcast (spec §2.2).
- **The layout does not change**: `layout.ts` positions, nav, seating, arrivals and their tests stay as they are (spec §2.3).
- **No new runtime dependency.** Blender is a tool; only images ship (spec §3.4, hard rule 6).
- **No `backdrop-filter`, no per-frame blur**; dirty-rect repaint (ADR 625), hidden-tab pause and collapsed-panel suspend stay (spec §5).
- **JS budgets must not rise** for this work; a new `officeArtBytes` budget is added and set from measurement +15% (spec §5, ADR 151/183); every raise is logged in `docs/perf/web-live-baseline.md`.
- Art is rendered at **2×** (sharp for the 1080p broadcast panel at DPR 1 and /live at DPR 2) (spec §5).
- `appearance.ts` stays the source of truth for identity; agents keep the visor and their non-human skin tints (spec §3.2).
- Nothing the office does today is lost before the flag comes off: ~21 gestures, carried props, board reach, wave, per-desk live state (spec §3.1 item 5, §3.2).
- Original art only; no game's assets, palettes or designs (spec §5).
- Commits carry the seat trailer; each increment is one lane and one squash-merged PR whose body opens with `Lane \`<id>\`.`

## Review Focus

1. **An asset fails to load** (404, blocked, slow network): the room must still paint — the painted scene, or the rendered layers that did arrive — never a blank panel or a thrown frame. Pinned in Task 3 (`loadRenderedAssets` resolves with `missing` listed; `renderScene` falls back per item).
2. **A member whose appearance maps to a layer the sheets don't have** (a new `HairStyle`, `Hat` or `Accessory` added later): the figure must draw with the base layers, not vanish. Pinned in Task 11.
3. **The lighting clock crosses a state boundary mid-frame** (e.g. 17:59 → 18:00, or `?light=` override): the crossfade must be continuous (no pop) and the mix must be 0 or 1 outside the fade window. Pinned in Task 8.
4. **A figure at the seam between facing directions** (heading exactly 22.5° from a cardinal) must not flicker between two sheets frame to frame. Pinned in Task 10 (hysteresis).
5. **The broadcast at 1080p30 with the full team on the floor**: per-frame draw time must be no higher than today's; a regression here is a decline. Pinned in Task 20 (the A/B baseline run is the test).

---

## File structure

**Art (tool inputs, committed):**
- `packages/web/art/office/README.md` — how to install Blender, render, and what each output is.
- `packages/web/art/office/scene.blend` — the room: floor, walls, every furniture item from `layout.ts` as a named object, the orthographic corner camera, three light rigs (day / evening / night) and two ceiling rigs (on / spill).
- `packages/web/art/office/figure.blend` — the rigged character, actions per animation, identity layers as collections.
- `packages/web/art/office/render.py` — `blender -b scene.blend -P render.py -- --out <dir>`: renders every layer and sheet, writes `manifest.json`.

**Runtime (shipped):**
- `packages/web/src/live/office-scene/rendered/assets/` — the PNGs and `manifest.json` the script writes (build inputs; Vite hashes and serves them).
- `packages/web/src/live/office-scene/rendered/manifest.ts` — manifest types and the parser.
- `packages/web/src/live/office-scene/rendered/assets.ts` — flag reader, loader, the in-memory asset table.
- `packages/web/src/live/office-scene/rendered/blit.ts` — one function that draws an asset at a floor position through `project()`.
- `packages/web/src/live/office-scene/rendered/roomState.ts` — light-state selection and crossfade from `LightEnv`.
- `packages/web/src/live/office-scene/rendered/figureSheet.ts` — direction and frame selection for a sprite sheet.
- `packages/web/src/live/office-scene/rendered/tint.ts` — tinted identity layers, cached.
- `packages/web/src/live/office-scene/rendered/figure.ts` — composes a member's layers for one frame.
- Modified: `iso.ts` (camera constants), `render.ts` (item painters consult the rendered path), `character.ts` (frame pick), `index.ts` (flag → camera + assets), `lighting.ts` (unchanged API; `roomState.ts` consumes it).
- `scripts/perf/check-budgets.ts` + `docs/perf/budgets.json` — `officeArtBytes`.

---

## Increment 1 — pipeline (lane `01M5D8F3RNW6AXVXSR76FG24KK`)

### Task 1: The manifest contract

**Files:**
- Create: `packages/web/src/live/office-scene/rendered/manifest.ts`
- Test: `packages/web/src/live/office-scene/rendered/manifest.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RenderedAsset {
    id: string;            // e.g. 'desk/base', 'room/floor', 'desk/lamp-on'
    file: string;          // basename, e.g. 'office-desk-base.png'
    w: number; h: number;  // source px (2×)
    anchor: { x: number; y: number }; // px in the source where the asset's floor point sits
    scale: number;         // source px per floor unit at 2× (same for every asset in one render)
  }
  export interface RenderedManifest { version: 1; camera: { kx: number; ky: number }; assets: RenderedAsset[] }
  export function parseManifest(json: unknown): RenderedManifest; // throws on shape errors
  export function assetById(m: RenderedManifest, id: string): RenderedAsset | undefined;
  ```

- [ ] **Step 1: Write the failing test** — `parseManifest` accepts a one-asset manifest and returns it typed; rejects `version: 2`; rejects an asset missing `anchor`; `assetById` finds by id and returns undefined otherwise.
- [ ] **Step 2: Run** `pnpm --filter @musterd/web exec vitest run src/live/office-scene/rendered/manifest.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement** `parseManifest` with a hand-written shape check (no zod in the web package today; keep it that way) and `assetById`.
- [ ] **Step 4: Run the test** — PASS.
- [ ] **Step 5: Commit** `feat(office): rendered-asset manifest contract (lane 01M5D8F3RN)`.

### Task 2: The flag and the loader

**Files:**
- Create: `packages/web/src/live/office-scene/rendered/assets.ts`
- Test: `packages/web/src/live/office-scene/rendered/assets.test.ts`
- Modify: `packages/web/src/live/office-scene/index.ts` (next to `lightOverrideHours`, ~line 217)

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
  ```ts
  export function renderedOfficeFromSearch(search: string): boolean; // '?office=rendered'
  export interface RenderedAssets { manifest: RenderedManifest; images: Map<string, CanvasImageSource>; missing: string[] }
  export function loadRenderedAssets(
    manifest: RenderedManifest,
    urlFor: (file: string) => string,
    loadImage?: (url: string) => Promise<CanvasImageSource>,
  ): Promise<RenderedAssets>; // never rejects; a failed image lands in `missing`
  ```
- `index.ts`: `createOfficeScene` options gain `rendered?: RenderedAssets | undefined`; when the flag is on, `index.ts` loads the manifest (`import manifestJson from './rendered/assets/manifest.json'` + `import.meta.glob('./rendered/assets/*.png', { eager: true, query: '?url', import: 'default' })`) and passes the result in; until it resolves the painted scene draws.

- [ ] **Step 1: Write the failing tests** — `renderedOfficeFromSearch('?office=rendered')` true, `''` false, `'?office=painted'` false; `loadRenderedAssets` with a stub `loadImage` that rejects for `'office-desk-lamp.png'` resolves with that file in `missing` and the others in `images`.
- [ ] **Step 2: Run** the test file — FAIL.
- [ ] **Step 3: Implement** both functions; `loadImage` default uses `new Image()` + `decode()`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Wire** `index.ts`: read the flag once at scene creation; load assets asynchronously; store on the scene; a `?office=rendered` without a manifest file present logs one `console.warn` and stays painted.
- [ ] **Step 6: Run** `pnpm --filter @musterd/web exec vitest run src/live/office-scene` — all green (nothing paints differently yet).
- [ ] **Step 7: Commit** `feat(office): ?office=rendered flag and asset loader (lane 01M5D8F3RN)`.

### Task 3: Blit one asset through the depth sort

**Files:**
- Create: `packages/web/src/live/office-scene/rendered/blit.ts`
- Test: `packages/web/src/live/office-scene/rendered/blit.test.ts`
- Modify: `packages/web/src/live/office-scene/render.ts` — `drawWorkstation` (line ~4245) and `RenderOpts` (line ~2100)

**Interfaces:**
- Consumes: `project(lx, ly, fit)` from `iso.ts`; `RenderedAsset`, `RenderedAssets`.
- Produces:
  ```ts
  export function blitAsset(ctx: CanvasRenderingContext2D, fit: Fit, a: RenderedAsset, img: CanvasImageSource, lx: number, ly: number, alpha = 1): void;
  // draws img so that its anchor lands on project(lx, ly, fit); size = (w, h) * fit.scale / a.scale
  ```
- `RenderOpts` gains `rendered?: RenderedAssets | undefined`. In `drawWorkstation`, when `opts.rendered` has `desk/base`, the slab + legs painter is replaced by one `blitAsset`; everything else (monitor, props, screen life) paints as today on top. The depth value and the sprite-cache part key are unchanged.

- [ ] **Step 1: Write the failing test** (recording context, as `render.test.ts` does): `blitAsset` emits exactly one `drawImage` with dx/dy = projected point minus anchor×(fit.scale/a.scale) and dw/dh = w,h×(fit.scale/a.scale); alpha sets and restores `globalAlpha`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `blitAsset`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Write the failing render test** — `renderScene` with `rendered` containing only `desk/base` emits a `drawImage` inside each desk's sprite part and no slab `fillRect`/`fill` for the slab path; without `rendered` the op list is byte-identical to today's (the existing snapshot).
- [ ] **Step 6: Implement** the branch in `drawWorkstation`; keep `phase` semantics (`'pre'` is where the slab lives).
- [ ] **Step 7: Run** `vitest run src/live/office-scene/render.test.ts` — PASS, including every existing test.
- [ ] **Step 8: Commit** `feat(office): a rendered desk base blits through the depth sort (lane 01M5D8F3RN)`.

### Task 4: The Blender pipeline, the first render, the byte budget

**Files:**
- Create: `packages/web/art/office/README.md`, `packages/web/art/office/scene.blend`, `packages/web/art/office/render.py`
- Create: `packages/web/src/live/office-scene/rendered/assets/manifest.json`, `…/assets/office-desk-base.png`
- Modify: `scripts/perf/check-budgets.ts` (after the font block, ~line 212), `docs/perf/budgets.json`, `docs/perf/web-live-baseline.md`, `docs/architecture/08-web.md`, `.gitattributes`

**Interfaces:**
- `render.py` CLI: `blender -b scene.blend -P render.py -- --out packages/web/src/live/office-scene/rendered/assets --scale 2`. It renders every object in the `export` collection to `office-<id with / → ->.png` with an alpha background and writes `manifest.json` (Task 1 shape). The camera is orthographic with `kx`,`ky` written into the manifest from the camera's rotation.
- `check-budgets.ts`: sums bytes of `dist/client/assets/office-*.png` and `office-*.webp`; fails over `budgets.officeArtBytes`; the failure text names the remedy ("cut directions/frames or raise officeArtBytes deliberately, logged in web-live-baseline.md").

- [ ] **Step 1: Install Blender** (`brew install --cask blender`); record the version in the README. This is the operator's machine, not CI; CI never renders.
- [ ] **Step 2: Model one desk** in `scene.blend` at `DESK_W × DESK_D × DESK_UP` floor units (100 × 68 × 36), matte oak, with the camera set so that one floor unit along `lx` projects to `KX_CORNER` px and along `ly` to `KY_CORNER` px at scale 1 (values from Task 5; for this increment use today's `KX = 0.70710678`, `KY = 0.35355339` so the blit lines up with the painted room).
- [ ] **Step 3: Evaluate the free omnidirectional isometric render add-on** (itch.io, April 2025; packs sheets via Pillow) and the open-source Blender-Isometric-Renderer script for the direction renders. Keep whichever renders 8 directions headlessly from `render.py`; script only what neither does (the room layers, the manifest). Record the choice and the add-on version in the README.
- [ ] **Step 4: Write `render.py`**: iterate the `export` collection, isolate each object, render to PNG with film transparent, compute the anchor as the projected floor-point of the object's origin, write the manifest.
- [ ] **Step 5: Render** and commit the outputs; add `packages/web/src/live/office-scene/rendered/assets/*.png binary` to `.gitattributes`.
- [ ] **Step 6: Write the failing budget check** — a unit test is not practical for this script; instead set `officeArtBytes: 1` in `budgets.json`, run `pnpm --filter @musterd/web build && pnpm perf:check`, expect the new failure line naming the desk PNG.
- [ ] **Step 7: Implement** the check; set `officeArtBytes` to measured + 15%; log the measurement in `web-live-baseline.md` under a dated heading with the lane id.
- [ ] **Step 8: Verify in the browser**: `pnpm dev` → `http://localhost:5174/office-preview?office=rendered` shows the rendered desk base under every desk's painted monitor and props, aligned to the painted room; without the flag nothing changes. Capture both for the PR.
- [ ] **Step 9: Docs**: `08-web.md`'s office-scene file tree gains the `rendered/` lines and `art/office/` is described (the arch-tree check fails otherwise).
- [ ] **Step 10: Run the fast gates** `pnpm typecheck && pnpm lint && pnpm format:check`; commit `feat(office): Blender pipeline, first rendered desk, officeArtBytes budget (lane 01M5D8F3RN)`; open the PR; `lane_submit` after merge.

---

## Increment 2 — the room (lane `01M5D8F7FTXT07SSGPPYGX9JV8`)

### Task 5: The corner camera, behind the flag

**Files:**
- Modify: `packages/web/src/live/office-scene/iso.ts` (`KX`, `KY`, `Fit`, `project`, `fitBox`), `index.ts` (where `fit` is computed)
- Test: `packages/web/src/live/office-scene/iso.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Camera { kx: number; ky: number }
  export const ISO_CAMERA: Camera = { kx: 0.70710678, ky: 0.35355339 };
  export const CORNER_CAMERA: Camera = { kx: 0.62, ky: 0.40 }; // spec §2.2; the builder tunes ky within [0.38, 0.44] against the render
  export interface Fit { ox: number; oy: number; scale: number; cam?: Camera } // cam defaults to ISO_CAMERA
  ```
  `project` and `depth` read `fit.cam ?? ISO_CAMERA`; `fitBox` takes the camera to size the diamond. `plateLayout.ts` and `hoursAnchor`/`boardAnchor` already go through `project`, so they follow.

- [ ] **Step 1: Write the failing tests** — `project(900, 0, fitWith(CORNER_CAMERA))` lands at `ox + 900*0.62*scale`; a `Fit` without `cam` projects exactly as before (existing numbers); `fitBox` with the corner camera keeps the whole floor inside the panel at `(1100, 640)` and `(1920, 1080)`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; `index.ts` passes `cam: CORNER_CAMERA` only when the flag is on.
- [ ] **Step 4: Run** `vitest run src/live/office-scene` — PASS; the painted path's snapshots are unchanged.
- [ ] **Step 5: Commit** `feat(office): orthographic corner camera behind ?office=rendered (lane 01M5D8F7FT)`.

### Task 6: Walls, floor and every static item rendered

**Files:**
- Modify: `packages/web/art/office/scene.blend`, `render.py`
- Modify: `render.ts` — `drawFloor`, `drawWalls`, `drawRug`, `drawPlant`, `bookshelf`, `drawEntrance`, the nook/lounge/reception painters, `drawWorkstation`
- Test: `render.test.ts`

**Interfaces:**
- Asset ids (one per depth slot the painters already use): `room/floor`, `room/wall-left`, `room/wall-right`, `room/skirting`, `desk/base`, `desk/monitor-off`, `bench/base`, `rug/<podId>`, `plant/<species>`, `shelf/<index>`, `entrance`, `nook/counter`, `nook/fridge`, `nook/machine`, `lounge/couch`, `lounge/table`, `reception/desk`, `board/frame`, `clock/frame`, `calendar/frame`.
- Each painter keeps its signature and its depth; when `opts.rendered` has the id it blits instead of painting; the live parts (screen face, clock numerals, calendar days, board content) still paint on top.

- [ ] **Step 1: Model the room** in Blender from `layout.ts` numbers (desks, pods, bench, window desks, nook, lounge, reception, plants) with the agreed materials (spec §2.3); windows on the left wall; board, clock and calendar frames on the right.
- [ ] **Step 2: Render** at 2×; commit assets; `perf:check` passes or the raise is logged.
- [ ] **Step 3: Write the failing render test** — with a full manifest every static item emits one `drawImage` and no painter fill ops; with none, byte-identical to today.
- [ ] **Step 4: Implement** the per-painter branches.
- [ ] **Step 5: Run** — PASS. Browser check at `/office-preview?office=rendered` at 1100×640 and 1920×1080.
- [ ] **Step 6: Commit** `feat(office): the rendered room — walls, floor, furniture (lane 01M5D8F7FT)`.

### Task 7: Per-desk live overlays

**Files:**
- Modify: `render.ts` — `drawWorkstation` (`lampsLit`, `atWork`, `owned`, props), `scene.blend`, `render.py`
- Test: `render.test.ts`

**Interfaces:**
- Asset ids: `desk/lamp-on`, `desk/lamp-pool`, `desk/screen-on`, `desk/prop-fan-<frame 0..3>`, `desk/prop-mug`, `desk/owned-warm`.
- `drawWorkstation` blits `lamp-on` + `lamp-pool` when `lampsLit && node`, `screen-on` when `atWork`, the mug/fan when `deskHasProp(id, kind)`; the fan frame is `Math.floor(t * 8) % 4` only when `node` is present (spec §3.1 item 5).

- [ ] **Step 1: Write the failing test** — an occupied desk at night emits `lamp-on` and `lamp-pool` blits; an empty one emits neither; a working owner adds `screen-on`; the fan frame advances with `t` only when occupied.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(office): rendered per-desk overlays keep the live desk state (lane 01M5D8F7FT)`.

### Task 8: Light states and the crossfade

**Files:**
- Create: `packages/web/src/live/office-scene/rendered/roomState.ts`
- Test: `packages/web/src/live/office-scene/rendered/roomState.test.ts`
- Modify: `render.ts` (`drawFloor`/`drawWalls` rendered branch, `drawWindowBeams`), `scene.blend`, `render.py`

**Interfaces:**
- Consumes: `LightEnv` (`hours`, `daylight`, `overheadOn`, `afterHours`).
- Produces:
  ```ts
  export type DayState = 'day' | 'evening' | 'night';
  export type CeilingState = 'on' | 'off' | 'spill';
  export interface RoomMix { from: `${DayState}-${CeilingState}`; to: `${DayState}-${CeilingState}`; mix: number } // mix in [0,1]
  export const DAY_EDGES = { eveningFrom: 16.5, nightFrom: 19.0, dayFrom: 7.0 } as const; // hours; 45-minute fades
  export function roomMixFor(env: LightEnv): RoomMix;
  export function figureTintFor(env: LightEnv): string; // multiply colour, '#ffffff' by day
  ```
- Asset ids: `room/light-<day|evening|night>` (floor + walls lit), `room/ceiling-<on|off|spill>` overlay. The rendered branch draws `from` at alpha 1 then `to` at `mix`.

- [ ] **Step 1: Write the failing tests** — at 12:00 with `overheadOn` → `day-on`, mix 0; at 16:30 → mix 0; at 16:52:30 → `day→evening`, mix 0.5; at 17:15 → mix 1 (then `from === to`); `afterHours` → ceiling `spill`; the mix never steps by more than 1/45 per simulated minute (continuity); `?light=` override feeds the same function.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Render** the three light states and three ceiling overlays; wire the blits; the painted path's `drawWindowBeams` is skipped when rendered (the beams are in the light layers).
- [ ] **Step 6: Browser check** `/office-preview?office=rendered&light=12`, `&light=17`, `&light=22`. Commit `feat(office): rendered light states with a 45-minute crossfade (lane 01M5D8F7FT)`.

### Task 9: nick's sign-off on the room; budgets; docs

- [ ] **Step 1:** Capture /live (`?office=rendered`) at the three light states and attach to the PR; `team_send ask` nick (species consult, tier standard) with the captures; iterate on his notes in this lane.
- [ ] **Step 2:** Re-measure `officeArtBytes`; set to measured + 15%; log in `web-live-baseline.md`.
- [ ] **Step 3:** `08-web.md`: the room section describes the rendered path and the flag. Fast gates; PR; `lane_submit`.

---

## Increment 3 — the figure (lane `01M5D8F93KGF8A47F2Q1A6N2BV`)

### Task 10: Sheet layout and frame selection

**Files:**
- Create: `packages/web/src/live/office-scene/rendered/figureSheet.ts`
- Test: `packages/web/src/live/office-scene/rendered/figureSheet.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Dir8 = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';
  export type Anim = 'idle' | 'walk' | 'sit-type' | 'sit-idle' | 'speak' | 'turn' | 'sit-down' | 'stand-up';
  export interface SheetSpec { frame: { w: number; h: number }; anchor: { x: number; y: number }; anims: Record<Anim, { row: number; frames: number; fps: number; loop: boolean }> } // one row per (anim, dir): row = anims[a].row + dirIndex
  export function dir8FromHeading(headingRad: number, prev?: Dir8): Dir8; // 45° sectors; ±4° hysteresis around a boundary when prev is given
  export function dir8FromDir(d: Dir): Dir8;
  export function frameRect(spec: SheetSpec, anim: Anim, dir: Dir8, t: number, startT: number): { sx: number; sy: number; sw: number; sh: number; done: boolean };
  ```

- [ ] **Step 1: Write the failing tests** — `dir8FromHeading(0)` is `E` and `dir8FromHeading(Math.PI/2)` is `S` (y down, as `heading` is used in `character.ts`); a heading 1° past a boundary with `prev` on the other side stays on `prev`; 5° past flips; `frameRect` for a 6-frame 12 fps loop at `t - startT = 0.5` is frame 0 again (`done` false); a 4-frame one-shot at 1.0 s is its last frame with `done` true.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(office): sprite-sheet frame and direction selection (lane 01M5D8F93K)`.

### Task 11: Tinted identity layers

**Files:**
- Create: `packages/web/src/live/office-scene/rendered/tint.ts`, `…/figure.ts`
- Test: `…/tint.test.ts`, `…/figure.test.ts`

**Interfaces:**
- Consumes: `Appearance` (`appearance.ts`), `SheetSpec`, `frameRect`.
- Produces:
  ```ts
  export type LayerId = 'skin' | `hair/${HairStyle}` | `facial/${FacialHair}` | `hat/${Hat}` | `top/${TopCut}` | 'bottom' | 'shoes' | `acc/${Accessory}` | 'visor';
  export function layersFor(a: Appearance, kind: OfficeNode['kind']): Array<{ id: LayerId; color: string | null }>; // draw order back→front; 'visor' only for agents
  export function tintedSheet(src: CanvasImageSource, color: string, cache: Map<string, CanvasImageSource>, key: string, create?: (w: number, h: number) => HTMLCanvasElement): CanvasImageSource; // multiply tint of a neutral-grey sheet; cached by key
  export function drawFigureFrame(ctx, fit, at: { lx: number; ly: number }, sheets: Map<LayerId, CanvasImageSource>, spec: SheetSpec, a: Appearance, kind, anim: Anim, dir: Dir8, t: number, startT: number, alpha: number, tint: string): void;
  ```
- A layer whose sheet is not in `sheets` is skipped (Review Focus 2); `skin` is tinted with `a.skin`, which is how agents keep mint/seafoam/periwinkle.

- [ ] **Step 1: Write the failing tests** — `layersFor` for a femme member with a bun, glasses and a hoodie yields `['skin','hair/bun','top/hoodie','bottom','shoes','acc/glasses']` in that order and no `visor`; an agent gets `visor` last; `tintedSheet` emits one `drawImage` + one `multiply` fill on a fresh canvas and returns the cached canvas on the second call; `drawFigureFrame` with a `sheets` map missing `hair/bun` still emits the other layers' `drawImage` ops.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(office): tintable identity layers compose a figure frame (lane 01M5D8F93K)`.

### Task 12: The rig and the first sheets

**Files:**
- Create: `packages/web/art/office/figure.blend`; modify `render.py` (a `--figure` mode writing `office-fig-<layer>.png` + `figure.json` as `SheetSpec`)
- Create: the sheets under `rendered/assets/`

- [ ] **Step 1: Build the character** to spec §2.1 (5 heads, slight waist, pelvis, structured face, matte materials); identity layers as separate meshes/collections rendered neutral grey where tinted. **Rig it with Mixamo's free auto-rigger** (humanoid, FBX in T-pose) and bring the rig and its standard clips into Blender with the Mixamo Rig 5 add-on; parent hair, hat, accessory and carried-prop meshes to bones so they follow every clip.
- [ ] **Step 2: Author the 8 first-cut actions** at 12 fps — walk, idle, sit-down/stand-up and sit-idle from Mixamo's library (deformations fixed in Blender), sit-type, speak and turn keyed by hand; every gesture that is ours (the wave, the board reach, the sip) is always hand-keyed so the figure never reads as a stock Mixamo character: idle 8f loop, walk 8f loop (stride = `STRIDE` floor units per cycle so feet don't slide), sit-type 6f loop, sit-idle 8f loop, speak 8f loop, turn 4f one-shot, sit-down / stand-up 6f one-shot.
- [ ] **Step 3: Render** 8 directions × actions × layers at 2× with the Task 5 camera; commit; `perf:check` (expect a raise; log it).
- [ ] **Step 4: Commit** `art(office): the member rig and first-cut sprite sheets (lane 01M5D8F93K)`.

### Task 13: `drawCharacter` picks frames

**Files:**
- Modify: `packages/web/src/live/office-scene/character.ts` (`drawCharacter`, line ~154), `render.ts` (`drawActor`, line ~3278; the seated overlay pass that calls it with `armsOnly`)
- Test: `character.test.ts` (new), `render.test.ts`

**Interfaces:**
- `CharacterOpts` gains `rendered?: RenderedAssets | undefined` and `animStart?: number`. Mapping from a `Pose` to `Anim`: walking (`pose` has a path step) → `walk`; seated and `typingFromPulse(...) > 0` → `sit-type`; seated otherwise → `sit-idle`; standing with a `bubble` → `speak`; else `idle`. `dir` = `dir8FromHeading(heading)` when `heading` is set, else `dir8FromDir(dir)`.
- When `rendered` is present and `fig` sheets loaded, `drawCharacter` calls `drawFigureFrame` and returns; the skeleton is not solved (`skelFor` is skipped by the caller when rendered). `armsOnly` is a no-op in the rendered path until Task 16.

- [ ] **Step 1: Write the failing tests** — a seated typing pose emits a `sit-type` frame (assert the `sy` row); a walking pose at heading π/4 picks `SE`; the painted path's op list is unchanged without `rendered`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** the mapping as `animFor(pose, node, t): { anim: Anim; startT: number }` in `character.ts` (exported, tested). **Step 4: Run** `vitest run src/live/office-scene` — PASS incl. `actors.test.ts`.
- [ ] **Step 5: Commit** `feat(office): drawCharacter picks sprite frames when rendered (lane 01M5D8F93K)`.

### Task 14: nick's sign-off on the figure; budgets; docs

- [ ] As Task 9: captures (walk, sit, speak), ask nick, iterate; re-measure `officeArtBytes`; `08-web.md`; PR; `lane_submit`.

---

## Increment 3b — motion parity (lane `01M5D8FCC94N90YHDSN79C9RPF`)

### Task 15: The remaining gestures as actions

**Files:** `figure.blend`, `render.py`, `rendered/assets/`, `figureSheet.ts` (`Anim` grows), `character.ts` (`animFor`)

- [ ] **Step 1:** Add an `Anim` per `IdleGesture` in `skeleton.ts` `GESTURE` (stretch, sip, swivel, roll, rubEyes, pocketPhone, call, eat, pour, fill, browse, wave, reach, take, …) with the same durations as `GESTURE_DUR` in `actors.ts`; `animFor` maps `o.gesture` to it and `gestureT` to the frame.
- [ ] **Step 2:** Test: for each `IDLE_GESTURES` entry `animFor` returns an `Anim` the spec has (a table-driven test over `IDLE_GESTURES`).
- [ ] **Step 3:** Author, render, commit; `perf:check` logged. Commit `art(office): every idle gesture as a sprite action (lane 01M5D8FCC9)`.

### Task 16: Carried props and the seated overlay

**Files:** `figure.ts`, `character.ts`, `render.ts`

- [ ] **Step 1:** Layers `carry/<CarryKind>` (laptop, plate, box, card) and `mug`, `lanyard` rendered per direction for the animations that carry; `layersFor` takes `carry: CarryKind | null`, `mug?: string`, `lanyard?: string`.
- [ ] **Step 2:** The seated overlay pass: `drawFigureFrame` gains `part: 'all' | 'arms'`; the sheets carry an `arms` layer for seated actions; `armsOnly` draws only it, over the desk, as the painter does today.
- [ ] **Step 3:** Tests: a carrying walker emits the `carry/laptop` layer; `armsOnly` emits only the `arms` layer. Commit `feat(office): carried props and the seated overlay in the rendered figure (lane 01M5D8FCC9)`.

### Task 17: Parity check

- [ ] **Step 1:** Run `/office-preview?office=rendered` through the ambient matrix `scripts/perf/scene-pixel-check.mjs` uses (states × light), eyeballing each against the painted scene for a missing behaviour; list any gap in the PR and close it in this lane.
- [ ] **Step 2:** PR; `lane_submit`.

---

## Increment 4 — the whole floor, stream-safe (lane `01M5D8EJ40SANYJ781005AZN06`)

### Task 18: Ambient life, welcome room, pet, receptionist

**Files:** `scene.blend`, `figure.blend`, `render.py`, `render.ts` (`drawReceptionist`, `drawDog`, `welcomeRoom.ts` painters), `pet.ts`

- [ ] **Step 1:** Render the receptionist on the member rig (`receptionistPose` → `Anim`), the dog as its own small sheet (`pawCycle` → frame), the welcome room's items as static assets; ambient life as small looped overlays (`screen-flicker`, `mug-steam`, `plant-sway` 4f at 6 fps) drawn only when the scene clock runs (same gate as idle sway).
- [ ] **Step 2:** Tests in the recording context as in Task 7. Commit.

### Task 19: Remove the flag, delete the painters

**Files:** `index.ts`, `iso.ts` (`ISO_CAMERA` goes; `CORNER_CAMERA` is the camera), `render.ts`, `character.ts`, `skeleton.ts` (only what `animFor` still reads stays), `scene-pixel-check.mjs`, `08-web.md`, `routes/character-sheet.tsx` (the hero and `/office-preview` mount the same scene and needed nothing)

- [x] **Step 1:** Delete every painter branch the rendered path replaced; `rendered` becomes required in `RenderOpts`; the hero and `/office-preview` load assets the same way `/live` does (`fitFloor` keeps framing the full wall height).
- [x] **Step 2:** (2026-10-23: the gate is a direct-vs-cache parity check with no stored baseline, so it needed no change — the rendered scene is the only scene it can measure.) `scene-pixel-check.mjs` re-baselines against the rendered scene (it is the new "room that was there before").
- [x] **Step 3:** `pnpm perf:check` — total JS must be **at or below** the pre-increment-1 number (log it); `a11y:check` and `a11y:targets:check` green.
- [x] **Step 4:** Commit `feat(office): the rendered office is the office; painters removed (lane 01M5D8EJ40)`.

### Task 20: Broadcast frame-time A/B

_(Replaced 2026-10-26, nick: the painters were deleted in #3295, so there is no B to compare against. The real-stream measurement in `docs/perf/web-live-baseline.md` — "2026-10-26 — /broadcast frame time on the hosted stream seat" (#3345: median 29 draws/s at 1080p30, p5 23, Chrome 157%) — stands in for the A/B and its gate. Lane 01M5QE7HXP.)_

- ~~**Step 1:** Run `scripts/perf/broadcast-baseline.mjs` (method at the top of `docs/perf/web-live-baseline.md`) against `origin/main` and this branch, same fixture team, 1080p30, five minutes each.~~ — replaced, see below
- ~~**Step 2:** Record draws/s, ms per draw and main-thread busy in `web-live-baseline.md`. The gate: ms per draw on this branch ≤ main's. A regression blocks the merge; fix it here (first suspects: unneeded per-frame `tintedSheet` misses, overlays drawn when nothing changed under dirty-rect).~~ — replaced, see below
- ~~**Step 3:** Commit the numbers.~~ — replaced, see below
- [x] **Replacement (nick, 2026-10-26).** Measure `/broadcast` on the hosted stream seat for five minutes and record it in `web-live-baseline.md`. **Revised gate:** the stream holds its capture rate — the encoder at 30 fps and 1× speed — while the office draws a median of at least 28 per second with its slowest 5% of seconds at 22 or above (nick, 2026-10-26), on a run with less than 10% CPU from other processes. **Met** (#3345): encoder `fps=30 … speed=1x`, median 29 draws/s (p5 23), other CPU 2.5%.

### Task 21: Ship

- [ ] **Step 1:** Captures of /live and /broadcast at day and night with the full team; `team_send ask` nick (tier standard) — this lane is `stakes: high`, so his answer is the acceptance.
- [ ] **Step 2:** PR; `lane_submit`; the build-publisher republishes /live within ~60 s; `musterd stream` picks the new bundle up on its next relaunch.

---

## Increments

| # | Increment | Lane |
| --- | --- | --- |
| 0 | Design document (this plan's spec) | `01M5D79CFYX6R7J9FWD0K0J63D` |
| 1 | Pipeline: Blender + render script → one desk through the sprite cache; `officeArtBytes` | `01M5D8F3RNW6AXVXSR76FG24KK` |
| 2 | The room: camera, walls, floor, furniture, per-desk overlays, light states | `01M5D8F7FTXT07SSGPPYGX9JV8` |
| 3 | The figure: rig, first-cut sheets, identity layers, frame picking | `01M5D8F93KGF8A47F2Q1A6N2BV` |
| 3b | Motion parity: every gesture, carried props, seated overlay | `01M5D8FCC94N90YHDSN79C9RPF` |
| 4 | Ambient life, welcome room, pet, receptionist; flag off; broadcast A/B; ship | `01M5D8EJ40SANYJ781005AZN06` |

Goal: `office-realism`. Each lane is one PR; nick's sign-off is asked in lanes 2, 3 and 4.

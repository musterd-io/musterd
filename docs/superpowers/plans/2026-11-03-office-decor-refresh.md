# Office decor refresh — implementation plan

**Goal:** Original fine-art paintings fill the office's five frames, the three signs become carved
oak with gold lettering and lamps that glow after dark, the shelves hold real-looking books with
objects on top, and the floor gains display pieces and one reading nook.

**Architecture:** Everything visible is pre-rendered art (Blender, plus committed images from an
image model and Meshy meshes) shipped as `office-art-*.webp` under the `officeArtBytes` budget, and
blitted by the office canvas (`render.ts`) at layout positions (`layout.ts`). Runtime code only
places, tints and lights that art. The doors (wiki, settings, work board) stay DOM hotspots over the
canvas.

**Tech stack:** Blender 5.2 Python (`packages/web/art/office/`), system Python 3 with Pillow for
the painting prep script (an art tool, never shipped), TypeScript canvas painter, vitest.

**Spec:** `docs/superpowers/specs/2026-11-03-office-decor-refresh-design.md` (approved by nick
2026-11-03). Read it first; this plan does not repeat its reasons.

## Increments

| Increment | Lane | Tasks |
| --- | --- | --- |
| 0. Design doc and this plan | `01M6FWZHJTJNPS8CKD8J2V5BFZ` | — |
| 1. Five paintings fill their frames | `01M6FXB2CAB8NHVPYD4CCJ2ZGS` | 1–3 |
| 2. The three signs | `01M6FXKVDDBZ3C1C9TKYH8MPG4` | 4–5 |
| 3. Real books and bookcase tops | `01M6FXB5GR0SKTS7QS66WK86BV` | 6–7 |
| 4. Floor pieces and the reading nook | `01M6FXBBHM6YYS8ZSNB5Y1B39S` | 8–10 |

One PR per increment, in this order. Each increment re-renders only its own assets (`render.py
--only <ids>`), never the room shell.

## Global constraints

- Hard rule 6: no new runtime dependency. Blender, Pillow, the image model and Meshy are art tools;
  their outputs are committed and nothing at runtime imports them.
- `officeArtBytes` is 9,730,000 B with 9,623,782 B used (2026-11-03). Every raise is logged in
  `docs/perf/budgets.json` `$comment` and `docs/perf/web-live-baseline.md` (ADR 151/183). If the
  decor's **cumulative** raise would pass +1,000,000 B, stop and ask nick (`team_question`) first.
- `totalJsGzipBytes` has ~0.3 KB of headroom. Code that replaces code (the print motifs, the DOM
  sign styling) must be deleted, not kept as a fallback.
- Painting provenance: prompts name no artist, movement tied to one person, title, museum or "in the
  style of"; each image has a sidecar; each is checked by eye; **nick sees all five at full size and
  at room size before the increment 1 PR merges.**
- The rendered room is lit by the room's rig (`scene.LIGHT_STATES`); new runtime-drawn light follows
  `LightEnv.daylight` (`lighting.ts`), the way `lampReflection` and `deskLampOn` do.
- Tests run in CI, not on the shared laptop (fast gates locally: `pnpm typecheck && pnpm lint &&
  pnpm format:check`). Blender renders run locally (~7 min for the full exterior set; per-asset
  `--only` runs are seconds).

## Review focus

1. **Mirrored on the back-left wall.** Four frames and the wiki sign hang on wall 0, where `+t` runs
   screen-left. A painting or a sign's lettering drawn or rendered there must read the right way
   round. Tests: Task 2 `paintingQuad` mirror test; Task 4 checks the sign renders by eye on both
   walls before commit.
2. **The room at night.** A painting at full brightness at 23:00, an unlit lamp in a dark room, or
   a lamp pool by day. Tests: Task 2 tint test; Task 5 `signLampAlpha` test; Task 10
   `floorLampOn` test.
3. **A hotspot that no longer covers its sign.** The doors must still be hittable where the
   rendered sign is, at every fit scale, with a 24px floor. Test: Task 5 `signRect` test; CI's
   `a11y:targets:check`.
4. **A figure walking through new furniture.** Every new floor piece blocks in `nav.ts`. Test:
   Task 8 layout tests.
5. **A painting that fails to load.** The frame and mat show with nothing in them; no thrown error,
   no motif fallback. Test: Task 2 `drawPainting` skips a missing image.

---

### Task 1: The image-model ADR, the painting sources and their sidecars

**Files:**
- Create: `docs/decisions/NNN-generated-paintings.md` (`pnpm adr:next` for NNN; push a draft PR
  before writing it, ADR 223)
- Create: `packages/web/art/office/paintings/<i>-<slug>.webp` (i = 0…4, the full-size source) and
  `<i>-<slug>.json` (the sidecar)
- Modify: `packages/web/art/office/README.md` (a "Paintings" section)

- [ ] **Step 1: Write the ADR**, shaped like ADR 755: the image model (Z-Image-Turbo,
  `Tongyi-MAI/Z-Image-Turbo`, Apache-2.0, checked 2026-11-03) is an art source for flat pictures
  only; outputs are committed with sidecars; the provenance rules from the spec; nick's review gate.
  Observability & Evaluation: Eval = nick's sign-off on each image.
- [ ] **Step 2: Generate the five paintings.** One per `ART` slot, in the frame's aspect. Start from
  the spec's four sample prompts and seeds; the fifth is a second direction of the builder's choice.
  Prompts follow the provenance rule.
- [ ] **Step 3: Write each sidecar** with exactly these keys: `prompt`, `seed`, `model`, `steps`,
  `shift`, `resolution`, `date`, `art_slot` (index into `ART`), `check` (`{by, date, notes}`: the
  resemblance/signature/lettering/watermark check).
- [ ] **Step 4: Check every image by eye** and record the result in `check`. Crop or regenerate any
  with a signature, lettering or watermark.
- [ ] **Step 5: Commit** `art: five generated paintings and their provenance (lane 01M6FXB2CA)`.

### Task 2: Paint the picture into the frame

**Files:**
- Create: `packages/web/src/live/office-scene/paintings.ts`, `paintings.test.ts`
- Modify: `layout.ts` (`ArtPiece`: replace `motif` with `painting: number`), `render.ts` (`wallArt`
  draws the painting; delete `MOTIFS`, `INK`, `ArtSurface`, `Motif`, `MotifName`),
  `layout.test.ts` (the "varies motif" test becomes "uses five different paintings")

**Interfaces:**
- Produces: `printOpening(w: number, h: number, frame: ArtPiece['frame']): { hw: number; hh: number }`;
  `paintingQuad(p: (a: number, b: number) => Pt, hw: number, hh: number, mirror: boolean): [Pt, Pt, Pt]`
  (the image's top-left, top-right and bottom-left corners on screen);
  `drawPainting(ctx, img: CanvasImageSource | undefined, quad: [Pt, Pt, Pt], iw: number, ih: number, tint: string): void`.
- Consumes: `figureTintFor(env)` (`rendered/roomState.ts`) as the tint.

- [ ] **Step 1: Write the failing tests** in `paintings.test.ts`:
  - `printOpening(54, 42, 'thick')` → `{ hw: 21.76, hh: 15.76 }`; `(22, 30, 'thin')` →
    `{ hw: 8.45, hh: 12.45 }`; `(26, 26, 'none')` → `{ hw: 13, hh: 13 }` (`toBeCloseTo`, 2). The
    rule: the frame bar is `w × 0.06` (thick) or `w × 0.025` (thin) per side, as `scene.wall_art`
    builds it, and the mat shows a 2-unit border; an unframed canvas is printed edge to edge.
  - `paintingQuad` with `mirror: false` puts corner 0 at `p(-hw, hh)`; with `mirror: true` at
    `p(hw, hh)`.
  - `drawPainting` with `img` undefined issues no draw calls (`recordingCtx()`); with an image it
    calls `setTransform`/`transform`, `drawImage` once, then a `multiply` fill of `tint` clipped to
    the quad.
- [ ] **Step 2: Implement** the three functions. `drawPainting` sets the affine transform that maps
  the image rect `(0,0)-(iw,ih)` onto the three corners, draws, then multiplies the tint over the
  same quad. `mirror` is `edge === WALL_EDGES[0]` at the call site.
- [ ] **Step 3: Wire `wallArt`** to `printOpening` + `paintingQuad` + `drawPainting`, with the image
  from the rendered asset map under id `painting/<n>` and the tint `figureTintFor(env)`. Delete
  the motif code.
- [ ] **Step 4: Fast gates, push, CI.** Expected: `paintings.test.ts` and `layout.test.ts` green;
  `perf:check` total JS not above budget (the motif deletion should pay for the new code).
- [ ] **Step 5: Commit** `office: paintings fill their frames, tinted by the room's light (lane 01M6FXB2CA)`.

### Task 3: Ship the paintings and get nick's yes

**Files:**
- Create: `packages/web/art/office/paintings.py`
- Modify: `rendered/assets/manifest.json` (5 `painting/<i>` assets),
  `rendered/assets/office-art-painting-<i>.webp`, `docs/perf/*` if the budget moves

- [ ] **Step 1: Write `paintings.py`** (Pillow): for each sidecar, centre-crop the source to its
  slot's `printOpening` aspect, resize to `ceil(2 × hw × 4)` px wide, quantize, save WebP q80 as
  `office-art-painting-<i>.webp`, and upsert the manifest entry `{id: 'painting/<i>', file, w, h,
  anchor: {x: 0, y: 0}, scale: 1}`. Idempotent.
- [ ] **Step 2: Run it**; expected five files, ~10–20 KB each, and `office-art-*` total under the
  budget (or a logged raise).
- [ ] **Step 3: Show nick** all five at full size and at room size (the visual companion, or an
  artifact), and ask with `team_question`. **Do not merge without his yes.** Regenerate any he
  rejects and ask again.
- [ ] **Step 4: Open the PR** with `Lane \`01M6FXB2CAB8NHVPYD4CCJ2ZGS\`.` in its first lines, arm
  auto-merge only after nick's yes, then `lane_submit`.

### Task 4: Render the three signs

**Files:**
- Create: `packages/web/src/live/office-scene/signs.ts`, `signs.test.ts`
- Modify: `scene.py` (`SIGNS`, `wall_sign()`, the oak-and-gold calendar card stays runtime but gets
  new colours in Task 5), `render.py` (`wall/sign-<name>` assets), `rendered/assets/*`

**Interfaces:**
- Produces (`signs.ts`): `type SignName = 'wiki' | 'settings' | 'board'`;
  `SIGNS: Record<SignName, { wall: 0 | 1; tc: number; uc: number; w: number; h: number; text: string }>`
  with texts `wiki`, `settings`, `work board`. `wiki` hangs above `BOOKSHELVES[WIKI_SHELF]`,
  `board` above `WALL_BOARD`, `settings` under `WORKING_HOURS_CALENDAR`, where today's DOM tags
  sit. `scene.py` mirrors these numbers (as `ART_PIECES` mirrors `ART`); a test reads both.

- [ ] **Step 1: Write the failing tests** in `signs.test.ts`: every sign is clear of every window's
  `t` span and of `ART`, the clock and the calendar (reuse the overlap helpers in
  `layout.test.ts`); `SIGNS` matches the `SIGNS` table parsed from `scene.py` (the
  `ART`/`ART_PIECES` pattern, if one exists; else a plain regex read).
- [ ] **Step 2: Implement `wall_sign(asset_id, name, zs, col)`** in `scene.py`: a bevelled oak board
  (`wood`, the board's `#DCBF8E` family), raised extruded gold lettering (`text_add`, extrude
  ~0.6, a gold metal material), two brass chains to a short brass rail, and a small brass picture
  light (shade + arm) above it, unlit. Check by eye that the lettering reads the right way on
  wall 0 and wall 1 (the clock's note on mirroring).
- [ ] **Step 3: Render** `--only wall/sign-wiki,wall/sign-settings,wall/sign-board`; blit each in
  `render.ts` `dress()` at its `SIGNS` floor point.
- [ ] **Step 4: Commit** `office: carved oak signs with gold lettering (lane 01M6FXKVDD)`.

### Task 5: Lamps after dark, the calendar's finish, and the doors over the new signs

**Files:**
- Modify: `signs.ts`, `signs.test.ts`, `render.ts` (`workingHoursSign` palette, the lamp pools),
  `index.ts` (the three hotspots), `Live.css` (`.lc-boardspot__tag`, `.lc-hoursspot__tab`)

**Interfaces:**
- Produces: `signLampAlpha(daylight: number): number` (0 when `daylight ≥ 0.5`, rising to 0.28 at
  `daylight 0`); `signRect(fit: Fit, name: SignName): { x: number; y: number; w: number; h: number; tiltDeg: number }`.

- [ ] **Step 1: Write the failing tests**: `signLampAlpha(1) === 0`, `signLampAlpha(0.5) === 0`,
  `signLampAlpha(0)` ≈ 0.28; `signRect` for each sign at fit scales 0.6 and 1.4 contains the
  sign's projected corners and is at least 24 × 24 px.
- [ ] **Step 2: Paint each lamp's pool** in the background bake: a radial gradient on the wall
  under the lamp, `rgba(255, 214, 150, signLampAlpha(env.daylight))`, radius ~0.9 × the sign's `w`.
- [ ] **Step 3: Restyle the calendar** (`workingHoursSign`): an oak frame and gold header band with
  cream ground; days and hours in the same gold/dark-oak ink. The text stays live.
- [ ] **Step 4: Make the DOM signs invisible doors.** The tag and the tab keep their element,
  their accessible name and their hover glow, but drop the visible oak, strings and text, and take
  their box from `signRect`. The pending-pairing red dot stays visible.
- [ ] **Step 5: Fast gates, push, CI.** Expected: `a11y:check`, `a11y:targets:check` green.
- [ ] **Step 6: PR** with `Lane \`01M6FXKVDDBZ3C1C9TKYH8MPG4\`.`, auto-merge, `lane_submit`.

### Task 6: A book generator that looks like a real shelf

**Files:**
- Create: `packages/web/art/office/books.py`, `packages/web/art/office/test_books.py`

**Interfaces:**
- Produces: `shelf_row(seed: int, long: float, band: float, deep: float) -> list[Book]`, where
  `Book` is a dict `{kind: 'upright' | 'lean' | 'flat', along: float, w: float, h: float, d: float,
  tilt: float, color: str, band_color: str, band_at: float}`. Pure Python, no `bpy`.

- [ ] **Step 1: Write `test_books.py`** (plain asserts, `python3 test_books.py`): deterministic for a
  seed; every book inside `±(long/2 - 2)`; no two books overlap along the row (a leaning book counts
  its tilted footprint); `h ≤ band - 3`; heights vary (max − min ≥ 4); every row has at least one
  gap ≥ 6; across a unit's rows there is at least one `lean` and one `flat` stack of 2–4; every book
  has a `band_color` and `0 < band_at < 1`.
- [ ] **Step 2: Implement `shelf_row`.** Spine colours from muted cloth tones (extend
  `BOOK_COLORS` with darker, less saturated cloths); band colours gold, cream or black.
- [ ] **Step 3: Run** `python3 packages/web/art/office/test_books.py`; expected no output, exit 0.
- [ ] **Step 4: Commit** `art: a shelf-row generator for real-looking books (lane 01M6FXB5GR)`.

### Task 7: Rebuild the shelves, with things on top

**Files:**
- Modify: `scene.py` (`bookshelf()` builds books from `shelf_row`; `SHELF_TOPS`), `layout.ts`
  (`ShelfDecor` matches what is actually on each top), `rendered/assets/office-art-shelf-*.webp`

- [ ] **Step 1: Build the books** in `bookshelf()` from `shelf_row`: uprights as boxes, a lean
  rotated about the bottom edge toward its neighbour, flats as a stack, each spine with a thin
  band; bookends where a lean would otherwise fall.
- [ ] **Step 2: Add `SHELF_TOPS`**: per unit, 1–3 objects on the top (for example a small plant, a
  vase, a globe, a box, a trophy), from existing meshes where one fits (`desk-plant`) or new Meshy
  meshes under ADR 755. The tall corner unit keeps clear of the art above it (`layout.test.ts`
  "never hangs a picture behind a bookshelf").
- [ ] **Step 3: Render** `--only shelf/0,shelf/1,shelf/2`; check the books and tops by eye in
  every light state.
- [ ] **Step 4: PR** with `Lane \`01M6FXB5GR0SKTS7QS66WK86BV\`.`, auto-merge, `lane_submit`.

### Task 8: Place the nook and the display pieces

**Files:**
- Modify: `layout.ts` (`READING_NOOK`, `DECOR`), `nav.ts` (blockers), `layout.test.ts`

**Interfaces:**
- Produces: `READING_NOOK = { chair: { lx, ly, dir: Dir }, lamp: { lx, ly }, table: { lx, ly } }`
  in the back corner by `BOOKSHELVES[0]`; `DECOR: ReadonlyArray<{ id: string; lx: number; ly: number;
  w: number; d: number; kind: 'sculpture' | 'installation' | 'lamp' | 'rug' | 'rack' | 'stand' }>`.

- [ ] **Step 1: Write the failing tests** in `layout.test.ts`: every `DECOR` piece and the nook's
  three pieces lie on the floor slab, overlap no desk slab, rug-free pod seat, shelf, plant,
  `MEETING` chair, `LOUNGE` piece, the front desk, the queue strip or the entrance band; every
  existing `LEISURE_SPOTS` and `NOOK_SPOTS` spot keeps its clearance (the existing "far enough
  apart" rule); `DECOR` has at least two `sculpture`/`installation` pieces.
- [ ] **Step 2: Choose positions** that pass; candidates from the spec (meeting table's open
  corner, lounge edge, back-left shelf). Add each piece to `nav.ts` as a blocker, the plant way.
- [ ] **Step 3: Commit** `office: place the reading nook and the display pieces (lane 01M6FXBBHM)`.

### Task 9: Model and render the floor pieces

**Files:**
- Modify: `packages/web/art/office/meshes/*` (new Meshy meshes and sidecars), `scene.py`
  (`reading_nook()`, `decor_piece()`), `render.py`, `rendered/assets/*`

- [ ] **Step 1: Generate the Meshy meshes** (ADR 755: untextured preview, sidecar, credits logged):
  the nook armchair (or reuse `armchair.glb`), the floor lamp, two sculptures/installations.
  Plinths, the side table, the rug and the book stack are scripted.
- [ ] **Step 2: Finish in Blender** with the room's matte materials (bronze, stone, oak, linen),
  lamps with a lit variant (`<id>-lit`) the way `desk_lamp` has one.
- [ ] **Step 3: Render** the new ids; measure `office-art-*`; raise and log the budget, or stop at
  +1 MB cumulative and ask nick.
- [ ] **Step 4: Commit** `art: the reading nook and the floor display pieces (lane 01M6FXBBHM)`.

### Task 10: Draw them, light the lamps, seat a reader

**Files:**
- Modify: `render.ts` (blit `DECOR` and the nook in the painter's sort), `lighting.ts`,
  `layout.ts` (`LEISURE_SPOTS`), `layout.test.ts`, a `lighting` test

**Interfaces:**
- Produces: `floorLampOn(env: Pick<LightEnv, 'daylight'>): boolean` (true when `daylight < 0.5`,
  whoever sits there).

- [ ] **Step 1: Write the failing tests**: `floorLampOn({ daylight: 0.2 })` true, `(0.8)` false;
  `LEISURE_SPOTS` has exactly one more seat than before, in a zone named `corner` (not `nook`,
  which names the break corner), `sit: 1`, at `READING_NOOK.chair`; the zones still interleave.
- [ ] **Step 2: Implement**: blit the pieces through the painter's depth sort, the lit lamp variant
  plus a warm floor pool when `floorLampOn`; add the `corner` zone to the interleave after
  `reading`.
- [ ] **Step 3: Fast gates, push, CI; check `/office-preview?light=13` and `?light=22`** by eye.
- [ ] **Step 4: PR** with `Lane \`01M6FXBBHM6YYS8ZSNB5Y1B39S\`.`, auto-merge, `lane_submit`; when all
  four increments are accepted, record the goal outcome on `office-decor-refresh`.

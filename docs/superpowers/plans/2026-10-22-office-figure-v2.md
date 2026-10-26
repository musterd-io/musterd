# Office figure v2 Implementation Plan

> **For agentic workers:** implement in your own seat, task by task, per the repo's AGENTS.md (no
> writing subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the rendered office's figure with a softer, connected, more realistic body, then grow
its wardrobe in small increments.

**Architecture:** The Blender pipeline (`figure.py` builds the rig, `render.py --figure` renders per-layer
sheets through the per-call store) gains a fusing pass, a skin-only base and holdout proxies; the
runtime (`rendered/figure.ts`) gains a draw order for overlapping pieces and a per-member width
stretch. Wardrobe growth is new layers plus, after the painted office is retired, new picks in
`appearance.ts`.

**Tech Stack:** Blender 5.2 Python (bpy, numpy), TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-10-22-office-figure-v2-design.md`

## Increments

| # | Increment | Tasks | Lane |
| --- | --- | --- | --- |
| v2-1 | The new body, today's wardrobe re-fitted, the build stretch | 1–8 | `01M5JHEEGT55EDJYG51H6ZAQVJ` |
| v2-2 | Tops upgraded | 9 | `01M5JHEGY8S4BSJDWS1M6SYZMG` |
| v2-3 | Hair and facial hair upgraded, polished and relaxed pools | 10 | `01M5JHEK4HNPFY7XC3RKQWJFV9` |
| v2-4 | Hats and accessories upgraded and added | 11 | `01M5JHENHB2ACVDJ767XP0RH8X` |
| v2-5 | Style, grooming and per-spot picks; `presents` retired; outer layers; first new pieces | 12 | `01M5JHERVT03C6VDN13M8FE3NK` |
| v2-6 | The one-piece layer and dresses; more pieces | 13 | `01M5JHEV51D8G1FKGSNVK9CJ81` |

Each increment is one PR. v2-5 waits for realism increment 4 (`01M5D8EJ40SANYJ781005AZN06`), which
waits for nick to accept v2-1 on /live.

## Global Constraints

- Proportion: ~4.7 heads, a quarter of the way from today's (`HEAD_R = 9.4·FIG`) to 3.7 heads; the crown (`figure.CROWN`) does not move.
- One height. Build varies only by a per-member horizontal draw stretch in **[0.96, 1.04]** (spec: 3–6%).
- Nothing tied to gender or race; no stereotypes; every pick independent from the name (spec §2.5).
- Skin stays the full-rainbow `SKINS` palette; sheets render neutral and are tinted at runtime, so the skin material's subsurface must stay **neutral in colour** (equal radii), or it would warm a mint skin.
- The outermost top carries the identity hue (`topColor`); agents wear no visor: `tell/eyes` and `tell/collar` glow in `topColor` (spec §2.2); no glasses, no facial hair.
- Figure scale stays **1.5** px per floor unit; ky **0.31**; run through `render_watch.py`.
- `officeArtBytes` rises only with a log entry in `docs/perf/web-live-baseline.md` (ADR 151/183).
- Each continuous surface is fused: no tube end, cap or seam visible at any joint in any clip.

## Review Focus

1. **Seated clips:** thighs in front of a top's hem, and the `@arms` overlay over the desk. Expected: the trousers show in front of the hem and the arms draw over the desk, as today. Task 4 adds the proxy holdouts, and Task 8's /live check covers `sit-type` and `sit-idle`.
2. **Long hair over the shoulders against hair behind the back.** Expected: hair behind the torso is hidden and hair falling in front shows over the top. Task 4 (the hair holdout proxy) and Task 7 (draw order test).
3. **A mirrored direction with a stretched figure.** Expected: the stretch scales about the floor point, so a flipped cell lands on the same anchor. Task 7 test.
4. **A layer whose sheet is missing** (a re-fit layer not yet rendered). Expected: that layer is skipped and the rest of the figure still draws, as today. Task 7 keeps the existing test green.
5. **A render hang mid-run.** Expected: the store resumes from the last call. Task 3's fused calls go into the store like any other.

---

### Task 1: Office-size stills for a look check

**Files:**
- Create: `packages/web/art/office/figure_stills.py`
- Modify: `packages/web/art/office/render.py` (`args`: `--stills <clip>:<frame>:<dir>,...`; `render_figure` writes stills instead of sheets when it is set)

**Interfaces:**
- Produces: `render.py --figure --stills idle:0:SE,... --out <dir> --scale <px>`. For each still it composites a fixed sample of eight members (names `ada bo cy dee eli fay gus hana`) through the runtime's draw order and tints. It reads the colours from `figure_stills.SAMPLE`, a table copied from `appearanceOf` for those names. It writes `<dir>/<clip>-<frame>-<dir>.png` at `--scale`, on the floor colour `#ebae64`, and `<dir>/sheet.png`, all stills side by side.

- [ ] **Step 1:** Implement the mode. It renders through the store, so stills taken during a full render cost nothing more.
- [ ] **Step 2:** Run it at `--scale 1.66` (retina /live) and `--scale 1.4` (broadcast). Expected: two `sheet.png` files, eight members each.
- [ ] **Step 3:** Commit: `feat(office): figure stills for an office-size look check (lane 01M5JHEEGT)`

### Task 2: The body's proportions and anatomy in `figure.py`

**Files:**
- Modify: `packages/web/art/office/figure.py` (constants block at the top; `build_figure` skin, head and leg parts)

**Interfaces:**
- Produces: the module constants `HEAD_R`, `HEAD_C`, `NECK`, `SHOULDER`, `HIP`, `KNEE`, `ANKLE`, `CHEST`, `THIGH`, `SHIN`, `UPPER_ARM`, `FORE_ARM`, `SHOULDER_W` (13.2·FIG), `HIP_W` (6.6·FIG), with `CROWN` unchanged. Skin parts carry the custom property `o["fuse"] = "skin"`; the head's skull, jaw, cheeks, nose, ears and lids carry `"head"`.

- [ ] **Step 1:** Derive the proportions. `R = lerp(9.4·FIG, HEIGHT/3.7/2, 0.25)`. Set `NECK = CROWN − 2.5·FIG − 2.06·R` and scale every vertical constant by `k = NECK_new / NECK_old`, so the crown holds. Arms are not shortened.
- [ ] **Step 2:** Rebuild the skin. The head is a skull, a narrower jaw, two cheeks, a small nose and ears. Eyes have a white, a gloss iris (roughness 0.15) and a skin lid over the top third; add brows and lips. The neck tapers. Arms taper: forearm wrist radius 2.05·FIG, elbow 2.65·FIG. Hands are a palm (2.6, 1.9, 3.3)·FIG plus a thumb. **Legs in skin:** thigh, knee and shin with the same tapers as the trousers, one unit inside them. The spike renders (`spike_real.py`, values in the spec §2) are the reference.
- [ ] **Step 3:** Run `python3 packages/web/art/office/render_watch.py -- --figure --stills idle:0:SE,idle:0:E,sit-type:2:E --out /tmp/fig-stills --scale 5 --ky 0.31` (the `--stills` mode from Task 1). Expected: the face has a jaw, eyes with lids and brows, and no ball head; hands are visible; legs are present under the trousers.
- [ ] **Step 4:** Commit: `git commit -m "feat(office): figure v2 body proportions and anatomy (lane 01M5JHEEGT)"`

### Task 3: Fused surfaces in `render.py`

**Files:**
- Create: `packages/web/art/office/figure_fuse.py`
- Modify: `packages/web/art/office/render.py` (`render_figure`: after `apply_pose`/`place_props`, before each call's render; `FIG_PIPELINE` → 2)

**Interfaces:**
- Produces: `fuse_groups(rig: Rig, visible: set[str]) -> list[bpy.types.Object]`. For each fuse group with two or more visible parts, it builds one fused copy (parts duplicated, modifiers applied, joined, voxel remesh, Laplacian smooth without volume-preserve, smooth-shaded), hides the originals from render, and returns the copies. Also `unfuse(copies)`, which deletes the copies and unhides the originals.
- Parameters (pinned by the spike): voxel 0.3 for `head`, 0.4 for `skin`, 0.35 for hair, 0.5 for cloth; Laplacian λ 0.6, iterations 12 / 20 / 10 / 18 respectively. A copy keeps its source's `layer` and `arm` properties, so the ID pass still splits it.

- [ ] **Step 1:** Write `figure_fuse.py` with the two functions. A copy's material is the group's first part's material.
- [ ] **Step 2:** In `render_figure`, wrap each call: `copies = fuse_groups(rig, visible)` → render → `unfuse(copies)`. The call key stays computed from the **originals**, before fusing. Bump `FIG_PIPELINE` to 2, because what a render's pixels become has changed.
- [ ] **Step 3:** Run the stills command from Task 2 Step 3. Expected: no seam at the shoulder, elbow, hip or knee in any still. Time one lit call (`time` around a single-call run). Record the per-call seconds; the full-render estimate is `calls × seconds`.
- [ ] **Step 4:** Commit: `feat(office): fuse each figure surface before it renders (lane 01M5JHEEGT)`

### Task 4: The skin-only base and holdout proxies

**Files:**
- Modify: `packages/web/art/office/figure.py` (`BASE_LAYERS`, `ARM_LAYERS` if needed); `packages/web/art/office/render.py` (`holdout_for`)

**Interfaces:**
- Produces: `BASE_LAYERS = ["skin", "visor"]`. `bottom` and `shoes` become variant layers, rendered alone like a top.
- The rule `holdout_for(layer) -> set[str]`: always the base, plus a proxy for each category that can be in front of the layer:
  - tops: base + `bottom` (seated thighs in front of the hem);
  - hair, facial, hats, `acc/*`: base + `top/tee` (the torso hides hair behind the back);
  - `bottom`: base; `shoes`: base + `bottom`;
  - carry and lanyard: as today.

- [ ] **Step 1:** Change the two sets and the rule as above.
- [ ] **Step 2:** Run the stills (Task 1) with `sit-type:2:E,sit-type:2:N,idle:0:N`. Expected: the trousers show in front of the hem when seated; the long-hair sample (`hana`) shows no hair through the torso from the back (`N`).
- [ ] **Step 3:** Commit: `feat(office): skin-only figure base with holdout proxies (lane 01M5JHEEGT)`

### Task 5: Materials

**Files:**
- Modify: `packages/web/art/office/figure.py` (`grey`, and the materials made in `build_figure`)

**Interfaces:**
- Produces:
  - skin: a neutral grey (0.8) with subsurface weight 0.35, radius **(1, 1, 1)** (neutral; see Global Constraints), scale 1.2;
  - cloth: `scene.fabric` in neutral grey (weave 1.4; denim 3.0);
  - hair: grey with a wave-texture bump (scale 1.6, distortion 6, strength 0.35) and roughness 0.5;
  - glasses frames, watch faces and buckles: roughness ≤ 0.3. Nothing else shiny.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Stills at 1.66. Expected: with the sample's tints, a mint skin stays mint (no warm cast); cloth shows a weave at 5× (`--scale 5`).
- [ ] **Step 3:** Commit: `feat(office): figure v2 materials (lane 01M5JHEEGT)`

### Task 6: Today's wardrobe re-fitted

**Files:**
- Modify: `packages/web/art/office/figure.py` (hair, facial, tops, bottom, shoes, hats, accessories, visor, lanyard and props in `build_figure` and `build_props`)

**Interfaces:**
- Consumes: Task 2's constants; every piece positioned from them, not from literals.
- Produces: the same layer ids as today (`LAYERS` unchanged). Every piece fits the new body. Tops, bottoms and hair get fuse groups named `top/<cut>`, `bottom` and `hair/<style>`.

- [ ] **Step 1:** Re-fit every piece. Hair caps sit above the skull, so no scalp shows. The visor is centred on the new eyes. Held props sit at the new hand positions.
- [ ] **Step 2:** Stills over all eight samples and the carrying clips (`walk-hold2:3:SE,idle-hold1:0:E,sit-hand:0:E`). Expected: no clipping, no floating piece, and props in the hands.
- [ ] **Step 3:** Show nick the 1.66 and 1.4 `sheet.png` next to today's figure. **Gate: his yes before Task 8.**
- [ ] **Step 4:** Commit: `feat(office): today's wardrobe re-fitted to the v2 body (lane 01M5JHEEGT)`

### Task 7: Draw order and build stretch in the runtime

**Files:**
- Modify: `packages/web/src/live/office-scene/appearance.ts` (`Appearance.build`, `appearanceOf`)
- Modify: `packages/web/src/live/office-scene/rendered/figure.ts` (`layersFor` order, `drawFigureFrame` stretch)
- Test: `packages/web/src/live/office-scene/appearance.test.ts`, `packages/web/src/live/office-scene/rendered/figure.test.ts`

**Interfaces:**
- Produces: `Appearance.build: number`, picked from `[0.96, 0.98, 1.0, 1.02, 1.04]` with salt `15` (unused today). `layersFor` back to front: `skin`, `shoes`, `bottom`, `top/*`, carried, lanyard, `hair/*`, `facial/*`, `hat/*`, `acc/*`, `visor`. `drawFigureFrame` scales each layer's destination width by `look.build` about the floor point.

- [ ] **Step 1: Write the failing tests**

```ts
// appearance.test.ts
it('gives everyone a build within 4% of the base, stable per name, and varied', () => {
  const builds = names.map((n) => appearanceOf({ name: n, kind: 'human' }).build);
  expect(builds.every((b) => b >= 0.96 && b <= 1.04)).toBe(true);
  expect(appearanceOf({ name: 'ada', kind: 'human' }).build).toBe(appearanceOf({ name: 'ada', kind: 'human' }).build);
  expect(new Set(builds).size).toBeGreaterThan(2);
});
// figure.test.ts — replaces the two order tests above it
it('draws shoes and trousers under the top, and hair over it', () => {
  expect(layersFor(femme, 'human', '#3366cc').map((l) => l.id)).toEqual([
    'skin', 'shoes', 'bottom', 'top/hoodie', 'hair/bun', 'acc/glasses',
  ]);
});
it('a stretched figure keeps its floor point, mirrored or not', () => {
  // build 1.04: each drawImage's dest width is c.sw*k*1.04 and dest x is p.x - (anchor.x - ox)*k*1.04
  // (flipped cells: the translate is p.x - (anchor.x - ox)*k*1.04 + c.sw*k*1.04)
});
```

- [ ] **Step 2:** Run `pnpm --filter @musterd/web exec vitest run src/live/office-scene/appearance.test.ts src/live/office-scene/rendered/figure.test.ts`. Expected: FAIL (no `build`; old order).
- [ ] **Step 3:** Implement. Fill in the stretch test's assertions against `recordingCtx`'s recorded `drawImage` and `translate` calls, the way the existing draw tests read them.
- [ ] **Step 4:** Run the same command. Expected: PASS, along with the rest of both files (missing-sheet skip, tint, arms overlay).
- [ ] **Step 5:** Commit: `feat(office): v2 figure draw order and per-member build stretch (lane 01M5JHEEGT)`

### Task 8: The full render, /live check, bytes and PR

**Files:**
- Modify: `packages/web/src/live/office-scene/rendered/assets/**` (sheets, `figure.json`); `docs/perf/budgets.json`; `docs/perf/web-live-baseline.md`; `packages/web/art/office/README.md` (proportions, base, fusing, stills, measured render time)

- [ ] **Step 1:** Run the full render overnight, after nick's yes in Task 6: `python3 packages/web/art/office/render_watch.py -- --figure --out packages/web/src/live/office-scene/rendered/assets --scale 1.5 --ky 0.31`. Expected: `figure: … 37 layer sheets, figure.json`.
- [ ] **Step 2:** Check in /live (`pnpm dev` → `http://localhost:5174/live?office=rendered`): standing, walking, `sit-type`, a carrying walk and the seated overlay. nick looks.
- [ ] **Step 3:** Measure: `stat -f %z` over `office-art-*`, summed. If the total is over 8,420,000 B, raise `officeArtBytes` to measured + 15% and log it with the before/after table, as the 2026-10-22 entries do.
- [ ] **Step 4:** Run the fast gates (`pnpm typecheck && pnpm lint && pnpm format:check`), open the PR with `Lane \`01M5JHEEGT55EDJYG51H6ZAQVJ\`.` first, and arm auto-merge.

### Task 9 (v2-2): Tops upgraded

**Files:** `packages/web/art/office/figure.py` (tops), the assets, the perf log.

- [ ] Add detail to the five tops, at the spec §2.4 level:
  - **tee:** a sleeve hem band, a neck rib;
  - **long:** cuffs;
  - **stripe:** stripes following the fused surface;
  - **hoodie:** a hood, a ribbed hem and cuffs, drawstrings with aglets, a pocket;
  - **vest:** armholes with a band.
- [ ] Run stills, nick looks, then a full `--figure` run. Expected in the log: only `top/*` calls render, every other call is `reused`.
  - _(2026-10-26, lane 01M5JHEGY8)_ Wrong by 5×: the tee is the holdout torso for every hair, facial, hat, accessory, carry and lanyard call (`holdout_for` in `render.py`), so a tee change re-renders 24 of 32 layers a frame — measured on `g-wave:0:E` at 1.5: 24 rendered, 8 reused. Budget a tee change as a full render (~5 h at 1.5), or first give the pipeline a holdout torso of its own; hair, facial hair, hats and accessories hold nothing else out, so v2-3 and v2-4 stay small.
- [ ] Bytes as in Task 8 Step 3; PR as in Task 8 Step 4, with `Lane \`01M5JHEGY8S4BSJDWS1M6SYZMG\`.`.

### Task 10 (v2-3): Hair and facial hair, polished and relaxed

**Files:** `figure.py` (`HAIR`, `FACIAL`, their geometry). `appearance.ts` gains nothing until v2-5; new styles render ahead of their picks.

- [ ] Rebuild the eight hair styles as sculpted clumps, as in the spike.
- [ ] Add the relaxed and polished styles: side-part, slicked-back, messy, curly, loose waves, a neat bob and a messy bob.
- [ ] Facial hair: trimmed and untrimmed beards, stubble, a moustache.
- [ ] Each new style is a new `LAYERS` entry; `wornLayers` loads it only when worn.
- [ ] Expected in the log: only `hair/*` and `facial/*` calls render.
- [ ] PR with `Lane \`01M5JHEK4HNPFY7XC3RKQWJFV9\`.`.

### Task 11 (v2-4): Hats and accessories

- [ ] Upgrade the cap, beanie, band, glasses, headphones and scarf.
- [ ] Add earrings (stud, hoop), a headband, a watch, a bracelet, headphones around the neck, and two more glasses frames (square, thin metal).
- [ ] Layer ids: `acc/<name>`; `hat/headband`.
- [ ] Expected in the log: only those layers render.
- [ ] PR with `Lane \`01M5JHENHB2ACVDJ767XP0RH8X\`.`.

### Task 12 (v2-5): Picks, after the painted office is gone

**Files:** `appearance.ts`, `appearance.test.ts`, `rendered/figure.ts`, `rendered/figure.test.ts`, `figure.py` (outer layers and the first new pieces).

- [ ] **Tests first.** In `appearance.test.ts`:
  - `presents` is gone;
  - over 400 names, a long-hair style and facial hair co-occur at least once, and so do a dress or skirt and facial hair;
  - each of style, grooming and each accessory spot is independent of skin (the existing correlation test's method);
  - the dnd look sets the ears spot to `headphones-on`, and `headphones-neck` moves to the ears;
  - no single non-`none` piece is worn by more than 25% of names.

  In `figure.test.ts`: an outer layer draws after the top and takes `topColor`; the top under it takes a free colour.
- [ ] **Appearance fields:**
  - `style: 'formal' | 'smart' | 'casual' | 'athletic'`;
  - `grooming: 'polished' | 'relaxed'`;
  - spots `eyes`, `ears`, `wrist`, `head`, `neck` (each a piece or `'none'`);
  - `outer: OuterCut | 'none'`;
  - `top`, `bottom` and `shoes` pieces chosen from the style's pool.

  Salts 16–25.
- [ ] Render the outer layers and the first pieces of each style; stills; nick looks.
- [ ] PR with `Lane \`01M5JHERVT03C6VDN13M8FE3NK\`.` and a line saying every member's look changes.

### Task 13 (v2-6): The one-piece layer and dresses, then more pieces

- [ ] **Test first** (`figure.test.ts`): a member wearing `onepiece/<cut>` gets no `top/*` and no `bottom` layer, and the one-piece takes `topColor`.
- [ ] **Render one dress first.** Holdout: the base plus no proxies; the seated `@arms` cells come from its sleeves. Stills: seated and walking.
- [ ] Then add more pieces per style, a few per PR, each with stills, nick's look and a bytes entry.
- [ ] PR with `Lane \`01M5JHEV51D8G1FKGSNVK9CJ81\`.`. Further PRs reuse the lane, or open a follow-up lane named in the closing `follows_up`.

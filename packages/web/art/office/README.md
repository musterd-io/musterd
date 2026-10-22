# The office's pre-rendered art

Source for the images the `/live` and `/broadcast` office draws when `?office=rendered` is on
(office realism, [spec](../../../../docs/superpowers/specs/2026-10-20-office-realism-design.md),
[plan](../../../../docs/superpowers/plans/2026-10-20-office-realism.md)). Nothing here ships: only
the PNGs and `manifest.json` it writes into `packages/web/src/live/office-scene/rendered/assets/`
do. Blender is an **art tool**, not a runtime dependency (hard rule 6 is untouched).

## Files

- `scene.py` — builds the room in Blender from the same numbers `layout.ts` uses: furniture, lights,
  and the orthographic corner camera that matches `iso.ts`. A script, not a saved `.blend`, so the
  scene is text that diffs; `--save` writes a `.blend` to open in the UI.
- `render.py` — renders every object in the `export` collection alone, from the one camera, film
  transparent, crops each to its alpha bounds and writes `manifest.json` (file, size, anchor, px per
  floor unit, camera KX/KY). `manifest.ts` is the TypeScript side of that contract.

## Rendering

Install Blender (the art machine, never CI): `brew install --cask blender`. Rendered with
**Blender 5.2.2 LTS** on 2026-10-20; EEVEE; the script uses only `bpy`, `mathutils` and the
`numpy` Blender bundles.

```sh
/Applications/Blender.app/Contents/MacOS/Blender -b --python packages/web/art/office/render.py -- \
  --out packages/web/src/live/office-scene/rendered/assets --scale 3
```

`--scale` is px per floor unit at 2× (spec §5: sharp for the 1080p broadcast at DPR 1 and `/live`
at DPR 2; the canvas downsamples smaller fits). `--ky` sets the camera's vertical ratio (today's
isometric `0.35355339`; increment 2's corner camera passes its own, and `iso.ts` must carry the
same number — the manifest records it so the two cannot drift silently). `--save <file.blend>`
also writes the scene for the UI. `--only desk/fan-0,desk/fan-1` re-renders just those assets and
keeps every other manifest entry on disk — minutes, not the ~10 the whole room takes.

Commit the outputs. `pnpm perf:check` sums `dist/client/assets/office-art-*.png` against
`officeArtBytes` in `docs/perf/budgets.json`; a raise is logged in
`docs/perf/web-live-baseline.md` (ADR 151).

Two things keep the set small (10 MB → ~1 MB, increment 2): every `room/*` layer is **box-filtered
to half the item resolution** before it is cropped (`SHELL_DOWNSAMPLE`; the manifest's per-asset
`scale` records it, so `blit.ts` needs no special case), and every PNG is **palette-quantized with
pngquant** when it is on PATH (`brew install pngquant`; without it the script says so and the files
are two to three times bigger). Both are lossy in a way nobody can see at the panel's scale, and
both are the render script's business, not the runtime's.

## What is rendered (increment 2)

- **The shell**, `room/light-<day|evening|night>`: floor, both back walls, windows and skirting, all
  together, under one light rig per day state (`LIGHT_STATES` in `scene.py`: sun, fill, world, what
  the panes emit, the window spots that pool light on the floor). `roomState.ts` crossfades the two
  nearest over 45 minutes at each edge (07:00, 16:30, 19:00).
- **The ceiling bank**, `room/ceiling-<on|spill>`: the night shell rendered with the four area lights
  on, minus the same render with them off — an **additive** layer the canvas draws with
  `globalCompositeOperation = 'lighter'` over any day state. `spill` is the same at 42%. There is no
  `off` image; off is nothing.
- **Every static item** once, at the floor's centre, blitted wherever `layout.ts` puts one: desks (two
  orientations), the bench, plants, shelves, the entrance, the nook set, reception, the meeting
  table and chairs, the printer, the rugs. Each carries its own soft contact shadow.
- **Per-desk overlays**: `desk/lamp-off`, `desk/lamp-on` (the lit one with its pool on the slab) and
  `desk/fan-0..3` (the blades a quarter-turn apart); `drawWorkstation` picks by the desk's live state.

Items are rendered under the day rig; at evening and night the painted veil does to them what it
always did, and `figureTintFor` carries the same curve to the figures of increment 3.

## Projection

`iso.ts` projects `x = (lx − ly)·KX`, `y = (lx + ly)·KY − lz` and lifts heights 1:1 (no
foreshortening). The camera sits at azimuth 45° (viewer at +x +y) and elevation
`asin(KY / KX)` (30° today), and `scene.py` stretches every height by `1 / cos(elev)` so a rendered
desk lands on the painted desk's pixels. A rendered asset's `anchor` is where its floor origin
projects inside the crop; `blit.ts` puts that point on `project(lx, ly, fit)`.

## The figure (increment 3)

```sh
/Applications/Blender.app/Contents/MacOS/Blender -b --python packages/web/art/office/render.py -- \
  --figure --out packages/web/src/live/office-scene/rendered/assets --scale 2 --ky 0.31
```

`figure.py` builds the member from `skeleton.ts`'s proportions (96 tall, five heads): rigid parts
parented to an Empty at each joint — no armature, no weights — and an **action** is a function of
the clip's phase that sets joint rotations (`action(name, t)`). The eight first-cut clips (`CLIPS`:
idle, walk, sit-type, sit-idle, speak, turn, sit-down, stand-up) are hand-keyed there at 12 fps.
The plan named Mixamo's auto-rigger; it is a browser service behind an Adobe login — a human step
the pipeline cannot run — and a stock Mixamo walk is the "some game's character" the spec rules
out, so the rig is text that diffs instead. (Decision recorded 2026-10-20, lane 01M5D8F93K.)

Five directions are rendered — E, SE, N, NE, NW — and three are mirrored from them: S from E,
W from N, SW from NE. A horizontal flip in the canvas's frame swaps `lx` and `ly` (screen-right is
+lx −ly), which is why the mirror of east is south, not west; SE and NW face straight down and
up the screen and are their own mirrors.

Each layer's frames are **packed into an atlas, cropped to their own pixels** (`cells` in
`figure.json`: atlas rect plus the cell's offset inside the nominal frame), not laid out as a
grid: a glasses frame is a few hundred pixels, not a whole 112×208 cell, and 27 grid sheets would
decode to about 2 GB in the browser. Tinting happens per frame on one scratch canvas at draw
time; a tinted copy of a whole sheet per member colour is never made.

Every mesh carries the **layer** its pixels belong to (`LAYERS`: skin, one per hair style, facial
hair, hat, top cut, accessory, bottom, shoes, visor, and the carried things below). Per frame the renderer draws the base body
(skin, bottom, shoes, visor) twice — lit, neutral grey, and as flat ID colours, no anti-aliasing —
and splits the lit pixels by ID; then each variant alone, with the body as a **holdout**, so a
hand in front of a hoodie keeps its pixels and the hoodie has a hand-shaped hole. `figure.ts`
can therefore draw the layers in any order and occlusion is already right. The sheets are
`office-art-fig-<layer>.png`: one row per (clip, direction) — directions clockwise from E, as
`figureSheet.ts`'s `DIR8` — one column per frame; `figure.json` is the `SheetSpec` plus the file
per layer. Sheets are neutral grey; `appearance.ts` tints them at draw time (`tint.ts`), and the
visor keeps its own colour. The base clips — 265 frames × (2 + 23) renders at 2 px/unit — took 77
minutes on the shared laptop (2026-10-21).

### Gestures (increment 3b)

Every beat the painter plays (`skeleton.ts` `applyOverlays`) has a clip, `g-<beat>`, hand-keyed in
`figure.py` `GESTURES` (and `_seq` for the beats with motion of their own). Two kinds keep the
frames down:

- **env** — the clip is the beat's envelope from rest to peak, six frames. `character.ts`
  `gestureFrame` maps the beat's own envelope (arc, hold, rise, fall) onto it, so a beat that goes
  out and comes back costs half the frames and plays at any length. `take` is `reach` played back.
- **seq** — scratch, sip, swivel, shoulder roll, eat and wave carry their own motion inside the
  window, so their eight or ten frames sample the window itself.

A gesture is only ever seen facing a desk or a fixture, so it is rendered E and N and mirrored to S
and W (`dirs` in `figure.json`); in any other direction, or in the wrong posture, the base clip
plays.

### Carried things and the seated overlay (plan Task 16)

What a member carries is its own layer, `carry/<thing>` (laptop, box, plant, plate, card, mug,
bottle, phone), plus `lanyard` and `lanyard-card` for a first arrival's badge. A prop is not
jointed: after a frame is posed, `place_props` stands it at the hands — upright, turned with the
body — the way the painter's `drawCarry` reads the solved wrists (a rigid child of the wrist would
tip a mug upside down at the top of a sip). Each prop renders only on the clips that carry it, so
the rest of the sheet costs it nothing, and it is rendered with the body *and a torso* as the
holdout, so a hand in front of a box cuts it. The moving box is `carry/box` in kraft with
`carry/plant` in it; the box and the mug are neutral grey and tinted, everything else keeps its own
colour.

Carrying changes the arms, so five clips carry the painter's carry overlays: `walk-hold2` and
`idle-hold2` (both hands at the chest: a box, a plate), `walk-hold1` and `idle-hold1` (the right hand
out in front: the card, a mug, a bottle) and `walk-call` (the phone at the ear on a pacing call).
`character.ts` `animFor` picks them from the pose's carry. The frame is 72 units wide for them — a
held-out hand reaches ~30 from the floor point and clipped at 56.

A desk paints over a member sitting behind it, but their forearms rest on it. For the seated clips
the ID pass also marks every mesh on a shoulder, elbow or wrist joint (the green byte), and each of
`ARM_LAYERS` (skin, the tops' sleeves, a mug or plate held at the desk) packs those pixels into its
own atlas a second time as `<layer>@arms` cells. `drawFigureFrame(part: 'arms')` draws only those,
in the overlay slot over the desk slab, as the painter's `armsOnly` pass does.

### Re-rendering part of the figure

`--clips g-sip,g-wave` renders only the named clips and takes every other clip's frames back out of
the atlases on disk — a change to one beat is minutes, not the whole figure. `--only <layer>,…`
does the same along the other axis (a hair style, a top). Change the body itself (`skin`) and
every layer's holdout changes, so that one is the full render.

## Original art

Everything in this folder is ours. No game's assets, palettes or character designs are referenced
(spec §5).

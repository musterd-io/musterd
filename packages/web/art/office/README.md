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
also writes the scene for the UI.

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

## Direction renders (increment 3)

Figures are rendered as sprite sheets, 8 directions × actions. The plan evaluates the free
omnidirectional isometric render add-on (itch.io, 2025) and the open-source
Blender-Isometric-Renderer before scripting that part; the rig comes from Mixamo's auto-rigger with
our own gestures hand-keyed. Record the choice here when it is made.

## Original art

Everything in this folder is ours. No game's assets, palettes or character designs are referenced
(spec §5).

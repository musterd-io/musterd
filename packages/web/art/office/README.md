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

# 746 — The office projects through the camera the art was rendered at

- Status: accepted
- Date: 2026-10-28

## Context

The office is pre-rendered in Blender. The shell (floor and walls) is one image, and every item is blitted at the point `layout.ts` gives it, through `iso.ts` `CORNER_CAMERA`. Both paths are meant to share one camera. `render.py` is run with `--ky 0.31`, and `CORNER_CAMERA.ky` is 0.31.

nick, 2026-10-28: the front door "doesn't extend all the way down to the floor". On the served office at 1440 its posts ended about 12 px above the left wall's skirting.

## Problem

The two paths don't share a camera. `scene.py` `camera()`, `figure.figure_camera` and `dog.dog_camera` set the camera's height as `dist * sin(elev) * zs`. `zs` is the stretch applied to heights, so they draw 1:1. Multiplying the camera position by it tilts the camera steeper than asked. A request for ky 0.31 renders through `KX * sin(atan(tan(elev) * zs))` = **0.33729**.

The runtime projected at 0.31, so the logical floor was about 8% flatter than the baked one. The two agree at the back corner and drift apart toward the edges, by up to about 48 floor units. Measured on `room/light-day`, the skirting sat 5, 4, 12, 20 and 25 px (at scale 1.5) below where 0.31 put it at ly 100, 300, 500, 700 and 815. The floor's front corner baked at y 1202, where 0.31 put it at 1129. Each item's own sprite is consistent, because its contact shadow is baked in. The mismatch only shows where an item meets the shell: the door against its wall, and the café counter and cooler standing off theirs.

## Decision

The runtime projects through the camera the art was actually rendered at. `CORNER_CAMERA.ky` is 0.33729.

`scene.effective_ky(ky)` computes it. `render.py` records it as `manifest.json`'s camera, so the manifest states what the pixels are, and the runtime's existing camera check compares like with like.

The camera code itself is not changed. Fixing it would change every asset: the shell, about 100 items, the figure (a 3 h 30 min render) and the dog. Every command keeps passing `--ky 0.31`. The art README says why.

## Consequences

No asset is re-rendered, and every shipped pixel stays the same. On screen the room is about 8% taller, and anything placed on the floor now lands on the baked floor beneath it. The door stands on its skirting. The kitchenette sits against its wall. A member at the room's edge stands on the planks under their feet, not up to 48 units off them.

Rendered heights stay 2.2% short of 1:1 (`zs * cos(actual elev)` = 0.978), as they have been since increment 2. Nothing places a painted overlay against a rendered height closely enough for that to show.

Screen-space checks in `layout.test.ts` (`MIN_SPOT_GAP`) run at the new camera and stay green.

## Observability & Evaluation

Traces: none. This is a projection constant.

Eval: the dataset is the before/after captures on `office-preview` at 1440. A debug line drawn at the logical wall foot (lx 0, ly 0) sat 12–25 px above the baked skirting at 0.31 and runs along it at 0.33729. The measurements in Problem are reproducible from `room/light-day` with the projection above.

Experiment: none. If an item drawn against the shell drifts again, check `manifest.json`'s camera against `CORNER_CAMERA` before changing a placement.

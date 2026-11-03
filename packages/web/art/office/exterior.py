"""The world outside the windows (window views, spec 2026-11-02, lane 01M6ENGW2H).

One low-poly exterior per setting, built behind a back wall and rendered through an orthographic
camera that looks OUT through one pane: the plate is land only — buildings, sea, hills — on a
transparent sky, with no sun or moon disc (the runtime paints the sky on the continuous clock and the
discs as sprites). Lit by the shell's own rig (`scene.lights`), so a face the room's sun lights is lit
here too. The two back walls face 90° apart, so each wall gets its own view of the same scene.

Only `bpy` and `mathutils`, like `scene.py`; `render.py` drives it with `--exterior <setting,…>`.
"""
from __future__ import annotations

import math

import bpy
from mathutils import Vector

import scene
from scene import FLOOR, WALL_H, srgb

SETTINGS = ("city", "coast", "mountain")
MARGIN = 0.04  # of the pane span, each side — slack for the crop

# city palette: a far row in haze, a near row in its own colour, lit windows for the night state
CITY_FAR = srgb("#9aa3b4")
CITY_NEAR = srgb("#5a6070")
CITY_ROOF = srgb("#8d94a3")
CITY_LIT = srgb("#ffd27a")
# coast: sea, sand, a headland in haze, a white lighthouse with a red band
SEA = srgb("#3f8fa3")
SAND = srgb("#e3d3ae")
HEADLAND = srgb("#7d8f86")
LIGHTHOUSE = srgb("#f2efe6")
LIGHTHOUSE_BAND = srgb("#c8403a")
ROCK = srgb("#5c5a55")
# mountain: a meadow, three ridges near → far (darker → hazier), snow, a timber cabin
MEADOW = srgb("#6f8f5a")
RIDGE = [srgb("#4f6b4e"), srgb("#6c7f8d"), srgb("#9aa7b8")]
SNOW = srgb("#f4f6fa")
CABIN = srgb("#6b4a2e")
CABIN_ROOF = srgb("#3d3a36")

# The pane frames z = u0·WALL_H … u1·WALL_H (64 … 154 for both panes); the camera looks straight out,
# so a horizontal plane is edge-on. Ground that must *show* — sea, sand, meadow — is a gentle ramp
# rising with distance, which in this view reads as a flat expanse ending at a horizon.
HORIZON_Z = 98.0


def _frame(which: int):
    """Axis helpers for one wall: `a` runs along the wall (t·FLOOR), `d` runs OUT from it (>0 is outside)."""
    if which == 0:  # the lx=0 wall: outside is x < 0; along is +y
        return lambda a, d: (-d, a)
    return lambda a, d: (a, -d)  # the ly=0 wall: outside is y < 0; along is +x


def _place(which: int, zs: float, col):
    """A block in wall space: centre `a` along, `d` out, size `w` (along) × `dd` (out) × `h` (up) from `z0`."""
    to_xy = _frame(which)

    def place(name: str, a: float, d: float, z0: float, w: float, dd: float, h: float, mat) -> bpy.types.Object:
        cx, cy = to_xy(a, d)
        sx, sy = (dd, w) if which == 0 else (w, dd)
        o = scene.box(name, cx, cy, z0, sx, sy, h, mat, zs)
        for c in list(o.users_collection):
            c.objects.unlink(o)
        col.objects.link(o)
        return o

    return place


def _lit(name: str) -> bpy.types.Material:
    """A window quad that glows at night only — `set_lit` turns it up per state."""
    return scene.glow(name, CITY_LIT, strength=0.0)


def set_lit(state: str) -> None:
    """The lit-window material follows the day state: off by day and evening, on at night."""
    m = bpy.data.materials.get("view-lit")
    if not m:
        return
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Emission Strength"].default_value = 2.4 if state == "night" else 0.0


def build_exterior(setting: str, which: int, zs: float) -> list[bpy.types.Object]:
    """The land outside wall `which`, in its own `exterior` collection; returns the objects to render."""
    col = scene.collection("exterior")
    place = _place(which, zs, col)
    objs: list[bpy.types.Object] = []
    if setting == "city":
        objs += _city(place, which)
    elif setting == "coast":
        objs += _coast(place, which, zs, col)
    elif setting == "mountain":
        objs += _mountain(place, which, zs, col)
    else:
        raise SystemExit(f"exterior.py: unknown setting {setting!r} (one of {SETTINGS})")
    return objs


def _adopt(o: bpy.types.Object, col: bpy.types.Collection) -> bpy.types.Object:
    for c in list(o.users_collection):
        c.objects.unlink(o)
    col.objects.link(o)
    return o


def _ramp(name: str, which: int, a0: float, a1: float, d0: float, d1: float, z0: float, z1: float, mat, zs: float, col) -> bpy.types.Object:
    """A quad rising from z0 at d0 to z1 at d1 across a0…a1: ground that shows in a horizontal view."""
    to_xy = _frame(which)
    verts = [(*to_xy(a, d), z * zs) for a, d, z in ((a0, d0, z0), (a1, d0, z0), (a1, d1, z1), (a0, d1, z1))]
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], [(0, 1, 2, 3)])
    me.update()
    o = bpy.data.objects.new(name, me)
    o.data.materials.append(mat)
    bpy.context.scene.collection.objects.link(o)
    return _adopt(o, col)


def _ridge(name: str, which: int, pts: list[tuple[float, float]], d: float, bottom: float, zig: float, mat, zs: float, col, floor: float | None = None) -> bpy.types.Object:
    """A ridge line as a vertical strip down to `bottom`: `pts` are (a, z) peaks and valleys; every
    other point sits `zig` further out, so the faces alternate facing ±a and the sun lights one
    flank of each peak. With `floor` (snow caps) the line is clipped where it crosses that height,
    the strip's bottom is the floor, and there is no zig — the caps sit flat just in front."""
    to_xy = _frame(which)
    if floor is not None:
        line: list[tuple[float, float, float]] = []
        for k in range(len(pts) - 1):
            (a0, z0), (a1, z1) = pts[k], pts[k + 1]
            if z0 >= floor:
                line.append((a0, z0, d))
            if (z0 - floor) * (z1 - floor) < 0:
                t = (floor - z0) / (z1 - z0)
                line.append((a0 + t * (a1 - a0), floor, d))
        lo = floor
    else:
        line = [(a, z, d + (zig if k % 2 else 0.0)) for k, (a, z) in enumerate(pts)]
        lo = bottom
    verts = []
    faces = []
    for k, (a, z, dd) in enumerate(line):
        verts.append((*to_xy(a, dd), z * zs))
        verts.append((*to_xy(a, dd), lo * zs))
        if k:
            faces.append((2 * k - 2, 2 * k - 1, 2 * k + 1, 2 * k))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    o = bpy.data.objects.new(name, me)
    o.data.materials.append(mat)
    bpy.context.scene.collection.objects.link(o)
    return _adopt(o, col)


def _skyline_pts(rnd, base: float, lo: float, hi: float, step: float) -> list[tuple[float, float]]:
    """Peaks and valleys along the wall: a peak every `step`, a valley between, heights from `rnd`."""
    pts = []
    a = -160.0
    while a < FLOOR + 160:
        pts.append((a, base + lo + (hi - lo) * rnd() ** 1.2))
        pts.append((a + step * (0.4 + 0.3 * rnd()), base + lo * (0.3 + 0.4 * rnd())))
        a += step
    return pts


def _coast(place, which: int, zs: float, col) -> list[bpy.types.Object]:
    """Sea to the horizon, a sand strip below the sill, a headland in haze to one side, and — on
    wall 0 — a lighthouse on its rock inside the second pane (`windowSprites.ts` LIGHTHOUSE flashes
    its beacon at that pane position at night). Wall 1 gets a buoy and a pier end instead."""
    sea = scene.paint("view-sea", SEA, 0.35)
    sand = scene.paint("view-sand", SAND, 0.9)
    head = scene.paint("view-headland", HEADLAND, 0.9)
    rock = scene.paint("view-rock", ROCK, 0.9)
    white = scene.paint("view-lighthouse", LIGHTHOUSE, 0.6)
    band = scene.paint("view-lighthouse-band", LIGHTHOUSE_BAND, 0.6)
    lit = _lit("view-lit")
    sea_z = lambda d: 65 + (HORIZON_Z - 65) * (d - 70) / (1400 - 70)  # noqa: E731 — the sea ramp's height at d
    objs = [
        _ramp("sand", which, -200, FLOOR + 200, 30, 70, 58, 65, sand, zs, col),
        _ramp("sea", which, -200, FLOOR + 200, 70, 1400, 65, HORIZON_Z, sea, zs, col),
        # a darker band under the horizon, and a few pale wave lines, so the water has depth
        _ramp("sea-far", which, -200, FLOOR + 200, 1250, 1400, sea_z(1250) + 0.3, HORIZON_Z + 0.3, scene.paint("view-sea-far", srgb("#357f93"), 0.35), zs, col),
    ]
    pale = scene.paint("view-wave", srgb("#6fb0c0"), 0.4)
    for k, (d, w) in enumerate(((150, 24), (330, 34), (580, 50), (900, 70))):
        objs.append(_ramp(f"wave{k}", which, -200, FLOOR + 200, d, d + w, sea_z(d) + 0.4, sea_z(d + w) + 0.4, pale, zs, col))
    # the headland: two low domes on the horizon, inside the pane the lighthouse is not in
    ha = 0.37 * FLOOR
    for k, (da, rx, rz) in enumerate(((0, 80, 7), (70, 50, 5))):  # ortho: a dome shows at full size however far
        o = scene.ball(f"headland{k}", *_frame(which)(ha + da, 1200), sea_z(1200) - rz, rx, 60, rz, head, zs)  # centred at the waterline
        objs.append(_adopt(o, col))
    if which == 0:
        la, ld = 0.70 * FLOOR, 220.0  # pane 1 (t 0.58…0.78) → x = 0.6
        lx, ly = _frame(which)(la, ld)
        objs.append(_adopt(scene.ball("rock", lx, ly, 56, 16, 12, 9, rock, zs), col))
        objs.append(_adopt(scene.cyl("lighthouse", lx, ly, 64, 4.2, 3.2, 48, white, zs), col))
        objs.append(_adopt(scene.cyl("lighthouse-band", lx, ly, 86, 3.9, 3.7, 8, band, zs), col))
        objs.append(_adopt(scene.cyl("lantern", lx, ly, 112, 3.0, 3.0, 5, lit, zs), col))
        objs.append(_adopt(scene.cyl("lantern-cap", lx, ly, 117, 3.4, 1.0, 3, band, zs), col))
    else:
        bx, by = _frame(which)(0.40 * FLOOR, 180)
        objs.append(_adopt(scene.cyl("buoy", bx, by, 60, 2.0, 1.2, 5, band, zs), col))
        objs.append(place("pier", 0.66 * FLOOR, 95, 59, 60, 6, 2.5, rock))
        for k in range(5):
            objs.append(place(f"pile{k}", 0.66 * FLOOR - 26 + k * 13, 95, 55, 1.6, 1.6, 4.5, rock))
    return objs


def _mountain(place, which: int, zs: float, col) -> list[bpy.types.Object]:
    """A meadow rising to three ridges — near, mid, far — each paler with distance, snow above the
    snowline on the two far ones, and on wall 0 a cabin in the first pane (`windowSprites.ts` CABIN
    glows at that pane position at night). Deterministic: the LCG seeds the ridge lines."""
    meadow = scene.paint("view-meadow", MEADOW, 0.9)
    snow = scene.paint("view-snow", SNOW, 0.7)
    cabin = scene.paint("view-cabin", CABIN, 0.85)
    roof = scene.paint("view-cabin-roof", CABIN_ROOF, 0.9)
    lit = _lit("view-lit")
    rnd = _lcg(31 + which)
    objs = [_ramp("meadow", which, -200, FLOOR + 200, 30, 470, 57, 87, meadow, zs, col)]
    # peaks stay under z≈140 (the pane's top is 154): the sky must keep the upper third
    ridges = (("near", 440, 82, 6, 30, 60, 30), ("mid", 800, 86, 14, 40, 80, 40), ("far", 1200, 92, 20, 48, 100, 50))
    for k, (name, d, base, lo, hi, step, zig) in enumerate(ridges):
        mat = scene.paint(f"view-ridge-{name}", RIDGE[k], 0.9)
        pts = _skyline_pts(rnd, base, lo, hi, step)
        objs.append(_ridge(f"ridge-{name}", which, pts, d, 50, zig, mat, zs, col))  # down past the sill: no sky between valleys
        if k:
            objs.append(_ridge(f"snow-{name}", which, pts, d - 0.5, 50, 0, snow, zs, col, floor=base + lo + (hi - lo) * 0.6))
    if which == 0:
        ca, cd = 0.38 * FLOOR, 300.0  # pane 0 (t 0.28…0.46) → x = 0.56; the meadow is z≈76 there
        objs.append(place("cabin", ca, cd, 76, 16, 12, 9, cabin))
        objs.append(place("cabin-roof", ca, cd, 85, 19, 15, 2.5, roof))
        objs.append(place("chimney", ca + 5, cd, 87.5, 2, 2, 3.5, roof))
        for k in (-4.5, 4.5):
            objs.append(place(f"cabin-lit{k:+.0f}", ca + k, cd - 6.3, 78.5, 3.2, 0.4, 3.2, lit))
    else:
        for k in range(7):  # a stand of firs on the meadow's edge
            fa = 0.2 * FLOOR + k * 60 + 30 * rnd()
            fx, fy = _frame(which)(fa, 360 + 40 * rnd())
            objs.append(_adopt(scene.cyl(f"fir{k}", fx, fy, 80, 5.5 + 2 * rnd(), 0.3, 14 + 6 * rnd(), scene.paint("view-fir", srgb("#3c5a3a"), 0.9), zs, verts=8), col))
    return objs


def _city(place, which: int) -> list[bpy.types.Object]:
    """A skyline across the whole wall: a far row high and pale in haze, a near row lower and darker,
    both dense (a pane spans ~160 units; a block is 8–24), every block turned ~28° so the sun lights
    one face and leaves the other in shadow. Lit window quads on the near row's room-facing faces.
    Deterministic: a tiny LCG seeds the heights, so a re-render is the same skyline."""
    far = scene.paint("view-city-far", CITY_FAR, 0.9)
    near = scene.paint("view-city-near", CITY_NEAR, 0.85)
    roof = scene.paint("view-city-roof", CITY_ROOF, 0.9)
    lit = _lit("view-lit")
    ground = 8.0
    objs = []
    rnd = _lcg(7 + which)

    def row(prefix: str, d: float, depth: float, w_lo: float, w_hi: float, h_lo: float, h_hi: float, mat, gap: float, windows: bool):
        a = -120.0
        k = 0
        while a < FLOOR + 120:
            w = w_lo + (w_hi - w_lo) * rnd()
            h = h_lo + (h_hi - h_lo) * rnd() ** 1.4
            o = place(f"{prefix}{k}", a + w / 2, d, ground, w, depth, h, mat)
            o.rotation_euler = (0, 0, math.radians(28))
            objs.append(o)
            if windows:
                r = place(f"{prefix}{k}-roof", a + w / 2, d, ground + h, w + 1, depth + 1, 1.0, roof)
                r.rotation_euler = (0, 0, math.radians(28))
                objs.append(r)
                cols = max(1, int(w // 5))
                rows = max(1, int(h // 9))
                for rr in range(rows):
                    for c in range(cols):
                        if (rr * 7 + c * 3 + k) % 3 == 0:
                            wa = a + (c + 0.5) * (w / cols)
                            wz = ground + 3 + rr * (h - 5) / rows
                            q = place(f"{prefix}{k}-lit{rr}-{c}", wa, d - depth / 2 - 0.3, wz, 2.2, 0.4, 3.2, lit)
                            objs.append(q)
            a += w + gap
            k += 1

    row("far", 560, 60, 9, 22, 70, 150, far, 3, False)
    row("mid", 330, 50, 9, 20, 45, 110, far, 4, False)
    row("near", 150, 46, 10, 24, 28, 78, near, 5, True)
    street = scene.paint("view-city-street", srgb("#3a3d47"), 0.95)
    objs.append(place("street", FLOOR / 2, 300, ground - 6, FLOOR + 400, 700, 6, street))
    return objs


def _lcg(seed: int):
    """A tiny deterministic generator in [0, 1): the skyline must be the same on every render."""
    state = [seed * 2654435761 % 2**32]

    def nxt() -> float:
        state[0] = (1664525 * state[0] + 1013904223) % 2**32
        return state[0] / 2**32

    return nxt


def exterior_camera(which: int, t0: float, t1: float, u0: float, u1: float, zs: float) -> tuple[bpy.types.Object, float, float]:
    """An ORTHO camera inside the room, centred on the pane, looking out through wall `which`.
    Returns the camera and the frame's (width, height) in world units: the pane span plus `MARGIN`."""
    to_xy = _frame(which)
    a0, a1 = t0 * FLOOR, t1 * FLOOR
    z0, z1 = u0 * WALL_H * zs, u1 * WALL_H * zs
    w = (a1 - a0) * (1 + 2 * MARGIN)
    h = (z1 - z0) * (1 + 2 * MARGIN)
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    cam.name = f"exterior-{which}"
    cam.data.type = "ORTHO"
    cam.data.clip_start = 1.0
    cam.data.clip_end = 5000.0
    cam.data.ortho_scale = max(w, h)
    cx, cy = to_xy((a0 + a1) / 2, -40.0)  # 40 units inside the room
    cam.location = (cx, cy, (z0 + z1) / 2)
    tx, ty = to_xy((a0 + a1) / 2, 1000.0)
    target = Vector((tx, ty, (z0 + z1) / 2))
    cam.rotation_euler = (target - Vector(cam.location)).to_track_quat("-Z", "Y").to_euler()
    return cam, w, h


def remove_exterior() -> None:
    col = bpy.data.collections.get("exterior")
    if not col:
        return
    for o in list(col.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for cam in [o for o in bpy.data.objects if o.name.startswith("exterior-")]:
        bpy.data.objects.remove(cam, do_unlink=True)


def mirrors_on_read(which: int) -> bool:
    """A plate is stored with its pixels running t0 → t1 left to right (windowView.ts maps x along
    the wall). Looking out of wall 0 the camera's screen-right is +t already; looking out of wall 1
    it is −t, so that frame is flipped once. (Plates skip `crop_alpha`, which is where the room's
    frames get their mirror — see `project_px`.)"""
    return which == 1


__all__ = ["SETTINGS", "MARGIN", "build_exterior", "exterior_camera", "remove_exterior", "set_lit", "mirrors_on_read"]

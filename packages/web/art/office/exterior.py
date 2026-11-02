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
    else:
        raise SystemExit(f"exterior.py: setting {setting!r} is not built yet (increment 2)")
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
    """`crop_alpha` mirrors every frame left-to-right (see `project_px`). Looking out of wall 0 the
    camera's screen-right is +t, so that mirror would put t1 on the left; the plate is flipped once
    before the crop so the stored pixels run t0 → t1 for both walls. Wall 1's screen-right is −t, and
    the crop's mirror alone sets it right."""
    return which == 0


__all__ = ["SETTINGS", "MARGIN", "build_exterior", "exterior_camera", "remove_exterior", "set_lit", "mirrors_on_read"]

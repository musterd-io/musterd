"""The office, built in Blender from the same numbers `layout.ts` uses.

Run through `render.py` (never on its own): `build_scene()` makes the room, `camera()` the
orthographic corner camera that matches `iso.ts`, and every exportable item goes into the
`export` collection under the asset id the manifest will carry.

Why a script and not a saved .blend: the scene is a function of `layout.ts`, and a text file
diffs, reviews and regenerates; a .blend is a binary nobody can read in a PR. Save one from
`render.py --save` when you want to open the result in the Blender UI.

Projection (spec 2026-10-20 §2.2, plan Task 5): `iso.ts` projects a floor point as
  x = (lx - ly) * KX,  y = (lx + ly) * KY - lz
with KX = cos45 and KY = KX * sin(elev). Today's elev is 30 (KY/KX = 0.5). `lz` is NOT
foreshortened by cos(elev) — the painters lift by `h * scale` — so the Blender scene scales
every height by 1 / cos(elev) to land on the same pixels. The corner camera of increment 2
changes `KY` only; `camera()` takes the ratio.
"""

from __future__ import annotations

import math

import bpy
from mathutils import Vector

# ── layout.ts numbers ──────────────────────────────────────────────────────────────────────
FLOOR = 900
DESK_W = 100
DESK_D = 68
DESK_LEG_H = 29
DESK_SLAB = 7
DESK_UP = DESK_LEG_H + DESK_SLAB
LEG = 8
LEG_INSET = 6

# ── iso.ts projection ──────────────────────────────────────────────────────────────────────
KX = 0.70710678
KY_ISO = 0.35355339


def elevation(ky: float = KY_ISO) -> float:
    """Camera elevation (radians above the floor) for a given KY, from KY = KX * sin(elev)."""
    return math.asin(ky / KX)


def z_scale(ky: float = KY_ISO) -> float:
    """Heights are drawn 1:1 by the painters, so the scene stretches z by 1/cos(elev)."""
    return 1.0 / math.cos(elevation(ky))


# ── materials ──────────────────────────────────────────────────────────────────────────────
def matte(name: str, rgb: tuple[float, float, float], rough: float = 0.75) -> bpy.types.Material:
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Specular IOR Level"].default_value = 0.25
    return m


def srgb(hex6: str) -> tuple[float, float, float]:
    """`#rrggbb` → linear RGB, the way Blender's Base Color wants it."""
    def lin(c: float) -> float:
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (int(hex6[i : i + 2], 16) / 255 for i in (1, 3, 5))
    return (lin(r), lin(g), lin(b))


OAK = srgb("#a97a46")        # the painters' PAL.wood lit; the render carries its own shading
OAK_DARK = srgb("#6b4826")


# ── scene ──────────────────────────────────────────────────────────────────────────────────
def clear() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def collection(name: str) -> bpy.types.Collection:
    c = bpy.data.collections.get(name)
    if c is None:
        c = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(c)
    return c


def box(name: str, cx: float, cy: float, z0: float, w: float, d: float, h: float, mat, zs: float) -> bpy.types.Object:
    """An axis-aligned block: floor units in x/y, height stretched by `zs`. Origin at the floor point."""
    bpy.ops.mesh.primitive_cube_add(size=1)
    o = bpy.context.active_object
    o.name = name
    o.scale = (w, d, h * zs)
    o.location = (cx, cy, (z0 + h / 2) * zs)
    bpy.ops.object.transform_apply(scale=True)
    o.data.materials.append(mat)
    return o


def desk(asset_id: str, lx: float, ly: float, along_x: bool, zs: float, col: bpy.types.Collection) -> bpy.types.Object:
    """One workstation base — legs and slab (the bevelled lip is the render's own highlight)."""
    w, d = (DESK_W, DESK_D) if along_x else (DESK_D, DESK_W)
    oak = matte("oak", OAK)
    dark = matte("oak-dark", OAK_DARK)
    parts = [box(f"{asset_id}/slab", lx, ly, DESK_LEG_H, w, d, DESK_SLAB, oak, zs)]
    for sx in (-1, 1):
        for sy in (-1, 1):
            parts.append(
                box(f"{asset_id}/leg", lx + sx * (w / 2 - LEG_INSET), ly + sy * (d / 2 - LEG_INSET), 0, LEG, LEG, DESK_LEG_H, dark, zs)
            )
    # bevel the slab's top edges a little so the light catches them (the painters' "Delight D" lip)
    slab = parts[0]
    bev = slab.modifiers.new("bevel", "BEVEL")
    bev.width = 1.2
    bev.segments = 3
    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = slab
    bpy.ops.object.join()
    o = bpy.context.active_object
    o.name = asset_id
    # the origin is the asset's floor point — what the manifest's anchor is measured from
    bpy.context.scene.cursor.location = Vector((lx, ly, 0.0))
    bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
    for c in list(o.users_collection):
        c.objects.unlink(o)
    col.objects.link(o)
    return o


def lights() -> None:
    """One warm key from the window side (upper-left in the painted room), a cool fill, soft world."""
    bpy.ops.object.light_add(type="SUN", location=(0, 0, 400))
    key = bpy.context.active_object
    key.name = "key"
    key.data.energy = 3.0
    key.data.angle = math.radians(8)
    key.data.color = (1.0, 0.93, 0.82)
    key.rotation_euler = (math.radians(50), 0, math.radians(-120))
    bpy.ops.object.light_add(type="SUN", location=(0, 0, 400))
    fill = bpy.context.active_object
    fill.name = "fill"
    fill.data.energy = 0.9
    fill.data.angle = math.radians(40)
    fill.data.color = (0.82, 0.9, 1.0)
    fill.rotation_euler = (math.radians(35), 0, math.radians(60))
    world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = (0.9, 0.86, 0.8, 1.0)
    bg.inputs["Strength"].default_value = 0.35


def camera(ky: float, px_per_unit: float, zs: float) -> bpy.types.Object:
    """The orthographic corner camera: azimuth 45 (viewer at +x+y), elevation from `ky`.

    Frames the whole floor diamond plus wall headroom; `render.py` crops each asset from the full
    frame, so the camera never moves between assets and every anchor shares one frame.
    """
    elev = elevation(ky)
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    cam.name = "corner"
    cam.data.type = "ORTHO"
    cam.data.clip_start = 1.0
    cam.data.clip_end = 20000.0
    # full-frame extent in floor units: the diamond is 2*FLOOR*KX wide
    width_units = 2 * FLOOR * KX
    cam.data.ortho_scale = width_units
    dist = 3000.0
    cam.location = (
        dist * math.cos(elev) * math.cos(math.radians(45)) + FLOOR / 2,
        dist * math.cos(elev) * math.sin(math.radians(45)) + FLOOR / 2,
        dist * math.sin(elev) * zs,
    )
    target = Vector((FLOOR / 2, FLOOR / 2, 0.0))
    cam.rotation_euler = (target - Vector(cam.location)).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam
    return cam


def build_scene(ky: float = KY_ISO, px_per_unit: float = 3.0) -> dict[str, bpy.types.Object]:
    """Build everything increment 1 renders: one S/N desk and one E/W desk at the floor's centre."""
    clear()
    zs = z_scale(ky)
    export = collection("export")
    assets = {
        "desk/base": desk("desk/base", FLOOR / 2, FLOOR / 2, True, zs, export),
        "desk/base-ew": desk("desk/base-ew", FLOOR / 2, FLOOR / 2, False, zs, export),
    }
    lights()
    camera(ky, px_per_unit, zs)
    return assets

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

# ── layout.ts numbers (keep in step with layout.ts; the TypeScript is the source of truth) ────
FLOOR = 900
THICK = 22          # iso.ts: floor slab thickness
WALL_H = 188        # iso.ts: back-wall height
DESK_W = 100
DESK_D = 68
DESK_LEG_H = 29
DESK_SLAB = 7
DESK_UP = DESK_LEG_H + DESK_SLAB
LEG = 8
LEG_INSET = 6

PODS = [  # id, cx, cy, axis, size, rug fill, rug mark, weave
    (0, 215, 290, "ns", 4, "#93a9a4", "#75908a", "border"),
    (1, 560, 545, "ew", 4, "#97a7b8", "#7c8ca0", "stripes"),
    (2, 245, 560, "ew", 2, "#ab97a4", "#8b7683", "border"),
    (3, 455, 250, "ew", 1, "#a8ab8e", "#8c9070", "stripes"),
]
POD_RUG = (230, 250)        # along, across
POD_RUG_DUO = (170, 140)
POD_RUG_SOLO = (130, 120)
BENCH = dict(lx=320, ly=62, long=300, deep=30)
NOOK = (725, 175)
NOOK_RUG_R = 150
NOOK_RUG = ("#ce9256", "#b2743c")
LOUNGE = dict(
    fridge=dict(dx=-104, dy=-60, w=36, d=30, h=72),
    counter=dict(dx=-30, dy=-86, w=120, d=30, h=34),
    machine=dict(dx=-71, dy=-86),
    sink=dict(dx=-49, dy=-86),
    cooler=dict(dx=42, dy=-92, w=26, d=26, h=52),
    couch=dict(dx=6, dy=-4, len=108, dep=44),
    table=dict(dx=6, dy=86, w=56, d=40),
)
MEETING = dict(lx=500, ly=805, w=150, d=80, h=30, rug=(250, 175, "#9aa886", "#7e8c6b", "stripes"),
               chairs=[(-40, -72, "S"), (40, -72, "S"), (-124, 0, "E"), (124, 0, "W")], chair=36)
RECEPTION = dict(rug=(140, 810, 200, 120, "#c07a55", "#9c5c3c", "border"), chair=(205, 856, "N"),
                 end_table=(152, 860), plant=(268, 872))
FRONT_DESK = dict(lx=165, ly=742, long=92, deep=50, high=DESK_UP)
WAIT_CHAIR = 34
END_TABLE = 26
ENTRANCE = (47, 815)
PRINTER = dict(lx=505, ly=60, w=46, d=34, h=32)
PLANTS = [  # lx, ly, species
    (70, 110, "snake"), (855, 130, "fiddle"), (55, 645, "fiddle"), (866, 610, "snake"),
    (380, 870, "fiddle"), (66, 470, "fiddle"), (830, 330, "snake"), (872, 878, "fiddle"),
]
SHELF_LONG, SHELF_DEEP, SHELF_H, DEEP_WIDE = 58, 20, 66, 22
BOOKSHELVES = [  # lx, ly, dir, long, deep, high, rows, tone
    (130, SHELF_DEEP / 2, "S", 44, SHELF_DEEP, 88, 4, 1.0),
    (FLOOR - DEEP_WIDE / 2, 320, "W", 76, DEEP_WIDE, 46, 2, 0.94),
    (SHELF_DEEP / 2, 240, "E", SHELF_LONG, SHELF_DEEP, SHELF_H, 3, 1.05),
    (DEEP_WIDE / 2, 560, "E", 70, DEEP_WIDE, 48, 2, 0.97),
]
WINDOWS = [  # t0, t1, u0, u1, mullions — on both back walls (render.ts drawWalls)
    (0.28, 0.46, 0.34, 0.82, 2),
    (0.58, 0.78, 0.34, 0.82, 3),
]
BOOK_COLORS = ["#b5473a", "#2f6f8f", "#d9a441", "#4a7c59", "#7a4e8a", "#c86b3c", "#3f5b7a", "#8d8d3a"]

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
FLOOR_TILE = srgb("#ebae64")  # DARK_PALETTE.floor
FLOOR_SIDE = srgb("#c8863c")  # DARK_PALETTE.floor2
WALL = srgb("#b8aac2")        # pale lilac-grey plaster: nick 2026-10-20, "still a tiny bit too dark" at #9a8aa6 (first cut #5a4a64)
APPLIANCE = srgb("#d8d2c6")
COUCH = srgb("#e3a72b")       # DARK_PALETTE.couch


def _nodes(m: bpy.types.Material):
    m.use_nodes = True
    nt = m.node_tree
    return nt, nt.nodes, nt.links, nt.nodes.get("Principled BSDF")


def wood(name: str, rgb: tuple[float, float, float], grain: float = 0.18, scale: float = 0.06) -> bpy.types.Material:
    """Matte wood: a wave grain broken by noise, as a slight colour and bump variation (spec §2.3)."""
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    nt, nodes, links, bsdf = _nodes(m)
    bsdf.inputs["Roughness"].default_value = 0.62
    bsdf.inputs["Specular IOR Level"].default_value = 0.3
    tex = nodes.new("ShaderNodeTexCoord")
    wave = nodes.new("ShaderNodeTexWave")
    wave.wave_type = "BANDS"
    wave.bands_direction = "X"
    wave.inputs["Scale"].default_value = scale
    wave.inputs["Distortion"].default_value = 3.5
    wave.inputs["Detail"].default_value = 2.0
    wave.inputs["Detail Scale"].default_value = 1.5
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = scale * 6
    noise.inputs["Detail"].default_value = 4.0
    mixt = nodes.new("ShaderNodeMix")
    mixt.data_type = "FLOAT"
    mixt.inputs["Factor"].default_value = 0.35
    ramp = nodes.new("ShaderNodeValToRGB")
    dark = tuple(c * (1 - grain) for c in rgb)
    light = tuple(min(1.0, c * (1 + grain * 0.6)) for c in rgb)
    ramp.color_ramp.elements[0].color = (*dark, 1)
    ramp.color_ramp.elements[1].color = (*light, 1)
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.08
    links.new(tex.outputs["Object"], wave.inputs["Vector"])
    links.new(tex.outputs["Object"], noise.inputs["Vector"])
    links.new(wave.outputs["Fac"], mixt.inputs["A"])
    links.new(noise.outputs["Fac"], mixt.inputs["B"])
    links.new(mixt.outputs["Result"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(mixt.outputs["Result"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return m


def fabric(name: str, rgb: tuple[float, float, float], weave: float = 0.9) -> bpy.types.Material:
    """Matte fabric: no sheen, a fine noise bump that reads as a weave at 2×."""
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    nt, nodes, links, bsdf = _nodes(m)
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Roughness"].default_value = 0.95
    bsdf.inputs["Specular IOR Level"].default_value = 0.1
    bsdf.inputs["Sheen Weight"].default_value = 0.4
    tex = nodes.new("ShaderNodeTexCoord")
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = weave
    noise.inputs["Detail"].default_value = 6.0
    noise.inputs["Roughness"].default_value = 0.8
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.12
    links.new(tex.outputs["Object"], noise.inputs["Vector"])
    links.new(noise.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return m


def tiles(name: str, rgb: tuple[float, float, float], cell: float = 90.0) -> bpy.types.Material:
    """The floor: long ceramic tiles in a brick bond with a dark grout, a little colour wander per tile."""
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    nt, nodes, links, bsdf = _nodes(m)
    bsdf.inputs["Roughness"].default_value = 0.55
    bsdf.inputs["Specular IOR Level"].default_value = 0.35
    tex = nodes.new("ShaderNodeTexCoord")
    brick = nodes.new("ShaderNodeTexBrick")
    brick.inputs["Scale"].default_value = 1.0 / cell
    brick.inputs["Mortar Size"].default_value = 0.012
    brick.inputs["Mortar Smooth"].default_value = 0.4
    brick.inputs["Bias"].default_value = 0.0
    brick.inputs["Brick Width"].default_value = 2.0
    brick.inputs["Row Height"].default_value = 1.0
    brick.inputs["Color1"].default_value = (*rgb, 1)
    brick.inputs["Color2"].default_value = (*[c * 0.92 for c in rgb], 1)
    brick.inputs["Mortar"].default_value = (*[c * 0.55 for c in rgb], 1)
    links.new(tex.outputs["Object"], brick.inputs["Vector"])
    links.new(brick.outputs["Color"], bsdf.inputs["Base Color"])
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.25
    links.new(brick.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return m


def paint(name: str, rgb: tuple[float, float, float], rough: float = 0.85) -> bpy.types.Material:
    """Matte painted plaster: a faint noise so the wall is not a flat fill."""
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    nt, nodes, links, bsdf = _nodes(m)
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Specular IOR Level"].default_value = 0.15
    tex = nodes.new("ShaderNodeTexCoord")
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 0.4
    noise.inputs["Detail"].default_value = 3.0
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.04
    links.new(tex.outputs["Object"], noise.inputs["Vector"])
    links.new(noise.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return m


def glow(name: str, rgb: tuple[float, float, float], strength: float = 1.6) -> bpy.types.Material:
    """Window glass by day: a soft emissive pane, so the windows read as light, not as holes."""
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    nt, nodes, links, bsdf = _nodes(m)
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Emission Color"].default_value = (*rgb, 1)
    bsdf.inputs["Emission Strength"].default_value = strength
    bsdf.inputs["Roughness"].default_value = 0.2
    return m


def shadow_mat() -> bpy.types.Material:
    """The contact shadow under an item: translucent black, blended, casting nothing."""
    m = bpy.data.materials.get("contact-shadow")
    if m:
        return m
    m = bpy.data.materials.new("contact-shadow")
    nt, nodes, links, bsdf = _nodes(m)
    bsdf.inputs["Base Color"].default_value = (0, 0, 0, 1)
    bsdf.inputs["Alpha"].default_value = 0.32
    bsdf.inputs["Roughness"].default_value = 1.0
    bsdf.inputs["Specular IOR Level"].default_value = 0.0
    for attr, val in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
        try:
            setattr(m, attr, val)
        except Exception:
            pass
    try:
        m.use_transparent_shadow = True
    except Exception:
        pass
    return m


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


def cyl(name: str, cx: float, cy: float, z0: float, r0: float, r1: float, h: float, mat, zs: float, verts: int = 24) -> bpy.types.Object:
    """A cone frustum (r0 at the bottom, r1 at the top) — pots, cups, the cooler bottle."""
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r0, radius2=r1, depth=h * zs)
    o = bpy.context.active_object
    o.name = name
    o.location = (cx, cy, (z0 + h / 2) * zs)
    o.data.materials.append(mat)
    smooth(o)
    return o


def ball(name: str, cx: float, cy: float, z0: float, rx: float, ry: float, rz: float, mat, zs: float) -> bpy.types.Object:
    """An ellipsoid with its floor point at z0 (so z0 + rz is its centre) — leaves, cushions."""
    bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=12, radius=1.0)
    o = bpy.context.active_object
    o.name = name
    o.scale = (rx, ry, rz * zs)
    o.location = (cx, cy, (z0 + rz) * zs)
    bpy.ops.object.transform_apply(scale=True)
    o.data.materials.append(mat)
    smooth(o)
    return o


def smooth(o: bpy.types.Object) -> None:
    for p in o.data.polygons:
        p.use_smooth = True


def bevel(o: bpy.types.Object, width: float = 1.2, segments: int = 3) -> None:
    """Soften a block's edges so the key light catches them (the painters' "Delight D" lip)."""
    b = o.modifiers.new("bevel", "BEVEL")
    b.width = width
    b.segments = segments
    b.limit_method = "ANGLE"


def shadow(name: str, cx: float, cy: float, rx: float, ry: float, zs: float, alpha_scale: float = 1.0) -> bpy.types.Object:
    """The soft contact shadow pooled under an item, a touch toward the viewer (+x +y)."""
    bpy.ops.mesh.primitive_circle_add(vertices=32, radius=1.0, fill_type="NGON")
    o = bpy.context.active_object
    o.name = name
    o.scale = (rx, ry, 1.0)
    o.location = (cx + rx * 0.08, cy + ry * 0.08, 0.25 * zs)
    bpy.ops.object.transform_apply(scale=True)
    o.data.materials.append(shadow_mat())
    o.visible_shadow = False
    return o


def finish(asset_id: str, parts: list[bpy.types.Object], lx: float, ly: float, col: bpy.types.Collection) -> bpy.types.Object:
    """Join `parts` into one object named `asset_id`, origin at its floor point, in the export collection."""
    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    if len(parts) > 1:
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


# ── furniture ──────────────────────────────────────────────────────────────────────────────
def desk(asset_id: str, lx: float, ly: float, along_x: bool, zs: float, col: bpy.types.Collection) -> bpy.types.Object:
    """One workstation base — legs and slab (the bevelled lip is the render's own highlight)."""
    w, d = (DESK_W, DESK_D) if along_x else (DESK_D, DESK_W)
    oak = wood("oak", OAK)
    dark = wood("oak-dark", OAK_DARK, grain=0.1)
    slab = box(f"{asset_id}/slab", lx, ly, DESK_LEG_H, w, d, DESK_SLAB, oak, zs)
    bevel(slab)
    parts = [slab]
    for sx in (-1, 1):
        for sy in (-1, 1):
            parts.append(
                box(f"{asset_id}/leg", lx + sx * (w / 2 - LEG_INSET), ly + sy * (d / 2 - LEG_INSET), 0, LEG, LEG, DESK_LEG_H, dark, zs)
            )
    parts.append(shadow(f"{asset_id}/shadow", lx, ly, w * 0.56, d * 0.56, zs))
    return finish(asset_id, parts, lx, ly, col)


def bench(asset_id: str, zs: float, col: bpy.types.Collection) -> bpy.types.Object:
    """The long shared bench — a slab on a leg every seat."""
    B = BENCH
    oak = wood("oak", OAK)
    dark = wood("oak-dark", OAK_DARK, grain=0.1)
    slab = box(f"{asset_id}/slab", B["lx"], B["ly"], DESK_LEG_H, B["long"], B["deep"], DESK_SLAB, oak, zs)
    bevel(slab)
    parts = [slab]
    for i in range(5):
        along = -B["long"] / 2 + i * (B["long"] / 4)
        along = max(-B["long"] / 2 + 6, min(B["long"] / 2 - 6, along))
        parts.append(box(f"{asset_id}/leg", B["lx"] + along, B["ly"], 0, LEG, LEG, DESK_LEG_H, dark, zs))
    parts.append(shadow(f"{asset_id}/shadow", B["lx"], B["ly"], B["long"] * 0.52, B["deep"] * 0.9, zs))
    return finish(asset_id, parts, B["lx"], B["ly"], col)


def rug(asset_id: str, lx: float, ly: float, w: float, d: float, fill: str, mark: str, weave: str, zs: float, col) -> bpy.types.Object:
    """A flat rug: 1.2 high, bound or striped with a second thin layer, a knot at each corner."""
    base = fabric(f"rug-{fill}", srgb(fill), weave=1.4)
    accent = fabric(f"rug-{mark}", srgb(mark), weave=1.4)
    parts = [box(f"{asset_id}/field", lx, ly, 0, w, d, 1.2, base, zs)]
    if weave == "border":
        parts.append(box(f"{asset_id}/border", lx, ly, 1.2, w - 26, d - 26, 0.3, accent, zs))
        parts.append(box(f"{asset_id}/inner", lx, ly, 1.5, w - 40, d - 40, 0.3, base, zs))
    elif weave == "stripes":
        across = w >= d
        span = w if across else d
        inset = 18
        for i in range(3):
            off = -span / 4 + i * span / 4
            bw = 16 if across else w - inset * 2
            bd = d - inset * 2 if across else 16
            parts.append(box(f"{asset_id}/stripe", lx + (off if across else 0), ly + (0 if across else off), 1.2, bw, bd, 0.3, accent, zs))
    for sx in (-1, 1):
        for sy in (-1, 1):
            parts.append(cyl(f"{asset_id}/knot", lx + sx * (w / 2 - 4), ly + sy * (d / 2 - 4), 1.2, 4.2, 3.2, 1.2, accent, zs, 12))
    return finish(asset_id, parts, lx, ly, col)


def diamond_rug(asset_id: str, lx: float, ly: float, r: float, fill: str, mark: str, zs: float, col) -> bpy.types.Object:
    """The nook's one big diamond rug: a square turned 45° in floor space, bound with a darker edge."""
    base = fabric(f"rug-{fill}", srgb(fill), weave=1.4)
    accent = fabric(f"rug-{mark}", srgb(mark), weave=1.4)
    side = r * math.sqrt(2)
    parts = []
    for name, rr, z0, h, mat in (("field", r, 0, 1.2, base), ("border", r - 14, 1.2, 0.3, accent), ("inner", r - 26, 1.5, 0.3, base)):
        o = box(f"{asset_id}/{name}", lx, ly, z0, rr * math.sqrt(2), rr * math.sqrt(2), h, mat, zs)
        o.rotation_euler = (0, 0, math.radians(45))
        bpy.ops.object.transform_apply(rotation=True)
        parts.append(o)
    return finish(asset_id, parts, lx, ly, col)


def plant(asset_id: str, lx: float, ly: float, species: str, zs: float, col) -> bpy.types.Object:
    """A potted plant: tapered terracotta pot, rim, soil, then snake-plant blades or a fiddle-leaf canopy."""
    pot = paint("pot", srgb("#b9603a"), rough=0.7)
    rim = paint("pot-rim", srgb("#cb6f45"), rough=0.7)
    soil = paint("soil", srgb("#4a3326"), rough=1.0)
    parts = [
        cyl(f"{asset_id}/pot", lx, ly, 0, 8.5, 12.5, 19, pot, zs),
        cyl(f"{asset_id}/rim", lx, ly, 19, 13.5, 13.5, 3.5, rim, zs),
        cyl(f"{asset_id}/soil", lx, ly, 22.0, 11.5, 11.5, 0.8, soil, zs),
    ]
    top = 22.5
    if species == "snake":
        blade = paint("snake-leaf", srgb("#3e6b3a"), rough=0.6)
        tip = paint("snake-tip", srgb("#6fa35a"), rough=0.6)
        for i, (dx, dy, h, tilt) in enumerate(((0, 0, 60, 0), (-6, 2, 50, -8), (6, -1, 54, 9), (-3, -5, 44, -5), (4, 5, 46, 6), (-7, -3, 36, -12), (8, 3, 40, 11))):
            b = ball(f"{asset_id}/blade{i}", lx + dx, ly + dy, top, 2.6, 4.2, h / 2, blade, zs)
            b.rotation_euler = (math.radians(tilt * 0.4), math.radians(tilt), 0)
            parts.append(b)
            parts.append(ball(f"{asset_id}/tip{i}", lx + dx * 1.1, ly + dy * 1.1, top + h - 10, 2.0, 3.0, 5, tip, zs))
    else:
        trunk = wood("trunk", srgb("#7c5a3c"), grain=0.1)
        leaf = paint("fiddle-leaf", srgb("#6e9e52"), rough=0.5)
        leaf_lit = paint("fiddle-leaf-lit", srgb("#86b368"), rough=0.5)
        parts.append(cyl(f"{asset_id}/trunk", lx, ly, top, 1.8, 1.4, 30, trunk, zs, 10))
        crown = top + 27
        for i, (dx, dy, dz, r) in enumerate(((0, 0, 14, 13), (-10, 4, 6, 10), (10, -3, 8, 10), (-5, -9, 2, 9), (6, 9, 0, 9), (-12, -4, 18, 8), (11, 6, 20, 8), (0, -11, 20, 7))):
            m = leaf_lit if i % 3 == 0 else leaf
            parts.append(ball(f"{asset_id}/leaf{i}", lx + dx, ly + dy, crown + dz, r, r * 0.8, r * 0.55, m, zs))
    parts.append(shadow(f"{asset_id}/shadow", lx, ly, 20, 15, zs))
    return finish(asset_id, parts, lx, ly, col)


def bookshelf(asset_id: str, lx: float, ly: float, d: str, long: float, deep: float, high: float, rows: int, tone: float, zs: float, col) -> bpy.types.Object:
    """A shelf unit against a wall: carcass, shelves, books in rows (their fronts toward the room)."""
    sn = d in ("S", "N")
    wx, dy = (long, deep) if sn else (deep, long)
    carcass = wood(f"shelf-{tone}", tuple(c * tone for c in OAK), grain=0.14)
    back_mat = wood(f"shelf-back-{tone}", tuple(c * tone * 0.7 for c in OAK), grain=0.08)
    fwd = {"S": (0, 1), "N": (0, -1), "E": (1, 0), "W": (-1, 0)}[d]
    P = 2.0  # panel thickness
    # an open carcass: a back panel on the wall side, two uprights, a top, and a shelf per row
    parts = [
        box(f"{asset_id}/back", lx - fwd[0] * (deep / 2 - P / 2), ly - fwd[1] * (deep / 2 - P / 2), 0, wx if sn else P, P if sn else dy, high, back_mat, zs),
        box(f"{asset_id}/top", lx, ly, high - P, wx, dy, P, carcass, zs),
    ]
    for sgn in (-1, 1):
        ux = lx + (sgn * (long / 2 - P / 2) if sn else 0)
        uy = ly + (0 if sn else sgn * (long / 2 - P / 2))
        parts.append(box(f"{asset_id}/upright", ux, uy, 0, P if sn else deep, deep if sn else P, high, carcass, zs))
    band = (high - 10) / rows
    rnd = 0
    for row in range(rows):
        base_up = 8 + row * band
        parts.append(box(f"{asset_id}/shelf{row}", lx, ly, base_up - 1.5, wx - 2 * P, dy - 2 * P, 1.5, carcass, zs))
        n = max(2, int(long / 9))
        for i in range(n):
            rnd = (rnd * 1103515245 + 12345 + row * 7 + i) & 0x7FFFFFFF
            bw = 5 + (rnd % 4)
            bh = min(band - 4, 11 + (rnd % 9))
            along = -long / 2 + 5 + i * ((long - 10) / n)
            color = srgb(BOOK_COLORS[(rnd >> 4) % len(BOOK_COLORS)])
            bx = lx + (along if sn else fwd[0] * (deep / 2 - 7))
            by = ly + (fwd[1] * (deep / 2 - 7) if sn else along)
            parts.append(box(f"{asset_id}/book", bx, by, base_up, bw if sn else 9, 9 if sn else bw, bh, paint(f"book-{(rnd >> 4) % 8}", color, 0.8), zs))
    parts.append(shadow(f"{asset_id}/shadow", lx + fwd[0] * 4, ly + fwd[1] * 4, wx * 0.6, dy * 0.6, zs))
    return finish(asset_id, parts, lx, ly, col)


def entrance(asset_id: str, zs: float, col) -> bpy.types.Object:
    """The glass front door on the left wall: two posts, a lintel, two panes, a threshold strip."""
    lx, ly = ENTRANCE
    wx = lx - 42
    H = 96
    frame = wood("door-frame", srgb("#5c452c"), grain=0.1)
    sill = wood("door-sill", srgb("#4e3a24"), grain=0.1)
    glass = glow("door-glass", srgb("#cfe3ea"), strength=0.9)
    mullion = paint("door-mullion", srgb("#3c2e1e"), 0.6)
    parts = [
        box(f"{asset_id}/sill", wx, ly, 0, 6, 94, 3, sill, zs),
        box(f"{asset_id}/post-a", wx, ly - 44, 0, 10, 10, H, frame, zs),
        box(f"{asset_id}/post-b", wx, ly + 44, 0, 10, 10, H, frame, zs),
        box(f"{asset_id}/lintel", wx, ly, H, 8, 98, 10, frame, zs),
        box(f"{asset_id}/pane-a", wx, ly - 20, 4, 2, 36, H - 6, glass, zs),
        box(f"{asset_id}/pane-b", wx, ly + 20, 4, 2, 36, H - 6, glass, zs),
        box(f"{asset_id}/mullion", wx, ly, 3, 3, 4, H - 3, mullion, zs),
        box(f"{asset_id}/rail-a", wx, ly - 20, 44, 3, 36, 2.5, mullion, zs),
        box(f"{asset_id}/rail-b", wx, ly + 20, 44, 3, 36, 2.5, mullion, zs),
        box(f"{asset_id}/handle", wx + 2, ly - 6, 42, 1.5, 2, 12, paint("brass", srgb("#c9a24d"), 0.35), zs),
    ]
    parts.append(shadow(f"{asset_id}/shadow", wx + 8, ly, 52, 15, zs))
    return finish(asset_id, parts, lx, ly, col)


def nook_fridge(asset_id: str, zs: float, col) -> bpy.types.Object:
    f = LOUNGE["fridge"]
    lx, ly = NOOK[0] + f["dx"], NOOK[1] + f["dy"]
    body = paint("appliance", APPLIANCE, 0.45)
    front = ly + f["d"] / 2
    fr = box(f"{asset_id}/body", lx, ly, 0, f["w"], f["d"], f["h"], body, zs)
    bevel(fr, 0.8, 2)
    parts = [fr, box(f"{asset_id}/seam", lx, front, 34, f["w"] - 4, 1.5, 1.5, paint("seam", srgb("#c3b9a8"), 0.5), zs)]
    for up in (38, 18):
        parts.append(box(f"{asset_id}/handle", lx + 11, front + 0.5, up, 2.5, 2.5, 12, paint("handle", srgb("#6e6558"), 0.4), zs))
    parts.append(box(f"{asset_id}/note", lx - 6, front + 0.4, 24, 7, 0.8, 8, paint("note", srgb("#f4cf52"), 0.9), zs))
    parts.append(box(f"{asset_id}/crate", lx - 5, ly - 2, f["h"], 15, 13, 9, wood("crate", srgb("#c9744a"), grain=0.12), zs))
    parts.append(shadow(f"{asset_id}/shadow", lx, ly, f["w"] * 0.65, f["d"] * 0.7, zs))
    return finish(asset_id, parts, lx, ly, col)


def nook_counter(asset_id: str, zs: float, col) -> bpy.types.Object:
    """The kitchenette run: a carcass, a worktop, a backsplash, the coffee machine and the sink."""
    c = LOUNGE["counter"]
    lx, ly = NOOK[0] + c["dx"], NOOK[1] + c["dy"]
    oak = wood("oak", OAK)
    dark = wood("oak-dark", OAK_DARK, grain=0.1)
    top = box(f"{asset_id}/top", lx, ly, c["h"] - 4, c["w"], c["d"], 4, oak, zs)
    bevel(top, 1.0)
    parts = [
        box(f"{asset_id}/carcass", lx, ly, 0, c["w"] - 4, c["d"] - 3, c["h"] - 4, dark, zs),
        top,
        box(f"{asset_id}/splash", lx, ly - c["d"] / 2 + 1.5, c["h"], c["w"], 3, 16, paint("splash", srgb("#e8e0d2"), 0.4), zs),
    ]
    for seam in (-0.22, 0.22):
        parts.append(box(f"{asset_id}/seam", lx + c["w"] * seam, ly + c["d"] / 2 - 1.2, 2, 1.0, 1.0, c["h"] - 8, paint("seam-dark", srgb("#4b3420"), 0.8), zs))
    # coffee machine
    mx, my = NOOK[0] + LOUNGE["machine"]["dx"], NOOK[1] + LOUNGE["machine"]["dy"]
    metal = paint("steel", srgb("#8d939a"), 0.3)
    parts.append(box(f"{asset_id}/machine", mx, my, c["h"], 14, 12, 16, metal, zs))
    parts.append(box(f"{asset_id}/machine-head", mx, my + 3, c["h"] + 16, 12, 8, 4, paint("steel-dark", srgb("#4a4f55"), 0.4), zs))
    parts.append(cyl(f"{asset_id}/cup", mx + 1, my + 4, c["h"], 2.2, 2.6, 4, paint("cup", srgb("#f2e7d5"), 0.6), zs, 12))
    # sink
    sx, sy = NOOK[0] + LOUNGE["sink"]["dx"], NOOK[1] + LOUNGE["sink"]["dy"]
    parts.append(box(f"{asset_id}/sink", sx, sy, c["h"] - 1.5, 16, 12, 1.8, paint("sink", srgb("#b9c2c7"), 0.25), zs))
    parts.append(cyl(f"{asset_id}/tap", sx, sy - 5, c["h"], 1.0, 1.0, 9, metal, zs, 10))
    # a bread bag and two stacked plates
    parts.append(box(f"{asset_id}/bag", lx + 18, ly + 1, c["h"], 9, 8, 12, paint("bag", srgb("#a97c50"), 0.8), zs))
    for i in range(2):
        parts.append(cyl(f"{asset_id}/plate{i}", lx + 32, ly, c["h"] + i * 1.2, 5.5, 5.5, 1.0, paint("plate", srgb("#f2e7d5"), 0.5), zs, 16))
    parts.append(shadow(f"{asset_id}/shadow", lx, ly, c["w"] * 0.55, c["d"] * 0.8, zs))
    return finish(asset_id, parts, lx, ly, col)


def nook_cooler(asset_id: str, zs: float, col) -> bpy.types.Object:
    c = LOUNGE["cooler"]
    lx, ly = NOOK[0] + c["dx"], NOOK[1] + c["dy"]
    body = paint("appliance", APPLIANCE, 0.45)
    water = glow("water", srgb("#8fd0e6"), strength=0.25)
    parts = [
        box(f"{asset_id}/body", lx, ly, 0, c["w"], c["d"], c["h"], body, zs),
        box(f"{asset_id}/tap", lx, ly + c["d"] / 2 + 1, 26, 8, 3, 5, paint("tap-block", srgb("#5f6b70"), 0.4), zs),
        box(f"{asset_id}/cups", lx - 7, ly + c["d"] / 2 + 1, 30, 3, 2, 10, paint("cup-tube", srgb("#cfd6d8"), 0.5), zs),
        cyl(f"{asset_id}/neck", lx, ly, c["h"], 4, 7, 5, water, zs),
        cyl(f"{asset_id}/bottle", lx, ly, c["h"] + 5, 7, 7.5, 12, water, zs),
        cyl(f"{asset_id}/bottle-top", lx, ly, c["h"] + 17, 7.5, 6, 5, water, zs),
    ]
    parts.append(shadow(f"{asset_id}/shadow", lx, ly, c["w"] * 0.7, c["d"] * 0.7, zs))
    return finish(asset_id, parts, lx, ly, col)


def couch(asset_id: str, lx: float, ly: float, L: float, Dp: float, zs: float, col, facing: str = "S") -> bpy.types.Object:
    """A two-seater facing the room: seat, back, two arms, two seat cushions, a throw pillow."""
    fab = fabric("couch", COUCH)
    fab_dark = fabric("couch-dark", tuple(c * 0.9 for c in COUCH))
    sn = facing in ("S", "N")
    f = {"S": (0, 1), "N": (0, -1), "E": (1, 0), "W": (-1, 0)}[facing]
    parts = []
    seat = box(f"{asset_id}/seat", lx, ly, 0, L if sn else Dp, Dp if sn else L, 20, fab, zs)
    bevel(seat, 2.0)
    parts.append(seat)
    back = box(f"{asset_id}/back", lx - f[0] * (Dp / 2 - 4), ly - f[1] * (Dp / 2 - 4), 0, L if sn else 10, 10 if sn else L, 34, fab_dark, zs)
    bevel(back, 2.0)
    parts.append(back)
    p = (1, 0) if sn else (0, 1)
    for sgn in (-1, 1):
        arm = box(f"{asset_id}/arm", lx + sgn * p[0] * (L / 2 - 5), ly + sgn * p[1] * (L / 2 - 5), 0, 10 if sn else Dp, Dp if sn else 10, 27, fab_dark, zs)
        bevel(arm, 2.0)
        parts.append(arm)
    for sgn in (-0.5, 0.5):
        cx = lx + sgn * p[0] * (L / 2) + f[0] * 2
        cy = ly + sgn * p[1] * (L / 2) + f[1] * 2
        parts.append(ball(f"{asset_id}/cushion", cx, cy, 19, (L / 4 - 3) if sn else Dp / 2 - 5, Dp / 2 - 5 if sn else (L / 4 - 3), 3.5, fab, zs))
    parts.append(ball(f"{asset_id}/pillow", lx - p[0] * (L / 2 - 16) - f[0] * 8, ly - p[1] * (L / 2 - 16) - f[1] * 8, 20, 9, 7, 7, fabric("pillow", srgb("#d9774f")), zs))
    parts.append(shadow(f"{asset_id}/shadow", lx, ly, (L if sn else Dp) * 0.58, (Dp if sn else L) * 0.6, zs))
    return finish(asset_id, parts, lx, ly, col)


def low_table(asset_id: str, lx: float, ly: float, w: float, d: float, h: float, zs: float, col, dress: bool = True) -> bpy.types.Object:
    oak = wood("oak", OAK)
    top = box(f"{asset_id}/top", lx, ly, h - 3, w, d, 3, oak, zs)
    bevel(top, 0.8)
    parts = [top]
    for sx in (-1, 1):
        for sy in (-1, 1):
            parts.append(box(f"{asset_id}/leg", lx + sx * (w / 2 - 4), ly + sy * (d / 2 - 4), 0, 4, 4, h - 3, wood("oak-dark", OAK_DARK, grain=0.1), zs))
    if dress:
        parts.append(box(f"{asset_id}/book-a", lx - 13, ly + 3, h, 22, 15, 1.2, paint("book-cover", srgb("#b98a5e"), 0.8), zs))
        parts.append(box(f"{asset_id}/book-b", lx - 13, ly + 3, h + 1.2, 18, 12, 2.4, paint("book-3", srgb(BOOK_COLORS[3]), 0.8), zs))
        parts.append(cyl(f"{asset_id}/bowl", lx + 8, ly - 2, h, 7, 9, 3.5, paint("bowl", srgb("#e8c17d"), 0.5), zs, 16))
    parts.append(shadow(f"{asset_id}/shadow", lx, ly, w * 0.6, d * 0.6, zs))
    return finish(asset_id, parts, lx, ly, col)


def armchair(asset_id: str, lx: float, ly: float, S: float, facing: str, zs: float, col) -> bpy.types.Object:
    fab = fabric("couch", COUCH)
    fab_dark = fabric("couch-dark", tuple(c * 0.9 for c in COUCH))
    sn = facing in ("S", "N")
    f = {"S": (0, 1), "N": (0, -1), "E": (1, 0), "W": (-1, 0)}[facing]
    seat = box(f"{asset_id}/seat", lx, ly, 0, S - 2 if sn else S, S if sn else S - 2, 20, fab, zs)
    bevel(seat, 2.0)
    back = box(f"{asset_id}/back", lx - f[0] * (S / 2 - 6), ly - f[1] * (S / 2 - 6), 0, S - 2 if sn else 10, 10 if sn else S - 2, 32, fab_dark, zs)
    bevel(back, 2.0)
    parts = [seat, back, ball(f"{asset_id}/cushion", lx + f[0] * 2, ly + f[1] * 2, 19, S / 2 - 5, S / 2 - 5, 3, fabric("cushion", srgb("#eabf50")), zs)]
    parts.append(shadow(f"{asset_id}/shadow", lx, ly, S * 0.62, S * 0.62, zs))
    return finish(asset_id, parts, lx, ly, col)


def front_desk(asset_id: str, zs: float, col) -> bpy.types.Object:
    """Reception: a desk with a modesty panel toward the room, a monitor, a small plant and a visitor book."""
    D = FRONT_DESK
    lx, ly = D["lx"], D["ly"]
    oak = wood("oak", OAK)
    dark = wood("oak-dark", OAK_DARK, grain=0.1)
    top = box(f"{asset_id}/top", lx, ly, D["high"] - 4, D["long"], D["deep"], 4, oak, zs)
    bevel(top, 1.0)
    parts = [box(f"{asset_id}/base", lx, ly, 0, D["long"] - 4, D["deep"] - 3, D["high"] - 4, dark, zs), top]
    parts.append(box(f"{asset_id}/panel", lx, ly + D["deep"] / 2 - 4, D["high"], D["long"] - 8, 8, 9, dark, zs))
    parts.append(box(f"{asset_id}/monitor", lx + 18, ly - 6, D["high"] + 4, 21, 2.5, 13, paint("screen-bezel", srgb("#3a3a3e"), 0.4), zs))
    parts.append(box(f"{asset_id}/monitor-foot", lx + 18, ly - 6, D["high"], 9, 7, 4, paint("screen-bezel", srgb("#3a3a3e"), 0.4), zs))
    parts.append(cyl(f"{asset_id}/pot", lx - 24, ly - 8, D["high"], 6, 7.5, 11, paint("pot", srgb("#b9603a"), 0.7), zs, 16))
    parts.append(ball(f"{asset_id}/leaves", lx - 24, ly - 8, D["high"] + 11, 11, 9, 5, paint("fiddle-leaf", srgb("#6e9e52"), 0.5), zs))
    parts.append(box(f"{asset_id}/book", lx - 2, ly + 6, D["high"], 24, 16, 1.6, paint("paper", srgb("#f2ecd9"), 0.9), zs))
    parts.append(shadow(f"{asset_id}/shadow", lx, ly, D["long"] * 0.56, D["deep"] * 0.7, zs))
    return finish(asset_id, parts, lx, ly, col)


def meeting_table(asset_id: str, zs: float, col) -> bpy.types.Object:
    M = MEETING
    lx, ly = M["lx"], M["ly"]
    oak = wood("oak", OAK)
    dark = wood("oak-dark", OAK_DARK, grain=0.1)
    top = box(f"{asset_id}/top", lx, ly, M["h"] - 6, M["w"], M["d"], 6, oak, zs)
    bevel(top, 2.0, 4)
    parts = [top]
    for sx in (-1, 1):
        for sy in (-1, 1):
            parts.append(box(f"{asset_id}/leg", lx + sx * (M["w"] / 2 - 8), ly + sy * (M["d"] / 2 - 8), 0, 8, 8, M["h"] - 6, dark, zs))
    hub = lx + 30
    parts.append(box(f"{asset_id}/puck", hub, ly, M["h"], 17, 17, 4.5, paint("puck", srgb("#2c2c30"), 0.35), zs))
    parts.append(cyl(f"{asset_id}/vase", lx, ly, M["h"], 6, 7, 9, paint("vase", srgb("#efe2c6"), 0.4), zs, 16))
    for i, (dx, dy, dz, c) in enumerate(((-4, 0, 43, "#6f985d"), (4, 0, 45, "#7eaa69"), (0, 0, 50, "#f4cf52"))):
        parts.append(ball(f"{asset_id}/flower{i}", lx + dx, ly + dy, M["h"] + dz - 7, 5, 5, 4 if i < 2 else 3, paint(f"flower{i}", srgb(c), 0.6), zs))
    parts.append(cyl(f"{asset_id}/stem", lx, ly, M["h"] + 9, 0.8, 0.8, 34, paint("stem", srgb("#4e7a3c"), 0.7), zs, 8))
    parts.append(shadow(f"{asset_id}/shadow", lx, ly, M["w"] * 0.52, M["d"] * 0.6, zs))
    return finish(asset_id, parts, lx, ly, col)


def meeting_chair(asset_id: str, lx: float, ly: float, facing: str, zs: float, col) -> bpy.types.Object:
    S = MEETING["chair"]
    fab = fabric("chair-fab", srgb("#5e6e7e"))
    dark = paint("chair-frame", srgb("#3a3a3e"), 0.4)
    f = {"S": (0, 1), "N": (0, -1), "E": (1, 0), "W": (-1, 0)}[facing]
    sn = facing in ("S", "N")
    parts = [
        box(f"{asset_id}/seat", lx, ly, 15, S - 8, S - 8, 5, fab, zs),
        box(f"{asset_id}/back", lx - f[0] * (S / 2 - 8), ly - f[1] * (S / 2 - 8), 20, S - 10 if sn else 4, 4 if sn else S - 10, 22, fab, zs),
        cyl(f"{asset_id}/stem", lx, ly, 2, 1.6, 1.6, 13, dark, zs, 10),
    ]
    for i in range(5):
        a = i / 5 * math.tau
        parts.append(box(f"{asset_id}/spoke", lx + math.cos(a) * 7, ly + math.sin(a) * 7, 0, 3, 3, 2, dark, zs))
    parts.append(shadow(f"{asset_id}/shadow", lx, ly, S * 0.5, S * 0.5, zs))
    return finish(asset_id, parts, lx, ly, col)


def end_table(asset_id: str, zs: float, col) -> bpy.types.Object:
    lx, ly = RECEPTION["end_table"]
    oak = wood("oak", OAK)
    t = box(f"{asset_id}/top", lx, ly, 0, END_TABLE, END_TABLE, 16, oak, zs)
    bevel(t, 1.0)
    parts = [t,
             box(f"{asset_id}/mag-a", lx - 2, ly + 1, 16, 15, 11, 1.1, paint("mag-a", srgb("#d9c7a8"), 0.9), zs),
             box(f"{asset_id}/mag-b", lx + 1, ly - 1, 17.1, 15, 11, 1.1, paint("mag-b", srgb("#c98f6a"), 0.9), zs)]
    parts.append(shadow(f"{asset_id}/shadow", lx, ly, 20, 14, zs))
    return finish(asset_id, parts, lx, ly, col)


def printer(asset_id: str, zs: float, col) -> bpy.types.Object:
    P = PRINTER
    lx, ly = P["lx"], P["ly"]
    body = box(f"{asset_id}/body", lx, ly, 0, P["w"], P["d"], P["h"], paint("printer", srgb("#9aa3ab"), 0.5), zs)
    bevel(body, 1.5)
    parts = [body,
             box(f"{asset_id}/tray", lx, ly, P["h"], P["w"] - 12, P["d"] - 10, 5, paint("printer-dark", srgb("#6d757d"), 0.5), zs),
             box(f"{asset_id}/paper", lx, ly, P["h"] + 5, P["w"] - 20, P["d"] - 16, 4, paint("paper", srgb("#f2ecd9"), 0.9), zs)]
    parts.append(shadow(f"{asset_id}/shadow", lx, ly, P["w"] * 0.62, P["d"] * 0.7, zs))
    return finish(asset_id, parts, lx, ly, col)


# ── per-desk live overlays (plan Task 7) ───────────────────────────────────────────────────
def desk_lamp(asset_id: str, lit: bool, zs: float, col) -> bpy.types.Object:
    """A desk lamp standing on the worktop at its floor point: base, pole, shade — and, lit, a
    glowing shade and a warm pool on the slab. Modelled at DESK_UP so the anchor is the floor point
    `drawWorkstation` already blits props at."""
    C = FLOOR / 2
    up = DESK_UP
    dark = paint("lamp-dark", srgb("#3d4650"), 0.4)
    pole = paint("lamp-pole", srgb("#4a545f"), 0.4)
    shade = glow("lamp-shade-lit", srgb("#f3cf6e"), strength=2.4) if lit else paint("lamp-shade", srgb("#aab0b8"), 0.5)
    parts = [
        box(f"{asset_id}/base", C, C, up, 10, 10, 3, dark, zs),
        cyl(f"{asset_id}/pole", C, C, up + 3, 1.5, 1.5, 22, pole, zs, 10),
        cyl(f"{asset_id}/shade", C, C, up + 22, 4.5, 9, 7, shade, zs, 20),
    ]
    if lit:
        pool = bpy.data.materials.get("lamp-pool") or bpy.data.materials.new("lamp-pool")
        nt, nodes, links, bsdf = _nodes(pool)
        bsdf.inputs["Base Color"].default_value = (1.0, 0.85, 0.5, 1)
        bsdf.inputs["Emission Color"].default_value = (1.0, 0.85, 0.5, 1)
        bsdf.inputs["Emission Strength"].default_value = 0.9
        bsdf.inputs["Alpha"].default_value = 0.35
        for attr, val in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
            try:
                setattr(pool, attr, val)
            except Exception:
                pass
        bpy.ops.mesh.primitive_circle_add(vertices=32, radius=1.0, fill_type="NGON")
        o = bpy.context.active_object
        o.name = f"{asset_id}/pool"
        o.scale = (22, 16, 1.0)
        o.location = (C + 3, C + 4, (up + 0.3) * zs)
        bpy.ops.object.transform_apply(scale=True)
        o.data.materials.append(pool)
        o.visible_shadow = False
        parts.append(o)
    return finish(asset_id, parts, C, C, col)


def desk_fan(asset_id: str, frame: int, zs: float, col) -> bpy.types.Object:
    """A small desk fan: base, neck, a cage ring with a hub and three blades, the head facing the
    viewer (+x +y); `frame`/4 of a revolution turns the blades."""
    from mathutils import Matrix

    C = FLOOR / 2
    up = DESK_UP
    dark = paint("fan-dark", srgb("#556069"), 0.4)
    cage = paint("fan-cage", srgb("#8794a0"), 0.4)
    blade = paint("fan-blade", srgb("#aeb9c2"), 0.5)
    parts = [
        box(f"{asset_id}/base", C, C, up, 9, 9, 5, dark, zs),
        cyl(f"{asset_id}/neck", C, C, up + 4, 1.5, 1.5, 12, dark, zs, 10),
    ]
    n = Vector((1, 1, 0)).normalized()          # the head's axis, toward the viewer
    u = Vector((0, 0, 1))                       # "up" in the head's plane
    v = n.cross(u)                              # "across" in the head's plane
    centre = Vector((C, C, (up + 17) * zs))
    face = n.to_track_quat("Z", "Y")           # takes a cylinder's Z axis onto n

    def head(o: bpy.types.Object) -> bpy.types.Object:
        o.rotation_euler = face.to_euler()
        o.location = centre
        return o

    bpy.ops.mesh.primitive_torus_add(major_radius=10, minor_radius=0.7, major_segments=32, minor_segments=8)
    ring = bpy.context.active_object
    ring.name = f"{asset_id}/ring"
    ring.data.materials.append(cage)
    parts.append(head(ring))
    bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=2.4, depth=2.0)
    hub = bpy.context.active_object
    hub.name = f"{asset_id}/hub"
    hub.data.materials.append(dark)
    parts.append(head(hub))
    for i in range(3):
        a = math.radians(frame * 30 + i * 120)
        radial = (math.cos(a) * u + math.sin(a) * v).normalized()
        tangent = n.cross(radial)
        bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=1.0)
        b = bpy.context.active_object
        b.name = f"{asset_id}/blade{i}"
        b.scale = (4.2, 2.2, 0.5)               # long along the radial, flat along the axis (left unapplied: join bakes it)
        b.data.materials.append(blade)
        smooth(b)
        # basis columns: x → radial, y → tangent, z → the head's axis
        m = Matrix((radial, tangent, n)).transposed()
        b.rotation_euler = m.to_euler()
        b.location = centre + radial * 5.5
        parts.append(b)
    return finish(asset_id, parts, C, C, col)


# ── the shell ──────────────────────────────────────────────────────────────────────────────
def floor_slab(asset_id: str, zs: float, col) -> bpy.types.Object:
    """The floor: a tiled top and a darker slab edge (THICK) the diamond sits on. Origin at the back corner."""
    tile = tiles("floor-tiles", FLOOR_TILE)
    side = paint("floor-side", FLOOR_SIDE, 0.7)
    top = box(f"{asset_id}/top", FLOOR / 2, FLOOR / 2, -1.0, FLOOR, FLOOR, 1.0, tile, zs)
    slab = box(f"{asset_id}/slab", FLOOR / 2, FLOOR / 2, -THICK, FLOOR - 0.2, FLOOR - 0.2, THICK - 1.0, side, zs)
    return finish(asset_id, [top, slab], 0, 0, col)


def wall(asset_id: str, which: int, zs: float, col) -> bpy.types.Object:
    """One back wall, along the lx=0 edge (0, the left) or the ly=0 edge (1, the right): plaster, a cap,
    a skirting board, and the two windows each wall carries, with frames, mullions, a sill and a lit pane."""
    plaster = paint("wall", WALL, 0.9)
    cap = paint("wall-cap", tuple(c * 0.8 for c in WALL), 0.9)
    skirt = wood("skirting", srgb("#4e3a24"), grain=0.1)
    frame = paint("window-frame", tuple(c * 0.7 for c in WALL), 0.6)
    pane = glow("window-pane", srgb("#f6e7c4"), strength=2.2)
    T = 8.0  # wall thickness, behind the room
    parts = []
    along = lambda t: t * FLOOR  # noqa: E731

    def place(name, t0, t1, z0, h, depth_off, thick, mat):
        """A block on this wall's face: `t0..t1` along it, `z0..z0+h` up it, `depth_off` out from the face."""
        c = (along(t0) + along(t1)) / 2
        L = along(t1) - along(t0)
        if which == 0:
            return box(name, -T / 2 + depth_off, c, z0, thick, L, h, mat, zs)
        return box(name, c, -T / 2 + depth_off, z0, L, thick, h, mat, zs)

    parts.append(place(f"{asset_id}/face", 0, 1, 0, WALL_H, 0, T, plaster))
    parts.append(place(f"{asset_id}/cap", 0, 1, WALL_H, WALL_H * 0.04, 0.5, T + 1, cap))
    parts.append(place(f"{asset_id}/skirt", 0, 1, 0, 7, T / 2 + 1.0, 2, skirt))
    for i, (t0, t1, u0, u1, mull) in enumerate(WINDOWS):
        z0, z1 = u0 * WALL_H, u1 * WALL_H
        # the pane sits just proud of the plaster (an inset would be inside the wall block and unseen)
        parts.append(place(f"{asset_id}/win{i}-pane", t0 + 0.004, t1 - 0.004, z0 + 2, z1 - z0 - 4, T / 2 + 0.6, 1.0, pane))
        for name, a, b, zz, hh in (("top", t0, t1, z1 - 3, 3), ("bottom", t0, t1, z0, 3)):
            parts.append(place(f"{asset_id}/win{i}-{name}", a, b, zz, hh, T / 2 + 1.6, 3, frame))
        for name, tt in (("left", t0), ("right", t1)):
            parts.append(place(f"{asset_id}/win{i}-{name}", tt - 0.004, tt + 0.004, z0, z1 - z0, T / 2 + 1.6, 3, frame))
        for k in range(1, mull):
            tt = t0 + (t1 - t0) * k / mull
            parts.append(place(f"{asset_id}/win{i}-mullion{k}", tt - 0.0015, tt + 0.0015, z0, z1 - z0, T / 2 + 1.3, 2, frame))
        parts.append(place(f"{asset_id}/win{i}-sill", t0 - 0.006, t1 + 0.006, z0 - 2.5, 2.5, T / 2 + 3.5, 7, skirt))
    return finish(asset_id, parts, 0, 0, col)


# ── light states (spec §3.3, plan Task 8) ─────────────────────────────────────────────────
# Each day state is a rig: the sun (energy, colour, elevation), the fill, the world, and what the
# window panes emit. The ceiling bank is a separate set of area lights, on / off / spill.
LIGHT_STATES = {
    "day": dict(sun=(3.0, (1.0, 0.93, 0.82), 50), fill=(0.9, (0.82, 0.9, 1.0)), world=(0.35, (0.9, 0.86, 0.8)),
                pane=(2.2, "#f6e7c4"), window=(900.0, (1.0, 0.93, 0.8))),
    "evening": dict(sun=(2.2, (1.0, 0.62, 0.36), 18), fill=(0.5, (0.7, 0.62, 0.9)), world=(0.22, (0.75, 0.55, 0.6)),
                    pane=(1.7, "#f3b57a"), window=(700.0, (1.0, 0.66, 0.4))),
    "night": dict(sun=(0.0, (0.5, 0.6, 1.0), 30), fill=(0.32, (0.55, 0.65, 1.0)), world=(0.1, (0.35, 0.4, 0.65)),
                  pane=(0.18, "#1b2440"), window=(0.0, (0.5, 0.6, 1.0))),
}
CEILING = {"on": 1.0, "spill": 0.42, "off": 0.0}


def clear_lights() -> None:
    for o in [o for o in bpy.data.objects if o.type == "LIGHT"]:
        bpy.data.objects.remove(o, do_unlink=True)


def lights(state: str = "day", ceiling: str = "off", zs: float = 1.0) -> None:
    """The light rig for one day state and one ceiling state. Items are rendered under `day`/`off`
    (their own shading is baked in; the room's state tints them at runtime); the shell is rendered
    under every state. Windows are on both back walls, so each gets a spot that pools light across
    the floor the way the painted `drawWindowBeams` does."""
    clear_lights()
    L = LIGHT_STATES[state]
    energy, color, elev = L["sun"]
    if energy > 0:
        bpy.ops.object.light_add(type="SUN", location=(0, 0, 400))
        key = bpy.context.active_object
        key.name = "key"
        key.data.energy = energy
        key.data.angle = math.radians(8)
        key.data.color = color
        key.rotation_euler = (math.radians(90 - elev), 0, math.radians(-120))
    f_energy, f_color = L["fill"]
    bpy.ops.object.light_add(type="SUN", location=(0, 0, 400))
    fill = bpy.context.active_object
    fill.name = "fill"
    fill.data.energy = f_energy
    fill.data.angle = math.radians(40)
    fill.data.color = f_color
    fill.rotation_euler = (math.radians(35), 0, math.radians(60))
    world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    w_strength, w_color = L["world"]
    bg.inputs["Color"].default_value = (*w_color, 1.0)
    bg.inputs["Strength"].default_value = w_strength
    # the panes' glow follows the state (the glow material is shared by every window)
    pane = bpy.data.materials.get("window-pane")
    if pane:
        bsdf = pane.node_tree.nodes.get("Principled BSDF")
        p_strength, p_hex = L["pane"]
        bsdf.inputs["Emission Color"].default_value = (*srgb(p_hex), 1)
        bsdf.inputs["Base Color"].default_value = (*srgb(p_hex), 1)
        bsdf.inputs["Emission Strength"].default_value = p_strength
    # window spots: one per window per wall, just outside the pane, aimed down across the floor
    w_energy, w_color = L["window"]
    if w_energy > 0:
        for which in (0, 1):
            for t0, t1, u0, u1, _ in WINDOWS:
                c = (t0 + t1) / 2 * FLOOR
                z = (u0 + u1) / 2 * WALL_H * zs
                # just inside the pane (a light behind the wall block lights nothing in the room)
                loc = (6, c, z) if which == 0 else (c, 6, z)
                aim = Vector((c + 260, c + 120, 0)) if which == 0 else Vector((c + 120, c + 260, 0))
                aim = Vector((260, c + 120, 0)) if which == 0 else Vector((c + 120, 260, 0))
                bpy.ops.object.light_add(type="SPOT", location=loc)
                sp = bpy.context.active_object
                sp.name = f"window-{which}-{t0}"
                sp.data.energy = w_energy * 1800
                sp.data.color = w_color
                sp.data.spot_size = math.radians(70)
                sp.data.spot_blend = 0.9
                sp.data.shadow_soft_size = 40
                sp.rotation_euler = (aim - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    # the ceiling bank: four warm area lights over the floor
    c_scale = CEILING[ceiling]
    if c_scale > 0:
        for cx, cy in ((FLOOR * 0.3, FLOOR * 0.3), (FLOOR * 0.7, FLOOR * 0.3), (FLOOR * 0.3, FLOOR * 0.7), (FLOOR * 0.7, FLOOR * 0.7)):
            bpy.ops.object.light_add(type="AREA", location=(cx, cy, 260 * zs))
            a = bpy.context.active_object
            a.name = f"ceiling-{cx}-{cy}"
            a.data.shape = "SQUARE"
            a.data.size = 220
            a.data.energy = 650000 * c_scale
            a.data.color = (1.0, 0.95, 0.86)
            a.rotation_euler = (0, 0, 0)


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
    """Build every static item the room renders (increment 2, plan Task 6), keyed by asset id.

    A desk, a plant, a shelf is rendered once at the floor's centre and blitted wherever `layout.ts`
    puts one (orthographic: the same image everywhere). Items that exist once — the bench, the nook
    set, reception, the meeting table — are modelled where they stand, so a wall-hugging piece can
    be rendered with the wall at its back and its shadow falls the right way.
    """
    clear()
    zs = z_scale(ky)
    export = collection("export")
    C = FLOOR / 2
    a: dict[str, bpy.types.Object] = {}
    # The shell — floor and both walls — is one image per light state (`room/light-<state>`),
    # rendered together under each rig; `render.py` iterates LIGHT_STATES for it. Its objects are
    # built once and carry the `shell` tag the renderer reads.
    shell = [floor_slab("room/floor", zs, export), wall("room/wall-left", 0, zs, export), wall("room/wall-right", 1, zs, export)]
    for o in shell:
        o["shell"] = True
    a["room/shell"] = shell[0]
    for pid, cx, cy, axis, size, fill, mark, weave in PODS:
        ns = axis == "ns"
        along, across = POD_RUG_SOLO if size == 1 else POD_RUG_DUO if size == 2 else POD_RUG
        w, d = (across, along) if ns else (along, across)
        a[f"rug/pod-{pid}"] = rug(f"rug/pod-{pid}", cx, cy, w, d, fill, mark, weave, zs, export)
    mw, md, mf, mm, mv = MEETING["rug"]
    a["rug/meeting"] = rug("rug/meeting", MEETING["lx"], MEETING["ly"], mw, md, mf, mm, mv, zs, export)
    rlx, rly, rw, rd, rf, rm, rv = RECEPTION["rug"]
    a["rug/reception"] = rug("rug/reception", rlx, rly, rw, rd, rf, rm, rv, zs, export)
    a["rug/nook"] = diamond_rug("rug/nook", NOOK[0], NOOK[1], NOOK_RUG_R, NOOK_RUG[0], NOOK_RUG[1], zs, export)
    a["desk/base"] = desk("desk/base", C, C, True, zs, export)
    a["desk/base-ew"] = desk("desk/base-ew", C, C, False, zs, export)
    a["bench/base"] = bench("bench/base", zs, export)
    a["plant/snake"] = plant("plant/snake", C, C, "snake", zs, export)
    a["plant/fiddle"] = plant("plant/fiddle", C, C, "fiddle", zs, export)
    for i, (lx, ly, d, long, deep, high, rows, tone) in enumerate(BOOKSHELVES):
        a[f"shelf/{i}"] = bookshelf(f"shelf/{i}", lx, ly, d, long, deep, high, rows, tone, zs, export)
    a["entrance"] = entrance("entrance", zs, export)
    a["nook/fridge"] = nook_fridge("nook/fridge", zs, export)
    a["nook/counter"] = nook_counter("nook/counter", zs, export)
    a["nook/cooler"] = nook_cooler("nook/cooler", zs, export)
    cz = LOUNGE["couch"]
    a["nook/couch"] = couch("nook/couch", NOOK[0] + cz["dx"], NOOK[1] + cz["dy"], cz["len"], cz["dep"], zs, export)
    tb = LOUNGE["table"]
    a["nook/table"] = low_table("nook/table", NOOK[0] + tb["dx"], NOOK[1] + tb["dy"], tb["w"], tb["d"], 16, zs, export)
    a["reception/desk"] = front_desk("reception/desk", zs, export)
    a["reception/endtable"] = end_table("reception/endtable", zs, export)
    ch = RECEPTION["chair"]
    a["reception/armchair"] = armchair("reception/armchair", ch[0], ch[1], WAIT_CHAIR, ch[2], zs, export)
    a["meeting/table"] = meeting_table("meeting/table", zs, export)
    for i, (dx, dy, facing) in enumerate(MEETING["chairs"]):
        a[f"meeting/chair-{i}"] = meeting_chair(f"meeting/chair-{i}", MEETING["lx"] + dx, MEETING["ly"] + dy, facing, zs, export)
    a["printer"] = printer("printer", zs, export)
    a["desk/lamp-off"] = desk_lamp("desk/lamp-off", False, zs, export)
    a["desk/lamp-on"] = desk_lamp("desk/lamp-on", True, zs, export)
    for frame in range(4):
        a[f"desk/fan-{frame}"] = desk_fan(f"desk/fan-{frame}", frame, zs, export)
    lights("day", "off", zs)
    camera(ky, px_per_unit, zs)
    return a

"""The member figure: a jointed body built from `skeleton.ts`'s proportions, identity meshes per
layer, and hand-keyed first-cut actions (office realism, plan Task 12; spec §2.1, §3.2).

Run through `render.py --figure`. No armature and no Mixamo: every part is a rigid mesh parented
to an Empty at its joint, and an action is a function of the frame's phase that sets joint
rotations — forward kinematics in a text file that diffs. The plan named Mixamo's auto-rigger;
that is a browser service behind an Adobe login, a human step the pipeline cannot run, and a
stock Mixamo walk is exactly the "some game's character" the spec rules out.

Layers (spec §3.2): every mesh is tagged with the layer id its pixels belong to. `render.py`
renders a frame twice — lit, in neutral grey, and as flat ID colours — and splits the lit frame
by ID into one image per layer. The split is exact: a pixel belongs to exactly one layer, so
`figure.ts` can draw the layers in any order and occlusion is already right.

Proportions are CHAR in skeleton.ts (floor units, heights drawn 1:1): 96 tall, head r 12.6 at
75.9 — five heads. The figure faces +x (heading 0 = E); `render.py` rotates it for each direction.
"""

from __future__ import annotations

import math

import bpy
from mathutils import Vector

import scene

# ── skeleton.ts CHAR, scaled ───────────────────────────────────────────────────────────────
# nick on the first figures (2026-10-20): "a little too big relative to everything else in the
# office", "heads too big". The painted member was 96 tall with a 12.6 head (3.7 heads). The
# rendered one is FIG × that: ~83 tall, and a 9.4 head — five heads, as spec §2.1 asks.
FIG = 0.92  # 0.86 read "a tiny bit" too small (nick, the second look)
HEIGHT = 96 * FIG
ANKLE, KNEE, HIP, CHEST, SHOULDER, NECK = (v * FIG for v in (3, 19, 36, 52, 58, 64))
HEAD_R = 9.4 * FIG
HEAD_C = NECK + 2.5 * FIG + HEAD_R * 1.02
HIP_W, SHOULDER_W = 7 * FIG, 14.5 * FIG
THIGH, SHIN, UPPER_ARM, FORE_ARM = (v * FIG for v in (17, 16, 15, 14))
# Not scaled: the chair cushion is where it is. A smaller figure sits lower in it, which reads right.
SEAT_TOP = 22  # layout.ts: top of the chair cushion, where a seated pelvis rests
# "it looks like the weight of the head is causing the bodies to lean back": the head and neck sit
# a touch forward of the spine, and the hair cap less far behind the skull.
HEAD_X = 1.6 * FIG
# The crown of the head (no hair), in floor units — what nameplates and bubbles hang above.
CROWN = HEAD_C + HEAD_R * 1.04

# ── layers ─────────────────────────────────────────────────────────────────────────────────
HAIR = ["buzz", "short", "side", "bob", "long", "ponytail", "afro", "bun"]
FACIAL = ["stubble", "moustache", "goatee", "beard"]
HATS = ["cap", "beanie", "band"]
TOPS = ["tee", "long", "stripe", "hoodie", "vest"]
ACCS = ["glasses", "headphones", "scarf"]
LAYERS = (
    ["skin"]
    + [f"hair/{h}" for h in HAIR]
    + [f"facial/{f}" for f in FACIAL]
    + [f"top/{t}" for t in TOPS]
    + ["bottom", "shoes"]
    + [f"hat/{h}" for h in HATS]
    + [f"acc/{a}" for a in ACCS]
    + ["visor"]
)
# Base layers are on every member and split by the ID pass; every other layer is one of an exclusive
# group (one hair style, one top, …) and is rendered alone with the base as a holdout.
BASE_LAYERS = {"skin", "bottom", "shoes", "visor"}
# the ID pass stores 9·(index+1) in the red byte — spaced so a nearest match survives rounding
ID_STEP = 9


def layer_id_byte(layer: str) -> int:
    return ID_STEP * (LAYERS.index(layer) + 1)


# ── materials ──────────────────────────────────────────────────────────────────────────────
def grey(name: str, v: float = 0.78, rough: float = 0.8) -> bpy.types.Material:
    """Neutral, tintable: `figure.ts` multiplies the member's colour over this."""
    return scene.matte(name, (v, v, v), rough)


def flat(name: str, rgb) -> bpy.types.Material:
    """An untinted layer's own colour (the visor), matte."""
    return scene.matte(name, rgb, 0.3)


# ── parts ──────────────────────────────────────────────────────────────────────────────────
class Rig:
    """Joints (Empties) and the meshes hung on them. Every mesh carries `layer` and `lit_mat`."""

    def __init__(self, zs: float, origin: Vector):
        self.zs = zs
        self.origin = origin
        self.joints: dict[str, bpy.types.Object] = {}
        self.meshes: list[bpy.types.Object] = []

    def joint(self, name: str, parent: str | None, x: float, y: float, z: float) -> bpy.types.Object:
        """A joint at (x, y, z) in figure space (rest pose), parented to `parent`."""
        bpy.ops.object.empty_add(type="PLAIN_AXES", radius=1)
        e = bpy.context.active_object
        e.name = f"j/{name}"
        if parent:
            p = self.joints[parent]
            e.parent = p
            pw = p.matrix_world.translation
            e.location = Vector((x, y, z * self.zs)) + self.origin - pw if parent == "root" else Vector((x, y, z * self.zs)) - (pw - self.origin)
        else:
            e.location = self.origin + Vector((x, y, z * self.zs))
        bpy.context.view_layer.update()
        self.joints[name] = e
        return e

    def _attach(self, o: bpy.types.Object, joint: str, layer: str, mat) -> bpy.types.Object:
        o.data.materials.append(mat)
        o["layer"] = layer
        o.parent = self.joints[joint]
        o.matrix_parent_inverse = self.joints[joint].matrix_world.inverted()
        self.meshes.append(o)
        return o

    def box(self, name, joint, layer, mat, x, y, z0, w, d, h, bev: float = 0.0) -> bpy.types.Object:
        """A block at figure (x, y) with its base at z0; `w` along x (forward), `d` across (y)."""
        o = scene.box(f"{layer}/{name}", self.origin.x + x, self.origin.y + y, z0, w, d, h, mat, self.zs)
        if bev:
            scene.bevel(o, bev, 3)
        return self._attach(o, joint, layer, mat)

    def ball(self, name, joint, layer, mat, x, y, ztop, rx, ry, rz) -> bpy.types.Object:
        """An ellipsoid whose TOP is at `ztop` (so a head of radius r centred at c is `ztop = c + r`)."""
        o = scene.ball(f"{layer}/{name}", self.origin.x + x, self.origin.y + y, ztop - 2 * rz, rx, ry, rz, mat, self.zs)
        return self._attach(o, joint, layer, mat)

    def cyl(self, name, joint, layer, mat, x, y, z0, r0, r1, h) -> bpy.types.Object:
        o = scene.cyl(f"{layer}/{name}", self.origin.x + x, self.origin.y + y, z0, r0, r1, h, mat, self.zs, 16)
        return self._attach(o, joint, layer, mat)

    def frustum(self, name, joint, layer, mat, x, y, z0, r0, r1, h, sy=1.0) -> bpy.types.Object:
        """A tapered cylinder (r0 at the bottom, r1 at the top) with an oval section `sy` wider across
        than deep — the torso: one smooth volume, waist to shoulders, no seams to bulge."""
        bpy.ops.mesh.primitive_cone_add(vertices=32, radius1=r0, radius2=r1, depth=h * self.zs)
        o = bpy.context.active_object
        o.name = f"{layer}/{name}"
        o.scale = (1.0, sy, 1.0)
        o.location = (self.origin.x + x, self.origin.y + y, (z0 + h / 2) * self.zs)
        scene.smooth(o)
        b = o.modifiers.new("bevel", "BEVEL")
        b.width = 1.2 * min(r0, r1)
        b.segments = 4
        b.limit_method = "ANGLE"
        return self._attach(o, joint, layer, mat)

    def torus(self, name, joint, layer, mat, x, y, zc, major, minor, rot=(0, 0, 0)) -> bpy.types.Object:
        bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, major_segments=24, minor_segments=8)
        o = bpy.context.active_object
        o.name = f"{layer}/{name}"
        o.location = (self.origin.x + x, self.origin.y + y, zc * self.zs)
        o.rotation_euler = rot
        o.scale = (1, 1, self.zs)
        scene.smooth(o)
        return self._attach(o, joint, layer, mat)


def build_figure(zs: float, origin: Vector) -> Rig:
    """The whole figure in its rest pose (standing, arms at the sides, facing +x), every layer built."""
    r = Rig(zs, origin)
    skin = grey("fig-skin", 0.8, 0.7)
    cloth = grey("fig-cloth", 0.78, 0.9)
    cloth_dark = grey("fig-cloth-dark", 0.55, 0.9)
    hair = grey("fig-hair", 0.75, 0.85)
    shoe = grey("fig-shoe", 0.7, 0.6)
    acc = grey("fig-acc", 0.72, 0.5)
    eye = scene.matte("fig-eye", (0.03, 0.03, 0.035), 0.4)
    mouth = scene.matte("fig-mouth", (0.35, 0.18, 0.18), 0.6)
    visor = flat("fig-visor", (0.25, 0.75, 0.85))

    # joints
    r.joint("root", None, 0, 0, 0)
    r.joint("hips", "root", 0, 0, HIP)
    r.joint("spine", "hips", 0, 0, HIP + 5 * FIG)
    r.joint("neck", "spine", 0, 0, NECK)
    r.joint("head", "neck", 0, 0, NECK + 3 * FIG)
    for side, sy in (("L", 1), ("R", -1)):
        r.joint(f"shoulder{side}", "spine", 0, sy * SHOULDER_W, SHOULDER)
        r.joint(f"elbow{side}", f"shoulder{side}", 0, sy * SHOULDER_W, SHOULDER - UPPER_ARM)
        r.joint(f"wrist{side}", f"elbow{side}", 0, sy * SHOULDER_W, SHOULDER - UPPER_ARM - FORE_ARM)
        r.joint(f"hip{side}", "hips", 0, sy * HIP_W, HIP)
        r.joint(f"knee{side}", f"hip{side}", 0, sy * HIP_W, KNEE)
        r.joint(f"ankle{side}", f"knee{side}", 0, sy * HIP_W, ANKLE)

    # ── skin: head with a face, neck, hands, forearms (a short sleeve leaves them bare)
    r.ball("head", "head", "skin", skin, HEAD_X, 0, HEAD_C + HEAD_R * 1.04, HEAD_R * 0.92, HEAD_R * 0.96, HEAD_R * 1.04)
    # tapered: a broader base where it meets the shoulders, so the head does not sit on a post
    r.cyl("neck", "neck", "skin", skin, HEAD_X * 0.6, 0, NECK - 2.5 * FIG, 3.6 * FIG, 2.7 * FIG, 7 * FIG)
    r.ball("nose", "head", "skin", skin, HEAD_X + HEAD_R * 0.86, 0, HEAD_C - 0.8 + 1.8, 1.9, 1.5, 1.8)
    for sy in (1, -1):
        # "some of the avatars look like they don't have eyes" (nick, 2026-10-21): at 2 px a unit a
        # 2.4-unit eye was a pixel or two and vanished. Taller ovals, set a touch wider, still under
        # the visor (its band runs HEAD_C + 0.4 … + 4.8).
        r.ball("eye", "head", "skin", eye, HEAD_X + HEAD_R * 0.8, sy * 3.4, HEAD_C + 4.1, 1.2, 1.45, 1.75)
        r.ball("ear", "head", "skin", skin, HEAD_X, sy * HEAD_R * 0.95, HEAD_C + 1.0 + 2.1, 1.3, 1.0, 2.1)
    r.box("mouth", "head", "skin", mouth, HEAD_X + HEAD_R * 0.84, 0, HEAD_C - 4.3, 0.9, 3.4, 1.0)
    for side, sy in (("L", 1), ("R", -1)):
        # The whole arm is skin under the sleeves: a sleeveless top (the vest) left the forearms
        # hanging in the air, and a swung sleeve opened a gap at the shoulder and the elbow (nick,
        # 2026-10-21: "the arms look very detached"). Balls at both joints keep the limb whole at any
        # angle; a sleeve, a size larger, covers them.
        r.ball("shoulder", f"shoulder{side}", "skin", skin, 0, sy * SHOULDER_W, SHOULDER + 2.3 * FIG, 3.2 * FIG, 3.2 * FIG, 3.2 * FIG)
        r.cyl("upperarm", f"shoulder{side}", "skin", skin, 0, sy * SHOULDER_W, SHOULDER - UPPER_ARM, 2.7 * FIG, 3.1 * FIG, UPPER_ARM)
        r.ball("elbow", f"elbow{side}", "skin", skin, 0, sy * SHOULDER_W, SHOULDER - UPPER_ARM + 2.7 * FIG, 2.7 * FIG, 2.7 * FIG, 2.7 * FIG)
        r.cyl("forearm", f"elbow{side}", "skin", skin, 0, sy * SHOULDER_W, SHOULDER - UPPER_ARM - FORE_ARM, 2.4 * FIG, 2.9 * FIG, FORE_ARM)
        r.ball("hand", f"wrist{side}", "skin", skin, 0.6, sy * SHOULDER_W, SHOULDER - UPPER_ARM - FORE_ARM - 1.5 * FIG + 3.2 * FIG, 3.0 * FIG, 2.4 * FIG, 3.2 * FIG)

    # ── hair: one silhouette each, all on the head
    # A hair cap sits BEHIND the hairline: centred back of the head's centre and a touch higher, so
    # the face (x > 0) stands proud of it and the body holdout cuts the cap off at the brow.
    cap = lambda layer, top=1.0, back=1.0, side=1.02: r.ball("cap", "head", layer, hair, HEAD_X - HEAD_R * 0.22, 0, HEAD_C + 2.4 + HEAD_R * top, HEAD_R * back, HEAD_R * side, HEAD_R * top)  # noqa: E731
    cap("hair/buzz", 0.98, 1.0, 0.98)
    cap("hair/short", 1.06, 1.1, 1.05)
    r.box("fringe", "head", "hair/short", hair, HEAD_X + HEAD_R * 0.7, 0, HEAD_C + 4.5, 3.2, 11, 4, 0.8)
    cap("hair/side", 1.06, 1.1, 1.05)
    r.box("sweep", "head", "hair/side", hair, HEAD_X + HEAD_R * 0.6, 3, HEAD_C + 4, 5, 10, 5, 1.2)
    cap("hair/bob", 1.08, 1.15, 1.12)
    for sy in (1, -1):
        r.box("bobside", "head", "hair/bob", hair, HEAD_X - 1.5, sy * HEAD_R * 0.95, HEAD_C - 6.5, 10, 3.4, 13, 1.2)
    cap("hair/long", 1.08, 1.15, 1.1)
    r.box("fall", "head", "hair/long", hair, HEAD_X - HEAD_R * 0.8, 0, HEAD_C - 17, 5, 13, 24, 1.6)
    cap("hair/ponytail", 1.04, 1.08, 1.03)
    r.cyl("tail", "head", "hair/ponytail", hair, HEAD_X - HEAD_R * 1.1, 0, HEAD_C - 8, 1.9, 3.0, 15)
    r.ball("afro", "head", "hair/afro", hair, HEAD_X - HEAD_R * 0.25, 0, HEAD_C + 2.4 + HEAD_R * 1.4, HEAD_R * 1.25, HEAD_R * 1.45, HEAD_R * 1.4)
    cap("hair/bun", 1.04, 1.06, 1.03)
    r.ball("bun", "head", "hair/bun", hair, HEAD_X - HEAD_R * 0.9, 0, HEAD_C + 5 + 3.8, 3.8, 3.8, 3.8)

    # ── facial hair
    r.box("stubble", "head", "facial/stubble", hair, HEAD_X + HEAD_R * 0.55, 0, HEAD_C - 8.5, 6.5, 11, 4, 1.2)
    r.box("moustache", "head", "facial/moustache", hair, HEAD_X + HEAD_R * 0.86, 0, HEAD_C - 2.9, 1.3, 5.6, 1.5, 0.4)
    r.box("goatee", "head", "facial/goatee", hair, HEAD_X + HEAD_R * 0.8, 0, HEAD_C - 9.6, 2.8, 4, 4, 0.8)
    r.ball("beard", "head", "facial/beard", hair, HEAD_X + HEAD_R * 0.45, 0, HEAD_C - 9.6 + 5.6, HEAD_R * 0.7, HEAD_R * 0.98, 5.6)

    # ── tops: a torso with a slight waist, and sleeves that follow the arms
    def torso(layer, mat=cloth):
        # "a little bit too block-ish" (nick): one smooth tapered volume from the waist to the
        # shoulders, oval in section — a slight waist, wider chest, rounded edges, no seams.
        z0 = HIP - 1 * FIG
        h = SHOULDER - z0
        r.frustum("torso", "spine", layer, mat, 0.3, 0, z0, 5.0 * FIG, 6.4 * FIG, h, sy=1.75)
        # The shoulders: a flattened ellipsoid over the top of the torso, so the line from the neck
        # falls away to each arm instead of meeting it at a flat lid ("the shoulders/neck are too
        # block-y", nick, 2026-10-21).
        r.ball("yoke", "spine", layer, mat, 0.3, 0, SHOULDER + 3.6 * FIG, 6.7 * FIG, 13.6 * FIG, 3.6 * FIG)

    def sleeves(layer, long: bool, mat=cloth):
        for side, sy in (("L", 1), ("R", -1)):
            # a rounded cap where the sleeve meets the yoke, turning with the arm
            r.ball("cap", f"shoulder{side}", layer, mat, 0, sy * SHOULDER_W, SHOULDER + 2.9 * FIG, 3.9 * FIG, 3.9 * FIG, 3.9 * FIG)
            r.cyl("sleeve", f"shoulder{side}", layer, mat, 0, sy * SHOULDER_W, SHOULDER - UPPER_ARM + 1 * FIG, 3.6 * FIG, 4.2 * FIG, UPPER_ARM - 1 * FIG)
            if long:
                r.ball("elbow", f"elbow{side}", layer, mat, 0, sy * SHOULDER_W, SHOULDER - UPPER_ARM + 3.5 * FIG, 3.5 * FIG, 3.5 * FIG, 3.5 * FIG)
                r.cyl("cuff", f"elbow{side}", layer, mat, 0, sy * SHOULDER_W, SHOULDER - UPPER_ARM - FORE_ARM + 1 * FIG, 3.0 * FIG, 3.4 * FIG, FORE_ARM - 1 * FIG)

    torso("top/tee"); sleeves("top/tee", False)
    torso("top/long"); sleeves("top/long", True)
    torso("top/stripe"); sleeves("top/stripe", True)
    for dz in (3, 9, 15, 20):
        z = HIP + dz * FIG
        on_chest = z > CHEST - 5 * FIG
        r.ball("stripe", "spine" if dz > 5 else "hips", "top/stripe", cloth_dark, 0.5 if on_chest else 0, 0, z + 1.3 * FIG, (6.8 if on_chest else 5.8) * FIG, (11.5 if on_chest else 8.2) * FIG, 1.3 * FIG)
    torso("top/hoodie"); sleeves("top/hoodie", True)
    r.ball("pocket", "hips", "top/hoodie", cloth_dark, 5.4 * FIG, 0, HIP + 7 * FIG, 1.2, 5.5 * FIG, 3.0 * FIG)
    r.ball("hood", "spine", "top/hoodie", cloth, -5 * FIG, 0, NECK - 1 * FIG + 5 * FIG, 6 * FIG, 9 * FIG, 5 * FIG)
    torso("top/vest", cloth_dark)

    # ── bottom: pelvis and trouser legs; shoes on the feet
    r.ball("pelvis", "hips", "bottom", cloth, 0, 0, HIP + 2.5 * FIG, 6.0 * FIG, 8.6 * FIG, 5.0 * FIG)
    for side, sy in (("L", 1), ("R", -1)):
        r.cyl("thigh", f"hip{side}", "bottom", cloth, 0, sy * HIP_W, KNEE - 1 * FIG, 3.6 * FIG, 4.4 * FIG, THIGH + 1 * FIG)
        r.ball("knee", f"knee{side}", "bottom", cloth, 0, sy * HIP_W, KNEE + 3.7 * FIG, 3.7 * FIG, 3.7 * FIG, 3.7 * FIG)
        r.cyl("shin", f"knee{side}", "bottom", cloth, 0, sy * HIP_W, ANKLE + 1 * FIG, 3.0 * FIG, 3.6 * FIG, SHIN - 1 * FIG)
        r.box("shoe", f"ankle{side}", "shoes", shoe, 2.5 * FIG, sy * HIP_W, 0, 10 * FIG, 5.5 * FIG, 4 * FIG, 1.2)

    # ── hats
    r.ball("cap", "head", "hat/cap", acc, HEAD_X - HEAD_R * 0.2, 0, HEAD_C + 4 + HEAD_R * 0.95, HEAD_R * 1.0, HEAD_R * 1.06, HEAD_R * 0.95)
    r.box("brim", "head", "hat/cap", acc, HEAD_X + HEAD_R * 1.05, 0, HEAD_C + 5.5, 7.5, 9, 1.2, 0.4)
    r.ball("beanie", "head", "hat/beanie", acc, HEAD_X - HEAD_R * 0.2, 0, HEAD_C + 5 + HEAD_R * 1.05, HEAD_R * 1.0, HEAD_R * 1.06, HEAD_R * 1.05)
    r.torus("band", "head", "hat/band", acc, HEAD_X, 0, HEAD_C + 4.8, HEAD_R * 1.0, 1.3)

    # ── accessories
    for sy in (1, -1):
        r.torus("lens", "head", "acc/glasses", acc, HEAD_X + HEAD_R * 1.02, sy * 3.3, HEAD_C + 2.0, 2.3, 0.8, (0, math.radians(90), 0))
        r.box("arm", "head", "acc/glasses", acc, HEAD_X + HEAD_R * 0.5, sy * HEAD_R * 0.98, HEAD_C + 1.8, HEAD_R * 1.0, 0.7, 0.7)
    r.box("bridge", "head", "acc/glasses", acc, HEAD_X + HEAD_R * 1.02, 0, HEAD_C + 1.8, 0.8, 2.8, 0.8)
    r.torus("headband", "head", "acc/headphones", acc, HEAD_X - 0.8, 0, HEAD_C + 3.2, HEAD_R * 1.08, 1.0, (math.radians(90), 0, 0))
    for sy in (1, -1):
        r.ball("cup", "head", "acc/headphones", acc, HEAD_X, sy * HEAD_R * 1.1, HEAD_C + 0.8 + 3.6, 3.6, 1.8, 3.6)
    r.torus("scarf", "neck", "acc/scarf", acc, HEAD_X * 0.6, 0, NECK + 1 * FIG, 5.6, 2.6)
    r.box("scarf-tail", "spine", "acc/scarf", acc, 6 * FIG, 2, CHEST - 2 * FIG, 2.6, 4.3, 8.6, 0.9)

    # ── the visor (agents): a band across the eyes, its own colour
    r.box("visor", "head", "visor", visor, HEAD_X + HEAD_R * 0.92, 0, HEAD_C + 0.4, 1.7, HEAD_R * 1.5, 4.4, 0.9)
    return r


# ── actions ────────────────────────────────────────────────────────────────────────────────
# A pose is {joint: (rx, ry, rz) in degrees} plus a root lift (floor units). A forward swing of a
# limb that hangs down is a NEGATIVE rotation about the lateral (y) axis — `swing` hides that.
def swing(deg: float) -> float:
    return -deg


STAND = {}
SEATED = {
    "hipL": (0, swing(88), 0), "hipR": (0, swing(88), 0),
    "kneeL": (0, swing(-86), 0), "kneeR": (0, swing(-86), 0),
    # Elbows bent, forearms level over the keyboard — the old near-straight arm (58°, 10°) read as
    # reaching, not typing. The hands land within a unit or two of where they did.
    "shoulderL": (0, swing(45), 0), "shoulderR": (0, swing(45), 0),
    "elbowL": (0, swing(45), 0), "elbowR": (0, swing(45), 0),
    "spine": (0, swing(-4), 0),
}
SEATED_LIFT = SEAT_TOP - HIP


def lerp_pose(a: dict, b: dict, t: float) -> dict:
    keys = set(a) | set(b)
    return {k: tuple(a.get(k, (0, 0, 0))[i] + (b.get(k, (0, 0, 0))[i] - a.get(k, (0, 0, 0))[i]) * t for i in range(3)) for k in keys}


def smoothstep(t: float) -> float:
    return t * t * (3 - 2 * t)


def action(name: str, t: float) -> tuple[dict, float]:
    """The pose and root lift of action `name` at phase `t` (0 → 1 over the clip)."""
    ph = 2 * math.pi * t
    if name == "idle":
        breath = math.sin(ph)
        return {"spine": (0, swing(1.5 * breath), 1.2 * math.sin(ph * 0.5)), "shoulderL": (0, 0, 4), "shoulderR": (0, 0, -4),
                "elbowL": (0, swing(8), 0), "elbowR": (0, swing(8), 0), "head": (0, swing(1.2 * breath), 0)}, 0.0
    if name == "walk":
        s = math.sin(ph)
        kneeL = 38 * max(0.0, -math.sin(ph - 0.4))
        kneeR = 38 * max(0.0, math.sin(ph - 0.4))
        return {"hipL": (0, swing(30 * s), 0), "hipR": (0, swing(-30 * s), 0),
                "kneeL": (0, swing(-kneeL), 0), "kneeR": (0, swing(-kneeR), 0),
                "shoulderL": (0, swing(-26 * s), 0), "shoulderR": (0, swing(26 * s), 0),
                "elbowL": (0, swing(22), 0), "elbowR": (0, swing(22), 0),
                "spine": (0, swing(5), 3 * s), "head": (0, swing(2), -2 * s)}, 1.4 * abs(s)
    if name in ("sit-type", "sit-idle"):
        pose = dict(SEATED)
        if name == "sit-type":
            pose["elbowL"] = (0, swing(45 + 6 * math.sin(ph)), 0)
            pose["elbowR"] = (0, swing(45 - 6 * math.sin(ph)), 0)
            pose["shoulderL"] = (0, swing(48), 0)
            pose["shoulderR"] = (0, swing(48), 0)
            pose["head"] = (0, swing(6), 0)
        else:
            pose["spine"] = (0, swing(-4 + 1.5 * math.sin(ph)), 0)
            pose["head"] = (0, swing(1.5 * math.sin(ph)), 3 * math.sin(ph * 0.5))
        return pose, SEATED_LIFT
    if name == "speak":
        return {"shoulderR": (0, swing(48 + 8 * math.sin(ph)), -10), "elbowR": (0, swing(78), 25 * math.sin(ph)),
                "shoulderL": (0, 0, 6), "elbowL": (0, swing(10), 0),
                "head": (0, swing(4 * math.sin(ph)), 5 * math.sin(ph * 0.5)), "spine": (0, swing(2), 0)}, 0.0
    if name == "turn":
        k = 1 - t
        return {"spine": (0, 0, 22 * k), "head": (0, 0, 30 * k), "shoulderL": (0, 0, 4), "shoulderR": (0, 0, -4)}, 0.0
    if name in ("sit-down", "stand-up"):
        k = smoothstep(t if name == "sit-down" else 1 - t)
        return lerp_pose(STAND, SEATED, k), SEATED_LIFT * k
    raise KeyError(name)


def apply_pose(rig: Rig, pose: dict, lift: float, heading_rad: float) -> None:
    for name, j in rig.joints.items():
        if name == "root":
            j.rotation_euler = (0, 0, heading_rad)
            j.location = rig.origin + Vector((0, 0, lift * rig.zs))
            continue
        rx, ry, rz = pose.get(name, (0, 0, 0))
        j.rotation_euler = (math.radians(rx), math.radians(ry), math.radians(rz))
    bpy.context.view_layer.update()


# ── the clips (frames at 12 fps) and the sheet layout ──────────────────────────────────────
CLIPS = [  # name, frames, loop — "not smooth enough" (nick, 2026-10-20): the loops doubled
    ("idle", 8, True),
    ("walk", 12, True),
    ("sit-type", 6, True),
    ("sit-idle", 8, True),
    ("speak", 8, True),
    ("turn", 3, False),
    ("sit-down", 4, False),
    ("stand-up", 4, False),
]
FPS = 12
DIRS = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"]  # figureSheet.ts DIR8, heading 0 = E, +45° clockwise
FRAME_W, FRAME_H = 56, 104  # floor units; the figure is ~83 tall plus a hat, ~26 wide with the arms out
ANCHOR_UP = 6  # the floor point sits this far above the frame's bottom edge


def figure_camera(ky: float, px_per_unit: float, zs: float, centre: Vector) -> bpy.types.Object:
    """The corner camera again, framed on one figure: `FRAME_W` units wide, floor point near the bottom."""
    elev = scene.elevation(ky)
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    cam.name = "figure-cam"
    cam.data.type = "ORTHO"
    cam.data.clip_start = 1.0
    cam.data.clip_end = 20000.0
    # Blender's ortho_scale spans the frame's LARGER side; the figure frame is portrait, so that is
    # its height (a width-based scale cut the feet off: the frame came out 35 units wide, 64 tall).
    cam.data.ortho_scale = max(FRAME_W, FRAME_H)
    # the camera's vertical axis on screen is world z scaled by cos(elev)·zs = 1 unit per unit, so
    # lifting the target by (FRAME_H/2 − ANCHOR_UP) puts the floor point ANCHOR_UP above the bottom
    target = centre + Vector((0, 0, (FRAME_H / 2 - ANCHOR_UP) * zs))
    dist = 3000.0
    cam.location = target + Vector((dist * math.cos(elev) * math.cos(math.radians(45)), dist * math.cos(elev) * math.sin(math.radians(45)), dist * math.sin(elev) * zs))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam
    return cam

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
# v2 (office figure v2 spec §2.1, nick 2026-10-22): a quarter of the way from the v1 figure's five
# heads toward the painted figure's 3.7 — "between A and B" — with the crown held where v1 had it, so
# labels, bubbles and the seat do not move: a bigger head sits on a body scaled down by `_K`.
_V1_HEAD_R = 9.4 * FIG
_V1_NECK = 64 * FIG
_CROWN = _V1_NECK + 2.5 * FIG + _V1_HEAD_R * 2.06
HEAD_R = _V1_HEAD_R + (HEIGHT / 3.7 / 2 - _V1_HEAD_R) * 0.25
_K = (_CROWN - 2.5 * FIG - HEAD_R * 2.06) / _V1_NECK
ANKLE, KNEE, HIP, CHEST, SHOULDER, NECK = (v * FIG * _K for v in (3, 19, 36, 52, 58, 64))
HEAD_C = NECK + 2.5 * FIG + HEAD_R * 1.02
HIP_W, SHOULDER_W = 6.6 * FIG, 13.2 * FIG
THIGH, SHIN, UPPER_ARM, FORE_ARM = (v * FIG * _K for v in (17, 16, 15, 14))
WRIST = SHOULDER - UPPER_ARM - FORE_ARM
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
# Carried things (increment 3b, plan Task 16): `figure.ts` maps a pose's CarryKind onto these. The
# moving box is `carry/box` in kraft with `carry/plant` poking out of it.
CARRY = ["laptop", "box", "plant", "plate", "card", "mug", "bottle", "phone"]
LAYERS = (
    ["skin", "eyes", "mouth/soft", "mouth/wide"]
    + [f"hair/{h}" for h in HAIR]
    + [f"facial/{f}" for f in FACIAL]
    + [f"top/{t}" for t in TOPS]
    + ["bottom", "shoes"]
    + [f"hat/{h}" for h in HATS]
    + [f"acc/{a}" for a in ACCS]
    # an agent's tell (nick, 2026-10-22: no visors on anyone): its eyes and a collar light glow, white
    # here and tinted with the agent's identity colour at runtime
    + ["tell/eyes", "tell/collar"]
    + [f"carry/{c}" for c in CARRY]
    # a first arrival's badge: the cord and the card's band take their colour, the card stays paper
    + ["lanyard", "lanyard-card"]
)
# Base layers are on every member and split by the ID pass; every other layer is one of an exclusive
# group (one hair style, one top, …) and is rendered alone with the base as a holdout.
BASE_LAYERS = ["skin", "eyes"]  # v2: the body alone; trousers and shoes are pieces over it (plan Task 4)
# the ID pass stores 9·(index+1) in the red byte — spaced so a nearest match survives rounding. Only
# the base is split by ID, so only the base needs a byte (the whole list would overflow 255).
ID_STEP = 9


def layer_id_byte(layer: str) -> int:
    return ID_STEP * (BASE_LAYERS.index(layer) + 1) if layer in BASE_LAYERS else 0


# The seated overlay (plan Task 16): a desk paints over a member sitting behind it, but their forearms
# rest ON it. For the seated clips, these layers also store just their arm pixels (`<layer>@arms`
# cells) — every mesh on a shoulder, elbow or wrist joint, plus the whole of a prop held at the desk —
# which `drawFigureFrame(part: 'arms')` draws again over the slab.
ARM_LAYERS = ["skin"] + [f"top/{t}" for t in TOPS] + ["carry/mug", "carry/plate"]


# ── materials ──────────────────────────────────────────────────────────────────────────────
def grey(name: str, v: float = 0.78, rough: float = 0.8) -> bpy.types.Material:
    """Neutral, tintable: `figure.ts` multiplies the member's colour over this."""
    return scene.matte(name, (v, v, v), rough)


def skin_mat(name: str, v: float) -> bpy.types.Material:
    """Neutral skin with a soft subsurface: light passes a little way in, so it reads as skin, not paint."""
    m = scene.matte(name, (v, v, v), 0.55)
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Subsurface Weight"].default_value = 0.35
    b.inputs["Subsurface Radius"].default_value = (1.0, 1.0, 1.0)
    b.inputs["Subsurface Scale"].default_value = 1.2
    return m


def hair_mat(name: str, v: float) -> bpy.types.Material:
    """Neutral hair with strands: a stretched wave bump the key light catches."""
    m = bpy.data.materials.new(name)
    nt, nodes, links, bsdf = scene._nodes(m)
    bsdf.inputs["Base Color"].default_value = (v, v, v, 1)
    bsdf.inputs["Roughness"].default_value = 0.5
    bsdf.inputs["Specular IOR Level"].default_value = 0.35
    tc = nodes.new("ShaderNodeTexCoord")
    wave = nodes.new("ShaderNodeTexWave")
    wave.inputs["Scale"].default_value = 1.6
    wave.inputs["Distortion"].default_value = 6
    wave.inputs["Detail"].default_value = 4
    wave.bands_direction = "Z"
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.35
    links.new(tc.outputs["Object"], wave.inputs["Vector"])
    links.new(wave.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return m


def flat(name: str, rgb) -> bpy.types.Material:
    """An untinted layer's own colour, matte."""
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
        o["arm"] = joint.startswith(("shoulder", "elbow", "wrist"))
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

    def orb(self, name, joint, layer, mat, x, y, zc, rx, ry, rz, fuse: str | None = None) -> bpy.types.Object:
        """`ball` by its centre, tagged with the fuse group it melts into (figure_fuse.py), if any."""
        o = self.ball(name, joint, layer, mat, x, y, zc + rz, rx, ry, rz)
        if fuse:
            o["fuse"] = fuse
        return o

    @staticmethod
    def turn(o: bpy.types.Object, euler: tuple[float, float, float]) -> bpy.types.Object:
        """Turn a part's mesh about its own centre. Setting `rotation_euler` after parenting turns it
        about the parent-inverse origin and flings it across the frame."""
        from mathutils import Euler, Matrix
        c = sum((Vector(b) for b in o.bound_box), Vector()) / 8
        o.data.transform(Matrix.Translation(c) @ Euler(euler).to_matrix().to_4x4() @ Matrix.Translation(-c))
        return o

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
    # v2 materials (spec §2.3): skin that lets a little light through, cloth with a weave, hair with a
    # strand texture. All neutral: `figure.ts` tints every layer, so a warm subsurface would warm a mint
    # skin too — the radius is equal in r, g and b.
    skin = skin_mat("fig-skin", 0.8)
    cloth = scene.fabric("fig-cloth", (0.78, 0.78, 0.78), 1.4)
    cloth_dark = scene.fabric("fig-cloth-dark", (0.55, 0.55, 0.55), 1.4)
    denim = scene.fabric("fig-denim", (0.78, 0.78, 0.78), 3.0)
    hair = hair_mat("fig-hair", 0.75)
    shoe = grey("fig-shoe", 0.7, 0.6)
    acc = grey("fig-acc", 0.72, 0.5)
    eye = scene.matte("fig-eye", (0.03, 0.025, 0.02), 0.15)  # the iris: gloss, so it catches the light
    eye_white = scene.matte("fig-eye-white", scene.srgb("#f2ece4"), 0.35)
    brow = grey("fig-brow", 0.3, 0.8)
    lips = grey("fig-lips", 0.42, 0.5)  # tinted with the skin at runtime: a darker shade of it
    mouth_in = grey("fig-mouth-in", 0.08, 0.6)

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

    # ── skin (v2, spec §2.1–2.2): one fused surface for the neck, arms, hands and legs, and a head
    # fused from a skull, a narrower jaw and cheeks — a chin, not a ball. Limbs taper to the wrist and
    # the ankle: one thickness everywhere is what read as a toy (nick, 2026-10-22).
    R = HEAD_R
    sk = lambda name, joint, x, y, zc, rx, ry, rz: r.orb(name, joint, "skin", skin, x, y, zc, rx, ry, rz, "skin")  # noqa: E731
    hd = lambda name, x, y, zc, rx, ry, rz: r.orb(name, "head", "skin", skin, x, y, zc, rx, ry, rz, "head")  # noqa: E731
    hd("head", HEAD_X, 0, HEAD_C + R * 0.02, R * 0.9, R * 0.88, R * 1.0)
    hd("jaw", HEAD_X + R * 0.18, 0, HEAD_C - R * 0.05, R * 0.72, R * 0.7, R * 0.72)
    for sy in (1, -1):
        hd("cheek", HEAD_X + R * 0.45, sy * R * 0.35, HEAD_C + R * 0.05, R * 0.38, R * 0.3, R * 0.3)
        hd("ear", HEAD_X - R * 0.05, sy * R * 0.86, HEAD_C + R * 0.3, R * 0.12, R * 0.08, R * 0.2)
        hd("lid", HEAD_X + R * 0.74, sy * R * 0.3, HEAD_C + R * 0.47, R * 0.13, R * 0.19, R * 0.08)
    # a nose with a bridge from the brow, a rounded tip that catches the light, and small wings — it was a
    # dot that vanished at office size (nick, 2026-10-22: "what about noses and mouths?")
    hd("bridge", HEAD_X + R * 0.86, 0, HEAD_C + R * 0.18, R * 0.12, R * 0.09, R * 0.26)
    hd("nose", HEAD_X + R * 0.96, 0, HEAD_C - R * 0.02, R * 0.15, R * 0.13, R * 0.14)
    for sy in (1, -1):
        hd("nostril", HEAD_X + R * 0.86, sy * R * 0.11, HEAD_C - R * 0.06, R * 0.1, R * 0.08, R * 0.08)
    # eyes are their own untinted layer: a skin tint over a white would turn it mint on a mint skin
    for sy in (1, -1):
        # "some of the avatars look like they don't have eyes" (nick, 2026-10-21): a white and an iris
        # that catches the light read at 1.5 px a unit where a dark dot vanished
        r.orb("eyewhite", "head", "eyes", eye_white, HEAD_X + R * 0.76, sy * R * 0.3, HEAD_C + R * 0.38, R * 0.1, R * 0.16, R * 0.15)
        r.orb("iris", "head", "eyes", eye, HEAD_X + R * 0.85, sy * R * 0.3, HEAD_C + R * 0.36, R * 0.05, R * 0.105, R * 0.125)
        r.turn(r.orb("brow", "head", "skin", brow, HEAD_X + R * 0.8, sy * R * 0.32, HEAD_C + R * 0.6, R * 0.08, R * 0.2, R * 0.045), (math.radians(sy * -8), 0, 0))
    # the mouth is the member's own smile (`appearance.ts` smile): its own layer, tinted with their skin,
    # so a darker grey reads as lips on any skin. Soft: corners just turned up. Wide: a broader curve,
    # parted, the inside dark.
    def smile(layer, half, lift, parted):
        for i in range(-3, 4):
            t = i / 3
            r.orb("lip", "head", layer, lips, HEAD_X + R * (0.83 - 0.06 * t * t), t * R * half, HEAD_C - R * 0.32 + lift * R * t * t,
                  R * 0.07, R * half / 3.2, R * (0.05 if parted else 0.04))
        if parted:
            r.orb("inside", "head", layer, mouth_in, HEAD_X + R * 0.84, 0, HEAD_C - R * 0.31, R * 0.05, R * half * 0.7, R * 0.025)
    smile("mouth/soft", 0.2, 0.05, False)
    smile("mouth/wide", 0.27, 0.09, True)
    # the neck: wider where it meets the shoulders and sloping into them (the trapezius), not a post the
    # head sits on (nick, 2026-10-22: "make their necks a little smoother/more natural looking")
    r.cyl("neck", "neck", "skin", skin, HEAD_X * 0.5, 0, NECK - 3 * FIG, 4.0 * FIG, 3.0 * FIG, 6.5 * FIG)["fuse"] = "skin"
    sk("nape", "neck", HEAD_X * 0.3, 0, NECK - 1.6 * FIG, 3.6 * FIG, 4.4 * FIG, 2.6 * FIG)
    for sy in (1, -1):
        r.turn(sk("trap", "spine", -0.4 * FIG, sy * 4.6 * FIG, SHOULDER + 1.0 * FIG, 3.0 * FIG, 4.6 * FIG, 1.7 * FIG), (math.radians(sy * 18), 0, 0))
    for side, sy in (("L", 1), ("R", -1)):
        y = sy * SHOULDER_W
        sk("shoulder", f"shoulder{side}", 0, y, SHOULDER - 0.4 * FIG, 3.1 * FIG, 3.0 * FIG, 3.0 * FIG)
        r.cyl("upperarm", f"shoulder{side}", "skin", skin, 0, y, SHOULDER - UPPER_ARM, 2.5 * FIG, 3.1 * FIG, UPPER_ARM)["fuse"] = "skin"
        sk("elbow", f"elbow{side}", 0, y, SHOULDER - UPPER_ARM, 2.4 * FIG, 2.4 * FIG, 2.4 * FIG)
        r.cyl("forearm", f"elbow{side}", "skin", skin, 0, y, WRIST, 2.05 * FIG, 2.65 * FIG, FORE_ARM)["fuse"] = "skin"
        sk("hand", f"wrist{side}", 0.4, y, WRIST - 1.2 * FIG, 2.6 * FIG, 1.9 * FIG, 3.3 * FIG)
        sk("thumb", f"wrist{side}", 1.9 * FIG, y - sy * 0.4 * FIG, WRIST - 1.4 * FIG, 1.0 * FIG, 0.9 * FIG, 1.7 * FIG)
    # legs, under the trousers: a skirt or a dress shows them (spec §3, the skin-only base)
    sk("hips", "hips", 0, 0, HIP + 1.5 * FIG, 5.2 * FIG, 7.8 * FIG, 4.4 * FIG)
    for side, sy in (("L", 1), ("R", -1)):
        y = sy * HIP_W
        r.cyl("thigh", f"hip{side}", "skin", skin, 0, y, KNEE, 2.6 * FIG, 3.7 * FIG, HIP - KNEE)["fuse"] = "skin"
        sk("knee", f"knee{side}", 0, y, KNEE, 2.6 * FIG, 2.6 * FIG, 2.6 * FIG)
        r.cyl("shin", f"knee{side}", "skin", skin, 0, y, ANKLE + 0.5 * FIG, 1.9 * FIG, 2.6 * FIG, KNEE - ANKLE - 0.5 * FIG)["fuse"] = "skin"
        sk("ankle", f"ankle{side}", 0.6, y, ANKLE + 0.6 * FIG, 1.9 * FIG, 1.8 * FIG, 1.4 * FIG)

    # ── hair (v2): a cap and clumps per style, fused into one sculpted volume — not a helmet, not a
    # slab fringe (spec §2.3). The cap sits back of the face and a touch high, so no scalp shows.
    def clump(layer, name, x, y, zc, rx, ry, rz, rot=None):
        o = r.orb(name, "head", layer, hair, x, y, zc, rx, ry, rz, layer)
        return r.turn(o, rot) if rot else o

    def cap(layer, k=1.0):
        clump(layer, "cap", HEAD_X - R * 0.22, 0, HEAD_C + R * 0.14, R * 1.02 * k, R * 1.0 * k, R * 1.04 * k)

    cap("hair/buzz", 0.97)
    cap("hair/short")
    for i, (y, dz, lean) in enumerate(((-0.5, 0.0, -10), (-0.15, 0.08, 6), (0.2, 0.02, -4), (0.52, -0.05, 12))):
        clump("hair/short", f"fringe{i}", HEAD_X + R * 0.55, y * R, HEAD_C + R * (0.77 + dz), R * 0.32, R * 0.3, R * 0.22, (math.radians(lean), math.radians(-25), 0))
    for i, (x, y) in enumerate(((0.0, -0.45), (0.1, 0.4), (-0.4, 0.0), (0.25, 0.0))):
        clump("hair/short", f"top{i}", HEAD_X + x * R, y * R, HEAD_C + R * 1.02, R * 0.4, R * 0.38, R * 0.32)
    cap("hair/side")
    for i, (y, dz) in enumerate(((-0.55, 0.15), (-0.2, 0.25), (0.15, 0.32), (0.5, 0.28))):
        clump("hair/side", f"sweep{i}", HEAD_X + R * 0.45, y * R, HEAD_C + R * (0.76 + dz * 0.4), R * 0.4, R * 0.35, R * 0.26, (math.radians(25), math.radians(-15), 0))
    cap("hair/bob", 1.04)
    for sy in (1, -1):
        clump("hair/bob", "side", HEAD_X - R * 0.1, sy * R * 0.78, HEAD_C - R * 0.25, R * 0.62, R * 0.32, R * 0.62)
    clump("hair/bob", "back", HEAD_X - R * 0.55, 0, HEAD_C - R * 0.2, R * 0.6, R * 0.9, R * 0.62)
    cap("hair/long", 1.04)
    clump("hair/long", "fall", HEAD_X - R * 0.7, 0, HEAD_C - R * 1.1, R * 0.45, R * 0.85, R * 1.5)
    for sy in (1, -1):  # strands over the front of the shoulders
        clump("hair/long", "front", HEAD_X - R * 0.05, sy * R * 0.75, HEAD_C - R * 1.0, R * 0.3, R * 0.28, R * 1.2)
    cap("hair/ponytail")
    clump("hair/ponytail", "tie", HEAD_X - R * 1.0, 0, HEAD_C + R * 0.2, R * 0.28, R * 0.28, R * 0.28)
    clump("hair/ponytail", "tail", HEAD_X - R * 1.2, 0, HEAD_C - R * 0.55, R * 0.3, R * 0.3, R * 0.85)
    # centred well back of the face, so the face stands in front of it (it covered the face at -0.25)
    clump("hair/afro", "afro", HEAD_X - R * 0.5, 0, HEAD_C + R * 0.3, R * 1.15, R * 1.42, R * 1.32)
    cap("hair/bun")
    clump("hair/bun", "bun", HEAD_X - R * 0.75, 0, HEAD_C + R * 0.95, R * 0.42, R * 0.42, R * 0.42)

    # ── facial hair, following the jaw
    stub = lambda name, *a: r.orb(name, "head", "facial/stubble", hair, *a, "facial/stubble")  # noqa: E731
    stub("jaw", HEAD_X + R * 0.25, 0, HEAD_C - R * 0.3, R * 0.7, R * 0.74, R * 0.42)
    stub("chin", HEAD_X + R * 0.55, 0, HEAD_C - R * 0.55, R * 0.3, R * 0.4, R * 0.2)
    r.orb("moustache", "head", "facial/moustache", hair, HEAD_X + R * 0.8, 0, HEAD_C - R * 0.24, R * 0.1, R * 0.3, R * 0.07)
    r.orb("goatee", "head", "facial/goatee", hair, HEAD_X + R * 0.62, 0, HEAD_C - R * 0.6, R * 0.22, R * 0.24, R * 0.2)
    r.orb("beard", "head", "facial/beard", hair, HEAD_X + R * 0.32, 0, HEAD_C - R * 0.5, R * 0.6, R * 0.66, R * 0.36, "facial/beard")
    r.orb("tache", "head", "facial/beard", hair, HEAD_X + R * 0.8, 0, HEAD_C - R * 0.24, R * 0.1, R * 0.3, R * 0.07, "facial/beard")

    # ── tops (v2): a torso with a waist that comes down over the trouser top, shoulders, sleeves —
    # all one fused garment per cut, so the sleeve flows out of the shoulder (spec §2.1)
    def torso(layer, mat=cloth, waist=5.2, chest=6.6):
        z0 = HIP - 1.5 * FIG
        r.frustum("torso", "spine", layer, mat, 0.3, 0, z0, waist * FIG, chest * FIG, SHOULDER - z0, sy=1.7)["fuse"] = layer
        r.orb("yoke", "spine", layer, mat, 0.3, 0, SHOULDER, 6.2 * FIG, 12.6 * FIG, 3.4 * FIG, layer)
        r.orb("belly", "hips", layer, mat, 0.5, 0, HIP + 2 * FIG, 5.6 * FIG, 8.4 * FIG, 4.0 * FIG, layer)

    def sleeves(layer, long: bool, mat=cloth):
        for side, sy in (("L", 1), ("R", -1)):
            y = sy * SHOULDER_W
            r.orb("cap", f"shoulder{side}", layer, mat, 0, y, SHOULDER - 0.5 * FIG, 3.7 * FIG, 3.6 * FIG, 3.6 * FIG, layer)
            r.cyl("sleeve", f"shoulder{side}", layer, mat, 0, y, SHOULDER - UPPER_ARM, 3.1 * FIG, 3.7 * FIG, UPPER_ARM)["fuse"] = layer
            if long:
                r.orb("elbow", f"elbow{side}", layer, mat, 0, y, SHOULDER - UPPER_ARM, 3.0 * FIG, 3.0 * FIG, 3.0 * FIG, layer)
                r.cyl("cuff", f"elbow{side}", layer, mat, 0, y, WRIST + 1.2 * FIG, 2.5 * FIG, 3.0 * FIG, FORE_ARM - 1.2 * FIG)["fuse"] = layer

    torso("top/tee"); sleeves("top/tee", False)
    torso("top/long"); sleeves("top/long", True)
    torso("top/stripe"); sleeves("top/stripe", True)
    for dz in (3, 9, 15, 20):
        z = HIP + dz * FIG * _K
        on_chest = z > CHEST - 5 * FIG
        r.ball("stripe", "spine" if dz > 5 else "hips", "top/stripe", cloth_dark, 0.5 if on_chest else 0, 0, z + 1.3 * FIG, (6.9 if on_chest else 6.0) * FIG, (11.6 if on_chest else 8.6) * FIG, 1.3 * FIG)
    torso("top/hoodie"); sleeves("top/hoodie", True)
    r.orb("pocket", "hips", "top/hoodie", cloth_dark, 5.4 * FIG, 0, HIP + 2.6 * FIG, 0.8, 5.0 * FIG, 2.6 * FIG)
    r.orb("hood", "spine", "top/hoodie", cloth, -4.2 * FIG, 0, NECK + 0.4 * FIG, 5.0 * FIG, 8.6 * FIG, 4.0 * FIG, "top/hoodie")
    torso("top/vest", cloth_dark)

    # ── bottom: a pelvis with a seat and trouser legs that taper to the ankle, one fused shape
    r.orb("pelvis", "hips", "bottom", denim, 0, 0, HIP + 2.5 * FIG, 5.6 * FIG, 8.2 * FIG, 5.0 * FIG, "bottom")
    for side, sy in (("L", 1), ("R", -1)):
        y = sy * HIP_W
        r.cyl("thigh", f"hip{side}", "bottom", denim, 0, y, KNEE, 3.0 * FIG, 4.2 * FIG, HIP - KNEE + 1 * FIG)["fuse"] = "bottom"
        r.orb("knee", f"knee{side}", "bottom", denim, 0, y, KNEE, 3.0 * FIG, 3.0 * FIG, 3.1 * FIG, "bottom")
        r.cyl("shin", f"knee{side}", "bottom", denim, 0, y, ANKLE + 1.5 * FIG, 2.5 * FIG, 3.0 * FIG, KNEE - ANKLE - 1.5 * FIG)["fuse"] = "bottom"
        # shoes: a rounded upper on a sole, not a block
        r.orb("shoe", f"ankle{side}", "shoes", shoe, 2.2 * FIG, y, 0.9 * FIG + 2.4 * FIG * 0.5, 5.2 * FIG, 2.7 * FIG, 2.4 * FIG, "shoes")
        r.orb("sole", f"ankle{side}", "shoes", shoe, 2.4 * FIG, y, 0.65 * FIG, 5.4 * FIG, 2.8 * FIG, 0.65 * FIG, "shoes")

    # ── hats, sized to the v2 head
    r.orb("cap", "head", "hat/cap", acc, HEAD_X - R * 0.2, 0, HEAD_C + R * 0.6, R * 1.04, R * 1.08, R * 0.7)
    r.box("brim", "head", "hat/cap", acc, HEAD_X + R * 0.95, 0, HEAD_C + R * 0.66, R * 0.75, R * 0.95, 1.0, 0.4)
    r.orb("beanie", "head", "hat/beanie", acc, HEAD_X - R * 0.2, 0, HEAD_C + R * 0.42, R * 1.06, R * 1.08, R * 0.95)
    r.torus("band", "head", "hat/band", acc, HEAD_X - R * 0.1, 0, HEAD_C + R * 0.62, R * 0.98, 1.3)

    # ── accessories: thin frames on the nose, cups over the ears, a scarf at the neck
    frame = scene.matte("fig-frame", (0.72, 0.72, 0.72), 0.3)
    for sy in (1, -1):
        r.torus("lens", "head", "acc/glasses", frame, HEAD_X + R * 0.95, sy * R * 0.3, HEAD_C + R * 0.36, R * 0.2, 0.32, (0, math.radians(90), 0))
        r.box("arm", "head", "acc/glasses", frame, HEAD_X + R * 0.45, sy * R * 0.9, HEAD_C + R * 0.34, R * 0.95, 0.3, 0.35)
    r.box("bridge", "head", "acc/glasses", frame, HEAD_X + R * 0.97, 0, HEAD_C + R * 0.34, 0.4, R * 0.2, 0.35)
    # over the top of the head from ear to ear: the ring's axis turned onto x (about x it looped through the face)
    r.torus("headband", "head", "acc/headphones", acc, HEAD_X - R * 0.1, 0, HEAD_C + R * 0.3, R * 1.08, 1.0, (0, math.radians(90), 0))
    for sy in (1, -1):
        r.orb("cup", "head", "acc/headphones", acc, HEAD_X - R * 0.05, sy * R * 0.98, HEAD_C + R * 0.3, R * 0.36, R * 0.2, R * 0.4)
    r.torus("scarf", "neck", "acc/scarf", acc, HEAD_X * 0.5, 0, NECK - 1.5 * FIG, 4.4 * FIG, 1.9 * FIG)
    r.box("scarf-tail", "spine", "acc/scarf", acc, 6.2 * FIG, 2, CHEST - 2 * FIG, 2.6, 4.3, 8.6, 0.9)

    # ── an agent's tell: the irises glow, and a thin ring of light sits at the neckline — read from every
    # side, quieter than the visor it replaces (nick, 2026-10-22)
    light = scene.glow("fig-tell", (1.0, 1.0, 1.0), 3.0)
    for sy in (1, -1):
        r.orb("iris", "head", "tell/eyes", light, HEAD_X + R * 0.87, sy * R * 0.3, HEAD_C + R * 0.36, R * 0.04, R * 0.1, R * 0.12)
    r.torus("collar", "spine", "tell/collar", light, HEAD_X * 0.4, 0, NECK - 2.6 * FIG, 3.9 * FIG, 0.45)

    # ── the lanyard (a first arrival, from the toss until they sit): a cord round the back of the neck
    # and down both sides of the chest to a badge. Rigid on the spine — it rides the torso's sway.
    card = scene.matte("fig-lanyard-card", scene.srgb("#f7f3ea"), 0.6)
    front = 0.3 + 6.4 * FIG * 0.98  # the torso's front at the chest
    cord = [r.torus("cord", "spine", "lanyard", cloth, HEAD_X * 0.4, 0, NECK - 0.5 * FIG, 4.6 * FIG, 0.55, (0, math.radians(-16), 0))]
    for sy in (1, -1):
        bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.55, depth=13 * FIG)
        o = bpy.context.active_object
        o.name = "lanyard/side"
        o.location = (r.origin.x + front - 1.2, r.origin.y + sy * 2.6 * FIG, (CHEST + 6.5 * FIG) * zs)
        o.rotation_euler = (math.radians(sy * 14), math.radians(-14), 0)
        o.scale = (1, 1, zs)
        cord.append(r._attach(o, "spine", "lanyard", cloth))
    cord.append(r.box("band", "spine", "lanyard", cloth, front + 0.5, 0, CHEST - 3.4 * FIG, 0.7, 5.2, 1.8))
    cord.append(r.box("badge", "spine", "lanyard-card", card, front + 0.4, 0, CHEST - 8.2 * FIG, 0.7, 5.2, 6.4))
    for o in cord:
        o["clips"] = STANDING_CLIPS
    build_props(r)
    return r


# ── carried things (increment 3b, plan Task 16) ─────────────────────────────────────────────────
# A prop is not jointed: after a frame is posed, `place_props` stands each one where the hands are —
# upright, turned with the body — the way the painter's `drawCarry` reads the solved wrists. A rigid
# child of the wrist would tip a mug upside down at the top of a sip. Each prop renders only on the
# clips that carry it (`clips`), so the rest of the sheet costs it nothing.
HOLD2 = ["walk-hold2", "idle-hold2"]  # both hands forward: the box, the moving box, a plate of food
HOLD1 = ["walk-hold1", "idle-hold1"]  # the right hand out in front: the card, a mug, a bottle
# the clips a standing member plays, which is where the lanyard shows
STANDING_CLIPS = ["idle", "walk", "speak", "turn", *HOLD2, *HOLD1, "walk-call",
                  "g-browse", "g-fill", "g-pour", "g-call", "g-reach", "g-wave"]


class Prop:
    def __init__(self, name: str, clips: list[str], place):
        bpy.ops.object.empty_add(type="PLAIN_AXES", radius=1)
        self.empty = bpy.context.active_object
        self.empty.name = f"prop/{name}"
        self.clips = clips
        self.place = place

    def add(self, rig: Rig, o: bpy.types.Object, layer: str) -> None:
        """`o` built at the world origin in floor units, unstretched (zs = 1); the empty stretches it."""
        o["layer"] = layer
        o["arm"] = False
        o["clips"] = self.clips
        o.parent = self.empty
        rig.meshes.append(o)


def _hand(rig: Rig, side: str) -> Vector:
    """The middle of a hand, in world space: past the wrist along the forearm."""
    w = rig.joints[f"wrist{side}"].matrix_world.translation
    e = rig.joints[f"elbow{side}"].matrix_world.translation
    return w + (w - e).normalized() * 2.6


def build_props(r: Rig) -> None:
    m = lambda name, hex6, rough=0.6: scene.matte(f"fig-prop-{name}", scene.srgb(hex6), rough)  # noqa: E731
    tint = grey("fig-prop-tint", 0.82, 0.7)
    tint_dark = grey("fig-prop-tint-dark", 0.58, 0.7)
    r.props = []
    up = lambda zs, dz: Vector((0, 0, dz * zs))  # noqa: E731

    # the member's own closed laptop, tucked under the right arm — it rides the elbow, so the arm's
    # swing carries it, and sits just inside the arm against the body
    lap = Prop("laptop", ["idle", "walk", "speak", "turn"],
               lambda rig, f, l, zs: rig.joints["elbowR"].matrix_world.translation + l * 2.2 - up(zs, 1.5))
    o = scene.box("carry/laptop", 0, 0, -6, 17, 1.4, 12, m("laptop", "#c7ccd2", 0.35), 1)
    scene.bevel(o, 0.5, 2)
    lap.add(r, o, "carry/laptop")
    r.props.append(lap)

    # the handoff box (and the moving box, in kraft) at the chest between both hands; the plant in it
    mid = lambda rig: (_hand(rig, "L") + _hand(rig, "R")) / 2  # noqa: E731
    box = Prop("box", HOLD2, lambda rig, f, l, zs: mid(rig) - f * 1.2)
    box.add(r, scene.box("carry/box", 0, 0, -6.5, 12, 14.4, 13, tint, 1), "carry/box")
    box.add(r, scene.box("carry/box-lid", 0, 0, 3.3, 12.2, 14.6, 3.4, tint_dark, 1), "carry/box")
    r.props.append(box)
    plant = Prop("plant", HOLD2, lambda rig, f, l, zs: mid(rig) - f * 1.2)
    plant.add(r, scene.ball("carry/plant", 1.5, 1, 4.5, 4.6, 4.6, 4.0, m("leaf", "#4f8a4b", 0.8), 1), "carry/plant")
    plant.add(r, scene.ball("carry/plant-lit", -1, -1.5, 8.5, 3.2, 3.2, 3.0, m("leaf-lit", "#79b36a", 0.8), 1), "carry/plant")
    r.props.append(plant)

    # a plate of food: resting on both palms on the way back from the fridge; in the left hand to eat
    def plate_meshes(p: Prop) -> None:
        p.add(r, scene.cyl("carry/plate", 0, 0, 0, 7.6, 8.2, 1.0, m("plate", "#f2e7d5", 0.4), 1, 24), "carry/plate")
        p.add(r, scene.ball("carry/food", 0, 0, 0.6, 4.4, 4.0, 1.6, m("food", "#c9744a", 0.8), 1), "carry/plate")

    held = Prop("plate", HOLD2, lambda rig, f, l, zs: mid(rig) + up(zs, 2.2))
    plate_meshes(held)
    r.props.append(held)
    eat = Prop("plate-eat", ["g-eat"], lambda rig, f, l, zs: _hand(rig, "L") + f * 2.5 + up(zs, 1.6))
    plate_meshes(eat)
    r.props.append(eat)

    # the lane's card, held up in front — the wall's own sticky size, a dark rim so pale paper reads
    # against a pale shirt; `g-reach` has it too, and the runtime only draws it once it's been taken
    card = Prop("card", [*HOLD1, "g-reach"], lambda rig, f, l, zs: _hand(rig, "R") + f * 0.8 + up(zs, 1.0))
    card.add(r, scene.box("carry/card-rim", 0, 0, 0, 0.5, 15.6, 10.6, m("card-rim", "#8f8470", 0.8), 1), "carry/card")
    card.add(r, scene.box("carry/card", 0.3, 0, 0.3, 0.4, 15, 10, m("card", "#efe8d8", 0.8), 1), "carry/card")
    card.add(r, scene.box("carry/card-tab", 0.5, 0, 9.0, 0.3, 7, 2.6, m("card-tab", "#b4a88f", 0.8), 1), "carry/card")
    r.props.append(card)

    # a mug held by its handle, the body just ahead of the fist (a hand this chunky hides a mug held
    # any other way): tinted — the desk mug's colour on a sip,
    # the break nook's ceramic on the way back from it
    mug = Prop("mug", [*HOLD1, "g-sip"], lambda rig, f, l, zs: _hand(rig, "R") + f * 5.4 - up(zs, 3.0))
    mug.add(r, scene.cyl("carry/mug", 0, 0, 0, 3.0, 3.2, 6.0, tint, 1, 20), "carry/mug")
    bpy.ops.mesh.primitive_torus_add(major_radius=1.8, minor_radius=0.6, major_segments=16, minor_segments=6)
    h = bpy.context.active_object
    h.name = "carry/mug-handle"
    h.location = (-3.4, 0, 3.0)
    h.rotation_euler = (math.radians(90), 0, 0)
    h.data.materials.append(tint)
    mug.add(r, h, "carry/mug")
    r.props.append(mug)

    # a mini of the desk water bottle, upright in the right hand, to and from the water cooler
    bottle = Prop("bottle", [*HOLD1, "g-fill"], lambda rig, f, l, zs: _hand(rig, "R") + f * 2.6 - up(zs, 4.0))
    bottle.add(r, scene.cyl("carry/bottle", 0, 0, 0, 2.3, 2.3, 10, m("bottle", "#bfe3f2", 0.25), 1, 20), "carry/bottle")
    bottle.add(r, scene.cyl("carry/bottle-cap", 0, 0, 10, 1.5, 1.5, 1.8, m("bottle-cap", "#5aa0c9", 0.5), 1, 16), "carry/bottle")
    r.props.append(bottle)

    # the phone: at the ear on a call, in the hand at the desk
    phone = Prop("phone", ["walk-call", "g-call", "g-pocketPhone"], lambda rig, f, l, zs: _hand(rig, "R") - up(zs, 2.3))
    phone.add(r, scene.box("carry/phone", 0, 0, 0, 0.8, 2.6, 4.8, m("phone", "#2b2b31", 0.3), 1), "carry/phone")
    r.props.append(phone)


def place_props(rig: Rig, clip: str, heading_rad: float) -> None:
    """Stand each prop the clip carries at its hands, upright and turned with the body."""
    from mathutils import Matrix

    f = Vector((math.cos(heading_rad), math.sin(heading_rad), 0))
    l = Vector((-math.sin(heading_rad), math.cos(heading_rad), 0))
    for p in rig.props:
        if clip not in p.clips:
            continue
        at = p.place(rig, f, l, rig.zs)
        p.empty.matrix_world = Matrix.Translation(at) @ Matrix.Diagonal((1, 1, rig.zs, 1)) @ Matrix.Rotation(heading_rad, 4, "Z")
    bpy.context.view_layer.update()


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


# ── gestures (increment 3b) ────────────────────────────────────────────────────────────────
# The painter's beats (skeleton.ts `applyOverlays`), hand-keyed as joint rotations. Two kinds:
#   env — the clip IS the envelope: frame k is the pose at envelope k/(n−1), from the base pose to the
#         peak. The runtime maps the beat's own envelope (arc, hold, or a rise) onto it, so a beat that
#         goes out and comes back costs half the frames and plays at any length.
#   seq — the beat has its own motion inside the window (a rub, a rock, a bite), so frames sample the
#         window itself: frame k is gestureT = (k + ½)/n.
# A raise of the arm to the side is a rotation about x: + for the left (+y) arm, − for the right.
def _abduct(side: str, deg: float) -> float:
    return deg if side == "L" else -deg


SEATED_REST = dict(SEATED)
LAP = {"shoulderL": (0, swing(18), 0), "shoulderR": (0, swing(18), 0),
       "elbowL": (0, swing(55), 0), "elbowR": (0, swing(55), 0)}


def _merge(*poses: dict) -> dict:
    out: dict = {}
    for p in poses:
        out.update(p)
    return out


GESTURES: dict = {
    # ── seated, at the desk ──
    "stretch": ("seated", "env", {"shoulderL": (_abduct("L", 18), swing(165), 0), "shoulderR": (_abduct("R", 18), swing(165), 0),
                                  "elbowL": (0, swing(12), 0), "elbowR": (0, swing(12), 0),
                                  "spine": (0, swing(12), 0), "head": (0, swing(16), 0)}),
    "glance": ("seated", "env", {"head": (0, 0, 38), "neck": (0, 0, 10)}),
    "chin": ("seated", "env", {"shoulderR": (_abduct("R", 6), swing(72), 0), "elbowR": (0, swing(142), 0), "head": (0, swing(-8), 0)}),
    "lean": ("seated", "env", _merge(LAP, {"spine": (0, swing(24), 0), "head": (0, swing(-6), 0)})),
    "roll": ("seated", "env", _merge(LAP, {"spine": (0, swing(9), 0)})),
    "settle": ("seated", "env", {"shoulderR": (_abduct("R", 45), swing(-35), 0), "elbowR": (0, swing(55), 0),
                                 "spine": (_abduct("L", 7), swing(8), 0), "head": (_abduct("L", 5), 0, 0)}),
    "behindHead": ("seated", "env", {"shoulderL": (_abduct("L", 70), swing(140), 0), "shoulderR": (_abduct("R", 70), swing(140), 0),
                                     "elbowL": (0, swing(150), 0), "elbowR": (0, swing(150), 0),
                                     "spine": (0, swing(18), 0), "head": (0, swing(4), 0)}),
    "rubEyes": ("seated", "env", {"shoulderR": (_abduct("R", 4), swing(80), 0), "elbowR": (0, swing(145), 0),
                                  "head": (0, swing(-20), 0), "neck": (0, swing(-7), 0)}),
    "pocketPhone": ("seated", "env", {"shoulderR": (0, swing(22), 0), "elbowR": (0, swing(85), 0),
                                      "head": (0, swing(-26), 8), "neck": (0, swing(-8), 0)}),
    # ── standing, at a fixture or on the floor ──
    "browse": ("standing", "env", {"shoulderR": (_abduct("R", 14), swing(95), 0), "elbowR": (0, swing(22), 0),
                                   "spine": (0, swing(-8), 0), "head": (0, swing(-12), 0)}),
    "fill": ("standing", "env", {"shoulderR": (0, swing(40), 0), "elbowR": (0, swing(62), 0),
                                 "spine": (0, swing(-12), 0), "head": (0, swing(-12), 0)}),
    "pour": ("standing", "env", {"shoulderR": (0, swing(68), 0), "elbowR": (0, swing(52), 0), "spine": (0, swing(-5), 0)}),
    "call": ("standing", "env", {"shoulderR": (_abduct("R", 32), swing(22), 0), "elbowR": (_abduct("R", 150), 0, 0),
                                 "head": (_abduct("R", -6), 0, 0)}),
    # one clip for both legs of the card: `reach` plays it forward, `take` backward
    "reach": ("standing", "env", {"shoulderR": (_abduct("R", 6), swing(150), 0), "elbowR": (0, swing(12), 0), "head": (0, swing(12), 0)}),
}


def _seq(name: str, t: float) -> dict:
    """The seq beats' own motion over the window `t` (0 → 1); the envelope rides inside."""
    arc = math.sin(smoothstep(t) * math.pi)
    hold = min(smoothstep(min(1.0, t / 0.18)), 1.0, smoothstep(min(1.0, (1 - t) / 0.18)))
    if name == "scratch":
        rub = math.sin(t * 2 * math.pi * 4) * 6 * arc
        return {"shoulderR": (_abduct("R", 38 * arc), swing(118 * arc), 0), "elbowR": (0, swing(10 + 125 * arc + rub), 0),
                "head": (_abduct("L", 9 * arc), 0, 0)}
    if name == "sip":
        up = smoothstep(min(1.0, t / 0.28)) if t < 0.72 else 1 - smoothstep((t - 0.72) / 0.28)
        tip = math.sin(((t - 0.28) / 0.44) * math.pi) if 0.28 <= t <= 0.72 else 0.0
        return {"shoulderR": (0, swing(45 + 20 * up), 0), "elbowR": (0, swing(45 + 98 * up), 0), "head": (0, swing(11 * tip), 0)}
    if name == "swivel":
        yaw = math.sin(smoothstep(t) * 3 * math.pi) * 9.2  # chairYaw's 0.16 rad
        return {"hips": (0, 0, yaw)}
    if name == "shoulders":
        back = math.sin(smoothstep(t) * math.pi * 2) * arc
        return {"shoulderL": (_abduct("L", 6 * arc), swing(45 - 14 * back), 0), "shoulderR": (_abduct("R", 6 * arc), swing(45 - 14 * back), 0),
                "shoulderL.loc": (-1.6 * back, 0, 2.4 * arc), "shoulderR.loc": (-1.6 * back, 0, 2.4 * arc),
                "head": (0, swing(-5 * arc), 0)}
    if name == "eat":
        bite = (math.sin(t * 2 * math.pi * 3) + 1) / 2 * hold
        return {"shoulderL": (0, swing(35), 0), "elbowL": (0, swing(80), 0),
                "shoulderR": (0, swing(35 + 25 * bite), 0), "elbowR": (0, swing(80 + 62 * bite), 0)}
    if name == "wave":
        rock = math.sin(t * math.pi * 5) * 22 * arc
        # upper arm out to the side, forearm up, rocking about the elbow
        return {"shoulderR": (_abduct("R", 82 * arc), swing(14 * arc), 0), "elbowR": (_abduct("R", 78 * arc) + rock, 0, 0),
                "head": (0, 0, -6 * arc)}
    raise KeyError(name)


SEQ_BASE = {"scratch": "seated", "sip": "seated", "swivel": "seated", "shoulders": "seated", "eat": "seated", "wave": "standing"}


def gesture_pose(name: str, x: float) -> tuple[dict, float]:
    """Gesture `name` at `x` — the envelope for an env clip, gestureT for a seq clip."""
    if name in GESTURES:
        base_name, _, peak = GESTURES[name]
        base = SEATED_REST if base_name == "seated" else STAND
        return lerp_pose(base, _merge(base, peak), x), (SEATED_LIFT if base_name == "seated" else 0.0)
    base = SEATED_REST if SEQ_BASE[name] == "seated" else STAND
    return _merge(base, _seq(name, x)), (SEATED_LIFT if SEQ_BASE[name] == "seated" else 0.0)


def sample(name: str, f: int, frames: int) -> float:
    """The clip parameter of frame `f`: the envelope k/(n−1) for an env gesture, (k + ½)/n for a seq
    gesture, and the loop phase f/n for the base clips."""
    if name.startswith("g-"):
        g = name[2:]
        return f / (frames - 1) if g in GESTURES else (f + 0.5) / frames
    return f / frames


# The carrying arms (plan Task 16), laid over a walk or the idle — the painter's carry overlays: both
# hands forward and a little in at the chest, or the right hand out in front, or the phone at the ear.
# The other arm keeps its counter-swing.
ARMS_HOLD2 = {"shoulderL": (_abduct("L", -12), swing(22), 0), "shoulderR": (_abduct("R", -12), swing(22), 0),
              "elbowL": (0, swing(78), 0), "elbowR": (0, swing(78), 0)}
ARMS_HOLD1 = {"shoulderR": (0, swing(22), 0), "elbowR": (0, swing(88), 0)}
ARMS_CALL = {k: v for k, v in GESTURES["call"][2].items() if k in ("shoulderR", "elbowR")}
CARRY_ARMS = {"hold2": ARMS_HOLD2, "hold1": ARMS_HOLD1, "call": ARMS_CALL}


def action(name: str, t: float) -> tuple[dict, float]:
    """The pose and root lift of action `name` at phase `t` (0 → 1 over the clip)."""
    if name.startswith("g-"):
        return gesture_pose(name[2:], t)
    if name == "sit-hand":
        # Seated with something to say (a bubble): the painter's help hand — the right hand up and a
        # little out, so it reads as "over here" from across the room.
        pose, lift = action("sit-idle", t)
        return _merge(pose, {"shoulderR": (_abduct("R", 24), swing(158), 0), "elbowR": (0, swing(18), 0),
                             "head": (0, swing(-4), 0)}), lift
    if name.startswith(("walk-", "idle-")):
        base, arms = name.split("-", 1)
        pose, lift = action(base, t)
        return _merge(pose, CARRY_ARMS[arms]), lift
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
    rest = getattr(rig, "rest_loc", None)
    if rest is None:
        rest = rig.rest_loc = {n: j.location.copy() for n, j in rig.joints.items()}
    for name, j in rig.joints.items():
        if name == "root":
            j.rotation_euler = (0, 0, heading_rad)
            j.location = rig.origin + Vector((0, 0, lift * rig.zs))
            continue
        rx, ry, rz = pose.get(name, (0, 0, 0))
        j.rotation_euler = (math.radians(rx), math.radians(ry), math.radians(rz))
        # `<joint>.loc`: a small translation in the parent's frame (the shoulder roll lifts the joint)
        dx, dy, dz = pose.get(f"{name}.loc", (0, 0, 0))
        j.location = rest[name] + Vector((dx, dy, dz * rig.zs))
    bpy.context.view_layer.update()


# ── the clips (frames at 12 fps) and the sheet layout ──────────────────────────────────────
# The directions a gesture is seen in: a desk beat only ever faces a desk (E/N rendered, S/W their
# mirrors), and so do the errands at a fixture. `None` is every rendered direction.
CARDINAL = ["E", "N"]
CLIPS = [  # name, frames, loop, dirs — "not smooth enough" (nick, 2026-10-20): the loops doubled
    ("idle", 8, True, None),
    ("walk", 12, True, None),
    ("sit-type", 6, True, None),
    ("sit-idle", 8, True, None),
    ("speak", 8, True, None),
    ("turn", 3, False, None),
    ("sit-down", 4, False, None),
    ("stand-up", 4, False, None),
    # increment 3b — every beat the painter plays (figureSheet.ts ANIMS lists them in this order)
    *[(f"g-{g}", 6, False, CARDINAL) for g in GESTURES],
    *[(f"g-{g}", n, False, CARDINAL) for g, n in (("scratch", 8), ("sip", 8), ("swivel", 8), ("shoulders", 8), ("eat", 10), ("wave", 10))],
    # plan Task 16 — the carrying walks and holds (appended, so every earlier clip keeps its cells)
    ("walk-hold2", 12, True, None),
    ("walk-hold1", 12, True, None),
    ("walk-call", 12, True, None),
    ("idle-hold2", 8, True, None),
    ("idle-hold1", 8, True, None),
    # Task 17 (parity): the raised hand of a seated member with a bubble
    # one frame, held: every frame of it stores whole skin and top cells (the sleeve brings the torso),
    # so an eight-frame wave cost 519 KB and two frames 165 KB — the painter's wave is a ±3-unit
    # wobble nobody reads at office scale, the raised hand is what reads
    ("sit-hand", 1, True, None),
]
# A carrying clip changes only the arms, the sleeves and what is held (and the lanyard the arms can
# cover): every other layer is the same pixels as the walk or the idle it is laid over, so it is not
# stored again — `frameCell` reads those layers from the base clip (`base` and `layers` in figure.json).
CARRY_BASE = {"walk-hold2": "walk", "walk-hold1": "walk", "walk-call": "walk", "idle-hold2": "idle", "idle-hold1": "idle",
              # the raised hand is the same: only the arm moves over the seated idle
              "sit-hand": "sit-idle"}
CARRY_OWN = ("skin", "top/", "carry/", "lanyard")


def stored_in(clip: str, layer: str) -> bool:
    """Whether `layer` has frames of its own in `clip`."""
    return clip not in CARRY_BASE or layer.startswith(CARRY_OWN)


# The clips a member plays seated at a desk — the ones whose arms the overlay pass redraws.
SEATED_CLIPS = {"sit-type", "sit-idle", "sit-hand"} | {f"g-{g}" for g, (base, _, _) in GESTURES.items() if base == "seated"} | {
    f"g-{g}" for g, base in SEQ_BASE.items() if base == "seated"}
FPS = 12
DIRS = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"]  # figureSheet.ts DIR8, heading 0 = E, +45° clockwise
FRAME_W, FRAME_H = 72, 104  # floor units; ~83 tall plus a hat; 72 wide since a held-out hand (a mug, a card) reaches ~30 from the floor point
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

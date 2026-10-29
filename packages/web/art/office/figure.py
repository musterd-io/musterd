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
HAIR = ["buzz", "short", "side", "bob", "long", "ponytail", "afro", "bun", "slicked", "curly", "tousled"]
FACIAL = ["stubble", "moustache", "goatee", "beard", "beard-wild"]
HATS = ["cap", "beanie", "band", "bucket"]
TOPS = ["tee", "long", "stripe", "hoodie", "vest"]
# outer layers (v2-5b): worn over a top; the outermost carries the identity hue
OUTERS = ["cardigan", "blazer", "zip"]
# one-pieces (v2-6a): worn instead of a top and a bottom
DRESSES = ["shift"]
ACCS = ["glasses", "glasses-square", "glasses-browline", "headphones", "scarf", "earrings-stud", "earrings-hoop", "watch", "bracelet", "headphones-neck"]
# Carried things (increment 3b, plan Task 16): `figure.ts` maps a pose's CarryKind onto these. The
# moving box is `carry/box` in kraft with `carry/plant` poking out of it. `folder` is appended last so
# every earlier layer keeps its place.
CARRY = ["laptop", "box", "plant", "plate", "card", "mug", "bottle", "phone", "folder"]
LAYERS = (
    ["skin", "eyes", "mouth/soft", "mouth/wide"]
    + [f"hair/{h}" for h in HAIR]
    + [f"facial/{f}" for f in FACIAL]
    + [f"top/{t}" for t in TOPS]
    + [f"outer/{o}" for o in OUTERS]
    + [f"dress/{d}" for d in DRESSES]
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
# the wrist pieces (v2-4c) ride the forearm, so the seated overlay and the carrying poses keep them
ARM_LAYERS = ["skin"] + [f"top/{t}" for t in TOPS] + ["carry/mug", "carry/plate", "acc/watch", "acc/bracelet"] + [f"outer/{o}" for o in OUTERS] + [f"dress/{d}" for d in DRESSES]


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


def hair_mat(name: str, v: float, strands: float = 1.6) -> bpy.types.Material:
    """Neutral hair with strands: a stretched wave bump the key light catches. `strands` is the wave
    scale — 1.6 reads as hair on the head, ~4 as the finer grain of facial hair (v2-3a)."""
    m = bpy.data.materials.new(name)
    nt, nodes, links, bsdf = scene._nodes(m)
    bsdf.inputs["Base Color"].default_value = (v, v, v, 1)
    bsdf.inputs["Roughness"].default_value = 0.5
    bsdf.inputs["Specular IOR Level"].default_value = 0.35
    tc = nodes.new("ShaderNodeTexCoord")
    wave = nodes.new("ShaderNodeTexWave")
    wave.inputs["Scale"].default_value = strands
    wave.inputs["Distortion"].default_value = 6
    wave.inputs["Detail"].default_value = 4
    wave.bands_direction = "Z"
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.35
    links.new(tc.outputs["Object"], wave.inputs["Vector"])
    links.new(wave.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return m


def stripe_mat(name: str, period: float) -> bpy.types.Material:
    """Neutral cloth in two greys, banded on world height every `period` (world units): painted on the
    fused surface, so the stripes follow the body instead of floating as discs in front of it (v2-2)."""
    m = bpy.data.materials.new(name)
    nt, nodes, links, bsdf = scene._nodes(m)
    bsdf.inputs["Roughness"].default_value = 0.95
    bsdf.inputs["Specular IOR Level"].default_value = 0.1
    bsdf.inputs["Sheen Weight"].default_value = 0.4
    tc = nodes.new("ShaderNodeTexCoord")
    wave = nodes.new("ShaderNodeTexWave")
    wave.bands_direction = "Z"
    wave.inputs["Scale"].default_value = 2 * math.pi / (20 * period)  # Blender's bands: sin(20 · scale · z)
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "CONSTANT"
    ramp.color_ramp.elements[0].color = (0.8, 0.8, 0.8, 1)
    ramp.color_ramp.elements[1].position = 0.62  # the dark band is the narrower one
    ramp.color_ramp.elements[1].color = (0.5, 0.5, 0.5, 1)
    links.new(tc.outputs["Object"], wave.inputs["Vector"])
    links.new(wave.outputs["Fac"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
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
    # facial hair: finer strands than the head, and stubble darker and sparser still (v2-3a)
    facial = hair_mat("fig-facial", 0.7, strands=4.2)
    stubble_mat = hair_mat("fig-stubble", 0.58, strands=9.0)
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
    # (v2-3b) polished: short gets a tapered nape and neat sideburns; side gets a real parting — a lifted
    # mass on the heavy side swept across, a flatter one on the other — and a tidy back
    for sy in (1, -1):
        clump("hair/short", "sideburn", HEAD_X + R * 0.2, sy * R * 0.86, HEAD_C + R * 0.05, R * 0.16, R * 0.12, R * 0.3)
        clump("hair/side", "sideburn", HEAD_X + R * 0.2, sy * R * 0.86, HEAD_C + R * 0.05, R * 0.16, R * 0.12, R * 0.3)
    for i, y in enumerate((-0.3, 0.3)):
        clump("hair/short", f"nape{i}", HEAD_X - R * 0.78, y * R, HEAD_C - R * 0.3, R * 0.32, R * 0.36, R * 0.42)
    clump("hair/side", "heavy", HEAD_X + R * 0.1, -R * 0.35, HEAD_C + R * 0.98, R * 0.62, R * 0.55, R * 0.34, (math.radians(-12), 0, 0))
    clump("hair/side", "light", HEAD_X + R * 0.1, R * 0.55, HEAD_C + R * 0.9, R * 0.5, R * 0.36, R * 0.26)
    clump("hair/side", "back", HEAD_X - R * 0.7, 0, HEAD_C - R * 0.1, R * 0.45, R * 0.85, R * 0.6)
    cap("hair/bob", 1.04)
    for sy in (1, -1):
        clump("hair/bob", "side", HEAD_X - R * 0.1, sy * R * 0.78, HEAD_C - R * 0.25, R * 0.62, R * 0.32, R * 0.62)
    clump("hair/bob", "back", HEAD_X - R * 0.55, 0, HEAD_C - R * 0.2, R * 0.6, R * 0.9, R * 0.62)
    cap("hair/long", 1.04)
    clump("hair/long", "fall", HEAD_X - R * 0.7, 0, HEAD_C - R * 1.1, R * 0.45, R * 0.85, R * 1.5)
    for sy in (1, -1):  # strands over the front of the shoulders
        clump("hair/long", "front", HEAD_X - R * 0.05, sy * R * 0.75, HEAD_C - R * 1.0, R * 0.3, R * 0.28, R * 1.2)
    # (v2-3b) polished: the bob gets a soft fringe and ends that curl under at the jaw; long hair gets
    # crown volume and layered falls down the back instead of one slab
    for i, y in enumerate((-0.42, 0.0, 0.42)):
        clump("hair/bob", f"fringe{i}", HEAD_X + R * 0.62, y * R, HEAD_C + R * 0.74, R * 0.3, R * 0.34, R * 0.2, (0, math.radians(-30), 0))
    for sy in (1, -1):
        clump("hair/bob", "curl", HEAD_X + R * 0.05, sy * R * 0.74, HEAD_C - R * 0.72, R * 0.42, R * 0.3, R * 0.18)
    clump("hair/long", "crown", HEAD_X - R * 0.3, 0, HEAD_C + R * 0.82, R * 0.8, R * 0.9, R * 0.4)
    for i, (y, dz, k) in enumerate(((-0.42, -0.2, 0.9), (0.42, -0.25, 0.9), (0.0, -0.55, 1.05))):
        clump("hair/long", f"layer{i}", HEAD_X - R * 0.82, y * R, HEAD_C - R * (0.9 - dz), R * 0.36, R * 0.4, R * 1.2 * k)
    cap("hair/ponytail")
    clump("hair/ponytail", "tie", HEAD_X - R * 1.0, 0, HEAD_C + R * 0.2, R * 0.28, R * 0.28, R * 0.28)
    clump("hair/ponytail", "tail", HEAD_X - R * 1.2, 0, HEAD_C - R * 0.55, R * 0.3, R * 0.3, R * 0.85)
    # (v2-3b) polished: the ponytail is gathered — strands pulled back over the crown into a band — and
    # the tail tapers in two pieces; the bun sits in a band with a wisp loose at the nape
    for sy in (1, -1):
        clump("hair/ponytail", "pull", HEAD_X - R * 0.45, sy * R * 0.42, HEAD_C + R * 0.62, R * 0.62, R * 0.3, R * 0.3, (0, math.radians(18), 0))
    r.torus("pony-band", "head", "hair/ponytail", hair, HEAD_X - R * 1.05, 0, HEAD_C + R * 0.08, R * 0.24, 0.5, (0, math.radians(80), 0))
    clump("hair/ponytail", "tip", HEAD_X - R * 1.28, 0, HEAD_C - R * 1.25, R * 0.2, R * 0.2, R * 0.45)
    r.torus("bun-band", "head", "hair/bun", hair, HEAD_X - R * 0.68, 0, HEAD_C + R * 0.66, R * 0.3, 0.5, (0, math.radians(-35), 0))
    for sy in (1, -1):
        clump("hair/bun", "wisp", HEAD_X - R * 0.62, sy * R * 0.5, HEAD_C - R * 0.42, R * 0.14, R * 0.12, R * 0.3)
    # centred well back of the face, so the face stands in front of it (it covered the face at -0.25)
    clump("hair/afro", "afro", HEAD_X - R * 0.5, 0, HEAD_C + R * 0.3, R * 1.15, R * 1.42, R * 1.32)
    # (v2-3b) polished: the buzz gets a shaped hairline and sideburns, so it reads as a cut, not a cap;
    # the afro gets a rounded, textured surface — smaller curls standing out of the big volume
    clump("hair/buzz", "hairline", HEAD_X + R * 0.58, 0, HEAD_C + R * 0.62, R * 0.32, R * 0.7, R * 0.2)
    for sy in (1, -1):
        clump("hair/buzz", "sideburn", HEAD_X + R * 0.2, sy * R * 0.86, HEAD_C + R * 0.08, R * 0.14, R * 0.1, R * 0.26)
    for i in range(14):
        a, b = i * 2.399, (i % 5) / 4.0  # golden-angle round the volume, five bands top to sides
        el = math.radians(-20 + 85 * b)
        cx, cy, cz = HEAD_X - R * 0.5, 0, HEAD_C + R * 0.3
        clump("hair/afro", f"curl{i}", cx + R * 1.1 * math.cos(el) * math.cos(a) * 0.8, R * 1.35 * math.cos(el) * math.sin(a), cz + R * 1.25 * math.sin(el), R * 0.32, R * 0.32, R * 0.3)
    cap("hair/bun")
    clump("hair/bun", "bun", HEAD_X - R * 0.75, 0, HEAD_C + R * 0.95, R * 0.42, R * 0.42, R * 0.42)

    # (v2-3c) new: slicked back — close to the head, combed straight back from a high hairline into a
    # neat ridge at the crown that tucks in at the nape (polished pool)
    cap("hair/slicked", 0.99)
    for i, y in enumerate((-0.4, 0.0, 0.4)):
        clump("hair/slicked", f"comb{i}", HEAD_X - R * 0.15, y * R, HEAD_C + R * 0.88, R * 0.75, R * 0.26, R * 0.22, (0, math.radians(14), 0))
    clump("hair/slicked", "ridge", HEAD_X - R * 0.35, 0, HEAD_C + R * 1.0, R * 0.55, R * 0.6, R * 0.2)
    clump("hair/slicked", "nape", HEAD_X - R * 0.8, 0, HEAD_C - R * 0.15, R * 0.3, R * 0.7, R * 0.45)

    # (v2-3c) new: curly — a close cap covered in tight curls, a little fuller at the crown and sides,
    # clear of the face (relaxed pool)
    cap("hair/curly", 1.02)
    for i in range(22):
        a, b = i * 2.399, (i % 6) / 5.0
        el = math.radians(-5 + 80 * b)
        x, y = math.cos(el) * math.cos(a), math.cos(el) * math.sin(a)
        if x > 0.55 and el < math.radians(45):
            continue  # the face
        clump("hair/curly", f"curl{i}", HEAD_X - R * 0.22 + R * 0.98 * x, R * 1.0 * y, HEAD_C + R * 0.14 + R * 1.02 * math.sin(el), R * 0.24, R * 0.24, R * 0.22)

    # (v2-3c) new: tousled — medium length, pieces leaning every which way over the crown, a loose fringe
    # falling over one brow, ends flicking out over the ears and nape (relaxed pool)
    cap("hair/tousled", 1.03)
    for i, (x, y, z, lean, tw) in enumerate((
        (0.1, -0.45, 1.0, -28, 10), (0.15, 0.1, 1.08, 22, -14), (-0.25, 0.45, 1.0, 30, 8), (-0.45, -0.2, 0.95, -18, 20),
        (-0.1, 0.5, 0.9, 40, -6), (0.35, -0.1, 0.98, -10, -25), (-0.6, 0.25, 0.75, 15, 30),
    )):
        clump("hair/tousled", f"piece{i}", HEAD_X + x * R, y * R, HEAD_C + z * R, R * 0.6, R * 0.22, R * 0.16, (math.radians(lean), math.radians(tw), 0))
    clump("hair/tousled", "fringe", HEAD_X + R * 0.62, -R * 0.25, HEAD_C + R * 0.6, R * 0.3, R * 0.45, R * 0.24, (math.radians(-20), math.radians(-35), 0))
    for sy in (1, -1):
        clump("hair/tousled", "flick", HEAD_X - R * 0.15, sy * R * 0.92, HEAD_C - R * 0.05, R * 0.3, R * 0.18, R * 0.34, (math.radians(sy * 25), 0, 0))
    clump("hair/tousled", "nape", HEAD_X - R * 0.85, 0, HEAD_C - R * 0.35, R * 0.38, R * 0.75, R * 0.4)

    # ── facial hair (v2-3a, spec §2.4): each style is one fused group that follows the jaw, with a
    # trimmed and an untrimmed beard. Every piece is tinted with the hair colour at draw time; the
    # materials only set the grain — fine strands on a beard, a darker, sparser grain on stubble.
    def fh(layer, name, mat, x, y, zc, rx, ry, rz, rot=None):
        o = r.orb(name, "head", layer, mat, x, y, zc, rx, ry, rz, layer)
        return r.turn(o, rot) if rot else o

    def jaw_shell(layer, mat, k=1.0, drop=0.0):
        """Two cheek-to-jaw lobes and a chin, hugging the jawline; `k` fattens, `drop` lowers the chin."""
        for sy in (1, -1):
            fh(layer, f"jaw{'L' if sy > 0 else 'R'}", mat, HEAD_X + R * 0.18, sy * R * 0.5, HEAD_C - R * (0.34 + drop * 0.5), R * 0.5 * k, R * 0.36 * k, R * 0.3 * k, (0, 0, sy * math.radians(18)))
        fh(layer, "chin", mat, HEAD_X + R * 0.5, 0, HEAD_C - R * (0.56 + drop), R * 0.34 * k, R * 0.42 * k, R * 0.22 * k)

    def lip(layer, mat, k=1.0, droop=14):
        """A moustache as two lobes either side of the philtrum, drooping outward."""
        for sy in (1, -1):
            fh(layer, f"lip{'L' if sy > 0 else 'R'}", mat, HEAD_X + R * 0.8, sy * R * 0.17, HEAD_C - R * 0.25, R * 0.11 * k, R * 0.2 * k, R * 0.075 * k, (sy * math.radians(droop), 0, 0))

    # stubble: a shadow along the jaw and lip, thin, in the sparse grain
    jaw_shell("facial/stubble", stubble_mat, k=1.02)  # at k 0.92 it vanished into the skin at office size
    lip("facial/stubble", stubble_mat, k=1.0, droop=8)
    # moustache: the lobes alone, a touch fuller
    lip("facial/moustache", facial, k=1.5, droop=16)  # alone it has to carry the face: fuller than the beards' lip
    # goatee: chin tuft, a soul patch under the lip, and the moustache that frames the mouth
    fh("facial/goatee", "tuft", facial, HEAD_X + R * 0.58, 0, HEAD_C - R * 0.62, R * 0.24, R * 0.26, R * 0.24)
    fh("facial/goatee", "patch", facial, HEAD_X + R * 0.76, 0, HEAD_C - R * 0.42, R * 0.1, R * 0.1, R * 0.07)
    lip("facial/goatee", facial, k=1.1)
    # beard, trimmed: the jaw shell at the jawline, sideburns to the ear, the moustache joined to it
    jaw_shell("facial/beard", facial)
    for sy in (1, -1):
        fh("facial/beard", f"burn{'L' if sy > 0 else 'R'}", facial, HEAD_X - R * 0.08, sy * R * 0.8, HEAD_C + R * 0.05, R * 0.2, R * 0.14, R * 0.38)
    lip("facial/beard", facial, k=1.15)
    # beard, untrimmed: fuller and lumpier, the chin reaching down the neck, cheeks higher, and a
    # couple of stray clumps so the silhouette is not a shape anyone combed
    jaw_shell("facial/beard-wild", facial, k=1.3, drop=0.3)
    for sy in (1, -1):
        fh("facial/beard-wild", f"burn{'L' if sy > 0 else 'R'}", facial, HEAD_X - R * 0.05, sy * R * 0.82, HEAD_C + R * 0.1, R * 0.26, R * 0.2, R * 0.46)
        fh("facial/beard-wild", f"cheek{'L' if sy > 0 else 'R'}", facial, HEAD_X + R * 0.35, sy * R * 0.62, HEAD_C - R * 0.1, R * 0.3, R * 0.26, R * 0.28)
        fh("facial/beard-wild", f"stray{'L' if sy > 0 else 'R'}", facial, HEAD_X + R * 0.42, sy * R * 0.3, HEAD_C - R * 1.0, R * 0.16, R * 0.18, R * 0.22, (sy * math.radians(20), math.radians(-10), 0))
    fh("facial/beard-wild", "tip", facial, HEAD_X + R * 0.4, 0, HEAD_C - R * 1.12, R * 0.22, R * 0.26, R * 0.26)
    lip("facial/beard-wild", facial, k=1.45, droop=22)

    # ── tops (v2): a torso with a waist that comes down over the trouser top, shoulders, sleeves —
    # all one fused garment per cut, so the sleeve flows out of the shoulder (spec §2.1)
    def torso(layer, mat=cloth, waist=5.2, chest=6.6):
        z0 = HIP - 1.5 * FIG
        r.frustum("torso", "spine", layer, mat, 0.3, 0, z0, waist * FIG, chest * FIG, SHOULDER - z0, sy=1.7)["fuse"] = layer
        r.orb("yoke", "spine", layer, mat, 0.3, 0, SHOULDER, 6.2 * FIG, 12.6 * FIG, 3.4 * FIG, layer)
        r.orb("belly", "hips", layer, mat, 0.5, 0, HIP + 2 * FIG, 5.6 * FIG, 8.4 * FIG, 4.0 * FIG, layer)
        # over the skin's trapezius slopes, a size up: the smoothed yoke fell just under them and two
        # dots of skin showed through every top from behind (seen at the v2-2 look check, 2026-10-26)
        for sy in (1, -1):
            r.turn(r.orb("trap", "spine", layer, mat, -0.4 * FIG, sy * 4.6 * FIG, SHOULDER + 1.1 * FIG, 3.6 * FIG, 5.4 * FIG, 2.3 * FIG, layer),
                   (math.radians(sy * 18), 0, 0))

    def sleeves(layer, long: bool, mat=cloth):
        for side, sy in (("L", 1), ("R", -1)):
            y = sy * SHOULDER_W
            r.orb("cap", f"shoulder{side}", layer, mat, 0, y, SHOULDER - 0.5 * FIG, 3.7 * FIG, 3.6 * FIG, 3.6 * FIG, layer)
            r.cyl("sleeve", f"shoulder{side}", layer, mat, 0, y, SHOULDER - UPPER_ARM, 3.1 * FIG, 3.7 * FIG, UPPER_ARM)["fuse"] = layer
            if long:
                r.orb("elbow", f"elbow{side}", layer, mat, 0, y, SHOULDER - UPPER_ARM, 3.0 * FIG, 3.0 * FIG, 3.0 * FIG, layer)
                r.cyl("cuff", f"elbow{side}", layer, mat, 0, y, WRIST + 1.2 * FIG, 2.5 * FIG, 3.0 * FIG, FORE_ARM - 1.2 * FIG)["fuse"] = layer

    # v2-2 (spec §2.4): the finishing a garment has — a ribbed neck and hem bands, cuffs, a hoodie's
    # drawstrings. Each is its own mesh, NOT in the fuse group: the remesh would melt a band this thin
    # back into the cloth, and a separate band keeps its edge, which is what reads at 1.5 px a unit.
    rib = scene.fabric("fig-rib", (0.68, 0.68, 0.68), 6.0)

    def neck_rib(layer):
        r.torus("neckrib", "spine", layer, rib, HEAD_X * 0.4, 0, NECK - 2.3 * FIG, 4.2 * FIG, 0.6)

    def hem_band(layer, z, rad):
        """A short band round the sleeve at `z`, a touch proud of it, on the arm (so it rides the overlay)."""
        for side, sy in (("L", 1), ("R", -1)):
            joint = f"shoulder{side}" if z > SHOULDER - UPPER_ARM - 0.5 else f"elbow{side}"
            r.cyl("band", joint, layer, rib, 0, sy * SHOULDER_W, z, rad, rad, 1.3 * FIG)

    def waist_band(layer, mat=rib):
        o = r.torus("hem", "hips", layer, mat, 0.45, 0, HIP - 0.8 * FIG, 5.5 * FIG, 1.0)
        o.scale = (1.0, 1.5, o.scale.z)

    torso("top/tee"); sleeves("top/tee", False)
    neck_rib("top/tee")
    hem_band("top/tee", SHOULDER - UPPER_ARM - 0.1 * FIG, 3.3 * FIG)
    torso("top/long"); sleeves("top/long", True)
    neck_rib("top/long")
    hem_band("top/long", WRIST + 0.8 * FIG, 2.75 * FIG)  # cuffs
    # stripes painted on the cloth (`stripe_mat`), so they follow the fused surface; the period is the
    # discs' old spacing, about five units
    breton = stripe_mat("fig-stripe", 5.2 * FIG * zs)
    torso("top/stripe", breton); sleeves("top/stripe", True, breton)
    neck_rib("top/stripe")
    torso("top/hoodie"); sleeves("top/hoodie", True)
    hem_band("top/hoodie", WRIST + 0.8 * FIG, 2.8 * FIG)
    waist_band("top/hoodie")
    r.orb("pocket", "hips", "top/hoodie", cloth_dark, 5.4 * FIG, 0, HIP + 2.6 * FIG, 0.8, 5.0 * FIG, 2.6 * FIG)
    r.orb("hood", "spine", "top/hoodie", cloth, -4.2 * FIG, 0, NECK + 0.4 * FIG, 5.0 * FIG, 8.6 * FIG, 4.0 * FIG, "top/hoodie")
    # drawstrings from the hood's front down the chest, each ending in a pale aglet
    aglet = grey("fig-aglet", 0.92, 0.4)
    for sy in (1, -1):
        x, y = 0.3 + 6.7 * FIG, sy * 1.7 * FIG
        cord_o = r.cyl("string", "spine", "top/hoodie", rib, x, y, CHEST - 3.5 * FIG, 0.32, 0.32, SHOULDER - CHEST + 4.5 * FIG)
        r.turn(cord_o, (math.radians(sy * 4), math.radians(-6), 0))
        r.orb("aglet", "spine", "top/hoodie", aglet, x + 0.4, y, CHEST - 4.0 * FIG, 0.45, 0.45, 0.8 * FIG)
    torso("top/vest", cloth_dark)
    neck_rib("top/vest")
    # the armholes: a band round each, standing in the side plane where the arm leaves the vest
    for side, sy in (("L", 1), ("R", -1)):
        r.torus("armhole", "spine", "top/vest", rib, 0.3, sy * (SHOULDER_W - 1.0 * FIG), SHOULDER - 2.6 * FIG,
                3.5 * FIG, 0.8, (math.radians(90), 0, 0))

    # ── the dress (v2-6a, spec §2.4): a one-piece worn instead of a top and a bottom — a fitted bodice
    # with short sleeves and a skirt to just above the knee, the legs bare under it. The skirt is three
    # panels fused into one: a flared panel on each thigh that follows the leg (seated, it lies over the
    # lap instead of hanging through the chair like a rigid tube) and a centre panel on the hips that
    # closes the gap between them and drapes between the knees when sitting.
    torso("dress/shift")
    sleeves("dress/shift", False)
    neck_rib("dress/shift")
    hem_z = KNEE + 1.5 * FIG
    r.frustum("skirt-mid", "hips", "dress/shift", cloth, 0.3, 0, hem_z, 4.4 * FIG, 5.6 * FIG, HIP + 2.0 * FIG - hem_z, sy=1.3)["fuse"] = "dress/shift"
    for side, sy in (("L", 1), ("R", -1)):
        r.cyl("skirt-leg", f"hip{side}", "dress/shift", cloth, 0.2, sy * HIP_W * 0.85, hem_z, 4.9 * FIG, 4.3 * FIG, HIP + 1.0 * FIG - hem_z)["fuse"] = "dress/shift"

    # ── outer layers (v2-5b, spec §2.4): a size up over any top — a fuller body that reaches past the
    # trouser top, long sleeves over the top's — with each garment's own finishing. One layer each.
    def outer_body(layer, mat=cloth, drop=1.5):
        z0 = HIP - (1.5 + drop) * FIG
        r.frustum("torso", "spine", layer, mat, 0.3, 0, z0, 5.8 * FIG, 7.1 * FIG, SHOULDER - z0, sy=1.7)["fuse"] = layer
        r.orb("yoke", "spine", layer, mat, 0.3, 0, SHOULDER, 6.6 * FIG, 13.2 * FIG, 3.7 * FIG, layer)
        r.orb("belly", "hips", layer, mat, 0.5, 0, HIP + 2 * FIG, 6.0 * FIG, 8.9 * FIG, 4.3 * FIG, layer)
        for sy in (1, -1):
            r.turn(r.orb("trap", "spine", layer, mat, -0.4 * FIG, sy * 4.7 * FIG, SHOULDER + 1.2 * FIG, 3.9 * FIG, 5.7 * FIG, 2.6 * FIG, layer),
                   (math.radians(sy * 18), 0, 0))
        for side, sy in (("L", 1), ("R", -1)):
            y = sy * SHOULDER_W
            r.orb("cap", f"shoulder{side}", layer, mat, 0, y, SHOULDER - 0.5 * FIG, 4.1 * FIG, 4.0 * FIG, 4.0 * FIG, layer)
            r.cyl("sleeve", f"shoulder{side}", layer, mat, 0, y, SHOULDER - UPPER_ARM, 3.5 * FIG, 4.1 * FIG, UPPER_ARM)["fuse"] = layer
            r.orb("elbow", f"elbow{side}", layer, mat, 0, y, SHOULDER - UPPER_ARM, 3.4 * FIG, 3.4 * FIG, 3.4 * FIG, layer)
            r.cyl("cuff", f"elbow{side}", layer, mat, 0, y, WRIST + 1.6 * FIG, 2.9 * FIG, 3.4 * FIG, FORE_ARM - 1.6 * FIG)["fuse"] = layer

    front = 0.3 + 7.0 * FIG  # the outer body's front at the chest
    # the cardigan: soft knit, a deep V edged in rib, buttons down the placket, ribbed hem and cuffs
    outer_body("outer/cardigan", drop=2.5)
    for sy in (1, -1):
        r.turn(r.box("v-edge", "spine", "outer/cardigan", rib, front - 0.4, sy * 1.6 * FIG, CHEST - 2 * FIG, 0.7, 1.0 * FIG, 9 * FIG),
               (math.radians(sy * -16), 0, 0))
    for i in range(4):
        r.orb("button", "spine", "outer/cardigan", rib, front - 0.1 - i * 0.25, 0, CHEST - 4 * FIG - i * 3.2 * FIG, 0.55, 0.55, 0.55)
    r.cyl("placket", "spine", "outer/cardigan", rib, front - 0.6, 0, HIP - 3.5 * FIG, 0.5 * FIG, 0.5 * FIG, CHEST - HIP)
    o = r.torus("hem", "hips", "outer/cardigan", rib, 0.45, 0, HIP - 3.2 * FIG, 5.9 * FIG, 1.1)
    o.scale = (1.0, 1.5, o.scale.z)
    for side, sy in (("L", 1), ("R", -1)):
        r.cyl("cuffrib", f"elbow{side}", "outer/cardigan", rib, 0, sy * SHOULDER_W, WRIST + 0.9 * FIG, 3.0 * FIG, 3.0 * FIG, 1.5 * FIG)

    # the blazer: tailored — squared shoulders, notched lapels lying open in a V, two buttons at the
    # waist and flapped pockets at the hips, a hem past the trouser top
    outer_body("outer/blazer", cloth_dark, drop=3.0)
    for sy in (1, -1):
        r.orb("pad", f"shoulder{"L" if sy > 0 else "R"}", "outer/blazer", cloth_dark, 0, sy * SHOULDER_W, SHOULDER + 0.2 * FIG, 4.3 * FIG, 4.4 * FIG, 2.6 * FIG)
        r.turn(r.box("lapel", "spine", "outer/blazer", rib, front + 0.1, sy * 2.6 * FIG, CHEST - 4 * FIG, 1.0, 3.4 * FIG, 12 * FIG),
               (math.radians(sy * -22), 0, 0))
        r.box("pocket", "hips", "outer/blazer", cloth, 0.5 + 5.6 * FIG, sy * 5.2 * FIG, HIP - 0.5 * FIG, 0.8, 3.6 * FIG, 0.9 * FIG)
    for i in range(2):
        r.orb("button", "spine", "outer/blazer", rib, front, 0, HIP + 3.5 * FIG - i * 3.0 * FIG, 0.6, 0.6, 0.6)

    # the zip jacket: a stand collar, a zip pulled two-thirds up with its pull, a gathered waistband and
    # elastic cuffs
    outer_body("outer/zip", drop=1.0)
    zipper = grey("fig-zip", 0.85, 0.3)
    r.cyl("zip", "spine", "outer/zip", zipper, front + 0.2, 0, HIP - 2.2 * FIG, 0.6, 0.6, SHOULDER - HIP - 2 * FIG)
    r.orb("pull", "spine", "outer/zip", zipper, front + 0.4, 0, SHOULDER - 4.5 * FIG, 0.45, 0.6, 1.1)
    r.torus("collar", "spine", "outer/zip", cloth, HEAD_X * 0.4, 0, NECK - 2.0 * FIG, 4.6 * FIG, 1.4)
    o = r.torus("waist", "hips", "outer/zip", rib, 0.45, 0, HIP - 2.2 * FIG, 6.0 * FIG, 1.3)
    o.scale = (1.0, 1.5, o.scale.z)
    for side, sy in (("L", 1), ("R", -1)):
        r.cyl("cuffrib", f"elbow{side}", "outer/zip", rib, 0, sy * SHOULDER_W, WRIST + 0.9 * FIG, 2.9 * FIG, 2.9 * FIG, 1.4 * FIG)

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
    # (v2-4e) the cap: a rounded crown with a button on top and a curved bill, not a flat board
    r.orb("cap", "head", "hat/cap", acc, HEAD_X - R * 0.2, 0, HEAD_C + R * 0.6, R * 1.04, R * 1.08, R * 0.7)
    r.orb("cap-button", "head", "hat/cap", acc, HEAD_X - R * 0.2, 0, HEAD_C + R * 1.3, R * 0.12, R * 0.12, R * 0.07)
    r.orb("brim", "head", "hat/cap", acc, HEAD_X + R * 1.05, 0, HEAD_C + R * 0.68, R * 0.62, R * 0.88, R * 0.08)
    # the beanie: the knit crown, a thick folded-up cuff round the brow, and a pom on top
    r.orb("beanie", "head", "hat/beanie", acc, HEAD_X - R * 0.2, 0, HEAD_C + R * 0.42, R * 1.06, R * 1.08, R * 0.95)
    r.torus("beanie-cuff", "head", "hat/beanie", acc, HEAD_X - R * 0.16, 0, HEAD_C + R * 0.5, R * 1.02, R * 0.16)
    r.orb("beanie-pom", "head", "hat/beanie", acc, HEAD_X - R * 0.25, 0, HEAD_C + R * 1.42, R * 0.26, R * 0.26, R * 0.24)
    # a new hat: the bucket hat — a soft crown and a wide brim that slopes down all round
    r.cyl("bucket", "head", "hat/bucket", acc, HEAD_X - R * 0.15, 0, HEAD_C + R * 0.58, R * 1.02, R * 0.84, R * 0.9)
    r.cyl("bucket-brim", "head", "hat/bucket", acc, HEAD_X - R * 0.15, 0, HEAD_C + R * 0.5, R * 1.42, R * 1.0, R * 0.14)
    # the headband (v2-4d): a soft fabric band, taller than it is thick and following the head's slope —
    # higher at the back, low on the brow so it hugs the hair instead of floating over it like the old one —
    # with a small tied knot behind one ear, not the old round cord
    band = r.torus("band", "head", "hat/band", acc, HEAD_X - R * 0.12, 0, HEAD_C + R * 0.5, R * 1.04, 1.1, (0, math.radians(-14), 0))
    band.scale = (1, 1, 1.9)
    for dy, dz in ((0.18, 0.06), (0.34, -0.05)):
        r.orb("band-knot", "head", "hat/band", acc, HEAD_X - R * 1.08, R * dy, HEAD_C + R * (0.72 + dz), R * 0.1, R * 0.13, R * 0.09)

    # ── accessories: thin frames on the nose, cups over the ears, a scarf at the neck
    frame = scene.matte("fig-frame", (0.72, 0.72, 0.72), 0.3)
    for sy in (1, -1):
        r.torus("lens", "head", "acc/glasses", frame, HEAD_X + R * 0.95, sy * R * 0.3, HEAD_C + R * 0.36, R * 0.2, 0.32, (0, math.radians(90), 0))
        r.box("arm", "head", "acc/glasses", frame, HEAD_X + R * 0.45, sy * R * 0.9, HEAD_C + R * 0.34, R * 0.95, 0.3, 0.35)
    r.box("bridge", "head", "acc/glasses", frame, HEAD_X + R * 0.97, 0, HEAD_C + R * 0.34, 0.4, R * 0.2, 0.35)
    # two more frame shapes (figure v2-4a, spec §2.4 "several frame shapes"): square rims — four thin
    # bars a lens — and a browline, a heavy bar across the top of each lens with a fine rim below.
    # Each is its own layer; the eyes spot picks one of the three (`appearance.ts` EYES).
    lw, lh = R * 0.42, R * 0.36  # a lens's width and height on the face
    for sy in (1, -1):
        cy, cz = sy * R * 0.3, HEAD_C + R * 0.36
        # the square lens is a touch smaller than the round one, and its outer bar sits back on the cheek:
        # the face curves away there, and at the round lens's depth the bar floated in profile
        sw, sh = R * 0.36, R * 0.3
        for name, dx, dy, dz, w, h in (("top", 0.95, 0, sh / 2, sw, 0.34), ("bottom", 0.95, 0, -sh / 2, sw, 0.34), ("outer", 0.86, sy * sw / 2, 0, 0.34, sh), ("inner", 0.97, -sy * sw / 2, 0, 0.34, sh)):
            # `box` takes its BASE height, so each bar drops by half its own height to centre on the lens
            r.box(f"sq-{name}", "head", "acc/glasses-square", frame, HEAD_X + R * dx, cy + dy, cz + dz - h / 2, 0.4, w, h)
        r.box("sq-arm", "head", "acc/glasses-square", frame, HEAD_X + R * 0.45, sy * R * 0.9, HEAD_C + R * 0.34, R * 0.95, 0.3, 0.35)
        r.box("bl-brow", "head", "acc/glasses-browline", frame, HEAD_X + R * 0.95, cy, cz + lh * 0.42 - 0.375, 0.5, lw * 1.08, 0.75)
        r.torus("bl-rim", "head", "acc/glasses-browline", frame, HEAD_X + R * 0.95, cy, cz, R * 0.19, 0.2, (0, math.radians(90), 0))
        r.box("bl-arm", "head", "acc/glasses-browline", frame, HEAD_X + R * 0.45, sy * R * 0.9, HEAD_C + R * 0.36, R * 0.95, 0.3, 0.5)
    r.box("sq-bridge", "head", "acc/glasses-square", frame, HEAD_X + R * 0.97, 0, HEAD_C + R * 0.36 - 0.17, 0.4, R * 0.2, 0.34)
    r.box("bl-bridge", "head", "acc/glasses-browline", frame, HEAD_X + R * 0.97, 0, HEAD_C + R * 0.36 + lh * 0.42 - 0.3, 0.5, R * 0.2, 0.6)
    # over the top of the head from ear to ear: the ring's axis turned onto x (about x it looped through the face)
    r.torus("headband", "head", "acc/headphones", acc, HEAD_X - R * 0.1, 0, HEAD_C + R * 0.3, R * 1.08, 1.0, (0, math.radians(90), 0))
    for sy in (1, -1):
        r.orb("cup", "head", "acc/headphones", acc, HEAD_X - R * 0.05, sy * R * 0.98, HEAD_C + R * 0.3, R * 0.36, R * 0.2, R * 0.4)
    # earrings (figure v2-4b, spec §2.4 the ears spot): a stud on each lobe, or a small hoop hanging from
    # it, the ring turned to face sideways so it reads in profile. Untinted metal, tinted at runtime.
    lobe_x, lobe_y, lobe_z = HEAD_X - R * 0.05, R * 0.97, HEAD_C + R * 0.1
    metal = scene.matte("fig-metal", (0.9, 0.9, 0.9), 0.25)
    for sy in (1, -1):
        r.orb("stud", "head", "acc/earrings-stud", metal, lobe_x, sy * lobe_y, lobe_z, R * 0.07, R * 0.07, R * 0.07)
        r.torus("hoop", "head", "acc/earrings-hoop", metal, lobe_x, sy * (lobe_y + 0.2), lobe_z - R * 0.12, R * 0.12, 0.28, (math.radians(90), 0, 0))
    # the wrist spot (figure v2-4c): a watch on the left wrist — a band round the forearm just above the
    # hand, a round face on the back of the wrist — or a thin bracelet on the right. On the elbow joint,
    # so the seated overlay keeps them over the desk with the forearm.
    wz = WRIST + 0.7 * FIG
    r.torus("watch-band", "elbowL", "acc/watch", metal, 0, SHOULDER_W, wz, 2.2 * FIG, 0.45)
    r.orb("watch-face", "elbowL", "acc/watch", metal, 0, SHOULDER_W + 2.25 * FIG, wz, 1.0 * FIG, 0.45 * FIG, 1.0 * FIG)
    r.torus("bracelet", "elbowR", "acc/bracelet", metal, 0, -SHOULDER_W, wz, 2.25 * FIG, 0.35)
    # headphones around the neck (v2-4d): the band rests round the back of the neck, the cups lie on the
    # collarbones facing up. On the spine, so they ride the torso; on dnd they move up onto the ears.
    r.torus("neck-band", "spine", "acc/headphones-neck", acc, HEAD_X * 0.4, 0, NECK - 1.2 * FIG, 4.7 * FIG, 0.9, (0, math.radians(-18), 0))
    for sy in (1, -1):
        r.orb("neck-cup", "spine", "acc/headphones-neck", acc, HEAD_X * 0.4 + 3.4 * FIG, sy * 3.8 * FIG, NECK - 3.4 * FIG, R * 0.3, R * 0.34, R * 0.18)
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
    lap = Prop("laptop", ["idle", "walk", "speak", "turn", "sit-lap"],
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
    # a handoff's manila folder, held upright against the chest in both hands — the one it sets down on
    # the recipient's desk (`desk/folder-*`, lane 01M62X6FCC): two covers round the papers, the tab up
    folder = Prop("folder", HOLD2, lambda rig, f, l, zs: mid(rig) - f * 2.0)
    manila = m("folder-cover", "#e6b862", 0.75)
    folder.add(r, scene.box("carry/folder-back", -0.9, 0, -5.5, 0.5, 15, 11, manila, 1), "carry/folder")
    folder.add(r, scene.box("carry/folder-papers", 0, 0.3, -5.2, 1.2, 14, 11.2, m("folder-paper", "#fbf8f1", 0.85), 1), "carry/folder")
    folder.add(r, scene.box("carry/folder-front", 0.9, 0, -5.5, 0.5, 15, 10.2, manila, 1), "carry/folder")
    folder.add(r, scene.box("carry/folder-tab", -0.9, -3.6, 5.5, 0.5, 6, 1.8, m("folder-tab", "#d4a04c", 0.75), 1), "carry/folder")
    r.props.append(folder)

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
# Heads that look (lane 01M5XS5ZYP): a seated member turns the head toward the desk an act landed on.
# Head only — the body stays on the keyboard — split between head and neck the way `glance` is, so a
# 90° look is a turned head on a turned neck, not an owl. +z yaw is the figure's own left (it faces +x,
# z up). Rendered E and N like every seated gesture; the runtime mirrors S and W and flips the side.
# Listed after every other clip (CLIPS below) so the earlier clips keep their cells.
LOOKS: dict = {
    "look45L": ("seated", "env", {"head": (0, 0, 34), "neck": (0, 0, 11)}),
    "look45R": ("seated", "env", {"head": (0, 0, -34), "neck": (0, 0, -11)}),
    "look90L": ("seated", "env", {"head": (0, 0, 64), "neck": (0, 0, 26)}),
    "look90R": ("seated", "env", {"head": (0, 0, -64), "neck": (0, 0, -26)}),
}
GESTURES.update(LOOKS)


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
    if name == "sit-lap":
        # The seated idle's breath and sway with the arms down: hands resting in the lap (v3-6).
        pose, lift = action("sit-idle", t)
        return _merge(pose, LAP), lift
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
        # office v3-5 (nick: "the rocking animation for members is a little too much"): the sway is a
        # third of what it was — spine yaw 1.2° → 0.4°, pitch 1.5° → 0.8°, head 1.2° → 0.6°, shoulders ±4 → ±2
        breath = math.sin(ph)
        return {"spine": (0, swing(0.8 * breath), 0.4 * math.sin(ph * 0.5)), "shoulderL": (0, 0, 2), "shoulderR": (0, 0, -2),
                "elbowL": (0, swing(8), 0), "elbowR": (0, swing(8), 0), "head": (0, swing(0.6 * breath), 0)}, 0.0
    if name == "walk":
        # office v3-5 (nick: "gliding, walking on ice"): the walk plants its feet. The swing leg lifts
        # higher (knee to 50°), the stance leg is straight with its ankle counter-rotated so the sole
        # reads flat on the floor, the hips swing wider, the body bobs more and leans in, and the pelvis
        # rolls so the weight visibly transfers. `STRIDE` (skeleton.ts) is measured from this clip's
        # ankle travel by render.py (`anims.walk.contact`), so one gait cycle moves one stride.
        s = math.sin(ph)
        hipL, hipR = 34 * s, -34 * s
        kneeL = 50 * max(0.0, -math.sin(ph - 0.4))
        kneeR = 50 * max(0.0, math.sin(ph - 0.4))
        return {"hips": (3 * s, 0, 0),
                "hipL": (0, swing(hipL), 0), "hipR": (0, swing(hipR), 0),
                "kneeL": (0, swing(-kneeL), 0), "kneeR": (0, swing(-kneeR), 0),
                "ankleL": (0, swing(-hipL * 0.7 + kneeL * 0.5), 0), "ankleR": (0, swing(-hipR * 0.7 + kneeR * 0.5), 0),
                "shoulderL": (0, swing(-30 * s), 0), "shoulderR": (0, swing(30 * s), 0),
                "elbowL": (0, swing(26), 0), "elbowR": (0, swing(26), 0),
                "spine": (0, swing(4 + 1.0 * s), 3 * s), "head": (0, swing(2), -2 * s)}, 2.2 * abs(s)
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
    *[(f"g-{g}", 6, False, CARDINAL) for g in GESTURES if g not in LOOKS],
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
    # office v3-6 — a casual seat (stool, couch, meeting chair): hands in the lap, the closed laptop
    # under the right arm — "hands should be down (macbook under 1 arm)" (nick, 2026-10-26)
    ("sit-lap", 8, True, None),
    # heads that look (lane 01M5XS5ZYP) — figureSheet.ts LOOK_ANIMS, in this order
    *[(f"g-{g}", 6, False, CARDINAL) for g in LOOKS],
]
# A carrying clip changes only the arms, the sleeves and what is held (and the lanyard the arms can
# cover): every other layer is the same pixels as the walk or the idle it is laid over, so it is not
# stored again — `frameCell` reads those layers from the base clip (`base` and `layers` in figure.json).
CARRY_BASE = {"walk-hold2": "walk", "walk-hold1": "walk", "walk-call": "walk", "idle-hold2": "idle", "idle-hold1": "idle",
              # the raised hand is the same: only the arm moves over the seated idle
              "sit-hand": "sit-idle",
              # office v3-6: the lap arms over the seated idle
              "sit-lap": "sit-idle"}
CARRY_OWN = ("skin", "top/", "outer/", "dress/", "carry/", "lanyard", "acc/watch", "acc/bracelet")
# Layers a carrying clip stores beyond CARRY_OWN: the lap arms lie across the trousers, so sit-lap's
# `bottom` cells are its own (spec §8); every other carrying clip keeps the base clip's.
CARRY_OWN_EXTRA = {"sit-lap": ("bottom",)}


def own_layers(clip: str) -> tuple[str, ...]:
    """The layer prefixes `clip` stores itself (figure.json `layers`) when it rides a base clip."""
    return CARRY_OWN + CARRY_OWN_EXTRA.get(clip, ())


def stored_in(clip: str, layer: str) -> bool:
    """Whether `layer` has frames of its own in `clip`."""
    return clip not in CARRY_BASE or layer.startswith(own_layers(clip))


# The clips a member plays seated at a desk — the ones whose arms the overlay pass redraws.
SEATED_CLIPS = {"sit-type", "sit-idle", "sit-hand", "sit-lap"} | {f"g-{g}" for g, (base, _, _) in GESTURES.items() if base == "seated"} | {
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

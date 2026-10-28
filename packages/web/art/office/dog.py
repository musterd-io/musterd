"""The office dog: a jointed terrier built like the member figure (rigid parts on joint Empties, an
action is a function of the clip's phase), rendered whole — one sheet, its own colours, never tinted
(office realism increment 4, lane 01M5D8EJ40).

Run through `render.py --dog`. The painted dog (`drawDog` in render.ts) is the reference for the
look: a warm-white coat with soft near-black patches over the shoulders, the hip and a small one on
the flank, black ears and a painted ski mask with big eyes (2026-10-28), a cream muzzle, chest, paws and tail tip, and the team's
mustard collar with a tag. Its modes (`pet.ts` PetMode) are the clips: a trot (`walk`), `sit`, `curl`
(also `sleep`) and the play-bow `stretch`.

Floor units, heights 1:1 like the figure; the dog faces +x (heading 0 = E) and `render.py` turns it.
"""

from __future__ import annotations

import math

import bpy
from mathutils import Vector

import scene

# The dog is modelled in the painter's units (its hip 9.2 up) and drawn at the painter's DOG_SIZE, 1.25
# floor units to one: the root joint carries that scale, so every part, pose and the shadow follow.
SIZE = 1.6  # nick 2026-10-23: "small, but not this small" — the painter's 1.25 read too small rendered
WITHERS = 12.0
BODY_Z = 10.4
FRONT_X, HIND_X = 6.4, -6.6
LEG_Y = 2.5
UPPER, LOWER = 4.4, 4.6  # hip → knee → paw, floor units; the paw rests at 0.9

COAT = "#f1ece2"
PATCH = "#332e2a"
CREAM = "#fdfaf4"
EAR_IN = "#8a6a62"
COLLAR = "#e3a72b"
TAG = "#f6d98a"
NOSE = "#241d19"

# The visiting dog (lane 01M5XS6DP2): a neighbour's golden mutt, a blue collar and a silver tag — a
# different dog at a glance from across the room, the same rig and clips. `render.py --dog-coat visitor`
# swaps these in before the build and writes `dog-visitor.json` / `office-art-dog-visitor.webp`.
COATS = {
    "visitor": dict(
        COAT="#d39a5a",
        PATCH="#7b4b26",
        CREAM="#f6e6c8",
        EAR_IN="#9a6a48",
        COLLAR="#3f74c4",
        TAG="#d9dee3",
    ),
}


def set_coat(name: str) -> None:
    """Swap the module's colours for coat `name` (see COATS) before `build_dog` reads them."""
    if name not in COATS:
        raise SystemExit(f"dog.py: unknown coat {name} (known: {', '.join(COATS)})")
    globals().update(COATS[name])


def coat_with_patches(name: str, patches: list[tuple[tuple[float, float, float], float]], space: bpy.types.Object) -> bpy.types.Material:
    """The coat, with dark patches where a point is inside one of `patches` (centre, radius) in the
    space of `space` (the body joint): a marking that follows the surface across the barrel, chest and
    haunch, instead of a dark blob stuck on it."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = 0.85
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    tc = nt.nodes.new("ShaderNodeTexCoord")
    tc.object = space
    mask = None
    for (cx, cy, cz), r in patches:
        d = nt.nodes.new("ShaderNodeVectorMath")
        d.operation = "DISTANCE"
        d.inputs[1].default_value = (cx, cy, cz)
        nt.links.new(tc.outputs["Object"], d.inputs[0])
        lt = nt.nodes.new("ShaderNodeMath")
        lt.operation = "LESS_THAN"
        lt.inputs[1].default_value = r
        nt.links.new(d.outputs["Value"], lt.inputs[0])
        if mask is None:
            mask = lt
        else:
            mx = nt.nodes.new("ShaderNodeMath")
            mx.operation = "MAXIMUM"
            nt.links.new(mask.outputs[0], mx.inputs[0])
            nt.links.new(lt.outputs[0], mx.inputs[1])
            mask = mx
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs["A"].default_value = (*scene.srgb(COAT), 1)
    mix.inputs["B"].default_value = (*scene.srgb(PATCH), 1)
    if mask is not None:
        nt.links.new(mask.outputs[0], mix.inputs["Factor"])
    nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
    return m


class Dog:
    """Joints (Empties) and the meshes on them, like figure.Rig without the layer tags: the dog is
    one image."""

    def __init__(self, zs: float, origin: Vector):
        self.zs = zs
        self.origin = origin
        self.joints: dict[str, bpy.types.Object] = {}
        self.meshes: list[bpy.types.Object] = []

    def joint(self, name: str, parent: str | None, x: float, y: float, z: float) -> None:
        bpy.ops.object.empty_add(type="PLAIN_AXES", radius=1)
        e = bpy.context.active_object
        e.name = f"dog/j/{name}"
        world = self.origin + Vector((x, y, z * self.zs))
        if parent:
            p = self.joints[parent]
            e.parent = p
            e.location = world - p.matrix_world.translation
        else:
            e.location = world
        bpy.context.view_layer.update()
        self.joints[name] = e

    def _attach(self, o: bpy.types.Object, joint: str, mat) -> bpy.types.Object:
        o.data.materials.append(mat)
        o.parent = self.joints[joint]
        o.matrix_parent_inverse = self.joints[joint].matrix_world.inverted()
        scene.smooth(o)
        self.meshes.append(o)
        return o

    def orb(self, name, joint, mat, x, y, zc, rx, ry, rz) -> bpy.types.Object:
        o = scene.ball(f"dog/{name}", self.origin.x + x, self.origin.y + y, zc - rz, rx, ry, rz, mat, self.zs)
        return self._attach(o, joint, mat)

    def limb(self, name, joint, mat, x, y, z_top, length, r0, r1) -> bpy.types.Object:
        """A tapered leg segment hanging straight down from `z_top`."""
        o = scene.cyl(f"dog/{name}", self.origin.x + x, self.origin.y + y, z_top - length, r1, r0, length, mat, self.zs, 16)
        return self._attach(o, joint, mat)


# The eyes (nick, 2026-10-28: "make the eyes very cute and expressive"). The old ones were 0.55 units
# of near-black on a white skull: one or two pixels at office size, and the dog read as eyeless.
#   button  — a big glossy dark eye with two catch-lights
#   bright  — a white rim round a big dark pupil, one catch-light
#   blush   — `bright` plus two soft pink cheeks under the eyes
FACE = "blush"


def face_eyes(d: "Dog", face: str, hx: float, hz: float, eye) -> None:
    white = scene.matte("dog-eye-white", scene.srgb("#fbf8f2"), 0.35)
    shine = scene.glow("dog-eye-shine", (1.0, 1.0, 1.0), strength=3.0)
    pink = scene.matte("dog-blush", scene.srgb("#f2a7a0"), 0.9)
    for side, sy in (("L", 1), ("R", -1)):
        ex, ey, ez = hx + 3.0, sy * 1.55, hz + 0.35
        if face == "button":
            d.orb(f"eye{side}", "head", eye, ex, ey, ez, 0.95, 0.9, 1.05)
            d.orb(f"shine{side}", "head", shine, ex + 0.85, ey - 0.25 * sy, ez + 0.6, 0.3, 0.3, 0.3)
            d.orb(f"glint{side}", "head", shine, ex + 0.9, ey + 0.25 * sy, ez - 0.1, 0.14, 0.14, 0.14)
        else:
            d.orb(f"eyewhite{side}", "head", white, ex, ey, ez, 0.95, 0.95, 1.05)
            d.orb(f"eye{side}", "head", eye, ex + 0.45, ey, ez - 0.05, 0.7, 0.72, 0.82)
            d.orb(f"shine{side}", "head", shine, ex + 1.05, ey - 0.2 * sy, ez + 0.4, 0.22, 0.22, 0.22)
            # asleep: a soft dark lid line where the eye was, shown only when a pose closes the eyes
            lid = d.orb(f"lid{side}", "head", eye, ex + 0.75, ey, ez - 0.15, 0.35, 0.8, 0.16)
            lid.hide_render = True
            if face == "blush":
                d.orb(f"blush{side}", "head", pink, ex + 0.75, sy * 1.85, ez - 1.0, 0.5, 0.4, 0.32)


def build_dog(zs: float, origin: Vector, face: str = FACE) -> Dog:
    """The dog standing square, facing +x. `face` picks the eyes (see `FACE`)."""
    d = Dog(zs, origin)
    plain = scene.matte("dog-plain", scene.srgb(COAT), 0.85)
    patch = scene.matte("dog-patch", scene.srgb(PATCH), 0.8)
    cream = scene.matte("dog-cream", scene.srgb(CREAM), 0.8)
    ear_in = scene.matte("dog-ear-in", scene.srgb(EAR_IN), 0.8)
    collar = scene.matte("dog-collar", scene.srgb(COLLAR), 0.5)
    tag = scene.matte("dog-tag", scene.srgb(TAG), 0.3)
    nose = scene.matte("dog-nose", scene.srgb(NOSE), 0.25)
    eye = scene.matte("dog-eye", (0.02, 0.018, 0.016), 0.12)

    d.joint("root", None, 0, 0, 0)
    d.joint("body", "root", 0, 0, BODY_Z)
    # patches in the body joint's space (z stretched by zs): over the shoulders and back, the hip, a
    # small one low on the flank — the painter's three
    coat = coat_with_patches(
        "dog-coat",
        [((3.2, 0.0, 3.6 * zs), 4.4), ((-6.6, -0.8, 3.0 * zs), 3.3), ((-1.0, 3.8, -1.8 * zs), 1.8)],
        d.joints["body"],
    )
    d.joint("neck", "body", 8.4, 0, BODY_Z + 2.4)
    d.joint("head", "neck", 10.6, 0, BODY_Z + 5.6)
    d.joint("tail", "body", -9.6, 0, BODY_Z + 1.6)
    for side, sy in (("L", 1), ("R", -1)):
        for end, x in (("F", FRONT_X), ("H", HIND_X)):
            d.joint(f"hip{end}{side}", "body", x, sy * LEG_Y, BODY_Z - 1.2)
            d.joint(f"knee{end}{side}", f"hip{end}{side}", x, sy * LEG_Y, BODY_Z - 1.2 - UPPER)

    # the barrel, the chest and the haunch — overlapping forms, the patches painted across all three
    d.orb("barrel", "body", coat, 0, 0, BODY_Z, 9.4, 4.0, 4.0)
    d.orb("chest", "body", coat, 6.2, 0, BODY_Z + 0.4, 4.4, 3.9, 4.4)
    d.orb("haunch", "body", coat, -6.4, 0, BODY_Z + 0.3, 4.2, 3.9, 4.2)
    d.orb("bib", "body", cream, 8.6, 0, BODY_Z - 0.6, 2.4, 2.8, 3.2)
    # the neck and its collar
    d.orb("neck", "neck", plain, 9.6, 0, BODY_Z + 3.8, 2.8, 2.6, 3.4)
    c = d.orb("collar", "neck", collar, 9.4, 0, BODY_Z + 3.2, 2.9, 2.9, 0.75)
    d.orb("tag", "neck", tag, 11.6, 0, BODY_Z + 1.8, 0.5, 0.25, 0.75)
    del c
    # the head: skull under its ski mask, the cream muzzle, nose, eyes, flop ears
    hx, hz = 11.4, BODY_Z + 6.0
    # The ski mask (nick, 2026-10-28): painted on the skull, not stuck on it — the top of the head dark
    # and a ring round each eye, so the white eye rims read as the mask's eye holes and the muzzle
    # stays cream. Centres are in the head joint's space (z stretched by zs), like the coat's patches.
    # It replaced the one-sided eye patch.
    sk = (hx - 10.6, hz - (BODY_Z + 5.6))  # the skull's centre from the head joint
    mask = coat_with_patches(
        "dog-mask",
        [((sk[0] - 0.2, 0.0, (sk[1] + 2.9) * zs), 3.3)]
        + [((sk[0] + 2.9, sy * 1.55, (sk[1] + 0.45) * zs), 1.5) for sy in (1, -1)],
        d.joints["head"],
    )
    d.orb("skull", "head", mask, hx, 0, hz, 3.9, 3.4, 3.4)
    d.orb("muzzle", "head", cream, hx + 3.6, 0, hz - 1.0, 2.6, 2.0, 1.8)
    d.orb("nose", "head", nose, hx + 6.0, 0, hz - 0.6, 0.75, 0.85, 0.6)
    face_eyes(d, face, hx, hz, eye)
    for side, sy in (("L", 1), ("R", -1)):
        d.orb(f"ear{side}", "head", patch, hx - 0.6, sy * 3.0, hz - 0.2, 1.4, 0.7, 2.6)
        d.orb(f"earin{side}", "head", ear_in, hx - 0.4, sy * 2.6, hz - 0.4, 0.9, 0.4, 1.8)
    # the tail: a short sabre, up and back, with the cream tip
    d.orb("tail", "tail", coat, -11.4, 0, BODY_Z + 3.6, 1.2, 1.1, 3.4)
    d.orb("tailtip", "tail", cream, -12.4, 0, BODY_Z + 6.6, 1.0, 0.95, 1.3)
    # legs: upper and lower, cream paws
    for side, sy in (("L", 1), ("R", -1)):
        for end, x in (("F", FRONT_X), ("H", HIND_X)):
            z_hip = BODY_Z - 1.2
            d.limb(f"upper{end}{side}", f"hip{end}{side}", plain, x, sy * LEG_Y, z_hip + 1.2, UPPER + 1.2, 1.55, 1.25)
            d.limb(f"lower{end}{side}", f"knee{end}{side}", plain, x, sy * LEG_Y, z_hip - UPPER, LOWER, 1.15, 1.0)
            d.orb(f"paw{end}{side}", f"knee{end}{side}", cream, x + 0.6, sy * LEG_Y, 0.9, 1.5, 1.2, 0.9)
    # a soft contact shadow, its own: the dog's shade on the floor turns with it
    sh = scene.shadow("dog/shadow", origin.x, origin.y, 11.0, 5.5, zs, 0.9)
    sh.parent = d.joints["root"]
    sh.matrix_parent_inverse = d.joints["root"].matrix_world.inverted()
    d.meshes.append(sh)
    return d


# ── clips, 12 fps like the figure; the runtime maps the pet's phase or mode time onto a frame ────────
FPS = 12
# name, frames, loop, rendered directions (None = every rendered one)
CLIPS = [
    ("walk", 8, True, None),
    ("sit", 4, True, None),
    ("curl", 4, True, None),
    ("stretch", 6, False, None),
]
DIRS = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"]
RENDERED = ["E", "SE", "NE", "N", "NW"]
MIRRORED = {"S": "E", "W": "N", "SW": "NE"}
FRAME_W, FRAME_H = 44 * SIZE, 34 * SIZE  # floor units: nose to tail tip, ears to paws, with the shadow
ANCHOR_UP = 5


def pose(name: str, f: int, frames: int) -> tuple[dict, float]:
    """Joint rotations (degrees, x y z in the joint's frame: y pitches nose-down, z yaws) and how far
    the body lifts (negative sinks it)."""
    t = f / frames
    p: dict = {}
    if name == "walk":
        # a trot: diagonal pairs swing together, two bobs a cycle, the tail sways and the head nods
        a = math.sin(2 * math.pi * t)
        for leg, s in (("hipFL", 1), ("hipHR", 1), ("hipFR", -1), ("hipHL", -1)):
            p[leg] = (0, s * 26 * a, 0)
            knee = leg.replace("hip", "knee")
            fold = max(0.0, -s * a)
            p[knee] = (0, (-34 if leg.startswith("hipF") else 34) * fold, 0)
        p["tail"] = (0, -10, 14 * math.sin(4 * math.pi * t))
        p["head"] = (0, 4 * math.sin(4 * math.pi * t), 0)
        return p, 0.5 * abs(math.cos(2 * math.pi * t))
    if name == "sit":
        # on the haunches: the body pitched up, hind legs folded under, front legs straight, tail sweeping
        p["body"] = (0, -28, 0)
        p["hipHL"] = p["hipHR"] = (0, -70, 0)
        p["kneeHL"] = p["kneeHR"] = (0, 120, 0)
        p["hipFL"] = p["hipFR"] = (0, 28, 0)
        p["head"] = (0, 22, 0)
        p["neck"] = (0, 6, 0)
        p["tail"] = (0, 60, 22 * math.sin(2 * math.pi * t))
        return p, -2.6
    if name == "curl":
        # asleep, flopped on its side: the whole dog rolled onto its flank, legs out and a little
        # bent, head down on the floor, tail lying behind; a slow breath lifts the ribs. Rigid parts
        # cannot tuck legs under a curl convincingly — the first try read as a leap — and a dog flat
        # on its side reads as asleep from every direction.
        b = 1 + 0.04 * math.sin(2 * math.pi * t)
        p["body"] = (82, 0, 0)
        for leg in ("hipFL", "hipFR", "hipHL", "hipHR"):
            p[leg] = (0, -14 if leg.startswith("hipF") else 18, 0)
            p[leg.replace("hip", "knee")] = (0, 24 if leg.startswith("hipF") else -20, 0)
        p["neck"] = (0, 6, 0)
        p["head"] = (0, 8, 0)
        p["tail"] = (0, 70, 0)
        p["eyes"] = "closed"  # asleep: lids down (nick, 2026-10-28: "very cute and expressive")
        p["body.scale"] = (1.0, b, 1.0)
        return p, -5.6
    if name == "stretch":
        # the play-bow: front paws reaching, chest to the floor, rump high, tail up — and back
        k = math.sin(math.pi * min(1.0, t * 1.25))
        p["body"] = (0, 22 * k, 0)
        p["hipFL"] = p["hipFR"] = (0, -60 * k, 0)
        p["kneeFL"] = p["kneeFR"] = (0, 10 * k, 0)
        p["hipHL"] = p["hipHR"] = (0, -22 * k, 0)
        p["head"] = (0, -18 * k, 0)
        p["tail"] = (0, -40 * k, 0)
        return p, -1.8 * k
    raise KeyError(name)


def apply_pose(d: Dog, p: dict, lift: float, heading_rad: float) -> None:
    rest = getattr(d, "rest_loc", None)
    if rest is None:
        rest = d.rest_loc = {n: j.location.copy() for n, j in d.joints.items()}
    for name, j in d.joints.items():
        if name == "root":
            j.rotation_euler = (0, 0, heading_rad)
            j.location = d.origin + Vector((0, 0, lift * SIZE * d.zs))
            j.scale = (SIZE, SIZE, SIZE)
            continue
        rx, ry, rz = p.get(name, (0, 0, 0))
        j.rotation_euler = (math.radians(rx), math.radians(ry), math.radians(rz))
        j.scale = p.get(f"{name}.scale", (1, 1, 1))
        j.location = rest[name]
    closed = p.get("eyes") == "closed"
    for o in d.meshes:
        n = o.name.split("/")[-1]
        if n.startswith(("eyewhite", "eye", "shine", "glint")) and not n.startswith("eyepatch"):
            o.hide_render = closed
        elif n.startswith("lid"):
            o.hide_render = not closed
    bpy.context.view_layer.update()


def dog_camera(ky: float, px_per_unit: float, zs: float, centre: Vector) -> bpy.types.Object:
    """The corner camera framed on the dog: `FRAME_W` wide, the floor point `ANCHOR_UP` above the bottom."""
    elev = scene.elevation(ky)
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    cam.name = "dog-cam"
    cam.data.type = "ORTHO"
    cam.data.clip_start = 1.0
    cam.data.clip_end = 20000.0
    cam.data.ortho_scale = max(FRAME_W, FRAME_H)
    target = centre + Vector((0, 0, (FRAME_H / 2 - ANCHOR_UP) * zs))
    dist = 3000.0
    cam.location = target + Vector((dist * math.cos(elev) * math.cos(math.radians(45)), dist * math.cos(elev) * math.sin(math.radians(45)), dist * math.sin(elev) * zs))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam
    return cam

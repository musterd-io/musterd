"""Render the office's pre-rendered art and write its manifest (office realism, plan Task 4).

    blender -b --python packages/web/art/office/render.py -- \\
        --out packages/web/src/live/office-scene/rendered/assets --scale 3 [--ky 0.35355339] [--save scene.blend]

Every object in the `export` collection (see scene.py) is rendered alone, from one fixed
orthographic corner camera, film transparent, then cropped to its alpha bounds. The manifest
records, per asset: the file, its size, the anchor (where the object's floor origin landed inside
the crop) and `scale` (px per floor unit). `camera` records the KX/KY the frame was projected
with, which `iso.ts` must agree with (plan Task 5).

`--scale` is px per floor unit at 2x. The /live panel at 1100px lands near 0.83 px/unit and the
1080p broadcast near 1.4; 3.0 keeps both sharp (spec §5) and the canvas downsamples the rest.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys

import math
import time

import bpy
import numpy as np
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scene  # noqa: E402  (the scene builder beside this file)


def args() -> dict:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    out = {"out": None, "scale": 3.0, "ky": scene.KY_ISO, "save": None, "only": None, "figure": False, "force": False,
           "resample_from": None, "stills": None, "warm": None, "dog": False}
    i = 0
    while i < len(argv):
        k = argv[i]
        if k == "--out":
            out["out"] = argv[i + 1]; i += 2
        elif k == "--scale":
            out["scale"] = float(argv[i + 1]); i += 2
        elif k == "--ky":
            out["ky"] = float(argv[i + 1]); i += 2
        elif k == "--save":
            out["save"] = argv[i + 1]; i += 2
        elif k == "--only":
            out["only"] = set(argv[i + 1].split(",")); i += 2
        elif k == "--figure":
            out["figure"] = True; i += 1
        elif k == "--dog":
            out["dog"] = True; i += 1
        elif k == "--force":
            out["force"] = True; i += 1
        elif k == "--stills":
            # clip:frame:dir,… — a look check at office size instead of sheets (figure_stills.py)
            out["stills"] = [(c, d, int(f)) for c, f, d in (x.split(":") for x in argv[i + 1].split(","))]; i += 2
        elif k == "--warm":
            # clip,clip,… — render these clips into the store and write no sheets, so a long figure
            # render can be split across runs (the last, plain run writes the sheets from the store)
            out["warm"] = set(argv[i + 1].split(",")); i += 2
        elif k == "--resample-from":
            out["resample_from"] = float(argv[i + 1]); i += 2
        else:
            raise SystemExit(f"render.py: unknown argument {k}")
    if not out["out"]:
        raise SystemExit("render.py: --out <dir> is required")
    return out


def setup_render(px_per_unit: float) -> tuple[int, int]:
    s = bpy.context.scene
    s.render.engine = "BLENDER_EEVEE"
    s.render.film_transparent = True
    s.render.image_settings.file_format = "PNG"
    s.render.image_settings.color_mode = "RGBA"
    s.render.image_settings.compression = 90
    s.view_settings.view_transform = "Standard"
    cam = s.camera.data
    # ortho_scale is the frame's width in floor units; the frame's aspect follows the diamond + headroom
    width_px = int(round(cam.ortho_scale * px_per_unit))
    height_px = int(round(width_px * 0.8))
    s.render.resolution_x = width_px
    s.render.resolution_y = height_px
    s.render.resolution_percentage = 100
    return width_px, height_px


# Blender's corner camera (at +x +y, looking in) has screen-right = −x +y; the canvas projects
# screen-right = +lx −ly (`iso.ts`). The two views are mirror images, so every render is flipped
# left-to-right as it is read — the room's symmetric furniture hid this until the figure's facing
# came out backwards (nick, 2026-10-20). `project_px` mirrors the anchor the same way.
def project_px(point: Vector, w: int, h: int) -> tuple[float, float]:
    """World point → pixel in the full (mirrored) frame (y down)."""
    s = bpy.context.scene
    v = world_to_camera_view(s, s.camera, point)
    return ((1.0 - v.x) * w, (1.0 - v.y) * h)


def render_alone(objs: list[bpy.types.Object], path: str, export: bpy.types.Collection) -> None:
    """Render only `objs` of the export collection (every other export object hidden)."""
    for o in export.objects:
        o.hide_render = o not in objs
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def difference(path_on: str, path_off: str, out_path: str, gain: float = 1.0) -> None:
    """Write `out_path` = clip(on − off) · gain, alpha from `off` — the additive overlay the canvas
    draws with `globalCompositeOperation = 'lighter'` to switch the ceiling bank on over any day
    state. Both inputs are full-frame renders; the caller crops the result like any asset."""
    a = bpy.data.images.load(path_on)
    b = bpy.data.images.load(path_off)
    w, h = a.size
    # both bottom-up and unmirrored here: crop_alpha flips the result like every other asset
    pa = np.array(a.pixels[:], dtype=np.float32).reshape(h, w, 4)
    pb = np.array(b.pixels[:], dtype=np.float32).reshape(h, w, 4)
    diff = np.clip((pa[:, :, :3] - pb[:, :, :3]) * gain, 0, 1)
    out = np.concatenate([diff, pb[:, :, 3:4]], axis=2)
    img = bpy.data.images.new("diff", w, h, alpha=True, float_buffer=False)
    img.pixels = out.astype(np.float32).ravel().tolist()
    img.filepath_raw = out_path
    img.file_format = "PNG"
    img.save()
    for i in (a, b, img):
        bpy.data.images.remove(i)


# The room shell — floor and walls — is big and flat, so it ships at half the item resolution:
# 4× fewer pixels for layers nobody reads at the sprite scale. The manifest's per-asset `scale`
# records it, so `blit.ts` sizes them right without knowing.
SHELL_DOWNSAMPLE = 2  # applies to every `room/*` asset


def crop_alpha(path: str, down: int = 1) -> tuple[int, int, int, int]:
    """Crop the PNG at `path` in place to its alpha bounds (+2px pad), box-downsampled by `down`;
    return (x0, y0, w, h) in FULL-frame px (the caller divides the anchor by `down`)."""
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    px = px[::-1, ::-1]  # Blender stores bottom-up; we want y down — and mirrored (see project_px)
    alpha = px[:, :, 3] > 0.002
    ys, xs = np.nonzero(alpha)
    if len(xs) == 0:
        raise SystemExit(f"render.py: {path} rendered nothing")
    pad = 2
    x0, x1 = max(0, xs.min() - pad), min(w, xs.max() + pad + 1)
    y0, y1 = max(0, ys.min() - pad), min(h, ys.max() + pad + 1)
    x1 -= (x1 - x0) % down
    y1 -= (y1 - y0) % down
    crop = px[y0:y1, x0:x1]
    if down > 1:
        ch, cw = crop.shape[0] // down, crop.shape[1] // down
        # premultiplied box filter, so a transparent neighbour does not darken an edge pixel
        pm = crop.copy()
        pm[:, :, :3] *= pm[:, :, 3:4]
        pm = pm.reshape(ch, down, cw, down, 4).mean(axis=(1, 3))
        a = pm[:, :, 3:4]
        pm[:, :, :3] = np.where(a > 1e-6, pm[:, :, :3] / np.maximum(a, 1e-6), 0)
        crop = pm
    crop = crop[::-1]  # back to bottom-up for Blender
    out = bpy.data.images.new("crop", crop.shape[1], crop.shape[0], alpha=True, float_buffer=False)
    out.pixels = crop.astype(np.float32).ravel().tolist()
    out.filepath_raw = path
    out.file_format = "PNG"
    out.save()
    bpy.data.images.remove(img)
    bpy.data.images.remove(out)
    return (int(x0), int(y0), int(x1 - x0), int(y1 - y0))


def quantize(path: str) -> None:
    """Palette-quantize the PNG in place with pngquant when it is on PATH (brew install pngquant).
    A rendered asset is soft-shaded, so 256 colours with dithering is invisible at the panel's
    scale and cuts the file by two-thirds or more; `officeArtBytes` is measured on the result."""
    exe = shutil.which("pngquant")
    if not exe:
        print("render.py: pngquant not on PATH — assets left unquantized (bigger than they need be)")
        return
    subprocess.run([exe, "--force", "--ext", ".png", "--speed", "1", "--quality", "70-95", "256", path], check=False)


def to_webp(path: str) -> str:
    """Re-encode the (quantized) PNG as lossless WebP when cwebp is on PATH (brew install webp) and
    return the file to record: the same pixels, 16–20% smaller on the figure's heaviest sheets
    (2026-10-22, lane 01M5GYGJD0). The PNG is removed — the scene globs this folder, so a stale
    copy would ship. Without cwebp the PNG stays, and the runtime reads either."""
    exe = shutil.which("cwebp")
    if not exe:
        print("render.py: cwebp not on PATH — assets left as PNG (bigger than they need be)")
        return path
    out = path[: -len(".png")] + ".webp"
    r = subprocess.run([exe, "-quiet", "-lossless", "-z", "9", path, "-o", out], check=False)
    if r.returncode != 0 or not os.path.exists(out):
        print(f"render.py: cwebp failed on {os.path.basename(path)} — kept the PNG")
        return path
    os.remove(path)
    return out


def read_pixels(path: str, mirror: bool = True) -> np.ndarray:
    """A PNG as float32 (h, w, 4), y down — mirrored left-to-right for a render (see project_px); an
    atlas this script wrote reads back with `mirror=False`, since `write_pixels` does not flip."""
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)[::-1]
    if mirror:
        px = px[:, ::-1]
    bpy.data.images.remove(img)
    return px


def write_pixels(path: str, px: np.ndarray) -> None:
    """A float32 (h, w, 4) array, y down, to a PNG."""
    h, w = px.shape[:2]
    img = bpy.data.images.new("out", w, h, alpha=True, float_buffer=False)
    img.pixels = px[::-1].astype(np.float32).ravel().tolist()
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


# ── the figure's render cache ──────────────────────────────────────────────────────────────
# A render call is keyed on everything that decides its pixels: the meshes it shows (geometry,
# modifiers, materials, layer and arm tags) where the pose put them, which of them are holdouts,
# the lights, the camera, the render settings and FIG_PIPELINE. Its cells are saved under that key
# the moment it finishes (`~/.cache/musterd/office-figure/calls/<key>.npz`), and a later call with
# the same key takes them from there instead of rendering — so changing one beat, one prop or one
# hair style renders that and nothing else, and a run that hangs or crashes resumes where it
# stopped. The store is this machine's: a fresh machine renders everything once.
FIG_PIPELINE = 2  # 2: surfaces fused before they render (office figure v2).  bump when what a render's pixels BECOME changes (masks, thresholds, the arm split)
LIT_SAMPLES = 16  # 32 was indistinguishable at panel and broadcast size, ~0.1% RMSE (nick, 2026-10-21)
FIG_CACHE = os.environ.get("MUSTERD_FIG_CACHE") or os.path.expanduser("~/.cache/musterd/office-figure")


def _h(*parts) -> str:
    import hashlib

    m = hashlib.sha1()
    for p in parts:
        m.update(p if isinstance(p, bytes) else repr(p).encode())
        m.update(b"\0")
    return m.hexdigest()[:20]


def _r(v, nd: int = 4) -> tuple:
    return tuple(round(float(x), nd) for x in v)


def _socket_vals(node_tree) -> tuple:
    out = []
    for n in node_tree.nodes:
        for i in n.inputs:
            dv = getattr(i, "default_value", None)
            if dv is None:
                continue
            try:
                out.append((n.bl_idname, i.identifier, _r(dv)))
            except TypeError:
                out.append((n.bl_idname, i.identifier, repr(dv)))
    return tuple(sorted(out))


def _mat_key(m) -> tuple:
    if m is None:
        return ()
    return (m.name, _socket_vals(m.node_tree)) if m.use_nodes and m.node_tree else (m.name,)


def _geom_key(o) -> str:
    me = o.data
    co = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    sm = np.empty(len(me.polygons), dtype=bool)
    me.polygons.foreach_get("use_smooth", sm)
    mods = tuple((md.type, *(repr(getattr(md, k, None)) for k in ("width", "segments", "limit_method"))) for md in o.modifiers)
    return _h(np.round(co, 4).tobytes(), sm.tobytes(), mods, [_mat_key(sl.material) for sl in o.material_slots], o["layer"], bool(o["arm"]))


def render_figure(a: dict) -> None:
    """`--figure`: the member sprite sheets, one per identity layer, plus `figure.json` (figureSheet.ts's
    SheetSpec). Each frame is rendered twice — lit, neutral grey, under the day rig; and as flat ID
    colours with no anti-aliasing — and the lit frame is split by ID into its layers. Rows are
    (clip, direction), columns are frames."""
    import figure
    import figure_fuse
    import figure_resample
    import figure_stills

    scene.clear()
    zs = scene.z_scale(a["ky"])
    px = a["scale"]
    centre = Vector((scene.FLOOR / 2, scene.FLOOR / 2, 0.0))
    rig = figure.build_figure(zs, centre)
    scene.lights("day", "off", zs)
    cam = figure.figure_camera(a["ky"], px, zs, centre)
    s = bpy.context.scene
    s.render.engine = "BLENDER_EEVEE"
    s.render.film_transparent = True
    s.render.image_settings.file_format = "PNG"
    s.render.image_settings.color_mode = "RGBA"
    s.view_settings.view_transform = "Standard"
    fw, fh = int(round(figure.FRAME_W * px)), int(round(figure.FRAME_H * px))
    s.render.resolution_x, s.render.resolution_y = fw, fh
    s.render.resolution_percentage = 100

    # ID materials: the red byte names the layer (stored sRGB, so set the linear value that lands on it)
    def lin(c: float) -> float:
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    # …and the green byte says the pixel is an arm's (the seated overlay's `@arms` cells)
    id_mats: dict[tuple[str, bool], bpy.types.Material] = {}
    for layer in figure.LAYERS:
        for arm in (False, True):
            m = bpy.data.materials.new(f"id/{layer}{'@arms' if arm else ''}")
            m.use_nodes = True
            nt = m.node_tree
            for n in list(nt.nodes):
                nt.nodes.remove(n)
            em = nt.nodes.new("ShaderNodeEmission")
            em.inputs["Color"].default_value = (lin(figure.layer_id_byte(layer) / 255), 1.0 if arm else 0.0, 0, 1)
            em.inputs["Strength"].default_value = 1.0
            out = nt.nodes.new("ShaderNodeOutputMaterial")
            nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
            id_mats[(layer, arm)] = m
    lit_mats = {o.name: [slot.material for slot in o.material_slots] for o in rig.meshes}

    def set_id_pass(on: bool) -> None:
        for o in rig.meshes + (fused or []):
            arms = o.get("arm_slots") or [bool(o["arm"])] * len(o.material_slots)  # a fused copy: per slot
            mats = [id_mats[(o["layer"], bool(a))] for a in arms] if on else lit_mats[o.name]
            for slot, m in zip(o.material_slots, mats):
                slot.material = m
        s.render.filter_size = 0.0 if on else 1.5
        try:
            s.eevee.taa_render_samples = 1 if on else LIT_SAMPLES
        except Exception:
            pass
        for light in [x for x in bpy.data.objects if x.type == "LIGHT"]:
            light.hide_render = on

    rows = 0
    anims = {}
    MIRRORED = {"S": "E", "W": "N", "SW": "NE"}
    for name, frames, loop, dirs in figure.CLIPS:
        anims[name] = {"row": rows, "frames": frames, "fps": figure.FPS, "loop": loop}
        if name in figure.CARRY_BASE:
            anims[name]["base"] = figure.CARRY_BASE[name]
            anims[name]["layers"] = list(figure.CARRY_OWN)
        if dirs is not None:
            # the directions this clip has: the rendered ones and their mirrors (the runtime falls back
            # to the base clip anywhere else)
            anims[name]["dirs"] = [d for d in figure.DIRS if d in dirs or MIRRORED.get(d) in dirs]
        rows += len(figure.DIRS)
    # Every cell's pixels, cropped to themselves: grid key (a layer, or `<layer>@arms`) → cell name
    # ("clip/dir/frame") → (uint8 RGBA, x0, y0 inside the nominal frame).
    crops: dict[str, dict[str, tuple]] = {}
    tmp_lit = os.path.join(a["out"], "_fig-lit.png")
    tmp_id = os.path.join(a["out"], "_fig-id.png")
    base = [l for l in figure.LAYERS if l in figure.BASE_LAYERS]
    variants = [l for l in figure.LAYERS if l not in figure.BASE_LAYERS]
    by_layer: dict[str, list] = {}
    for o in rig.meshes:
        by_layer.setdefault(o["layer"], []).append(o)

    def on_clip(o: bpy.types.Object, clip: str) -> bool:
        """A mesh limited to some clips (a prop, the lanyard) is not there in any other."""
        clips = o.get("clips")
        return clips is None or clip in clips

    def show(layers: set[str], holdout: set[str], clip: str) -> bool:
        """Only `layers` render; `holdout` ones render as holes (they occlude, but leave no pixels).
        False when nothing of `layers` is in this clip — the render can be skipped."""
        any_on = False
        for o in rig.meshes:
            l = o["layer"]
            here = on_clip(o, clip)
            o.hide_render = not here or (l not in layers and l not in holdout)
            o.is_holdout = l in holdout
            any_on = any_on or (here and l in layers)
        return any_on

    def holdout_for(layer: str) -> set[str]:
        """What occludes a variant: the body (skin and eyes), plus a stand-in for each kind of piece that
        can be in front of it (office figure v2, plan Task 4) — the runtime draws pieces back to front,
        so a piece's own render must already have the holes the pieces drawn under it cannot make.
        - a top: the trousers (seated thighs come in front of the hem);
        - shoes: the trousers (a hem over the ankle);
        - hair, facial hair, hats, accessories, a carried thing, the lanyard: a torso (the tee's — every
          top shares its shape), so hair behind the back is hidden and long hair in front still shows;
          the scarf sits on the torso, so it holds out the body alone;
        - an agent's tell (glowing irises, the collar light): the body alone — it sits on the surface;
        - the plant: the box it sits in, as before."""
        b = set(base)
        if layer.startswith("top/") or layer == "shoes":
            return b | {"bottom"}
        if layer == "acc/scarf" or layer == "bottom" or layer.startswith(("tell/", "mouth/")):
            return b
        return b | {"top/tee"} | ({"carry/box"} if layer == "carry/plant" else set())

    # Five directions are rendered and three are mirrored. A horizontal flip in the canvas's frame
    # swaps lx and ly (screen-right is +lx −ly), so the mirror of E (+lx) is S (+ly), of N is W,
    # of NE is SW; SE and NW face straight down and up the screen and mirror onto themselves.
    fig_json = os.path.join(a["out"], "figure.json")
    geom = {o.name: _geom_key(o) for o in rig.meshes}  # before the ID pass swaps any material
    lights = sorted(
        (l.data.type, round(l.data.energy, 4), _r(l.data.color), _r(np.array(l.matrix_world).ravel()),
         round(getattr(l.data, "shadow_soft_size", 0.0), 4), round(getattr(l.data, "size", 0.0), 4))
        for l in bpy.data.objects if l.type == "LIGHT"
    )
    world = _socket_vals(s.world.node_tree) if s.world and s.world.use_nodes else ()
    # The frame's WIDTH is not in the key: the camera spans the frame's height (ortho_scale is the
    # larger side), so a wider frame is the same pixels with more margin. Stored crops are placed
    # from the frame's centre line, so they land right in a frame of any width that holds them.
    def scale_key(p: float, h: int) -> str:
        return _h(FIG_PIPELINE, LIT_SAMPLES, bpy.app.version_string, s.render.engine, s.view_settings.view_transform,
                  s.view_settings.look, p, h, cam.data.ortho_scale, _r(np.array(cam.matrix_world).ravel()), lights, world)

    g_key = scale_key(px, fh)
    # `--resample-from <p>`: a call missing at this scale is scaled down from its cells at <p>
    # (figure_resample.py) instead of rendered. The camera does not depend on the scale, so the
    # call's key at <p> differs only in the scale and the frame's height.
    src_px = a["resample_from"]
    if src_px is not None and src_px <= px:
        raise SystemExit("render.py: --resample-from must be a bigger scale than --scale")
    sfw, sfh = (int(round(figure.FRAME_W * src_px)), int(round(figure.FRAME_H * src_px))) if src_px else (fw, fh)
    g_key_src = scale_key(src_px, sfh) if src_px else None

    def call_key(kind: str, seated: bool, g: str = g_key) -> str:
        """The key of the render about to happen: what `show` left visible, where it is, and how."""
        objs = sorted((geom[o.name], _r(np.array(o.matrix_world).ravel(), 3), bool(o.is_holdout)) for o in rig.meshes if not o.hide_render)
        return _h(g, kind, seated, objs)

    store = os.path.join(FIG_CACHE, "calls")
    os.makedirs(store, exist_ok=True)

    def unstash(k: str, w: int = fw) -> dict | None:
        """A call's cells from the store, or None (never rendered here, `--force`, or too wide for a
        frame `w` wide)."""
        path = os.path.join(store, k + ".npz")
        if a["force"] or not os.path.exists(path):
            return None
        out = {}
        with np.load(path) as z:
            for n in z.files:
                if n.endswith(".o"):
                    continue
                img, (cx, y0) = z[n], z[n + ".o"]
                x0 = int(cx) + w // 2
                if x0 < 0 or x0 + img.shape[1] > w:
                    return None
                out[n.replace("|", "/")] = (img, x0, int(y0))
        return out

    def stash(k: str, outs: dict) -> None:
        """Save a call's cells the moment it is rendered — a hang or a crash loses one call, not the run."""
        arrs = {}
        for gk, (img, x0, y0) in outs.items():
            arrs[gk.replace("/", "|")] = img
            arrs[gk.replace("/", "|") + ".o"] = np.array([x0 - fw // 2, y0])
        tmp = os.path.join(store, k + ".tmp.npz")
        np.savez_compressed(tmp, **arrs)
        os.replace(tmp, os.path.join(store, k + ".npz"))

    def crop(img: np.ndarray, mask: np.ndarray) -> tuple | None:
        """The masked pixels as 8-bit RGBA, cropped to themselves (the sheet is 8-bit anyway)."""
        if not mask.any():
            return None
        ys, xs = np.nonzero(mask)
        x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
        part = np.where(mask[y0:y1, x0:x1, None], img[y0:y1, x0:x1], 0.0)
        return (np.clip(np.rint(part * 255), 0, 255).astype(np.uint8), x0, y0)

    def keep(outs: dict, gk: str, c: tuple | None) -> None:
        if c is not None:
            outs[gk] = c

    done = reused = rendered = resampled = 0
    frames_of = {n: fr for n, fr, _, _ in figure.CLIPS}

    def base_frame(clip: str, d: str, f: int) -> tuple[str, str, int]:
        """Where a layer a carrying clip does not store comes from: its base clip's frame at the same
        point of the loop (`frameCell` in figureSheet.ts does the same at runtime)."""
        b = figure.CARRY_BASE[clip]
        return (b, d, (f * frames_of[b]) // frames_of[clip] % frames_of[b])

    wanted = None
    if a["stills"] is not None:
        wanted = set(a["stills"]) | {base_frame(*w) for w in a["stills"] if w[0] in figure.CARRY_BASE}
    t0 = time.time()
    for name, frames, _, dirs in figure.CLIPS:
        if a["warm"] is not None and name not in a["warm"]:
            continue
        for di, d in enumerate(figure.DIRS):
            if d in MIRRORED or (dirs is not None and d not in dirs):
                continue  # drawn flipped from its source direction at runtime (`frameCell`)
            for f in range(frames):
                if wanted is not None and (name, d, f) not in wanted:
                    continue  # a look check renders only the stills it was asked for
                pose, lift = figure.action(name, figure.sample(name, f, frames))
                figure.apply_pose(rig, pose, lift, math.radians(45 * di))
                figure.place_props(rig, name, math.radians(45 * di))
                seated = name in figure.SEATED_CLIPS
                cname = f"{name}/{d}/{f}"
                fused = None  # this frame's fused copies, made at its first render
                calls = [("base", set(base), set())] + [(l, {l}, holdout_for(l)) for l in variants if figure.stored_in(name, l)]
                for kind, layers, holdout in calls:
                    if not show(layers, holdout, name):
                        continue  # nothing of it in this clip (a prop, the lanyard)
                    k = call_key(kind, seated)
                    outs = unstash(k)
                    src = unstash(call_key(kind, seated, g_key_src), sfw) if outs is None and src_px else None
                    if outs is not None:
                        reused += 1
                    elif src is not None:
                        resampled += 1
                        outs = figure_resample.resample_call(src, (sfw, sfh), (fw, fh))
                        stash(k, outs)
                    else:
                        rendered += 1
                        outs = {}
                        # each continuous surface as one soft shape (figure_fuse.py), fused once a
                        # frame; the key above was taken from the posed parts, not the copies
                        if fused is None:
                            fused = figure_fuse.fuse_frame(rig.meshes)
                            for o in fused:
                                lit_mats[o.name] = [slot.material for slot in o.material_slots]
                        figure_fuse.show_for_call(fused)
                        if kind == "base":
                            # the base body — skin and eyes — split by ID, no piece in the way
                            set_id_pass(False)
                            s.render.filepath = tmp_lit
                            bpy.ops.render.render(write_still=True)
                            set_id_pass(True)
                            s.render.filepath = tmp_id
                            bpy.ops.render.render(write_still=True)
                            set_id_pass(False)
                            lit = read_pixels(tmp_lit)
                            id_px = read_pixels(tmp_id)
                            ids = np.rint(id_px[:, :, 0] * 255).astype(np.int32)
                            arm = id_px[:, :, 1] > 0.5
                            for layer in base:
                                mask = (np.abs(ids - figure.layer_id_byte(layer)) <= figure.ID_STEP // 2) & (lit[:, :, 3] > 0.002)
                                keep(outs, layer, crop(lit, mask))
                                if seated and layer in figure.ARM_LAYERS:
                                    keep(outs, f"{layer}@arms", crop(lit, mask & arm))
                        else:
                            # each variant alone, the body as a holdout: its pixels are exactly the ones a wearer shows
                            s.render.filepath = tmp_lit
                            bpy.ops.render.render(write_still=True)
                            px_l = read_pixels(tmp_lit)
                            mask = px_l[:, :, 3] > 0.002
                            keep(outs, kind, crop(px_l, mask))
                            if seated and kind in figure.ARM_LAYERS and mask.any():
                                if kind.startswith("carry/"):
                                    keep(outs, f"{kind}@arms", crop(px_l, mask))  # a prop at the desk is all "arm"
                                else:
                                    # which of a top's pixels are its sleeves: the same view as flat ID colours
                                    set_id_pass(True)
                                    s.render.filepath = tmp_id
                                    bpy.ops.render.render(write_still=True)
                                    set_id_pass(False)
                                    keep(outs, f"{kind}@arms", crop(px_l, mask & (read_pixels(tmp_id)[:, :, 1] > 0.5)))
                        stash(k, outs)
                    for gk, c in outs.items():
                        crops.setdefault(gk, {})[cname] = c
                if fused:
                    for o in fused:
                        del lit_mats[o.name]
                    figure_fuse.clear(fused)
                done += 1
        print(f"figure: {name} done ({done} frames so far; {rendered} calls rendered, {reused} reused, {resampled} resampled, {time.time() - t0:.0f}s)", flush=True)
    for p in (tmp_lit, tmp_id):
        if os.path.exists(p):
            os.remove(p)
    if a["warm"] is not None:
        print(f"figure: warmed {sorted(a['warm'])}: {rendered} render calls, {reused} reused, {time.time() - t0:.0f}s; no sheets written", flush=True)
        return
    if a["stills"] is not None:
        bad = [s for s in a["stills"] if s[1] in MIRRORED]
        if bad:
            raise SystemExit(f"render.py: --stills takes rendered directions only (not {sorted(MIRRORED)}): {bad}")
        def resolve(layer: str, clip: str, d: str, f: int) -> str:
            if clip in figure.CARRY_BASE and not figure.stored_in(clip, layer):
                clip, d, f = base_frame(clip, d, f)
            return f"{clip}/{d}/{f}"

        figure_stills.write(crops, a["stills"], fw, fh, a["out"], write_pixels, resolve)
        return
    # Pack each layer's frames cropped to their own pixels (an atlas, not a grid): a glasses frame
    # is a few hundred pixels, not a 112×208 cell, and the browser decodes only what is drawn.
    # figure.json records each cell's rect in the atlas and its offset inside the nominal frame.
    ATLAS_W = 1024
    spec = {
        "scale": px,
        "frame": {"w": fw, "h": fh},
        "anchor": {"x": fw / 2, "y": fh - figure.ANCHOR_UP * px},
        "height": round(figure.CROWN, 2),
        "anims": anims,
        # S, W and SW are not stored: the runtime draws E, N and NE flipped (`frameCell`). Storing
        # the flipped copies doubled the sheets for nothing (2026-10-21, increment 3b).
        "mirror": MIRRORED,
        "layers": [],
        "cells": {},
    }
    for layer in figure.LAYERS:
        if not crops.get(layer):
            print(f"figure: layer {layer} rendered nothing — not written")
            continue
        # shelf-pack every cell left to right, top to bottom. A layer with arm pixels packs its
        # `@arms` cells into the same atlas after its own, so the overlay needs no second image.
        cells = []  # flat, six per (anim, dir, frame): x, y, w, h, ox, oy — all zero when empty
        grids = [layer] + ([f"{layer}@arms"] if crops.get(f"{layer}@arms") else [])
        items = []
        for gk in grids:
            for name, frames, _, _ in figure.CLIPS:
                for d in figure.DIRS:
                    for f in range(frames):
                        c = crops[gk].get(f"{name}/{d}/{f}") if figure.stored_in(name, layer) else None
                        items.append(None if c is None else (c[0].astype(np.float32) / 255, c[1], c[2]))
        crops_l = items
        shelf_x, shelf_y, shelf_h = 0, 0, 0
        placed = []
        for c in crops_l:
            if c is None:
                placed.append(None)
                continue
            img, ox, oy = c
            h, w = img.shape[:2]
            if shelf_x + w > ATLAS_W:
                shelf_x, shelf_y, shelf_h = 0, shelf_y + shelf_h, 0
            placed.append((shelf_x, shelf_y, w, h, ox, oy))
            shelf_x += w
            shelf_h = max(shelf_h, h)
        atlas_h = shelf_y + shelf_h
        atlas = np.zeros((max(1, atlas_h), ATLAS_W, 4), dtype=np.float32)
        for c, pl in zip(crops_l, placed):
            if pl is None:
                cells.extend([0, 0, 0, 0, 0, 0])
                continue
            x, y, w, h, ox, oy = pl
            atlas[y : y + h, x : x + w] = c[0]
            cells.extend([x, y, w, h, ox, oy])
        path = os.path.join(a["out"], "office-art-fig-" + layer.replace("/", "-") + ".png")
        write_pixels(path, atlas)
        quantize(path)
        path = to_webp(path)
        file = os.path.basename(path)
        spec["layers"].append({"id": layer, "file": file})
        n = len(cells) // len(grids)
        spec["cells"][layer] = cells[:n]
        if len(grids) > 1:
            spec["cells"][f"{layer}@arms"] = cells[n:]
        print(f"figure: wrote {file} {ATLAS_W}x{atlas_h} {os.path.getsize(path)} B", flush=True)
    with open(fig_json, "w") as fjson:
        json.dump(spec, fjson, separators=(",", ":"))
        fjson.write("\n")
    if a["save"]:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(a["save"]))
    print(f"figure: {done} frames, {rendered} render calls, {reused} reused, {resampled} resampled, {time.time() - t0:.0f}s; {len(spec['layers'])} layer sheets, figure.json")


def render_dog(a: dict) -> None:
    """`--dog`: the office dog's sprite sheet, `office-art-dog.webp`, and `dog.json` (dogSheet.ts's
    DogSpec). One lit render per (clip, rendered direction, frame) under the day rig, cropped to its
    own pixels and shelf-packed into one atlas; S, W and SW are their mirrors (lane 01M5D8EJ40)."""
    import dog

    scene.clear()
    zs = scene.z_scale(a["ky"])
    px = a["scale"]
    centre = Vector((scene.FLOOR / 2, scene.FLOOR / 2, 0.0))
    d = dog.build_dog(zs, centre)
    scene.lights("day", "off", zs)
    dog.dog_camera(a["ky"], px, zs, centre)
    s = bpy.context.scene
    s.render.engine = "BLENDER_EEVEE"
    s.render.film_transparent = True
    s.render.image_settings.file_format = "PNG"
    s.render.image_settings.color_mode = "RGBA"
    s.view_settings.view_transform = "Standard"
    try:
        s.eevee.taa_render_samples = LIT_SAMPLES
    except Exception:
        pass
    fw, fh = int(round(dog.FRAME_W * px)), int(round(dog.FRAME_H * px))
    s.render.resolution_x, s.render.resolution_y = fw, fh
    s.render.resolution_percentage = 100
    tmp = os.path.join(a["out"], "_dog_tmp.png")
    anims: dict = {}
    crops: list = []  # in cell order: clips, then DIRS, then frames; None for a mirrored direction
    row = 0
    t0 = time.time()
    for name, frames, loop, _ in dog.CLIPS:
        anims[name] = {"row": row, "frames": frames, "fps": dog.FPS, "loop": loop}
        row += len(dog.DIRS)
        for di, dname in enumerate(dog.DIRS):
            for f in range(frames):
                if dname not in dog.RENDERED:
                    crops.append(None)
                    continue
                p, lift = dog.pose(name, f, frames)
                dog.apply_pose(d, p, lift, math.radians(45 * di))
                s.render.filepath = tmp
                bpy.ops.render.render(write_still=True)
                img = read_pixels(tmp)
                ys, xs = np.nonzero(img[:, :, 3] > 0.004)
                if len(xs) == 0:
                    crops.append(None)
                    continue
                x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
                crops.append((img[y0:y1, x0:x1].copy(), int(x0), int(y0)))
        print(f"dog: {name} rendered, {time.time() - t0:.0f}s", flush=True)
    os.remove(tmp)
    ATLAS_W = 1024
    shelf_x, shelf_y, shelf_h = 0, 0, 0
    placed = []
    for c in crops:
        if c is None:
            placed.append(None)
            continue
        h, w = c[0].shape[:2]
        if shelf_x + w > ATLAS_W:
            shelf_x, shelf_y, shelf_h = 0, shelf_y + shelf_h, 0
        placed.append((shelf_x, shelf_y, w, h, c[1], c[2]))
        shelf_x += w
        shelf_h = max(shelf_h, h)
    atlas = np.zeros((max(1, shelf_y + shelf_h), ATLAS_W, 4), dtype=np.float32)
    cells = []
    for c, pl in zip(crops, placed):
        if pl is None:
            cells.extend([0, 0, 0, 0, 0, 0])
            continue
        x, y, w, h, ox, oy = pl
        atlas[y : y + h, x : x + w] = c[0]
        cells.extend([x, y, w, h, ox, oy])
    path = os.path.join(a["out"], "office-art-dog.png")
    write_pixels(path, atlas)
    if a["save"]:
        shutil.copy(path, a["save"])  # a PNG copy to look at before it is quantized
    quantize(path)
    path = to_webp(path)
    spec = {
        "scale": px,
        "frame": {"w": fw, "h": fh},
        "anchor": {"x": fw / 2, "y": fh - dog.ANCHOR_UP * px},
        "anims": anims,
        "mirror": dog.MIRRORED,
        "file": os.path.basename(path),
        "cells": cells,
    }
    with open(os.path.join(a["out"], "dog.json"), "w") as fj:
        json.dump(spec, fj, separators=(",", ":"))
        fj.write("\n")
    print(f"dog: wrote {os.path.basename(path)} {ATLAS_W}x{atlas.shape[0]} {os.path.getsize(path)} B, dog.json, {time.time() - t0:.0f}s")


def main() -> None:
    a = args()
    os.makedirs(a["out"], exist_ok=True)
    if a["figure"]:
        render_figure(a)
        return
    if a["dog"]:
        render_dog(a)
        return
    assets = scene.build_scene(ky=a["ky"], px_per_unit=a["scale"])
    export = bpy.data.collections["export"]
    w, h = setup_render(a["scale"])
    manifest = {"version": 1, "camera": {"kx": scene.KX, "ky": a["ky"]}, "assets": []}
    # `--only id,id`: re-render those and keep every other entry of the manifest already on disk
    # (same camera and scale, or the kept entries would lie) — a desk's tweak is seconds, not minutes.
    only = a["only"]
    manifest_path = os.path.join(a["out"], "manifest.json")
    if only:
        with open(manifest_path) as f:
            prev = json.load(f)
        if prev["camera"] != manifest["camera"]:
            raise SystemExit("render.py: --only needs the camera the manifest was rendered at")
        manifest["assets"] = [x for x in prev["assets"] if x["id"] not in only]

    def wanted(asset_id: str) -> bool:
        return not only or asset_id in only

    zs = scene.z_scale(a["ky"])
    shell = [o for o in export.objects if o.get("shell")]

    def record(asset_id: str, path: str, origin: Vector, down: int) -> None:
        x0, y0, cw, ch = crop_alpha(path, down)
        quantize(path)
        path = to_webp(path)
        file = os.path.basename(path)
        ox, oy = project_px(origin, w, h)
        manifest["assets"].append(
            {
                "id": asset_id,
                "file": file,
                "w": cw // down,
                "h": ch // down,
                "anchor": {"x": round((ox - x0) / down, 2), "y": round((oy - y0) / down, 2)},
                "scale": a["scale"] / down,
            }
        )
        print(f"rendered {asset_id} -> {file} {cw // down}x{ch // down} anchor ({(ox - x0) / down:.1f}, {(oy - y0) / down:.1f}) {os.path.getsize(path)} B")

    def out_path(asset_id: str) -> str:
        return os.path.join(a["out"], "office-art-" + asset_id.replace("/", "-") + ".png")

    # the shell under each day state (ceiling off), then the ceiling overlays as night-on minus night-off
    origin = shell[0].matrix_world.translation.copy()
    for state in scene.LIGHT_STATES:
        if not wanted(f"room/light-{state}"):
            continue
        scene.lights(state, "off", zs)
        path = out_path(f"room/light-{state}")
        render_alone(shell, path, export)
        record(f"room/light-{state}", path, origin, SHELL_DOWNSAMPLE)
    if wanted("room/ceiling-on") or wanted("room/ceiling-spill"):
        night_off = os.path.join(a["out"], "_night-off.png")
        night_on = os.path.join(a["out"], "_night-on.png")
        scene.lights("night", "off", zs)
        render_alone(shell, night_off, export)
        scene.lights("night", "on", zs)
        render_alone(shell, night_on, export)
        for ceiling, gain in (("on", 1.0), ("spill", scene.CEILING["spill"])):
            path = out_path(f"room/ceiling-{ceiling}")
            difference(night_on, night_off, path, gain)
            record(f"room/ceiling-{ceiling}", path, origin, SHELL_DOWNSAMPLE)
        for p in (night_off, night_on):
            os.remove(p)
    scene.lights("day", "off", zs)

    for asset_id, obj in assets.items():
        if asset_id == "room/shell" or not wanted(asset_id):
            continue
        path = out_path(asset_id)
        render_alone([obj], path, export)
        print(f"engine {bpy.context.scene.render.engine}; wrote {os.path.getsize(path)} bytes to {os.path.basename(path)}")
        record(asset_id, path, obj.matrix_world.translation, 1)
    manifest["assets"].sort(key=lambda x: x["id"])
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    if a["save"]:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(a["save"]))
    print(f"wrote {len(manifest['assets'])} asset(s) and manifest.json to {a['out']}")


main()

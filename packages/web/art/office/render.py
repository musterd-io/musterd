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

import bpy
import numpy as np
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scene  # noqa: E402  (the scene builder beside this file)


def args() -> dict:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    out = {"out": None, "scale": 3.0, "ky": scene.KY_ISO, "save": None, "only": None, "figure": False}
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


def read_pixels(path: str) -> np.ndarray:
    """A PNG as float32 (h, w, 4), y down, mirrored left-to-right (see project_px)."""
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)[::-1, ::-1]
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


def render_figure(a: dict) -> None:
    """`--figure`: the member sprite sheets, one per identity layer, plus `figure.json` (figureSheet.ts's
    SheetSpec). Each frame is rendered twice — lit, neutral grey, under the day rig; and as flat ID
    colours with no anti-aliasing — and the lit frame is split by ID into its layers. Rows are
    (clip, direction), columns are frames."""
    import figure

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

    id_mats: dict[str, bpy.types.Material] = {}
    for layer in figure.LAYERS:
        m = bpy.data.materials.new(f"id/{layer}")
        m.use_nodes = True
        nt = m.node_tree
        for n in list(nt.nodes):
            nt.nodes.remove(n)
        em = nt.nodes.new("ShaderNodeEmission")
        em.inputs["Color"].default_value = (lin(figure.layer_id_byte(layer) / 255), 0, 0, 1)
        em.inputs["Strength"].default_value = 1.0
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
        id_mats[layer] = m
    lit_mats = {o.name: [slot.material for slot in o.material_slots] for o in rig.meshes}

    def set_id_pass(on: bool) -> None:
        for o in rig.meshes:
            mats = [id_mats[o["layer"]]] * len(o.material_slots) if on else lit_mats[o.name]
            for slot, m in zip(o.material_slots, mats):
                slot.material = m
        s.render.filter_size = 0.0 if on else 1.5
        try:
            s.eevee.taa_render_samples = 1 if on else 32
        except Exception:
            pass
        for light in [x for x in bpy.data.objects if x.type == "LIGHT"]:
            light.hide_render = on

    rows = 0
    anims = {}
    for name, frames, loop in figure.CLIPS:
        anims[name] = {"row": rows, "frames": frames, "fps": figure.FPS, "loop": loop}
        rows += len(figure.DIRS)
    cols = max(f for _, f, _ in figure.CLIPS)
    sheets = {layer: np.zeros((rows * fh, cols * fw, 4), dtype=np.float32) for layer in figure.LAYERS}
    tmp_lit = os.path.join(a["out"], "_fig-lit.png")
    tmp_id = os.path.join(a["out"], "_fig-id.png")
    only = a["only"]
    base = [l for l in figure.LAYERS if l in figure.BASE_LAYERS]
    variants = [l for l in figure.LAYERS if l not in figure.BASE_LAYERS and (not only or l in only)]
    render_base = not only or any(l in only for l in base)
    by_layer: dict[str, list] = {}
    for o in rig.meshes:
        by_layer.setdefault(o["layer"], []).append(o)

    def show(layers: set[str], holdout: set[str]) -> None:
        """Only `layers` render; `holdout` ones render as holes (they occlude, but leave no pixels)."""
        for o in rig.meshes:
            l = o["layer"]
            o.hide_render = l not in layers and l not in holdout
            o.is_holdout = l in holdout

    # Five directions are rendered and three are mirrored. A horizontal flip in the canvas's frame
    # swaps lx and ly (screen-right is +lx −ly), so the mirror of E (+lx) is S (+ly), of N is W,
    # of NE is SW; SE and NW face straight down and up the screen and mirror onto themselves.
    MIRRORED = {"S": "E", "W": "N", "SW": "NE"}
    done = 0
    for name, frames, _ in figure.CLIPS:
        for di, d in enumerate(figure.DIRS):
            row = anims[name]["row"] + di
            if d in MIRRORED:
                continue  # filled from its source direction after the clip, cell by cell
            for f in range(frames):
                pose, lift = figure.action(name, f / frames)
                figure.apply_pose(rig, pose, lift, math.radians(45 * di))
                cell = (slice(row * fh, (row + 1) * fh), slice(f * fw, (f + 1) * fw))
                # the base body — skin, bottom, shoes, visor — split by ID, no variant in the way
                if render_base:
                    show(set(base), set())
                    set_id_pass(False)
                    s.render.filepath = tmp_lit
                    bpy.ops.render.render(write_still=True)
                    set_id_pass(True)
                    s.render.filepath = tmp_id
                    bpy.ops.render.render(write_still=True)
                    set_id_pass(False)
                    lit = read_pixels(tmp_lit)
                    ids = np.rint(read_pixels(tmp_id)[:, :, 0] * 255).astype(np.int32)
                    for layer in base:
                        mask = (np.abs(ids - figure.layer_id_byte(layer)) <= figure.ID_STEP // 2) & (lit[:, :, 3] > 0.002)
                        if mask.any():
                            sheets[layer][cell][mask] = lit[mask]
                # each variant alone, the body as a holdout: its pixels are exactly the ones a wearer shows
                for layer in variants:
                    show({layer}, set(base))
                    s.render.filepath = tmp_lit
                    bpy.ops.render.render(write_still=True)
                    px_l = read_pixels(tmp_lit)
                    mask = px_l[:, :, 3] > 0.002
                    if mask.any():
                        sheets[layer][cell][mask] = px_l[mask]
                done += 1
        # the mirrored rows copy whole rows, so they must run after their source direction: DIRS
        # lists E, SE, S, SW, W, NW, N, NE — SW and W follow SE and E, but NW precedes NE.
        for d, src in MIRRORED.items():
            row, src_row = anims[name]["row"] + figure.DIRS.index(d), anims[name]["row"] + figure.DIRS.index(src)
            for layer in figure.LAYERS:
                for f in range(frames):  # flip each frame within its own cell — a row flip reverses the frame order
                    sheets[layer][row * fh : (row + 1) * fh, f * fw : (f + 1) * fw] = sheets[layer][src_row * fh : (src_row + 1) * fh, f * fw : (f + 1) * fw][:, ::-1]
        print(f"figure: {name} rendered ({done} frames so far)")
    for p in (tmp_lit, tmp_id):
        if os.path.exists(p):
            os.remove(p)
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
        "layers": [],
        "cells": {},
    }
    fig_json = os.path.join(a["out"], "figure.json")
    kept = {}
    kept_cells = {}
    if only and os.path.exists(fig_json):
        with open(fig_json) as f:
            prev = json.load(f)
        kept = {l["id"]: l for l in prev["layers"]}
        kept_cells = prev.get("cells", {})
    rendered_now = set(variants) | (set(base) if render_base else set())
    for layer in figure.LAYERS:
        if layer not in rendered_now:
            if layer in kept:
                spec["layers"].append(kept[layer])
                spec["cells"][layer] = kept_cells.get(layer, [])
            continue
        sheet = sheets[layer]
        if sheet[:, :, 3].max() <= 0.002:
            print(f"figure: layer {layer} rendered nothing — not written")
            continue
        # crop every cell; shelf-pack them left to right, top to bottom
        cells = []  # flat, six per (anim, dir, frame): x, y, w, h, ox, oy — all zero when empty
        crops = []
        for name, frames, _ in figure.CLIPS:
            for di in range(len(figure.DIRS)):
                row = anims[name]["row"] + di
                for f in range(frames):
                    cell = sheet[row * fh : (row + 1) * fh, f * fw : (f + 1) * fw]
                    ys, xs = np.nonzero(cell[:, :, 3] > 0.002)
                    if len(xs) == 0:
                        crops.append(None)
                        continue
                    x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
                    crops.append((cell[y0:y1, x0:x1], x0, y0))
        shelf_x, shelf_y, shelf_h = 0, 0, 0
        placed = []
        for c in crops:
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
        for c, pl in zip(crops, placed):
            if pl is None:
                cells.extend([0, 0, 0, 0, 0, 0])
                continue
            x, y, w, h, ox, oy = pl
            atlas[y : y + h, x : x + w] = c[0]
            cells.extend([x, y, w, h, ox, oy])
        file = "office-art-fig-" + layer.replace("/", "-") + ".png"
        path = os.path.join(a["out"], file)
        write_pixels(path, atlas)
        quantize(path)
        spec["layers"].append({"id": layer, "file": file})
        spec["cells"][layer] = cells
        print(f"figure: wrote {file} {ATLAS_W}x{atlas_h} {os.path.getsize(path)} B")
    with open(fig_json, "w") as fjson:
        json.dump(spec, fjson, separators=(",", ":"))
        fjson.write("\n")
    if a["save"]:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(a["save"]))
    print(f"figure: {done} frames, {len(spec['layers'])} layer sheets, figure.json")


def main() -> None:
    a = args()
    os.makedirs(a["out"], exist_ok=True)
    if a["figure"]:
        render_figure(a)
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
        file = os.path.basename(path)
        x0, y0, cw, ch = crop_alpha(path, down)
        quantize(path)
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

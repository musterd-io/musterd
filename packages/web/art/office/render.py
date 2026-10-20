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

import bpy
import numpy as np
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scene  # noqa: E402  (the scene builder beside this file)


def args() -> dict:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    out = {"out": None, "scale": 3.0, "ky": scene.KY_ISO, "save": None}
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


def project_px(point: Vector, w: int, h: int) -> tuple[float, float]:
    """World point → pixel in the full frame (y down)."""
    s = bpy.context.scene
    v = world_to_camera_view(s, s.camera, point)
    return (v.x * w, (1.0 - v.y) * h)


def render_alone(obj: bpy.types.Object, path: str, export: bpy.types.Collection) -> None:
    for o in export.objects:
        o.hide_render = o is not obj
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


# The room shell — floor and walls — is big and flat, so it ships at half the item resolution:
# 4× fewer pixels for layers nobody reads at the sprite scale. The manifest's per-asset `scale`
# records it, so `blit.ts` sizes them right without knowing.
SHELL_DOWNSAMPLE = {"room/floor": 2, "room/wall-left": 2, "room/wall-right": 2}


def crop_alpha(path: str, down: int = 1) -> tuple[int, int, int, int]:
    """Crop the PNG at `path` in place to its alpha bounds (+2px pad), box-downsampled by `down`;
    return (x0, y0, w, h) in FULL-frame px (the caller divides the anchor by `down`)."""
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    px = px[::-1]  # Blender stores bottom-up; we want y down
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


def main() -> None:
    a = args()
    os.makedirs(a["out"], exist_ok=True)
    assets = scene.build_scene(ky=a["ky"], px_per_unit=a["scale"])
    export = bpy.data.collections["export"]
    w, h = setup_render(a["scale"])
    manifest = {"version": 1, "camera": {"kx": scene.KX, "ky": a["ky"]}, "assets": []}
    for asset_id, obj in assets.items():
        v = world_to_camera_view(bpy.context.scene, bpy.context.scene.camera, obj.matrix_world.translation)
        print(f"frame {w}x{h}; {asset_id} origin in camera view: ({v.x:.3f}, {v.y:.3f}, {v.z:.1f})")
        file = "office-art-" + asset_id.replace("/", "-") + ".png"
        path = os.path.join(a["out"], file)
        render_alone(obj, path, export)
        print(f"engine {bpy.context.scene.render.engine}; wrote {os.path.getsize(path)} bytes to {file}")
        down = SHELL_DOWNSAMPLE.get(asset_id, 1)
        x0, y0, cw, ch = crop_alpha(path, down)
        quantize(path)
        ox, oy = project_px(obj.matrix_world.translation, w, h)
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
    with open(os.path.join(a["out"], "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    if a["save"]:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(a["save"]))
    print(f"wrote {len(manifest['assets'])} asset(s) and manifest.json to {a['out']}")


main()

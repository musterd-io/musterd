"""The office paintings (office decor refresh, lane 01M6FXB2CA, ADR 789): crop each generated source in
`paintings/` to its frame's print opening, size it, and write `office-art-painting-<slot>.webp` plus its
`painting/<slot>` entry in the rendered manifest.

    python3 packages/web/art/office/paintings.py [--out packages/web/src/live/office-scene/rendered/assets]

Plain Python with Pillow — an art tool, like Blender and `meshy.py`; nothing here ships at runtime. The
sources and their sidecars (`<slot>-<slug>.json`: prompt, seed, model, the provenance check) are the
record a reviewer reads. Idempotent: re-running rewrites the same files.
"""
from __future__ import annotations

import glob
import json
import math
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "paintings")
OUT = os.path.join(HERE, "..", "..", "src", "live", "office-scene", "rendered", "assets")

# layout.ts ART: (w, h, frame) per slot — the frame sizes the print opening, as `printOpening` does
SLOTS = [(54, 42, "thick"), (26, 26, "none"), (22, 30, "thin"), (30, 22, "thin"), (60, 44, "thick")]
MAT = 2.0  # the mat border left showing round the print, logical units (paintings.ts MAT)
PX_PER_UNIT = 6  # the room's art renders at 3; twice that keeps brushwork on a 2x screen, at a few KB each
EDGE_INSET = 0.02  # trimmed off every side first: generators like to paint a frame line at the edge


def print_opening(w: float, h: float, frame: str) -> tuple[float, float]:
    """Half-width and half-height of the print, in logical units (paintings.ts `printOpening`)."""
    if frame == "none":
        return w / 2, h / 2
    bar = w * (0.06 if frame == "thick" else 0.025)
    return (w - 2 * bar) / 2 - MAT, (h - 2 * bar) / 2 - MAT


def crop_to(img: Image.Image, aspect: float) -> Image.Image:
    """Trim `EDGE_INSET`, then centre-crop to `aspect` (width / height)."""
    W, H = img.size
    dx, dy = round(W * EDGE_INSET), round(H * EDGE_INSET)
    img = img.crop((dx, dy, W - dx, H - dy))
    W, H = img.size
    if W / H > aspect:
        nw = round(H * aspect)
        x0 = (W - nw) // 2
        return img.crop((x0, 0, x0 + nw, H))
    nh = round(W / aspect)
    y0 = (H - nh) // 2
    return img.crop((0, y0, W, y0 + nh))


def main(out: str) -> None:
    manifest_path = os.path.join(out, "manifest.json")
    manifest = json.load(open(manifest_path))
    assets = [a for a in manifest["assets"] if not a["id"].startswith("painting/")]
    for side in sorted(glob.glob(os.path.join(SRC, "*.json"))):
        meta = json.load(open(side))
        slot = meta["art_slot"]
        hw, hh = print_opening(*SLOTS[slot])
        img = Image.open(os.path.join(SRC, meta["source"])).convert("RGB")
        img = crop_to(img, hw / hh)
        pw = math.ceil(2 * hw * PX_PER_UNIT)
        ph = math.ceil(2 * hh * PX_PER_UNIT)
        img = img.resize((pw, ph), Image.LANCZOS)
        name = f"office-art-painting-{slot}.webp"
        img.save(os.path.join(out, name), "WEBP", quality=85, method=6)
        assets.append({"id": f"painting/{slot}", "file": name, "w": pw, "h": ph, "anchor": {"x": 0, "y": 0}, "scale": PX_PER_UNIT})
        print(f"painting/{slot} <- {meta['source']} {pw}x{ph} {os.path.getsize(os.path.join(out, name))} B")
    manifest["assets"] = assets
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    args = sys.argv[1:]
    main(args[args.index("--out") + 1] if "--out" in args else OUT)

"""Figure stills: a few frames of eight sample members, composited the way the runtime draws them, at
office size — the look check before a full figure render (office figure v2, plan Task 1).

    python3 packages/web/art/office/render_watch.py -- --figure --stills idle:0:SE,sit-type:2:E \\
        --out /tmp/fig-stills --scale 1.66 --ky 0.31

Each still renders through the per-call store, so stills taken during (or after) a full render cost
nothing more. Writes `<clip>-<frame>-<dir>.png` per still and `sheet.png`, every still side by side,
on the floor's colour. No Blender here — numpy and the cells `render.py` already split.
"""

from __future__ import annotations

import colorsys
import os

import numpy as np

FLOOR = "#ebae64"

# `appearanceOf` for eight names, as `appearance.ts` deals them today (regenerate with a tsx one-off
# that prints appearanceOf + memberColor when the wardrobe changes). `top` is the identity colour.
SAMPLE = {
    "ada": {"ears": "earrings-stud", "metal": "#cfd3d8", "smile": "soft", "kind": "human", "top": "hsl(334,68,62)", "skin": "#c68642", "hair": "short", "hairColor": "#221a14", "facialHair": "none", "hat": "none", "hatColor": "#2a2118", "cut": "tee", "bottom": "#8a4a32", "shoes": "#2f8f7a", "accessory": "none", "accessoryColor": "#2f8fa3"},
    "bo": {"ears": "earrings-hoop", "metal": "#e2b85c", "smile": "soft", "kind": "human", "top": "hsl(341,68,62)", "skin": "#f2a6a6", "hair": "afro", "hairColor": "#3d2a1c", "facialHair": "stubble", "hat": "band", "hatColor": "#2f8fa3", "cut": "hoodie", "bottom": "#3f5570", "shoes": "#2f4a70", "accessory": "scarf", "accessoryColor": "#e1ad01"},
    "cy": {"smile": "soft", "kind": "agent", "top": "hsl(219,68,62)", "skin": "#8ed1c9", "hair": "short", "hairColor": "#2f8f7a", "facialHair": "none", "hat": "band", "hatColor": "#d1503f", "cut": "tee", "bottom": "#8a4a32", "shoes": "#2f8f7a", "accessory": "headphones", "accessoryColor": "#3f6fa8"},
    "dee": {"smile": "soft", "kind": "human", "top": "hsl(21,68,62)", "skin": "#4e2c14", "hair": "bun", "hairColor": "#e8dcc8", "facialHair": "goatee", "hat": "none", "hatColor": "#e8dcc8", "cut": "hoodie", "bottom": "#8a4a32", "shoes": "#e1ad01", "accessory": "glasses-square", "accessoryColor": "#e1ad01"},
    "eli": {"smile": "wide", "kind": "human", "top": "hsl(328,68,62)", "skin": "#f7d9b8", "hair": "bun", "hairColor": "#4f8a3a", "facialHair": "beard", "hat": "cap", "hatColor": "#e07a3f", "cut": "tee", "bottom": "#4a5a3a", "shoes": "#d1503f", "accessory": "none", "accessoryColor": "#d1503f"},
    "fay": {"smile": "soft", "kind": "agent", "top": "hsl(168,68,62)", "skin": "#9db8c9", "hair": "afro", "hairColor": "#8a3a2e", "facialHair": "none", "hat": "none", "hatColor": "#2f8fa3", "cut": "vest", "bottom": "#3f5570", "shoes": "#a9683a", "accessory": "headphones", "accessoryColor": "#2f8fa3"},
    "gus": {"smile": "wide", "kind": "human", "top": "hsl(20,68,62)", "skin": "#f5cf6e", "hair": "bald", "hairColor": "#3f6fa8", "facialHair": "beard-wild", "hat": "cap", "hatColor": "#d1503f", "cut": "long", "bottom": "#7d6b8f", "shoes": "#e1ad01", "accessory": "none", "accessoryColor": "#d1503f"},
    "hana": {"smile": "wide", "kind": "human", "top": "hsl(340,68,62)", "skin": "#f5cf6e", "hair": "long", "hairColor": "#4f8a3a", "facialHair": "moustache", "hat": "none", "hatColor": "#2f8fa3", "cut": "vest", "bottom": "#8a4a32", "shoes": "#2f8f7a", "accessory": "glasses-browline", "accessoryColor": "#4f8a3a"},
}
# hana's hair is `bob` today; `long` here so a long-hair silhouette is always in the check (Review Focus 2).


def rgb(c: str) -> np.ndarray:
    if c.startswith("hsl("):
        h, s, l = (float(v) for v in c[4:-1].split(","))
        return np.array(colorsys.hls_to_rgb(h / 360, l / 100, s / 100))
    return np.array([int(c[i : i + 2], 16) / 255 for i in (1, 3, 5)])


def layers_for(m: dict) -> list[tuple[str, str | None]]:
    """`figure.ts` `layersFor`, v2 order: back to front, (layer id, tint or None). An agent's tells take
    its identity colour; there is no visor."""
    agent = m["kind"] == "agent"
    out = [("skin", m["skin"]), ("eyes", None)] + ([("tell/eyes", m["top"])] if agent else [])
    out.append((f"mouth/{m['smile']}", m["skin"]))
    out += [("shoes", m["shoes"]), ("bottom", m["bottom"]), (f"top/{m['cut']}", m["top"])]
    if agent:
        out.append(("tell/collar", m["top"]))
    if m["hair"] != "bald":
        out.append((f"hair/{m['hair']}", m["hairColor"]))
    if m["facialHair"] != "none":
        out.append((f"facial/{m['facialHair']}", m["hairColor"]))
    if m["hat"] != "none":
        out.append((f"hat/{m['hat']}", m["hatColor"]))
    if m["accessory"] != "none":
        out.append((f"acc/{m['accessory']}", m["accessoryColor"]))
    if m.get("ears", "none").startswith("earrings"):  # the ears spot (v2-4b), in its metal
        out.append((f"acc/{m['ears']}", m["metal"]))
    return out


CARRIED = ["carry/folder", "carry/box", "carry/laptop", "carry/plate", "carry/mug", "carry/card", "carry/bottle", "carry/phone"]


def composite(crops: dict, still: tuple[str, str, int], m: dict, fw: int, fh: int, resolve) -> np.ndarray:
    """One member's frame: each layer's cell multiplied by its tint (sRGB, like `tintFrame`), drawn over.
    A carrying clip draws the first thing it holds a cell for, after the clothes, as `layersFor` does."""
    frame = np.zeros((fh, fw, 4))
    clip, d, f = still
    layers = layers_for(m)
    held = next((l for l in CARRIED if crops.get(l, {}).get(resolve(l, clip, d, f)) is not None), None)
    if held:
        at = next(i for i, (l, _) in enumerate(layers) if l.startswith("top/")) + 1
        layers.insert(at, (held, None))
    for layer, tint in layers:
        c = crops.get(layer, {}).get(resolve(layer, clip, d, f))
        if c is None:
            continue
        img, x0, y0 = c
        px = img.astype(np.float64) / 255
        if tint is not None:
            px[:, :, :3] *= rgb(tint)
        h, w = px.shape[:2]
        dst = frame[y0 : y0 + h, x0 : x0 + w]
        a = px[:, :, 3:4]
        dst[:, :, :3] = px[:, :, :3] * a + dst[:, :, :3] * (1 - a)
        dst[:, :, 3:4] = a + dst[:, :, 3:4] * (1 - a)
    return frame


def write(crops: dict, stills: list[tuple[str, str, int]], fw: int, fh: int, out: str, write_png, resolve) -> None:
    """`stills` as (clip, dir, frame). `write_png(path, float32 (h, w, 4))` is render.py's writer;
    `resolve(layer, clip, dir, frame)` names the cell a layer draws from (a carrying clip's base)."""
    os.makedirs(out, exist_ok=True)
    floor = rgb(FLOOR)
    rows = []
    for clip, d, f in stills:
        tiles = []
        for name, m in SAMPLE.items():
            fr = composite(crops, (clip, d, f), m, fw, fh, resolve)
            tile = np.ones((fh, fw, 4))
            tile[:, :, :3] = fr[:, :, :3] + floor * (1 - fr[:, :, 3:4])
            tiles.append(tile)
        row = np.concatenate(tiles, axis=1)
        write_png(os.path.join(out, f"{clip}-{f}-{d}.png"), row.astype(np.float32))
        rows.append(row)
    write_png(os.path.join(out, "sheet.png"), np.concatenate(rows, axis=0).astype(np.float32))
    print(f"figure stills: {len(stills)} still(s) × {len(SAMPLE)} members → {out}", flush=True)

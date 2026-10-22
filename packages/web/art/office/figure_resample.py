"""A figure render call's cells at another scale, from the cells stored at a bigger one (lane 01M5J8DXCH).

`render.py --figure --resample-from <px>` uses this on a store miss: instead of rendering the call
at the new scale it takes the call's cells at <px> and scales them down. The cells of one call are
the pieces of one lit frame, split by a hard ID mask, so they are put back together first and the
whole frame is scaled, premultiplied; then each target pixel goes to the layer of the source pixel
nearest its centre — the same hard split a render at the new scale makes with its own ID pass. Scaling
each cell alone instead would leave a faint gap wherever two layers meet (a sleeve on an arm).

No Blender here — numpy only, so it can be tested and compared outside it.
"""

from __future__ import annotations

import numpy as np

ALPHA_MIN = 0.002  # render.py's mask threshold: a lit pixel this faint is not part of the figure


def weights(n_out: int, n_in: int, kind: str = "lanczos2") -> np.ndarray:
    """(n_out, n_in) rows that each sum to 1: the filter stretched over the source pixels one target
    pixel covers (scaling down, so the support grows by n_in / n_out)."""
    r = n_out / n_in
    c = (np.arange(n_out) + 0.5) / r - 0.5  # each target centre, in source pixels
    x = (np.arange(n_in)[None, :] - c[:, None]) * r  # distance in target pixels
    if kind == "tent":
        w = np.clip(1.0 - np.abs(x), 0.0, None)
    elif kind == "box":
        w = (np.abs(x) <= 0.5).astype(np.float64)
    elif kind.startswith("lanczos"):
        a = int(kind[len("lanczos"):])
        w = np.where(np.abs(x) < a, np.sinc(x) * np.sinc(x / a), 0.0)
    else:
        raise ValueError(f"figure_resample: unknown filter {kind}")
    return w / w.sum(axis=1, keepdims=True)


def resample_call(cells: dict, src: tuple[int, int], dst: tuple[int, int], kind: str = "lanczos2") -> dict:
    """`cells`: grid key (a layer, or `<layer>@arms`) → (uint8 RGBA crop, x0, y0) in a `src` (w, h)
    frame. Returns the same keys' cells in a `dst` (w, h) frame; a cell with nothing left is dropped."""
    sw, sh = src
    dw, dh = dst
    layers = [g for g in cells if not g.endswith("@arms")]
    lit = np.zeros((sh, sw, 4), np.float64)  # premultiplied
    label = np.full((sh, sw), -1, np.int32)
    arm = np.zeros((sh, sw), bool)
    for i, g in enumerate(layers):
        img, x0, y0 = cells[g]
        h, w = img.shape[:2]
        px = img.astype(np.float64) / 255
        on = px[:, :, 3] > 0
        px[:, :, :3] *= px[:, :, 3:4]
        lit[y0 : y0 + h, x0 : x0 + w] += px  # the layers of one call never overlap
        label[y0 : y0 + h, x0 : x0 + w][on] = i
    for g in cells:
        if g.endswith("@arms"):
            img, x0, y0 = cells[g]
            h, w = img.shape[:2]
            arm[y0 : y0 + h, x0 : x0 + w] |= img[:, :, 3] > 0
    wy, wx = weights(dh, sh, kind), weights(dw, sw, kind)
    out = np.einsum("ys,sxc->yxc", wy, np.einsum("xt,stc->sxc", wx, lit))
    out[:, :, 3] = np.clip(out[:, :, 3], 0.0, 1.0)
    a = out[:, :, 3:4]
    out[:, :, :3] = np.where(a > 0, out[:, :, :3] / np.maximum(a, 1e-12), 0.0)
    out = np.clip(out, 0.0, 1.0)
    # the source pixel nearest each target pixel's centre decides its layer, as the ID pass would
    sy = np.minimum(((np.arange(dh) + 0.5) * sh / dh).astype(int), sh - 1)
    sx = np.minimum(((np.arange(dw) + 0.5) * sw / dw).astype(int), sw - 1)
    label_t, arm_t = label[np.ix_(sy, sx)], arm[np.ix_(sy, sx)]
    solid = out[:, :, 3] > ALPHA_MIN
    res = {}
    for i, g in enumerate(layers):
        mask = (label_t == i) & solid
        c = _crop(out, mask)
        if c is not None:
            res[g] = c
        if f"{g}@arms" in cells:
            c = _crop(out, mask & arm_t)
            if c is not None:
                res[f"{g}@arms"] = c
    return res


def _crop(img: np.ndarray, mask: np.ndarray) -> tuple | None:
    """render.py's `crop`: the masked pixels as 8-bit RGBA, cropped to themselves."""
    if not mask.any():
        return None
    ys, xs = np.nonzero(mask)
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
    part = np.where(mask[y0:y1, x0:x1, None], img[y0:y1, x0:x1], 0.0)
    return (np.clip(np.rint(part * 255), 0, 255).astype(np.uint8), x0, y0)

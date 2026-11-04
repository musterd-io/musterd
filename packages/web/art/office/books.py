"""Real-looking books for the office shelves (office decor refresh, lane 01M6FXB5GR).

nick, 2026-11-03: "books that look real (different heights, some leaning, some stacked flat, spines
with bands)". `shelf_row` lays out one shelf's books along its length: runs of upright books of
varied height and thickness, now and then a book leaning on its neighbour, a flat stack, and a gap.
Pure Python (no bpy) so `test_books.py` can hold it; `scene.py` `bookshelf` builds the boxes.

A book is a dict: `kind` ('upright' | 'lean' | 'flat'), `along` (its centre along the shelf, 0 at
the middle), `w` (thickness along the shelf; a flat stack's footprint length), `h` (height up from the
shelf; a flat stack's total height), `d` (depth into the shelf), `tilt` (degrees, a lean only),
`color` and `band_color` (hex), `band_at` (the spine band's height as a fraction of the book), and for
a flat stack `count` (books in it).
"""
from __future__ import annotations

import math
import random

# Muted cloth bindings: darker and less saturated than a toy shelf, so a row reads as a library.
CLOTHS = [
    "#7a2e2a", "#2c4a5e", "#5a4a2e", "#3f5a43", "#5b3a5e", "#8a5a34", "#2e3a4a", "#6b6a3a",
    "#a0522d", "#40576b", "#7d6b4f", "#4b3b2f", "#556b5e", "#8c3f3f", "#2f2f35", "#b08a4a",
]
BANDS = ["#d8b45c", "#efe4cf", "#1f1d1b"]  # gold leaf, cream, black


def shelf_row(seed: int, long: float, band: float, deep: float, want_flat: bool = False, want_lean: bool = False) -> list[dict]:
    """One shelf's books, deterministic for `seed`. `long` is the shelf's inside length, `band` the
    clear height above it, `deep` its depth. `want_flat` / `want_lean` make this row carry a flat stack /
    a leaning book where it has room, so a unit (`scene.py` asks one row for each) always has both."""
    rng = random.Random(seed)
    half = long / 2 - 2
    top = band - 3
    books: list[dict] = []
    x = -half
    gaps = 0
    flats = 0
    leans = 0

    def cloth() -> tuple[str, str, float]:
        return rng.choice(CLOTHS), rng.choice(BANDS), round(rng.uniform(0.18, 0.82), 3)

    # every row breathes somewhere: one gap is placed up front, more may come by chance
    gap_at = rng.uniform(-half * 0.5, half * 0.5)
    while half - x >= 2.4:
        roll = rng.random()
        room = half - x
        if gaps == 0 and x + 6 >= gap_at and room > 8:
            x += rng.uniform(6, min(9, room - 1))
            gaps += 1
            continue
        if roll < (1.0 if want_flat else 0.12) and room > 14 and flats < 1 and not (gaps == 0 and x + 16 >= gap_at):
            # a flat stack: 2–4 books lying down, a little ragged
            count = rng.randint(2, 4)
            w = rng.uniform(10, min(15, room - 1))
            h = sum(rng.uniform(1.6, 2.6) for _ in range(count))
            h = min(h, top)
            c, b, at = cloth()
            books.append({"kind": "flat", "along": x + w / 2, "w": w, "h": h, "d": min(deep - 4, rng.uniform(8, 11)),
                          "tilt": 0.0, "color": c, "band_color": b, "band_at": at, "count": count})
            x += w + rng.uniform(0.6, 1.4)
            flats += 1
        elif roll < 0.22 and room > 10 and gaps < 2:
            # a gap: the shelf is used, not packed
            x += rng.uniform(6, min(10, room - 2))
            gaps += 1
        else:
            run = rng.randint(2, 6)
            start = x
            for k in range(run):
                room = half - x
                if gaps == 0 and x + 6 >= gap_at and room > 8:
                    break  # the row's gap comes here; the loop above opens it
                w = rng.uniform(2.0, 4.6)
                if room < w + 0.3:
                    break
                h = top * (rng.choice((0.62, 0.72, 0.84, 0.95)) + rng.uniform(-0.03, 0.02))
                c, b, at = cloth()
                lean = k > 0 and (k == run - 1 or (want_lean and leans == 0)) and leans < 2 and rng.random() < (1.0 if want_lean and leans == 0 else 0.35) and room > w + 6 and not (gaps == 0 and x + 14 >= gap_at)
                if lean:
                    tilt = rng.uniform(12, 22)
                    foot = w + h * math.sin(math.radians(tilt))  # the tilted footprint along the shelf
                    if foot > room - 0.3:
                        lean = False
                if lean:
                    books.append({"kind": "lean", "along": x + foot / 2, "w": w, "h": min(h, top / math.cos(math.radians(tilt))),
                                  "d": min(deep - 4, rng.uniform(7, 11)), "tilt": round(tilt, 2),
                                  "color": c, "band_color": b, "band_at": at})
                    x += foot + rng.uniform(1.0, 3.0)
                    leans += 1
                    break
                books.append({"kind": "upright", "along": x + w / 2, "w": w, "h": h, "d": min(deep - 4, rng.uniform(7, 11)),
                              "tilt": 0.0, "color": c, "band_color": b, "band_at": at})
                x += w + rng.uniform(0.05, 0.35)
            if x == start and not (gaps == 0 and x + 6 >= gap_at and half - x > 8):
                break  # nothing more fits: the shelf ends here
    # a shelf of one height reads as a block: make sure the uprights span short to tall
    ups = [b for b in books if b["kind"] == "upright"]
    if len(ups) >= 3 and max(b["h"] for b in ups) - min(b["h"] for b in ups) < 2:
        ups[0]["h"], ups[-1]["h"] = top * 0.62, top * 0.95
    return books


def foot(book: dict) -> tuple[float, float]:
    """The span a book takes along the shelf (a lean counts its tilted footprint)."""
    if book["kind"] == "lean":
        span = book["w"] + book["h"] * math.sin(math.radians(book["tilt"]))
    else:
        span = book["w"]
    return book["along"] - span / 2, book["along"] + span / 2

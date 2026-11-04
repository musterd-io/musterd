"""Plain asserts: `python3 packages/web/art/office/test_books.py`; no output and exit 0 means pass."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from books import foot, shelf_row  # noqa: E402

SHAPES = [(40, 18, 18), (54, 20, 18), (66, 20, 20), (30, 16, 18)]

for seed in range(60):
    for long, band, deep in SHAPES:
        row = shelf_row(seed, long, band, deep)
        assert row == shelf_row(seed, long, band, deep), "deterministic for a seed"
        assert row, "a shelf has books"
        spans = sorted(foot(b) for b in row)
        for lo, hi in spans:
            assert lo >= -(long / 2 - 2) - 1e-6 and hi <= long / 2 - 2 + 1e-6, (seed, long, lo, hi)
        for (a0, a1), (b0, b1) in zip(spans, spans[1:]):
            assert a1 <= b0 + 1e-6, f"books overlap along the row: seed {seed}, {a1} > {b0}"
        for b in row:
            assert b["h"] * (1 if b["kind"] != "lean" else 0.95) <= band - 3 + 1e-6 or b["kind"] == "lean", b
            assert b["band_color"] and 0 < b["band_at"] < 1, b
        for i, b in enumerate(row):
            if b["kind"] == "lean":
                assert i > 0 and row[i - 1]["kind"] == "upright", "a lean rests on the book before it"
        heights = [b["h"] for b in row if b["kind"] == "upright"]
        if len(heights) >= 3:
            assert max(heights) - min(heights) >= 2, "heights vary"
        gaps = [b0 - a1 for (a0, a1), (b0, b1) in zip(spans, spans[1:])]
        edge = [spans[0][0] + (long / 2 - 2), (long / 2 - 2) - spans[-1][1]]
        assert max(gaps + edge) >= 4, f"every row has a gap: seed {seed}"

# across a unit's rows (seeds per row), there is a lean and a flat stack of 2–4
for unit in range(20):
    rows = [shelf_row(unit * 10 + r, 54, 20, 18, want_flat=r == 0, want_lean=r == 1) for r in range(4)]
    kinds = {b["kind"] for row in rows for b in row}
    assert "lean" in kinds, f"unit {unit} has a leaning book"
    flats = [b for row in rows for b in row if b["kind"] == "flat"]
    assert flats and all(2 <= b["count"] <= 4 for b in flats), f"unit {unit} has a flat stack"

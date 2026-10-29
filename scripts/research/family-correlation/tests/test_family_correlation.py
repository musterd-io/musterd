"""The family-correlation tooling: patch numbering, the four operators, keep rule, reply parsing and scoring.

Runs under pytest, or as `python3 tests/test_family_correlation.py` where pytest is not installed.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import analyze  # noqa: E402
import keep  # noqa: E402
import mutate  # noqa: E402
import patchlib  # noqa: E402
import review  # noqa: E402

PATCH = """diff --git a/pkg/mod.py b/pkg/mod.py
index 1111111..2222222 100644
--- a/pkg/mod.py
+++ b/pkg/mod.py
@@ -10,3 +10,14 @@ class A:
     def keep(self):
         return 1

+    def size(self, n, strict: bool = False):
+        if n < 3:
+            return "small"
+        elif n > 10:
+            return "big"
+        else:
+            return "mid"
+
+    def check(self, x):
+        if x is None:
+            raise ValueError("x is required")
@@ -30,2 +41,3 @@ class A:
     def tail(self):
+        pass
         return 2
diff --git a/tests/test_mod.py b/tests/test_mod.py
--- a/tests/test_mod.py
+++ b/tests/test_mod.py
@@ -1,1 +1,2 @@
 import x
+assert x < 1
"""


def test_parse_render_round_trip():
    assert patchlib.render(patchlib.parse(PATCH)) == PATCH


def test_numbered_carries_new_file_lines():
    text = patchlib.numbered([f for f in patchlib.parse(PATCH) if not patchlib.is_test_path(f.path)])
    assert "   13 +     def size(self, n, strict: bool = False):" in text
    assert "   14 +         if n < 3:" in text
    assert "   41       def tail(self):" in text
    assert "tests/test_mod.py" not in text


def test_sites_cover_all_four_classes_and_skip_tests():
    files = patchlib.parse(PATCH)
    found = {(s.cls, s.detail) for s in mutate.sites(files, mutate.FIRST_CLASSES)}
    assert ("off_by_one", "< -> <=") in found
    assert ("off_by_one", "> -> >=") in found
    assert ("wrong_default", "default False -> True") in found
    assert any(c == "swallowed_error" for c, _ in found)
    assert any(c == "missed_branch" and "else" in d for c, d in found)
    assert any(c == "missed_branch" and "elif" in d for c, d in found)
    assert all(files[s.file].path == "pkg/mod.py" for s in mutate.sites(files, mutate.FIRST_CLASSES))


def test_off_by_one_keeps_the_line_number():
    files = patchlib.parse(PATCH)
    s = next(s for s in mutate.sites(files, mutate.FIRST_CLASSES) if s.detail == "< -> <=")
    m = mutate.apply(files, s)
    assert "+        if n <= 3:" in m.patch
    assert (m.loc_start, m.loc_end) == (14, 14)
    assert m.hunk_range == (10, 23)


def test_missed_branch_locates_the_first_line_after_and_renumbers_later_hunks():
    files = patchlib.parse(PATCH)
    s = next(s for s in mutate.sites(files, mutate.FIRST_CLASSES) if s.cls == "missed_branch" and "else" in s.detail and "elif" not in s.detail)
    m = mutate.apply(files, s)
    assert '+            return "mid"' not in m.patch
    assert "@@ -10,3 +10,12 @@ class A:" in m.patch
    assert "@@ -30,2 +39,3 @@ class A:" in m.patch  # the next hunk moved up two lines
    after = patchlib.parse(m.patch)[0].hunks[0]
    line_at = dict(zip(after.new_numbers(), (t for _, t in after.lines)))
    assert line_at[m.loc_start] == ""  # the blank line that followed the removed arm


def test_swallowed_error_becomes_pass_at_the_same_indent():
    files = patchlib.parse(PATCH)
    s = next(s for s in mutate.sites(files, mutate.FIRST_CLASSES) if s.cls == "swallowed_error")
    m = mutate.apply(files, s)
    assert "+            pass" in m.patch and "raise ValueError" not in m.patch


ABSENT = """diff --git a/pkg/b.py b/pkg/b.py
--- a/pkg/b.py
+++ b/pkg/b.py
@@ -1,2 +1,15 @@
 def run(x, y):
     a = 1
+    if x is None:
+        raise ValueError("x")
+    total = x + y
+    log(total)
+    if x > 0 and y > 0:
+        return total
+    elif x < 0:
+        return -total
+    while x and y or a:
+        x -= 1
+    a = x * 2
+    only = 1
+    return 0
"""


def test_absence_operators():
    files = patchlib.parse(ABSENT)
    found = {(s.cls, s.detail) for s in mutate.sites(files)}
    assert ("dropped_guard", "removed guard `if x is None:`") in found
    assert ("dropped_statement", "removed `a = x * 2`") in found  # rebinds `a`
    assert ("dropped_statement", "removed `total = x + y`") not in found  # would leave `total` unbound
    assert ("dropped_statement", "removed `log(total)`") in found
    assert ("dropped_clause", "dropped `and y > 0` from the condition") in found
    assert ("dropped_elif", "removed `elif x < 0:` arm") in found
    assert not any("while" in d for _, d in found)  # mixed and/or is skipped
    assert not any(d == "removed `x -= 1`" for _, d in found)  # the only statement in its block
    assert {c for c, _ in found} <= set(mutate.CLASSES)
    clause = next(s for s in mutate.sites(files) if s.cls == "dropped_clause")
    m = mutate.apply(files, clause)
    assert "+    if x > 0:" in m.patch and m.loc_start == 7
    guard = next(s for s in mutate.sites(files) if s.cls == "dropped_guard")
    m = mutate.apply(files, guard)
    assert "raise ValueError" not in m.patch and m.loc_start == 3  # the line after the removed guard


def test_keep_rule():
    ok_ref = {"passed": True, "tests_passed": 5, "tests_failed": 0, "error": None}
    assert keep.verdict(ok_ref, {"passed": False, "tests_passed": 4, "tests_failed": 1, "error": None}) == (True, "kept")
    assert not keep.verdict(ok_ref, {"passed": True, "tests_passed": 5, "tests_failed": 0, "error": None})[0]
    assert not keep.verdict(ok_ref, {"passed": False, "tests_passed": 0, "tests_failed": 3, "error": None})[0]
    assert not keep.verdict(ok_ref, {"error": "boom"})[0]
    assert keep.verdict(ok_ref, {"tests_passed": 0, "tests_failed": 0, "hung": True})[1].startswith("mutant hangs")
    assert not keep.verdict({"passed": False}, {"tests_passed": 1, "tests_failed": 1})[0]


def test_parse_findings():
    assert review.parse_findings('{"findings": []}') == []
    fenced = '```json\n{"findings": [{"file": "pkg/mod.py", "line": "14", "summary": "bound"}]}\n```'
    assert review.parse_findings(fenced) == [{"file": "pkg/mod.py", "line": 14, "summary": "bound"}]
    assert review.parse_findings('Sure! {"findings": [{"file": "a.py", "line": 3}]} done')[0]["line"] == 3
    assert review.parse_findings("no defects found") is None
    assert review.parse_findings('{"issues": []}') is None


def test_prompt_is_the_manifests():
    assert "The change may contain no defect." in review.PROMPT
    assert review.PROMPT.endswith("TASK: {task}\n\nDIFF: {diff}")


def test_hit_rules():
    item = {"path": "pkg/mod.py", "loc": [14, 14], "hunk": [10, 23]}
    assert analyze.hit([{"file": "pkg/mod.py", "line": 17}], item, "primary")
    assert not analyze.hit([{"file": "pkg/mod.py", "line": 18}], item, "primary")
    assert analyze.hit([{"file": "pkg/mod.py", "line": 22}], item, "coarse")
    assert not analyze.hit([{"file": "pkg/mod.py", "line": 24}], item, "coarse")
    assert analyze.hit([{"file": "b/pkg/mod.py", "line": 14}], item, "primary")
    assert analyze.hit([{"file": "mod.py", "line": 14}], item, "primary")
    assert not analyze.hit([{"file": "pkg/other.py", "line": 14}], item, "primary")
    assert not analyze.hit([], item, "primary") and not analyze.hit(None, item, "primary")


def test_d_drops_reviewers_with_no_variance():
    miss = {
        "c1": [1, 0, 1, 0, 1, 0],
        "c2": [1, 0, 1, 0, 1, 0],  # same as c1: within-family phi 1
        "g1": [1, 1, 0, 0, 1, 0],
        "g2": [1, 1, 1, 1, 1, 1],  # misses everything: dropped
    }
    family = {"c1": "claude", "c2": "claude", "g1": "gpt", "g2": "gpt"}
    d, dropped = analyze.d_stat(miss, family, list(range(6)))
    assert dropped == ["g2"]
    cross = analyze.phi(miss["c1"], miss["g1"])
    assert abs(d - (1.0 - cross)) < 1e-9


def test_d_is_none_without_a_within_family_pair():
    miss = {"c1": [1, 0, 1, 0], "g1": [0, 1, 1, 0]}
    d, _ = analyze.d_stat(miss, {"c1": "claude", "g1": "gpt"}, [0, 1, 2, 3])
    assert d is None


def test_verdict_needs_both_rules():
    assert analyze.verdict((0.02, 0.30), (0.05, 0.25)) == "same-family excess"
    assert analyze.verdict((-0.10, 0.12), (-0.05, 0.10)) == "no excess worth routing on"
    assert analyze.verdict((0.02, 0.30), (-0.05, 0.10)) == "inconclusive (rules disagree)"
    assert analyze.verdict((-0.05, 0.30), (-0.05, 0.30)) == "inconclusive"
    assert analyze.verdict(None, (0.02, 0.3)) == "inconclusive (rules disagree)"


def test_pilot_projection_reads_pilot_rows_only(tmp_path=None):
    import json
    import subprocess
    import tempfile

    run = Path(tmp_path or tempfile.mkdtemp())
    item = {"path": "pkg/mod.py", "loc": [14, 14], "hunk": [10, 22], "feature": "r/task1/feature1", "class": "dropped_guard"}
    items = [{**item, "item": "s1", "stage": "pilot"}, {**item, "item": "s2", "stage": "main"}]
    reviews = [
        {"item": "s1", "stage": "pilot", "model": "m", "family": "f", "findings": [], "cost_usd": 0.10},
        {"item": "s2", "stage": "main", "model": "m", "family": "f", "findings": [], "cost_usd": 50.0},
    ]
    (run / "items.jsonl").write_text("".join(json.dumps(r) + "\n" for r in items))
    (run / "reviews.jsonl").write_text("".join(json.dumps(r) + "\n" for r in reviews))
    out = subprocess.run(
        [sys.executable, str(Path(analyze.__file__)), "--run", str(run), "--stage", "pilot", "--main-reviews", "10"],
        capture_output=True, text=True, check=True,
    ).stdout
    report = json.loads(out)
    assert report["spent_usd"] == 0.1 and report["spent_all_stages_usd"] == 50.1
    assert report["pilot_gate"]["projected_total_usd"] == 1.1  # 0.10 + 0.10 x 10, the main row ignored


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
    print(f"{len(tests)} passed")

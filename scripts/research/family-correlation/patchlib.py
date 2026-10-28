"""Unified-diff parsing, rendering and new-file line numbering for the family-correlation study.

docs/research/family-correlation-manifest.md pins what this serves: reviewers see the diff with
explicit new-file line numbers, and the scorer locates a seeded defect by new-file line and by
diff hunk. Everything here works from the patch text alone; no repository checkout is needed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$")
TEST_DIR_RE = re.compile(r"(^|/)(tests?|testing|__tests__)/")
TEST_FILE_RE = re.compile(r"(^|/)(test_[^/]+|[^/]+_test\.py|conftest\.py)$")


@dataclass
class Hunk:
    old_start: int
    new_start: int
    suffix: str
    lines: list[tuple[str, str]] = field(default_factory=list)  # (tag, text): tag in ' ', '+', '-', '\\'

    @property
    def old_len(self) -> int:
        return sum(1 for t, _ in self.lines if t in " -")

    @property
    def new_len(self) -> int:
        return sum(1 for t, _ in self.lines if t in " +")

    def new_numbers(self) -> list[int | None]:
        """The new-file line number of each line, or None for a removed line or a no-newline marker."""
        out: list[int | None] = []
        n = self.new_start
        for tag, _ in self.lines:
            if tag in " +":
                out.append(n)
                n += 1
            else:
                out.append(None)
        return out

    def new_range(self) -> tuple[int, int]:
        """First and last new-file line the hunk covers (an empty hunk covers its start line)."""
        return self.new_start, self.new_start + max(self.new_len, 1) - 1


@dataclass
class FileDiff:
    header: list[str]  # `diff --git`, index, mode, ---/+++ lines, verbatim
    path: str  # new-file path, without the b/ prefix
    hunks: list[Hunk] = field(default_factory=list)

    @property
    def is_python_source(self) -> bool:
        return self.path.endswith(".py") and not is_test_path(self.path)


def is_test_path(path: str) -> bool:
    return bool(TEST_DIR_RE.search(path) or TEST_FILE_RE.search(path))


def parse(text: str) -> list[FileDiff]:
    files: list[FileDiff] = []
    cur: FileDiff | None = None
    hunk: Hunk | None = None
    for raw in text.splitlines():
        if raw.startswith("diff --git "):
            m = re.match(r"diff --git a/(\S+) b/(\S+)", raw)
            cur = FileDiff(header=[raw], path=m.group(2) if m else raw.split()[-1])
            files.append(cur)
            hunk = None
            continue
        if cur is None:
            continue
        m = HUNK_RE.match(raw)
        if m:
            hunk = Hunk(old_start=int(m.group(1)), new_start=int(m.group(3)), suffix=m.group(5))
            cur.hunks.append(hunk)
            continue
        if hunk is None:
            cur.header.append(raw)
            if raw.startswith("+++ "):
                p = raw[4:].strip()
                if p != "/dev/null":
                    cur.path = p[2:] if p.startswith("b/") else p
            continue
        # A blank context line arrives as "" (no leading space) in some patches. Its tag stays "",
        # which `in " +"` and `in " -"` both accept, so it counts as context and renders back verbatim.
        tag = raw[:1]
        if tag not in " +-\\":
            continue  # tolerate stray lines between hunks
        hunk.lines.append((tag, raw[1:]))
    return files


def _hunk_header(h: Hunk) -> str:
    old_start = h.old_start if h.old_len else max(h.old_start, 0)
    return f"@@ -{old_start},{h.old_len} +{h.new_start},{h.new_len} @@{h.suffix}"


def renumber(files: list[FileDiff]) -> None:
    """Recompute each hunk's new_start after an earlier hunk in the same file changed length."""
    for f in files:
        shift = 0
        for h in f.hunks:
            if h.old_start == 0:  # a new file: one hunk, starting at line 1
                h.new_start = 1
            elif h.old_len == 0:  # a pure insertion goes after old_start
                h.new_start = h.old_start + 1 + shift
            else:
                h.new_start = h.old_start + shift
            shift += h.new_len - h.old_len


def render(files: list[FileDiff]) -> str:
    out: list[str] = []
    for f in files:
        out.extend(f.header)
        for h in f.hunks:
            out.append(_hunk_header(h))
            out.extend(tag + text for tag, text in h.lines)
    return "\n".join(out) + "\n"


def numbered(files: list[FileDiff]) -> str:
    """The diff as reviewers see it: each kept or added line carries its new-file line number."""
    out: list[str] = []
    for f in files:
        out.append(f"--- file: {f.path}")
        for h in f.hunks:
            out.append(_hunk_header(h))
            for (tag, text), n in zip(h.lines, h.new_numbers()):
                if tag == "\\":
                    continue
                num = f"{n:>5}" if n is not None else "     "
                out.append(f"{num} {tag} {text}")
    return "\n".join(out) + "\n"

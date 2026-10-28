"""The four defect classes the family-correlation manifest pre-registers, as operators on a patch.

Each operator finds candidate sites among a Python source file's added lines and returns a
Mutant: the mutated patch plus where the defect sits in the new file. Only added (`+`) lines are
touched, so the mutant still applies to the task's base commit.

  off_by_one       a comparison bound moved by one: < <-> <=, > <-> >=
  missed_branch    an added `elif`/`else` arm and its body removed
  wrong_default    a parameter default changed: True <-> False, an integer n -> n + 1
  swallowed_error  an added `raise ...` statement replaced with `pass`
"""

from __future__ import annotations

import copy
import io
import re
import tokenize
from dataclasses import dataclass

from patchlib import FileDiff, Hunk, renumber, render

CLASSES = ("off_by_one", "missed_branch", "wrong_default", "swallowed_error")
FLIP = {"<": "<=", "<=": "<", ">": ">=", ">=": ">"}
PARAM_DEFAULT_RE = re.compile(r"^(\s*\*{0,2}\w+\s*(?::\s*[^=]+?)?\s*=\s*)(True|False|-?\d+)(\s*,?\s*(?:#.*)?)$")
DEF_DEFAULT_RE = re.compile(r"(\w+\s*(?::\s*[^=,()]+?)?\s*=\s*)(True|False|-?\d+)(?=\s*[,)])")


@dataclass
class Site:
    cls: str
    file: int  # index into the patch's files
    hunk: int  # index into that file's hunks
    start: int  # first hunk line touched
    end: int  # last hunk line touched (== start for a one-line replacement)
    replacement: str | None  # the new text for a one-line operator; None removes lines start..end
    detail: str  # what changed, for the item list


@dataclass
class Mutant:
    site: Site
    patch: str
    path: str
    loc_start: int  # new-file line(s) of the defect in the mutated patch
    loc_end: int
    hunk_range: tuple[int, int]  # new-file lines the mutated hunk covers


def _tokens(text: str) -> list[tokenize.TokenInfo] | None:
    """Tokens of one source line, or None when the line is not a whole statement on its own."""
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(text.strip() + "\n").readline))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return None
    return toks


def _indent(text: str) -> int:
    return len(text) - len(text.lstrip(" \t"))


def _off_by_one(h: Hunk, i: int, text: str) -> list[tuple[str, str]]:
    toks = _tokens(text)
    if not toks:
        return []
    out = []
    lead = text[: _indent(text)]
    body = text.strip()
    for t in toks:
        if t.type == tokenize.OP and t.string in FLIP and t.start[0] == 1:
            col = t.start[1]
            new = body[:col] + FLIP[t.string] + body[col + len(t.string) :]
            out.append((lead + new, f"{t.string} -> {FLIP[t.string]}"))
    return out


def _wrong_default(h: Hunk, i: int, text: str) -> list[tuple[str, str]]:
    def bump(v: str) -> str:
        return {"True": "False", "False": "True"}.get(v) or str(int(v) + 1)

    out = []
    stripped = text.strip()
    if stripped.startswith(("def ", "async def ")):
        for m in DEF_DEFAULT_RE.finditer(text):
            new = text[: m.start(2)] + bump(m.group(2)) + text[m.end(2) :]
            out.append((new, f"default {m.group(2)} -> {bump(m.group(2))}"))
        return out
    m = PARAM_DEFAULT_RE.match(text)
    if m and _inside_open_def(h, i):
        new = m.group(1) + bump(m.group(2)) + m.group(3)
        out.append((new, f"default {m.group(2)} -> {bump(m.group(2))}"))
    return out


def _inside_open_def(h: Hunk, i: int) -> bool:
    """Whether line i sits inside a multi-line `def (` signature that opened on an earlier added line."""
    for j in range(i - 1, max(-1, i - 30), -1):
        tag, text = h.lines[j]
        if tag != "+":
            return False
        s = text.strip()
        if s.startswith(("def ", "async def ")):
            return "(" in s and not re.search(r"\)\s*(->.*)?:\s*$", s)
        if s.endswith(":") or s.startswith(")"):
            return False
    return False


def _swallowed_error(h: Hunk, i: int, text: str) -> list[tuple[str, str]]:
    s = text.strip()
    if not s.startswith("raise") or (len(s) > 5 and s[5] not in " ("):
        return []
    if _tokens(text) is None:  # a raise continued onto the next line
        return []
    return [(text[: _indent(text)] + "pass", f"{s[:60]} -> pass")]


def _branch_end(h: Hunk, i: int) -> int | None:
    """The last line of the added elif/else arm starting at i, or None when it is not removable whole."""
    indent = _indent(h.lines[i][1])
    end = i
    for j in range(i + 1, len(h.lines)):
        tag, text = h.lines[j]
        if not text.strip():
            if tag != "+":
                break
            continue
        if _indent(text) <= indent:
            break
        if tag != "+":
            return None  # the arm's body runs into context or removed lines
        end = j
    if end == i:
        return None
    # the arm must not run off the end of the hunk, or its body may continue unseen
    if end == len(h.lines) - 1:
        return None
    return end


def sites(files: list[FileDiff]) -> list[Site]:
    out: list[Site] = []
    for fi, f in enumerate(files):
        if not f.is_python_source:
            continue
        for hi, h in enumerate(f.hunks):
            for li, (tag, text) in enumerate(h.lines):
                if tag != "+" or not text.strip() or text.strip().startswith("#"):
                    continue
                for new, detail in _off_by_one(h, li, text):
                    out.append(Site("off_by_one", fi, hi, li, li, new, detail))
                for new, detail in _wrong_default(h, li, text):
                    out.append(Site("wrong_default", fi, hi, li, li, new, detail))
                for new, detail in _swallowed_error(h, li, text):
                    out.append(Site("swallowed_error", fi, hi, li, li, new, detail))
                s = text.strip()
                if (s.startswith("elif ") or s == "else:" or s.startswith("else:")) and s.endswith(":"):
                    end = _branch_end(h, li)
                    if end is not None:
                        out.append(Site("missed_branch", fi, hi, li, end, None, f"removed `{s[:60]}` arm"))
    return out


def apply(files: list[FileDiff], site: Site) -> Mutant:
    fs = copy.deepcopy(files)
    f = fs[site.file]
    h = f.hunks[site.hunk]
    if site.replacement is not None:
        h.lines[site.start] = ("+", site.replacement)
        removed = False
    else:
        del h.lines[site.start : site.end + 1]
        removed = True
    renumber(fs)
    nums = h.new_numbers()
    if removed:
        # the defect's location is the first new-file line after the removed arm
        after = next((n for n in nums[site.start :] if n is not None), None)
        loc = after if after is not None else h.new_range()[1] + 1
        loc_start = loc_end = loc
    else:
        loc_start = loc_end = nums[site.start]  # type: ignore[assignment]
    return Mutant(site, render(fs), f.path, loc_start, loc_end, h.new_range())

"""The defect classes the family-correlation manifest pre-registers, as operators on a patch.

Each operator finds candidate sites among a Python source file's added lines and returns a
Mutant: the mutated patch plus where the defect sits in the new file. Only added (`+`) lines are
touched, so the mutant still applies to the task's base commit.

  off_by_one       a comparison bound moved by one: < <-> <=, > <-> >=
  missed_branch    an added `elif`/`else` arm and its body removed
  wrong_default    a parameter default changed: True <-> False, an integer n -> n + 1
  swallowed_error  an added `raise ...` statement replaced with `pass`

Those four were the first set. The first pilot (2026-10-28) found reviewers caught them almost
every time, so the kill rule's one operator change replaced them with absence defects, which leave
no odd token behind:

  dropped_statement  an added one-line assignment or call removed
  dropped_clause     the last `and`/`or` clause of an added `if`/`elif`/`while` condition removed
  dropped_guard      an added `if ...:` whose body is one `raise`/`return` removed whole
  dropped_elif       an added `elif` arm and its body removed

`CLASSES` is the set in force; `FIRST_CLASSES` keeps the first for reproducing pilot 1.
"""

from __future__ import annotations

import copy
import io
import re
import tokenize
from dataclasses import dataclass

from patchlib import FileDiff, Hunk, renumber, render

FIRST_CLASSES = ("off_by_one", "missed_branch", "wrong_default", "swallowed_error")
CLASSES = ("dropped_statement", "dropped_clause", "dropped_guard", "dropped_elif")
NOT_A_PLAIN_STATEMENT = {
    "return", "raise", "pass", "break", "continue", "import", "from", "def", "class", "if", "elif",
    "else", "for", "while", "with", "try", "except", "finally", "assert", "global", "nonlocal",
    "del", "yield", "async", "await", "lambda", "match", "case",
}
CONTINUES_BLOCK = ("elif ", "else:", "except", "finally:")
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


def _has_sibling(h: Hunk, start: int, end: int) -> bool:
    """Whether the block holding lines start..end keeps another statement once they are removed."""
    indent = _indent(h.lines[start][1])
    for rng in (range(start - 1, -1, -1), range(end + 1, len(h.lines))):
        for j in rng:
            tag, text = h.lines[j]
            if tag == "-" or not text.strip() or text.strip().startswith("#"):
                continue
            ind = _indent(text)
            if ind < indent:
                break
            if ind == indent and not text.strip().startswith(CONTINUES_BLOCK):
                return True
            if ind == indent:
                break
    return False


def _plain_statement(h: Hunk, i: int, text: str) -> bool:
    """A whole one-line assignment or call: removing it leaves no syntax and no unbound name behind.

    An assignment to a bare name counts only when the name is already seen earlier in the hunk, so
    the removal does not leave a later use of a name that nothing binds.
    """
    s = text.strip()
    toks = _tokens(text)
    if not toks or s.endswith((":", "\\", ",")) or s.startswith(("@", "'", '"')):
        return False
    first = toks[0]
    if first.type != tokenize.NAME or first.string in NOT_A_PLAIN_STATEMENT:
        return False
    depth = 0
    for t in toks:
        if t.type == tokenize.OP:
            if t.string in "([{":
                depth += 1
            elif t.string in ")]}":
                depth -= 1
            elif depth == 0 and (t.string == "=" or (t.string.endswith("=") and t.string not in ("==", "<=", ">=", "!="))):
                target = s[: t.start[1]].strip()
                if re.fullmatch(r"\w+", target):
                    before = "\n".join(x for tag, x in h.lines[:i] if tag != "-")
                    return re.search(rf"\b{target}\b", before) is not None
                return not ("," in target and "[" not in target)  # no tuple unpacking
    return s.endswith(")")


def _dropped_clause(text: str) -> list[tuple[str, str]]:
    s = text.strip()
    if not s.startswith(("if ", "elif ", "while ")) or not s.endswith(":"):
        return []
    toks = _tokens(text)
    if not toks:
        return []
    depth, ops = 0, []
    for t in toks:
        if t.type == tokenize.OP and t.string in "([{":
            depth += 1
        elif t.type == tokenize.OP and t.string in ")]}":
            depth -= 1
        elif depth == 0 and t.type == tokenize.NAME and t.string in ("and", "or") and t.start[0] == 1:
            ops.append(t)
    if not ops or len({t.string for t in ops}) > 1:
        return []
    last = ops[-1]
    kept = s[: last.start[1]].rstrip()
    gone = s[last.start[1] : -1].strip()
    return [(text[: _indent(text)] + kept + ":", f"dropped `{gone[:60]}` from the condition")]


def _guard_end(h: Hunk, i: int) -> int | None:
    """The body line of an added `if ...:` whose body is one raise/return, or None."""
    s = h.lines[i][1].strip()
    if not s.startswith("if ") or not s.endswith(":") or _tokens(h.lines[i][1]) is None:
        return None
    if i + 1 >= len(h.lines) - 1:
        return None
    tag, body = h.lines[i + 1]
    b = body.strip()
    if tag != "+" or _indent(body) <= _indent(h.lines[i][1]) or not b.startswith(("raise", "return")):
        return None
    if _tokens(body) is None:
        return None
    for j in range(i + 2, len(h.lines)):
        t2, nxt = h.lines[j]
        if t2 == "-" or not nxt.strip():
            continue
        if _indent(nxt) > _indent(h.lines[i][1]):
            return None  # the body is longer than one line
        if nxt.strip().startswith(("elif ", "else:")):
            return None
        return i + 1
    return None


def sites(files: list[FileDiff], classes: tuple[str, ...] = CLASSES) -> list[Site]:
    """Candidate sites for `classes` (the set in force by default) among added Python lines."""
    return [s for s in _all_sites(files) if s.cls in classes]


def _all_sites(files: list[FileDiff]) -> list[Site]:
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
                        if s.startswith("elif "):
                            out.append(Site("dropped_elif", fi, hi, li, end, None, f"removed `{s[:60]}` arm"))
                if _plain_statement(h, li, text) and _has_sibling(h, li, li):
                    out.append(Site("dropped_statement", fi, hi, li, li, None, f"removed `{s[:60]}`"))
                for new, detail in _dropped_clause(text):
                    out.append(Site("dropped_clause", fi, hi, li, li, new, detail))
                end = _guard_end(h, li)
                if end is not None and _has_sibling(h, li, end):
                    out.append(Site("dropped_guard", fi, hi, li, end, None, f"removed guard `{s[:60]}`"))
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

"""What agents looked for when they read the board (lane 01M5N3SR7H, finding 022 follow-up).

Every `lane_board`, `team_status`, `lane_show` and plain `team_inbox_check` (no `wait`) call in the
musterd agents' streams, with where it sat and what the agent said just before it:

- `context`: `after_held_refusal` (a held-file refusal is among the last three results),
  `before_claim` (the agent has not opened or claimed a lane yet), `after_own_finish` (the agent
  already resolved, submitted or released its own lane), `after_wait` (the previous musterd call
  was a blocking wait), else `mid_work`.
- `next`: the agent's next action (edit, git, wait, message, claim, read, end).
- `said`: the last text the agent wrote before the call, cut to 200 characters.
- `intent`: a keyword label on `said` plus `context` (`intent()` below). The agent's last text can
  be a few calls stale, so read intent shares as rough.

    python3 boardreads.py /data/runs/logs claim-musterd-core claim-musterd-new > boardreads.json
    python3 boardreads.py --table boardreads.json   # the finding's table, from the file

No model calls: it only reads the streams on disk.
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

HELD_REFUSAL = re.compile(r"blocked: '[^']+' is held by ")
READS = {"lane_board", "team_status", "lane_show"}
OWN_END = {"lane_resolve", "lane_submit", "lane_release"}
CLAIMS = {"lane_open", "lane_claim"}
EDITS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}


def events(path: Path):
    for line in path.read_text(errors="replace").splitlines():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(ev, dict):
            continue
        for block in (ev.get("message") or {}).get("content") or []:
            if not isinstance(block, dict):
                continue
            t = block.get("type")
            if t == "text" and block.get("text"):
                yield "text", block["text"]
            elif t == "tool_use":
                yield "tool", (block.get("name") or "", block.get("input") or {})
            elif t == "tool_result":
                out = block.get("content")
                if isinstance(out, list):
                    out = " ".join(x.get("text", "") for x in out if isinstance(x, dict))
                yield "result", str(out or "")


def short(name: str) -> str:
    return name[len("mcp__musterd__"):] if name.startswith("mcp__musterd__") else name


def is_read(name: str, args: dict) -> bool:
    tool = short(name)
    if tool in READS:
        return True
    return tool == "team_inbox_check" and not args.get("wait") and not args.get("ids")


def next_action(evs: list, i: int) -> str:
    for kind, payload in evs[i + 1:]:
        if kind != "tool":
            continue
        name, args = payload
        tool = short(name)
        if name in EDITS:
            return "edit"
        if name == "Bash":
            cmd = args.get("command", "")
            return "git" if re.search(r"\bgit\b", cmd) else "bash"
        if tool == "team_inbox_check":
            return "wait" if args.get("wait") else "read"
        if tool in READS:
            return "read"
        if tool == "team_send":
            return "message"
        if tool in CLAIMS:
            return "claim"
        if tool in OWN_END:
            return "finish"
        if name.startswith("mcp__musterd__"):
            return tool
    return "end"


def scan(stream: Path) -> list[dict]:
    evs = list(events(stream))
    out = []
    claimed = finished = False
    last_musterd = None
    said = ""
    recent_results: list[str] = []
    for i, (kind, payload) in enumerate(evs):
        if kind == "text":
            said = payload
            continue
        if kind == "result":
            recent_results = (recent_results + [payload])[-3:]
            continue
        name, args = payload
        tool = short(name)
        if name.startswith("mcp__musterd__") and is_read(name, args):
            if any(HELD_REFUSAL.search(r) for r in recent_results):
                context = "after_held_refusal"
            elif not claimed:
                context = "before_claim"
            elif finished:
                context = "after_own_finish"
            elif last_musterd == "wait":
                context = "after_wait"
            else:
                context = "mid_work"
            out.append({
                "tool": tool if tool != "team_inbox_check" else "inbox_plain",
                "context": context,
                "next": next_action(evs, i),
                "said": " ".join(said.split())[:200],
            })
        if tool in CLAIMS:
            claimed = True
        if tool in OWN_END:
            finished = True
        if name.startswith("mcp__musterd__"):
            last_musterd = "wait" if tool == "team_inbox_check" and args.get("wait") else tool
    return out


INTENTS = [
    "start: orienting before it claimed a lane",
    "routine check-in at a task boundary",
    "held file: who holds it, is it free",
    "partner progress: is my partner done",
    "overlap warning: who else is on my file",
    "other, or the text does not say",
]


def intent(r: dict) -> str:
    """One label per read. Structural context first, then keywords on what the agent last wrote."""
    s = r["said"].lower()
    if r["context"] == "before_claim":
        return INTENTS[0]
    if r["context"] == "after_held_refusal" or re.search(r"blocked|holds it|lane is still claimed", s):
        return INTENTS[2]
    if re.search(r"overlap|also working|also modifying|same file", s):
        return INTENTS[4]
    if re.search(r"wait for|to complete|responded|completed their|their work|'s changes|released|finish", s):
        return INTENTS[3]
    if re.search(r"tests pass|commit|patch|final|works correctly|status update|submit|implementation works|clean up", s):
        return INTENTS[1]
    return INTENTS[5]


def table(path: Path) -> int:
    d = json.loads(path.read_text())
    runs = list(d["summary"])
    counts = {run: Counter(r["intent"] for r in d["calls"] if r["run"] == run) for run in runs}
    totals = {run: sum(counts[run].values()) for run in runs}
    print("| What the agent was after | " + " | ".join(f"{run} ({totals[run]})" for run in runs) + " |")
    print("| --- | " + " | ".join("---" for _ in runs) + " |")
    for label in INTENTS:
        print(f"| {label} | " + " | ".join(str(counts[run][label]) for run in runs) + " |")
    for run in runs:
        print(f"\n{run} by structural context: {d['summary'][run]['by_context']}")
    return 0


def main(argv: list[str]) -> int:
    if argv and argv[0] == "--table":
        return table(Path(argv[1]))
    logs, runs = Path(argv[0]), argv[1:]
    rows = []
    for run in runs:
        for stream in sorted((logs / run).rglob("agent*_stream.jsonl")):
            pair = str(stream.parent.relative_to(logs))
            for r in scan(stream):
                row = {"run": run, "pair": pair, "agent": stream.name.split("_")[0], **r}
                rows.append({**row, "intent": intent(row)})
    summary = {
        run: {
            "by_tool": dict(Counter(r["tool"] for r in rows if r["run"] == run)),
            "by_context": dict(Counter(r["context"] for r in rows if r["run"] == run)),
            "by_next": dict(Counter(r["next"] for r in rows if r["run"] == run)),
            "by_intent": dict(Counter(r["intent"] for r in rows if r["run"] == run)),
        }
        for run in runs
    }
    json.dump({"summary": summary, "calls": rows}, sys.stdout, indent=1)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

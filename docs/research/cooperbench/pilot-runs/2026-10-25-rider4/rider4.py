"""Rider 4 (riders.md; ADR 730 push acts beside ADR 724 acts), per musterd pair, from the copied
daemon database and the two agents' streams:

- `git_pushes`: every `git push` Bash call per agent (stream order), so a push the daemon never
  announced is visible as a count gap, not a guess.
- `push_acts`: ADR 730 directed acts (`meta.lane_pushed`) — to whom, when, body, and the receiving
  seat's next musterd move after the act landed in its stream (`receiver_next`).
- `lane_freed_acts`: ADR 724 acts (`meta.lane_freed`), count only (rider2.py reads them in full).
- `hand_pushed_sends`: the arm's `team_send` calls whose body sends.py labels pushed/fetch (its first
  KINDS regex, copied unchanged), per agent, with whether an ADR 730 act for that sender's branch had
  been recorded for that sender by then (`pushes_before`, `push_acts_so_far`).

    python3 rider4.py /data/runs/logs r4-musterd > rider4.json

No model calls: it only reads what is on disk.
"""

from __future__ import annotations

import glob
import json
import re
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / ".." / "2026-10-21-pilot3" / "cost"))
sys.path.insert(0, "/app/docs/research/cooperbench/pilot-runs/2026-10-21-pilot3/cost")
sys.path.insert(0, "/app/scripts/research/cooperbench")
LOGS = sys.argv[1]
from readout import classify_move, stream_events  # noqa: E402

PUSHED = re.compile(r"(?i)\bpush(ed)?\b|\bfetch\b|\bpull\b|branch .*(ready|up)|committed")  # sends.py KINDS[0]
GIT_PUSH = re.compile(r"\bgit\s+(?:-C\s+\S+\s+)*push\b")


def rows(con, sql):
    con.row_factory = sqlite3.Row
    return [dict(r) for r in con.execute(sql)]


def meta_of(m):
    try:
        return json.loads(m.get("meta") or "{}")
    except json.JSONDecodeError:
        return {}


def pair_dirs(arm: str):
    for f in sorted(glob.glob(f"{LOGS}/{arm}/**/result.json", recursive=True)):
        yield Path(f).parent


def find_db(pair: Path):
    hits = sorted(pair.rglob("*.db")) + sorted(pair.rglob("*.sqlite"))
    return hits[0] if hits else None


def next_move_after(pair: Path, seat: str, needle: str):
    stream = pair / f"{seat}_stream.jsonl"
    if not stream.exists():
        return None
    armed = False
    for kind, payload in stream_events(stream):
        if kind == "result" and needle in payload:
            armed = True
        elif armed and kind == "tool":
            name, args = payload
            move = classify_move(name, args)
            if move is None and name in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
                move = "edit"
            if move is not None:
                return move
        elif armed and kind == "bash":
            return "bash"
    return "nothing before the run ended" if armed else "act not seen in stream"


def git_pushes(pair: Path):
    out = {}
    for stream in sorted(pair.glob("agent*_stream.jsonl")):
        seat = stream.name.replace("_stream.jsonl", "")
        out[seat] = [cmd[:120] for kind, cmd in stream_events(stream) if kind == "bash" and GIT_PUSH.search(cmd)]
    return out


def hand_pushed_sends(pair: Path, push_acts_by_holder: dict):
    """Streams carry no clock, so a hand-sent pushed/fetch message is placed by stream order: how many of
    the sender's own `git push` calls came before it (`pushes_before`), and whether the daemon had an
    ADR 730 act on record for that sender by then (`push_acts_so_far`, by count — the act fires in the
    push's own PostToolUse hook, so it exists before the sender's next tool call)."""
    out = {}
    for stream in sorted(pair.glob("agent*_stream.jsonl")):
        seat = stream.name.replace("_stream.jsonl", "")
        sends = []
        pushes = 0
        acts = len(push_acts_by_holder.get(seat, []))
        for kind, payload in stream_events(stream):
            if kind == "bash" and GIT_PUSH.search(payload):
                pushes += 1
            elif kind == "tool" and payload[0].endswith("team_send"):
                body = payload[1].get("body", "") or ""
                if PUSHED.search(body):
                    sends.append({"body": body[:200], "pushes_before": pushes, "push_acts_so_far": min(acts, pushes)})
        out[seat] = sends
    return out


def pair_record(pair: Path):
    db = find_db(pair)
    rec = {"pair": str(pair.relative_to(LOGS)), "db": str(db.name) if db else None, "git_pushes": git_pushes(pair)}
    rec["git_push_count"] = sum(len(v) for v in rec["git_pushes"].values())
    if db is None:
        return rec
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    names = {r["id"]: r["name"] for r in rows(con, "SELECT id, name FROM members")}
    msgs = rows(con, "SELECT ts, from_member, to_member, act, body, meta FROM messages ORDER BY ts")
    con.close()

    push_acts = []
    by_sender: dict[str, list] = {}
    freed = 0
    for m in msgs:
        meta = meta_of(m)
        if "lane_freed" in meta:
            freed += 1
        lp = meta.get("lane_pushed")
        if not lp:
            continue
        to = names.get(m["to_member"], m["to_member"])
        holder = lp.get("holder")
        by_sender.setdefault(holder, []).append(m["ts"])
        push_acts.append(
            {
                "ts": m["ts"],
                "to": to,
                "holder": holder,
                "branch": lp.get("branch"),
                "head": (lp.get("head") or "")[:12],
                "body": (m.get("body") or "")[:200],
                "receiver_next": next_move_after(pair, to, "pushed"),
            }
        )
    rec["push_acts"] = push_acts
    rec["push_act_count"] = len(push_acts)
    rec["lane_freed_act_count"] = freed
    rec["hand_pushed_sends"] = hand_pushed_sends(pair, by_sender)
    rec["hand_pushed_count"] = sum(len(v) for v in rec["hand_pushed_sends"].values())
    rec["hand_pushed_after_own_push"] = sum(1 for v in rec["hand_pushed_sends"].values() for s in v if s["pushes_before"] > 0)
    return rec


def main():
    out = {}
    for arm in sys.argv[2:]:
        pairs = [pair_record(p) for p in pair_dirs(arm)]
        out[arm] = {
            "pairs": pairs,
            "totals": {
                "git_pushes": sum(p.get("git_push_count", 0) for p in pairs),
                "push_acts": sum(p.get("push_act_count", 0) for p in pairs),
                "lane_freed_acts": sum(p.get("lane_freed_act_count", 0) for p in pairs),
                "hand_pushed_sends": sum(p.get("hand_pushed_count", 0) for p in pairs),
                "hand_pushed_after_own_push": sum(p.get("hand_pushed_after_own_push", 0) for p in pairs),
            },
        }
    json.dump(out, sys.stdout, indent=1, default=str)
    print()


if __name__ == "__main__":
    main()

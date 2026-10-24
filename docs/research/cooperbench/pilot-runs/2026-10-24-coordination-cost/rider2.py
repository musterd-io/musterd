"""Rider 2 (riders.md, ADR 724): in the musterd pairs with at least one held-file refusal, the
holder's state-signal sends per pair, and the time from the holder's lane freeing the file to the
refused seat's next edit of it.

Per pair, from the copied daemon database and the two agents' streams:

- `refusals`: every `lane.gate` deny with `hold = held` — the refused seat, the holder, and the gate
  fingerprint (the hashed class+path the hook sends; the same file gives the same fingerprint).
- `holder_signals`: for each holder seat, its `team_send` calls that finding 019's `is_signal`
  labels (`pilot-runs/2026-10-21-pilot3/cost/cf.py`, unchanged), from the holder's own stream.
- `freed_to_edit_s`: for each refusal, the holder's lane leaving its hands (`lane.state_changed` to a
  state other than claimed/active/blocked, `lane.released`, or an ADR 693 takeover of the holder's
  lane after it left — `holder_freed_how` says which), then the
  refused seat's first `lane.gate` allow with the same fingerprint. Null when the lane never freed
  the file before the run ended, or the refused seat never edited it after.
- `lane_freed_acts`: ADR 724 directed acts (`meta.lane_freed`) in the daemon's messages, with the
  receiving seat's next musterd move after it, from its stream.

    python3 rider2.py /data/runs/logs claim-musterd-core cc-musterd > rider2.json

No model calls: it only reads what is on disk.
"""

from __future__ import annotations

import glob
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / ".." / "2026-10-21-pilot3" / "cost"))
sys.path.insert(0, "/app/docs/research/cooperbench/pilot-runs/2026-10-21-pilot3/cost")
sys.path.insert(0, "/app/scripts/research/cooperbench")
LOGS = sys.argv[1]
os.environ["LOGS"] = LOGS
import cf  # noqa: E402
from calls import calls  # noqa: E402
from readout import classify_move, stream_events  # noqa: E402

CONTENDING = {"claimed", "active", "blocked"}
HELD_ACT_TAG = "lane_freed"


def rows(con, sql):
    con.row_factory = sqlite3.Row
    return [dict(r) for r in con.execute(sql)]


def detail(r):
    try:
        return json.loads(r.get("detail") or "{}")
    except json.JSONDecodeError:
        return {}


def pair_dirs(arm: str):
    for f in sorted(glob.glob(f"{LOGS}/{arm}/**/result.json", recursive=True)):
        yield Path(f).parent


def find_db(pair: Path):
    hits = sorted(pair.rglob("*.db")) + sorted(pair.rglob("*.sqlite"))
    return hits[0] if hits else None


def holder_signals(pair: Path, seat: str):
    stream = pair / f"{seat}_stream.jsonl"
    if not stream.exists():
        return None
    cs, _ = calls(str(stream))
    sig = []
    for c in cs:
        if cf.is_signal(c):
            body = " ".join(t["input"].get("body", "") for t in c["tools"] if t["name"].endswith("team_send"))
            sig.append(body[:160])
    return sig


def next_move_after(pair: Path, seat: str, needle: str):
    """The seat's first musterd move (or edit/bash) after a tool result containing `needle`."""
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


def pair_record(pair: Path):
    db = find_db(pair)
    rec = {"pair": str(pair.relative_to(LOGS)), "db": str(db.name) if db else None}
    if db is None:
        return rec
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    names = {r["id"]: r["name"] for r in rows(con, "SELECT id, name FROM members")}
    lanes = {r["id"]: r for r in rows(con, "SELECT id, title, owner_seat, state, surface_globs FROM lanes")}
    audit = rows(con, "SELECT ts, actor, action, result, detail FROM audit ORDER BY ts")
    msgs = rows(con, "SELECT ts, from_member, to_member, act, body, meta FROM messages ORDER BY ts")
    con.close()

    gate = [dict(a, d=detail(a)) for a in audit if a["action"] == "lane.gate"]
    refusals = []
    for g in gate:
        if g["result"] != "deny" or g["d"].get("hold") != "held":
            continue
        refusals.append({"ts": g["ts"], "seat": g["actor"], "holder": g["d"].get("holder"), "fp": g["d"].get("fingerprint")})
    rec["refusals"] = len(refusals)
    if not refusals:
        return rec

    # when each holder's lane(s) left a contending state
    freed_at = {}
    freed_how = {}
    for a in audit:
        d = detail(a)
        if a["action"] == "lane.state_changed" and d.get("to") not in CONTENDING:
            lane = lanes.get(d.get("lane"))
            if lane:
                freed_at.setdefault(lane["owner_seat"], a["ts"])
                freed_how.setdefault(lane["owner_seat"], "lane.state_changed:" + str(d.get("to")))
        if a["action"] == "lane.released":
            lane = lanes.get(d.get("lane"))
            owner = (lane or {}).get("owner_seat") or a["actor"]
            freed_at.setdefault(owner, a["ts"])
            freed_how.setdefault(owner, "lane.released")
        # ADR 693: the holder left and its lane was taken over (handoff / takeover) — the file left
        # the holder's hands here, with no ADR 724 act (the lane stays contending under a new owner).
        if a["action"] == "lane.claimed" and d.get("previous_owner") and d.get("owner") != d.get("previous_owner"):
            freed_at.setdefault(d["previous_owner"], a["ts"])
            freed_how.setdefault(d["previous_owner"], f"taken over by {d.get('owner')} ({d.get('kind')})")

    # ADR 724's act is sent within a sweep (2 s) of the lane freeing the file, and names how; where
    # the audit rows above did not show the free (a `lane_resolve` close, a scope narrowing), the
    # act's time stands for it.
    for m in msgs:
        try:
            meta = json.loads(m.get("meta") or "{}")
        except json.JSONDecodeError:
            meta = {}
        if HELD_ACT_TAG not in meta:
            continue
        hit = re.match(r"\[lane\] (\S+?)'s lane \".*\" is ([a-z ]+?):", m.get("body") or "")
        if hit:
            freed_at.setdefault(hit.group(1), m["ts"])
            freed_how.setdefault(hit.group(1), "act: " + hit.group(2))

    out = []
    seen = set()
    for r in refusals:
        key = (r["seat"], r["holder"], r["fp"])
        if key in seen:
            continue
        seen.add(key)
        freed = freed_at.get(r["holder"])
        nxt_edit = None
        if freed is not None:
            for g in gate:
                if g["actor"] == r["seat"] and g["result"] == "allow" and g["d"].get("fingerprint") == r["fp"] and g["ts"] >= freed:
                    nxt_edit = g["ts"]
                    break
        out.append(
            {
                "refused": r["seat"],
                "holder": r["holder"],
                "refused_at": r["ts"],
                "holder_freed_at": freed,
                "holder_freed_how": freed_how.get(r["holder"]),
                "refused_next_edit_at": nxt_edit,
                "freed_to_edit_s": round((nxt_edit - freed) / 1000, 1) if (freed is not None and nxt_edit is not None) else None,
            }
        )
    rec["pairs_refused_holder"] = out
    rec["holder_signals"] = {h: holder_signals(pair, h) for h in sorted({r["holder"] for r in refusals if r["holder"]})}
    rec["holder_signal_count"] = sum(len(v or []) for v in rec["holder_signals"].values())

    freed_acts = []
    for m in msgs:
        try:
            meta = json.loads(m.get("meta") or "{}")
        except json.JSONDecodeError:
            meta = {}
        if HELD_ACT_TAG in meta:
            to = names.get(m["to_member"], m["to_member"])
            freed_acts.append({"ts": m["ts"], "to": to, "body": (m.get("body") or "")[:200], "receiver_next": next_move_after(pair, to, "is free")})
    rec["lane_freed_acts"] = freed_acts
    return rec


def main():
    out = {}
    for arm in sys.argv[2:]:
        recs = [pair_record(p) for p in pair_dirs(arm)]
        with_ref = [r for r in recs if r.get("refusals")]
        out[arm] = {
            "pairs": len(recs),
            "pairs_with_held_refusal": len(with_ref),
            "holder_signals_total": sum(r.get("holder_signal_count", 0) for r in with_ref),
            "holder_signals_per_pair": [r.get("holder_signal_count", 0) for r in with_ref],
            "freed_to_edit_s": [x["freed_to_edit_s"] for r in with_ref for x in r.get("pairs_refused_holder", [])],
            "lane_freed_acts": sum(len(r.get("lane_freed_acts", [])) for r in with_ref),
            "records": with_ref,
        }
    json.dump(out, sys.stdout, indent=1)


if __name__ == "__main__":
    main()

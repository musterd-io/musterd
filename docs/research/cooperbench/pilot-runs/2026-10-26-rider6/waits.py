"""Beside the rules (rider 6, R6b): each team_inbox_check wait call in the agents' streams — what it
returned (a push act, another act, nothing) and whether a push act to that seat was already recorded
before the call. Reads agent*_stream.jsonl and the pair's daemon log. One-off read; no model calls."""
import json, sys, re
from pathlib import Path
L = Path(sys.argv[1]) / sys.argv[2]
tot = {"wait_calls": 0, "returned_push_act": 0, "returned_other_act": 0, "returned_nothing": 0, "push_act_already_waiting": 0, "wait_seconds": []}
pairs = {}
for pair in sorted(p for p in L.rglob("eval.json")):
    d = pair.parent
    fired = []
    for dl in d.glob("*daemon.log"):
        for line in dl.read_text(errors="replace").splitlines():
            if '"lane_push_fired"' in line:
                try:
                    o = json.loads(line); fired.append((o["ts"], o["seat"]))
                except Exception: pass
    rec = {"wait_calls": 0, "returned_push_act": 0, "returned_other_act": 0, "returned_nothing": 0, "push_act_already_waiting": 0}
    for stream in sorted(d.glob("agent*_stream.jsonl")):
        seat = stream.name.replace("_stream.jsonl", "")
        pending = {}  # tool_use id -> (ts, wait)
        lines = stream.read_text(errors="replace").splitlines()
        for ln in lines:
            try: o = json.loads(ln)
            except Exception: continue
            msg = o.get("message") or {}
            content = msg.get("content") or []
            if not isinstance(content, list): continue
            ts = o.get("timestamp")
            for c in content:
                if not isinstance(c, dict): continue
                if c.get("type") == "tool_use" and str(c.get("name","")).endswith("team_inbox_check") and (c.get("input") or {}).get("wait"):
                    pending[c["id"]] = (ts, c["input"]["wait"])
                if c.get("type") == "tool_result" and c.get("tool_use_id") in pending:
                    t0, w = pending.pop(c["tool_use_id"])
                    text = json.dumps(c.get("content"))
                    rec["wait_calls"] += 1; tot["wait_calls"] += 1; tot["wait_seconds"].append(w)
                    if "pushed \\\\\"" in text or 'pushed \\"' in text or "lane_pushed" in text:
                        rec["returned_push_act"] += 1; tot["returned_push_act"] += 1
                    elif '"messages":[]' in text.replace(" ", "") or '\\"messages\\":[]' in text.replace(" ", ""):
                        rec["returned_nothing"] += 1; tot["returned_nothing"] += 1
                    else:
                        rec["returned_other_act"] += 1; tot["returned_other_act"] += 1
                    # was a push act to this seat already fired before the call?
                    try:
                        import datetime
                        tms = int(datetime.datetime.fromisoformat(t0.replace("Z","+00:00")).timestamp()*1000) if t0 else None
                    except Exception:
                        tms = None
                    if tms and any(s == seat and f <= tms for f, s in fired):
                        rec["push_act_already_waiting"] += 1; tot["push_act_already_waiting"] += 1
    pairs[str(d.relative_to(L))] = rec
ws = tot.pop("wait_seconds")
tot["wait_seconds_median"] = sorted(ws)[len(ws)//2] if ws else None
tot["wait_seconds_hist"] = {str(k): ws.count(k) for k in sorted(set(ws))}
print(json.dumps({"totals": tot, "pairs": pairs}, indent=1))

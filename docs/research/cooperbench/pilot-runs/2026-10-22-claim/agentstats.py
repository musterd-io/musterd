import json, glob, collections, sys
out = {}
for f in sorted(glob.glob("/data/runs/logs/claim-*/**/*stream.jsonl", recursive=True)):
    ev = []
    for l in open(f):
        l = l.strip()
        if l.startswith("{"):
            try: ev.append(json.loads(l))
            except Exception: pass
    first = next((e for e in ev if e.get("type") == "assistant"), {})
    u = first.get("message", {}).get("usage", {})
    c = collections.Counter()
    for e in ev:
        if e.get("type") != "assistant": continue
        for x in e["message"].get("content", []):
            if x.get("type") != "tool_use": continue
            n, i = x["name"], x.get("input", {})
            if n == "mcp__musterd__team_inbox_check": c["inbox_wait" if i.get("wait") else "inbox_plain"] += 1
            elif n in ("mcp__musterd__lane_board", "mcp__musterd__team_status"): c["board_status"] += 1
            elif n == "mcp__musterd__team_send": c["send"] += 1
            elif n == "ToolSearch": c["toolsearch"] += 1
            elif n == "Bash" and "sleep" in i.get("command", ""): c["bash_sleep"] += 1
    res = [e for e in ev if e.get("type") == "result"]
    out[f.replace("/data/runs/logs/", "")] = {"first_ctx": sum(u.get(k) or 0 for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")), "calls": dict(c), "cost": res[-1].get("total_cost_usd") if res else None, "turns": res[-1].get("num_turns") if res else None}
st = {}
for f in glob.glob("/data/runs/logs/claim-solo-*/**/result.json", recursive=True):
    r = json.load(open(f)); st[f.split("solo/")[-1]] = (r.get("agent") or {}).get("status") or r.get("status")
json.dump({"agents": out, "solo_status": st}, open(sys.argv[1], "w"), indent=1)

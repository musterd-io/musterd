#!/usr/bin/env python3
"""Cost-fix stage 1 gates G1–G4 (costfix-manifest.md), read from the lean and baseline core runs.

usage: gates.py <logs> <lean run> <baseline run>
"""
import glob, json, os, re, sys

LEAN_GONE = ["team_join", "team_status", "team_next", "lane_claim", "team_memory_read", "team_memory_save"]
PARTNER_INTEGRATE = re.compile(r"\bgit\s+(fetch|merge|pull)\b")


def sessions(run):
    return sorted(glob.glob(os.path.join(LOGS, run, "**", "*_stream.jsonl"), recursive=True))


def first_tool(path):
    for line in open(path):
        d = json.loads(line)
        if d.get("type") == "assistant":
            for b in d["message"].get("content") or []:
                if b.get("type") == "tool_use":
                    return b["name"]
    return None


def init_tools(path):
    for line in open(path):
        d = json.loads(line)
        if d.get("type") == "system" and d.get("subtype") == "init":
            return d.get("tools") or []
    return []


def integrates(path):
    for line in open(path):
        d = json.loads(line)
        if d.get("type") == "assistant":
            for b in d["message"].get("content") or []:
                if b.get("type") == "tool_use" and b["name"] == "Bash" and PARTNER_INTEGRATE.search(str((b.get("input") or {}).get("command", ""))):
                    return True
    return False


def evals(run):
    out = {}
    for f in glob.glob(os.path.join(LOGS, run, "**", "eval.json"), recursive=True):
        e = json.load(open(f))
        out[os.path.dirname(f).split(run + "/", 1)[1]] = (bool(e.get("both_passed")), (e.get("merge") or {}).get("status"))
    return out


LOGS, LEAN, BASE = sys.argv[1:4]
ls = sessions(LEAN)
g1 = sum(1 for p in ls if (first_tool(p) or "").endswith("team_inbox_check"))
pairs = {}
for p in ls:
    pairs.setdefault(os.path.dirname(p), []).append(integrates(p))
g2 = sum(1 for v in pairs.values() if sum(v) <= 1)
leaked = sorted({t for p in ls for t in init_tools(p) if any(t == "mcp__musterd__" + g for g in LEAN_GONE)})
el, eb = evals(LEAN), evals(BASE)
lp, bp = sum(v[0] for v in el.values()), sum(v[0] for v in eb.values())
lconf = sum(1 for v in el.values() if v[1] == "conflicts")
res = {
    "G1_first_call_inbox": [g1, len(ls), g1 <= 2],
    "G2_one_integrator_pairs": [g2, len(pairs), g2 >= 7],
    "G3_leaked_tools": [leaked, not leaked],
    "G4_passes_lean_base_conflicts": [lp, bp, lconf, lp >= bp - 2 and lconf <= 2],
}
res["all_pass"] = all(v[-1] for v in res.values())
print(json.dumps(res))

#!/usr/bin/env bash
# Pilot 3 step 4: one musterd smoke pair; passes only if both agents fetched from the shared remote.
set -uo pipefail
cd /data/runs
cooperbench run -n p3-smoke-musterd -r pallets_click_task -t 2068 -f 1,2 -m claude-sonnet-4-5 -a claude_code_musterd --setting coop --git --no-auto-eval > /data/runs/p3-smoke.log 2>&1
cooperbench eval -n p3-smoke-musterd --backend docker >> /data/runs/p3-smoke.log 2>&1
python3 - <<'PY'
import glob, json, re, sys
d = glob.glob("/data/runs/logs/p3-smoke-musterd/*/pallets_click_task/2068/*")[0]
r = json.load(open(f"{d}/result.json")); e = json.load(open(f"{d}/eval.json"))
ok = True
for ag in ("agent1", "agent2"):
    t = open(f"{d}/{ag}_stream.jsonl", errors="replace").read()
    fails = t.count("unable to look up")
    fetched = len(re.findall(r'"command": "[^"]*git fetch team', t))
    print(ag, r["agents"][ag]["status"], "lookup_failures", fails, "fetch_calls", fetched)
    ok &= r["agents"][ag]["status"] == "Submitted" and fails == 0 and fetched > 0
print("cost", round(r["total_cost"], 2), "merge", e["merge"]["status"], "passed", e["both_passed"], "error", e.get("error"))
ok &= e.get("error") is None
print("SMOKE PASS" if ok else "SMOKE FAIL")
PY

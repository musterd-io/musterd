#!/usr/bin/env bash
# Pilot 2 error re-runs (manifest step 6): the 11 pairs whose agents hit the API account's usage
# limit at ~19:57Z are re-run once, under new run names so the first run's logs stay as recorded.
# Stop: $35 of re-run spend (nick, 2026-10-21: "we are burning through cash").
set -uo pipefail
cd /data/runs
D=/data/runs/pilot2-2026-10-21
CAP=35
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$D/pilot2.log"; }
pair() {  # run agent setting repo task features
  cooperbench run -n "$1" -m claude-sonnet-4-5 -a "$2" --setting "$3" --git -r "$4" -t "$5" -f "$6" --no-auto-eval >> "$D/$1.run.log" 2>&1
  log "$1 $4/$5 exit=$?"
}
export -f pair log; export D
log "rerun start"
printf '%s\n' \
  "p2r-musterd claude_code_musterd coop llama_index_task 17244 5,6" \
  "p2r-musterd claude_code_musterd coop openai_tiktoken_task 0 4,8" \
  "p2r-musterd claude_code_musterd coop pallets_click_task 2800 1,4" \
  "p2r-musterd claude_code_musterd coop pallets_jinja_task 1559 5,8" \
  "p2r-musterd claude_code_musterd coop pallets_jinja_task 1621 6,10" \
  "p2r-musterd claude_code_musterd coop react_hook_form_task 153 2,6" \
  "p2r-musterd claude_code_musterd coop typst_task 6554 2,6" \
  "p2r-team claude_code team pallets_jinja_task 1559 5,8" \
  "p2r-team claude_code team pallets_jinja_task 1621 6,10" \
  "p2r-team claude_code team react_hook_form_task 153 2,6" \
  "p2r-team claude_code team typst_task 6554 2,6" \
  | xargs -P 6 -L 1 bash -c 'pair "$@"' _ &
XP=$!
spent() { python3 -c "
import json,glob
print(f'{sum(float(json.load(open(f)).get(\"total_cost\") or 0) for f in glob.glob(\"/data/runs/logs/p2r-*/**/result.json\",recursive=True)):.2f}')"; }
while kill -0 $XP 2>/dev/null; do
  s=$(spent); echo "$(date -u +%FT%TZ) rerun_spent=$s" > "$D/spend-rerun.txt"
  if python3 -c "import sys; sys.exit(0 if float('$s') >= $CAP else 1)"; then
    log "HARD STOP rerun: \$$s reached \$$CAP"; pkill -f "cooperbench run"; break
  fi
  sleep 30
done
wait
for r in p2r-musterd p2r-team; do cooperbench eval -n "$r" --backend docker > "$D/$r.eval.log" 2>&1; log "$r eval exit=$?"; done
log "rerun_spent=$(spent) rerun done"
touch "$D/rerun.done"

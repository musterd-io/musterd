#!/usr/bin/env bash
source /etc/profile.d/cooperbench.sh
unset MUSTERD_ARM_LANE
D=/data/runs/flash-2026-11-06; cd /data/runs
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$D/flash2.log"; }
log "re-run once (arm error: git-server container race, 404 on cooperbench-git at start): outlines 1655 f7,f10 as flash2r-musterd"
cooperbench run -n flash2r-musterd -r dottxt_ai_outlines_task -t 1655 -f 7,10 -m claude-opus-5-5 -a claude_code_musterd --setting coop --git --no-auto-eval > "$D/flash2r-musterd.run.log" 2>&1
log "flash2r-musterd run exit=$?"
while pgrep -f "[c]ooperbench eval -n flash2-" > /dev/null; do sleep 20; done
cooperbench eval -n flash2r-musterd --backend docker > "$D/flash2r-musterd.eval.log" 2>&1
log "flash2r-musterd eval exit=$?"
touch "$D/rerun.done"

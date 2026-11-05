#!/usr/bin/env bash
# Rider 7 re-run, error re-run once (manifest: an MCP startup failure is an error, re-run once under a new name).
set -uo pipefail
source /etc/profile.d/cooperbench.sh
D=/data/runs/r7b-2026-11-05; cd /data/runs
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$D/rerun.log"; }
export MUSTERD_ARM_LANE=act
log "re-run react_hook_form_task/153 f2,f6 as r7b-rerun-rhf (evaluator error: Failed to write patch2.patch)"
cooperbench run -n r7b-rerun-rhf -r react_hook_form_task -t 153 -f 2,6 -m claude-sonnet-4-5 -a claude_code_musterd --setting coop --git --no-auto-eval > "$D/r7b-rerun-rhf.run.log" 2>&1
log "run exit=$?"
cooperbench eval -n r7b-rerun-rhf --backend docker > "$D/r7b-rerun-rhf.eval.log" 2>&1
log "eval exit=$?"
touch "$D/rerun-rhf.done"

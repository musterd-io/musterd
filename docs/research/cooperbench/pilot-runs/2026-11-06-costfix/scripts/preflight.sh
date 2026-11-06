#!/usr/bin/env bash
# Cost-fix pre-flight (costfix-manifest.md, procedure 2): post-deploy setup and the API check.
set -uo pipefail
source /etc/profile.d/cooperbench.sh
D=/data/runs/costfix-2026-11-06; mkdir -p "$D"; cd /data/runs
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$D/preflight.log"; }
id smoke >/dev/null 2>&1 || useradd -m smoke
mkdir -p /opt/cooperbench/src/cooperbench/agents/swe_agent/trajectories && chmod 1777 /opt/cooperbench/src/cooperbench/agents/swe_agent/trajectories
ln -sfn /opt/cooperbench/dataset /data/runs/dataset
log "musterd $(musterd --version 2>&1 | head -1) · MUSTERD_REF=$MUSTERD_REF · claude $(claude --version 2>&1 | head -1) · df $(df -h /data | awk 'NR==2{print $4}') free"
out=$(runuser -u smoke -- env HOME=/home/smoke ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" claude -p 'reply with the single word ok' --model claude-opus-5-5 2>&1 | tail -1)
log "api check: $out"
cd /app/scripts/research/cooperbench && python3 -m pytest -q tests/test_prompt.py tests/test_config.py 2>&1 | tail -2 | while read -r l; do log "arm tests: $l"; done
log "preflight done"

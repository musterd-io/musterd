#!/usr/bin/env bash
# Rider 7 pre-flight on musterd-cooperbench (rider7-manifest.md steps 1–3): post-deploy setup,
# API check, the two host smokes as the unprivileged `smoke` user. Logs to $D/preflight.log.
set -uo pipefail
source /etc/profile.d/cooperbench.sh
D=/data/runs/flash-2026-11-06; mkdir -p "$D"; cd /data/runs
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$D/preflight.log"; }
id smoke >/dev/null 2>&1 || useradd -m smoke
mkdir -p /opt/cooperbench/src/cooperbench/agents/swe_agent/trajectories && chmod 1777 /opt/cooperbench/src/cooperbench/agents/swe_agent/trajectories
ln -sfn /opt/cooperbench/dataset /data/runs/dataset
log "musterd $(musterd --version 2>&1 | head -1) · MUSTERD_REF=$MUSTERD_REF · claude $(claude --version 2>&1 | head -1)"
out=$(runuser -u smoke -- env HOME=/home/smoke ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" claude -p 'reply with the single word ok' --model claude-opus-5-5 2>&1 | tail -1)
log "api check: $out"
log "gate_smoke start"
runuser -u smoke -- env HOME=/home/smoke ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" PATH="$PATH" PYTHONPATH="$PYTHONPATH" PREFIX=/opt/musterd-seat \
  python3 /app/scripts/research/cooperbench/gate_smoke.py > "$D/gate_smoke.out" 2>&1
log "gate_smoke $(tail -1 "$D/gate_smoke.out")"
log "hold_smoke_697 start"
runuser -u smoke -- env HOME=/home/smoke ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" PATH="$PATH" PYTHONPATH="$PYTHONPATH" PREFIX=/opt/musterd-seat \
  python3 /app/docs/research/cooperbench/pilot-runs/2026-10-21-pilot3/hold_smoke_697.py > "$D/hold_smoke_697.out" 2>&1
log "hold_smoke_697 $(tail -1 "$D/hold_smoke_697.out")"
log "preflight done"

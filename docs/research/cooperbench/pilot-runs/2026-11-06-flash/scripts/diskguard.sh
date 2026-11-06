#!/usr/bin/env bash
D=/data/runs/flash-2026-11-06
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$D/flash2.log"; }
log "disk guard (standalone) armed at 4 GB free"
while sleep 30; do
  [ -f "$D/all2.done" ] && exit 0
  avail=$(df -BG --output=avail /data | tail -1 | tr -dc 0-9)
  if [ "${avail:-99}" -lt 4 ]; then log "DISK-STOP: /data ${avail}G free"; pkill -f "[r]un_arms.py"; pkill -f "[c]ooperbench run -n flash2-"; sleep 5; docker ps -q --filter name=minisweagent | xargs -r docker rm -f; exit 0; fi
done

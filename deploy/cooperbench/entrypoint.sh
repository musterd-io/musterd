#!/bin/bash
# Boot the CooperBench run machine: dockerd (images on the volume), Redis for the coop arm, then
# wait. Runs are started by hand over `fly ssh console` (README), and the machine is stopped when
# they finish, so only the volume costs money between runs.
set -euo pipefail

mkdir -p /data/docker /data/runs
dockerd --data-root /data/docker >/data/dockerd.log 2>&1 &
for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null 2>&1 || { echo "dockerd never came up"; tail -40 /data/dockerd.log; exit 1; }

redis-server --daemonize yes --bind 127.0.0.1 --port 6379 >/dev/null
echo "cooperbench machine ready: docker $(docker version -f '{{.Server.Version}}'), musterd ${MUSTERD_REF:-unknown}"
exec sleep infinity

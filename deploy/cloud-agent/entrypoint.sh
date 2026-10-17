#!/bin/bash
# Cloud agent entrypoint (ADR 647 phase 1): no root phase, no daemon, no tailnet. The machine
# is a remote actuator against the hosted team's server (design §4.1b): `musterd host
# --cloud-provision` claims the pending provision for this host label, stands the seat up in
# its workspace on the volume (ADR 648), and then polls that server for the seat's wakes.
#
# Non-secret env (fly.toml): MUSTERD_SERVER, MUSTERD_TEAM, MUSTERD_HOST (this machine's host
# label), REPO_URL (the seat workspace's clone source).
# Secrets (`fly secrets set`, never in the image or repo):
#   MUSTERD_HOST_KEY    the sponsor-scoped host key (ADR 648) — the only musterd credential here
#   ANTHROPIC_API_KEY   the sponsor's model key (BYOK, ADR 647) — the resident engine reads it
#                       at spawn; or the variable named by MUSTERD_KEY_ENV
#   GH_TOKEN            a fine-grained token for the workspace repo (clone, push, PRs)
# Refused: MUSTERD_AGENT_KEY (a team's daemon-private key has no business on this machine) and
# any sponsor credential — the sponsor's binding must never live here (ADR 648).
set -euo pipefail

: "${MUSTERD_SERVER:?}" "${MUSTERD_TEAM:?}" "${MUSTERD_HOST:?}"
HOME="${HOME:-/data/home}"
export HOME
mkdir -p "$HOME" /data/log /data/work
LOG=/data/log/host.log

log() { printf '%s cloud-agent: %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG"; }

if [ -n "${MUSTERD_AGENT_KEY:-}" ]; then
  log "REFUSING TO BOOT: MUSTERD_AGENT_KEY is set — the team agent key is daemon-private and must not be on this machine. Fix: fly secrets unset MUSTERD_AGENT_KEY"
  exit 1
fi
: "${MUSTERD_HOST_KEY:?MUSTERD_HOST_KEY (the sponsor-scoped host key) must be staged as a Fly secret}"

# The workspace clone source: the provisioner clones (or worktrees) the seat's workspace from
# this checkout. First boot only; the clone lives on the volume after that.
cd /data/work
if [ ! -d repo/.git ]; then
  : "${REPO_URL:?REPO_URL (the workspace repo) must be set for the first boot}"
  log "cloning workspace repo"
  git clone --quiet "$REPO_URL" repo
fi
cd repo

# The model key's variable NAME is recorded in the registry at provisioning (ADR 588); its
# value is this process's env, inherited by the host loop and read at spawn — never written
# to a file by anything here.
export MUSTERD_KEY_ENV="${MUSTERD_KEY_ENV:-ANTHROPIC_API_KEY}"

log "host starting: server $MUSTERD_SERVER team $MUSTERD_TEAM host $MUSTERD_HOST"
exec musterd host --cloud-provision \
  --server "$MUSTERD_SERVER" --team "$MUSTERD_TEAM" --host "$MUSTERD_HOST" \
  --key-env "$MUSTERD_KEY_ENV" >>"$LOG" 2>&1

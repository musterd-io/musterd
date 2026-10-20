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
#   GH_TOKEN            a fine-grained token for the workspace repo (clone, push, PRs). ADR 675:
#                       it never enters the jail — gh keeps it under $HOME/.config/gh (0600,
#                       outside every workspace), git reaches it through gh's credential
#                       helper, and the variable is dropped before the host starts.
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

# ADR 675: sign gh in from GH_TOKEN and hand git the same credential, then drop the variable.
# The jail's readers cannot leave the workspace and `gh auth` / `git credential` are not on its
# allowlist, so the seat's git and gh can push and open PRs without the shell ever seeing the
# token. gh refuses `auth login` while GH_TOKEN is exported, so it is moved to a local first.
if [ -n "${GH_TOKEN:-}" ]; then
  gh_token="$GH_TOKEN"
  unset GH_TOKEN
  if printf '%s' "$gh_token" | gh auth login --with-token --hostname github.com >>"$LOG" 2>&1 \
    && gh auth setup-git >>"$LOG" 2>&1; then
    log "gh: signed in from GH_TOKEN (kept under \$HOME/.config/gh); git credential helper set"
  else
    log "! gh: sign-in from GH_TOKEN failed — the seat can clone and commit but not push or open PRs"
  fi
  unset gh_token
else
  log "gh: no GH_TOKEN — the seat can clone and commit but not push or open PRs"
fi

# The model key's variable NAME is recorded in the registry at provisioning (ADR 588); its
# value is this process's env, inherited by the host loop and read at spawn — never written
# to a file by anything here.
export MUSTERD_KEY_ENV="${MUSTERD_KEY_ENV:-ANTHROPIC_API_KEY}"
# The model is a declaration, never a default (ADR 101): the resident engine reads MUSTERD_MODEL
# at spawn and DEFERS the wake — quietly, by design — when it is unset. The third pilot run
# (2026-10-19) provisioned and woke the seat, then deferred every wake on exactly that.
: "${MUSTERD_MODEL:?MUSTERD_MODEL (the model the seat runs on) must be set — create.sh --model}"

log "host starting: server $MUSTERD_SERVER team $MUSTERD_TEAM host $MUSTERD_HOST model $MUSTERD_MODEL"
# The host's own output goes to the volume log AND to stdout, so `fly logs` shows it: create.sh
# waits for the host's "◉ polling" line there before it mints, and the first canary runs
# (2026-10-20) sent it to $LOG only, so every create.sh timed out and the agent was minted by hand.
exec > >(tee -a "$LOG") 2>&1
exec musterd host --cloud-provision \
  --server "$MUSTERD_SERVER" --team "$MUSTERD_TEAM" --host "$MUSTERD_HOST" \
  --key-env "$MUSTERD_KEY_ENV"

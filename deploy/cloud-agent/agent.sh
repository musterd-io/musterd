#!/bin/bash
# Cloud agent — the SEAT phase, run as the unprivileged `seat` user. entrypoint.sh handled the
# root-only step (the tailnet, hub mode) and exec'd here with HOME, HUB_IP and LOG_DIR set.
#
# Hosted mode (ADR 647 phase 1; MUSTERD_HUB unset): no daemon, no team store (design §4.1b). The
# machine is a remote actuator against the hosted team's server: `musterd host --cloud-provision`
# claims the pending provision for this host label, stands the seat up in its workspace on the
# volume (ADR 648), and then polls that server for the seat's wakes.
#
# Hub mode (ADR 689; MUSTERD_HUB = the laptop's tailnet name): this machine runs its OWN daemon
# as a joiner — loopback-bound, enrolled at the hub with a one-shot invite — and the same host
# loop polls `http://127.0.0.1:4849`. The hub-minted host key authenticates there because
# sponsor-scoped credentials replicate (ADR 689 d1); provisioning verbs are refused
# `hub_unreachable` past the freshness window and the loop defers the row (d7). Nothing on this
# machine is a human: no `team create`, no `--as`.
#
# Non-secret env (fly.toml): MUSTERD_SERVER, MUSTERD_TEAM, MUSTERD_HOST (this machine's host
# label), REPO_URL (the seat workspace's clone source), MUSTERD_MODEL; hub mode adds MUSTERD_HUB
# (+ MUSTERD_HUB_PORT) and ROSTER_REPO (the team home — seat files travel by git, ADR 058).
# Secrets (`fly secrets set`, never in the image or repo):
#   MUSTERD_HOST_KEY    the sponsor-scoped host key (ADR 648) — the only musterd credential here
#   MUSTERD_INVITE      hub mode, first boot only: `musterd node invite` on the hub; scrubbed
#   ANTHROPIC_API_KEY   the sponsor's model key (BYOK) — read at spawn; or the MUSTERD_KEY_ENV var
#   GH_TOKEN            a fine-grained token for the workspace repo (ADR 675: never in the jail)
#   ROSTER_TOKEN        hub mode, a private team home: fine-grained, that repo only, contents read;
#                       kept in a 0600 file for the roster clone's own helper, then unset
set -euo pipefail

: "${MUSTERD_SERVER:?}" "${MUSTERD_TEAM:?}" "${MUSTERD_HOST:?}" "${HOME:?}" "${LOG_DIR:?}"
[ "$(id -u)" -ne 0 ] || { echo "agent.sh must not run as root — entrypoint.sh drops privileges first" >&2; exit 1; }
LOG="$LOG_DIR/host.log"
log() { printf '%s cloud-agent: %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG"; }
: "${MUSTERD_HOST_KEY:?MUSTERD_HOST_KEY (the sponsor-scoped host key) must be staged as a Fly secret}"

# ── hub mode: this machine's own daemon, a joiner ─────────────────────────────────────────────
if [ -n "${MUSTERD_HUB:-}" ]; then
  : "${HUB_IP:?}" "${ROSTER_REPO:?ROSTER_REPO (the team home git URL) must be set in hub mode}"
  MUSTERD_HUB_URL="http://${HUB_IP}:${MUSTERD_HUB_PORT:-4849}"
  if [ "$MUSTERD_SERVER" != "http://127.0.0.1:4849" ]; then
    log "hub mode: MUSTERD_SERVER is '$MUSTERD_SERVER' — using this machine's own daemon at http://127.0.0.1:4849"
    MUSTERD_SERVER=http://127.0.0.1:4849
  fi
  mkdir -p "$HOME/.musterd"
  musterd serve --port 4849 --host 127.0.0.1 >>"$LOG_DIR/daemon.log" 2>&1 &
  DAEMON_PID=$!
  for _ in $(seq 1 60); do curl -fsS -m 2 http://127.0.0.1:4849/health >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS -m 2 http://127.0.0.1:4849/health >/dev/null || { log "daemon did not come up — see $LOG_DIR/daemon.log"; exit 1; }
  log "daemon up (pid $DAEMON_PID), a joiner of $MUSTERD_HUB"

  # The roster: seat files travel by git (ADR 058). The team home is cloned once and declared as
  # this daemon's roster root. `team export` refuses a folder that already holds team.toml (every
  # clone), so the root is written into config directly and the daemon reloaded — the one remaining
  # delta friction (docs/perf/cloud-seat.md finding 4); the product fix (`team adopt`) is open.
  TEAM_HOME="$HOME/musterd/$MUSTERD_TEAM"
  # A private team home reads with its own token (ROSTER_TOKEN: fine-grained, that repo only,
  # contents read). A fine-grained token covers one owner, and the workspace's owner usually
  # differs. It lives in a 0600 file beside gh's config (ADR 675: never in the jail's
  # environment), and the clone's repo-local helper list is reset to read only that file, so
  # gh's workspace token never reaches the team home and this one never reaches the workspace.
  ROSTER_CRED="$HOME/.config/musterd/roster-token"
  if [ -n "${ROSTER_TOKEN:-}" ]; then
    mkdir -p "$(dirname "$ROSTER_CRED")"
    (umask 077 && printf '%s' "$ROSTER_TOKEN" >"$ROSTER_CRED")
  fi
  unset ROSTER_TOKEN
  ROSTER_AUTH=()
  if [ -s "$ROSTER_CRED" ]; then
    ROSTER_AUTH=(-c credential.helper=
      -c "credential.helper=!f() { test \"\$1\" = get || exit 0; echo username=x-access-token; echo \"password=\$(cat \"$ROSTER_CRED\")\"; }; f")
  fi
  if [ ! -d "$TEAM_HOME/.git" ]; then
    mkdir -p "$(dirname "$TEAM_HOME")"
    # `clone -c` also writes the helper into the clone's own config, so later pulls (here and the
    # daemon's roster refresh, ADR 592) read with the same token.
    git clone --quiet "${ROSTER_AUTH[@]}" "$ROSTER_REPO" "$TEAM_HOME" \
      || { log "roster clone failed — a private team home needs ROSTER_TOKEN (contents: read on $ROSTER_REPO)"; exit 1; }
  else
    git -C "$TEAM_HOME" pull --ff-only --quiet || log "roster pull did not fast-forward — the daemon's own refresh retries (ADR 592)"
  fi
  TEAM_HOME="$TEAM_HOME" node -e '
    const fs = require("fs"); const p = process.env.HOME + "/.musterd/config.json";
    const c = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {}; c.rosterHome = c.rosterHome || {};
    if (c.rosterHome[process.env.MUSTERD_TEAM] !== process.env.TEAM_HOME) {
      c.rosterHome[process.env.MUSTERD_TEAM] = process.env.TEAM_HOME;
      fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n"); console.log("roster root declared");
    }'
  kill -HUP "$DAEMON_PID"; sleep 2

  # Enrol at the hub (first boot; ~/.musterd/node.json is the proof). `node join` on a daemon
  # that has never seen the team creates the bare team row and its node row itself (ADR 689,
  # lane 01M5DTSKAB) — no human is minted here. The invite is single use and scrubbed below.
  if ! grep -q "\"$MUSTERD_TEAM\"" "$HOME/.musterd/node.json" 2>/dev/null; then
    for _ in $(seq 1 30); do curl -sf --max-time 2 "$MUSTERD_HUB_URL/health" >/dev/null && break; sleep 2; done
    MUSTERD_SERVER=http://127.0.0.1:4849 musterd node join "$MUSTERD_HUB_URL" "${MUSTERD_INVITE:?first boot in hub mode needs MUSTERD_INVITE}" \
      || { log "node join failed — is the invite fresh (single use, 15 m) and the hub awake at $MUSTERD_HUB_URL?"; exit 1; }
    log "enrolled at $MUSTERD_HUB_URL"
  fi
  unset MUSTERD_INVITE

  # Wait for the first fold to carry the sponsor's host key here (ADR 689 d1): the host loop
  # would otherwise poll into 401 until the sync tick lands. Bounded; the loop retries anyway.
  for _ in $(seq 1 90); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 -X POST \
      -H "authorization: Bearer $MUSTERD_HOST_KEY" -H 'content-type: application/json' \
      -d "{\"host\":\"$MUSTERD_HOST\"}" "http://127.0.0.1:4849/teams/$MUSTERD_TEAM/residency/wake-leases")"
    [ "$code" = 200 ] && break
    sleep 2
  done
  [ "${code:-}" = 200 ] && log "host key honoured by this daemon (replicated from the hub)" \
    || log "! host key not yet honoured here (last status ${code:-none}) — the hub's sync tick may be pending; the host loop keeps polling"
fi

# ── the workspace clone source (both modes) ───────────────────────────────────────────────────
cd /data/work
if [ ! -d repo/.git ]; then
  : "${REPO_URL:?REPO_URL (the workspace repo) must be set for the first boot}"
  log "cloning workspace repo"
  git clone --quiet "$REPO_URL" repo
fi
cd repo

# ADR 675: sign gh in from GH_TOKEN and hand git the same credential, then drop the variable.
unset ROSTER_TOKEN   # hosted mode never reads it; it never reaches the jail either way
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

# The model key's variable NAME is recorded in the registry at provisioning (ADR 588); its value
# is this process's env, read at spawn — never written to a file by anything here.
export MUSTERD_KEY_ENV="${MUSTERD_KEY_ENV:-ANTHROPIC_API_KEY}"
# The model is a declaration, never a default (ADR 101).
: "${MUSTERD_MODEL:?MUSTERD_MODEL (the model the seat runs on) must be set — create.sh --model}"

log "host starting: server $MUSTERD_SERVER team $MUSTERD_TEAM host $MUSTERD_HOST model $MUSTERD_MODEL${MUSTERD_HUB:+ (hub mode, joiner of $MUSTERD_HUB)}"
# The host's own output goes to the volume log AND to stdout, so `fly logs` shows it: create.sh
# waits for the host's "◉ polling" line there before it mints.
exec > >(tee -a "$LOG") 2>&1
exec musterd host --cloud-provision \
  --server "$MUSTERD_SERVER" --team "$MUSTERD_TEAM" --host "$MUSTERD_HOST" \
  --key-env "$MUSTERD_KEY_ENV"

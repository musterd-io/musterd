#!/bin/bash
# Second machine — a macOS laptop joins a musterd team as a federated machine (ADR 325 / 328 / 376)
# and hosts agent seats. The Mac twin of deploy/cloud-seat/{entrypoint,seat}.sh: the same steps
# in the same order, with no root, no container, and launchd services where the VM has a
# foreground supervisor. Every step is a no-op once done, so re-running after a failure resumes.
#
#   bootstrap.sh machine                 # 1 runtime · 2 services · 3 team home · 4 enrol · 5 key
#   bootstrap.sh seat <name> <harness>   # 6 give an agent seat a Workspace here, wakeable
#
# Run as the human (the one who created the team), from a shell whose `node` is ≥22: `musterd
# service install` embeds that node into every plist (AGENTS.md "TRAP"). The guide is
# docs/guides/second-machine.md; this file is its executable half.
#
# Env (every one has a default):
#   MUSTERD_TEAM=revive        MUSTERD_HUB=nicks-laptop   (tailnet name, or an IP)
#   MUSTERD_HUB_PORT=4849      MUSTERD_HUMAN=nick
#   ROSTER_REPO=SandRiseStudio/musterd-revive   WORK_REPO=SandRiseStudio/musterd
#   MUSTERD_RUNTIME_REF=main   MUSTERD_INVITE=msinv_…     (step 4 only; minted on the hub)
set -euo pipefail

MUSTERD_TEAM="${MUSTERD_TEAM:-revive}"
MUSTERD_HUB="${MUSTERD_HUB:-nicks-laptop}"
MUSTERD_HUB_PORT="${MUSTERD_HUB_PORT:-4849}"
MUSTERD_HUMAN="${MUSTERD_HUMAN:-nick}"
ROSTER_REPO="${ROSTER_REPO:-SandRiseStudio/musterd-revive}"
WORK_REPO="${WORK_REPO:-SandRiseStudio/musterd}"
MUSTERD_RUNTIME_REF="${MUSTERD_RUNTIME_REF:-main}"
RUNTIME="$HOME/.musterd/runtime"
TEAM_HOME="$HOME/musterd/$MUSTERD_TEAM"
CONFIG="$HOME/.musterd/config.json"
LOG="$HOME/.musterd/second-machine.log"
mkdir -p "$HOME/.musterd"

log() { printf '%s second-machine: %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG" || true; }
die() { log "✗ $*"; exit 1; }
local_health() { curl -fsS -m 2 "http://127.0.0.1:${MUSTERD_HUB_PORT}/health" >/dev/null 2>&1; }
wait_local() {
  for _ in $(seq 1 60); do local_health && return 0; sleep 1; done
  die "the local daemon did not answer /health — see ~/.musterd/daemon.err.log"
}

# ── preflight — what a human must have done first (the guide's "Before the script") ─────────
preflight() {
  [ "$(id -u)" -ne 0 ] || die "run as yourself, never as root"
  command -v tailscale >/dev/null || die "tailscale is not on PATH — the Mac app does not add its CLI: menu-bar Tailscale → Settings → Install CLI (or: sudo ln -sf /Applications/Tailscale.app/Contents/MacOS/Tailscale /usr/local/bin/tailscale)"
  tailscale status >/dev/null 2>&1 || die "tailscale is not up — open the app and sign in to the same tailnet as the hub"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 22 ] || die "node ≥22 required on PATH (found $(node -v 2>/dev/null || echo none)); brew install node@22 and export its bin dir first"
  command -v pnpm >/dev/null || die "pnpm is not on PATH — brew install pnpm && pnpm setup, then reopen the shell"
  command -v gh >/dev/null || die "gh is not on PATH — brew install gh"
  gh auth status >/dev/null 2>&1 || die "gh is not signed in — gh auth login"
  case "$MUSTERD_HUB" in
    [0-9]*.[0-9]*.[0-9]*.[0-9]*) HUB_IP="$MUSTERD_HUB" ;;
    *) HUB_IP="$(tailscale ip -4 "${MUSTERD_HUB%%.*}" 2>/dev/null | head -1)" ;;
  esac
  [ -n "${HUB_IP:-}" ] || die "'$MUSTERD_HUB' is not a peer on this tailnet (tailscale status)"
  HUB_URL="http://${HUB_IP}:${MUSTERD_HUB_PORT}"
  curl -fsS -m 3 "$HUB_URL/health" >/dev/null || die "the hub does not answer at $HUB_URL/health — is the hub laptop awake, and is \`tailscale serve\` forwarding $MUSTERD_HUB_PORT there?"
  log "preflight ok · hub $MUSTERD_HUB → $HUB_URL · node $(node -v)"
}

# ── 1. the runtime: the same build the hub runs, kept on main by autorefresh ────────────────
step_runtime() {
  if [ ! -d "$RUNTIME/.git" ]; then
    log "cloning $WORK_REPO → $RUNTIME"
    gh repo clone "$WORK_REPO" "$RUNTIME" -- --branch "$MUSTERD_RUNTIME_REF"
  fi
  if [ ! -f "$RUNTIME/packages/cli/dist/bin.js" ]; then
    log "building the runtime (first time: minutes — better-sqlite3 compiles)"
    ( cd "$RUNTIME" && pnpm install --frozen-lockfile && pnpm -r build ) >>"$LOG" 2>&1
  fi
  if ! command -v musterd >/dev/null; then
    # A plain shim in pnpm's global bin dir, not `pnpm link --global`: pnpm 12 removed that flag
    # (second-machine run, 2026-10-02), and the shim is all the link ever amounted to.
    local bin="${PNPM_HOME:-$HOME/Library/pnpm}"
    mkdir -p "$bin"
    printf '#!/bin/sh\nexec node "%s/packages/cli/dist/bin.js" "$@"\n' "$RUNTIME" >"$bin/musterd"
    chmod +x "$bin/musterd"
    export PATH="$bin:$PATH"
    command -v musterd >/dev/null || die "\`musterd\` is still not on PATH — run \`pnpm setup\`, reopen the shell, and re-run"
  fi
  log "runtime: $(git -C "$RUNTIME" rev-parse --short HEAD) · $(musterd --version 2>/dev/null | head -1)"
}

# ── 2. services: daemon (loopback), wake actuator, autorefresh — launchd, like the hub ───────
step_services() {
  if ! local_health; then
    log "installing the daemon service (loopback bind — a joiner dials out, nothing dials in)"
    musterd service install >>"$LOG" 2>&1
    wait_local
  fi
  musterd service install --wake >>"$LOG" 2>&1 || log "service install --wake refused (already installed?) — see $LOG"
  musterd service install --auto --mode notice >>"$LOG" 2>&1 || log "service install --auto refused (already installed?) — see $LOG"
  log "services: $(musterd service status 2>/dev/null | head -1)"
}

# ── 3. the team, locally: cloned roster, created under the same slug, declared as roster root ─
step_team() {
  if [ ! -d "$TEAM_HOME/.musterd" ]; then
    mkdir -p "$(dirname "$TEAM_HOME")"
    gh repo clone "$ROSTER_REPO" "$TEAM_HOME"
  fi
  ( cd "$TEAM_HOME" && musterd team create "$MUSTERD_TEAM" --as "$MUSTERD_HUMAN" ) >>"$LOG" 2>&1 \
    || log "team create: already present — continuing"
  # Declare the clone as this daemon's roster root (ADR 058). `team export` records this, but
  # refuses a folder that already holds team.toml — which every clone does (cloud-seat finding 4).
  # No CLI sets it on an existing home yet, so this edits config.json and restarts the daemon.
  node -e '
    const fs = require("fs"); const [p, team, home] = process.argv.slice(1);
    const c = JSON.parse(fs.readFileSync(p, "utf8")); c.rosterHome = c.rosterHome || {};
    if (c.rosterHome[team] !== home) {
      c.rosterHome[team] = home;
      fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n"); console.log("roster root declared");
    }' "$CONFIG" "$MUSTERD_TEAM" "$TEAM_HOME" | tee -a "$LOG"
  musterd service restart >>"$LOG" 2>&1
  wait_local
  log "team $MUSTERD_TEAM: roster root $TEAM_HOME"
}

# ── 4. enrol at the hub (once; ~/.musterd/node.json is the proof) ──────────────────────────
step_enrol() {
  if grep -q "\"$MUSTERD_TEAM\"" "$HOME/.musterd/node.json" 2>/dev/null; then
    log "already enrolled for $MUSTERD_TEAM"
    return 0
  fi
  [ -n "${MUSTERD_INVITE:-}" ] || die "not enrolled yet. On the HUB, from its team home: \`musterd node invite --label \"$(hostname -s)\"\` → then re-run with MUSTERD_INVITE=msinv_… (single use, 15 minutes)"
  ( cd "$TEAM_HOME" && musterd node join "$HUB_URL" "$MUSTERD_INVITE" ) | tee -a "$LOG"
  log "enrolled at $HUB_URL. NOW ON THE HUB, as $MUSTERD_HUMAN: \`musterd node trust <this machine's node id>\` — until then every push from here is refused 403 bound_elsewhere (ADR 358/360)"
}

# ── 5. this daemon's own team agent key (never the hub's — cloud-seat findings 2 and 14) ─────
step_key() {
  if [ "$(jq -r --arg t "$MUSTERD_TEAM" '.agentKeys[$t] // empty' "$CONFIG" 2>/dev/null)" != "" ]; then
    return 0
  fi
  ( cd "$TEAM_HOME" && musterd team agent-key --rotate --yes ) >>"$LOG" 2>&1
  log "minted this daemon's team agent key (a fresh joiner holds no seats, so nothing was invalidated)"
}

# ── 6. a seat's Workspace here: worktree, wiring, trust, wakeable ───────────────────────────
step_seat() {
  local name="$1" harness="$2"
  grep -q "\"$MUSTERD_TEAM\"" "$HOME/.musterd/node.json" 2>/dev/null || die "enrol first: bootstrap.sh machine"
  log "seat $name [$harness] — on the HUB first, as $MUSTERD_HUMAN: \`musterd residency off --seat $name\` and \`musterd node unbind $name\` (an agent seat lives on one machine, ADR 358 §3)"
  # From the runtime checkout: a worktree lands under ~/musterd/<team>/<repo>/<name> (ADR 447) and
  # the harness set is wired through the reconcile engine (ADR 491) — no hand edits.
  ( cd "$RUNTIME" && musterd agent "$name" --harness "$harness" --as "$MUSTERD_HUMAN" ) | tee -a "$LOG"
  local ws
  ws="$(ls -d "$TEAM_HOME"/*/"$name" 2>/dev/null | head -1)"
  [ -n "$ws" ] && [ -f "$ws/.musterd/binding.json" ] || die "no Workspace for $name under $TEAM_HOME/*/ — read the agent output above"
  # The seat's own gates need its dependencies; native builds take minutes and nothing waits on them.
  ( cd "$ws" && nohup pnpm install --frozen-lockfile >>"$HOME/.musterd/second-machine-install-$name.log" 2>&1 & )
  if [ "$harness" = "claude-code" ]; then
    # A cold wake spawns a headless session, which cannot answer Claude Code's first-run trust
    # prompt for a folder it has never opened (cloud-seat finding 8). Pre-accept it.
    node -e '
      const fs = require("fs"); const [p, ws] = process.argv.slice(1);
      const c = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
      c.projects = c.projects || {};
      c.projects[ws] = { ...(c.projects[ws] || {}), hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
      fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");' "$HOME/.claude.json" "$ws"
  fi
  ( cd "$ws" && musterd init --refresh-hooks ) >>"$LOG" 2>&1 || log "init --refresh-hooks failed in $ws"
  ( cd "$ws" && musterd wire ) >>"$LOG" 2>&1 || log "musterd wire refused in $ws — the actuator may poll with a credential the wake endpoint rejects (finding 14)"
  ( cd "$ws" && musterd residency on --seat "$name" --harness "$harness" --flow auto --as "$MUSTERD_HUMAN" ) | tee -a "$LOG" \
    || die "residency on refused — $name is not wakeable here until it succeeds"
  log "verify: (cd $ws && musterd harness status) — $harness selected AND available, every fragment settled. Then open it once: \`musterd $name\`"
}

case "${1:-}" in
  machine)
    preflight; step_runtime; step_services; step_team; step_enrol; step_key
    log "machine ready. Watch the first drain: tail -f ~/.musterd/daemon.log | grep -E 'sync_(drained|pulled|fold)'"
    ;;
  seat)
    [ $# -eq 3 ] || die "usage: bootstrap.sh seat <name> <claude-code|codex|grok|opencode>"
    preflight; step_seat "$2" "$3"
    ;;
  *)
    echo "usage: bootstrap.sh machine | bootstrap.sh seat <name> <harness>" >&2
    exit 2
    ;;
esac

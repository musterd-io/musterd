#!/bin/bash
# Second machine — a macOS laptop (or a Linux VM, prepared by linux/prep-ubuntu.sh) joins a musterd team as a federated machine (ADR 325 / 328 / 376)
# and hosts agent seats. The Mac twin of delta's cloud-seat scripts (retired 2026-10-21; the record is
# docs/perf/cloud-seat.md, the successor deploy/cloud-agent in hub mode): the same steps
# in the same order, with no root, no container, and launchd services where the VM has a
# foreground supervisor. Every step is a no-op once done, so re-running after a failure resumes.
#
#   bootstrap.sh machine                 # 1 runtime · 2 services · 3 team home · 4 enrol · 5 key
#   bootstrap.sh seat <name> <harness>   # 6 give an agent seat a Workspace here, wakeable
#   bootstrap.sh reset --yes             # start this machine over: un-enrol, state aside, keep the build
#
# Run as the human (the one who created the team), from a shell whose `node` is ≥22: `musterd
# service install` embeds that node into every plist (AGENTS.md "TRAP"). On Linux the services are
# systemd --user units from linux/ instead, since `musterd service` is launchd-only. The guide is
# docs/guides/second-machine.md; this file is its executable half.
#
# Env (every one has a default):
#   MUSTERD_TEAM=revive        MUSTERD_HUB=nicks-laptop   (tailnet name, or an IP)
#   MUSTERD_HUB_PORT=4849      MUSTERD_HUMAN=nick
#   ROSTER_REPO=SandRiseStudio/musterd-revive   WORK_REPO=musterd-io/musterd
#   MUSTERD_RUNTIME_REF=main   MUSTERD_INVITE=msinv_…     (step 4 only; minted on the hub)
set -euo pipefail

MUSTERD_TEAM="${MUSTERD_TEAM:-revive}"
MUSTERD_HUB="${MUSTERD_HUB:-nicks-laptop}"
MUSTERD_HUB_PORT="${MUSTERD_HUB_PORT:-4849}"
MUSTERD_HUMAN="${MUSTERD_HUMAN:-nick}"
ROSTER_REPO="${ROSTER_REPO:-SandRiseStudio/musterd-revive}"
WORK_REPO="${WORK_REPO:-musterd-io/musterd}"
MUSTERD_RUNTIME_REF="${MUSTERD_RUNTIME_REF:-main}"
RUNTIME="$HOME/.musterd/runtime"
TEAM_HOME="$HOME/musterd/$MUSTERD_TEAM"
CONFIG="$HOME/.musterd/config.json"
LOG="$HOME/.musterd/second-machine.log"
mkdir -p "$HOME/.musterd"
OS="$(uname -s)"
UNITS="$HOME/.config/systemd/user"

ADMIN_DIR="$HOME/.musterd/second-machine-admin"
# The human's member Workspace on this machine (ADR 447: ~/musterd/<team>/<repo>/<human>).
human_ws() { ls -d "$TEAM_HOME"/*/"$MUSTERD_HUMAN" 2>/dev/null | head -1; }
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
  [ "$OS" = Darwin ] || [ "$OS" = Linux ] || die "unsupported OS: $OS"
  command -v tailscale >/dev/null || die "tailscale is not on PATH — on Linux run linux/prep-ubuntu.sh as root; the Mac app does not add its CLI: menu-bar Tailscale → Settings → Install CLI (or: sudo ln -sf /Applications/Tailscale.app/Contents/MacOS/Tailscale /usr/local/bin/tailscale)"
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
  # Track the ref the way autorefresh does. A joiner on a build older than the hub's can stop the
  # fold (sync_fold_newer_build), and one older than the joiner guards (#1976, #1978) wedges itself.
  git -C "$RUNTIME" fetch -q origin "$MUSTERD_RUNTIME_REF" >>"$LOG" 2>&1 \
    && git -C "$RUNTIME" merge -q --ff-only "origin/$MUSTERD_RUNTIME_REF" >>"$LOG" 2>&1 \
    || log "runtime: could not fast-forward to origin/$MUSTERD_RUNTIME_REF — using what is checked out"
  # `dist/build.json` is the truth of what the BUILD is (ADR 135); HEAD says only what is checked out.
  local head built
  head="$(git -C "$RUNTIME" rev-parse HEAD)"
  built="$(node -p 'try{require(process.argv[1]).ref||""}catch(e){""}' "$RUNTIME/packages/cli/dist/build.json" 2>/dev/null || true)"
  if [ ! -f "$RUNTIME/packages/cli/dist/bin.js" ] || [ "$built" != "$head" ]; then
    log "building the runtime at ${head:0:8} (first time: minutes — better-sqlite3 compiles)"
    ( cd "$RUNTIME" && pnpm install --frozen-lockfile && pnpm -r build ) >>"$LOG" 2>&1
  fi
  if ! command -v musterd >/dev/null; then
    # A plain shim in pnpm's global bin dir, not `pnpm link --global`: pnpm 12 removed that flag
    # (second-machine run, 2026-10-02), and the shim is all the link ever amounted to.
    local bin="${PNPM_HOME:-$HOME/Library/pnpm}"
    [ "$OS" = Linux ] && bin="${PNPM_HOME:-$HOME/.local/share/pnpm}/bin"   # pnpm 12 keeps its shims under bin/
    mkdir -p "$bin"
    printf '#!/bin/sh\nexec node "%s/packages/cli/dist/bin.js" "$@"\n' "$RUNTIME" >"$bin/musterd"
    chmod +x "$bin/musterd"
    export PATH="$bin:$PATH"
    command -v musterd >/dev/null || die "\`musterd\` is still not on PATH — run \`pnpm setup\`, reopen the shell, and re-run"
  fi
  log "runtime: ${head:0:8} · $(musterd --version 2>/dev/null | head -1)"
}

# ── 2. services: daemon (loopback), wake actuator, autorefresh — launchd, like the hub ───────
step_services() {
  if [ "$OS" = Linux ]; then
    # `musterd service` is launchd-only: install the systemd --user twins from the runtime checkout,
    # so a refresh that changes a unit lands on the next run of this step.
    mkdir -p "$UNITS"
    cp "$RUNTIME"/deploy/second-machine/linux/musterd-*.service "$RUNTIME"/deploy/second-machine/linux/musterd-*.timer "$UNITS/"
    systemctl --user daemon-reload
    systemctl --user enable --now musterd-daemon.service >>"$LOG" 2>&1
    wait_local
    systemctl --user enable --now musterd-host.service musterd-refresh.timer >>"$LOG" 2>&1
    log "services: $(systemctl --user is-active musterd-daemon.service musterd-host.service | tr '\n' ' ')"
    return 0
  fi
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
  # Create the team on THIS daemon, under the hub's slug, with the human as its first admin. It runs
  # in a scratch folder: `team create` binds the folder it runs in, and the team root refuses a
  # binding by position (ADR 447). Identity is the folder since ADR 442 — there is no `--as`.
  if ! curl -fsS -m 2 "http://127.0.0.1:${MUSTERD_HUB_PORT}/teams/$MUSTERD_TEAM" >/dev/null 2>&1 \
    && [ ! -f "$ADMIN_DIR/.musterd/binding.json" ]; then
    mkdir -p "$ADMIN_DIR"
    ( cd "$ADMIN_DIR" && musterd team create "$MUSTERD_TEAM" --member "$MUSTERD_HUMAN" ) 2>&1 | tee -a "$LOG"
    [ -f "$ADMIN_DIR/.musterd/binding.json" ] || die "team create did not bind $ADMIN_DIR — read its output above"
  fi
  # Declare the clone as this daemon's roster root (ADR 058). `team export` records this, but
  # refuses a folder that already holds team.toml — which every clone does (cloud-seat finding 4).
  # No CLI sets it on an existing home yet, so this edits config.json and restarts the daemon.
  node -e '
    const fs = require("fs"); const [p, team, home] = process.argv.slice(1);
    const c = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
    c.rosterHome = c.rosterHome || {};
    if (c.rosterHome[team] !== home) {
      c.rosterHome[team] = home;
      fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n"); console.log("roster root declared");
    }' "$CONFIG" "$MUSTERD_TEAM" "$TEAM_HOME" | tee -a "$LOG"
  # --force: the only session on a fresh joiner is its own wake actuator (second-machine run, 2026-10-02).
  if [ "$OS" = Linux ]; then
    systemctl --user restart musterd-daemon.service >>"$LOG" 2>&1
  else
    musterd service restart --force >>"$LOG" 2>&1
  fi
  wait_local
  log "team $MUSTERD_TEAM: roster root $TEAM_HOME"
  # The human's own Workspace here (ADR 447): every later admin act — enrol, key, provisioning a
  # seat, residency — resolves its identity from this folder. `--rotate` because `team create`
  # already minted this human a credential here, and re-issuing it otherwise asks on the TTY —
  # where the tee hides the question and the run hangs (second-machine run, 2026-10-02).
  if [ -z "$(human_ws)" ]; then
    # From the admin folder `team create` bound as the human: a folder acts only as the member it is
    # bound to (ADR 442), and the runtime checkout is bound to no one (Linux VM run, 2026-10-29).
    # `--home` because outside a checkout `human` cannot derive the member worktree (ADR 447).
    ( cd "$ADMIN_DIR" && musterd human "$MUSTERD_HUMAN" --team "$MUSTERD_TEAM" --rotate \
      --home "$TEAM_HOME/musterd/$MUSTERD_HUMAN" ) 2>&1 | tee -a "$LOG"
  fi
  [ -n "$(human_ws)" ] || die "no Workspace for $MUSTERD_HUMAN under $TEAM_HOME/*/ — read the output above"
  log "human Workspace: $(human_ws)"
}

# ── 4. enrol at the hub (once; ~/.musterd/node.json is the proof) ──────────────────────────
step_enrol() {
  if grep -q "\"$MUSTERD_TEAM\"" "$HOME/.musterd/node.json" 2>/dev/null; then
    log "already enrolled for $MUSTERD_TEAM"
    return 0
  fi
  [ -n "${MUSTERD_INVITE:-}" ] || die "not enrolled yet. On the HUB, from your own Workspace there: \`musterd node invite --label \"$(hostname -s)\"\` → then re-run with MUSTERD_INVITE=msinv_… (single use, 15 minutes)"
  ( cd "$(human_ws)" && musterd node join "$HUB_URL" "$MUSTERD_INVITE" ) 2>&1 | tee -a "$LOG"
  grep -q "\"$MUSTERD_TEAM\"" "$HOME/.musterd/node.json" 2>/dev/null || die "node join did not enrol — read its output above (an expired invite needs a fresh one from the hub)"
  log "enrolled at $HUB_URL. NOW ON THE HUB, as $MUSTERD_HUMAN: \`musterd node trust <this machine's node id>\` — until then every push from here is refused 403 bound_elsewhere (ADR 358/360)"
}

# ── 5. this daemon's own team agent key (never the hub's — cloud-seat findings 2 and 14) ─────
step_key() {
  if [ -n "$(node -p 'try{(require(process.argv[1]).agentKeys||{})[process.argv[2]]||""}catch(e){""}' "$CONFIG" "$MUSTERD_TEAM" 2>/dev/null || true)" ]; then
    return 0
  fi
  ( cd "$(human_ws)" && musterd team agent-key --rotate --yes ) >>"$LOG" 2>&1
  log "minted this daemon's team agent key (a fresh joiner holds no seats, so nothing was invalidated)"
}

# ── 6. a seat's Workspace here: worktree, wiring, trust, wakeable ───────────────────────────
step_seat() {
  local name="$1" harness="$2"
  grep -q "\"$MUSTERD_TEAM\"" "$HOME/.musterd/node.json" 2>/dev/null || die "enrol first: bootstrap.sh machine"
  # Finding 6 (2026-10-03): re-running this for a seat that already moved here did nothing visible,
  # which read as a hang. `residency on` is the step's last write, so a host-registry entry for this
  # seat and harness, with a bound Workspace, means every step before it finished. A partial run has
  # no entry and resumes below.
  local done_ws
  done_ws="$(node -e '
    const fs = require("fs"); const [p, team, seat, harness] = process.argv.slice(1);
    let r; try { r = JSON.parse(fs.readFileSync(p, "utf8")); } catch { process.exit(0); }
    const e = (r.entries || []).find((x) => x.team === team && x.seat === seat && x.harness === harness);
    if (e && fs.existsSync(e.workspace + "/.musterd/binding.json")) console.log(e.workspace);' \
    "${MUSTERD_HOST_REGISTRY:-$HOME/.musterd/host-registry.json}" "$MUSTERD_TEAM" "$name" "$harness")"
  if [ -n "$done_ws" ]; then
    log "seat $name [$harness] is already provisioned here ($done_ws) and wakeable — nothing to do. Open it: \`musterd $name\`; check it: (cd $done_ws && musterd harness status)"
    return 0
  fi
  log "seat $name [$harness] — on the HUB first, as $MUSTERD_HUMAN: \`musterd residency off --seat $name\` and \`musterd node unbind $name\` (an agent seat lives on one machine, ADR 358 §3)"
  # From the runtime checkout: a worktree lands under ~/musterd/<team>/<repo>/<name> (ADR 447) and
  # the harness set is wired through the reconcile engine (ADR 491) — no hand edits.
  ( cd "$(human_ws)" && musterd agent "$name" --harness "$harness" ) 2>&1 | tee -a "$LOG"
  # ADR 592: `musterd agent` pushes the seat file it wrote. The hub learns a member only from that
  # file, and a `residency on` it cannot resolve is lost (finding 1, 2026-10-03), so refuse to enrol
  # a seat whose file has not reached the remote — with the commands that get it there.
  local rel=".musterd/seats/$name.toml"
  if [ -f "$TEAM_HOME/$rel" ] && git -C "$TEAM_HOME" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if [ -n "$(git -C "$TEAM_HOME" status --porcelain -- "$rel")" ] \
      || [ -n "$(git -C "$TEAM_HOME" rev-list '@{upstream}..HEAD' -- "$rel" 2>/dev/null)" ]; then
      die "$rel has not reached the roster remote, so the hub cannot know $name yet — publish it, then re-run this step:
  git -C $TEAM_HOME add $rel && git -C $TEAM_HOME commit -m \"roster: add $name\" -- $rel && git -C $TEAM_HOME push"
    fi
  fi
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
  ( cd "$(human_ws)" && musterd residency on --seat "$name" --workspace "$ws" --harness "$harness" --flow auto ) 2>&1 | tee -a "$LOG" \
    || die "residency on refused — $name is not wakeable here until it succeeds"
  log "verify: (cd $ws && musterd harness status) — $harness selected AND available, every fragment settled. Then open it once: \`musterd $name\`"
}

# ── reset: start this machine over, keeping the build and the roster clone ──────────────────────
# A joiner can end up in state that cannot be repaired in place (second-machine run, 2026-10-02: its
# reaper wrote events AS seats that live on the hub, and the hub refused every batch for good — ADR
# 360). The node id lives in the daemon DB and the hub never lets a revoked id enrol again, so the DB
# goes with it: stop the services, move everything under ~/.musterd aside EXCEPT the build, drop the
# human Workspace (a fresh checkout whose binding is dead anyway), and let `machine` rebuild the rest.
# Nothing else is deleted — it all lands in ~/.musterd-reset-<stamp>/.
step_reset() {
  [ "${1:-}" = "--yes" ] || die "reset un-enrols this machine and moves its musterd state aside. Re-run as: bash ~/bootstrap.sh reset --yes"
  step_runtime
  # A build that predates the joiner reaper guards re-wedges a fresh joiner within minutes. Refuse
  # BEFORE touching anything. Delete this check once every machine is past #1978.
  grep -q joinerTeams "$RUNTIME/packages/server/dist/presence/reaper.js" 2>/dev/null \
    || die "this build predates the joiner reaper guards (#1978) — a fresh enrolment would wedge again. Wait for it to land on main, then re-run reset"
  local others="" d
  for d in "$TEAM_HOME"/*/*/; do
    [ -d "$d" ] || continue
    [ "$(basename "$d")" = "$MUSTERD_HUMAN" ] || others="$others$d
"
  done
  [ -z "$others" ] || die "member Workspaces other than ${MUSTERD_HUMAN}'s exist here, and a reset kills their credentials — move those seats off this machine first:
$others"
  local old_node
  old_node="$(node -p 'try{(require(process.argv[1]).nodes||{})[process.argv[2]].node_id}catch(e){""}' "$HOME/.musterd/node.json" "$MUSTERD_TEAM" 2>/dev/null || true)"

  log "stopping this machine's musterd services"
  local label
  if [ "$OS" = Linux ]; then
    systemctl --user disable --now musterd-refresh.timer musterd-host.service musterd-daemon.service >>"$LOG" 2>&1 || true
  else
    for label in studio.sandrise.musterd-host studio.sandrise.musterd-autorefresh studio.sandrise.musterd; do
      launchctl bootout "gui/$(id -u)/$label" >>"$LOG" 2>&1 || true
      rm -f "$HOME/Library/LaunchAgents/$label.plist"
    done
  fi
  for _ in $(seq 1 20); do local_health || break; sleep 1; done
  ! local_health || die "a daemon is still answering on :${MUSTERD_HUB_PORT} — stop it (launchctl list | grep musterd) and re-run"

  local stash f ws
  stash="$HOME/.musterd-reset-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$stash"
  while IFS= read -r f; do
    case "${f##*/}" in runtime|second-machine.log) continue ;; esac
    mv "$f" "$stash/"
  done < <(find "$HOME/.musterd" -mindepth 1 -maxdepth 1)
  ws="$(human_ws)"
  if [ -n "$ws" ]; then
    git -C "$RUNTIME" worktree remove --force "$ws" >>"$LOG" 2>&1 || mv "$ws" "$stash/human-workspace"
    git -C "$RUNTIME" worktree prune >>"$LOG" 2>&1 || true
  fi
  git -C "$RUNTIME" branch -D "human/$MUSTERD_HUMAN" >>"$LOG" 2>&1 || true
  log "reset done: state moved to $stash; the build and the roster clone are untouched"
  printf '\nNext:\n'
  printf '  1. On the HUB, as %s:   musterd node revoke %s\n' "$MUSTERD_HUMAN" "${old_node:-<the old node id>}"
  printf '                           musterd node invite --label "%s"\n' "$(hostname -s)"
  printf '  2. Here:                 MUSTERD_INVITE=msinv_… bash ~/bootstrap.sh machine\n'
  printf '  3. On the HUB:           musterd node trust <the new node id>\n\n'
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
  reset)
    preflight; step_reset "${2:-}"
    ;;
  *)
    echo "usage: bootstrap.sh machine | seat <name> <harness> | reset --yes" >&2
    exit 2
    ;;
esac

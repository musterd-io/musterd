#!/bin/bash
# Create one cloud-agent machine (ADR 647 phase 1) — the README's Create + First boot steps as
# one script, so no secret is ever copy-pasted through a terminal or a chat.
#
#   deploy/cloud-agent/create.sh <seat> [options]
#
# Options:
#   --org <org>          Fly org (default: personal)
#   --region <region>    Fly region (default: sjc)
#   --team <slug>        hosted team slug (default: revive-staging)
#   --server <url>       hosted team server URL (default: https://<team>.musterd.dev)
#   --repo <git-url>     workspace repo the seat clones on first boot (required)
#   --host-label <label> host label the provision is queued for (default: cloud-<seat>)
#   --key-env <VAR>      env var holding the sponsor's model key (default: ANTHROPIC_API_KEY)
#   --model <id>         model the resident engine runs the seat on (default: claude-sonnet-5-5);
#                        ADR 101: the engine never guesses one, so an unset model defers every wake
#   --hub <tailnet-name> HUB MODE (ADR 689): the team lives on a laptop hub, not on Cloud. The
#                        machine joins the tailnet (TAILSCALE_AUTHKEY, read without echo), runs
#                        its own daemon and enrols at the hub with an invite minted here; the
#                        sponsor steps run from THIS folder, which must be bound to the team on
#                        the hub. --roster-repo is required (the team home's git URL, ADR 058).
#   --roster-repo <url>  hub mode: the team home repo the machine clones as its roster root
#   --hub-port <n>       hub mode: the hub daemon's port on the tailnet (default 4849)
#   --skip-sponsor       skip the sponsor steps (host key in MUSTERD_HOST_KEY; no agent is minted)
#   --skip-fly           the app, volume, secrets and machine already exist — only mint the agent
#   --dry-run            print every step (secrets redacted), change nothing
#   HOSTED_BUDGET_USD    env: per-wake budget set on the team for hosted seats (default: 5)
#
# Sponsor steps run as the sponsor. From a folder already bound to the team they run there; from
# anywhere else the script binds a scratch folder to the team itself, as the member whose
# credential staging-issuer saved in ~/.musterd/cloud/teams/<team>.json (`create-team`), so the
# whole thing is ONE command. The host key is minted, captured into a shell variable, and handed
# straight to `fly secrets set` — it is never printed.
#
# Order matters (ADR 463 §2): the agent is minted LAST, through the sponsored path, once the machine's
# host is polling — that is the only moment a provision is queued for it. The first pilot run
# (2026-10-19) minted the agent first and the host polled an empty queue. The model key and GH token are read without echo (or taken from the environment
# variables named by --key-env / GH_TOKEN when already set).
set -euo pipefail

SEAT="${1:-}"
shift || true
ORG=personal
REGION=sjc
TEAM=revive-staging
SERVER=""
TEAM_SET=""
REPO_URL=""
HOST_LABEL=""
MODEL="claude-sonnet-5-5"
KEY_ENV=ANTHROPIC_API_KEY
SKIP_SPONSOR=0
SKIP_FLY=0
DRY_RUN=0
HUB=""
HUB_PORT=4849
ROSTER_REPO=""

while [ $# -gt 0 ]; do
  case "$1" in
    --org) ORG="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --team) TEAM="$2"; TEAM_SET="$2"; shift 2 ;;
    --server) SERVER="$2"; shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --host-label) HOST_LABEL="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --key-env) KEY_ENV="$2"; shift 2 ;;
    --hub) HUB="$2"; shift 2 ;;
    --hub-port) HUB_PORT="$2"; shift 2 ;;
    --roster-repo) ROSTER_REPO="$2"; shift 2 ;;
    --skip-sponsor) SKIP_SPONSOR=1; shift ;;
    --skip-fly) SKIP_FLY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ -n "$SEAT" ] || { echo "usage: create.sh <seat> --repo <git-url> [options]" >&2; exit 2; }
[ -n "$REPO_URL" ] || { echo "--repo <git-url> is required (the seat's workspace clone source)" >&2; exit 2; }
HOST_LABEL="${HOST_LABEL:-cloud-$SEAT}"
HOSTED_BUDGET_USD="${HOSTED_BUDGET_USD:-5}"
if [ -n "$HUB" ]; then
  # Hub mode: the host loop polls the machine's OWN daemon; the team is whatever this folder is
  # bound to on the hub unless --team says otherwise.
  [ -n "$ROSTER_REPO" ] || { echo "--hub needs --roster-repo <url> (the team home the machine clones, ADR 058)" >&2; exit 2; }
  SERVER="http://127.0.0.1:4849"
  BOUND_TEAM="$( (musterd whoami --json 2>/dev/null || true) | jq -r 'select(.source == "binding") | .team // empty')"
  TEAM="${TEAM_SET:-${BOUND_TEAM:-$TEAM}}"
else
  SERVER="${SERVER:-https://$TEAM.musterd.dev}"   # a hosted team lives at <slug>.musterd.dev (cloud-ops.md)
fi
APP="musterd-agent-$SEAT"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

run() {
  if [ "$DRY_RUN" = 1 ]; then printf '  $ %s\n' "$*"; else "$@"; fi
}
say() { printf '%s\n' "$*"; }

for tool in fly musterd git jq; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done

say "== cloud agent for seat '$SEAT' (app $APP, host $HOST_LABEL, team $TEAM${HUB:+, hub $HUB})"

# ── sponsor binding ───────────────────────────────────────────────────────────────────────────
# `musterd` acts as the folder it runs in. Unless this folder is already bound to $TEAM, bind a
# scratch folder with the team file's saved human credential (passed through the environment,
# never argv or stdout) and run the sponsor steps from there.
HOST_KEY="${MUSTERD_HOST_KEY:-}"
if [ "$SKIP_SPONSOR" = 0 ]; then
  BOUND="$( (musterd whoami --json 2>/dev/null || true) | jq -r 'select(.source == "binding") | .team // empty')"
  if [ -n "$HUB" ] && [ "$BOUND" != "$TEAM" ]; then
    echo "hub mode runs the sponsor steps from a folder bound to '$TEAM' on the hub; this one is bound to '${BOUND:-no team}'." >&2
    exit 1
  fi
  if [ "$BOUND" != "$TEAM" ]; then
    TEAM_FILE="$HOME/.musterd/cloud/teams/$TEAM.json"
    if [ ! -f "$TEAM_FILE" ]; then
      echo "this folder is bound to '${BOUND:-no team}', not '$TEAM', and $TEAM_FILE is missing." >&2
      echo "Run from a folder bound to $TEAM as the sponsor, or create the team first" >&2
      echo "(docs/guides/cloud-ops.md § Create a team on staging), or pass --skip-sponsor." >&2
      exit 1
    fi
    SPONSOR="$(jq -r '.member.name // empty' "$TEAM_FILE")"
    [ -n "$SPONSOR" ] || { echo "$TEAM_FILE names no member" >&2; exit 1; }
    WORK="$(mktemp -d "${TMPDIR:-/tmp}/musterd-cloud-agent.XXXXXX")"
    say "-- sponsor: bind $WORK to $TEAM as $SPONSOR (credential from $TEAM_FILE, never printed)"
    cd "$WORK"
    if [ "$DRY_RUN" = 1 ]; then
      printf '  $ MUSTERD_SERVER=%s MUSTERD_AGENT_KEY=… musterd claim %s --team %s --detach\n' "$SERVER" "$SPONSOR" "$TEAM"
    else
      MUSTERD_SERVER="$SERVER" MUSTERD_AGENT_KEY="$(jq -r '.human_credential' "$TEAM_FILE")" \
        musterd claim "$SPONSOR" --team "$TEAM" --detach
    fi
  fi
  INVITE=""
  if [ -n "$HUB" ]; then
    say "-- sponsor: mint the machine's enrollment invite on the hub (captured, never printed; single use, 15 m)"
    if [ "$DRY_RUN" = 1 ]; then
      INVITE="<invite>"
    else
      INVITE="$(musterd node invite --label "cloud agent $SEAT" | grep -o 'msinv_[A-Za-z0-9_-]*' | head -1)"
      [ -n "$INVITE" ] || { echo "node invite returned no code — is this folder bound as an admin on the hub?" >&2; exit 1; }
    fi
  fi
  say "-- sponsor: mint the host key for '$HOST_LABEL' (captured, never printed)"
  if [ "$DRY_RUN" = 1 ]; then
    HOST_KEY="<host key>"
  else
    HOST_KEY="$(musterd team bootstrap mint --host "$HOST_LABEL" --json | jq -r .agent_key)"
    [ -n "$HOST_KEY" ] && [ "$HOST_KEY" != "null" ] || { echo "host key mint returned no key" >&2; exit 1; }
  fi
else
  [ -n "$HOST_KEY" ] || { echo "--skip-sponsor needs MUSTERD_HOST_KEY in the environment" >&2; exit 1; }
fi

# ── secrets, read without echo ────────────────────────────────────────────────────────────────
MODEL_KEY="${!KEY_ENV:-}"
if [ -z "$MODEL_KEY" ] && [ "$DRY_RUN" = 0 ]; then
  read -rsp "  $KEY_ENV (the sponsor's model key, not echoed): " MODEL_KEY; echo
fi
if [ -z "${GH_TOKEN:-}" ] && [ "$DRY_RUN" = 0 ]; then
  read -rsp "  GH_TOKEN (fine-grained, workspace repo only, not echoed): " GH_TOKEN; echo
fi
if [ -n "$HUB" ] && [ -z "${TAILSCALE_AUTHKEY:-}" ] && [ "$DRY_RUN" = 0 ]; then
  read -rsp "  TAILSCALE_AUTHKEY (single use, tagged if your tailnet policy wants it, not echoed): " TAILSCALE_AUTHKEY; echo
fi

# ── fly steps ─────────────────────────────────────────────────────────────────────────────────
if [ "$SKIP_FLY" = 0 ]; then
say "-- fly: app + volume"
run fly apps create "$APP" --org "$ORG" || true
run fly volumes create agent_data --app "$APP" --region "$REGION" --size 3 --yes || true

say "-- fly: stage secrets (values never printed)"
HUB_SECRETS=()
[ -z "$HUB" ] || HUB_SECRETS=("MUSTERD_INVITE=${INVITE:-}" "TAILSCALE_AUTHKEY=${TAILSCALE_AUTHKEY:-}")
if [ "$DRY_RUN" = 1 ]; then
  printf '  $ fly secrets set --app %s MUSTERD_HOST_KEY=… %s=… GH_TOKEN=…%s\n' "$APP" "$KEY_ENV" "${HUB:+ MUSTERD_INVITE=… TAILSCALE_AUTHKEY=…}"
else
  fly secrets set --app "$APP" \
    "MUSTERD_HOST_KEY=$HOST_KEY" \
    "$KEY_ENV=$MODEL_KEY" \
    "GH_TOKEN=${GH_TOKEN:-}" \
    "${HUB_SECRETS[@]}"
fi
unset HOST_KEY MODEL_KEY GH_TOKEN INVITE TAILSCALE_AUTHKEY HUB_SECRETS

say "-- fly: deploy (first boot provisions the seat)"
# The checkout is the build context (the Dockerfile's `COPY . .`), named explicitly: by default fly
# uses the config's folder, and the first pilot run (2026-10-19) built from deploy/cloud-agent/ alone —
# 292 bytes, "No projects matched the filters". The sponsor steps above may also have cd'd away.
run fly deploy "$ROOT" --config "$ROOT/deploy/cloud-agent/fly.toml" \
  --dockerfile "$ROOT/deploy/cloud-agent/Dockerfile" \
  --app "$APP" --ha=false \
  --env "MUSTERD_SERVER=$SERVER" \
  --env "MUSTERD_TEAM=$TEAM" \
  --env "MUSTERD_HOST=$HOST_LABEL" \
  --env "MUSTERD_MODEL=$MODEL" \
  --env "REPO_URL=$REPO_URL" \
  ${HUB:+--env "MUSTERD_HUB=$HUB" --env "MUSTERD_HUB_PORT=$HUB_PORT" --env "ROSTER_REPO=$ROSTER_REPO"}
fi

# ── the agent, minted once the host is polling ────────────────────────────────────────────────
if [ "$SKIP_SPONSOR" = 0 ]; then
  say "-- host: waiting for '$HOST_LABEL' to poll (the provision is queued only while it does)"
  if [ "$DRY_RUN" = 1 ]; then
    printf '  (poll `fly logs --app %s` for "◉ polling", then one tick)\n' "$APP"
  else
    seen=0
    for _ in $(seq 1 24); do
      if fly logs --app "$APP" --no-tail 2>/dev/null | grep -q '◉ polling'; then seen=1; break; fi
      sleep 10
    done
    [ "$seen" = 1 ] || { echo "host '$HOST_LABEL' never reported polling — fly logs --app $APP" >&2; exit 1; }
    sleep 15   # one poll tick, so the server has seen the host before the mint
  fi
  say "-- sponsor: hosted budget \$$HOSTED_BUDGET_USD per wake (ADR 463 §2 — a claim without one fails no_budget)"
  run musterd team policy --hosted-budget "$HOSTED_BUDGET_USD"
  say "-- sponsor: mint the agent (sponsored path — this is what queues its provision, pinned to this host)"
  # --host pins the row to THIS machine's label: with another host of the sponsor's polling (the
  # pilot, a sibling canary), whichever polled first used to claim it (2026-10-20, three times).
  # Hub mode: the hub learns the label is up from the joiner's heartbeat, which arrives on the
  # hub's next sync pull (ADR 689 d3) — so a mint refused "unseen host" is retried for a few ticks.
  if [ -n "$HUB" ] && [ "$DRY_RUN" = 0 ]; then
    minted=0
    for _ in $(seq 1 12); do
      if musterd agent "$SEAT" --hosted --host "$HOST_LABEL"; then minted=1; break; fi
      say "   (the hub has not seen '$HOST_LABEL' yet — waiting for its heartbeat to sync)"
      sleep 15
    done
    [ "$minted" = 1 ] || { echo "the hub never saw '$HOST_LABEL' — check fly logs --app $APP and the hub's sync (musterd node list)" >&2; exit 1; }
  else
    run musterd agent "$SEAT" --hosted --host "$HOST_LABEL"
  fi
fi

say ""
say "done. Watch it stand the seat up:"
say "  fly logs --app $APP"
say "Verify (README §Verify): the provision reads ready, then send the seat an act that wakes."

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
#   --skip-sponsor       skip the sponsor steps (agent already created, host key in MUSTERD_HOST_KEY)
#   --dry-run            print every step (secrets redacted), change nothing
#
# Sponsor steps run as the sponsor. From a folder already bound to the team they run there; from
# anywhere else the script binds a scratch folder to the team itself, as the member whose
# credential staging-issuer saved in ~/.musterd/cloud/teams/<team>.json (`create-team`), so the
# whole thing is ONE command. The host key is minted, captured into a shell variable, and handed
# straight to `fly secrets set` — it is never printed. The model key and GH token are read without echo (or taken from the environment
# variables named by --key-env / GH_TOKEN when already set).
set -euo pipefail

SEAT="${1:-}"
shift || true
ORG=personal
REGION=sjc
TEAM=revive-staging
SERVER=""
REPO_URL=""
HOST_LABEL=""
KEY_ENV=ANTHROPIC_API_KEY
SKIP_SPONSOR=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --org) ORG="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --team) TEAM="$2"; shift 2 ;;
    --server) SERVER="$2"; shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --host-label) HOST_LABEL="$2"; shift 2 ;;
    --key-env) KEY_ENV="$2"; shift 2 ;;
    --skip-sponsor) SKIP_SPONSOR=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ -n "$SEAT" ] || { echo "usage: create.sh <seat> --repo <git-url> [options]" >&2; exit 2; }
[ -n "$REPO_URL" ] || { echo "--repo <git-url> is required (the seat's workspace clone source)" >&2; exit 2; }
HOST_LABEL="${HOST_LABEL:-cloud-$SEAT}"
SERVER="${SERVER:-https://$TEAM.musterd.dev}"   # a hosted team lives at <slug>.musterd.dev (cloud-ops.md)
APP="musterd-agent-$SEAT"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

run() {
  if [ "$DRY_RUN" = 1 ]; then printf '  $ %s\n' "$*"; else "$@"; fi
}
say() { printf '%s\n' "$*"; }

for tool in fly musterd git jq; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done

say "== cloud agent for seat '$SEAT' (app $APP, host $HOST_LABEL, team $TEAM)"

# ── sponsor binding ───────────────────────────────────────────────────────────────────────────
# `musterd` acts as the folder it runs in. Unless this folder is already bound to $TEAM, bind a
# scratch folder with the team file's saved human credential (passed through the environment,
# never argv or stdout) and run the sponsor steps from there.
HOST_KEY="${MUSTERD_HOST_KEY:-}"
if [ "$SKIP_SPONSOR" = 0 ]; then
  BOUND="$( (musterd whoami --json 2>/dev/null || true) | jq -r 'select(.source == "binding") | .team // empty')"
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
  say "-- sponsor: create the agent and queue its provision"
  run musterd agent "$SEAT"
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

# ── fly steps ─────────────────────────────────────────────────────────────────────────────────
say "-- fly: app + volume"
run fly apps create "$APP" --org "$ORG" || true
run fly volumes create agent_data --app "$APP" --region "$REGION" --size 3 --yes || true

say "-- fly: stage secrets (values never printed)"
if [ "$DRY_RUN" = 1 ]; then
  printf '  $ fly secrets set --app %s MUSTERD_HOST_KEY=… %s=… GH_TOKEN=…\n' "$APP" "$KEY_ENV"
else
  fly secrets set --app "$APP" \
    "MUSTERD_HOST_KEY=$HOST_KEY" \
    "$KEY_ENV=$MODEL_KEY" \
    "GH_TOKEN=${GH_TOKEN:-}"
fi
unset HOST_KEY MODEL_KEY GH_TOKEN

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
  --env "REPO_URL=$REPO_URL"

say ""
say "done. Watch it stand the seat up:"
say "  fly logs --app $APP"
say "Verify (README §Verify): the provision reads ready, then send the seat an act that wakes."

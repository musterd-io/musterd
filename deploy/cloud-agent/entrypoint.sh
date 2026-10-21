#!/bin/bash
# Cloud agent entrypoint — the ROOT phase, every boot, idempotent. It does the one thing on the
# machine that may need root — in hub mode, bring the tailnet up (kernel networking wants
# /dev/net/tun and the tailscaled socket) — then hands the machine to agent.sh as the unprivileged
# `seat` user (setpriv, no inheritable caps; ADR 390). The daemon, git, gh, the host loop and the
# resident engine never run as root. In hosted mode nothing here needs root at all and the drop is
# immediate.
#
# Mode is one variable: MUSTERD_HUB set = hub mode (ADR 689, a laptop-hub team); unset = hosted
# mode (ADR 647 phase 1, a Cloud team). agent.sh documents the rest of the environment.
#
# Secrets consumed HERE and scrubbed before the drop: TAILSCALE_AUTHKEY (first boot only).
# Refused: MUSTERD_AGENT_KEY — a team's daemon-private key has no business on this machine.
set -euo pipefail

HOME="${HOME:-/data/home}"
export HOME
SEAT_USER=seat
LOG_DIR=/data/log
mkdir -p "$HOME" "$LOG_DIR" /data/work
log() { printf '%s cloud-agent: %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG_DIR/entrypoint.log" || true; }

if [ -n "${MUSTERD_AGENT_KEY:-}" ]; then
  log "REFUSING TO BOOT: MUSTERD_AGENT_KEY is set — the team agent key is daemon-private and must not be on this machine. Fix: fly secrets unset MUSTERD_AGENT_KEY"
  exit 1
fi

HUB_IP=""
if [ -n "${MUSTERD_HUB:-}" ]; then
  # ── hub mode: the tailnet, as root ──────────────────────────────────────────────────────────
  # Fly machines are real VMs with /dev/net/tun, so tailscaled runs with kernel networking. State
  # lives on the volume, so the node keeps its tailnet identity across redeploys and the auth key
  # is spent once, on first boot.
  mkdir -p /data/tailscale /var/run/tailscale
  tailscaled --state=/data/tailscale/tailscaled.state >"$LOG_DIR/tailscaled.log" 2>&1 &
  for _ in $(seq 1 60); do tailscale status >/dev/null 2>&1 && break; sleep 1; done
  if ! tailscale status >/dev/null 2>&1; then
    TS_TAGS=()
    [ -z "${TAILSCALE_ADVERTISE_TAGS:-}" ] || TS_TAGS=(--advertise-tags="$TAILSCALE_ADVERTISE_TAGS")
    for _ in $(seq 1 10); do
      tailscale up --authkey="${TAILSCALE_AUTHKEY:?first boot in hub mode needs TAILSCALE_AUTHKEY}" \
        --hostname="${TAILSCALE_HOSTNAME_PREFIX:-musterd-agent}-${MUSTERD_HOST:-seat}" --accept-dns=false \
        "${TS_TAGS[@]}" 2>/dev/null && break
      sleep 2
    done
  fi
  tailscale status >/dev/null || { log "tailscale never came up"; tail -20 "$LOG_DIR/tailscaled.log"; exit 1; }
  # Ask tailscaled for the hub's address rather than a resolver (MagicDNS is off).
  case "$MUSTERD_HUB" in
    [0-9]*.[0-9]*.[0-9]*.[0-9]*) HUB_IP="$MUSTERD_HUB" ;;
    *) HUB_IP="$(tailscale ip -4 "${MUSTERD_HUB%%.*}" 2>/dev/null | head -1)" ;;
  esac
  [ -n "$HUB_IP" ] || { log "'$MUSTERD_HUB' is not a peer on this tailnet"; tailscale status | head -10; exit 1; }
  log "tailnet up · hub $MUSTERD_HUB → $HUB_IP"
fi
# Spent on first boot (state on the volume); must not ride into the seat's environment.
unset TAILSCALE_AUTHKEY

# ── drop root ────────────────────────────────────────────────────────────────────────────────
# Everything under /data that is the seat's belongs to the seat. tailscale's state stays root's.
# The boot log is handed over explicitly every boot: on a volume whose $LOG_DIR is already
# seat-owned the loop skips the dir and never reaches a root-created file inside it.
chown "$SEAT_USER:$SEAT_USER" "$LOG_DIR/entrypoint.log" 2>/dev/null || true
for d in "$HOME" /data/work "$LOG_DIR"; do
  [ -e "$d" ] || continue
  if [ "$(stat -c %U "$d")" != "$SEAT_USER" ]; then
    log "chown $d → $SEAT_USER (one-time)"
    chown -R "$SEAT_USER:$SEAT_USER" "$d"
  fi
done
log "dropping root → $SEAT_USER"
exec setpriv --reuid="$SEAT_USER" --regid="$SEAT_USER" --init-groups --inh-caps=-all \
  env HOME="$HOME" HUB_IP="$HUB_IP" LOG_DIR="$LOG_DIR" \
  bash /app/deploy/cloud-agent/agent.sh

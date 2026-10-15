#!/bin/sh
# ADR 542: start main's hourly full-check probe from the daemon host, because GitHub's hourly cron
# (ADR 535) fired 3 of 22 slots on 2026-10-06/07. The probe itself decides: CI's pick step runs the
# full check only when the last one is over 4 hours old, code moved since, and none is in flight —
# otherwise it skips every gate and succeeds. This only starts it; it never decides anything.
#
#   scripts/ci/main-probe.sh            dispatch one probe now (what the LaunchAgent runs)
#   scripts/ci/main-probe.sh install    write + load the LaunchAgent (hourly, at :47)
#   scripts/ci/main-probe.sh uninstall  unload + remove it
#
# Install it from the daemon's checkout (~/.musterd/runtime), which the auto-refresher keeps on
# main, so the agent always runs main's copy of this script.
set -eu

LABEL=studio.sandrise.musterd-ci-probe
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/.musterd/ci-probe.log"
REPO=${MUSTERD_PROBE_REPO:-musterd-io/musterd}

case "${1:-dispatch}" in
  dispatch)
    ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    if out=$(gh workflow run ci.yml --repo "$REPO" --ref main -f probe=true 2>&1); then
      echo "$ts dispatched probe on $REPO main"
    else
      echo "$ts dispatch FAILED: $out"
      exit 1
    fi
    # ADR 610: the same hourly tick samples the forge's completed runs into the ledger, as the
    # autorefresh service seat (the token the auto-refresher's tick already uses). Best-effort:
    # a sampling failure is one log line, never a failed probe.
    bin=$(cd "$(dirname "$0")/../.." && pwd)/packages/cli/dist/bin.js
    if [ -f "$bin" ]; then
      if out=$(MUSTERD_SERVICE_TOKEN_FILE="$HOME/.musterd/autorefresh/seat-token" MUSTERD_PROBE_REPO="$REPO" node "$bin" ci sample 2>&1); then
        echo "$ts $out"
      else
        echo "$ts ci sample FAILED: $out"
      fi
    fi
    ;;
  install)
    script=$(cd "$(dirname "$0")" && pwd)/main-probe.sh
    gh_bin=$(command -v gh) || { echo "gh is not on PATH" >&2; exit 1; }
    gh auth status >/dev/null 2>&1 || { echo "gh is not logged in — run: gh auth login" >&2; exit 1; }
    mkdir -p "$(dirname "$LOG")"
    # :47, half an hour off the cron's :17 — when both fire, the second sees the first's full check
    # in flight or under 4h old and skips. A slot missed while the laptop slept fires on wake.
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>$script</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Minute</key>
    <integer>47</integer>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(dirname "$gh_bin"):/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "installed $LABEL → $script (hourly at :47, log $LOG)"
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed $LABEL"
    ;;
  *)
    echo "usage: $0 [dispatch|install|uninstall]" >&2
    exit 2
    ;;
esac

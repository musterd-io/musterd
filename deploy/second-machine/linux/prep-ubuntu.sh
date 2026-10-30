#!/bin/bash
# Second machine, Linux — the root half: turn a fresh Ubuntu 24.04 VM into a box `bootstrap.sh
# machine` can run on. The Mac guide's "Before the script" steps (docs/guides/second-machine.md),
# done by a script because a VPS has no app installers. Run once as root; every step is a no-op
# once done.
#
#   bash prep-ubuntu.sh [user]          # default user: musterd
#
# Leaves: Node 22, git, gh, tailscale, bubblewrap and a C toolchain (better-sqlite3 compiles) system-wide;
# a non-root user with lingering on (its systemd --user services run with nobody logged in); pnpm,
# Claude Code and Codex installed for that user. Signing in (tailscale, gh, claude, codex) is the
# human's step after this — see the guide's Linux section.
set -euo pipefail

USER_NAME="${1:-musterd}"
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

apt-get update -q
apt-get install -yq ca-certificates curl git build-essential python3 bubblewrap jq unzip

if ! node -v 2>/dev/null | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi

if ! command -v gh >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    >/etc/apt/sources.list.d/github-cli.list
  apt-get update -q
  apt-get install -yq gh
fi

command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
# Join the tailnet when a single-use key is given (read it without echo: `read -rs TS_AUTHKEY`).
if [ -n "${TS_AUTHKEY:-}" ] && ! tailscale status >/dev/null 2>&1; then
  tailscale up --authkey "$TS_AUTHKEY" --hostname "$(hostname -s)"
fi

if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$USER_NAME"
  # The human's SSH key reaches the user too, so every later step runs as it, never as root.
  if [ -f /root/.ssh/authorized_keys ]; then
    install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "/home/$USER_NAME/.ssh"
    install -m 600 -o "$USER_NAME" -g "$USER_NAME" /root/.ssh/authorized_keys "/home/$USER_NAME/.ssh/authorized_keys"
  fi
fi
# A headless box has no login session: without lingering, the user's systemd --user manager (and
# with it the daemon and the wake actuator) stops when the last SSH session closes.
loginctl enable-linger "$USER_NAME"

# Per-user tools, under the user's home so updates need no root: pnpm's standalone installer, and the
# two harnesses into ~/.npm-global (one of the paths the host's claude/codex lookup already tries).
sudo -iu "$USER_NAME" bash -s <<'EOF'
set -euo pipefail
command -v pnpm >/dev/null || [ -x "$HOME/.local/share/pnpm/bin/pnpm" ] || curl -fsSL https://get.pnpm.io/install.sh | sh -
npm config set prefix "$HOME/.npm-global"
npm install -g @anthropic-ai/claude-code @openai/codex
grep -q npm-global "$HOME/.bashrc" || echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >>"$HOME/.bashrc"
EOF

# Ubuntu 24.04 sets kernel.apparmor_restrict_unprivileged_userns=1, and bubblewrap needs a user
# namespace: Codex's own sandbox (its vendored bwrap) fails "bwrap: loopback: Failed RTM_NEWADDR:
# Operation not permitted", so every Codex wake dies ("thread id missing"), and the resident
# engine's bash sandbox is bwrap too (musterd-joiner-1, 2026-10-29). Exempt only the two bwrap
# binaries; the restriction stays on for everything else.
CODEX_BWRAP="/home/$USER_NAME/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex-resources/bwrap"
if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ]; then
  {
    printf 'abi <abi/4.0>,\ninclude <tunables/global>\n'
    printf 'profile musterd-bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n}\n'
    printf 'profile musterd-codex-bwrap %s flags=(unconfined) {\n  userns,\n}\n' "$CODEX_BWRAP"
  } >/etc/apparmor.d/musterd-bwrap-userns
  apparmor_parser -r /etc/apparmor.d/musterd-bwrap-userns
fi

echo
tailscale status >/dev/null 2>&1 || echo "tailscale is not up: as root, \`tailscale up\` (or re-run with TS_AUTHKEY set)"
echo "prep done. Next, as $USER_NAME (ssh $USER_NAME@<this box>):"
echo "  gh auth login · claude (then /login) · codex login --device-auth"
echo "  then: bootstrap.sh machine   (docs/guides/second-machine.md, Linux section)"

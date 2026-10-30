#!/bin/bash
# Second machine, Linux — the root half: turn a fresh Ubuntu 24.04 VM into a box `bootstrap.sh
# machine` can run on. The Mac guide's "Before the script" steps (docs/guides/second-machine.md),
# done by a script because a VPS has no app installers. Run once as root; every step is a no-op
# once done.
#
#   bash prep-ubuntu.sh [user]          # default user: musterd
#
# Leaves: Node 22, git, gh, tailscale, bubblewrap and a C toolchain (better-sqlite3 compiles) system-wide;
# a non-root user with lingering on (its systemd --user services run with nobody logged in); pnpm
# and Claude Code installed for that user, Codex system-wide. Signing in (tailscale, gh, claude, codex) is the
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
npm install -g @anthropic-ai/claude-code
grep -q npm-global "$HOME/.bashrc" || echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >>"$HOME/.bashrc"
EOF

# Codex goes in system-wide, as root: its sandbox runs a vendored bwrap, and the AppArmor
# exemption below must name a binary the agents (who run as $USER_NAME) cannot replace. Anything
# under the user's home can be swapped by renaming a parent folder the user owns.
npm install -g @openai/codex

# Ubuntu 24.04 sets kernel.apparmor_restrict_unprivileged_userns=1, and bubblewrap needs a user
# namespace: Codex's sandbox fails "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted",
# so every Codex wake dies ("thread id missing"), and the resident engine's bash sandbox is bwrap
# too (musterd-joiner-1, 2026-10-29). Install Ubuntu's own bwrap-userns-restrict profile from the
# apparmor-profiles package: bwrap may use the namespace to build its sandbox, but everything it
# runs is stacked under unpriv_bwrap and denied every capability, so plain `unshare -Ur` stays
# refused (lane 01M654MHYJ). Only the attachment is widened, to cover Codex's vendored bwrap too
# (root-owned: Codex is installed system-wide above).
if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ]; then
  tmp="$(mktemp -d)"
  (cd "$tmp" && apt-get download -q apparmor-profiles && dpkg -x apparmor-profiles_*.deb x)
  sed 's#^profile bwrap /usr/bin/bwrap #profile bwrap /{usr/bin/bwrap,usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-*/vendor/*/codex-resources/bwrap} #' \
    "$tmp/x/usr/share/apparmor/extra-profiles/bwrap-userns-restrict" >/etc/apparmor.d/musterd-bwrap-userns
  rm -rf "$tmp"
  grep -q '^profile bwrap /{usr/bin/bwrap,' /etc/apparmor.d/musterd-bwrap-userns
  # A box prepared by an earlier version of this script loaded UNCONFINED profiles under these
  # names; the exact-path Codex one would outrank the new pattern. Unload them first.
  printf 'profile musterd-bwrap {}\nprofile musterd-codex-bwrap {}\n' | apparmor_parser -R 2>/dev/null || true
  apparmor_parser -r /etc/apparmor.d/musterd-bwrap-userns
  if aa-status 2>/dev/null | grep -qE '^\s+musterd-(codex-)?bwrap$'; then
    echo "stale unconfined bwrap profile still loaded" >&2
    exit 1
  fi
fi

echo
tailscale status >/dev/null 2>&1 || echo "tailscale is not up: as root, \`tailscale up\` (or re-run with TS_AUTHKEY set)"
echo "prep done. Next, as $USER_NAME (ssh $USER_NAME@<this box>):"
echo "  gh auth login · claude (then /login) · codex login --device-auth"
echo "  then: bootstrap.sh machine   (docs/guides/second-machine.md, Linux section)"

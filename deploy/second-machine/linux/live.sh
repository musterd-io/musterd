#!/bin/bash
# One /live publisher tick on a Linux hub box — the systemd twin of the launchd build-publisher that
# `musterd service install --live` generates on macOS (ADR 132; the generated script is the reference,
# and this one keeps its shape: fetch, detach the service-owned worktree on origin/main, build protocol
# + web, publish into the daemon's web-root by atomic swap, stamp the published SHA). The daemon runs
# with `--web-root` and serves the bundle from its own origin: no dev server, no daemon restart.
#
# Left out on purpose: the musterd.io site-gap ask (ADR 734). One deploy authorizer, one asker — the
# laptop publisher keeps that job; two publishers would raise the same ask twice.
set -u
RUNTIME="$HOME/.musterd/runtime"
LIVE="$HOME/.musterd/live"
WORKTREE="$LIVE/checkout"
WEBROOT="$LIVE/web"
STAMP="$WEBROOT/.published-sha"
stamp() { date '+%F %T'; }

# An open tab's lazy chunks survive the swap: carry the previous bundle's own assets (and anything
# published in the last hour) into the new one, so a page loaded before the publish still resolves.
carry_retired_assets() {
  local old="$WEBROOT/assets" f
  ls "$SRC/assets" > "$STAGE/.own-assets" 2>/dev/null || true
  [ -d "$old" ] || return 0
  mkdir -p "$STAGE/assets"
  for f in "$old"/*; do
    [ -f "$f" ] || continue
    f="${f##*/}"
    [ -e "$STAGE/assets/$f" ] && continue
    if grep -qxF "$f" "$WEBROOT/.own-assets" 2>/dev/null; then
      cp "$old/$f" "$STAGE/assets/$f"
    elif [ -n "$(find "$old/$f" -mmin -60)" ]; then
      cp -p "$old/$f" "$STAGE/assets/$f"
    fi
  done
}

# A missing worktree is re-created, never a quiet no-op (the macOS script's 2026-07-24 lesson).
if [ ! -e "$WORKTREE/.git" ]; then
  echo "$(stamp) worktree missing at $WORKTREE — creating it from $RUNTIME"
  git -C "$RUNTIME" worktree prune 2>&1 || true
  git -C "$RUNTIME" fetch --quiet origin main 2>&1 || true
  git -C "$RUNTIME" worktree add --detach "$WORKTREE" origin/main 2>&1 || {
    echo "$(stamp) worktree create FAILED — /live serves a stale bundle until this is fixed"
    exit 1
  }
fi
cd "$WORKTREE" || { echo "$(stamp) cannot cd to $WORKTREE"; exit 1; }

git fetch --quiet origin main 2>/dev/null || exit 0
TIP="$(git rev-parse origin/main 2>/dev/null || true)"
PUBLISHED="$(cat "$STAMP" 2>/dev/null || true)"
# Already on tip and that tip is what was last published: the poll stays cheap. (Not index.html
# alone: a failed build leaves an older bundle in place and would never retry.)
if [ "$(git rev-parse HEAD 2>/dev/null)" = "$TIP" ] && [ -n "$TIP" ] && [ "$PUBLISHED" = "$TIP" ]; then
  exit 0
fi
# --force: the worktree is service-owned, and a build can rewrite a tracked file (routeTree.gen.ts).
if ! git checkout --quiet --force --detach origin/main 2>&1; then
  echo "$(stamp) checkout FAILED — serving $(git rev-parse --short HEAD 2>/dev/null) until this is fixed"
  exit 1
fi
echo "$(stamp) building $(git rev-parse --short HEAD)"

# The build transcript is printed only on failure: a successful publish is one line.
BUILD_OUT="$(mktemp -t musterd-live-build.XXXXXX)"
trap 'rm -f "$BUILD_OUT"' EXIT
pnpm install --prefer-offline --silent > "$BUILD_OUT" 2>&1 || true
# Protocol first: web imports @musterd/protocol from dist.
if pnpm --filter @musterd/protocol build >> "$BUILD_OUT" 2>&1 && pnpm --filter @musterd/web build >> "$BUILD_OUT" 2>&1; then
  SRC="$WORKTREE/packages/web/dist/client"
  mkdir -p "$LIVE"
  STAGE="$LIVE/.web.next"
  rm -rf "$STAGE"
  cp -R "$SRC" "$STAGE"                       # stage on the web-root's own filesystem
  carry_retired_assets
  rm -rf "$WEBROOT.prev"
  [ -e "$WEBROOT" ] && mv "$WEBROOT" "$WEBROOT.prev"
  mv "$STAGE" "$WEBROOT"                       # atomic swap into place
  rm -rf "$WEBROOT.prev"
  git rev-parse HEAD > "$STAMP"
  echo "$(stamp) published $(git rev-parse --short HEAD) → $WEBROOT"
else
  echo "$(stamp) web build failed; keeping the previously published bundle. Build output:"
  cat "$BUILD_OUT"
fi

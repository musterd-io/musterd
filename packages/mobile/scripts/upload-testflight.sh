#!/usr/bin/env bash
# Upload a build to TestFlight with fastlane, skipping EAS Submit's queue
# (docs/architecture/09-mobile.md). It reads the App Store Connect API key config at
# ~/.appstoreconnect/fastlane-musterd.json, which stays on this machine, and needs Xcode.
#
#   packages/mobile/scripts/upload-testflight.sh path/to/musterd.ipa  # a local `eas build --local`
#   packages/mobile/scripts/upload-testflight.sh                      # the latest EAS cloud build
#   packages/mobile/scripts/upload-testflight.sh <build-id>           # one EAS cloud build
set -euo pipefail
cd "$(dirname "$0")/.."
key="${ASC_API_KEY_JSON:-$HOME/.appstoreconnect/fastlane-musterd.json}"
[ -f "$key" ] || { echo "no API key config at $key (see 09-mobile.md)" >&2; exit 1; }
# altool can print a resume-file error and fail the fastlane action after the upload itself
# succeeded (2026-10-30, builds 33 and 34). Its own "UPLOAD SUCCEEDED" line is the truth.
upload() {
  local log status=0
  log=$(mktemp)
  FASTLANE_SKIP_UPDATE_CHECK=1 fastlane run upload_to_testflight api_key_path:"$key" ipa:"$1" \
    skip_waiting_for_build_processing:true 2>&1 | tee "$log" || status=$?
  if [ "$status" -ne 0 ] && grep -q "UPLOAD SUCCEEDED" "$log"; then
    echo "altool reported UPLOAD SUCCEEDED; the error after it is not a failed upload."
    status=0
  fi
  rm -f "$log"
  return "$status"
}
if [ $# -ge 1 ] && [ -f "$1" ]; then
  if [ -n "${DRY_RUN:-}" ]; then echo "dry run: would upload $1 ($(du -h "$1" | cut -f1))"; exit 0; fi
  upload "$1"
  exit $?
fi
if [ $# -ge 1 ]; then
  json=$(npx -y eas-cli@latest build:view "$1" --json)
else
  json=$(npx -y eas-cli@latest build:list --platform ios --status finished --limit 1 --json --non-interactive)
fi
# Two plain lines (url, build number), parsed by python — bash 3.2's `read < <(…)` left both
# unset on nick's first run (2026-10-06).
fields=$(printf '%s' "$json" | python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    b = json.loads(raw[raw.index("{") if raw.lstrip().startswith("{") else raw.index("["):])
except Exception as e:
    sys.exit("could not read the build from eas-cli: %s" % e)
b = b[0] if isinstance(b, list) else b
print(b["artifacts"]["buildUrl"]); print(b["appBuildVersion"])
')
url=$(printf '%s\n' "$fields" | sed -n 1p)
build=$(printf '%s\n' "$fields" | sed -n 2p)
[ -n "$url" ] && [ -n "$build" ] || { echo "no finished build found" >&2; exit 1; }
ipa="$(mktemp -d)/musterd-$build.ipa"
echo "downloading build ${build}..."
curl -sSL -o "$ipa" "$url"
if [ -n "${DRY_RUN:-}" ]; then echo "dry run: would upload $ipa ($(du -h "$ipa" | cut -f1))"; exit 0; fi
upload "$ipa"

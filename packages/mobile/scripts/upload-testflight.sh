#!/usr/bin/env bash
# Upload a finished EAS build to TestFlight with fastlane, skipping EAS Submit's queue
# (docs/architecture/09-mobile.md). Run it yourself: it reads the App Store Connect API key
# config at ~/.appstoreconnect/fastlane-musterd.json, which stays on this machine.
#
#   packages/mobile/scripts/upload-testflight.sh            # the latest iOS build
#   packages/mobile/scripts/upload-testflight.sh <build-id>
set -euo pipefail
cd "$(dirname "$0")/.."
key="${ASC_API_KEY_JSON:-$HOME/.appstoreconnect/fastlane-musterd.json}"
[ -f "$key" ] || { echo "no API key config at $key (see 09-mobile.md)" >&2; exit 1; }
if [ $# -ge 1 ]; then
  view=$(npx -y eas-cli@latest build:view "$1" --json)
else
  view=$(npx -y eas-cli@latest build:list --platform ios --status finished --limit 1 --json --non-interactive | python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin)[0]))')
fi
read -r url build < <(python3 -c 'import json,sys;b=json.loads(sys.argv[1]);print(b["artifacts"]["buildUrl"],b["appBuildVersion"])' "$view")
ipa="$(mktemp -d)/musterd-$build.ipa"
echo "downloading build $build…"
curl -sSL -o "$ipa" "$url"
FASTLANE_SKIP_UPDATE_CHECK=1 fastlane run upload_to_testflight api_key_path:"$key" ipa:"$ipa" skip_waiting_for_build_processing:true

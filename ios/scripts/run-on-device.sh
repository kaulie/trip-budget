#!/usr/bin/env bash
#
# Build, install and launch Trip Budget on a connected iPhone.
#
#   ./scripts/run-on-device.sh                 # auto-detect the phone
#   ./scripts/run-on-device.sh <device-udid>
#
# Environment overrides:
#   DEVELOPMENT_TEAM   Apple team id (default: JD4B775BJ5)
#   TRIP_BUDGET_API    dev server URL (default: http://<this-Mac-LAN-IP>:4000)
#   BUNDLE_ID          bundle identifier override
#
# Notes for a physical device:
#   * the app must reach the dev server over the LAN, so the server has to be
#     started with HOST=0.0.0.0 (the default) and the phone must be on the same
#     Wi-Fi / USB network;
#   * iOS 14+ asks for Local Network permission the first time (Info.plist
#     already explains why);
#   * a free Apple ID is limited to 3 sideloaded apps per device and the
#     provisioning profile expires after 7 days.
set -euo pipefail

cd "$(dirname "$0")/.."

DEVICE_ID="${1:-}"
if [[ -z "$DEVICE_ID" ]]; then
  # `xcodebuild -showdestinations` prints the hardware UDID that `-destination`
  # and `devicectl --device` both accept. (`devicectl list devices` prints a
  # CoreDevice identifier instead, which `-destination` rejects.)
  DEVICE_ID="$(xcodebuild -project TripBudget.xcodeproj -scheme TripBudget -showdestinations 2>/dev/null \
    | sed -n 's/.*platform:iOS, arch:arm64, id:\([^,]*\), name:.*/\1/p' | head -1)"
fi
if [[ -z "$DEVICE_ID" ]]; then
  echo "No paired iPhone found. Connect it, trust this Mac, then retry." >&2
  exit 1
fi

TEAM="${DEVELOPMENT_TEAM:-JD4B775BJ5}"
BUNDLE_ID="${BUNDLE_ID:-com.gaolei.tripbudget}"

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
API="${TRIP_BUDGET_API:-http://${LAN_IP:-127.0.0.1}:4000}"

echo "device : $DEVICE_ID"
echo "team   : $TEAM"
echo "bundle : $BUNDLE_ID"
echo "api    : $API"

if ! curl -s -m 3 "$API/health" >/dev/null; then
  echo "warning: $API/health did not answer — is the server running?" >&2
fi

xcodebuild \
  -project TripBudget.xcodeproj \
  -scheme TripBudget \
  -destination "platform=iOS,id=$DEVICE_ID" \
  -derivedDataPath build-device \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
  build

APP="build-device/Build/Products/Debug-iphoneos/TripBudget.app"
xcrun devicectl device install app --device "$DEVICE_ID" "$APP"

# The env var wins over Info.plist, so a device build does not need the LAN IP
# baked in.
xcrun devicectl device process launch \
  --device "$DEVICE_ID" \
  --terminate-existing \
  --environment-variables "{\"TRIP_BUDGET_API\":\"$API\"}" \
  "$BUNDLE_ID"

echo
echo "Launched. Grant Microphone / Speech Recognition / Local Network when asked,"
echo "then say: 我付了 500，我们三个人吃饭，其中小王和小李也要分摊"

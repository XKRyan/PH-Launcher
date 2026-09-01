#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")/.."

for name in APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do
  if ! value="$(printenv "$name")" || [[ -z "$value" ]]; then
    echo "Missing notarization credential: $name" >&2
    exit 1
  fi
done

setopt null_glob
disk_images=(release/PH-Launcher-*-macOS-universal.dmg)
if (( ${#disk_images} != 1 )); then
  echo "Expected exactly one Universal DMG in release/." >&2
  exit 1
fi

disk_image="$disk_images[1]"
xcrun notarytool submit "$disk_image" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait
xcrun stapler staple "$disk_image"
xcrun stapler validate "$disk_image"

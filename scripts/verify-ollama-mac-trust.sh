#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")/.."

version="$(node -p "require('./electron/ai-deployment.cjs').OLLAMA_MAC_VERSION")"
expected_hash="$(node -p "require('./electron/ai-deployment.cjs').OLLAMA_MAC_SHA256")"
team_id="$(node -p "require('./electron/ai-deployment.cjs').OLLAMA_MAC_TEAM_ID")"
bundle_id="$(node -p "require('./electron/ai-deployment.cjs').OLLAMA_MAC_BUNDLE_ID")"
download_url="$(node -p "require('./electron/ai-deployment.cjs').OLLAMA_MAC_DOWNLOAD_URL")"

temporary_directory="$(mktemp -d -t ph-launcher-ollama-trust)"
mount_point="$temporary_directory/mount"
disk_image="$temporary_directory/Ollama.dmg"
mounted=0

cleanup() {
  if [[ "$mounted" == "1" ]]; then
    /usr/bin/hdiutil detach "$mount_point" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$temporary_directory"
}
trap cleanup EXIT

mkdir -m 700 "$mount_point"
curl --fail --location --retry 4 --retry-all-errors --output "$disk_image" "$download_url"

actual_hash="$(/usr/bin/shasum -a 256 "$disk_image" | /usr/bin/awk '{print $1}')"
[[ "$actual_hash" == "$expected_hash" ]] || { echo "Ollama.dmg SHA-256 mismatch" >&2; exit 1; }

/usr/bin/hdiutil verify "$disk_image"
/usr/sbin/spctl --assess --type open --context context:primary-signature --verbose=4 "$disk_image"
/usr/bin/hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$mount_point" "$disk_image"
mounted=1

app_path="$mount_point/Ollama.app"
[[ -d "$app_path" && ! -L "$app_path" ]] || { echo "Ollama.app missing from disk image" >&2; exit 1; }
requirement="anchor apple generic and identifier \"$bundle_id\" and certificate leaf[subject.OU] = \"$team_id\""
/usr/bin/codesign --verify --deep --strict --verbose=4 -R="$requirement" "$app_path"
signature_details="$(/usr/bin/codesign --display --verbose=4 "$app_path" 2>&1)"
print -r -- "$signature_details" | /usr/bin/grep -Fx "Identifier=$bundle_id"
print -r -- "$signature_details" | /usr/bin/grep -Fx "TeamIdentifier=$team_id"
/usr/sbin/spctl --assess --type execute --verbose=4 "$app_path"

echo "Verified Ollama v$version: bundle=$bundle_id team=$team_id sha256=$actual_hash"

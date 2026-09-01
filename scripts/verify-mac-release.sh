#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")/.."
setopt null_glob

expected_bundle_id="cn.phlauncher.desktop"
expected_team_id="${EXPECTED_APPLE_TEAM_ID:-}"
[[ -n "$expected_team_id" ]] || { echo "Missing EXPECTED_APPLE_TEAM_ID" >&2; exit 1; }
print -r -- "$expected_team_id" | /usr/bin/grep -Eq '^[A-Z0-9]{10}$' || {
  echo "EXPECTED_APPLE_TEAM_ID must be a 10-character Apple Team ID" >&2
  exit 1
}

verify_all_macho_universal() {
  setopt local_options glob_dots null_glob
  local app_path="$1"
  local label="$2"
  local candidate description architectures relative_path
  local macho_count=0

  for candidate in "$app_path"/Contents/**/*(.); do
    description="$(/usr/bin/file -b "$candidate")"
    [[ "$description" == *"Mach-O"* ]] || continue
    architectures="$(/usr/bin/lipo -archs "$candidate")"
    relative_path="${candidate#"$app_path"/}"
    if [[ " $architectures " != *" arm64 "* || " $architectures " != *" x86_64 "* ]]; then
      echo "$label contains a non-Universal Mach-O file: $relative_path ($architectures)" >&2
      return 1
    fi
    (( macho_count += 1 ))
  done

  (( macho_count > 0 )) || { echo "$label contains no Mach-O files" >&2; return 1; }
  echo "Verified $macho_count Universal Mach-O files in $label."
}

verify_app_bundle() {
  local app_path="$1"
  local label="$2"
  local bundle_id requirement signature_details

  [[ -d "$app_path" && ! -L "$app_path" ]] || { echo "$label is missing or unsafe" >&2; return 1; }
  bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app_path/Contents/Info.plist")"
  [[ "$bundle_id" == "$expected_bundle_id" ]] || {
    echo "$label bundle ID mismatch: expected $expected_bundle_id, got $bundle_id" >&2
    return 1
  }

  requirement="anchor apple generic and identifier \"$expected_bundle_id\" and certificate leaf[subject.OU] = \"$expected_team_id\""
  /usr/bin/codesign --verify --deep --strict --verbose=4 -R="$requirement" "$app_path"
  signature_details="$(/usr/bin/codesign --display --verbose=4 "$app_path" 2>&1)"
  print -r -- "$signature_details" | /usr/bin/grep -Fx "Identifier=$expected_bundle_id" >/dev/null
  print -r -- "$signature_details" | /usr/bin/grep -Fx "TeamIdentifier=$expected_team_id" >/dev/null
  verify_all_macho_universal "$app_path" "$label"
}

disk_images=(release/PH-Launcher-*-macOS-universal.dmg)
zip_archives=(release/PH-Launcher-*-macOS-universal.zip)
installers=(release/PH-Launcher-*-macOS-universal.pkg)
if (( ${#disk_images} != 1 || ${#zip_archives} != 1 || ${#installers} != 1 )); then
  echo "Expected one Universal DMG, ZIP and PKG in release/." >&2
  exit 1
fi

disk_image="$disk_images[1]"
zip_archive="$zip_archives[1]"
installer="$installers[1]"
temporary_directory="$(mktemp -d -t ph-launcher-release-verify)"
mount_point="$temporary_directory/mount"
mounted=0

cleanup() {
  if [[ "$mounted" == "1" ]]; then
    /usr/bin/hdiutil detach "$mount_point" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$temporary_directory"
}
trap cleanup EXIT

/usr/bin/hdiutil verify "$disk_image"
/usr/sbin/spctl --assess --type open --context context:primary-signature --verbose=4 "$disk_image"
xcrun stapler validate "$disk_image"

mkdir -m 700 "$mount_point"
/usr/bin/hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$mount_point" "$disk_image"
mounted=1
app_path="$mount_point/PH Launcher.app"
verify_app_bundle "$app_path" "DMG app"
/usr/sbin/spctl --assess --type execute --verbose=4 "$app_path"
xcrun stapler validate "$app_path"

pkg_signature_details="$(LC_ALL=C /usr/sbin/pkgutil --check-signature "$installer")"
print -r -- "$pkg_signature_details"
print -r -- "$pkg_signature_details" | /usr/bin/grep -Eq "^[[:space:]]*1\\. Developer ID Installer: .*\\(${expected_team_id}\\)[[:space:]]*$" || {
  echo "PKG is not signed by Developer ID Installer team $expected_team_id" >&2
  exit 1
}
/usr/sbin/spctl --assess --type install --verbose=4 "$installer"
xcrun stapler validate "$installer"

mkdir -m 700 "$temporary_directory/zip"
/usr/bin/ditto -x -k "$zip_archive" "$temporary_directory/zip"
zip_app="$temporary_directory/zip/PH Launcher.app"
verify_app_bundle "$zip_app" "ZIP app"
/usr/sbin/spctl --assess --type execute --verbose=4 "$zip_app"
xcrun stapler validate "$zip_app"

echo "Bundle identity, Apple signing team, all Mach-O architectures, Gatekeeper assessments and notarization tickets are valid."

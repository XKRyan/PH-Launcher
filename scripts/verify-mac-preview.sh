#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")/.."
setopt null_glob

disk_images=(release/PH-Launcher-*-macOS-universal.dmg)
zip_archives=(release/PH-Launcher-*-macOS-universal.zip)
if (( ${#disk_images} != 1 || ${#zip_archives} != 1 )); then
  echo "Expected exactly one Universal DMG and one Universal ZIP in release/." >&2
  exit 1
fi

disk_image="$disk_images[1]"
zip_archive="$zip_archives[1]"
temporary_directory="$(mktemp -d -t ph-launcher-mac-preview)"
mount_point="$temporary_directory/mount"
mounted=0

cleanup() {
  if [[ "$mounted" == "1" ]]; then
    /usr/bin/hdiutil detach "$mount_point" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$temporary_directory"
}
trap cleanup EXIT

verify_universal_app() {
  setopt local_options glob_dots null_glob
  local app_path="$1"
  local label="$2"
  local bundle_id executable candidate description architectures
  local macho_count=0

  [[ -d "$app_path" && ! -L "$app_path" ]] || { echo "$label is missing or unsafe" >&2; return 1; }
  bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app_path/Contents/Info.plist")"
  [[ "$bundle_id" == "cn.phlauncher.desktop" ]] || { echo "$label bundle ID mismatch: $bundle_id" >&2; return 1; }
  executable="$app_path/Contents/MacOS/PH Launcher"
  [[ -x "$executable" ]] || { echo "$label executable is missing" >&2; return 1; }
  [[ -f "$app_path/Contents/Resources/dictionary/ecdict.db" ]] || { echo "$label offline dictionary is missing" >&2; return 1; }
  [[ -f "$app_path/Contents/Resources/icon.icns" ]] || { echo "$label macOS icon is missing" >&2; return 1; }

  /usr/bin/codesign --verify --deep --strict --verbose=2 "$app_path"
  local signature_details
  signature_details="$(/usr/bin/codesign --display --verbose=4 "$app_path" 2>&1)"
  [[ "$signature_details" == *"Signature=adhoc"* ]] || {
    echo "$label is not ad-hoc signed as required for this preview." >&2
    return 1
  }
  [[ "$signature_details" == *"TeamIdentifier=not set"* ]] || {
    echo "$label unexpectedly contains a developer team identity." >&2
    return 1
  }
  [[ "$signature_details" != *"Authority=Developer ID Application"* ]] || {
    echo "$label unexpectedly contains a Developer ID signature." >&2
    return 1
  }

  for candidate in "$app_path"/Contents/**/*(.); do
    description="$(/usr/bin/file -b "$candidate")"
    [[ "$description" == *"Mach-O"* ]] || continue
    architectures="$(/usr/bin/lipo -archs "$candidate")"
    if [[ " $architectures " != *" arm64 " || " $architectures " != *" x86_64 " ]]; then
      echo "$label contains a non-Universal Mach-O file: ${candidate#"$app_path"/} ($architectures)" >&2
      return 1
    fi
    (( macho_count += 1 ))
  done
  (( macho_count > 0 )) || { echo "$label contains no Mach-O files" >&2; return 1; }
  echo "Verified $macho_count Universal Mach-O files in $label."
}

/usr/bin/hdiutil verify "$disk_image"
mkdir -m 700 "$mount_point"
/usr/bin/hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$mount_point" "$disk_image"
mounted=1

verify_universal_app "$mount_point/PH Launcher.app" "DMG app"
[[ -L "$mount_point/Applications" && "$(readlink "$mount_point/Applications")" == "/Applications" ]] || {
  echo "DMG Applications link is missing or points elsewhere." >&2
  exit 1
}
[[ -f "$mount_point/首次打开帮助.html" ]] || { echo "DMG first-open help is missing." >&2; exit 1; }
/usr/bin/grep -F "没有 Developer ID 身份签名且未经 Apple 公证" "$mount_point/首次打开帮助.html" >/dev/null
/usr/bin/grep -F "support.apple.com/zh-cn/guide/mac-help/-mh40616/mac" "$mount_point/首次打开帮助.html" >/dev/null

/usr/bin/hdiutil detach "$mount_point"
mounted=0
mkdir -m 700 "$temporary_directory/zip"
/usr/bin/ditto -x -k "$zip_archive" "$temporary_directory/zip"
verify_universal_app "$temporary_directory/zip/PH Launcher.app" "ZIP app"

echo "Mac preview contains an ad-hoc signed Universal app, branded DMG layout, first-open help and offline dictionary."

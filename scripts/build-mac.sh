#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")/.."

npm ci
npm test
npm run dist:mac

app_path="release/mac-universal/PH Launcher.app"
executable="$app_path/Contents/MacOS/PH Launcher"
dictionary="$app_path/Contents/Resources/dictionary/ecdict.db"
[[ -d "$app_path" && ! -L "$app_path" && -x "$executable" && -f "$dictionary" ]] || {
  echo "Universal app bundle or offline dictionary is missing" >&2
  exit 1
}

echo "Mac 测试包已构建：release/ 中包含 Universal DMG、ZIP 与 PKG。未签名测试包不能直接分发；正式版还需 Developer ID 签名、Apple 公证与 Mac 实机验证。"

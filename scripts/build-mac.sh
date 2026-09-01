#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")/.."

npm ci
npm test
npm run self-test
npm run dist:mac

echo "Mac 构建完成，文件位于 release/。正式分发前仍需验证签名、公证与 Mac 实机功能。"

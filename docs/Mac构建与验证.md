# PH Launcher macOS 构建与验证

PH Launcher 的 Windows 与 Mac 版本共用一套源代码。Mac 正式版目标是一个已签名、已公证的 Universal 应用，同时支持 Apple 芯片与 Intel Mac。

> 当前仓库已同步 0.5.0 Mac 源码与未签名自动测试构建，但尚无可分享的 Mac 正式包。GitHub Actions 测试产物只用于开发验证。

## 给同学安装

未来正式发布后，首选文件将是 `PH-Launcher-0.5.0-macOS-universal.pkg`：双击后按 macOS“安装器”提示即可放入“应用程序”。DMG 是备用方式，打开后把 PH Launcher 拖入“应用程序”。ZIP 主要用于自动更新或排查问题。

只有通过 Developer ID 签名、Apple 公证、Gatekeeper 验证和 Mac 实机测试的文件才可作为正式版分发。系统仍可能要求用户确认安装或输入本机管理员密码；应用不得通过脚本关闭 Gatekeeper 或绕过这些提示。

## 本地构建测试包

需要 macOS、Node.js 22 与 Xcode Command Line Tools。若源码中没有离线词典，先执行 `npm run dictionary:prepare`；随后执行：

```zsh
zsh scripts/build-mac.sh
```

结果位于 `release/`，包含 Universal DMG、ZIP 与 PKG。此命令关闭自动证书发现，生成的未签名文件只用于开发验证，不能直接分享。

## 正式发布

仓库中的 `Release signed macOS packages` 工作流负责 Universal 构建、Developer ID 签名、Apple 公证、票据装订、Gatekeeper 检查、架构检查、SHA-256 清单与 GitHub Release 上传。工作流需要以下 GitHub Actions Secrets：

- `MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD`：Developer ID Application 证书及密码。
- `MAC_CSC_INSTALLER_LINK`、`MAC_CSC_INSTALLER_KEY_PASSWORD`：Developer ID Installer 证书及密码。
- `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`：Apple 公证凭据与团队标识。

正式构建必须验证：应用标识为 `cn.phlauncher.desktop`；应用与 PKG 的 Team ID 与发布账号一致；所有 Mach-O 文件同时包含 `arm64` 和 `x86_64`；DMG、PKG、ZIP 内的应用都通过 Gatekeeper 与公证票据验证；已签名应用的自检能读取钥匙串加密数据和随包离线词典。

应用的 Hardened Runtime 权限只保留 Electron 运行所需的 JIT 例外，不允许未签名可执行内存，也不关闭动态库校验。若未来引入原生组件，必须先证明必要性并补充回归测试，不能为了让签名暂时通过而扩大权限。

## 实机验收

至少在一台 Apple 芯片 Mac 上原生安装，并在 Intel Mac 或等效的 Intel 环境再验证一次。重点检查：首次安装与升级、学校网站登录和弹窗、简洁显示、离线词典、课程提醒、EduPage 常规课表预览、AI 更改确认、钥匙串跨版本解密、菜单栏图标、全屏和全局快捷键。

## 本地 AI

Apple 芯片 Mac 会按统一内存和可用磁盘空间给出保守模型建议；Intel Mac 默认不推荐本地模型，因为 Ollama 只能使用 CPU。未安装 Ollama 时，PH Launcher 会下载固定版本的官方 DMG，核对 SHA-256、Bundle ID、Apple Team ID、代码签名与 Gatekeeper 公证结果，再安装到当前用户的 `~/Applications`。它不会覆盖已有应用，也不会绕过 macOS 安全机制。

PH Launcher 可运行于 macOS 13 或更高版本；当前一键部署使用的 Ollama 要求 macOS 14 或更高版本。正式发布前仍须在真实 Mac 上验证这条完整链路。

# PH Launcher macOS 构建与验证

PH Launcher 的 Windows 与 Mac 版本使用同一套源代码。Mac 版目标为 macOS 13 或更高版本的 Universal 应用，可原生运行在 Apple 芯片与 Intel Mac 上。

## 在 Mac 上构建

1. 安装 Node.js 22、Xcode Command Line Tools，并准备稳定网络。
2. 在项目目录执行 `zsh scripts/build-mac.sh`。
3. 构建结果位于 `release` 文件夹，包括 Universal DMG 与 ZIP。

也可以把源码放入 GitHub 仓库，手动运行 `Build macOS test package` 工作流。该工作流只生成未签名测试包。

## 正式分发前必须完成

- 使用同一个 Apple Developer ID Application 证书签名。
- 使用 Apple 公证服务完成 notarization，并把公证票据装订到 DMG。
- 在 Apple 芯片 Mac 上原生验证，在 Intel Mac 或 Rosetta 环境中再验证一次。
- 核对应用版本信息、Universal 架构、签名、公证与 Gatekeeper 结果。
- 完整测试三所学校网站登录与弹窗、简洁显示、离线词典、课程提醒、EduPage 课表预览、AI 更改确认、钥匙串跨版本解密、菜单栏图标、全屏与全局快捷键。

## 本地 AI 的 Mac 差异

Apple 芯片电脑会按内存与磁盘空间推荐模型。Intel Mac 默认不推荐本地模型，因为只能使用 CPU，延迟与发热通常较高。Ollama 未安装时，PH Launcher 只打开官方安装页，由用户本人完成安装；不会执行来源不明的脚本。macOS 13 可以运行 PH Launcher，但当前 Ollama 需要 macOS 14 或更高版本。

未签名、未公证或未完成 Mac 实机验证的文件只能作为测试包，不适合直接发给同学安装。

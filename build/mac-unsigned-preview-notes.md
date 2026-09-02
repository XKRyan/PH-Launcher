# PH Launcher {{VERSION}} macOS Universal 未签名测试版

这是供自愿测试者体验的 **pre-release（预发布版本）**，不是面向所有同学的正式 Mac 版。

## 下载哪个文件

- 首选 `PH-Launcher-{{VERSION}}-macOS-universal.dmg`：打开后，把 PH Launcher 拖入“应用程序”。
- `PH-Launcher-{{VERSION}}-macOS-universal.zip`：仅作为 DMG 无法使用时的备用下载。
- `SHA256SUMS.txt`：用于核对下载文件是否与本发布页提供的文件一致。

DMG 与 ZIP 内是同一个 Universal 应用，可在 Apple 芯片和 Intel Mac 上运行。PH Launcher 本体要求 macOS 13 或更高版本；Mac 本地 AI 一键部署需要 macOS 14 或更高版本。

## 重要风险提示

本测试包只有用于启动兼容性的 **ad-hoc 临时签名**，没有 Developer ID 开发者身份签名，也没有经过 Apple 公证。macOS 无法确认开发者身份，也无法像正式公证版一样确认文件发布后是否被改动。运行未经 Developer ID 签名和公证的软件可能损害电脑或泄露隐私。

只应从 `https://github.com/XKRyan/PH-Launcher` 的预发布页面下载，并核对同一页面中的 SHA-256 清单。SHA-256 只能发现文件不一致，不能替代 Developer ID 签名或 Apple 公证。对来源或校验结果有疑问时，请不要打开。

## 第一次打开

1. 打开 DMG，把 PH Launcher 拖到“应用程序”。
2. 从“应用程序”中尝试打开 PH Launcher，让 macOS 显示安全提醒。
3. 打开“系统设置”→“隐私与安全性”，向下滚动到“安全性”。
4. 找到 PH Launcher 的提示，点按“仍要打开”，再确认“打开”。系统可能要求输入当前 Mac 的登录密码。

Apple 说明，“仍要打开”通常在尝试打开 App 后约一小时内可用：
https://support.apple.com/zh-cn/guide/mac-help/-mh40616/mac

不需要运行任何终端命令，也不要关闭 macOS 的安全功能。

## 建议测试

- 首次安装、重新打开和覆盖升级。
- 学校邮箱、ManageBac、EduPage 的登录保持。
- 简洁显示、离线词典、课程提醒、计划和快捷键。
- Apple 芯片电脑上的本地 AI 推荐与一键部署；Intel Mac 建议优先测试 API AI。

反馈问题时，请提供 Mac 型号、macOS 版本、使用 DMG 还是 ZIP，以及可复现步骤。请勿提交密码、Cookie、API Key、课程隐私数据或截图中的个人信息。

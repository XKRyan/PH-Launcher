# PH Launcher

PH Launcher 是面向平和 IB 学生的开源桌面学习工作台。它把学校邮箱、ManageBac、EduPage、课程表、待办、笔记、专注计时、离线英汉词典、IB 工具和可选 AI 放在一个安静、统一的界面中。

> 本项目是独立学生工具，不是上海市民办平和学校、ManageBac、EduPage、网易或 Ollama 的官方产品，也不使用校徽。

![PH Launcher 主界面](docs/images/overview.png)

## 发布状态

| 平台或版本 | 当前状态 | 说明 |
| --- | --- | --- |
| Windows x64 v0.4.1 | [已正式发布](https://github.com/XKRyan/PH-Launcher/releases/tag/v0.4.1) | 提供安装版与免安装版；Windows 目前没有商业代码签名证书，可能显示“未知发布者”。 |
| 0.5.0 源码 | 已同步 | Windows 与 macOS 共用的 0.5.0 源码、测试和自动构建流程已进入 main；这不等于发布了新的正式安装包。 |
| macOS 0.5.0 | 自动测试构建已启用 | main 更新会生成未签名 Universal 测试产物，仅供开发验证。正式 Mac 包仍需 Developer ID 签名、Apple 公证、Gatekeeper 检查和 Mac 实机安装验证。 |

目前可分享给同学的稳定下载仍是 Windows v0.4.1。请只从上方 Release 获取文件，并用同一 Release 附带的 `PH-Launcher-0.4.1-SHA256.txt` 核对。不要分享 GitHub Actions 生成的未签名 Mac 测试产物。

## 主要功能

- 三个学校网站使用相互隔离的登录空间，并提供可随时关闭的“简洁显示”。
- 本地课程表、上课提醒、任务、笔记、专注计时和可配置全局快捷键。
- 77 万余条 ECDICT 离线英汉词条，以及 IB 指令词、写作统计、成绩计算和里程碑模板。
- 可选本地 AI 或兼容 OpenAI Chat Completions 的 HTTPS API。
- 每台电脑单独检测内存、显卡和磁盘后推荐本地模型；不合适的电脑会明确不推荐安装。
- AI 操作启动器默认关闭；所有数据更改先预览、后确认，不能读取密码、Cookie、验证码或 API Key。

完整操作说明见 [使用指南](docs/使用指南.md)，Mac 构建与验收边界见 [Mac 构建与验证](docs/Mac构建与验证.md)，0.5.0 的安全说明见 [发布与安全说明](docs/PH-Launcher-0.5.0-发布与安全说明.md)。

## 从源码运行

需要 Node.js 22：

```powershell
git clone https://github.com/XKRyan/PH-Launcher.git
Set-Location PH-Launcher
npm ci
npm run dictionary:prepare
npm test
npm run self-test
npm start
```

离线词典数据库约 126 MiB，超过 GitHub 普通 Git 文件限制，因此不会进入提交历史。`dictionary:prepare` 会从固定 ECDICT 提交下载 CSV、核对固定 SHA-256，再在本机生成数据库。

Windows 测试构建：

```powershell
npm run dist
npm run dist:installer
```

Mac 未签名测试构建必须在 macOS 上执行：

```zsh
zsh scripts/build-mac.sh
```

正式 Mac 发布还必须配置 Apple Developer ID Application／Installer 证书，完成 Apple 公证、票据装订、Gatekeeper、Universal 架构与实机验证。仓库和普通 CI 不包含证书、私钥或公证凭据。

## 隐私与安全

- PH Launcher 不读取或保存学校网站密码；Cookie 和登录状态由各网站的隔离会话处理。
- 笔记、任务、课程表、设置与专注记录默认保存在当前系统用户目录。
- AI 默认关闭。API 模式只会向用户选择的服务商发送主动提交或明确授权的内容。
- AI 不获得网站密码、Cookie、验证码、API Key、任意文件系统或任意网页脚本权限。
- EduPage 课表导入只生成预览并合并课程，不会因空结果删除已有课程。

发现安全问题请阅读 [安全政策](SECURITY.md)，不要在公开 issue 中提交账号、Cookie、密钥或学生个人信息。

## 项目结构

```text
electron/   Electron 主进程、网站隔离、AI、词典与课表提取
src/        最终用户界面
build/      macOS 权限与安装器文案
scripts/    词典、图标、签名与平台验证脚本
tests/      核心安全边界与功能测试
assets/     应用图标和第三方许可
docs/       使用、发布与平台验证文档
```

提交贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。PH Launcher 采用 [MIT License](LICENSE)；ECDICT 等第三方组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

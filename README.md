# PH Launcher

PH Launcher 是面向平和 IB 学生的开源桌面学习工作台。它把学校邮箱、ManageBac、EduPage、自选学习网站、课程表、待办、笔记、专注计时、离线英汉词典、IB 工具和可选 AI 放在一个安静、统一的界面中。

## 0.6 协作预览

PH Launcher × [Hello Pinghe! Launcher](https://github.com/huaziqian40-bot/Hello-Pinghe-Launcher)：XKRyan 与 huaziqian40-bot 的学生工具项目协作整合。本版以 PH Launcher 为主体，结合 Hello Pinghe! Launcher 的简洁学习面板设计与学校数据接口经验；保留双方署名。整合代码保存在本仓库，不改动同学的仓库。

- 语境背词：本地阅读、原句收词、多语境积累、拼写与回忆练习、FSRS 6 间隔复习、撤销、暂停词条、词本导入导出。
- 从每天半页开始：粘贴自己的阅读材料，逐词查词、标记生词、确认阅读记录。统计是自己确认的阅读量，不是理解程度或词汇量测试。
- 我的学校：通过本机已登录的 ManageBac／EduPage 会话读取课表、课程、成绩和作业，按教学组选课并查看详情；网站改版或登录过期时会提示回到原网页核对。
- 我的日程：周、月、年视图，点击日期新增或编辑本地日程。
- 账号记忆：仅在你同意后保存系统加密的密码，严格限定学校登录页，绝不自动提交。
- 六套外观配色、四种角色颜色和学习内容缩放。

这是整合预览，不代表 Hello Pinghe! Launcher 的全部功能已经移植。邮件客户端／通讯录、AI 代发邮件／代交作业、Word 起草、任意班级查询与四档代理权限仍未在此版实现；原学校网页功能继续保留。学校数据读取需在实际账号上核对，不能替代学校官方记录。详见 [本版说明](docs/PH-Launcher-0.6-协作预览.md)。

> 本项目是独立学生工具，不是上海市民办平和学校、ManageBac、EduPage、网易、IBO、IB Docs 或 Ollama 的官方产品，也不使用校徽。

![PH Launcher 主界面](docs/images/overview.png)

## 下载与状态

- Windows x64 提供安装版与免安装版；请以 [GitHub Releases](https://github.com/XKRyan/PH-Launcher/releases) 中实际存在的最新发布为准，并核对同一发布页的 SHA-256。Windows 目前没有商业代码签名证书，可能显示“未知发布者”。
- 标有 `mac-preview` 的 macOS 包是 Universal 未签名测试版，支持 Apple 芯片与 Intel Mac。它只有 ad-hoc 临时签名，没有 Developer ID 身份签名且未经 Apple 公证；请从完整预发布页下载、阅读风险提示并核对 SHA-256，不要把它当作正式版。
- Mac 正式版仍需 Developer ID 签名、Apple 公证、Gatekeeper 检查和更多实机安装验证。

## 主要功能

- 三个学校网站使用相互隔离的登录空间；“简洁显示”默认关闭，可按网站开启并随时恢复原网页，登录时长仍由原网站决定。
- 可添加最多 12 个自选 HTTPS 网站，分别保存登录状态、颜色、顺序与可选全局快捷键；换域名、删除或手动清理时会清除该网站的登录数据。
- 本地课程表、上课提醒、任务、笔记、专注计时和可配置全局快捷键。
- 77 万余条 ECDICT 离线英汉词条，以及可按科目、考试版本与 AO 查询的 IB 指令词、写作统计、成绩计算、里程碑模板和学习资源入口。
- 可选本地 AI 或兼容 OpenAI Chat Completions 的 HTTPS API；每台电脑单独检测内存、显卡和磁盘后推荐本地模型。
- AI 操作启动器默认关闭；所有数据更改先预览、后确认。AI 可打开已添加的网站，但不能读取自选网页内容、填写表单，也不能读取密码、Cookie、验证码或 API Key。

完整说明见 [使用指南](docs/使用指南.md)，Mac 构建边界见 [Mac 构建与验证](docs/Mac构建与验证.md)，本版安全说明见 [PH Launcher 0.5.1 发布与安全说明](docs/PH-Launcher-0.5.1-发布与安全说明.md)。

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

Windows 构建：`npm run dist` 和 `npm run dist:installer`。Mac 未签名测试构建必须在 macOS 上运行 `zsh scripts/build-mac.sh`。正式 Mac 发布还必须配置 Apple Developer ID Application／Installer 证书并完成公证、票据装订、Gatekeeper、Universal 架构与实机验证；仓库和普通 CI 不包含证书、私钥或公证凭据。

## 隐私与安全

网站密码由原网站和系统浏览器组件处理，PH Launcher 不读取或保存密码。笔记、任务、课程和专注记录默认保存在本机；导出备份不包含 API Key。云端 AI 只应接收用户主动提交或明确授权的数据。

IB Docs 仅作为带风险提示的第三方外部链接。PH Launcher 不内嵌、下载、缓存、镜像、索引或代理其中内容；仅在学校或权利人明确授权的情况下访问和使用。

发现安全问题请阅读 [SECURITY.md](SECURITY.md)，不要在公开 issue 中提交账号、Cookie、密钥或学生个人信息。第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 许可证

PH Launcher 以 [MIT License](LICENSE) 开源。

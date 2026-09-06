# PH Launcher

PH Launcher 是面向平和 IB 学生的开源桌面学习工作台。它把学校邮箱、ManageBac、EduPage、自选学习网站、课程表、待办、笔记、专注计时、离线英汉词典、IB 工具和可选 AI 放在一个安静、统一的界面中。

## 1.0.0 协作预览

PH Launcher × [Hello Pinghe! Launcher](https://github.com/huaziqian40-bot/Hello-Pinghe-Launcher)：XKRyan 与 huaziqian40-bot 的学生工具项目协作整合。本版以 PH Launcher 为主体，保留双方署名，并将学校认证适配代码整合到本仓库。组合发行版采用 GPL-3.0-or-later；来源与原 PH Launcher 的 MIT 条款见 [许可证](#许可证)。

- 背单词：分组认识新词后再回忆、打乱新词顺序、跳过已会词、保存自己的表达，以及可选的本地 AI 表达纠错；保留阅读收词、FSRS 6 间隔复习与词本导入导出。
- 从每天半页开始：粘贴自己的阅读材料，逐词查词、标记生词、确认阅读记录。统计是自己确认的阅读量，不是理解程度或词汇量测试。
- 学校应用五个入口：我的课表、我的日程、班级课表、我的课程、平和邮箱。ManageBac／EduPage 可在账号框中保存并登录；已保存账号可在启动后后台同步。
- 我的日程：周、月、年视图，点击日期新增或编辑本地日程。
- 账号记忆：仅在你同意后保存系统加密的密码；学校站点可单独选择“自动重新登录”，默认关闭。
- 六套外观配色联动顶部和窗口按钮；全局字号默认 16px，可在 14–24px 间调整。支持简体中文／English 界面，不翻译个人内容或学习材料。
- 专注时间可在 1–180 分钟间调整，可填写目标并在开始时打开选定学习页面；侧栏提供暂停、继续、结束和调整入口。

这是整合预览，不代表 Hello Pinghe! Launcher 的全部功能已经移植。AI 代发邮件／代交作业、邮件附件发送、自动标记已读、Word 起草、任意班级和全校空教室查询、不经确认的写入仍未在此版实现。学校数据不能替代官方记录。详见 [1.0 更新说明](docs/PH-Launcher-1.0-更新说明.md)。

> 本项目是独立学生工具，不是上海市民办平和学校、ManageBac、EduPage、网易、IBO、IB Docs 或 Ollama 的官方产品，也不使用校徽。

![PH Launcher 主界面](docs/images/overview.png)

## 下载与状态

- Windows x64 提供安装版与免安装版；请以 [GitHub Releases](https://github.com/XKRyan/PH-Launcher/releases) 中实际存在的最新发布为准，并核对同一发布页的 SHA-256。Windows 目前没有商业代码签名证书，可能显示“未知发布者”。
- `1.0.0` 提供 Windows x64 安装版／文件夹版，以及 Mac Universal 体验包。安装包可由开发者直接分享；源码位于 [1.0 分支](https://github.com/XKRyan/PH-Launcher/tree/codex/v1.0-release-check)，GitHub Releases 的发布进度可能不同。Mac 本体要求 macOS 13+，本地 AI 一键部署要求 macOS 14+；该包只有 ad-hoc 签名、没有 Developer ID 与 Apple 公证，首次打开需要手动确认。请核对随包 SHA-256 清单。

## 主要功能

- 三个学校网站使用相互隔离的登录空间，并保留原网页显示；“简洁显示”已废弃，登录时长仍由原网站决定。
- 学校自动刷新默认关闭。首次手动读取后，可在学校页面开启；仅当学校页面可见、每五分钟检查且结果过期时才会刷新。
- 可添加最多 12 个自选 HTTPS 网站，分别保存登录状态、颜色、顺序与可选全局快捷键；换域名、删除或手动清理时会清除该网站的登录数据。
- 本地课程表、上课提醒、任务、笔记、专注计时和可配置全局快捷键。
- 77 万余条 ECDICT 离线英汉词条，可从推荐词书选择 TOEFL、IELTS、CET、GRE 和高频阅读等参考词本，离线分批加入；不是考试机构官方词表。另有 60 词原创语境练习本、IB 指令词和学习工具。
- 新词每组最多 5 个：先认识，再回忆；可切换难度、跳过已会词、用语境填空。可选本地 AI（默认）或单独授权的 API 推荐下一组，结合已有候选词、难度和最近学习记录；不可用时回到离线排序。自评与简短测试只提供粗略起点，不是标准化测验。
- 完整权限经单独确认后，可按请求读取启动器中的课程、成绩、作业、课表、邮件、日程、笔记和词汇等学习内容。支持搜索宣讲会邮件并生成日程待确认清单；日期时间不清楚时须补充。所有写入仍需确认，不提供密码、Cookie 或任意电脑文件。API 模式会发送相应内容给所选服务商。
- AI 对话与手动保存的学习偏好在本机加密保存。更换模型或连接后，旧会话可查看但不自动发给新服务；使用 API 时，长期记忆默认不附加。
- 个人课表默认显示周一至周五，可显示周末；“我的课表”与“我的日程”分别设置提前提醒。课程、日程与专注结束使用独立大提醒窗口，可关闭或延后 5 分钟。提醒需要程序运行、电脑唤醒，学校提醒还需当前账号课表同步成功。
- 本地普通聊天逐步显示回复，可随时停止。选择本地 AI 时，程序启动后会后台准备已安装的服务与选定模型；选择 API 或暂不启用时，不启动或预热本地 AI。不会后台自动安装或下载模型。
- 邮件按钮和链接单独列在正文前，显示实际域名；点击并确认后用系统浏览器打开。邮件图片不自动加载，链接格式合法不代表网站可信。

完整说明见 [使用指南](使用指南.md)、[1.0 更新说明](docs/PH-Launcher-1.0-更新说明.md)，Mac 构建边界见 [Mac 构建与验证](Mac构建与验证.md)，历史版本安全说明见 [PH Launcher 0.5.1 发布与安全说明](PH-Launcher-0.5.1-发布与安全说明.md)。

## 学校功能使用

在“设置 → 网站 → 账号记忆”中为 ManageBac 或 EduPage 输入账号密码、确认风险后选择“保存并登录”，即可读取相应课表或课程，无需先打开原网页登录。已保存账号可在启动后后台同步；自动重新登录仍是独立选项，默认关闭。验证码、双重验证仍可能要求在原网页完成。EduPage 的授权登录与整周课表读取、ManageBac 的真实授权登录及课程列表读取均已完成验证；成绩、作业和调课仍应以原学校网页核对。平和邮箱可在应用内显示最近 100 封邮件、用附件标识提示邮件附档，并在正文前显示附件以便保存；这部分仅以测试邮件数据核对，真实收发仍待验证。网易邮箱可能需要客户端授权码，而非仅使用网页密码。

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

可选“账号记忆”只保存你主动输入并同意保存的账号密码，使用 Windows／macOS 系统密钥加密；ManageBac 与 EduPage 的“自动重新登录”须另行明确开启。平和邮箱凭据同样存于系统加密凭据库，且不会自动填入网站。账号密码不进入备份，也不提供给 AI；共享电脑不建议启用。笔记、任务、课程和专注记录默认保存在本机；导出备份不包含 API Key。云端 AI 只应接收用户主动提交或明确授权的数据。

IB Docs 仅作为带风险提示的第三方外部链接。PH Launcher 不内嵌、下载、缓存、镜像、索引或代理其中内容；仅在学校或权利人明确授权的情况下访问和使用。

发现安全问题请阅读 [SECURITY.md](SECURITY.md)，不要在公开 issue 中提交账号、Cookie、密钥或学生个人信息。第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 许可证

组合发行版以 [GNU GPL-3.0-or-later](LICENSE) 开源。原 PH Launcher 的 MIT 版权与许可文本保留在 [LICENSE-MIT-PH-Launcher.txt](LICENSE-MIT-PH-Launcher.txt)；学校认证来源和第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

# PH Launcher

PH Launcher 是为平和 IB 学生日常学习设计的一站式桌面工作台。它把学校邮箱、ManageBac、EduPage 和常用学习工具放进同一个安静、统一的界面，让查看通知、安排课程、记录任务和专注学习少一些来回切换。

## 它能做什么

- 在一个应用内打开学校邮箱、ManageBac 与 EduPage，并保留各网站的登录状态。
- “简洁显示”整理学校网站的背景、卡片、表单、间距与配色；遇到不兼容页面时可以随时关闭。
- 集成任务清单、课程表、上课提醒、笔记、专注计时和每周专注统计。
- 内置 77 万余条离线英汉词典词条，无网也能查询释义、音标、词形并朗读。
- 提供 IB 指令词速查、写作字数统计、加权成绩计算和 EE／TOK／IA 里程碑模板。
- 支持自定义全局快捷键，常用页面和工具可以快速唤出。

## AI 是可选的

不用 AI，PH Launcher 的学校网站入口和全部本地工具仍然可以完整使用。

需要时，可以选择本地 AI 或 API AI。PH Launcher 会根据每台电脑自己的内存、显卡和磁盘空间给出本地模型建议，符合条件时可一键部署推荐模型；配置较低的电脑会明确建议不要安装。

“AI 操作启动器”默认关闭。开启后，AI 可以帮助整理任务、笔记和课程表，也可以从已经打开的 EduPage 常规课表生成导入预览。任何数据更改都会先列出完整内容，只有本人确认后才保存。AI 不能读取密码、Cookie、验证码或 API Key，也不能删除资料、发送邮件或提交作业。

## 隐私与安全

学校账号密码由原网站和系统浏览器组件处理，PH Launcher 不读取或保存密码。笔记、任务、课程和专注记录默认保存在本机；备份文件不包含 API Key。云端 AI 可能接收你主动提交或明确授权的数据，因此不要发送账号密码、验证码、他人隐私或不应上传的作业材料。

PH Launcher 是独立制作的学生工具，不是上海市民办平和学校、ManageBac、EduPage 或网易的官方产品，也不使用校徽。

## 当前可用版本

Windows 版已经开源，提供安装版和免安装版，可从 [Windows v0.4.1 发布页](https://github.com/XKRyan/PH-Launcher/releases/tag/v0.4.1) 下载。

macOS 0.5.0 Universal 测试版可从 [Mac 预发布页](https://github.com/XKRyan/PH-Launcher/releases/tag/mac-preview-v0.5.0-1) 下载，Apple 芯片与 Intel Mac 通用，要求 macOS 13 或更高版本。它只有 ad-hoc 临时签名，没有 Developer ID 身份签名且未经 Apple 公证；请只转发预发布页，不要单独转发来源不明的安装包，并请同学先阅读发布页风险提示、核对 SHA-256 后再自愿试用。正式 Mac 版仍需 Apple 签名、公证与更多实机验证。

## 可直接转发的短介绍

我最近在用 PH Launcher：它把平和邮箱、ManageBac、EduPage、课程表、待办、笔记、专注计时、离线英汉词典和 IB 小工具放进了一个桌面应用。AI 完全可选，也能按每台电脑配置推荐本地模型；AI 想修改任务或课表时，必须先给出预览并由本人确认。它不是学校官方产品，也不会读取网站密码。Windows 下载：https://github.com/XKRyan/PH-Launcher/releases/tag/v0.4.1 。Mac 未签名测试版：https://github.com/XKRyan/PH-Launcher/releases/tag/mac-preview-v0.5.0-1 ，仅供了解风险并自愿参与测试的同学使用。

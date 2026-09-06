# 学校数据整合：开发与验收说明

## 主体与合作署名

采用 [XKRyan/PH-Launcher](https://github.com/XKRyan/PH-Launcher) 的 Electron 主体，保留已有 Windows / macOS 构建链、离线词典、笔记与 AI 接口。参照 [huaziqian40-bot/Hello-Pinghe-Launcher](https://github.com/huaziqian40-bot/Hello-Pinghe-Launcher) 的学校数据工作台，把课表、教学组选课、课程、作业与成绩放到同一入口。

面向用户的建议署名：**PH Launcher × Hello Pinghe! Launcher — 合作整合**。注明原项目作者 XKRyan、huaziqian40-bot 与各项目贡献者，并链接两个来源仓库。它不是学校官方软件，不代表 ManageBac 或 EduPage。

选择依据：同学版本是 Python / pywebview 的重新实现，直接整体迁移会同时更换桌面运行时、打包链、离线工具和现有数据格式。保留 Electron 主体并整合只读数据能力，不需要同学额外安装 Python。

## 来源与许可证

检查日期：2026-09-06。同学仓库提交：`86bdc7feacfe1d979340748046d77f3e4cb2fe89`。

- [同学项目 README](https://github.com/huaziqian40-bot/Hello-Pinghe-Launcher/blob/main/README.md) 声明 GPL-3.0-or-later，依赖 edupage-api。
- [同学项目第三方声明](https://github.com/huaziqian40-bot/Hello-Pinghe-Launcher/blob/main/THIRD_PARTY_NOTICES.md) 标明 PH Launcher 设计来源以及 ManageBac 数据页面参考。
- [EdupageAPI/edupage-api](https://github.com/EdupageAPI/edupage-api) 提供 EduPage 端点与字段定义的互操作参考；检查提交 `2450bef971eca0f23e76a554d0483c29d82894a3`。
- [Electron Session 文档](https://www.electronjs.org/docs/latest/api/session) 定义持久化 session 与其 fetch API。

本轮 `electron/school-data.cjs` 是为 Electron 新写的适配器，没有复制/打包同学项目或 edupage-api 的 Python 源文件，没有引入 GPL 运行时依赖；上述项目作为互操作与功能设计来源署名。不得把这句话扩展成“经过独立法律审查”或“洁净室实现”。今后如复制、翻译或链接其 GPL 实现，须重新处理整个组合发行版的 GPL 源码交付和版权声明，不能只在鸣谢里加一个链接便继续宣称整个组合仅为 MIT。

`.integration-reference` 仅为本地检查用的原仓库副本，不应进入应用包或公开源码提交。

## 实际接口

```js
const client = new SchoolDataClient({
  fetch: (siteId, url, init) => schoolSessions[siteId].fetch(url, init),
});
await client.syncManageBac();
await client.syncEduPage({ weekStart: '2026-09-07' });
await client.getCourseDetail('21');
await client.getTaskDetail('21', '31');
await client.getCoreOverview('cas'); // 或 ee
```

所有调用需要使用 PH Launcher 现有学校网页分区的 Session。用户先在内置原网页登录；模块不读取密码、不导出 Cookie，也不自行提交登录表单。

ManageBac 返回课程、明确标注的总评、作业卡片、课程单元、课程文件名称、课程日历以及 CAS / EE 摘要。年月不完整的截止日期保留原文 `dueText`，`dueAt` 留空；只有包含年月日、时间、时区的明确日期才可自动加入提醒。总评分数必须对应语义标签，不能假定侧栏第四格永远是成绩。文件链接指向原课程文件页面，不转存短时 S3 签名链接。

EduPage 返回带具体日期的七日课程、老师、教室、教学组选项、取消标记、未覆盖日期和当前班级名；必须与每周循环计划分开。取消课程不应触发上课提醒。服务器可能每次只返回一个或数个日期，模块针对尚未覆盖的日期继续读，最多七次。未读取到的日期列入 `missingDates`，不可显示为“无课”。用户选择教学组后才能视为“我的课表”。

`accountKey` 是 EduPage 服务器当前账户 ID 的截断哈希，不是安全令牌。它用于避免展示其他账号的旧快照，不替代身份验证。同步结束再次核对账号和班级，切换则拒绝混合结果。当前适配器不提供跨账号或跨班级批量查询。

## 允许的网络请求

| 网站 | 方法 | 路径 | 用途 |
| --- | --- | --- | --- |
| shph.managebac.cn | GET | `/student/classes/my?page=N` | 当前账号课程 |
| shph.managebac.cn | GET | `/student/classes/ID/units` | 总评、单元 |
| shph.managebac.cn | GET | `/student/classes/ID/core_tasks[/TASK_ID]` | 作业列表/详情 |
| shph.managebac.cn | GET | `/student/classes/ID/files` | 文件名称 |
| shph.managebac.cn | GET | `/student/classes/ID/events.json` | 课程日历 |
| shph.managebac.cn | GET | `/student/ib/activity/cas` | CAS 概览 |
| shph.managebac.cn | GET | `/student/ib/pbl/778` | 本校 EE 页面，页面 ID 变动时需更新 |
| pingheschool.edupage.org | GET | `/user` | 当前身份与科目字段映射 |
| pingheschool.edupage.org | GET | `/dashboard/eb.php?mode=ttday` | 当前课表读取令牌 |
| pingheschool.edupage.org | POST | `/gcall` | 仅 `action=loadData`, `changes={}` 的读操作 |

其他地址、方法、任意查询参数、带用户名密码的 URL、跨域重定向全部拒绝。网络错误不回显响应正文、令牌或 Cookie。HTML 使用 inert parser，不执行脚本；RPC 信封只按 JSON 解析，绝不 eval。读取上限为单页 8 MiB；同步分页、课程数、课程卡片数量均有限制。

## 上层必须遵守的边界

- IPC 仅允许可信主界面、主 frame 调用。网站页面不得直接获得这些方法。
- 首次读取需要用户明确同意隐私提示；不得在每次启动时自动采集全量成绩、联系人或邮箱。
- 账号数据默认不提供给 AI。用户针对当前内容请求 AI 辅助时，仅提供需要的摘要。
- 本模块不写入网站、不发邮件、不提交作业、不收集全校联系人。整合这些能力时须单独设计操作预览与逐次确认。
- 清除网站登录数据、退出学校账号或切换账号时，清空相关快照。ManageBac 当前没有可靠的稳定账户 ID 校验，不应跨登录复用其持久化快照。
- 只有用户确认后的课程/作业才写入本地计划；同步失败不得覆盖已有手工计划。
- UI 用转义后的纯文本显示所有字段，不能将学校响应或字段当 HTML 插入。保留“在原网页查看”和同步时间。

## 验证状态

`node --test tests/school-data.test.cjs`：18 / 18 通过。覆盖来源地址隔离、写请求拒绝、重定向、登录过期、HTML 脚本不执行、明确成绩标签、截止日期不猜年份、文件令牌不泄露、课表班级过滤、七日覆盖、停课、教学组、账号切换、详情 ID 校验，以及学校 UI 初始不自动联网、读取同意提示、显示文本转义、教学组未选择与选择为空的区别、同步错误提示。

这些测试使用自造 HTML / JSON 夹具，不包含学生账号或成绩。2026-09-06 无凭据访问真实 ManageBac 课程入口得到 HTTP 401，验证登录门槛仍存在。尚未用真实登录账号完成端到端验证，不能将此版本描述为“所有学校数据功能均已实测可用”。需要最终用户在自己的内置网页登录后，核对一周课表（尤其周五下午）、至少一门课的总评/作业、课程详情和 CAS / EE。该验收不需要向开发者提供密码。

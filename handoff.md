# 工作交接

## 2.0.6 统一任务与课程位置记忆（2026-11-03）

Assessment/Coursework 等 core_tasks 与课程 events.json 合并到“任务 / Tasks”，全局同步及单课列表使用同一合并规则；按来源 ID / core_tasks 链接去重，保留原类型，日历失败报告 partial 并保留旧记录。明确提交要求与类型分开，未知不推断；活动显示待参加、已开始、已结束，无需提交或要求未知的过期任务显示待核对，完成仍取网站状态。只在详情识别到对应 Dropbox 表单/链接且不明确禁止提交时显示上传入口。事件详情展示日程和描述，不调用作业提交接口。活动结束移出通知，提醒不累加。没有真实学校登录、提交或学校页面现场校验；来源未知字段仍需用户核对。

新增 courseView 本地偏好：记忆顶部栏目、当前课程/详情分栏、周次和周末显示。切换到其他页面再返回或新渲染器启动恢复位置；任务通知仍直达任务。写入串行去重，避免旧 IPC 结果覆盖当前导航；绑定 EduPage/ManageBac 账号，校验缓存和共享数据身份，账号变化不重开旧课程。仅位置变更不触发提醒扫描。初次课表选择等旧测试改为区分位置写入与选课写入。

验证：最终全量 1073 项中 1072 通过，唯一失败仍是既有 PHL/Lite account-ui.js 字节差异（27008 / 27663），未覆盖 Lite。真实 Electron 检查中英文、窄窗口任务行、活动详情、返回、重新进入与新页面恢复课表；打包自检 success:true 且 courseViewRemembered:true（实际 IPC 保存）。包内 7 个运行文件与源文件逐字节核对。证据 .cache/course-view-{full-final-tests,final-tests,visual,self-test,build}.log，以及 tests/school-task-types.test.cjs。

检测程序退出后已替换 D:/PHLauncher/PH Launcher 的 exe 与 app.asar，个人资料哈希不变。备份 .cache/managebac-update-backup-2026-11-03T08-08-51.389Z。未推送或发布；等待用户实际学校数据试用。

## 2.0.5 课程读取超时（2026-11-03）

修复课程概览、作业分页、文件、日历串行请求导致累计等待超过一分钟的问题：四类读取并行，单栏目最多 15 秒，作业分页共享 15 秒总预算；request 对 fetch 与 body read 都有超时 Promise，transport 忽略 abort 也能结束等待。课程立即显示已有缓存及导航，UI 25 秒兜底，不接受迟到结果覆盖当前页面。没有真实学校登录或提交操作，未声称学校网页数据已现场验证。

99 项针对性测试通过，包括无限挂起、卡住分页、并行启动、缓存可用及迟到结果隔离。全量 1063 项，1062 通过，仅既有 PHL/Lite account-ui.js 字节差异失败。真实 Electron 中英文窄窗口、加载期间切换/返回及缓存显示通过，打包自检 success:true。恢复 lockfile 的传递依赖版本为已验证原基线，仅根应用版本升级，未更换已安装依赖。

用户确认退出后已替换本地 2.0.5，程序内运行文件与源码核对一致，个人数据哈希不变。备份 .cache/managebac-update-backup-2026-11-03T07-18-10.524Z。证据 .cache/course-speed-{tests,full-tests,visual,self-test,build}.log。未推送或发布。

## 2.0.4 本地更新（2026-11-03）

课表和课程合并为侧栏“我的课程”，内部保留课表、课程、通知、作业、讨论和 CAS/EE。旧 timetable 路由仍可用，侧栏激活统一课程入口。匹配使用课程名、级别、老师，唯一匹配直达作业；不确定时选择，手工关联写入 schoolPreferences.courseLinks，绑定 EduPage 和 ManageBac 两个账号，验证课程存在并保存失败回滚。支持更改关联及返回原周课表。英文新渲染节点立即翻译，用户内容保留原文，窄窗口标签换行。

重复启动：未拿到 Electron 单实例锁不再执行 ready 初始化；不同配置但共享数据目录的实例通过本地 pipe 唤醒已有窗口后退出，Lite 互斥不变。新增 pipe、关联持久化/账号隔离、课表往返回归。

最终针对性测试 66/66；另全量时超时的 calendar-localization/credential-electron 串行复跑通过。全量仍有既有 PHL/Lite account-ui.js 字节差异；合并入口导致的旧断言已更新并复跑。真实 Electron 中英文/780px 布局与返回检查通过；2.0.4 打包自检全部 true，包内运行文件与源码逐字节相同。没有真实学校登录/提交操作。

已更新 D:\PHLauncher\PH Launcher，数据哈希不变；备份 .cache/managebac-update-backup-2026-11-03T05-00-18.300Z。日志 .cache/merge-{focused-tests,full-tests,visual,self-test,build}.log。没有推送或发布。

## 2.0.3 本地修复（2026-11-03）

分支 feat/managebac-task-reminders。课程作业支持现代卡片、表格、普通链接和同课程分页；无法解析/分页失败明确区分 error、partial 与确认 empty。课程概览失败不再阻止作业读取。失败课程仅保留同账号的旧作业并标 stale，旧缓存不触发提醒。重试保留课程页签、筛选和查询。仅合成数据验证，未验证用户截图对应的真实学校响应，未真实登录或提交作业。

验证：最终作业/缓存/界面/提醒测试 85/85；实际 Electron 中英文、窄窗口错误与缓存展示通过。全量运行 1053 项：1050 通过、2 失败、1 超时取消；两个 Electron 超时用串行单独复跑 5/5 通过。剩余失败为已有 PHL / PHL Lite account-ui.js 字节不一致（27008 / 27663），与本次修改无关。后补共享容器回归单测已在最终 85 项内通过。打包自检 success:true，修改运行文件逐字节与源码一致。

已替换 D:\PHLauncher\PH Launcher 的 exe 与 app.asar，版本 2.0.3；用户数据哈希前后相同。备份 .cache/managebac-update-backup-2026-11-03T02-04-50.719Z。证据 .cache/assignment-{final-tests,full-tests,recheck,visual,self-test,build}.log 与 .cache/v2-visual/assignment-read-error-*.png。没有推送或发布，等待用户实际学校数据反馈。

## v2.0（2026-10-18）

用户要求以 fix/manual-course-selection（起点 35780bad178dd726e4bf476487cc7c1bb1c88252）优化课程作业，完成 Windows/macOS 并合入 main 发布。保留原分支 143 个领先 main 的提交，不用旧版覆盖。工作目录 F:\Codex\2026-10-18\PH-Launcher-v2。

新增作业筛选、否定状态识别、分段要求与附件、选择文件后明确确认上传、单次令牌/24 MB/账号绑定/结果未核实保护，以及返回课程和刷新入口。学校表单限定到当前任务；上传 POST 不自动重试。真实学校提交未测试，也未执行。英文及 24px 小窗口已用真实 Electron 合成页面检查。

本地首轮 1014 项回归与 source self-test 通过，补充上传重试保护后 1015 项通过。PHL Lite 账号兼容测试使用独立仓库固定提交 cd420f40a05dfae8b3482b851785ba4411d7b48d（PHL_LITE_DIR）；Windows 禁用 checkout 换行转换以保持字节一致。独立 npm ci，不使用 node_modules 联接。打包证据由 build-v2 工作流按精确提交记录。发布前另增加旧 macOS 构建入口保护测试，避免 main 推送重复触发不适用于 v2 的旧流水线；v2 使用统一的双平台验证入口。

macOS 仓库没有签名 secrets，使用既有 ad-hoc Universal DMG/ZIP 验证流程，不宣称 Developer ID 或公证。旧 v1 发布工作流已限制到 v1 标签，v2 通过已注册 build-collaboration 入口调用 build-v2，验证后手动发布已验证产物。GitHub 发布不等同于更新 phix.ing 独立更新服务器；本次不改该服务。

最终双平台构建 https://github.com/XKRyan/PH-Launcher/actions/runs/39129247306 成功，产物源码提交 63fc62894a927f91fe97643d3d9ae1adf8c66a80；两端各 1016 项测试、源码与打包后启动自检通过，macOS DMG/ZIP 各核验 13 个 Universal Mach-O 文件。因本机 Azure 大文件下载异常，旧 build-macos 手动入口改为“核验成功构建 → 下载原产物 → 逐文件 SHA-256 检查 → 上传到空白草稿”，不重新打包、不覆盖资产、不自动公开。此后提交仅修改发布工具及交接，应用源码仍与上述已测提交一致。

发布完成：2026-10-18 已快进合入 main，PR #10 已合并；v2.0.0 标签指向上述已测构建提交。正式发布页 https://github.com/XKRyan/PH-Launcher/releases/tag/v2.0.0，包含 Windows Setup、Universal DMG/ZIP、更新元数据、SHA-256 与两端构建证据。传输工作流 39130040152 成功；另通过 GitHub Release API 的 digest/size 与原构建证据逐项比对。最终发布工具改动后的本地 1016 项测试全部通过（v2-publication-final-tests.log）。本机仅完整下载了 release/v2.0.0-verified/evidence 的小型证据文件；完整安装包在正式发布页，不要把本机失败下载留下的零字节 artifact.zip 当作安装包。未改 phix.ing 更新服务器，未执行真实学校登录或作业提交。

## 1.0.10（2026-09-10，main 线）

2026-09-10：1.0.10 为 AI 完整权限新增日程删除能力。AI 必须先读取真实日程 id，只能生成待确认删除清单；用户确认后才删除。数据变化会使清单失效，每周重复日程会明确提示整组删除。1.0.9 的聊天记录恢复修复继续保留。

已实现：

- 词本区分“已学会”“已学习（下次复习）”“暂停复习”，显示下次复习时间。
- 预览位置、剩余词组与回忆阶段保存到本机，重启、跨日继续；每次评分继续单独保存。
- 保存最近成功读取的学校内容与已缓存周，离线可查看；账号变更仍清除对应缓存。尚未缓存本周时可点“查看上次课表”。
- 背单词 API 可勾选记住本机授权，绑定 API 地址、模型和 Key；在“连接与检查”撤销，密钥不进入授权文案。
- 首次使用五步导览，侧栏“设置”下方可重开；包含账号、可选 AI、可选心履和常用操作。导览保留步骤。
- 学习主按钮前置，新增文字提供英文翻译，修复心履设置的漏译。

验证：485 项全量回归通过；AI 日程精确删除、待确认提交、并发数据失效保护、不可解锁历史隔离及重建、真实点击保存表达、词组重启恢复测试通过；真实 Electron 桌面及 1.0.10 便携成品自检退出码均为 0。中英文 12 个主页面截图见 dist/interface-audit；IB 术语的中文讲解属于学习材料，未作为界面文案替换。

工程目录 F:\PH Launcher，package.json 当前版本 1.0.10。Windows 产物位于 release：PH-Launcher-1.0.10-x64.exe（安装版）与 PH-Launcher-1.0.10-Portable.exe（便携版）。SHA-256 见 release/PH-Launcher-1.0.10-SHA256.txt。当前产物未配置受信任代码签名。此目录未发现 Git 元数据；本轮未提交或发布。Mac 已由用户同学处理。

## 1.0.11（2026-09-26，feat/school-integrations 线）

这条线（PR #6 学校数据源整合 + 心履 → PR #8 phix 统一账号与云同步 → 卡片确认制更新）
从 62539ff 分出，一直是最新的可发布版本。本次把它合并回 main，合并方式见本节末尾。

已实现（相对 1.0.10）：

- **phix 统一账号 + 端到端加密云同步**：与 Pinghe Launcher Lite / 网页端共用同一套账号、
  同一份 `settings.yaml` 与 `data/.sync/` 同步状态（协议见 `D:\phix\phix-协议规范.md`）。
- **学校数据源整合**：ManageBac / EduPage / 网易企业邮，含共享课表 `data/Schedule`、
  共享学校数据 `data/School`、与 PHL Lite 的互斥运行与心跳检测。
- **心履（心履 / xin-lv.com）**：REST 客户端 `electron/xinlv-client.cjs` + 服务层
  `electron/xinlv-service.cjs`（LWW 心情同步引擎）+ 界面 `src/xinlv-ui.js`。
- **应用内更新改为卡片确认制**：进入软件时只检查、只弹卡片（版本号 + 更新内容 +
  取消 / 跳过本版本 / 更新）；**用户点「更新」之前不会下载任何东西**。
  Windows 走 electron-updater，macOS 未签名版自下载 zip 并替换 `.app`。
  更新服务：`https://phix.ing/api/v1/update/check?product=phl&platform=win|mac`。

验证：`npm test` **939/939 通过**；`node --test tests/auto-updater.test.cjs` 12/12；
真实 Electron 对话框几何审计里更新卡片在 1440×900/16px 与 1040×700/24px 下均 `passed: true`。
发布产物：`PH-Launcher-1.0.11-Setup.exe`（Windows）、`PH-Launcher-1.0.11-macOS-x64.zip`（macOS）。

两个需要知道的取舍：

- `electron/main.cjs` 里 `DATA_ENCRYPTION = false` 是**故意的** —— `settings.yaml` 要与
  PHL Lite / 网页端共用，密文它们解不开。读取路径仍兼容旧版写下的 `ENC1:` 密文，
  改回 true 时旧的明文文件会在下次保存时自动转为加密。
- 学校缓存的存储位置从 `secureStore.data.schoolCache`（1.0.10）换成了共享文件
  `data/School`（本条线）。升级后旧缓存不再读取，下次同步会重新填上；用户自己的数据不受影响。

合并说明：main 的 1.0.10 与本条线并行开发，`electron/xinlv-client.cjs` 两边各自新增了
同名但用途不同的文件（main 那份是 `XinlvTokenStore` 令牌存储，本条线这份是心履 REST 客户端）。
合并时以本条线为准，共 18 个冲突文件，`src/refinements.css`、`Agent.md`、本文件取双方并集。


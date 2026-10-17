# 工作交接

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


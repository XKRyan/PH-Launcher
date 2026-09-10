# PH Launcher · 与 Pinghe Launcher Lite 的数据格式与共存规范(v1)

> 本文档描述 **PH Launcher**(下称 PHL,本仓库)在用户机器上落盘的全部数据,
> 与 **Pinghe Launcher Lite**(下称 PLL,`D:\phl-lite-dev`)的
> `DATA-FORMAT.md` **v1** 对齐:两个程序安装在同一台机器上时可以不互相破坏,
> 并且共用账号、日程与 AI 会话记录。
>
> 规范版本:`1`(2026-09-10)。**共享文件**(第 3–5 节)的任何破坏性字段变更
> 都必须先改 PLL 侧文档并升版本号,再改本仓库。

---

## 0. 设计原则

1. **两个程序各自拥有自己的私有数据,只共用三个文件。** PHL 的私有数据全部关在
   `data/phl/` 里,PLL 的私有数据全部关在 `data/phll/` 里;两侧都**不读写**
   对方的私有目录(第 6 节)。
2. **共享的只有三样**:`settings.yaml`(账号与配置)、`Schedule`(按天日程)、
   `agent/`(AI 会话)。其余一律不共用。
3. **只写自己拥有的字段。** 共享文件一律"读 → 改 → 写",并且只替换自己负责的
   区块;别人的段落、注释、未知字段与文件其余字节必须原样保留(第 3、8 节)。
4. **写入一律原子替换**(同目录临时文件 + `rename`),崩溃/断电不会留下半个文件。
5. **读取必须容错**:文件缺失、损坏、超限或字段不认识时按"空/默认"处理,
   **绝不因为读不懂而删除或覆盖用户文件**。
6. **删除要证明所有权。** PHL 只删除"自己写的、且内容没有被对方改过"的共享条目;
   其余情况只做本地隐藏(第 4、5 节)。
7. **迁移只复制,不移动、不删除。** 旧布局的文件原地保留(第 7 节)。
8. **共享目录是用户的选择,不是自动行为。** 只有便携布局或用户明确点选之后,
   PHL 才会把数据根指向 PLL 的目录(第 1 节)。

---

## 1. 数据根目录怎样确定

数据根目录由 `electron/data-layout.cjs` 的 `resolveDataRoot()` 单点解析,
**任何模块都不许自己拼 `getPath('userData')` 或 `os.homedir()`**。

解析顺序(先命中者胜,`resolveDataRoot` 会回报 `source` 说明命中原因):

| 顺序 | `source` | 条件 | 结果 |
|---|---|---|---|
| 1 | `env` | 环境变量 `PHL_DATA_DIR` 有值 | 用它,路径不存在也会用(测试/便携) |
| 2 | `pointer` | profile 下的 `data-root.txt` 记着一行路径 | 用它(用户在设置里选择过的目录) |
| 3 | `portable` | 程序目录(或 `PORTABLE_EXECUTABLE_DIR`)下的 `portable.flag` 存在 | `<程序目录>/data`,与 PLL 便携版完全一致 |
| 4 | `profile` | 以上都不成立 | `<userData>/data` |

要点:

- **不会**因为"检测到 `~/.hellopinghe`"就自动把数据写进 PLL 的目录。
  设置页会显示检测到的 Lite 目录,并给出两个显式按钮:
  `改用 Lite 的数据目录`(写 `data-root.txt`)与 `恢复本应用自己的目录`。
  写指针文件后需要重启才生效,因此不存在"迁移到一半"的状态。
- 两个程序装在**同一个文件夹**且都用便携模式时,第 3 条会让它们自动指向
  同一个 `data/`,不需要任何设置。
- 想看当前用的是哪个目录:设置 → 数据与隐私,或 IPC `system:data-choice`。
- 解析结果在进程内缓存一次(`dataRoot()`),避免同一进程里读到两个不同的根。

`layoutPaths(root)` 由根派生出全部固定路径;`ensureLayout()` 只创建
`data/`、`data/phl/`、`data/agent/`、`data/logs/`、`data/_backups/`
五个目录,不写任何文件。

---

## 2. 目录总览

```
data/                          ← 数据根目录(便携:<程序目录>\data)
├── settings.yaml              [共享] 账号与 PHL/PLL 共有配置(第 3 节)
├── Schedule                   [共享] 按天日程(第 4 节)
├── agent/                     [共享] AI 会话,一会话一文件(第 5 节)
│   └── <session-id>.json
├── phl/                       [PHL 私有] 不读不写 PLL 数据的人请勿进入(第 6 节)
│   ├── launcher.json          学习数据(加密)
│   ├── school.json            学校快照缓存(加密)
│   ├── credentials.json       账号记忆/凭据库(加密)
│   ├── ai-history.json        AI 会话与长期记忆的加密主副本
│   ├── state.json             运行小状态(预留)
│   └── migrated.json          迁移记录(从哪来、何时)
├── phll/                      [PLL 私有] PHL 只读都不读
├── logs/                      [共享目录,各自文件] 诊断日志
│   ├── startup.jsonl          PHL:--debug-log 的启动耗时
│   └── ai-deployment.jsonl    PHL:本地 AI 部署日志
├── _backups/                  [共享目录,各自文件] 备份
└── _migrated_backup/          [PLL 私有] PLL 的旧布局归档
```

编码与格式(第 8 节给出实现细节):所有文本文件 **UTF-8 无 BOM**、换行 `\n`;
JSON 缩进 2 空格、非 ASCII **不转义**(直接写中文)。

---

## 3. 共享文件 ①:`settings.yaml`

**谁写哪个段**:`accounts`(四平台凭据)与 `agent`(AI 工作区等)是两侧共用的;
PHL 自己的界面、外观、快捷键、学习数据**不写进这个文件**(它们在 `phl/`)。

PHL 目前对这个文件的读写是**块级编辑**,不是整份重新序列化
(`electron/settings-yaml.cjs`):

- 读:`readNestedMap(text, 'accounts')` / `readScalarMap(text, 'agent')` /
  `readStringList(text, 'agent', 'workspaces')`。只解析需要的顶层块,缺失块返回
  `{}` / `[]`,畸形文件不抛错(值原样返回:带引号的按引号解析,`true`/`false`、
  纯数字转成对应类型,空值返回空字符串)。内联列表(`[a, b]`)只由
  `readStringList` 读取,不会当成标量。
- 写:`replaceBlock(text, name, body)` 只替换该块,**块外的每一个字节原样保留**
  (注释、空行、未知段落、其他程序的字段都不会被重排或丢弃);`body` 由
  `serializeNestedMap` / `serializeScalarMap` 生成,必须含结尾换行,否则报错。
  值需要引号时会用单引号转义(`'it''s'`);看起来像布尔或数字的**字符串**也会加
  引号,避免读回来时变成别的类型。
- 落盘:`atomicWriteFileSync()`(同目录临时文件 + `rename`,UTF-8 无 BOM,换行
  统一为 `LF`,沿用原文件权限)。

配套规则:

- **凭据是明文**(见 PLL 文档 §2.2 的说明),PHL 读取时不做额外加密处理,
  也不会把它上传、打印或写进日志;PHL 自己的凭据库仍是系统加密的
  `phl/credentials.json`。
- **两个方向都是显式操作**,界面在"设置 → 网站 → 账号记忆"里:
  - `导入账号`:把共用文件里的四平台账号读进 PHL 的加密凭据库;已经保存过的
    平台一律跳过(不会覆盖),缺少用户名或可用密钥的条目也跳过;
  - `写入共用文件`:把 PHL 已保存的账号(含心履用户名与令牌)写进 `accounts`
    段。因为文件是明文,点击前会再确认一次。
  字段映射(`electron/shared-accounts.cjs`):

  | 共用 `accounts.<平台>` | PHL 站点 | 映射 |
  |---|---|---|
  | `edupage` | `edupage` | `username` → 账号;`password` → 密码 |
  | `managebac` | `managebac` | `email` → 账号;`password` → 密码;写入时补 `base_url` |
  | `mail` | `mail` | `email` → 账号;`authcode` 优先作密钥,`password` 作回退;写入时补 `imap_host`/`smtp_host` |
  | `xinlv` | 心履 | `username` / `token`,PHL 存在加密的 `launcher.json` 里 |

- 导入的账号只写入本机加密凭据库,不会**自动**用在登录上:自动填入与自动重新
  登录仍各自需要单独开启(与既有行为一致)。

---

## 4. 共享文件 ②:`Schedule`

按天存储的 JSON 文档,字段与语义完全按 PLL `DATA-FORMAT.md` §3:
`version` / `kind: "pinghe-schedule"` / `app` / `updated_at` / `events[]`,
其中 `events[]` 为 `{ id:int, day:"YYYY-MM-DD", time:"HH:MM"(可为空=全天),
title, note, created }`。

PHL 的读写由 `electron/shared-schedule.cjs` 负责:

| 规则 | 实现 |
|---|---|
| 新增 id | 取 `max(已有 id, lastId) + 1`;`lastId` 是 PHL 维护的高水位字段(见下) |
| 时间戳 | 带本地时区偏移(`+08:00`),**不写 `Z`**;秒级精度,与 PLL 一致 |
| 写盘 | 读-改-写 + 原子替换;写前比对 `mtimeMs` 与文件长度,被改过则重读重算一次,仍被改则后者胜(`contended: true`) |
| 读容错 | 缺失/截断/非法 JSON = 空文档,不抛错、不删文件 |
| 未知字段 | 顶层与每条 event 上的未知字段原样保留(PLL 的写入同样保留) |

> **`lastId`(PHL 扩展字段)**:规范要求"id 删除后不复用",但"取当前最大 id + 1"
> 在删掉最大 id 后再新增就会复用。PHL 因此在文档顶层维护 `lastId`(只增不减),
> 新 id 取 `max(已有 id, lastId) + 1`。PLL 不认识这个字段,但按 §2.3 的规则会
> 原样保留,因此两个程序交替写入不会冲突,也不会复用 id。

PHL 的本地日历与 `Schedule` 的对应关系(字段不同,不能一一复制):

| PHL 日历(`calendarEvents[]`) | `Schedule.events[]` | 说明 |
|---|---|---|
| `date` | `day` | 都是本地日期 |
| `start` / `end` | `time` | 共享格式只有开始时间;导入时按 60 分钟补 `end`(最晚不超过 23:59) |
| `title` | `title` | 去空白,截 120 字 |
| `notes` | `note` | 去空白,截 400 字 |
| `sharedScheduleId` | `id` | PHL 侧新增字段,用来认出"这条来自共享日程";两边用同一个数字 |
| `repeatWeekdays` | —— | 每周重复的日程**不写入**共享文件(格式不支持),只在 PHL 内保存 |

同步由 `electron/shared-calendar-bridge.cjs` 计划、`electron/main.cjs` 执行:

- **读入(启动时一次)**:共享文件里 PHL 没有对应条目(`sharedScheduleId` 不认识、
  且日期+时间+标题都不重复)的条目会加进日历,标为 `source: 'lite'`;
  只新增,不改写、不删除任何本地日程。
- **写出(每次日历保存后)**:可表示的本地条目写入共享文件;内容相同的条目登记
  对应关系而不重复创建;内容变化的按 `sharedScheduleId` 就地更新。
- **删除**:本地删除某条日程时,只有当共享文件里的那一条仍与本地记录一致时
  才会一并删除;对方改过的条目保留(本地删除只影响本地)。
- **不参与共享**:每周重复、无日期、标题为空、时间非法的条目不写入。
  `end`、提醒、颜色、附件、`reminderState` 属于 PHL 私有,不进共享文件。

---

## 5. 共享文件 ③:`agent/`

一个会话一个 JSON 文件,文件名即会话 id(建议 `YYYYMMDD-HHMMSS`),
内容按 PLL `DATA-FORMAT.md` §4:`{ id, title, history[] }`,`history` 是
OpenAI Chat Completions 风格的消息数组。

PHL 的落地方式(`electron/shared-sessions.cjs` + `electron/ai-history.cjs`):

- **主副本仍是加密文件** `phl/ai-history.json`(会话 + 长期记忆)。每次保存会话时,
  再把这个会话镜像到 `data/agent/<id>.json`(额外写入 `version` / `kind` /
  `app` / `updated_at` 字段,PLL 忽略它们即可)。
- **镜像失败不影响保存**:共享目录不可写时,加密主副本照常成功。
- **别人的会话只读呈现**:`data/agent/` 里 PHL 没有保存过的会话会列在会话列表中,
  带来源标记与"只读"提示;继续聊天会新建一个属于当前连接的会话,旧内容不会
  发给当前服务商。
- **消息过滤**:镜像只保留 `user` / `assistant` 的文本消息;`system`、`tool`、
  `tool_calls` 等工具往返消息不写入共享文件(它们是过程数据,且可能含敏感内容)。
  读取对方的会话时同样只取可渲染的文本轮次。
- **删除保护**:PHL 删除会话时,只有当共享文件里的标题与消息仍与 PHL 自己的副本
  一致时才会删除该文件;对方改过的会话只从 PHL 列表里隐藏,文件保留。
- 会话列表上限 PHL 侧为 30 条加密会话(与实现一致);共享目录最多列出 60 个文件。
  畸形 JSON、超大文件(>512 KB)、空会话一律跳过。

---

## 6. PHL 私有数据:`phl/`

| 文件 | 内容 | 加密 | 删除后果 |
|---|---|---|---|
| `launcher.json` | 任务、笔记、课程表、日历、词汇、外观、快捷键、设置、心履状态 | 系统密钥(`safeStorage`) | **不要删**(等于丢全部学习数据) |
| `school.json` | 最近一次同步的 ManageBac/EduPage/邮箱快照 | 系统密钥 | 可删(重新同步即可) |
| `credentials.json` | 账号记忆(密码/授权码)与自动登录开关 | 系统密钥 | 可删(需重新输入密码) |
| `ai-history.json` | AI 会话与长期记忆的主副本 | 系统密钥 | 谨慎(Conversation 与记忆会丢) |
| `state.json` | 预留的运行小状态 | 否 | 可删 |
| `migrated.json` | 旧布局迁移记录(来源路径、目标路径、时间) | 否 | 可删(只影响可追溯性) |

**PLL 不读写 `phl/`,`PHL 不读写 `phll/`。** 两侧都不得把对方目录当作可清理的缓存。

---

## 7. 旧布局迁移(只复制,不删除)

PHL 1.0.7 及更早把数据放在 Electron profile 目录(`%APPDATA%\ph-launcher`
或 macOS 的 `~/Library/Application Support/ph-launcher`)根下。升级后的第一次启动:

1. `ensureLayout()` 创建新目录;
2. `migrateProfile()` 把下列文件**复制**到 `phl/`(源文件**原地保留**):

   | 旧文件 | 新位置 |
   |---|---|
   | `ph-launcher.secure` | `phl/launcher.json` |
   | `ph-launcher.school` | `phl/school.json` |
   | `ph-launcher.credentials` | `phl/credentials.json` |
   | `ph-launcher.ai-history` | `phl/ai-history.json` |

3. 每次复制都记进 `phl/migrated.json`;目标已存在则跳过(第二次启动不会覆盖)。

回退方法:关掉程序 → 把 `phl/*.json` 复制回 profile 目录下的旧文件名 →
装回旧版本。因为源文件一直没动过,回退不需要任何工具。

`--self-test` / 预览等无头模式使用临时 profile,不会碰真实数据目录。

---

## 8. 编码、原子写与并发

| 项目 | 约定 |
|---|---|
| 文本编码 | UTF-8 **无 BOM**;JSON 缩进 2 空格;非 ASCII 不转义;换行统一 `\n` |
| 原子写 | 同目录临时文件写入 → `fsync`(加密主副本)→ `rename` 覆盖;失败清理临时文件 |
| 进程内并发 | 每个文件一把"读-改-写"路径;共享文件在写前重新读取一次 |
| 跨进程并发 | `Schedule`/`agent/` 由两个程序同时写时:读最新 → 合并 → 写回;`Schedule` 额外比对 `mtimeMs` 与长度,变化则重算一次,仍变化则后者胜(`contended`) |
| 损坏容错 | 解析失败 = 当空文件处理,**不自动删除**用户文件 |
| 大小限制 | 单会话文件 >512 KB、单条目 >16 KB 文本一律截断/跳过,避免被超大文件拖垮 UI |

---

## 9. 失败与冲突处理总表

| 情况 | PHL 的行为 |
|---|---|
| 共享目录不存在 | `ensureLayout()` 创建;读不到内容则按空处理 |
| 共享目录不可写 | 镜像失败只记录,不阻断本地保存;界面提示只读 |
| `settings.yaml` 缺块/畸形 | 读回 `{}`/`[]`;不写入任何东西 |
| 对方把共享条目改成别的样子 | PHL 不覆盖、不删除;本地按自己的记录显示 |
| 同一台机器两个程序同时开 | 各自原子写;`Schedule` 用"读最新再改"避免丢改动 |
| 用户把数据根从 A 改到 B | 只写指针文件,重启后生效;两个目录的数据都保留原样 |

---

## 10. 代码位置索引

| 规则 | 文件 |
|---|---|
| 数据根解析、目录布局、迁移 | `electron/data-layout.cjs` |
| `settings.yaml` 块级读写 | `electron/settings-yaml.cjs` |
| `Schedule` 读写与字段映射 | `electron/shared-schedule.cjs` |
| `agent/` 会话镜像与删除保护 | `electron/shared-sessions.cjs`、`electron/ai-history.cjs` |
| PHL 私有存储 | `electron/main.cjs`(`SecureStore`)、`electron/school-store.cjs`、`electron/credential-vault.cjs` |
| 数据位置设置界面 | `src/index.html`、`src/app.js`(`renderDataChoice`)、`electron/preload.cjs` |

对应测试:`tests/data-layout.test.cjs`、`tests/settings-yaml.test.cjs`、
`tests/shared-schedule.test.cjs`、`tests/shared-sessions.test.cjs`、
`tests/ai-history.test.cjs`。

---

## 11. 与 PLL 的差异与已知限制

- PHL **不会**自动接管 `~/.hellopinghe`;共用必须由用户点选(便携模式除外)。
- PHL 的权限档位只有三档(仅聊天/操作前确认/完整权限),没有 PLL 的
  `workspace_write` 与 `full_access` 自动执行档;PHL 在任何档位下,**写入都必须
  在清单上确认**(发信还会再加一次系统确认)。
- 每周重复的日程、跨天日程、附件与提醒状态**不写入**共享 `Schedule`。
- 共享会话只保留文本轮次;PLL 的工具调用过程不会出现在 PHL 的会话内容里。
- 心履:两个程序各自同步会互相覆盖,PHL 按 PLL 文档 §8 的建议**不参与**
  `phll/xinlv/` 的读写。
- 备份:PHL 目前没有实现 `_backups/` 自动打包(该目录由 PLL 维护);
  PHL 的"导出备份"仍走自己的 JSON 导出。

---

## 12. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| 1 | 2026-09-10 | 首次确定 PHL 侧布局:数据根解析、`phl/` 私有目录、`settings.yaml` 块级共用、`Schedule` 与 `agent/` 共用规则、只复制迁移 |

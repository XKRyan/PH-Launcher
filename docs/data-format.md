# PH Launcher · 与 Pinghe Launcher Lite 的数据格式与共存规范(v1)

> 本文档描述 **PH Launcher**(下称 PHL,本仓库)在用户机器上落盘的全部数据,
> 与 **Pinghe Launcher Lite**(下称 PLL,`D:\phl-lite-dev`)的
> `DATA-FORMAT.md` **v1** 对齐:两个程序安装在同一台机器上时可以不互相破坏,
> 并且共用账号、日程与 AI 会话记录。
>
> 规范版本:`1`(2026-09-10)。**本文最后核对:2026-11-11(PHL 2.0.13 开发线)。**
> **共享文件格式仍是 v1、没有变化** —— PHL 侧已补齐 Lite 1.2.9 的安装登记、
> 安装目录/数据根联动，以及 Timetable/School/agent 未知字段保留；私有数据仍是明文容器，
> 账号仍只读写共用 `settings.yaml`，Chromium profile 仍放在 `phl/profile/`。
> **共享文件**(第 3–5 节)的任何破坏性字段变更仍必须先改 PLL 侧文档并升版本号,再改本仓库。

---

## 0. 设计原则

1. **两个程序各自拥有自己的私有数据,只共用五样。** PHL 的私有数据全部关在
   `data/phl/` 里,PLL 的私有数据全部关在 `data/phll/` 里;两侧都**不读写**
   对方的私有目录(第 6 节)。
2. **共享的是这五样**:`settings.yaml`(账号与配置+选课)、`Schedule`(按天日程)、
   `Timetable`(按天课表)、`School`(抓到的学校信息:课表/课程作业/邮箱摘要)、
   `agent/`(AI 会话)。其余一律不共用。
3. **只写自己拥有的字段。** `settings.yaml` / `Schedule` / `Timetable` / `School` /
   `agent/` 一律"读 → 改 → 写"；顶层未知键、对应条目内未知键与 YAML 注释必须保留。
   JSON 用浅合并，`settings.yaml` 用文本块/条目级合并，不能从 PHL 内存模型整文件重建。
4. **写入一律原子替换**(同目录临时文件 + `rename`),崩溃/断电不会留下半个文件。
5. **读取必须容错**:文件缺失、损坏、超限或字段不认识时按"空/默认"处理,
   **绝不因为读不懂而删除或覆盖用户文件**。
6. **删除要证明所有权。** PHL 只删除"自己写的、且内容没有被对方改过"的共享条目;
   其余情况只做本地隐藏(第 4、5 节)。
7. **迁移只复制,不移动、不删除。** 旧布局的文件原地保留(第 7 节)。
8. **只有一种架构:数据永远在 exe 同级的 `data/`。** 没有便携版/安装版两套布局,
   不收 `portable.flag`,也不写 `%APPDATA%`;程序文件夹里就是
   `PH Launcher.exe` + `PingheLauncherLite.exe` + `data/`(第 1 节)。
9. **PHL 的私有数据当前是明文容器,不是密文**(第 6 节)。这是 2026-09-10 起
   "与共用数据/其他端对齐"的既定选择(`main.cjs` 的 `DATA_ENCRYPTION = false`);
   不要把它描述成"已加密",读取路径仍兼容旧版本留下的加密文件。

---

## 1. 数据根目录怎样确定

数据根目录由 `electron/data-layout.cjs` 的 `resolveDataRoot()` 单点解析,
**任何模块都不许自己拼 `getPath('userData')` 或 `os.homedir()`**。

| 顺序 | `source` | 条件 | 结果 |
|---|---|---|---|
| 1 | `env` | 环境变量 `PHL_DATA_DIR` 有值 | 用它(自动化测试、预览、高级用户改向) |
| 2 | `pointer` | Electron 改向前的固定 profile（Windows `%APPDATA%\PH Launcher`）下 `data-root.txt` 记着一行绝对路径 | 用它（用户/安装器选择过的数据根） |
| 3 | `app` | 以上都没有 | `<exe 所在目录>/data`,不存在就自动创建 |

要点:

- **不需要任何标记文件**:装到哪个文件夹,`data/` 就长在那个文件夹里。
  用户看到的软件文件夹只有两个 exe 和一个 `data/`。
- **不会**因为"检测到 `~/.hellopinghe`"就自动把数据写进 PLL 的目录，也不会在应用
  启动时用 installations.ini 偷偷改向。共用要么是同文件夹(第 3 条)，要么由安装器在
  **新装且尚无指针**时采用对方登记的 data_root 并写 `data-root.txt`，要么由用户在设置页明确改向。
- 第 2 条是安装/用户显式选择的记录；升级安装发现已有指针时原样保留，绝不覆盖用户选择。
- 想换目录：设置 → 数据与隐私里的"改用 Lite 的数据目录 / 恢复本应用目录"
  (IPC `system:data-share-lite` / `system:data-use-own`)，或直接写 `data-root.txt`；重启生效。
- `<exe 目录>/data` 建不出来(例如装在需要管理员权限的目录)时,
  程序会明确提示"没有写入权限,请移动程序或按用户安装",不会静默换目录——
  静默换目录会让两个程序各写各的,数据就分家了。
- **卸载不删数据**:安装器接管了文件删除(`build/installer.nsh` 的 `customRemoveFiles`),
  只删程序文件,`data/` 原地保留;卸载后安装目录里只剩用户自己的数据,
  重新安装到同一目录即可继续用。不做这件事的话,electron-builder 默认的
  `RMDir /r $INSTDIR` 会把课表、日程、账号和 AI 会话一起删掉。
- **`fresh.flag`(干净测试环境)**:程序目录里放一个空的 `fresh.flag`(PLL 用同一个约定)时,
  启动会跳过**全部**旧数据迁移——旧 profile(`ph-launcher.secure/school/credentials`)、
  旧账号库都不动,而且拿不到数据根时也不会退回本机默认 profile(改用临时目录)。
  启动日志里会写 `fresh-env-skip-migration`。测试环境里放这个标记,第一次打开就是彻底空的;
  正式安装不要放。
- **PHL 自己的 Chromium profile 也在数据目录里**:`data/phl/profile/` 放缓存、
  学校网站 Cookie 与 localStorage。它是私有数据(第 6 节),不能当缓存删掉——
  删了要重新登录学校网站;它也不进备份、不上云。
- `data-root.txt` 的读取、界面写入与旧 Profile 迁移都固定使用 **profile 改向前**捕获的
  同一个目录；不会再写进 `<数据根>/phl/profile/`。PHL 写 UTF-8 无 BOM，Unicode NSIS
  为保证中文路径无损可写 UTF-16LE+BOM，解析器兼容两者。
- 解析结果在进程内缓存一次(`dataRoot()`),避免同一进程里读到两个不同的根。
- Lite 1.2.9 的解析顺序为 `PHLL_DATA_DIR` → 自己 `[phl-lite]` 登记的 `data_root` →
  `portable.flag` 对应的安装目录 `data/` → `~/.hellopinghe`；安装完成与应用启动都会
  更新 `%LOCALAPPDATA%\PingheSeries\installations.ini`。PHL 不把登记当运行时配置源，
  只把实际解析结果写回 `[phl]` 供下一次安装联动。
- **安装登记**：Windows `%LOCALAPPDATA%\PingheSeries\installations.ini`，macOS
  `~/Library/Application Support/PingheSeries/installations.ini`。PHL 启动用
  `electron/pinghe-series-registry.cjs` 原子更新 `[phl]` 的安装路径、实际 data_root、
  `package.json`/`app.getVersion()` 版本和时间；损坏/相对路径按未登记处理。卸载器只有在
  登记 path 与自身 `$INSTDIR` 相等时删除 `[phl]`，始终保留 `[phl-lite]` 与全部数据。
- 两端一起跑的自检脚本(用副本目录,别拿真实数据当靶子):

  ```
  node scripts/interop-check.cjs seed  <dataDir>
  set PHLL_DATA_DIR=<dataDir> && python -X utf8 <PLL 仓库>/scripts/interop_check.py check
  set PHLL_DATA_DIR=<dataDir> && python -X utf8 <PLL 仓库>/scripts/interop_check.py write
  node scripts/interop-check.cjs check <dataDir>
  ```

  覆盖 `settings.yaml` / `Schedule` / `agent/` / `Timetable` / `School` 的双向读写、
  未知字段保留、日程 id 不复用。

`layoutPaths(root)` 由根派生出全部固定路径;`ensureLayout()` 只创建
`data/`、`data/phl/`、`data/agent/`、`data/logs/`、`data/_backups/`
五个目录,不写任何文件。

---

## 2. 目录总览

```
<程序文件夹>/                  ← 用户在资源管理器里看到的全部内容
├── PH Launcher.exe            本程序
├── PingheLauncherLite.exe     另一个程序(可选,同装一个文件夹即共用数据)
└── data/                      ← 数据根目录(程序自动生成,不需要用户手动建)
    ├── .phl-running / .pll-running  [共享] 运行标记与心跳(见 `共享数据与进程互斥.md`)
    ├── .sync/                 [共享] 云同步状态与固定服务器公钥(不上云、不备份)
    ├── settings.yaml          [共享] 账号、选课、AI/同步配置与令牌(第 3 节)
    ├── Schedule               [共享] 按天日程(第 4 节)
    ├── Timetable              [共享] 按天课表(格式见 PLL `DATA-FORMAT.md` §8)
    ├── School                 [共享] 学校信息快照:课表/课程作业/邮箱摘要(格式见 PLL `DATA-FORMAT.md` §9)
    ├── agent/                 [共享] AI 会话,一会话一文件(第 5 节)
    │   └── <session-id>.json
    ├── phl/                   [PHL 私有] 不读不写 PLL 数据的人请勿进入(第 6 节)
    │   ├── launcher.json       学习数据(明文容器 `PLAIN1:`)
    │   ├── school.json         学校快照缓存(明文容器 `PHL-SCHOOL-1:plain:`)
    │   ├── credentials.json    旧版本机账号库(只迁移留档,不再使用)
    │   ├── ai-history.json     AI 会话与长期记忆(明文容器 `PHAIH1:`)
    │   ├── state.json          预留,当前未使用
    │   ├── migrated.json       迁移记录(从哪来、何时)
    │   └── profile/            Chromium profile(Cookie/登录态;不备份、不上云)
    ├── phll/                  [PLL 私有] PHL 只读都不读
    ├── logs/                  [共享目录,各自文件] 诊断日志
    │   ├── startup.jsonl       PHL:--debug-log 的启动耗时
    │   └── ai-deployment.jsonl PHL:本地 AI 部署日志
    ├── _backups/              [共享目录,各自文件] 备份
    └── _migrated_backup/      [PLL 私有] PLL 的旧布局归档
```

> `phl/` 下的 `.json` 文件**不是密文**:`PLAIN1:` / `PHL-SCHOOL-1:plain:` / `PHAIH1:`
> 只是"前缀 + base64(JSON)"的容器,内容可直接解出。旧版本用系统密钥写的
> `ENC1:`(launcher)与 `PHAIH1:`(AI 历史)仍能读、下次保存转明文;
> 旧 `PHL-SCHOOL-1:enc:`(学校缓存)**当前不读**——`SchoolStore` 在
> `DATA_ENCRYPTION=false` 时没有拿到 `safeStorage`,只会把文件当"读不懂"跳过,
> 下次同步重新写成 `plain:`(见 §6)。

编码与格式(第 8 节给出实现细节):所有文本文件 **UTF-8 无 BOM**、换行 `\n`;
JSON 缩进 2 空格、非 ASCII **不转义**(直接写中文)。

---

## 3. 共享文件 ①:`settings.yaml`

**谁写哪个段**:两个程序共用的是 `accounts`(账号凭据)、`lessons`(选课)、
`ui`(排序偏好)与 `ai`(AI 供应商配置);另外还有 `phix`(同步配置)与
`secrets_extra`(令牌)段(§3.3),以及 PLL 的 `agent`(AI 工作区)段——**PHL 不解析
`agent` 段**,但整段原样保留。PHL 写 `accounts`、`lessons`、`ai`、`phix`、
`secrets_extra`;`ui` 段由云同步(`cloudsync.cjs` 的 `writeSettingsSection`)写入,
PHL 本机不主动改它。其余段(注释、空行、未知段、字段顺序)一律原样保留。PHL 自己的
界面、外观、快捷键、学习数据**不写进这个文件**(它们在 `phl/`)。

`ai` 段自 2026-11-09 起默认参与云同步(`DEFAULT_OBJECTS` 含 `settings.ai`)；本机
secureStore 里的旧配置会在登录/恢复后补写进这一段，空配置**不写时间戳**（否则每轮
同步都会因为"时间戳变了"而空推一次）。

### 3.1 选课(`lessons`)

`lessons` 是"我实际在上哪些课"的唯一一份记录,两个程序都读它、都可能写它:

```yaml
lessons:
- subject: Physics HL1
  teacher: Jing Jiang
  group: 'A'
```

- **只写"科目 + 教学组 + 老师"这种两边都认得的说法**,不写任何一方的内部组标识。
  两个程序各自抓到的课表给教学组的编号完全不同(PHL 用自己的摘要,PLL 用
  `digest('shared:科目|组|老师')`),所以用到的时候必须**按当前这份课表重新解析**
  (`electron/shared-lessons.cjs` 的 `resolveGroupKeys`:科目必须完全一致,
  有组号时组号必须命中,老师用来消歧;组号写成 `A/B` 表示任一组命中即可)。
- **解析不到时的边界**:`selectionKeys` 在"`lessons` 段有内容、但当前课表一个组都匹配不上"
  时返回 `[]`,只有 `lessons` 段**缺失**才返回 `null`。当前 `main.cjs` 只挡 `null`,
  所以零匹配会被当成"用户取消了全部选课"写回。这是已知粗糙点(见 §11)——课表组标识
  变了不该等于用户不要这些课。
- **"全班必修"两端一致**:没有教学组的课(班会、国家课程、体育),以及科目命中
  `native` / `班会` / `homeroom` 的课(国家理科这类 Edupage 有时打组、有时不打组),
  两端都按必修处理。PLL 用 `mandatoryKeys`;PHL 的默认勾选在 `src/school-ui.js`
  的 `isDefaultOn`(只在还没有已保存选择时默认勾选)。这条规则是为了让同一个人的
  两份个人课表节数对得上——实测同一份共用数据下两端都是 352 节全班课 → 46 节个人课。
- PHL 在"选择教学组"里保存时会把自己选中的组回写成 `lessons`(整段替换),
  PLL 的选课向导写的是同一个字段,所以任一侧改选课,另一侧下次启动就会跟着变。
- `lessons` 的列表项可能**顶格写在第 0 列**(PLL 就是这么写的),换行也可能是
  CRLF。"整段替换"必须把这两种写法都吃掉,否则旧条目残留、被取消的课会在重启后
  被重新读出来(1.0.15 修过一次,测试在 `tests/settings-yaml.test.cjs`)。

PHL 对 `settings.yaml` 的读写是**块级编辑**,不是整份重新序列化
(`electron/settings-yaml.cjs`):

- 读:`sharedSettings.readTextFile()`(缺失/超限返回空串)+ `readNestedMap(text, 'accounts')`;
  `phix` / `secrets_extra` / `ui` 等段用 `cloudsync.parseYamlSection`;
  `readScalarMap` / `readStringList` 是通用工具(目前主要被测试使用)。只解析需要的
  顶层块,缺失块返回 `{}` / `[]`,畸形文件不抛错(值原样返回:带引号的按引号解析,
  `true`/`false`、纯数字转成对应类型,空值返回空字符串)。内联列表(`[a, b]`)
  只由 `readStringList` 读取,不会当成标量。
- 写:`replaceBlock(text, name, body)` 只替换该块,**块外的每一个字节原样保留**
  (注释、空行、未知段落、其他程序的字段都不会被重排或丢弃);`body` 由
  `serializeNestedMap` / `serializeScalarMap` 生成,必须含结尾换行,否则报错。
  值需要引号时会用单引号转义(`'it''s'`);看起来像布尔或数字的**字符串**也会加
  引号,避免读回来时变成别的类型。
- 落盘:`atomicWriteFileSync()`(同目录临时文件 + `rename`,UTF-8 无 BOM,换行
  统一为 `LF`,沿用原文件权限)。

### 3.2 账号(`accounts`)

账号在两个程序之间是**同一份**:PHL 的「设置 → 网站 → 账号记忆」保存时直接按段
替换共用 `settings.yaml` 的 `accounts`,没有"导入/导出"两个手工步骤,也没有 PHL
自己的账号库(`electron/shared-account-store.cjs`)。

```yaml
accounts:
  edupage:
    username: '...'
    email: '...'
    password: '...'
    phl_auto_fill: true
    phl_auto_login: false
    phl_updated_at: '2026-11-02T...'
  managebac:
    base_url: https://shph.managebac.cn
    username: '...'
    email: '...'
    password: '...'
    phl_auto_fill: true
    phl_auto_login: false
    phl_updated_at: '...'
  mail:
    imap_host: imap.qiye.163.com
    smtp_host: smtp.qiye.163.com
    username: '...'
    email: '...'
    password: '...'
    authcode: '...'
```

- **字段**:`username` 与 `email` 都写(两个程序各认一个);mail 的 `authcode`
  (网易企业邮客户端授权码)优先于 `password`;`base_url` / `imap_host` /
  `smtp_host` 是写入时补的固定值。
- **PHL 私有开关**:`phl_auto_fill`(登录页自动填入)、`phl_auto_login`(是否允许
  自动重新登录)、`phl_updated_at` 写在对应平台下。PLL 不认识这些键,但按
  "保留未知字段"的规则原样保留;即使被清掉,最坏也只是回到手动登录。
- **文件是明文**:保存前界面会明确提示。密码只填入对应学校登录页,不提供给 AI,
  也不写进导出的备份。共享电脑不要保存密码。
- **热更新**:每次读取前比对文件 `size + mtimeMs`;云同步或 PLL 改了文件就重新读,
  避免启动时的内存缓存让账号页一直显示"未登录"。
- **删除**:删除某平台账号会删掉 `accounts` 段里该平台的条目;其他平台与未知键保留。
- **迁移**:旧的 `phl/credentials.json`(以及更早的 profile 文件)在升级后第一次启动时,
  把"共用文件里还没有"的账号补写进 `accounts`,旧文件**原样保留**、之后不再使用
  (第 7 节)。
- PHL 不再有"导入账号 / 写入共用文件"两个按钮(旧 IPC 与处理函数仍留在代码里,
  界面已不展示);不要按旧文档去找这两个入口。
- 已知不一致(待产品决定):`phl_auto_login` 会被写入,但当前 `SharedAccountStore`
  在"账号 + 密码齐备"时就允许后台自动登录,并不检查这个开关;界面上的
  "允许自动重新登录"目前不改变实际行为。

> 凭据是明文(见上),PHL 不会把它上传、打印或写进日志。

### 3.3 phix 同步配置与令牌(`phix` / `secrets_extra`)

两个程序共用同一套 phix 登录,所以同步配置和令牌也写在共用 `settings.yaml`:

- `phix:` 段:服务器地址、用户名、`user_id`、`auto_sync`、`e2e`(应用层加密开关)、
  `objects`(要同步的对象名)、`sync_interval_minutes` 等。**非机密**,两边都读;
  PHL 只认识自己列出的键,未知键原样保留。
- `secrets_extra:` 段:phix 令牌(`phix:token` 老式、`phix:access_token` JWT、
  `phix:refresh_token` 续期)与心履令牌等机密字符串。**文件是明文**,但两边共用,
  所以换程序不用重新登录;界面上永远不回显这些值。
- **DEK/KEK 一个字节都不落盘**:解密出的 DEK 只在内存里,每次登录用口令重新解包。
- 写这两个段同样走 `replaceBlock`(读改写),段外内容与未知键原样保留。
- 旧位置:`data/secrets.json`(更早的凭据文件)与 `data/.sync/state.json`
  (不分账号的旧同步状态)会被客户端迁移或忽略,不要按旧文档去找。

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
- **写出(启动时和每次日历保存后)**:可表示的本地条目写入共享文件;内容相同的条目
  登记对应关系而不重复创建;内容变化的按 `sharedScheduleId` **用本地值就地覆盖**。
  也就是说更新是**最后写入者胜**——若对方刚改过同一条 linked 日程,PHL 下次启动/
  保存会把它改回本地版本;只有下面的"删除"做了所有权保护(见 §11)。
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

- **主副本是私有文件** `phl/ai-history.json`(会话 + 长期记忆,明文容器 `PHAIH1:`,
  见第 6 节)。每次保存会话时,再把这个会话镜像到 `data/agent/<id>.json`
  (额外写入 `version` / `kind` / `app` / `updated_at` 字段,PLL 忽略它们即可)。
  写回前会读取同一会话的最新文件，并按消息下标合并：PHL 拥有的已知字段更新，
  顶层与对应消息里的未知字段原样保留；最后用同目录唯一临时文件原子替换。
- **镜像失败不影响保存**:共享目录不可写时,私有主副本照常成功。注意
  `saveSession()` 目前无论镜像成功与否都返回 `shared: true`(见 §11),不要只凭
  这个返回值判断"已写进 agent/"。
- **别人的会话只读呈现**:`data/agent/` 里 PHL 没有保存过的会话会列在会话列表中,
  带来源标记与"只读"提示;继续聊天会新建一个属于当前连接的会话,旧内容不会
  发给当前服务商。这些会话只在内存里列出,不会被并进 PHL 的私有主副本。
- **消息过滤**:镜像只保留 `user` / `assistant` 的文本消息;`system`、`tool`、
  `tool_calls` 等工具往返消息不写入共享文件(它们是过程数据,且可能含敏感内容)。
  读取对方的会话时同样只取可渲染的文本轮次。
- **删除保护**:PHL 删除会话时,只有当共享文件里的标题与消息仍与 PHL 自己的副本
  一致时才会删除该文件;对方改过的会话只从 PHL 列表里隐藏,文件保留。
- 会话列表上限 PHL 侧为 30 条(与 `ai-history.cjs` 的 `MAX_SESSIONS` 一致);
  共享目录最多列出 60 个文件。畸形 JSON、超大文件(>512 KB)、空会话一律跳过。

---

## 6. PHL 私有数据:`phl/`

| 文件 | 内容 | 存储格式 | 删除后果 |
|---|---|---|---|
| `launcher.json` | 任务、笔记、课程表、日历、词汇、外观、快捷键、设置、心履状态、phix 记忆的账号密码 | 明文容器 `PLAIN1:` + base64(JSON);旧 `ENC1:` 密文仍可读,下次保存转明文 | **不要删**(等于丢全部学习数据) |
| `school.json` | 最近一次同步的 ManageBac/EduPage/邮箱快照 | 明文容器 `PHL-SCHOOL-1:plain:`;**旧 `PHL-SCHOOL-1:enc:` 当前不读**(没有传入 `safeStorage`,会被当"读不懂"跳过,下次同步重写) | 可删(重新同步即可) |
| `credentials.json` | 旧版本机账号库(密码/授权码、自动登录开关) | 旧格式(可能是 `PHCRED1:`/系统密钥);**只读一次做迁移,不再写入** | 可删(迁移完成后) |
| `ai-history.json` | AI 会话与长期记忆的主副本 | 明文容器 `PHAIH1:` + base64(JSON);旧加密文件可读,解不开时留档 | 谨慎(会话与记忆会丢) |
| `state.json` | 预留的运行小状态 | 定义仍在,当前代码**没有使用** | 可删 |
| `migrated.json` | 旧布局迁移记录(来源路径、目标路径、时间) | 明文 JSON | 可删(只影响可追溯性) |
| `profile/` | Chromium profile:缓存、学校网站 Cookie/localStorage/登录态 | Chromium 自己的格式 | **不要当缓存删**(删了要重新登录学校网站);不上云、不进备份 |

> 除旧 `credentials.json` 外,PHL 的私有存储**没有系统级加密**:文件内容是
> "前缀 + base64(JSON)",base64 不是加密。`main.cjs` 的 `DATA_ENCRYPTION = false`
> 是 2026-09-10 起与共用数据/其他端对齐的既定选择,不是遗漏(见第 0 节第 9 条)。

**PLL 不读写 `phl/`,PHL 不读写 `phll/`。** 两侧都不得把对方目录当作可清理的缓存。

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
4. 账号库迁移(`migrateLegacyCredentialVault`):把 `phl/credentials.json` 里
   "共用 `settings.yaml` 还没有"的账号补写进 `accounts` 段(第 3.2 节),旧文件
   原样保留、之后不再使用。

> **已知缺陷(v2.0,未修)**:上面第 2 步的 `migrateProfile()` 收到的是 profile
> 改向**之后**的 `app.getPath('userData')`(即 `<数据根>/phl/profile`),不是
> `%APPDATA%\ph-launcher`,所以直接从 1.0.7 及更早版本升到 v2 的用户**不会**
> 被自动迁移旧 `ph-launcher.*` 文件。旧版本已经迁移过的不受影响。见 §11。

回退方法:关掉程序 → 把 `phl/*.json` 复制回 profile 目录下的旧文件名 →
装回旧版本。因为源文件一直没动过,回退不需要任何工具。**注意(v2 起未实测)**:
v2 的 launcher/AI 历史是 `PLAIN1:`/`PHAIH1:` 明文容器,旧版大概率读不了;
真要回退,建议同时保留 v2 的数据文件而不是直接覆盖。

`--self-test` / 预览等无头模式使用临时 profile,不会碰真实数据目录。

---

## 8. 编码、原子写与并发

| 项目 | 约定 |
|---|---|
| 文本编码 | UTF-8 **无 BOM**;JSON 缩进 2 空格;非 ASCII 不转义;换行统一 `\n` |
| 存储编码 | 私有 `.json` 是"前缀 + base64(JSON)"的单行明文容器(`PLAIN1:` / `PHAIH1:` / `PHL-SCHOOL-1:plain:`);`settings.yaml` 与共享 JSON 是 UTF-8 明文 |
| 原子写 | 同目录临时文件写入 → `rename` 覆盖;AI 历史主副本在 rename 前额外 `fsync`(`SecureStore`/`SchoolStore` 没有 fsync);失败清理临时文件 |
| 文件权限 | 私有数据文件尽量以 `0600` 创建(Windows 上由 ACL 决定);共享文件沿用原文件权限 |
| 进程内并发 | 每个文件一把"读-改-写"路径;共享文件在写前重新读取一次 |
| 跨进程并发 | `Schedule` 写前比对 `mtimeMs` 与长度，变化则重算一次，仍变化则后者胜(`contended`)；`Timetable`/`School`/`agent/` 每次写前读取最新文档，已知字段后者胜、未知字段保留。正常运行另由系列进程互斥避免同时写。 |
| 损坏容错 | 解析失败 = 当空文件处理,**不自动删除**用户文件 |
| 大小限制 | 单会话文件 >512 KB、单条消息文本 >16000 字符一律截断/跳过,避免被超大文件拖垮 UI |

---

## 9. 失败与冲突处理总表

| 情况 | PHL 的行为 |
|---|---|
| 共享目录不存在 | `ensureLayout()` 创建;读不到内容则按空处理 |
| 共享目录不可写 | 镜像失败只记录,不阻断本地保存(**目前没有界面只读提示**,见 §11) |
| `settings.yaml` 缺块/畸形 | 读回 `{}`/`[]`;不写入任何东西 |
| `settings.yaml` 读不到或超过 512 KB | 账号状态如实显示"不可用/读不到";保存时重新读改写,绝不整份重写 |
| 旧加密文件解不开 | launcher/AI 历史:改名留档(`*.unreadable-<时间戳>`,绝不删除),以空数据继续;旧加密 `school.json` 直接当读不懂、下次同步重写 |
| 私有数据文件读取失败、连留档都失败 | 本次运行**禁止保存**(`SecureStore.saveBlocked`),下次启动重新读原文件——宁可本次改不了,也不覆盖用户唯一的数据 |
| 同一组学校账号密码自动登录失败 | 只自动提交一次(避免 ManageBac 锁号);改账号/密码、手动登录或重启后才再试 |
| 对方把 linked 日程改成别的样子 | **更新会被 PHL 覆盖(LWW)**;删除有所有权保护(第 4 节) |
| 对方把其它共享条目改成别的样子 | 五类共享文件都读改写；同一条已知字段按 PHL 本地值更新（LWW），顶层/条目未知字段与 YAML 注释保留 |
| 同一台机器两个程序同时开 | 系列互斥应阻止；文件层仍用原子写，`Schedule` 额外用"读最新再改"避免丢改动 |
| 用户把数据根从 A 改到 B | 只在固定 profile 原子写指针文件，下次启动按同一位置读取并生效；不复制、不删除 A/B 中的数据 |

---

## 10. 代码位置索引

| 规则 | 文件 |
|---|---|
| 数据根解析、目录布局、迁移 | `electron/data-layout.cjs` |
| 系列安装登记 / Windows 安装联动 | `electron/pinghe-series-registry.cjs`、`build/installer.nsh` |
| `settings.yaml` 块级读写 | `electron/settings-yaml.cjs` |
| 账号(唯一存储 = 共用 `settings.yaml`) | `electron/shared-account-store.cjs` |
| 账号字段映射/旧格式迁移 | `electron/shared-accounts.cjs`、`electron/credential-vault.cjs`(仅旧文件) |
| phix 配置/令牌(`phix` / `secrets_extra` 段) | `electron/phix-session.cjs` |
| 云同步状态与明文快照(`.sync/accounts/<账号>/`) | `electron/cloudsync.cjs` |
| `Schedule` 读写与字段映射 | `electron/shared-schedule.cjs` |
| 日历与共享日程的同步计划 | `electron/shared-calendar-bridge.cjs` |
| `agent/` 会话镜像与删除保护 | `electron/shared-sessions.cjs`、`electron/ai-history.cjs` |
| 课表/学校数据共享 | `electron/shared-timetable.cjs`、`electron/shared-school.cjs` |
| PHL 私有存储 | `electron/main.cjs`(`SecureStore`)、`electron/school-store.cjs`、`electron/ai-history.cjs` |
| Chromium profile 位置 | `electron/main.cjs`(启动时 `app.setPath('userData', data/phl/profile)`) |
| 数据位置设置界面 | `src/index.html`、`src/app.js`(`renderDataChoice`)、`electron/preload.cjs` |

对应测试:`tests/data-layout.test.cjs`、`tests/settings-yaml.test.cjs`、
`tests/shared-account-store-refresh.test.cjs`、`tests/shared-accounts.test.cjs`、
`tests/shared-schedule.test.cjs`、`tests/shared-calendar-bridge.test.cjs`、
`tests/shared-sessions.test.cjs`、`tests/shared-timetable.test.cjs`、
`tests/shared-data-compat.test.cjs`、`tests/pinghe-series-registry.test.cjs`、
`tests/installer-registry.test.cjs`、`tests/main-install-registry.test.cjs`、
`tests/ai-history.test.cjs`、`tests/school-store.test.cjs`。

---

## 11. 与 PLL 的差异与已知限制

- **同文件夹安装就会自动共用**数据(PHL 默认 `<exe>/data`,PLL 便携模式也是
  `<安装目录>/data`),不需要指针;只有两边数据目录不同(例如 PLL 留在
  `~/.hellopinghe`)时才需要用户显式改向。PHL 没有"便携模式"这个开关。
- **PHL 的私有数据是明文容器**(第 6 节):`PLAIN1:` / `PHL-SCHOOL-1:plain:` /
  `PHAIH1:` 只是 base64 包装。PHL 的导出备份同样不含 API Key 与保存的网页密码,
  但 `phl/launcher.json` 里的学习数据、AI 会话本身是可读的——宣传时不要说成"加密"。
- PHL 的权限档位只有三档(仅聊天/操作前确认/完整权限),没有 PLL 的
  `workspace_write` 与 `full_access` 自动执行档;PHL 在任何档位下,**写入都必须
  在清单上确认**(发信还会再加一次系统确认)。
- 每周重复的日程、跨天日程、附件与提醒状态**不写入**共享 `Schedule`。
- 共享会话只保留文本轮次;PLL 的工具调用过程不会出现在 PHL 的会话内容里。
- 心履:两个程序各自同步会互相覆盖,PHL 按 PLL 文档 §8 的建议**不参与**
  `phll/xinlv/` 的读写。
- 备份:PHL 目前没有实现 `_backups/` 自动打包(该目录由 PLL 维护);
  PHL 的"导出备份"仍走自己的 JSON 导出。

**仍存在的代码缺陷/不一致（2026-11-11 核对）**：

1. **选课零匹配会清空用户选择**：`selectionKeys` 返回 `[]` 被当成"取消全部"(§3.1)。
2. **删除最后一个平台账号不落盘**：`SharedAccountStore._write` 在 `accounts` 变空时
   直接 return，旧条目会留在 `settings.yaml`(§3.2)。
3. **linked 日程更新是 LWW**：对方刚改的已知字段会被 PHL 覆盖；只有删除有所有权保护(§4)。
4. **共享目录只读没有界面提示**；AI 会话镜像失败时 `saveSession()` 仍返回
   `shared: true`(§5、§9)。
5. **设置页"共用数据"说明只列了 3 样**(settings.yaml/Schedule/agent)，
   而且英文界面里这段运行时文案仍是中文；实际共享还有 Timetable/School。
6. **`phl_auto_login` 开关不参与自动登录判定**(§3.2)。

已在本开发线修复、不再列为已知缺陷：指针读写位置不一致、旧 Profile 迁移源错误、
`Timetable`/`School`/`agent/` 写回丢未知字段，以及 Schedule 删除最大 id 后高水位回退。

---

## 12. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| 1 | 2026-09-10 | 首次确定 PHL 侧布局:数据根解析、`phl/` 私有目录、`settings.yaml` 块级共用、`Schedule` 与 `agent/` 共用规则、只复制迁移 |
| 1(核对) | 2026-11-02 | 共享格式未变;按 PHL 2.0.0 代码校正实现说明:私有数据为明文容器、账号只读写共用 `settings.yaml`、旧 `credentials.json` 仅迁移、`phl/profile/`、运行标记与 `.sync/` |
| 1(兼容修订) | 2026-11-11 | 对齐 Lite 1.2.9：固定 installations.ini、安装目录/数据根联动、指针/旧 Profile 修复、五类共享文件未知字段保留；共享格式版本不变 |

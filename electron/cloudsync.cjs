'use strict';
// phix 云同步客户端（PHL 侧）—— `hellopinghe/cloudsync.py`（PLL 侧）的 Node 移植。
//
// 设计原则（协议规范 §5）:
//
//   * **本地 `data/` 永远是唯一真相源**。同步是"加在旁边"的一层,绝不改成"以云为准"。
//   * 服务端只存**不透明密文**（见 `phix-crypto.cjs`）,看不见对象里是什么,所以**合并在客户端做**。
//   * 拿不准就**保留两份并报告**,绝不静默丢数据。
//
// 同步单位是一个个**具名对象**,映射到本地文件 / 字段::
//
//     settings.accounts   settings.yaml 的 accounts 段(四平台凭据)
//     settings.lessons    settings.yaml 的 lessons(选课)
//     settings.ui         settings.yaml 的 ui 段(排序偏好)
//     settings.ai         settings.yaml 的 ai 段(供应商与 key)
//     schedule            data/Schedule(日程)
//     timetable           data/Timetable(课表)
//     school              data/School(学校快照)
//     agent:<会话id>      data/agent/<id>.json(AI 会话)
//
// **怎么做到"删除也能同步"**:光有 本地 + 远端 两份是分不清"对方删了"还是"我新加的"。
// 所以本地额外存一份**上次同步后的明文快照**(`data/.sync/accounts/<账号>/last/`),
// 用标准的三方合并(基版 / 本地 / 远端)判断,删除才会正确地传播。
//
// 状态与快照**按账号隔离**（`data/.sync/accounts/<账号>/`）：换账号时绝不沿用旧账号的
// 快照，否则新账号云端没有的内容会被判成"远端删除了"→ 把本地数据删掉。
// 同一个账号下 PHL 与 PLL 共用同一份，这正是我们想要的。
//
// **绝不碰的东西**:`phl/`、`phll/`、`logs/`、`_backups/`、`_migrated_backup/`、
// 运行标记 `.phl-running` / `.pll-running`、以及同步状态目录 `.sync/` 本身。
// 学校网站的 Cookie 与浏览器 profile 就在前两个里面 —— 那等于登录态,不上云。
//
// 快照与状态文件**与 PLL 共用同一份**（`data/.sync/`）:两台程序读写同一批文件,
// 而且它们不能同时运行(`.phl-running` / `.pll-running` 互斥),所以共用是对的 ——
// 换程序接着同步时,基版就是对方刚留下的那份,三方合并才不会把对方的新增当成"我新加的"。

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const phixCrypto = require('./phix-crypto.cjs');
const sharedSchool = require('./shared-school.cjs');
const sharedSettings = require('./settings-yaml.cjs');
const aiConfig = require('./ai-config.cjs');

// ---------------------------------------------------------------- 常量
/** 禁止上云名单里的目录名等常量之外，这里放一个协议常量。 */
const API_PREFIX = '/api/v1';

const SYNC_DIR = '.sync';
const STATE_NAME = 'state.json';
const SNAPSHOT_SUBDIR = 'last';
/** 状态与快照按账号存放的子目录：`data/.sync/accounts/<账号>/`。 */
const ACCOUNTS_SUBDIR = 'accounts';
const ACCOUNT_FALLBACK = 'default';
const ACCOUNT_MAX_LENGTH = 60;
const DEFAULT_TIMEOUT = 30_000;   // 毫秒（Python 侧 requests 的 timeout=30 是**秒**，移植时别照抄数字）
const MAX_PAYLOAD = 8 * 1024 * 1024;
const STATE_KIND = 'phix-sync-state';

/** 这些前缀/名字**永远不上云**（硬编码,不依赖配置）。 */
const NEVER_SYNC = Object.freeze([
  'phl', 'phll', 'logs', '_backups', '_migrated_backup',
  '.phl-running', '.pll-running', SYNC_DIR, '.gh_token',
]);

/** 默认同步哪些对象。profile 默认勾选，mood 不勾。 */
const DEFAULT_OBJECTS = Object.freeze([
  'settings.accounts', 'settings.lessons', 'settings.ui',
  'schedule', 'timetable', 'school', 'profile',
]);

const SETTINGS_SECTIONS = Object.freeze({
  'settings.accounts': 'accounts',
  'settings.lessons': 'lessons',
  'settings.ui': 'ui',
  'settings.ai': 'ai',
});

/** "本地缺这个键" 的哨兵（对应 Python 的 `_MISSING`）。 */
const MISSING = Symbol('missing');
/**
 * "按默认规则挑 Bearer" 的哨兵。
 *
 * **必须用 `Symbol.for`（全局注册表）而不是模块私有的 `Symbol()`**：
 * 同一份 `cloudsync.cjs` 被两条不同路径 require 时（打包副本、符号链接、
 * 或测试里用绝对路径 require），会各自求值一次模块，私有 Symbol 在两边
 * **并不相等**，于是"这次请求该不该用当前访问令牌"的判断会静默失效 ——
 * 表现就是"令牌过期了却不去续期"。用注册表里的同一个 Symbol 就没这个问题。
 */
const DEFAULT_TOKEN = Symbol.for('phix.default-token');

// ---------------------------------------------------------------- 小工具
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isPlainObject = (value) => isObject(value) && !Buffer.isBuffer(value);
const asMap = (value) => (isObject(value) ? value : {});
const asList = (value) => (Array.isArray(value) ? value : []);

function isMissing(value) { return value === MISSING || value === undefined; }

/** 与 Python `json.dumps(..., ensure_ascii=False)` 等价:中文原样,不是 \u 转义。 */
function jsonText(value) {
  const text = JSON.stringify(value);
  return text === undefined ? 'null' : text;
}

/** 排序键的 JSON（用于 `_same` 与哈希）—— 与 Python `sort_keys=True` 一致。 */
function canonical(value) {
  if (value === undefined) return 'null';
  if (!isObject(value) && !Array.isArray(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : canonical(item))).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function sameValue(a, b) { return canonical(a) === canonical(b); }

/** 可 JSON 序列化的文档 → 字节（与 Python `_dump` 逐字节一致:排序 + 无空格）。 */
function documentBytes(doc) {
  return Buffer.from(canonical(doc), 'utf8');
}

function hashDocument(doc) {
  if (doc === null || doc === undefined) return '';
  return crypto.createHash('sha256').update(documentBytes(doc)).digest('hex');
}

/** 本地时间戳（带时区偏移，与 PLL `filestore.now_iso` 同款）。 */
function nowIso(date = new Date()) {
  const moment = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(moment.getTime())) return '';
  const offset = -moment.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const pad = (value) => String(Math.floor(Math.abs(value))).padStart(2, '0');
  return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`
    + `T${pad(moment.getHours())}:${pad(moment.getMinutes())}:${pad(moment.getSeconds())}`
    + `${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}

function deviceName() {
  try { return os.hostname() || '本机'; } catch { return '本机'; }
}

/**
 * phix 用户名 → 安全的**单层**目录名。
 *
 * - 非 `[A-Za-z0-9._@+-]` 的字符换成 `_`
 * - 截断到 60 个字符
 * - 空、或**纯点串**（`.` / `..` / `...`）→ `default`
 *   （纯点串不含非法字符，会原样变成目录名，然后被 `path.join` 解析到上一级 ——
 *    这是真实的目录逃逸，不是洁癖）
 *
 * **必须与 PLL 的 `account_dir_name()` 逐字符一致** —— 两个程序用同一个账号时要落到
 * 同一个目录、共用同一份快照，否则三方合并会各自记各自的基版。
 */
function safeAccountName(username) {
  const text = String(username === null || username === undefined ? '' : username);
  const safe = Array.from(text)
    .map((char) => (/[A-Za-z0-9._@+-]/.test(char) ? char : '_'))
    .join('')
    .slice(0, ACCOUNT_MAX_LENGTH);
  if (!safe || /^\.+$/.test(safe)) return ACCOUNT_FALLBACK;
  return safe;
}

/** 容错读 JSON:缺失/损坏一律当"没有"。 */
function readJson(filePath, fallback = null) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_PAYLOAD) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed === undefined ? fallback : parsed;
  } catch { return fallback; }
}

/** 原子写 JSON（UTF-8 无 BOM、LF、同目录临时文件 + rename）。 */
function writeJson(filePath, doc) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
  return doc;
}

// ---------------------------------------------------------------- AI 配置归一化
/**
 * AI 配置的**同步载荷**（规范形态，与网页端 / PLL 共用同一个 settings.ai 对象）。
 *
 * 本地 settings.ai 是 PHL 自己的扁平形态（provider/apiEndpoint/apiKey/localModel/
 * workspace/权限确认…），直接上云的话网页端和 PLL 都读不懂；反过来网页端写的
 * `{providers, default_index}`，PHL 的旧运行路径也吃不下。所以这里做**双向归一**：
 *
 * - 上云：`{providers:[{name,protocol,base_url,model,api_key}], default_index,
 *   updated_at, updated_by}`
 * - 落盘：同步回来的规范形态合并进本地，`workspace`/`workspaces`/`localModel`/
 *   `localEndpoint`/`enabled`/`provider`/权限确认字段**一个都不动**。
 *
 * `updated_at` **沿用本地已有的值**：每次 collect 都盖"现在"会让哈希每轮都变，
 * 于是每轮同步都在推一份没变的配置（PLL 侧踩过同款坑）。
 */
function aiSyncPayload(ai) {
  const config = asMap(ai);
  const payload = aiConfig.serializeAiConfig({
    providers: aiConfig.providersOf(config),
    default_index: config.default_index || 0,
    updated_at: config.updated_at || '',
    updated_by: config.updated_by || '',
  });
  if (!payload.providers.length) return payload;
  // **元信息要么两个都写、要么两个都不写**：只写一个（比如本地有 updated_at 却没有
  // updated_by）会让"第一轮少一个键、第二轮才出现"，两轮载荷哈希不同 → 每轮空推一份
  // 配置。这里统一补齐：本机从来没有署名时按"本机自己写的"记 phl。
  if (!String(payload.updated_by || '').trim()) payload.updated_by = 'phl';
  // **密钥必须随对象上云**：网页端没有本地 secureStore，同步对象里没有 api_key
  // 它就只能回 409「未配置」——用户在客户端填了 key，网页端却用不了。
  // 这里不额外加字段，只保证已经有 key 的那些 provider 原样带上（`normalizeProvider`
  // 从来不丢 api_key，这条断言是防以后有人"顺手"把它过滤掉）。
  payload.providers = payload.providers.map((row) => ({ ...row, api_key: String(row.api_key || '') }));
  return payload;
}

/**
 * 把云端来的规范形态合并回本地 settings.ai（本地专有字段一律保留）。
 *
 * 走的是和同步引擎同一条 `mergeAiPayload`：这样"远端更新时要不要采纳"只有一份实现。
 * 本地专有字段（enabled/provider/workspace/localModel/权限确认…）由
 * `mergeAiProviders` 从本地那份带过去。
 */
function mergeAiSection(current, canonical) {
  const config = asMap(current);
  const canonicalMerged = mergeAiPayload(null, config, asMap(canonical), []);
  return aiConfig.mergeAiProviders(config, canonicalMerged, {});
}

/** 一条规范服务商是否逐字段相同。 */
function sameAiProvider(a, b) {
  return ['name', 'protocol', 'base_url', 'model', 'api_key']
    .every((key) => String(asMap(a)[key] || '') === String(asMap(b)[key] || ''));
}

/** 尽力解析 updated_at（解析不出来返回 0 = 没有时间信息）。 */
function aiStamp(value) {
  const text = String(asMap(value).updated_at || '');
  if (!text) return 0;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 取两份载荷里较新的时间戳（都没有就返回空串）。 */
function newerStamp(a, b) {
  const left = aiStamp(a);
  const right = aiStamp(b);
  if (!left && !right) return '';
  return left >= right ? String(asMap(a).updated_at || '') : String(asMap(b).updated_at || '');
}

/**
 * AI 配置的三方合并（**按服务商名称**对齐，与 PLL 的 aiconfig.merge_payload 同一套规则）。
 *
 * 没有基版(首次同步这个对象)时:
 *   - 远端时间戳更新 → 收下远端那份（用户刚在网页端改过配置，应该生效）；
 *   - 否则留本地（宁可晚一轮，也不猜着覆盖本机已经在用的服务商）。
 * 有基版时按标准的"本地没动跟随远端 / 谁改了算谁的"。
 */
function mergeAiPayload(base, local, remote, conflicts) {
  // 本地的 `updated_at` 必须带进这份载荷：没有它就分不出"远端是不是比本地新"，
  // 结果网页端刚改的配置会被一架老设备的老数据压住。
  const localSource = asMap(local);
  const localPayload = aiConfig.serializeAiConfig({
    providers: aiConfig.providersOf(localSource),
    default_index: localSource.default_index || 0,
    // 本机从没记过时间时**不要**让 serialize 兜底盖"现在"：那会让本机永远显得比
    // 云端新，网页端刚改的配置就落不下来。空串在这里表示"没有时间信息"。
    updated_at: localSource.updated_at || '',
  }, '');
  if (String(localSource.updated_at || '').trim()) localPayload.updated_at = String(localSource.updated_at);
  else delete localPayload.updated_at;
  if (!String(localSource.updated_by || '').trim()) delete localPayload.updated_by;
  const remotePayload = aiConfig.isEmptyConfig(remote)
    ? null
    : (() => {
      const source = asMap(remote);
      // `updated_at`/`updated_by` 不是"服务商字段"，normalizeAiConfig 不会带它们出来，
      // 必须显式补上 —— 少了它们就分不出谁更新（这正是踩过的坑）。
      const built = aiConfig.serializeAiConfig({
        ...aiConfig.normalizeAiConfig(source),
        updated_at: source.updated_at || '',
        updated_by: source.updated_by || '',
      }, '');
      if (!String(source.updated_at || '').trim()) delete built.updated_at;
      if (!String(source.updated_by || '').trim()) delete built.updated_by;
      return built;
    })();
  const basePayload = aiConfig.isEmptyConfig(base) ? null : aiConfig.normalizeAiConfig(base);

  // 远端是这个对象的老形态(或云端还没有) → 只取并集, 绝不因此清掉本地服务商
  if (remotePayload === null) {
    // 用本机自己的元信息（不要 serialize 兜底盖的"现在"，那会让哈希每轮都变）
    if (localSource.updated_at) localPayload.updated_at = String(localSource.updated_at);
    return localPayload;
  }
  if (!localPayload.providers.length) return remotePayload;

  const localRows = localPayload.providers;
  const remoteRows = remotePayload.providers;
  const baseRows = basePayload ? basePayload.providers : null;
  const localChanged = !baseRows
    || !sameAiList(localRows, baseRows)
    || Number(localPayload.default_index) !== Number(basePayload.default_index);

  const rows = [];
  // 哪些服务商是"本机这边贡献的"（本机新增的、或本机改过的）。用来决定写出去的
  // 载荷该署名谁：只要本机的贡献进了结果，就是 PHL 写的；纯拉远端则保留原署名。
  const mine = new Set();
  const names = [...localRows.map((row) => row.name), ...remoteRows.map((row) => row.name)
    .filter((name) => !localRows.some((row) => row.name === name))];
  for (const name of names) {
    const lp = localRows.find((row) => row.name === name) || null;
    const rp = remoteRows.find((row) => row.name === name) || null;
    const bp = baseRows ? (baseRows.find((row) => row.name === name) || null) : null;
    const rowPath = `ai.providers[${name || '?'}]`;
    if (!lp) { rows.push(rp); continue; }
    if (!rp) {
      // 没有基版(第一次同步这个对象)时**不做删除推断**：分不清"云端删了"还是
      // "本机刚加、云端还没同步到"。宁可多留一轮，也绝不猜着删用户的配置。
      if (!bp || !sameAiProvider(lp, bp)) {
        rows.push(lp);
        mine.add(name);
        if (bp) conflicts.push({ path: rowPath, local: lp, remote: null, base: bp, note: '远端删了这个服务商、但本地改过 → 保留本地' });
      }
      continue;
    }
    if (sameAiProvider(lp, rp)) { rows.push(lp); continue; }
    if (bp && sameAiProvider(lp, bp)) { rows.push(rp); continue; }
    if (bp && sameAiProvider(rp, bp)) { rows.push(lp); mine.add(name); continue; }
    if (!bp && aiStamp(remotePayload) > aiStamp(localPayload)) { rows.push(rp); continue; }
    rows.push(lp);
    mine.add(name);
    if (bp) {
      conflicts.push({ path: rowPath, local: lp, remote: rp, base: bp, note: '同一个服务商两边都改了 → 取较新的一份(本地)，远端那份见冲突记录' });
    }
  }

  // 默认项：跟着"被采纳的那一侧"走，再按名字映射到新列表
  const remoteNewer = aiStamp(remotePayload) > aiStamp(localPayload);
  const side = remoteNewer ? remotePayload : localPayload;
  const defaultName = asMap(side.providers[side.default_index] ?? side.providers[0]).name || '';
  let defaultIndex = 0;
  const picked = rows.findIndex((row) => row.name === defaultName);
  if (picked >= 0) defaultIndex = picked;

  // 本机的贡献有没有进结果？有 → 这份载荷是 PHL 写的（署名 phl）；一条都没进
  // （纯拉远端）→ 沿用原署名，别把"网页端改的"记成自己改的。
  // 时间戳一律沿用（不重盖"现在"）：重盖会让别的设备以为配置又变了，每轮重拉。
  const mineWon = rows.some((row) => mine.has(row.name));
  return {
    providers: rows,
    default_index: defaultIndex,
    updated_at: newerStamp(remotePayload, localPayload),
    updated_by: mineWon ? 'phl' : (remotePayload.updated_by || localPayload.updated_by),
  };
}

/** 两份规范服务商列表是否逐条逐字段相同。 */
function sameAiList(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (left.length !== right.length) return false;
  return left.every((row, index) => sameAiProvider(row, right[index]));
}

/**
 * 把一份服务商列表**叠加**到另一份上（按名称对齐），两侧都有的字段逐字段补齐
 * （本地缺 `api_key` 就用外来的那份）。
 *
 * 用途：PHL 的密钥有两个存放处 —— 本机加密存储（`secureStore`）和同步对象
 * `settings.ai`（网页端/PLL 也会写）。"在任意一端填了 key，三端都能用"要求两边
 * 合并，而不是谁覆盖谁。
 *
 * 空值不覆盖：只有本机那侧**缺**某个字段时才收下外来那份。
 * `protocol` 特殊一点：`normalizeProvider` 解析不出协议时会给默认值 `'openai'`，
 * 所以本机那侧是 `openai` 而外来那份是 `anthropic` 时，按"外来那份是用户明确选的"
 * 处理（`anthropic` 不可能是猜出来的默认值）。
 */
function overlayAiProviders(baseList, incomingList) {
  const baseRows = (Array.isArray(baseList) ? baseList : []).filter(isObject).map(aiConfig.normalizeProvider);
  const incomingRows = (Array.isArray(incomingList) ? incomingList : []).filter(isObject).map(aiConfig.normalizeProvider);
  if (!incomingRows.length) return baseRows;
  if (!baseRows.length) return incomingRows;
  const merged = baseRows.map((row) => {
    const other = incomingRows.find((candidate) => candidate.name === row.name);
    if (!other) return row;
    return {
      name: row.name || other.name,
      protocol: row.protocol === 'anthropic' || other.protocol === 'anthropic' ? 'anthropic' : 'openai',
      base_url: row.base_url || other.base_url,
      model: row.model || other.model,
      // **密钥以"有值的那一份"为准**：本机刚填的优先(它非空)，本机没有就收下同步对象里的。
      api_key: row.api_key || other.api_key,
    };
  });
  for (const other of incomingRows) {
    if (!merged.some((row) => row.name === other.name)) merged.push(other);
  }
  return merged;
}

// ---------------------------------------------------------------- 错误
class PhixError extends Error {
  /** `code` 与协议 §4.7 的枚举一致。 */
  constructor(code, message, status = 0, payload = {}) {
    super(message || code);
    this.name = 'PhixError';
    this.code = code || 'server_error';
    this.status = status;
    this.payload = payload || {};
  }

  get isConflict() { return this.code === 'revision_conflict'; }
}

// ---------------------------------------------------------------- HTTP 客户端
/**
 * 对 phix 服务端 REST API 的薄封装（只做 HTTP,不含任何业务）。
 *
 * **应用层加密传输**（对应 `加密链路思路.md` §3）：服务端在 `/ping` 里报出 `enc=1`
 * 与 X25519 公钥 `pk`，之后每个请求的体都用一次性的会话密钥加密（`sealBox`），
 * 响应也加密回来。**网线上只有密文**，不接 TLS 也不怕被嗅探。
 *
 *   - 公钥**首次信任后固定存本地**（`<pinDir>/<host>.txt`）；下次对不上就拒绝连接
 *     —— 防止有人冒充服务器。确认服务器确实换了钥匙之后，删掉那个文件
 *     （或调 `trustNewServerKey()`）再连。
 *   - 服务器不支持（`enc=0`）或探测失败 → 自动退回明文路径，**绝不因此连不上**。
 */
class PhixClient {
  /**
   * @param {string} server 服务器根地址（不含 `/api/v1`）
   * @param {string|null} token 老式长期令牌（P3 之前那个兼容字段）
   * @param {number} timeout 单次请求超时（毫秒）
   * @param {object} options
   *   - `e2e`      是否启用应用层加密传输（默认开）
   *   - `pinDir`   服务器公钥固定目录
   *   - `accessToken` / `refreshToken`  已落盘的两串令牌（P3）
   *   - `persist`  续期成功后回调 `({access_token, refresh_token})`，由上层落盘
   *   - `onLog`    续期/落盘失败时的日志出口（**绝不打印令牌本身**）
   */
  constructor(server, token = null, timeout = DEFAULT_TIMEOUT, options = {}) {
    this.server = String(server || '').replace(/\/+$/, '');
    this.token = token || '';
    // 首次请求要建连接（本机实测 30~50ms，慢网更久），故意传极小值只会让
    // "测试连接"永远失败，所以这里夹一个下限。
    const value = Number(timeout);
    this.timeout = Number.isFinite(value) && value >= 1000 ? value : DEFAULT_TIMEOUT;
    this.e2e = options.e2e !== false;                       // 默认开启加密传输
    this.pinDir = options.pinDir ? String(options.pinDir) : '';
    this.serverPk = null;                                    // 拿到公钥才非空
    // ---- P3：短期访问令牌（JWT）+ 长期 refresh 令牌 ----
    // `access_token` 优先：它是 P3 起业务请求该用的那串；没有就沿用构造参数
    // （老令牌 / 老客户端传进来的那串）—— 两串都是有效凭据，但 JWT 才有"15 分钟
    // 后自动续期"这条路。
    this.accessToken = options.accessToken ? String(options.accessToken) : '';
    if (this.accessToken) this.token = this.accessToken;
    this.refreshToken = options.refreshToken ? String(options.refreshToken) : '';
    // 续期成功后由上层把它存下来。**失败也绝不拦着请求**：内存里那一串照样能用，
    // 真存不下只影响"下次启动"，写日志就够（与 `phix-session` 的既有态度一致）。
    this._persist = typeof options.persist === 'function' ? options.persist : null;
    this._log = typeof options.onLog === 'function' ? options.onLog : () => {};
    /** 同一时刻只允许一次续期：并发请求撞上过期时**共用**同一次续期结果。 */
    this._refreshInFlight = null;
  }

  /** 当前是否真的在用信封。 */
  get encrypted() { return this.serverPk !== null; }

  // ------------------------------------------------------------ 令牌（P3）
  /**
   * 当前该拿哪一串当 Bearer。
   *
   * **优先 `access_token`**（15 分钟的 JWT）；没有（比如只有 PLL 留下的老令牌）
   * 就用 `this.token` 兜底 —— 两串现在都是有效凭据，但协议要求业务请求优先用
   * JWT，好让 15 分钟后能自然走一次"401 → 续期 → 重试"。
   */
  authToken() { return this.accessToken || this.token || ''; }

  /** 拿到新的令牌组：更新内存（并尽力落盘）。`refresh_token` 欠奉时**保持原样**。 */
  setTokens({ access = '', refresh = '' } = {}) {
    if (access) {
      this.accessToken = String(access);
      // 兼容：别的地方仍可能读 `client.token`，让两者指向同一串（PLL 侧同口径）
      this.token = this.accessToken;
    }
    if (refresh) this.refreshToken = String(refresh);
    if (this._persist) {
      try {
        this._persist({ access_token: this.accessToken, refresh_token: this.refreshToken });
      } catch (error) {
        this._log(`phix 令牌落盘失败（内存里仍然有效）：${error?.message || error}`);
      }
    }
    return this;
  }

  /** 清掉**两组**令牌（登出时用）。 */
  clearTokens() {
    this.token = '';
    this.accessToken = '';
    this.refreshToken = '';
    this.legacyToken = '';
    if (this._persist) {
      try {
        this._persist({ access_token: '', refresh_token: '' });
      } catch (error) {
        this._log(`phix 令牌清除失败：${error?.message || error}`);
      }
    }
    return this;
  }

  /** 请求该带哪个 Bearer：默认哨兵（或没传）→ 当前访问令牌；显式给值就用它。 */
  _authToken(token) { return token === DEFAULT_TOKEN || token === undefined ? this.authToken() : token; }

  /** 组装认证头。`token` 用默认哨兵 → 当前访问令牌；`''`/null 表示这一趟不带令牌。 */
  authHeaders({ token = DEFAULT_TOKEN, json = false } = {}) {
    const headers = { Accept: 'application/json' };
    const bearer = this._authToken(token);
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (json) headers['Content-Type'] = 'application/json; charset=utf-8';
    return headers;
  }

  /**
   * `POST /auth/refresh`：拿 refresh 换新的 access（服务端还会顺带轮换 refresh）。
   *
   * **免认证**，所以这一趟绝不带 Bearer，也绝不再走"401 → 续期"那条路
   * （否则续期失败时自己把自己套进循环里）。
   *
   * 处理三种响应：
   * - `rotated: true` + 新的 `refresh_token` → 两串都换掉并落盘；
   * - `rotated: false`（宽限期内重复续期，并发很正常）→ **只换 access**，
   *   本地那串 refresh 一个字节都不动，也**不报错**；
   * - 失败 → 抛 `PhixError`，**绝不重试**（拿旧 refresh 连点会被判成重放、
   *   整个会话作废）。
   */
  async refreshAccessToken() {
    if (!this.refreshToken) {
      throw new PhixError('no_refresh_token', '本机没有续期凭据（refresh 令牌），请重新登录', 401);
    }
    if (this._refreshInFlight) return this._refreshInFlight;
    this._refreshInFlight = (async () => {
      let data;
      try {
        data = await this._request('POST', '/auth/refresh', { refresh_token: this.refreshToken },
          '', { skipRetry: true });
      } catch (error) {
        throw PhixClient._refreshFailed(error);
      }
      const access = typeof data?.access_token === 'string' ? data.access_token : '';
      const rotated = typeof data?.refresh_token === 'string' ? data.refresh_token : '';
      if (!access) throw PhixClient._refreshFailed(data);
      // `rotated:false`（宽限期）时服务端**不重发** refresh —— 那就别动本机这一串
      this.setTokens({ access, refresh: rotated });
      return this.accessToken;
    })();
    try {
      return await this._refreshInFlight;
    } finally {
      this._refreshInFlight = null;
    }
  }

  /** 续期失败 → 一句人话，且**不重试**。 */
  static _refreshFailed(errorOrData) {
    if (errorOrData instanceof PhixError) {
      if (errorOrData.code === 'rate_limited') {
        return new PhixError('rate_limited',
          '续期太频繁了，请稍后再试（没有重复请求，不会造成会话失效）', errorOrData.status);
      }
      return new PhixError('refresh_failed',
        errorOrData.message || '登录状态已过期，请重新登录', errorOrData.status || 401);
    }
    return new PhixError('refresh_failed', '续期没有成功，请重新登录', 401);
  }

  /** 固定公钥的存放路径：`<pinDir>/<host>.txt`（host 里非 `[A-Za-z0-9._-]` 换成 `_`）。 */
  pinPath() {
    if (!this.pinDir) return '';
    const host = this.server.split('://').slice(-1)[0].replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
    return path.join(this.pinDir, `${host}.txt`);
  }

  /** 清掉固定的服务器公钥（确认服务器确实换了钥匙之后才该调用）。 */
  trustNewServerKey() {
    const target = this.pinPath();
    if (target) {
      try { fs.rmSync(target, { force: true }); } catch { /* 删不掉也不该挡着用 */ }
    }
    this.serverPk = null;
  }

  /**
   * 探测并启用应用层加密。返回是否启用。**不会因为失败就抛错**
   * （探测不通/服务端不支持 → 退回明文，绝不挡着用户）。
   * 公钥对不上时抛 `server_key_changed` —— 这条必须让用户看见。
   */
  async ensureE2e() {
    if (!this.e2e) return false;
    if (this.serverPk !== null) return true;
    let info;
    try {
      info = await this._plainRequest('GET', '/ping', null, '');
    } catch (error) {
      if (process.env.PHIX_E2E_DEBUG) console.error('[e2e] ping 探测失败:', error?.code, error?.message);
      this.e2e = false;                                    // 探测失败就退回明文
      return false;
    }
    let pk = null;
    try {
      if (Number(info?.enc || 0) !== 1 || !info?.pk) { this.e2e = false; return false; }
      pk = phixCrypto.b64d(info.pk);
    } catch {
      this.e2e = false;
      return false;
    }
    if (process.env.PHIX_E2E_DEBUG) console.error('[e2e] enc=', info?.enc, 'pkLen=', pk && pk.length);
    if (!pk || pk.length !== phixCrypto.EPK_LEN) { this.e2e = false; return false; }

    const target = this.pinPath();
    if (target) {
      let previous = null;
      try {
        if (fs.existsSync(target)) {
          const text = fs.readFileSync(target, 'utf8').trim();
          previous = Buffer.from(text, 'hex');
          if (!previous.length) previous = null;
        }
      } catch { previous = null; }
      if (previous && !previous.equals(pk)) {
        throw new PhixError('server_key_changed',
          '服务器的加密公钥和本机记住的不一样！可能是服务器重装过，也可能是有人在中间冒充。'
          + '确认无误后再重新信任（设置页有入口）。');
      }
      if (!previous) {
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, `${pk.toString('hex')}\n`, 'utf8');
        } catch { /* 存不下就只是不能固定，不该挡住使用 */ }
      }
    }
    this.serverPk = pk;
    return true;
  }

  _url(route) { return `${this.server}${API_PREFIX}${route}`; }

  /**
   * 组装带对象名的路由。
   *
   * **对象名原样放进路径，不做百分号编码** —— 服务端拿到的是 `request.path`，
   * 加密时 AAD 用的是**那个**路径。一旦这里编码（`agent:x` → `agent%3Ax`），
   * 客户端算 AAD 用 `%3A`、服务端用 `:`，两边对不上，服务端只会回
   * "信封解密失败（内容被改过或路径不匹配）"。PLL 侧也是原样拼的。
   */
  static objectRoute(name) {
    const text = String(name || '');
    if (!text || /[/?#\s]/.test(text)) {
      throw new PhixError('bad_request', `对象名不合法：${JSON.stringify(text)}`);
    }
    return `/sync/objects/${text}`;
  }

  /**
   * 统一的请求入口：能加密就加密，`/ping` 永远明文（要先拿公钥）。
   *
   * **P3 自动续期就在这里**：业务请求拿到 `401` + `code == "token_expired"` 时，
   * 调一次 `/auth/refresh`，然后用新 access **重试原请求一次**。
   * 三条死规矩：
   * - **只重试一次**（`skipRetry` 之后不再进来）—— 绝不循环；
   * - **续期失败不重试**（`refreshAccessToken` 抛错就原样往上抛）；
   * - 调用方显式传了**别的**令牌（比如客户端的 `token` 字段）时不插手续期，
   *   免得把"这条请求要用哪串令牌"的意图换掉。
   */
  async _request(method, route, payload, token, timeoutOrOptions) {
    const options = (timeoutOrOptions && typeof timeoutOrOptions === 'object')
      ? timeoutOrOptions : { timeoutMs: timeoutOrOptions };
    const explicitRaw = options.token !== undefined ? options.token : token;
    // `undefined` = 调用方没指定令牌 → 归一到哨兵，走"当前访问令牌 + 允许续期"那条路。
    // （**必须归一**：`explicit === DEFAULT_TOKEN` 是用来判断"能不能插手续期"的，
    //   留着裸 `undefined` 会判成"调用方指定了别的令牌"，于是过期了也不去续期。）
    const explicit = explicitRaw === undefined ? DEFAULT_TOKEN : explicitRaw;
    const send = async (bearer) => {
      if (route.split('?')[0] !== '/ping' && this.e2e) {
        if (this.serverPk === null) await this.ensureE2e();   // 公钥对不上会在这里抛
        if (this.serverPk !== null) return this._encRequest(method, route, payload, bearer, options.timeoutMs);
      }
      return this._plainRequest(method, route, payload, bearer, options.timeoutMs);
    };
    const retryable = options.skipRetry !== true && route.split('?')[0] !== '/auth/refresh';
    const bearer = retryable ? this._authToken(explicit) : explicit;
    const mayRefresh = retryable && explicit === DEFAULT_TOKEN && Boolean(this.refreshToken);
    try {
      return await send(bearer);
    } catch (error) {
      // 只有"令牌过期"才续期：会话被注销 / 令牌无效 → 直接让上层报"重新登录"
      if (error?.code !== 'token_expired' || !mayRefresh) throw error;
    }
    await this.refreshAccessToken();              // 失败就抛，**不重试**
    try {
      return await send(this.authToken());        // 原请求重试，仅此一次
    } catch (error) {
      // 重试之后还是过期（理论上不该发生：刚拿到的新 JWT）→ 说清楚，别再续
      if (error?.code === 'token_expired') {
        throw new PhixError('token_expired',
          '续期之后令牌仍然不可用，请重新登录', error.status || 401);
      }
      throw error;
    }
  }

  /**
   * 发一次 HTTP，返回 `{ status, text, data, headers }`。
   *
   * **为什么不用 `fetch`**：协议要求加密的 GET 也把信封放在**请求体**里
   * （查询串在信封的 `q` 字段里，URL 上不带 `?`），而 undici 的 `fetch` 直接拒绝
   * "GET 带 body"（`Request with GET/HEAD method cannot have body`）。
   * 服务端两样都收（实测 `node:http` 发 GET+体得到 200 并能解开信封），
   * 所以这里统一走 `node:http` / `node:https`。
   */
  _send(method, route, bodyText, headers, timeoutMs) {
    const url = new URL(this._url(route));
    const secure = url.protocol === 'https:';
    const transport = secure ? require('node:https') : require('node:http');
    const verb = String(method || 'GET').toUpperCase();
    const body = bodyText === undefined || bodyText === null ? null : Buffer.from(bodyText);
    const requestHeaders = { ...headers };
    if (body) requestHeaders['Content-Length'] = String(body.length);

    return new Promise((resolve, reject) => {
      const request = transport.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: verb,
        headers: requestHeaders,
        // 与 fetch 一样不做 keep-alive 复用：每次同步本来就串行，简单可靠优先
        agent: false,
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          clearTimeout(timer);
          const text = Buffer.concat(chunks).toString('utf8');
          let data = {};
          try { data = JSON.parse(text); } catch { data = {}; }
          resolve({ status: response.statusCode, text, data, headers: response.headers });
        });
        response.on('error', (error) => { clearTimeout(timer); reject(error); });
      });

      const timer = setTimeout(() => {
        request.destroy();
        reject(new PhixError('network', `连接超时：${this.server}`));
      }, timeoutMs || this.timeout);

      request.on('error', (error) => {
        clearTimeout(timer);
        if (error instanceof PhixError) { reject(error); return; }
        reject(new PhixError('network', `连不上 phix 服务：${error?.message || error}`));
      });
      if (body) request.write(body);
      request.end();
    });
  }

  /** 明文路径（老客户端 / 服务端不支持加密时的回退）。 */
  async _plainRequest(method, route, payload, token, timeoutMs) {
    const headers = this.authHeaders({
      token: token === undefined ? DEFAULT_TOKEN : token,
      json: payload !== undefined && payload !== null,
    });
    const bodyText = payload === undefined || payload === null ? undefined : Buffer.from(JSON.stringify(payload), 'utf8');
    const response = await this._send(method, route, bodyText, headers, timeoutMs);
    return PhixClient._decode(response.status, response.data);
  }

  /** 加密路径：请求体是信封，响应体也是信封。 */
  async _encRequest(method, route, payload, token, timeoutMs) {
    const cut = route.indexOf('?');
    const routeOnly = cut < 0 ? route : route.slice(0, cut);
    const query = cut < 0 ? '' : route.slice(cut + 1);
    // AAD 里用**完整路径**（含 /api/v1 前缀）—— 服务端那侧看到的就是它。
    // 查询串放进信封的 q 字段，URL 上不带 ?，于是 URL 里什么都不泄露。
    const fullPath = `${API_PREFIX}${routeOnly}`;
    const headers = { ...this.authHeaders({ token: token === undefined ? DEFAULT_TOKEN : token }), 'X-Phix-Enc': '1', 'Content-Type': 'application/json; charset=utf-8' };

    const { envelope, sk } = phixCrypto.makeEnvelope(this.serverPk, method, fullPath, payload ?? null, query);
    const response = await this._send(method, routeOnly, Buffer.from(JSON.stringify(envelope), 'utf8'), headers, timeoutMs);

    let data = response.data;
    // 信封解不开时服务端回的是**明文**错误（它那时还没拿到会话密钥），
    // 所以必须按内容判断，不能只看状态码 / 只看头。
    if (data && typeof data === 'object' && 'iv' in data && 'ct' in data) {
      try {
        data = JSON.parse(phixCrypto.openEnvelopeResponse(sk, method, fullPath, data).toString('utf8'));
      } catch (error) {
        throw new PhixError('bad_envelope',
          `服务器回复的信封解不开：${error?.message || error}`, response.status);
      }
    }
    return PhixClient._decode(response.status, data);
  }

  /** 状态码 + 解析后的 JSON → 数据，或带 code 的 PhixError。 */
  static _decode(status, data) {
    if (!data || typeof data !== 'object') data = {};
    if (status >= 400 || !(data.ok === true || (data.ok === undefined && status < 400))) {
      const info = data.error || {};
      throw new PhixError(info.code || 'server_error', info.message || `服务端返回 ${status}`, status, data);
    }
    return data;
  }

  // -- 认证 --
  ping() { return this._request('GET', '/ping', null, ''); }

  /**
   * 身份凭证：v2 账号发 `auth_hash`（服务器由此反推不出口令、更算不出 KEK），
   * v1 老账号只能发口令原文。服务端两边都收，客户端按账号的 `kdf_algo` 决定发哪种。
   *
   * 注意用的是 **auth_salt**（注册时定下、永不改变），不是 `kdf_salt`
   * （那个会随换包裹口令而变）—— 用错会导致换了同步口令之后登录失败。
   */
  static credential(password = null, { authSalt = null, algo = null, material = null, prefix = '' } = {}) {
    if (material && material.auth_hash) return { [`${prefix}auth_hash`]: material.auth_hash };
    if (password !== null && authSalt && algo && phixCrypto.usesAuthHash(algo)) {
      return { [`${prefix}auth_hash`]: phixCrypto.authHashHex(password, authSalt, algo) };
    }
    if (password !== null) return { [`${prefix}password`]: password };
    return {};
  }

  /**
   * 取某个账号的**公开**密钥材料（免登录）。
   * 客户端靠它知道这个账号的 `kdf_algo` 与 `auth_salt` —— 决定登录时发
   * AuthHash 还是口令原文、以及用哪个盐算。
   */
  keymaterial(username) {
    return this._request('POST', '/auth/keymaterial', { username }, '');
  }

  /** 与 `keymaterial` 同义（Python 侧两个名字都有，这里保留一个别名免得调用方找不着）。 */
  keyMaterial(username) { return this.keymaterial(username); }

  async register(username, password, device = '', material = null, agree = true) {
    const mat = material || phixCrypto.newMaterial(username, password);
    const body = {
      username, agree: Boolean(agree), device,
      kdf_algo: mat.kdf_algo, kdf_salt: mat.kdf_salt,
      auth_salt: mat.auth_salt || '',
      key_wrap: mat.key_wrap, key_mode: mat.key_mode,
      key_check: mat.key_check, key_check_plain: mat.key_check_plain,
      recovery_salt: mat.recovery_salt, recovery_wrap: mat.recovery_wrap,
    };
    Object.assign(body, PhixClient.credential(password, { material: mat }));
    const data = await this._request('POST', '/auth/register', body, '');
    // 注册响应里也带着令牌组（与登录一模一样），顺手收下来
    this._adoptResponseTokens(data);
    return [data, mat];
  }

  /**
   * 登录。
   *
   * 先问一次 `/auth/keymaterial` 拿该账号的 `kdf_algo` 与 `auth_salt`：
   * v2 账号发 `auth_hash`（**服务器永远见不到口令**），v1 老账号发口令原文。
   */
  async login(username, password, device = '', serverMeta = null) {
    const meta = serverMeta !== null && serverMeta !== undefined ? serverMeta : await this.keymaterial(username);
    const algo = meta.kdf_algo || phixCrypto.KDF_ALGO_V1;
    const authSalt = meta.auth_salt || meta.kdf_salt;
    const body = { username, device };
    Object.assign(body, PhixClient.credential(password, { authSalt, algo }));
    const data = await this._request('POST', '/auth/login', body, '');
    this._adoptResponseTokens(data);
    return data;
  }

  /**
   * 登录/注册响应 → 本项目里的三串。
   *
   * `token` 是 P3 之后的**兼容字段**（老式长期令牌），仍然收下当兜底；
   * 业务请求优先用 `access_token`，`expires_at` 只是给界面看的信息。
   */
  _adoptResponseTokens(data) {
    if (!data || typeof data !== 'object') return this;
    const access = typeof data.access_token === 'string' ? data.access_token : '';
    const refresh = typeof data.refresh_token === 'string' ? data.refresh_token : '';
    const legacy = typeof data.token === 'string' ? data.token : '';
    if (legacy) this.legacyToken = legacy;
    return this.setTokens({ access: access || legacy, refresh });
  }

  /** 当前用户信息（免参数用自己的令牌；显式给一串就用那一串）。 */
  me(token = DEFAULT_TOKEN) { return this._request('GET', '/auth/me', null, token); }

  /** 登出当前会话（服务端会把这条会话**整条**注销，JWT 与老式令牌一起失效）。 */
  logout(token = DEFAULT_TOKEN) { return this._request('POST', '/auth/logout', {}, token); }

  /**
   * 换登录密码。
   *
   * - `material` 里**没给的字段一律不发** —— syncphrase 模式改登录密码时不应带上
   *   key_wrap，否则会把 DEK 的包裹方式换掉。
   * - `oldAuthSalt` / `oldAlgo` 是**当前**账号的凭证盐与代次，用来算旧凭证。
   */
  changePassword(oldPassword, newPassword, dekProof, material = {}, options = {}) {
    const body = { dek_proof: dekProof };
    Object.assign(body, PhixClient.credential(oldPassword,
      { authSalt: options.oldAuthSalt || null, algo: options.oldAlgo || null, prefix: 'old_' }));
    Object.assign(body, PhixClient.credential(newPassword, { material, prefix: 'new_' }));
    for (const key of ['kdf_algo', 'kdf_salt', 'auth_salt', 'key_wrap', 'key_check', 'key_mode']) {
      if (material[key]) body[key] = material[key];
    }
    return this._request('POST', '/auth/password', body, options.token);
  }

  rewrap(password, dekProof, material, options = {}) {
    const body = {
      dek_proof: dekProof,
      kdf_algo: material.kdf_algo, kdf_salt: material.kdf_salt,
      auth_salt: material.auth_salt || '',
      key_wrap: material.key_wrap, key_check: material.key_check,
      key_mode: material.key_mode,
    };
    Object.assign(body, PhixClient.credential(password,
      { authSalt: options.authSalt || null, algo: options.algo || null }));
    return this._request('POST', '/auth/rewrap', body, options.token);
  }

  recover(username, newPassword, dekProof, material) {
    const body = {
      username,
      kdf_algo: material.kdf_algo, kdf_salt: material.kdf_salt,
      auth_salt: material.auth_salt || '',
      key_wrap: material.key_wrap, key_check: material.key_check,
      key_mode: material.key_mode, dek_proof: dekProof,
    };
    Object.assign(body, PhixClient.credential(newPassword, { material, prefix: 'new_' }));
    return this._request('POST', '/auth/recover', body, '');
  }

  /**
   * 会话（= 一次登录 = 一台设备）与老式令牌列表。响应里带 `sessions` 与 `devices`，
   * 还有 `access_ttl` / `refresh_ttl`；**列表里绝不会有 refresh 明文**。
   */
  devices(token = DEFAULT_TOKEN) { return this._request('GET', '/auth/devices', null, token); }

  /** 与 `devices` 同义（服务端那边叫 sessions，这里给个顺手的名字）。 */
  sessions(token = DEFAULT_TOKEN) { return this.devices(token); }

  /**
   * 注销会话 / 老式令牌。参数可组合：
   * `{ session_id }`（注销某台）、`{ all_except_current: true }`（注销除本机外全部）、
   * `{ token_id }`、`{ all_tokens: true }`。
   */
  revokeDevices(body = {}, token = DEFAULT_TOKEN) {
    return this._request('POST', '/auth/devices/revoke', body || {}, token);
  }

  // -- 同步 --
  manifest(token = DEFAULT_TOKEN) { return this._request('GET', '/sync/manifest', null, token); }

  getObject(name, token = DEFAULT_TOKEN) { return this._request('GET', PhixClient.objectRoute(name), null, token); }

  putObject(name, baseRevision, payload, device = '', token = DEFAULT_TOKEN) {
    return this._request('PUT', PhixClient.objectRoute(name),
      { base_revision: Number(baseRevision) || 0, payload, device }, token);
  }

  deleteObject(name, baseRevision, token = DEFAULT_TOKEN) {
    return this._request('PUT', PhixClient.objectRoute(name),
      { base_revision: Number(baseRevision) || 0, deleted: true }, token);
  }

  batch(items, token = DEFAULT_TOKEN) { return this._request('POST', '/sync/objects/batch', { objects: items }, token); }
}

// ---------------------------------------------------------------- 三方合并原语
/** 合并报告里不要出现 undefined（JSON 会把它丢掉,读起来像缺字段）。 */
function plain(value) { return value === MISSING || value === undefined ? null : value; }

/**
 * 把任何非 JSON 类型（尤其是内部哨兵）转成可序列化的形式。
 *
 * 兜底用：冲突记录会直接写进状态文件，一条不可序列化的值就会让整轮同步失败
 * （PLL 侧就是因为这个整轮崩过）。与 PLL 的 `_json_safe` 同语义。
 */
function jsonSafe(value) {
  if (value === MISSING || value === undefined) return null;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item));
  if (isObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[String(key)] = jsonSafe(item);
    return out;
  }
  if (typeof value === 'bigint') return Number(value);
  return String(value);
}

/** 缺省 / null / 空串 / 空字典 / 空数组 → 视为"没值"（与 PLL 的 `_is_empty` 一致）。 */
function isBlank(value) {
  if (value === MISSING || value === undefined || value === null) return true;
  if (typeof value === 'string') return value === '';
  if (Array.isArray(value)) return value.length === 0;
  if (isObject(value)) return Object.keys(value).length === 0;
  return false;
}

/** 标量/整体替换型值的三方合并。 */
function mergeScalar(base, local, remote, at, conflicts) {
  if (sameValue(local, remote)) return local;
  if (isMissing(base) || base === null) {
    // 没有基版 = 首次同步，或两边各自新增了这个键。
    // 这时让**空的那边让步**：否则一台新设备上还没配过的空值会把云端的配置抹掉
    // （实测：新设备首拉时 `ai.active_model` 被本机的 "" 覆盖，且没有任何提示）。
    if (isBlank(local) && !isBlank(remote)) return remote;
    if (isBlank(remote) && !isBlank(local)) return local;
    conflicts.push({
      path: at, local: plain(local), remote: plain(remote), base: null,
      note: '没有基版（首次同步或新增键），两边都有值且不同 → 保留本地',
    });
    return local;
  }
  if (sameValue(local, base)) return remote;   // 只有远端改了
  if (sameValue(remote, base)) return local;   // 只有本地改了
  conflicts.push({
    path: at, local: plain(local), remote: plain(remote), base: plain(base),
    note: '两边都改了且不同 → 保留本地',
  });
  return local;
}

/** 嵌套字典逐叶子三方合并。 */
function mergeDict(base, local, remote, at, conflicts) {
  const b = asMap(base);
  const l = asMap(local);
  const r = asMap(remote);
  const out = {};
  const keys = [...new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])].sort();
  for (const key of keys) {
    const baseValue = Object.hasOwn(b, key) ? b[key] : MISSING;
    const localValue = Object.hasOwn(l, key) ? l[key] : MISSING;
    const remoteValue = Object.hasOwn(r, key) ? r[key] : MISSING;
    const sub = at ? `${at}.${key}` : String(key);
    if (isMissing(localValue) && isMissing(remoteValue)) continue;   // 两边都没有 = 删掉
    if (isMissing(localValue)) {
      out[key] = isMissing(remoteValue) ? null : remoteValue;
      if (!isMissing(baseValue) && isMissing(remoteValue)) {
        conflicts.push({ path: sub, local: null, remote: null, base: plain(baseValue), note: '本地删除、远端也删除' });
      }
      continue;
    }
    if (isMissing(remoteValue)) {
      if (isMissing(baseValue)) {
        out[key] = localValue;                                     // 只是本地新增
      } else if (sameValue(localValue, baseValue)) {
        continue;                                                  // 远端删了且本地没动 → 跟着删
      } else {
        out[key] = localValue;
        conflicts.push({ path: sub, local: plain(localValue), remote: null, base: plain(baseValue), note: '远端删除、本地又改过 → 保留本地' });
      }
      continue;
    }
    if (isObject(localValue) || isObject(remoteValue)) {
      const mergedNested = mergeDict(isObject(baseValue) ? baseValue : {}, asMap(localValue), asMap(remoteValue), sub, conflicts);
      // 逐叶子合出来的结果如果与本地一模一样，就返回**本地那个原对象**：
      // 新建的等值对象在上一层 `sameValue(l, base)` 眼里是"本地改过了"，
      // 而这一层又没冲突记录 —— 上一层会因此改信远端，用远端的（可能是空的）
      // 值把本地内容覆盖掉，而且一声不吭。实测：远端 B 只加了供应商、
      // 本地 A 改过 active_model，合并后 A 的 active_model 被远端空值抹成 ""。
      out[key] = Object.keys(mergedNested).length || !Object.keys(asMap(localValue)).length
        ? mergedNested : localValue;
      continue;
    }
    out[key] = mergeScalar(isMissing(baseValue) ? MISSING : baseValue, localValue, remoteValue, sub, conflicts);
  }
  return out;
}

/**
 * 按 key 取并集的三方合并（用于选课、日程、课卡这类"带主键的集合"）。
 *
 * `unionOnly` 时**只取并集、永不删除、不报冲突、冲突时留本地** ——
 * 用于课表这类"抓取缓存":某台设备没有某天的数据不代表那天没课,
 * 把"本地缺"当成"用户删了"会导致两台设备互相删除 / 互相恢复地打架。
 */
function mergeListOfDicts(base, local, remote, keyOf, at, conflicts, unionOnly = false) {
  const index = (rows) => {
    const out = new Map();
    for (const row of asList(rows)) {
      if (!isObject(row)) continue;
      const key = keyOf(row);
      if (key === null || key === undefined || String(key) === '') continue;
      out.set(String(key), row);
    }
    return out;
  };

  const bi = index(base);
  const li = index(local);
  const ri = index(remote);
  const out = [];
  const order = [...li.keys(), ...[...ri.keys()].filter((key) => !li.has(key))];
  for (const key of order) {
    const b = bi.has(key) ? bi.get(key) : MISSING;
    const l = li.has(key) ? li.get(key) : MISSING;
    const r = ri.has(key) ? ri.get(key) : MISSING;
    if (isMissing(l) && isMissing(r)) continue;
    if (unionOnly) {
      out.push(isMissing(l) ? r : l);        // 远端有、本地没有 → 收下;两边都有 → 留本地
      continue;
    }
    if (isMissing(l)) { out.push(r); continue; }          // 远端新增（且本地没有）
    if (isMissing(r)) {
      if (isMissing(b)) {
        out.push(l);                                      // 本地新增
      } else if (sameValue(l, b)) {
        continue;                                         // 本地没动、远端删了 → 跟着删
      } else {
        out.push(l);
        conflicts.push({ path: `${at}[${key}]`, local: plain(l), remote: null, base: plain(b), note: '远端删除、本地又改过 → 保留本地' });
      }
      continue;
    }
    if (sameValue(l, r)) { out.push(l); continue; }
    if (!isMissing(b) && sameValue(r, b)) { out.push(l); continue; }   // 只有本地改了
    if (!isMissing(b) && sameValue(l, b)) { out.push(r); continue; }   // 只有远端改了
    // 两边都改了 → 用带时间戳的字段判断新旧,判不了就保留本地并报告
    const pick = pickNewer(l, r);
    out.push(pick);
    if (pick === l) {
      conflicts.push({
        path: `${at}[${key}]`, local: plain(l), remote: plain(r),
        base: isMissing(b) ? null : plain(b),
        note: '同一条两边都改了 → 取较新的（本地），远端那份见冲突记录',
      });
    }
  }
  return out;
}

/** 从一行里挑出可比的时间戳（只认字符串,与 Python `_ts_of` 一致）。 */
function timestampOf(row) {
  if (!isObject(row)) return null;
  for (const field of ['updated_at', 'modified_at', 'created', 'fetched_at']) {
    const value = row[field];
    if (typeof value === 'string' && value) {
      const time = Date.parse(value.replace(/Z$/, '+00:00'));
      if (Number.isFinite(time)) return time / 1000;
    }
  }
  return null;
}

function pickNewer(a, b) {
  const ta = timestampOf(a);
  const tb = timestampOf(b);
  if (ta !== null && tb !== null && ta !== tb) return ta > tb ? a : b;
  return a;
}

/**
 * 日程事件的三方合并,**专治跨设备 id 撞车**。
 *
 * 两个设备各自"现存最大 id + 1"时很容易同时分配到同一个 id（第一次同步后
 * 两边 id 集合相同,紧接着各加一条就必然撞车）。这时候不能二选一 ——
 * 交接文档 §7.2.5 明确要求**保留两份**:本地那条留住原 id,远端那条**改号**后照样留下。
 *
 * `base` 传 `null` 表示**本地根本没有这一轮的基版快照**（第一次同步、换账号、
 * 老状态还没搬过来、本地文件被别的程序重写过）。这时"本地没有某条"只说明
 * "这份本地文件不是那个 revision 的副本"，**不能**当成"用户删了" ——
 * 否则合并结果会把远端那些事件删掉，还会原样推回云端覆盖别人的数据
 * （Python 的 `_merge_events` 就是这样，属它的既有行为；这里按"本地 data/ 是
 * 唯一真相源、绝不静默丢数据"的原则改成取并集）。
 *
 * 返回 `{ events, nextId }`。
 */
function mergeEvents(base, local, remote, nextId, conflicts) {
  const index = (rows) => {
    const out = new Map();
    for (const row of asList(rows)) {
      if (!isObject(row) || !Number.isInteger(row.id)) continue;
      out.set(row.id, row);
    }
    return out;
  };

  const bi = index(base);
  const li = index(local);
  const ri = index(remote);
  const out = new Map();
  const dupes = [];
  let next = nextId;
  const order = [...li.keys(), ...[...ri.keys()].filter((key) => !li.has(key))];

  // 没有基版 → 只取并集:两边的每一条都留下,同 id 取带时间戳更新的那一份。
  if (base === null || base === undefined) {
    for (const key of order) {
      const l = li.has(key) ? li.get(key) : MISSING;
      const r = ri.has(key) ? ri.get(key) : MISSING;
      if (isMissing(l) && isMissing(r)) continue;
      if (isMissing(l)) { out.set(key, r); continue; }
      if (isMissing(r)) { out.set(key, l); continue; }
      if (sameValue(l, r)) { out.set(key, l); continue; }
      const pick = pickNewer(l, r);
      out.set(key, pick);
      conflicts.push({
        path: `events[${key}]`, local: plain(l), remote: plain(r), base: null,
        note: pick === l
          ? '没有基版快照可判断，同一条两边不同 → 保留本地（远端那份见本条记录）'
          : '没有基版快照可判断，同一条两边不同 → 取较新的那份（本地那份见本条记录）',
      });
    }
    return { events: [...out.values()], nextId: next };
  }

  for (const key of order) {
    const b = bi.has(key) ? bi.get(key) : MISSING;
    const l = li.has(key) ? li.get(key) : MISSING;
    const r = ri.has(key) ? ri.get(key) : MISSING;
    if (isMissing(l) && isMissing(r)) continue;
    if (isMissing(l)) {
      if (isMissing(b)) {
        out.set(key, r);                                  // 远端新增
      } else if (sameValue(r, b)) {
        continue;                                         // 本地删了、远端没动 → 跟着删
      } else {
        out.set(key, r);                                  // 本地删了但远端改过 → 保留远端
        conflicts.push({ path: `events[${key}]`, local: null, remote: plain(r), base: plain(b), note: '本地删除、远端又改过 → 保留远端那份' });
      }
      continue;
    }
    if (isMissing(r)) {
      if (isMissing(b)) {
        out.set(key, l);                                  // 本地新增
      } else if (sameValue(l, b)) {
        continue;                                         // 本地没动、远端删了 → 跟着删
      } else {
        out.set(key, l);                                  // 远端删了但本地改过 → 保留本地
        conflicts.push({ path: `events[${key}]`, local: plain(l), remote: null, base: plain(b), note: '远端删除、本地又改过 → 保留本地' });
      }
      continue;
    }
    if (sameValue(l, r)) { out.set(key, l); continue; }
    if (!isMissing(b) && sameValue(r, b)) { out.set(key, l); continue; }   // 只有本地改了
    if (!isMissing(b) && sameValue(l, b)) { out.set(key, r); continue; }   // 只有远端改了
    if (!isMissing(b)) {
      const pick = pickNewer(l, r);
      out.set(key, pick);
      conflicts.push({
        path: `events[${key}]`, local: plain(l), remote: plain(r), base: plain(b),
        note: '同一条两边都改了 → 取较新的那份，另一份见本条记录',
      });
      continue;
    }
    // 两边各自新增、却撞了同一个 id → 保留本地,远端改号
    out.set(key, l);
    dupes.push(r);
  }

  for (const row of dupes) {
    while (out.has(next)) next += 1;
    const moved = { ...row, id: next };
    out.set(next, moved);
    conflicts.push({
      path: `events[${row && row.id}]`,
      local: row ? row.title : null,
      remote: row ? row.title : null,
      note: `两台设备各自新增了一条日程、id 撞车 → 远端那条改号为 ${next}，两份都保留`,
    });
    next += 1;
  }

  return { events: [...out.values()], nextId: next };
}

// ---------------------------------------------------------------- YAML 段读写
//
// `settings.yaml` 与 PLL 共用,而且里面有用户手写的注释与两个程序都可能加的未知字段,
// 所以**只替换自己要写的那个顶层段**,其余字节原样保留(与 PHL 现有做法一致:
// `settings-yaml.cjs` 的 `replaceBlock`)。段内的结构按 YAML 解析,写回时重新序列化。

/** 行内列表 `[a, b]` 的分段：认得单/双引号里的逗号。 */
function splitFlowItems(inner) {
  const items = [];
  let current = '';
  let quote = '';
  for (const char of String(inner)) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    if (char === ',') { items.push(current); current = ''; continue; }
    current += char;
  }
  items.push(current);
  return items.map((item) => item.trim()).filter((item) => item !== '');
}

/** YAML 标量 → JS 值（行内 `[]` / `{}` 也认，别的原样当字符串）。 */
function parseYamlValue(raw) {
  const text = String(raw === undefined ? '' : raw).trim();
  if (!text) return '';
  if (text === 'null' || text === '~') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text.startsWith('[') && text.endsWith(']')) {
    return splitFlowItems(text.slice(1, -1)).map((item) => parseYamlValue(item));
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    const out = {};
    for (const item of splitFlowItems(text.slice(1, -1))) {
      const pair = mappingPair(item);
      if (pair) out[pair.key] = pair.value ? parseYamlValue(pair.value) : null;
    }
    return out;
  }
  return sharedSettings.parseYamlScalar(text);
}

/** 顶层段头的正则。**必须排除键名里带冒号的行**：
 *  `secrets_extra` 段里的 `phix:token: …` 缩进两层，用宽松的 `phix\s*:` 会把它
 *  当成 `phix` 段的开头，于是读出来的"phix 段"里只有一把令牌，
 *  真正的 `phix:` 段反而被跳过（实测：登录后 server / username 读不回来）。 */
function sectionHeaderPattern(name) {
  return new RegExp(`^([ \\t]*)${name}[ \\t]*:(?![:_\\w.-])(.*)$`);
}

/** 解析一个顶层段为 JS 值（字典 / 列表 / 标量）。缺失或坏行一律容错。 */
function parseYamlSection(text, name) {
  const keyLine = sectionHeaderPattern(name);
  const lines = String(text || '').replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').split('\n');
  let start = -1;
  let headerIndent = 0;
  let inline = '';
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(keyLine);
    if (match) { start = index; headerIndent = match[1].length; inline = match[2].trim(); break; }
  }
  if (start < 0) return null;
  if (inline && !inline.startsWith('#')) return parseYamlValue(inline);
  // 收集这一段的行:更深的缩进属于它;与它同缩进的 `- ` 列表项也属于它
  // （PLL 写选课时就写成 `lessons:` 换行后紧跟顶格的 `- subject: …`）。
  const tokens = [];
  let bodyIndent = -1;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.match(/^[ \t]*/)[0].length;
    const isItem = /^-[ \t]/.test(line.trim()) || line.trim() === '-';
    if (indent > headerIndent) { tokens.push({ indent, text: line.trim() }); }
    else if (indent === headerIndent && isItem) { tokens.push({ indent, text: line.trim() }); }
    else break;
    bodyIndent = bodyIndent < 0 ? indent : Math.min(bodyIndent, indent);
  }
  if (!tokens.length) return null;
  return parseYamlNode(tokens, 0, bodyIndent).value;
}

/** 一组同缩进的行 → JS 值。`- ` 开头是列表,`key: value` 是字典。 */
function parseYamlNode(tokens, start, indent) {
  const isItem = (token) => token.text.startsWith('- ') || token.text === '-';
  return isItem(tokens[start]) ? parseSequence(tokens, start, indent) : parseMapping(tokens, start, indent);
}

/** 列表:每个 `- ` 起一项,更深的缩进是这一项的内容。 */
function parseSequence(tokens, start, indent) {
  const out = [];
  let index = start;
  while (index < tokens.length && tokens[index].indent === indent && tokens[index].text.startsWith('- ')) {
    const content = tokens[index].text.slice(2).trim();
    if (!content) {
      index = skipBlock(tokens, index + 1, indent);
      out.push(null);
      continue;
    }
    const childIndent = nextIndent(tokens, index + 1, indent);
    const pair = mappingPair(content);
    if (pair) {
      // `- id: p1` + 更深缩进的同项其余键（`models:` / `name:` …）
      const item = {};
      if (pair.value) item[pair.key] = parseYamlValue(pair.value);
      index += 1;
      if (childIndent >= 0) {
        const nested = parseMapping(tokens, index, childIndent);
        Object.assign(item, nested.value);
        index = nested.next;
      }
      out.push(item);
      continue;
    }
    out.push(parseYamlValue(content));
    index = childIndent >= 0 ? skipBlock(tokens, index + 1, indent) : index + 1;
  }
  return { value: out, next: index };
}

/** 字典:同缩进的 `key: value`;值为空时,更深的缩进（或同缩进的 `- `）是它的内容。 */
function parseMapping(tokens, start, indent) {
  const out = {};
  let index = start;
  while (index < tokens.length && tokens[index].indent === indent) {
    const pair = mappingPair(tokens[index].text);
    if (!pair) { index += 1; continue; }
    index += 1;
    if (pair.value) { out[pair.key] = parseYamlValue(pair.value); continue; }
    const childIndent = nextIndent(tokens, index, indent);
    if (childIndent < 0) { out[pair.key] = null; continue; }
    // 同缩进的 `- ` 列表（YAML 允许序列与父键同缩进）走序列分支,否则走字典分支。
    const isSequence = tokens[index].text.startsWith('- ') && tokens[index].indent === childIndent;
    const parsed = isSequence
      ? parseSequence(tokens, index, childIndent)
      : parseMapping(tokens, index, childIndent);
    out[pair.key] = parsed.value;
    index = isSequence ? skipBlock(tokens, parsed.next, indent) : parsed.next;
  }
  return { value: out, next: index };
}

/**
 * `key: value` 行 → `{key, value}`;不是键值对返回 null。
 *
 * 按**最后一个** `: ` 切分：令牌、凭据这类键名里就带冒号
 * （`secrets_extra: {phix:token: …}`），只切第一个冒号会把键截断成 `phix`。
 */
function mappingPair(text) {
  const line = String(text);
  let cut = -1;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== ':') continue;
    if (index + 1 === line.length || line[index + 1] === ' ' || line[index + 1] === '\t') cut = index;
  }
  if (cut <= 0) return null;
  const key = line.slice(0, cut).trim();
  if (!key || key.startsWith('-')) return null;
  const value = line.slice(cut + 1).trim();
  return { key, value: value.startsWith('#') ? '' : value };
}

/** 下一行相对 `indent` 的块缩进;不是子块就是 -1。 */
function nextIndent(tokens, index, indent) {
  if (index >= tokens.length) return -1;
  const next = tokens[index];
  if (next.indent > indent) return next.indent;
  if (next.indent === indent && next.text.startsWith('- ')) return next.indent;
  return -1;
}

/** 跳过一段比 `indent` 更深的行。 */
function skipBlock(tokens, index, indent) {
  let cursor = index;
  while (cursor < tokens.length && tokens[cursor].indent > indent) cursor += 1;
  return cursor;
}

/** JS 值 → YAML 行;标量一律加引号,免得 `>`/`=`/中文数字被别的解析器读成别的类型。 */
function yamlLines(value, indent) {
  const pad = ' '.repeat(indent);
  const scalar = (item) => {
    if (typeof item === 'boolean') return item ? 'true' : 'false';
    if (typeof item === 'number' && Number.isFinite(item)) return String(item);
    if (item === null || item === undefined) return "''";
    const text = String(item).replace(/[\r\n]+/g, ' ');
    return `'${text.replace(/'/g, "''")}'`;
  };
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      if (isObject(item)) {
        const entries = Object.entries(item);
        if (!entries.length) { out.push(`${pad}- {}`); continue; }
        let first = true;
        for (const [key, sub] of entries) {
          const prefix = `${pad}${first ? '- ' : '  '}${key}:`;
          first = false;
          if (Array.isArray(sub) || isObject(sub)) {
            if (isEmptyCollection(sub)) { out.push(`${prefix} ${Array.isArray(sub) ? '[]' : '{}'}`); continue; }
            out.push(prefix);
            out.push(...yamlLines(sub, indent + 4));
          } else {
            out.push(`${prefix} ${scalar(sub)}`);
          }
        }
      } else if (Array.isArray(item)) {
        out.push(`${pad}- [${item.map((it) => scalar(it)).join(', ')}]`);
      } else {
        out.push(`${pad}- ${scalar(item)}`);
      }
    }
    return out.length ? out : [`${pad}[]`];
  }
  if (isObject(value)) {
    const entries = Object.entries(value);
    if (!entries.length) return [`${pad}{}`];
    const out = [];
    for (const [key, sub] of entries) {
      if (Array.isArray(sub) || isObject(sub)) {
        // 空数组 / 空对象写成行内 `[]` / `{}`（写成单独一行、下面什么都没有的话，
        // 读回来会被当成"这个键的值为空"）。
        if (isEmptyCollection(sub)) { out.push(`${pad}${key}: ${Array.isArray(sub) ? '[]' : '{}'}`); continue; }
        out.push(`${pad}${key}:`);
        out.push(...yamlLines(sub, indent + 2));
      } else {
        out.push(`${pad}${key}: ${scalar(sub)}`);
      }
    }
    return out;
  }
  return [`${pad}${scalar(value)}`];
}

const isEmptyCollection = (value) => (Array.isArray(value) && !value.length)
  || (isObject(value) && !Object.keys(value).length);

/**
 * 合并结果 → 顶层段文本（末尾带一个空行，作为与下一段的分隔）。
 *
 * 喂给下面的 `replaceSettingsSection`，**不能喂给 `settings-yaml.cjs` 的
 * `replaceBlock`** —— 那个函数把"列 0 的非缩进行"当作段结束，正好会漏掉
 * PLL 写选课的那种"顶格 `- subject:`"格式（实测写一次就多出一份重复行）。
 */
function serializeYamlSection(name, value) {
  if (Array.isArray(value)) return value.length ? `${name}:\n${yamlLines(value, 0).join('\n')}\n\n` : `${name}: []\n\n`;
  if (isObject(value)) {
    const entries = Object.entries(value);
    if (!entries.length) return `${name}: {}\n\n`;
    return `${name}:\n${yamlLines(value, 2).join('\n')}\n\n`;
  }
  return `${name}: ${yamlLines(value, 0)[0].trim()}\n\n`;
}

/**
 * 段的结尾：从 `start` 往下，跳过缩进行、空行与注释；**与段头同缩进的列表项
 * （顶格 `- …`）也算这一段**（PLL 写选课就是 `lessons:` 换行后紧跟顶格
 * `- subject: …`）；遇到下一个顶层键才停。
 */
function settingsSectionEnd(lines, start, headerIndent) {
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/.test(line)) { index += 1; continue; }
    const indent = line.match(/^[ \t]*/)[0].length;
    if (indent > headerIndent) { index += 1; continue; }
    if (indent === headerIndent && /^-[ \t]/.test(line.trim())) { index += 1; continue; }
    break;
  }
  return index;
}

/**
 * 替换 `settings.yaml` 的一个顶层段,别的字节（注释、别的段、未知字段）原样保留。
 *
 * 与 `settings-yaml.cjs` 的 `replaceBlock` 的区别：这里认得**与段头同缩进的列表项**
 * （`lessons:` 换行后紧跟顶格 `- subject: …`，PLL 就是这么写的），
 * 所以不会把段的后半截留在原地。
 */
function replaceSettingsSection(text, name, body) {
  const source = String(text == null ? '' : text).replace(/^\ufeff/, '');
  const lines = source.split('\n');
  const pattern = sectionHeaderPattern(name);
  const start = lines.findIndex((line) => pattern.test(line));
  if (start < 0) {
    // 文件里还没有这一段:补在末尾（原本非空就先留一个空行分隔）。
    const base = source && !source.endsWith('\n') ? `${source}\n` : source;
    const gap = base && !base.endsWith('\n\n') ? '\n' : '';
    return `${base}${gap}${body}`;
  }
  const headerIndent = lines[start].match(/^[ \t]*/)[0].length;
  const end = settingsSectionEnd(lines, start, headerIndent);
  const before = lines.slice(0, start).join('\n');
  const after = lines.slice(end).join('\n');
  const head = start === 0 ? '' : `${before}\n`;
  return `${head}${body}${after}`;
}

/** 读一段（拿不到就是 null,与"段里没有内容"区分不开时按 Python 的 `or {}` 处理）。 */
function readSettingsSection(filePath, name) {
  const text = sharedSettings.readTextFile(filePath);
  if (!text) return null;
  try { return parseYamlSection(text, name); } catch { return null; }
}

/** 只替换这一段,其余字节（注释、别的段、未知字段）原样保留。 */
function writeSettingsSection(filePath, name, value) {
  const text = sharedSettings.readTextFile(filePath);
  const body = serializeYamlSection(name, value);
  sharedSettings.atomicWriteFileSync(filePath, replaceSettingsSection(text, name, body));
}

// ---------------------------------------------------------------- 同步引擎
/** 一次同步的完整流程。**每次同步新建一个实例**,DEK 只存在内存里。 */
class SyncEngine {
  constructor(client, dek, userId, username, options = {}) {
    this.client = client;
    this.dek = Buffer.isBuffer(dek) ? dek : Buffer.from(dek || '', 'hex');
    this.userId = Number(userId) || 0;
    this.username = String(username || '');
    this.root = path.resolve(options.dataDir || process.cwd());
    this.device = options.device || deviceName();
    this.objects = Array.isArray(options.objects) && options.objects.length
      ? [...options.objects] : [...DEFAULT_OBJECTS];
    // 互斥的是"对方那个程序":PHL 要防的是 PLL（`.pll-running`）,反之亦然。
    this.siblingApp = String(options.siblingApp || 'pll') === 'phl' ? 'phl' : 'pll';
  }

  // ---------- 状态文件 ----------
  //
  // 状态与快照**按账号隔离**：`data/.sync/accounts/<账号>/`。
  //
  // 为什么必须隔离：快照是"上次同步后的明文"，三方合并靠它判断删除。
  // 如果在同一个 `data/` 上换了 phix 账号却沿用旧账号的快照，
  // 新账号云端没有的内容会被判成"远端删除了" → **把本地数据删掉**。
  // 同一个账号下两个程序（PHL/PLL）共享同一份，这正是我们想要的。
  get accountName() { return safeAccountName(this.username); }

  get accountDir() { return path.join(this.root, SYNC_DIR, ACCOUNTS_SUBDIR, this.accountName); }

  get legacyStatePath() { return path.join(this.root, SYNC_DIR, STATE_NAME); }

  get statePath() { return path.join(this.accountDir, STATE_NAME); }

  get snapshotDir() { return path.join(this.accountDir, SNAPSHOT_SUBDIR); }

  /**
   * 把老布局的 `.sync/state.json`（没分账号）搬进按账号的目录。
   *
   * 只在**它确实属于当前账号**时搬，而且是"复制"：老文件与老快照**原样留着、绝不删**。
   * 老文件里的 `username` 是别的账号 → 一个字都不动它。
   *
   * 迁移时**故意不把老快照当成可信基版**：老布局是"一台机器一份"，谁写的都可能。
   * 若把一份**属于别人 / 不完整**的老快照当基版，三方合并会把"本地没有"当成
   * "本地删了"，反而把云端数据删掉（实测就是这么丢 4 条日程的）。
   * 拿不准就退回"只取并集"（见 `mergeEvents`），第一轮同步会重建出正确的本地文件
   * 与快照，之后照常增量同步。
   */
  migrateLegacyState() {
    if (!fs.existsSync(this.legacyStatePath) || fs.existsSync(this.statePath)) return false;
    const doc = readJson(this.legacyStatePath, null);
    if (!isObject(doc) || !isObject(doc.objects) || !Object.keys(doc.objects).length) return false;
    const owner = doc.username;
    if (owner && String(owner) !== String(this.username)) return false;
    // 老快照干脆不要：省得把不属于本账号的明文当成基版
    if (isObject(doc.objects)) {
      for (const entry of Object.values(doc.objects)) {
        if (isObject(entry)) entry.sha256 = '';
      }
    }
    this.saveState(doc);
    return true;
  }

  loadState() {
    this.migrateLegacyState();
    return asMap(readJson(this.statePath, {}));
  }

  saveState(state) {
    state.version = 1;
    state.kind = STATE_KIND;
    // 兜底：冲突记录会直接写进状态文件，**一条不可序列化的值就会让整轮同步失败**
    // （Python 侧就是因为把内部哨兵 `_MISSING` 写进来而整轮 TypeError）。
    // 这里与 PLL 的 `save_state` 一样做一次归一，只留最近 50 条。
    state.conflicts = asList(state.conflicts).map((entry) => jsonSafe(entry)).slice(-50);
    writeJson(this.statePath, state);
  }

  // 快照文件名与 PLL 逐字符一致（`:` / `/` 换成 `__`）:
  // 两个程序读写同一份 `.sync/last/`,命名不同就等于各自记各自的基版,三方合并会退化。
  _snapshotPath(name) {
    const safe = String(name).replace(/:/g, '__').replace(/\//g, '__');
    return path.join(this.snapshotDir, `${safe}.json`);
  }

  /**
   * 取"上次同步后的明文"作为三方合并的**基版**。
   *
   * **只有当状态文件里的 `sha256` 与快照文件内容一致时才认它。**
   * 快照文件可能来自别处（老布局迁移过来的、被别的程序改写的），拿一份不完整
   * 或不属于本轮的明文当基版，会把"本地没有"误判成"本地删了"，于是**静默删掉
   * 远端的数据**（实测：base 有 5 条、本地只剩 1 条、远端 5 条 → 合并结果只剩 1 条，
   * 还把删除推回云端）。
   *
   * 对不上就返回 null → 合并退化成"只取并集"（没有基版时的既有语义），
   * 宁可这轮不传播删除，也绝不猜着删。
   */
  loadSnapshot(name) {
    const snapshot = readJson(this._snapshotPath(name), null);
    if (snapshot === null || snapshot === undefined) return null;
    const entry = asMap(asMap(this.loadState().objects)[name]);
    if (entry.sha256 !== hashDocument(snapshot)) return null;
    return snapshot;
  }

  saveSnapshot(name, doc) { writeJson(this._snapshotPath(name), doc); }

  // ---------- 收集 / 写回 ----------
  _agentIds() {
    const dir = path.join(this.root, 'agent');
    try {
      return fs.readdirSync(dir)
        .filter((entry) => entry.endsWith('.json') && !entry.endsWith('.tmp'))
        .map((entry) => entry.slice(0, -'.json'.length))
        .sort();
    } catch { return []; }
  }

  /** 默认对象 + 本地现有的每个 AI 会话（一个会话一个对象）。 */
  allObjectNames() {
    return [...this.objects, ...this._agentIds().map((id) => `agent:${id}`)];
  }

  get settingsPath() { return path.join(this.root, 'settings.yaml'); }

  /** 把本地内容读成可 JSON 序列化的文档;不存在返回 null。 */
  collect(name) {
    const section = SETTINGS_SECTIONS[name];
    if (section) {
      const parsed = readSettingsSection(this.settingsPath, section);
      if (section === 'lessons') return { lessons: asList(parsed) };
      // settings.ai 上云一律是**规范形态**（与网页端/PLL 同一个对象）
      if (section === 'ai') return { ai: aiSyncPayload(parsed) };
      return { [section]: asMap(parsed) };
    }
    if (name === 'schedule') return readJson(path.join(this.root, 'Schedule'), null);
    if (name === 'timetable') return readJson(path.join(this.root, 'Timetable'), null);
    if (name === 'school') return readJson(path.join(this.root, 'School'), null);
    if (name === 'profile') return readJson(path.join(this.root, 'Profile'), null);
    if (name === 'mood') return readJson(path.join(this.root, 'Mood'), null);
    if (name.startsWith('agent:')) {
      const id = name.slice('agent:'.length);
      return readJson(path.join(this.root, 'agent', `${id}.json`), null);
    }
    return null;
  }

  /** 把合并结果写回本地（一律读-改-写 + 原子替换）。 */
  apply(name, doc) {
    if (doc === null || doc === undefined) return;
    const section = SETTINGS_SECTIONS[name];
    if (section) {
      if (section === 'ai') {
        // 规范形态 → 本地扁平形态：只换 providers / default_index / 同步元信息，
        // workspace、localModel、权限确认字段一个都不动。
        const currentAi = asMap(readSettingsSection(this.settingsPath, 'ai'));
        writeSettingsSection(this.settingsPath, 'ai', mergeAiSection(currentAi, asMap(doc).ai));
        return;
      }
      const value = section === 'lessons' ? asList(doc[section]) : asMap(doc[section]);
      writeSettingsSection(this.settingsPath, section, value);
      return;
    }
    if (name === 'schedule') { writeJson(path.join(this.root, 'Schedule'), doc); return; }
    if (name === 'timetable') {
      // 落盘整份合并结果,**不走 `shared-timetable.cjs` 的 `writeDoc`** ——
      // 那个函数会顺手把 updated_at/app 改成"现在/PH Launcher",于是本地文件的哈希
      // 永远对不上刚记的快照,表现为"每轮同步都说 timetable 有变化"。
      // 非 days 的未知字段在合并时已经保留了（out = {...local} + remote 的其它字段）。
      if (isObject(doc)) writeJson(path.join(this.root, 'Timetable'), doc);
      return;
    }
    if (name === 'school') { writeJson(path.join(this.root, 'School'), doc); return; }
    if (name === 'profile') { writeJson(path.join(this.root, 'Profile'), doc); return; }
    if (name === 'mood') { writeJson(path.join(this.root, 'Mood'), doc); return; }
    if (name.startsWith('agent:')) {
      const id = name.slice('agent:'.length);
      writeJson(path.join(this.root, 'agent', `${id}.json`), doc);
    }
  }

  /**
   * 按"云端把这个对象删了"清理本地。返回**是否真的清理掉了**。
   *
   * 只为可以安全删除的对象动手；`schedule` / `timetable` / `school` 是两个程序
   * 共用的**大文件**（用户日程、整周课表、学校快照），误删代价太大 ——
   * 这里一律保留本地，由调用方报告出去。
   * （与 PLL 的 `_apply_removal` 同语义：PLL 早先是"够胆就删"，现在也守这条线。）
   */
  remove(name) {
    if (name.startsWith('agent:')) {
      const id = name.slice('agent:'.length);
      try { fs.rmSync(path.join(this.root, 'agent', `${id}.json`), { force: true }); return true; } catch { return false; }
    }
    const section = SETTINGS_SECTIONS[name];
    if (section) {
      try {
        if (section === 'ai') {
          // 云端删了 AI 配置对象 → 清掉**服务商列表**，但保留本机的本地专有设置
          // （本地模型、工作区、启动器授权确认…）；否则下一轮同步又会把旧的服务商
          // 列表原样推回去，用户会觉得"删了又回来"。
          const current = asMap(readSettingsSection(this.settingsPath, 'ai'));
          writeSettingsSection(this.settingsPath, 'ai', {
            ...current, providers: [], default_index: 0, updated_at: '', updated_by: '',
          });
          return true;
        }
        writeSettingsSection(this.settingsPath, section, section === 'lessons' ? [] : {});
        return true;
      } catch { return false; }
    }
    return false;
  }

  // ---------- 各对象的合并 ----------
  /** 返回 `[mergedDoc, conflicts]`。 */
  merge(name, base, local, remote) {
    const conflicts = [];

    if (name === 'settings.ai') {
      // AI 配置：三方先归一成规范形态，再**按服务商名称**逐条合并。
      // 直接用 mergeDict 不行：规范形态里的 providers 是**列表**，标量合并只会整体
      // 替换，一方新加的服务商会被另一方抹掉。
      // 结果一律以规范形态交出去（apply 再落回本地扁平形态）。
      const section = SETTINGS_SECTIONS[name];
      const toPayload = (value) => (value === null || value === undefined ? null : asMap(value)[section]);
      const canonical = mergeAiPayload(toPayload(base), toPayload(local), toPayload(remote), conflicts);
      return [{ [section]: canonical }, conflicts];
    }

    if (name === 'settings.accounts' || name === 'settings.ui') {
      const section = SETTINGS_SECTIONS[name];
      const merged = mergeDict(
        asMap(base)[section], asMap(local)[section], asMap(remote)[section], section, conflicts);
      return [{ [section]: merged }, conflicts];
    }

    if (name === 'settings.lessons') {
      const key = (row) => [
        String(row.subject || '').trim(), String(row.group || '').trim(), String(row.teacher || '').trim(),
      ].join('|');
      const merged = mergeListOfDicts(
        asMap(base).lessons, asMap(local).lessons, asMap(remote).lessons, key, 'lessons', conflicts);
      return [{ lessons: merged }, conflicts];
    }

    if (name === 'schedule') {
      const b = asMap(base);
      const l = asMap(local);
      const r = asMap(remote);
      const lastIds = [b.lastId, l.lastId, r.lastId].filter((value) => Number.isInteger(value));
      const eventsOf = (doc) => asList(doc.events).filter((event) => isObject(event) && Number.isInteger(event.id));
      const allIds = [...eventsOf(b), ...eventsOf(l), ...eventsOf(r)].map((event) => event.id);
      const nextId = Math.max(0, ...lastIds, ...allIds) + 1;
      // **没有基版快照时传 null**：`mergeEvents` 会退回"只取并集"，
      // 不再把"本地没有"当成"本地删了"（见那边的注释）。
      const baseEvents = base === null || base === undefined ? null : asMap(b).events;
      const merged = mergeEvents(baseEvents, l.events, r.events, nextId, conflicts);
      merged.events.sort((a, c) => {
        const dayA = String(a.day || ''); const dayC = String(c.day || '');
        if (dayA !== dayC) return dayA < dayC ? -1 : 1;
        const timeA = String(a.time || ''); const timeC = String(c.time || '');
        if (timeA !== timeC) return timeA < timeC ? -1 : 1;
        return (a.id || 0) - (c.id || 0);
      });
      const out = { ...l };
      for (const [key, value] of Object.entries(r)) {
        if (key === 'events' || key === 'lastId') continue;
        out[key] = value;
      }
      out.events = merged.events;
      out.lastId = Math.max(0, merged.nextId - 1, ...lastIds, ...allIds);
      if (out.version === undefined) out.version = 1;
      if (out.kind === undefined) out.kind = 'pinghe-schedule';
      return [out, conflicts];
    }

    if (name === 'timetable') {
      const b = asMap(base);
      const l = asMap(local);
      const r = asMap(remote);
      const bd = asMap(b.days);
      const ld = asMap(l.days);
      const rd = asMap(r.days);
      const outDays = {};
      const days = [...new Set([...Object.keys(bd), ...Object.keys(ld), ...Object.keys(rd)])].sort();
      for (const day of days) {
        const bv = Object.hasOwn(bd, day) ? bd[day] : null;
        const lv = Object.hasOwn(ld, day) ? ld[day] : null;
        const rv = Object.hasOwn(rd, day) ? rd[day] : null;
        // 护栏:远端"空的一天"绝不许清掉本地已有的课表
        if (Array.isArray(rv) && !rv.length && Array.isArray(lv) && lv.length) { outDays[day] = lv; continue; }
        if (lv === null && rv === null) continue;
        if (lv === null) { outDays[day] = rv; continue; }
        if (rv === null) { outDays[day] = lv; continue; }
        const key = (row) => [String(row.subject || ''), String(row.start || ''), String(row.group || '')].join('|');
        // 课表是抓取缓存:**只取并集**(unionOnly),不当成用户可删数据
        outDays[day] = mergeListOfDicts(null, lv, rv, key, `days.${day}`, conflicts, true);
        void bv;
      }
      const out = { ...l };
      for (const [key, value] of Object.entries(r)) {
        if (key === 'days') continue;
        out[key] = value;
      }
      out.days = outDays;
      if (out.version === undefined) out.version = 1;
      if (out.kind === undefined) out.kind = 'pinghe-timetable';
      return [out, conflicts];
    }

    if (name === 'school') {
      const l = asMap(local);
      const r = asMap(remote);
      const out = { ...l };
      // managebac / edupage 复用项目里已有的、踩过坑的合并函数
      if (isObject(r.managebac)) out.managebac = sharedSchool.mergeManagebac(l.managebac, r.managebac);
      if (isObject(r.edupage)) out.edupage = sharedSchool.mergeEdupaged(l.edupage, r.edupage);
      // mail 段只是摘要;两边都有就取 fetched_at 较新的那份
      if (isObject(r.mail) && isObject(l.mail)) out.mail = pickNewer(l.mail, r.mail);
      else if (isObject(r.mail)) out.mail = r.mail;
      for (const [key, value] of Object.entries(r)) {
        if (key === 'managebac' || key === 'edupage' || key === 'mail') continue;
        if (out[key] === undefined) out[key] = value;
      }
      if (out.version === undefined) out.version = 1;
      if (out.kind === undefined) out.kind = 'pinghe-school';
      return [out, conflicts];
    }

    if (name === 'profile') {
      // profile: {display_name, avatar, updated_at} —— 取 updated_at 较新的那份
      return [pickNewer(asMap(local), asMap(remote)) || {}, conflicts];
    }

    if (name === 'mood') {
      // mood: {entries: [{id, ts, text, intensity}]} —— 按 id 取并集
      const lEntries = asList(asMap(local).entries);
      const rEntries = asList(asMap(remote).entries);
      const merged = mergeListOfDicts(
        null, lEntries, rEntries, (row) => row?.id ?? null, 'mood.entries', conflicts);
      const out = { ...asMap(local) };
      for (const [key, value] of Object.entries(asMap(remote))) {
        if (key !== 'entries') out[key] = value;
      }
      out.entries = merged;
      return [out, conflicts];
    }

    if (name.startsWith('agent:')) {
      const l = asMap(local);
      const r = asMap(remote);
      const lh = asList(l.history);
      const rh = asList(r.history);
      if (rh.length > lh.length) return [{ ...l, ...r }, conflicts];
      if (rh.length === lh.length && !sameValue(rh, lh)) {
        conflicts.push({
          path: name, local: `${lh.length} 条`, remote: `${rh.length} 条`,
          note: '长度相同但内容不同 → 保留本地',
        });
      }
      return [local, conflicts];
    }

    // 未知对象:整体替换型三方合并
    return [mergeScalar(base, local, remote, name, conflicts), conflicts];
  }

  // ---------- 并发护栏 ----------
  /** 对方程序是不是正在运行:心跳未过期才算,崩溃留下的死标记不算。 */
  siblingRunning() {
    const marker = readRunningMarker(this.root, this.siblingApp);
    if (!marker) return null;
    return {
      kind: this.siblingApp,
      name: this.siblingApp === 'pll' ? 'Pinghe Launcher Lite（PHL Lite）' : 'PH Launcher',
      pid: marker.pid,
    };
  }

  // ---------- 主流程 ----------
  /** 跑一轮同步。返回可读报告（也会写进 state.conflicts）。 */
  async sync(options = {}) {
    const dryRun = Boolean(options.dryRun);
    const force = Boolean(options.force);
    const report = {
      ok: true, server: this.client.server, username: this.username,
      started_at: nowIso(), objects: {}, conflicts: [],
      skipped: null, pulled: [], pushed: [], errors: [],
    };

    // 并发护栏:对方程序在跑就别抢着写（协议规范 §6 的保守方案）
    const sibling = this.siblingRunning();
    if (sibling && !force) {
      report.ok = false;
      report.skipped = `${sibling.name} 正在运行，这轮同步先跳过（避免两边抢写）`;
      return report;
    }

    let manifest;
    try {
      manifest = await this.client.manifest();
    } catch (error) {
      report.ok = false;
      report.errors.push(`取清单失败：${error?.message || error}`);
      return report;
    }

    const remoteMap = new Map();
    for (const entry of asList(manifest.objects)) {
      if (entry && entry.name) remoteMap.set(String(entry.name), entry);
    }
    const state = this.loadState();
    const stateObjects = asMap(state.objects);
    const names = Array.isArray(options.names) && options.names.length ? [...options.names] : this.allObjectNames();

    for (const name of names) {
      if (SyncEngine.isForbidden(name)) {
        report.objects[name] = { action: 'skip', reason: '在禁止上云名单里' };
        continue;
      }
      let entry;
      try {
        entry = await this._syncOne(name, remoteMap.get(name) || null, stateObjects[name] || null, dryRun);
      } catch (error) {
        entry = { action: 'error', error: error?.message || String(error), code: error?.code || '' };
        report.errors.push(`${name}：${error?.message || String(error)}`);
      }
      report.objects[name] = entry;
      if (entry.conflicts && entry.conflicts.length) {
        report.conflicts.push(...entry.conflicts.map((item) => ({ object: name, ...item })));
      }
      if (entry.pulled) report.pulled.push(name);
      if (entry.pushed) report.pushed.push(name);
    }

    if (!dryRun) {
      // 注意:必须**重新读**状态文件再补元信息。`_record()` 每次都已把 objects[name]
      // 写进去了,这里若用循环开始时的旧 stateObjects 覆盖,会把整轮同步的进度全部抹掉,
      // 表现为"永远同步不完 / 永不收敛"。
      const fresh = this.loadState();
      fresh.server = this.client.server;
      fresh.user_id = this.userId;
      fresh.username = this.username;
      fresh.device = this.device;
      fresh.last_sync_at = nowIso();
      if (!isObject(fresh.objects)) fresh.objects = {};
      fresh.conflicts = report.conflicts.slice(-50);
      this.saveState(fresh);
      report.ok = !report.errors.length;
    }
    report.finished_at = nowIso();
    return report;
  }

  // -- 单个对象 --
  async _syncOne(name, remoteEntry, stateEntry, dryRun) {
    const out = { action: 'noop', conflicts: [] };
    const local = this.collect(name);
    const base = this.loadSnapshot(name);
    const localHash = hashDocument(local);

    if (!remoteEntry) {
      // 远端还没有这个对象
      if (local === null || local === undefined) { out.action = 'skip'; return out; }
      out.action = 'push';
      out.pushed = true;
      if (!dryRun) {
        const envelope = phixCrypto.sealObject(this.dek, this.userId, name, documentBytes(local));
        const result = await this.client.putObject(name, 0, envelope, this.device);
        this._record(stateEntry, name, result, local);
      }
      return out;
    }

    const remoteRevision = Number(remoteEntry.revision) || 0;
    const syncedRevision = Number((stateEntry || {}).revision) || 0;
    const localChanged = (stateEntry || {}).sha256 !== localHash;
    const remoteChanged = remoteRevision !== syncedRevision;

    if (remoteEntry.deleted) {
      // 云端把这个对象删了（墓碑）。
      if (local === null || local === undefined) {
        out.action = 'remote-deleted';
        if (!dryRun) this._record(stateEntry, name, { revision: remoteRevision }, null, { remote_deleted: true });
        return out;
      }
      const previous = stateEntry || {};
      if (previous.remote_deleted && !localChanged) {
        // 上一轮已经处理过了（比如"共用大文件保留本地"），别再每轮都报一次。
        out.action = 'noop';
        return out;
      }
      if (localChanged) {
        // 本地改过 → 保留本地并**推回云端**，等于否决这次删除。
        // 只报冲突不推的话，两边会每轮都吵一次，永远收敛不了。
        out.conflicts.push({
          path: name, local: '本地有内容', remote: null,
          note: '云端删了这个对象、但本地改过 → 保留本地并推回云端',
        });
        out.action = 'push';
        out.pushed = true;
        if (!dryRun) {
          const envelope = phixCrypto.sealObject(this.dek, this.userId, name, documentBytes(local));
          let result;
          try {
            result = await this.client.putObject(name, remoteRevision, envelope, this.device);
          } catch (error) {
            if (!error || !error.isConflict) throw error;
            const fresh = await this.client.getObject(name);
            result = await this.client.putObject(name, Number(fresh.revision) || remoteRevision, envelope, this.device);
          }
          this._record(stateEntry, name, result, local);
        }
        return out;
      }

      // 本地没改过 → 按对象类型决定删不删（共用大文件一律保留）。
      const removed = this.remove(name);
      out.action = removed ? 'pull-delete' : 'kept-local';
      out.pulled = removed;
      if (!removed) {
        out.conflicts.push({
          path: name, local: '本地有内容', remote: null,
          note: '云端删了这个对象；它是两个程序共用的大文件（日程 / 课表 / 学校数据），本地保留着，没有自动删',
        });
      }
      if (!dryRun) {
        this._record(stateEntry, name, { revision: remoteRevision }, removed ? null : local, { remote_deleted: true });
      }
      return out;
    }

    const payload = await this.client.getObject(name);
    const remoteEnvelope = payload ? payload.payload : null;
    let remote = null;
    if (remoteEnvelope) {
      try {
        remote = JSON.parse(phixCrypto.unsealObject(this.dek, this.userId, name, remoteEnvelope).toString('utf8'));
      } catch (error) {
        throw new PhixError('decrypt_failed', `解不开远端密文（口令不对？）：${error?.message || error}`);
      }
    }

    if (!remoteChanged && !localChanged) { out.action = 'noop'; return out; }

    // 其余情况**一律走三方合并**。合并才是安全操作:曾经给"只有远端变了"做过直接 apply
    // 的快捷路径,结果绕过了课表"空的一周不许清空"这类护栏,实测把本地 71 张课卡清成了 0。
    let [merged, conflicts] = this.merge(name, base, local, remote);
    out.conflicts = conflicts;
    let mergedHash = hashDocument(merged);
    const remoteHash = hashDocument(remote);

    const needWriteLocal = mergedHash !== localHash;
    let needPush = mergedHash !== remoteHash;
    if (!needWriteLocal && !needPush) {
      out.action = 'noop';
      // **首次同步且本地恰好与云端一致时，也必须把基线记下来。**
      // 不记的话这个对象的 state 就永远是空的，于是 localChanged 永远为真
      // （拿 undefined 跟哈希比）→ "云端把这个对象删了"会被误判成"本地改过"，
      // 拒绝跟随删除，而且每轮都要白拉一次密文再解密。
      // 实测：新设备首拉时两边数据本就相同、7 个对象全是 noop、一个都没记，
      // 随后云端删除根本传播不过来。
      if (!dryRun && local !== null && local !== undefined) {
        const previous = stateEntry || {};
        if (Number(previous.revision) !== remoteRevision || previous.sha256 !== mergedHash) {
          this._record(stateEntry, name, payload, merged);
        }
      }
      return out;
    }
    out.action = needWriteLocal && needPush ? 'merge' : (needWriteLocal ? 'pull' : 'push');
    out.pulled = needWriteLocal;
    out.pushed = needPush;
    if (dryRun) return out;

    if (needWriteLocal) {
      this.apply(name, merged);
      // 落盘后**重新读一遍**再定快照:写入路径可能顺手改写 updated_at/app 之类的字段,
      // 不重读就会"快照哈希永远对不上 → 每轮都以为有变化"。
      const after = this.collect(name);
      if (after !== null && after !== undefined) {
        merged = after;
        mergedHash = hashDocument(merged);
      }
    }

    needPush = mergedHash !== remoteHash;
    out.pushed = needPush;
    if (!needPush) {
      out.action = 'pull';
      this._record(stateEntry, name, payload, merged);
      return out;
    }

    let envelope = phixCrypto.sealObject(this.dek, this.userId, name, documentBytes(merged));
    let appliedHash = mergedHash;
    let result;
    try {
      result = await this.client.putObject(name, remoteRevision, envelope, this.device);
    } catch (error) {
      if (!error || !error.isConflict) throw error;
      // 有人在我们同步期间又写了 → 拉最新再合并一次（最多重试 3 次）
      result = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const fresh = await this.client.getObject(name);
        let freshDoc;
        try {
          freshDoc = JSON.parse(phixCrypto.unsealObject(this.dek, this.userId, name, fresh.payload).toString('utf8'));
        } catch { break; }
        let more = [];
        [merged, more] = this.merge(name, base, merged, freshDoc);
        conflicts.push(...more);
        out.conflicts = conflicts;
        if (hashDocument(merged) !== appliedHash) {
          this.apply(name, merged);
          appliedHash = hashDocument(merged);
        }
        envelope = phixCrypto.sealObject(this.dek, this.userId, name, documentBytes(merged));
        try {
          result = await this.client.putObject(name, Number(fresh.revision) || 0, envelope, this.device);
          break;
        } catch (retryError) {
          if (!retryError || !retryError.isConflict) throw retryError;
        }
      }
      if (result === null) {
        throw new PhixError('revision_conflict', '远端一直在被别人改，这轮先跳过（下轮再合）');
      }
    }
    this._record(stateEntry, name, result, merged);
    return out;
  }

  /** 写回 `state.objects` 与本地明文快照。`extra` 用来记 `remote_deleted` 之类的标记。 */
  _record(stateEntry, name, result, doc, extra = null) {
    const state = this.loadState();
    if (!isObject(state.objects)) state.objects = {};
    const entry = {
      revision: Number((result && result.revision) || 0),
      sha256: hashDocument(doc),
      synced_at: nowIso(),
    };
    if (isObject(extra)) Object.assign(entry, extra);
    state.objects[name] = entry;
    state.server = this.client.server;
    state.user_id = this.userId;
    state.username = this.username;
    state.device = this.device;
    this.saveState(state);
    if (doc === null || doc === undefined) {
      try { fs.rmSync(this._snapshotPath(name), { force: true }); } catch { /* 快照文件而已 */ }
    } else {
      this.saveSnapshot(name, doc);
    }
    void stateEntry;
  }

  /**
   * 禁止上云判定。既认对象名（`settings.lessons`、`agent:<id>`）,
   * 也认**路径形态**（`phll/managebac/session_x.json`）—— 只要第一段命中
   * 黑名单目录名就拒绝,避免以后有人把文件路径直接当对象名传进来。
   */
  static isForbidden(name) {
    if (typeof name !== 'string' || !name.trim()) return true;
    const cleaned = name.trim().replace(/^\/+/, '').replace(/\/+$/, '');
    if (NEVER_SYNC.includes(cleaned)) return true;
    const head = cleaned.split('/', 1)[0];
    if (NEVER_SYNC.includes(head)) return true;
    const namespace = cleaned.split(':', 1)[0];
    return NEVER_SYNC.includes(namespace);
  }
}

/** 读运行标记:只有 PID 还活着、心跳没过期才算"对方在跑"。 */
function readRunningMarker(dataDir, kind) {
  const file = path.join(dataDir, kind === 'pll' ? '.pll-running' : '.phl-running');
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const pid = Number(parsed && parsed.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch (error) { alive = error?.code === 'EPERM'; }
  if (!alive) return null;
  const stamp = String((parsed && (parsed.updatedAt || parsed.startedAt)) || '');
  if (stamp) {
    const at = Date.parse(stamp);
    if (Number.isFinite(at) && Date.now() - at >= 90_000) return null;   // 心跳过期 = 崩溃留下的标记
  }
  return { pid, kind };
}

module.exports = {
  // 常量
  ACCOUNTS_SUBDIR,
  ACCOUNT_FALLBACK,
  ACCOUNT_MAX_LENGTH,
  API_PREFIX,
  DEFAULT_OBJECTS,
  DEFAULT_TIMEOUT,
  MAX_PAYLOAD,
  NEVER_SYNC,
  SNAPSHOT_SUBDIR,
  STATE_KIND,
  STATE_NAME,
  SYNC_DIR,
  // 错误
  PhixError,
  // 客户端
  PhixClient,
  // 引擎
  SyncEngine,
  // AI 配置归一化（规范形态：与网页端 / PLL 共用的 settings.ai 对象）
  aiSyncPayload,
  mergeAiSection,
  mergeAiPayload,
  overlayAiProviders,
  // 工具
  deviceName,
  documentBytes,
  hashDocument,
  jsonSafe,
  jsonText,
  mergeDict,
  mergeEvents,
  mergeListOfDicts,
  mergeScalar,
  nowIso,
  parseYamlSection,
  pickNewer,
  readJson,
  readSettingsSection,
  replaceSettingsSection,
  safeAccountName,
  sameValue,
  serializeYamlSection,
  timestampOf,
  writeJson,
  writeSettingsSection,
};

'use strict';
// phix 会话：把"登录 → 拿令牌 → 解出 DEK → 云同步"串起来的一层。
// （`hellopinghe/phixsession.py` 的 Node 移植，配置与 PLL 共用同一份 `settings.yaml`。）
//
// **DEK 只在内存里，绝不落盘**：进程退出就没了，下次运行重新用口令解一次。
// 这样即便有人拷走整个 `data/`，没有口令也打不开云端的任何东西。
//
// 配置写在 `settings.yaml` 的 `phix:` 段（非机密：服务器地址、用户名、开关）。
//
// ---------------------------------------------------------------------------
// **令牌落盘契约（三键制，PHL 与 PLL 逐字一致；改这里就得改 PLL 的 phixsession.py）**
//
//   `phix:token`          老式长期令牌（兼容期用；服务端 `PHIX_LEGACY_TOKENS`
//                         关掉后作废）。**不再当业务 Bearer 的首选**。
//                         只在登录/注册响应里**有** `token` 时写。
//   `phix:access_token`   15 分钟的 Ed25519 JWT，**业务请求的 Bearer 首选**。
//                         登录 / 注册 / 每次续期都写。
//   `phix:refresh_token`  续期凭据（30 天、**用一次换一次**），**只**喂给
//                         `/auth/refresh`。登录 / 注册 / 每次轮换都写。
//
// 三条铁律：
//   1. **读兼容**：新键缺失时回落到旧键 —— `phix:token` 里那串**像 JWT 的**
//      （三段式、`.` 分隔；老实现把访问令牌存在这儿）当访问令牌，
//      `phix:refresh`（PLL 旧实现的续期键）当续期凭据。**不像 JWT 的
//      `phix:token` 就是老式长期令牌，绝不当访问令牌用**。
//   2. **写新键 + 迁移只补写**：读到旧键就顺手把新键补上（幂等），
//      旧键原样留着 —— 用户机器上已经写进去的东西一个都不丢。
//   3. **绝不删别人的键**：除了登出，一个键都不删。登出把这四个 phix 令牌键
//      （三键 + 旧 `phix:refresh`）一起清掉 —— 留着旧 refresh 会被回落逻辑
//      当成"还登着"；`settings.yaml` 里别的东西一律不动。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');

const cloudsync = require('./cloudsync.cjs');
const phixCrypto = require('./phix-crypto.cjs');
const sharedSettings = require('./settings-yaml.cjs');

/** 变更探测的轮询间隔（用户 2026-09-19：一秒一次）。 */
const AUTO_POLL_MS = 1000;

/** 老式长期令牌（兼容期）。**不是**业务请求该优先用的那串。 */
const TOKEN_KEY = 'phix:token';
/** 15 分钟的 JWT：业务请求的 Bearer 首选。 */
const ACCESS_TOKEN_KEY = 'phix:access_token';
/** 30 天、用一次换一次：**只**喂给 `/auth/refresh`。 */
const REFRESH_TOKEN_KEY = 'phix:refresh_token';
/**
 * PLL 旧实现写的续期键：**只读兼容**，本程序不再往它上面写。
 * 读到就迁移到 `phix:refresh_token`（不删它）。
 */
const LEGACY_REFRESH_KEY = 'phix:refresh';
const DEFAULT_INTERVAL_MINUTES = 10;

/**
 * 三段式（两个点）且每段非空 → 像 Ed25519 JWT。
 *
 * 只用来判断 `phix:token` 里那串是"老实现存进去的访问令牌"还是"老式长期令牌"：
 * **长期令牌不会续期、语义也不对，绝不能当访问令牌用**。
 * 与 PLL 的 `phixsession.looks_like_jwt` 同口径。
 */
function looksLikeJwt(value) {
  const parts = String(value || '').split('.');
  return parts.length === 3 && parts.every((part) => part.length > 0);
}


/** `phix:` 段的默认值。 */
function defaultConfig() {
  return {
    server: '',
    username: '',
    user_id: 0,
    device: cloudsync.deviceName(),
    key_mode: 'password',
    auto_sync: true,
    // 应用层加密传输（`加密链路思路.md` §3）：网线上也只有密文。
    // 服务端不支持时客户端会自动退回明文，所以默认开着是安全的。
    e2e: true,
    sync_interval_minutes: DEFAULT_INTERVAL_MINUTES,
    objects: [...cloudsync.DEFAULT_OBJECTS],
    last_sync_at: '',
  };
}

/**
 * 数据根从哪来：主进程启动时调一次 `configure({ dataDir })` 定下来。
 * 没配过就退回 `PHIX_DATA_DIR` 环境变量（测试与无头运行用），再没有就报错 ——
 * 绝不猜一个目录出来写用户数据。
 */
let configuredRoot = '';

function configure(options = {}) {
  if (options.dataDir) configuredRoot = path.resolve(options.dataDir);
  return configuredRoot;
}

function dataRoot() {
  const root = configuredRoot || String(process.env.PHIX_DATA_DIR || '').trim();
  if (!root) throw new Error('phix 会话还没拿到数据目录（请先 configure({ dataDir })）');
  return path.resolve(root);
}

// ---------------------------------------------------------------- 配置读写
function settingsFile() { return path.join(dataRoot(), 'settings.yaml'); }

/** 读 `phix:` 段；缺失/坏行一律用默认值补齐（未知键原样留着，写回时不丢）。 */
function loadConfig() {
  const raw = readSection('phix');
  const config = defaultConfig();
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (key in config && value !== null && value !== undefined) config[key] = value;
    }
    if (Array.isArray(raw.objects) && raw.objects.length) config.objects = raw.objects.map(String);
  }
  if (!Array.isArray(config.objects) || !config.objects.length) config.objects = [...cloudsync.DEFAULT_OBJECTS];
  config.user_id = Number(config.user_id) || 0;
  config.sync_interval_minutes = Math.max(2, Number(config.sync_interval_minutes) || DEFAULT_INTERVAL_MINUTES);
  config.auto_sync = config.auto_sync !== false;
  config.e2e = config.e2e !== false;
  return config;
}

function readSection(name) {
  const text = sharedSettings.readTextFile(settingsFile());
  if (!text) return null;
  try { return cloudsync.parseYamlSection(text, name); } catch { return null; }
}

/**
 * 应用层加密传输是否开启（默认开）。服务端不支持时客户端会自动退回明文。
 * **与 PLL 共用同一个 `phix.e2e` 配置项**。
 */
function e2eEnabled() {
  try { return loadConfig().e2e !== false; } catch { return true; }
}

/**
 * 固定服务器公钥的存放目录：`data/.sync/pinned/`。
 * **与 PLL 同一个位置、同一个文件名规则** —— 两个程序共用一份固定公钥，
 * 谁也不会因为对方先连过就报警。
 */
function pinDir() { return path.join(dataRoot(), cloudsync.SYNC_DIR, 'pinned'); }

/** 造一个已按当前配置打开的客户端（加密 + 公钥固定）。
 *
 * **默认不带任何令牌**（"测试连接"这类动作不需要凭据）；`withTokens: true` 时
 * 把本机存的三串令牌装进去（带读兼容：见 `storedTokens`）—— 登录、注册与日常请求
 * 走的是这一条路，于是"上次登录留下的 JWT 过期了"这件事会自动触发一次续期。
 */
function makeClient(server, token = null, timeout, options = {}) {
  const settings = { e2e: e2eEnabled(), pinDir: pinDir() };
  let legacy = token;
  if (options.withTokens === true) {
    let stored = { access: '', refresh: '', legacy: '' };
    try { stored = storedTokens(); } catch { /* 读不到就当没有 */ }
    // 老令牌走构造参数（`token`），它就是 `client.token`：`phix:token` 里那一串
    if (stored.legacy) legacy = stored.legacy;
    settings.accessToken = stored.access;
    settings.refreshToken = stored.refresh;
    settings.persist = (tokens) => { saveTokens(tokens); };
  }
  return new cloudsync.PhixClient(server, legacy, timeout, settings);
}

/**
 * 只更新一个顶层段，别的段（含用户手写的注释与两个程序的未知字段）原样保留。
 * 文件还不存在时按"空文件"处理，`replaceBlock` 会把这一段追加进去。
 */
function writeSection(name, value) {
  const text = sharedSettings.readTextFile(settingsFile());
  sharedSettings.atomicWriteFileSync(settingsFile(), sharedSettings.replaceBlock(text, name, cloudsync.serializeYamlSection(name, value)));
}

/** 只更新 `phix:` 段里的若干个键；`undefined`/`null` 表示"不动这个键"。 */
function saveConfig(changes = {}) {
  const section = readSection('phix');
  const next = section && typeof section === 'object' && !Array.isArray(section) ? { ...section } : {};
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined || value === null) continue;
    next[key] = value;
  }
  try { writeSection('phix', next); } catch { /* 读不到数据目录时不要拦着登录 */ }
  return loadConfig();
}

// ---------------------------------------------------------------- 令牌
//
// 三键制（见文件头契约）：`phix:token`（老式）/ `phix:access_token`（JWT）/
// `phix:refresh_token`（续期），外加只读兼容的旧键 `phix:refresh`。
// 三串都躺在 `secrets_extra` —— 与 PLL 共用的那个段（明文导出**不**含这一段的
// 语义与以前一致：这里本来就是机密段，四平台凭据也在里面）。
// **DEK / KEK 一个字节都不落盘。**

function readSecrets() {
  try {
    const extra = readSection('secrets_extra');
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) return { ...extra };
  } catch { /* 读不到就是没有 */ }
  return {};
}

function writeSecrets(next) {
  writeSection('secrets_extra', next);
  return true;
}

function secretOf(secrets, key) {
  return typeof secrets[key] === 'string' ? secrets[key] : '';
}

function storedToken() {
  return secretOf(readSecrets(), TOKEN_KEY);
}

/**
 * 写老式长期令牌。传空串**什么都不做**（绝不删键 —— 删除只在登出时发生，
 * 见 `clearTokens`）：这一串是"别人的键"还是"自己的键"由调用方决定，
 * 落盘层不做任何删除动作。
 */
function saveToken(token) {
  if (!token) return false;
  const next = readSecrets();
  next[TOKEN_KEY] = String(token);
  return writeSecrets(next);
}

/**
 * 取本机三串令牌（缺了就是空串，不抛）—— **读兼容**都在这里。
 *
 * - `access`：优先 `phix:access_token`；缺了就看 `phix:token` 里那串**像不像 JWT**
 *   （老 PLL 把访问令牌存在那儿）。不像 JWT = 它是老式长期令牌，**不当访问令牌用**。
 * - `refresh`：优先 `phix:refresh_token`；缺了认旧键 `phix:refresh`（老 PLL 写的）。
 * - `legacy`：`phix:token` 原样报出来（老式长期令牌）。
 *
 * 用上回落时**顺手补写新键**（只补写、不删旧键、幂等）：这样 PLL 旧格式留下的
 * 令牌 PHL 也能用上，反之亦然 —— 这正是"两个程序共用一份 settings.yaml"的关键。
 */
function storedTokens() {
  const secrets = readSecrets();
  const legacy = secretOf(secrets, TOKEN_KEY);
  let access = secretOf(secrets, ACCESS_TOKEN_KEY);
  let refresh = secretOf(secrets, REFRESH_TOKEN_KEY);
  let migrated = false;
  if (!access && looksLikeJwt(legacy)) {
    access = legacy;                       // 老 PLL 把 JWT 存在 phix:token 里
    migrated = true;
  }
  if (!refresh) {
    const oldRefresh = secretOf(secrets, LEGACY_REFRESH_KEY);
    if (oldRefresh) {
      refresh = oldRefresh;                // 老 PLL 的续期键
      migrated = true;
    }
  }
  if (migrated) {
    try { saveTokens({ access_token: access || undefined, refresh_token: refresh || undefined }); }
    catch { /* 迁不成不算错：旧键照样能读到 */ }
  }
  return { access, refresh, legacy };
}

/**
 * 存两串 P3 令牌。
 *
 * **键名与线上协议一致**（`access_token` / `refresh_token`）—— 落盘回调直接拿
 * 客户端给的那个对象喂进来，少一层改名就少一次"改错了还不知道"的机会。
 * 传空串或 `undefined` 一律**不动那个键**（绝不删：删除只发生在 `clearTokens`，
 * 也就是登出那一次）。
 */
function saveTokens({ access_token: access, refresh_token: refresh } = {}) {
  const next = readSecrets();
  for (const [key, value] of [[ACCESS_TOKEN_KEY, access], [REFRESH_TOKEN_KEY, refresh]]) {
    if (value === undefined || value === null || value === '') continue;
    next[key] = String(value);
  }
  return writeSecrets(next);
}

/**
 * 登出时用：这四个 phix 令牌键全清（三键 + 旧键 `phix:refresh`）。
 *
 * 为什么要连旧键一起清：留着它，下一次读就会把这条已经被服务端作废的续期凭据
 * **回落**成 `phix:refresh_token`，界面上看起来还"登着"。
 * **只清 phix 自己这几个令牌键**，`secrets_extra` 里别的东西（四平台凭据等）不动。
 */
function clearTokens() {
  const next = readSecrets();
  delete next[TOKEN_KEY];
  delete next[ACCESS_TOKEN_KEY];
  delete next[REFRESH_TOKEN_KEY];
  delete next[LEGACY_REFRESH_KEY];
  return writeSecrets(next);
}

// ---------------------------------------------------------------- 会话
function normalizeServer(server) {
  let value = String(server || '').trim().replace(/\/+$/, '');
  if (!value) throw new cloudsync.PhixError('bad_server', '请填写 phix 服务器地址');
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  if (value.includes('/api/v1')) value = value.split('/api/v1')[0];
  return value;
}

/** 一个进程一份；DEK 与恢复码只在这里的内存里。 */
class PhixSession {
  constructor(options = {}) {
    this.client = null;
    this.dek = null;
    this.userId = 0;
    this.username = '';
    this.server = '';
    this.keyMode = 'password';
    this.keyCheck = '';
    this.recoveryCode = '';       // 注册后**只在内存里**放一会儿给界面显示
    this.lastReport = null;
    this.timer = null;
    this.stopped = true;
    this.log = typeof options.log === 'function' ? options.log : () => {};
    /**
     * 同步**真正落盘之后**的回调（`dryRun` 不触发）。
     *
     * 由主进程注进来，用来把云端那份 AI 服务商与 Key 收进内存的加密存储 ——
     * 用户的运行路径读的是内存，不通知它就看不到"在网页端填的 Key"。
     */
    this.onSyncApplied = typeof options.onSyncApplied === 'function' ? options.onSyncApplied : null;
  }

  // ---------------- 状态 ----------------
  status() {
    const config = this.#config();
    // 有访问令牌（P3 的 JWT）或老式令牌，都算"登录着"；两者都没有才是没登录。
    const loggedIn = this.#isLoggedIn();
    const unlocked = this.dek !== null;
    const stored = this.#storedTokens();
    return {
      root: dataRoot(),
      configured: Boolean(config.server && config.username),
      server: this.server || config.server || '',
      username: this.username || config.username || '',
      user_id: this.userId || config.user_id || 0,
      logged_in: loggedIn,
      unlocked,
      key_mode: this.keyMode || config.key_mode || 'password',
      auto_sync: config.auto_sync !== false,
      // 自动同步是"一秒一轮的变更探测"（用户 2026-09-19），这两个数给界面/排障看：
      // 轮询有没有在跑、最近一轮是什么时候、最近一轮完整同步是什么时候。
      auto_poll_ms: AUTO_POLL_MS,
      polling: !this.stopped && Boolean(this.timer),
      last_poll_at: this.lastPollAt ? new Date(this.lastPollAt).toISOString() : '',
      last_full_sync_at: this.lastFullSyncAt ? new Date(this.lastFullSyncAt).toISOString() : '',
      sync_interval_minutes: config.sync_interval_minutes,
      last_sync_at: config.last_sync_at || '',
      recovery_code: this.recoveryCode,
      device: config.device || cloudsync.deviceName(),
      objects: config.objects,
      has_token: Boolean(stored.legacy),
      // 界面/排查用：本机到底存着哪几串（**只报有或没有，绝不回传令牌本身**）
      has_access_token: Boolean(stored.access),
      has_refresh_token: Boolean(stored.refresh),
      last_report: brief(this.lastReport),
      state: this.#stateSummary(),
    };
  }

  #config() { try { return loadConfig(); } catch { return defaultConfig(); } }

  #storedToken() { try { return storedToken(); } catch { return ''; } }

  #storedTokens() {
    try { return storedTokens(); } catch { return { access: '', refresh: '', legacy: '' }; }
  }

  /**
   * 是否处于登录态。
   *
   * 优先问客户端的 `authToken()`（P3：优先 access，兜底老令牌），**它不在时退回
   * `client.token`** —— 测试与外部注入的假客户端不一定实现了新方法，不该因此炸掉。
   */
  #isLoggedIn() {
    if (!this.client) return false;
    if (typeof this.client.authToken === 'function') return Boolean(this.client.authToken());
    return Boolean(this.client.token);
  }

  /**
   * 给界面看的同步状态摘要。
   *
   * 状态文件**按账号隔离**（`data/.sync/accounts/<账号>/state.json`）；账号刚从
   * `this.username` 或配置里取，取得跟 `SyncEngine` 完全一样的目录名。
   * 新位置还没有就**就地走一次老布局迁移**（与同步引擎同一段逻辑），
   * 这样界面看到的就是下一轮同步真正会用的那份，不会两边显示不一致。
   */
  #stateSummary() {
    try {
      const config = this.#config();
      const username = this.username || config.username || '';
      const engine = new cloudsync.SyncEngine(
        { server: this.server || config.server || '', token: '', manifest: async () => ({ objects: [] }) },
        Buffer.alloc(0), this.userId || config.user_id || 0, username,
        { dataDir: dataRoot(), device: config.device || cloudsync.deviceName() },
      );
      const state = engine.loadState();
      const reading = Object.keys(state).length
        ? state
        : cloudsync.readJson(path.join(dataRoot(), cloudsync.SYNC_DIR, cloudsync.STATE_NAME), null);
      if (!reading || !Object.keys(reading).length) return { last_sync_at: '', objects: {}, conflicts: [] };
      const objects = {};
      for (const [name, entry] of Object.entries(reading.objects || {})) objects[name] = entry && entry.revision;
      return {
        last_sync_at: reading.last_sync_at || '',
        objects,
        conflicts: (reading.conflicts || []).slice(-10),
      };
    } catch { return {}; }
  }

  // ---------------- 登录 / 注册 ----------------
  /**
   * 口令解 DEK。解不开 = 口令不对（GCM 认证标签失败），自检块过不了 = 数据坏了。
   *
   * **两种都归一成带 code 的 PhixError**：`unwrapDek` 自己抛的是原始密码学异常
   * （Node 是 `Error`，Python 是 `cryptography.InvalidTag`，都没有 `code`），
   * 直接冒到界面就是一句"Unsupported state or unable to authenticate data"，
   * 用户看不懂。PLL 那边现在也是裸异常（已在汇报里说明，那边没改）。
   */
  #unwrapOrFail(keyWrap, passphrase, salt, username, mode) {
    let dek;
    try {
      dek = phixCrypto.unwrapDek(keyWrap, passphrase, salt, username);
    } catch {
      throw new cloudsync.PhixError('bad_passphrase',
        mode === 'syncphrase' ? '同步口令不对' : '密码不对（或这个账号的密钥材料已损坏）');
    }
    if (this.keyCheck && !phixCrypto.checkDek(dek, username, this.keyCheck)) {
      // 只有在服务端给了自检块时才有意义：解得开包裹但自检不过 = 材料坏了。
      throw new cloudsync.PhixError('bad_passphrase',
        mode === 'syncphrase' ? '同步口令不对' : '密码不对（或这个账号的密钥材料已损坏）');
    }
    return dek;
  }

  /** 用 phix 账号登录。成功即拿到 DEK（在内存里），可以开始同步。 */
  async login(server, username, password, syncPassphrase = '', device = '') {
    const target = normalizeServer(server);
    const deviceName = device || cloudsync.deviceName();
    // 带着本机存着的令牌建客户端：登录响应会把三串换成新的（见 #persistTokens）
    const client = makeClient(target, null, undefined, { withTokens: true });
    const info = await client.login(username, password, deviceName);
    this.keyCheck = info.key_check || '';

    let dek = null;
    const mode = info.key_mode || 'password';
    if (mode === 'password') {
      dek = this.#unwrapOrFail(info.key_wrap, password, info.kdf_salt, info.username, 'password');
    } else if (syncPassphrase) {
      dek = this.#unwrapOrFail(info.key_wrap, syncPassphrase, info.kdf_salt, info.username, 'syncphrase');
    }

    this.client = client;
    this.dek = dek;
    this.userId = info.user_id;
    this.username = info.username;
    this.server = target;
    this.keyMode = mode;
    this.recoveryCode = '';

    this.#persistTokens(info, '登录');
    saveConfig({ server: target, username: info.username, user_id: info.user_id, device: deviceName, key_mode: mode });
    if (dek !== null) this.startAutoSync();
    return this.status();
  }

  /** 强模式（syncphrase）：用独立同步口令在本地解出 DEK；口令不外发。 */
  async unlock(syncPassphrase) {
    if (!this.client) throw new cloudsync.PhixError('not_logged_in', '请先登录');
    const info = await this.client.me();
    this.keyCheck = info.key_check || '';
    this.dek = this.#unwrapOrFail(info.key_wrap, syncPassphrase, info.kdf_salt, info.username, 'syncphrase');
    this.startAutoSync();
    return this.status();
  }

  /**
   * 恢复上次留下的会话（**不重新登录**）：把盘上的三串令牌装进一个新客户端。
   *
   * 为什么要有它：P3 之后令牌是"短期 + 可续期"的，程序重启时完全没必要再走一次
   * 登录（那会多出一条会话、还要用户重新输一次口令）。装上之后第一次业务请求
   * 若发现 access 过期，`PhixClient` 会自己续期并重试，**用户什么都不用做**。
   *
   * 恢复之后仍然是**锁着**的（DEK 只在内存里，重启就没了）—— `unlock()` 或
   * 重新 `login()` 才会解出来。没有任何令牌时返回 null。
   */
  async restore(server = '', username = '') {
    const config = this.#config();
    const target = server || config.server;
    const stored = { ...this.#storedTokens(), legacy: this.#storedToken() };
    if (!target || (!stored.access && !stored.legacy)) return null;
    const client = makeClient(target, stored.legacy || null, undefined, { withTokens: true });
    if (!client.authToken()) return null;
    this.client = client;
    this.server = target;
    this.username = username || config.username || '';
    this.userId = config.user_id || 0;
    this.keyMode = config.key_mode || 'password';
    this.dek = null;                      // 锁着：DEK 绝不落盘，重启就得重新解
    this.keyCheck = '';
    this.recoveryCode = '';
    return this.status();
  }

  /** 注册新账号。返回里带**恢复码**，界面必须提示用户抄下来。 */
  async register(server, username, password, keyMode = 'password') {
    const target = normalizeServer(server);
    const device = cloudsync.deviceName();
    const client = makeClient(target, null, undefined, { withTokens: true });
    const [info, material] = await client.register(username, password, device, null, true);

    this.client = client;
    this.dek = material.dek;
    this.userId = info.user_id;
    this.username = info.username;
    this.server = target;
    this.keyMode = keyMode;
    this.keyCheck = material.key_check;
    this.recoveryCode = material.recovery_code;

    this.#persistTokens(info, '注册');
    saveConfig({ server: target, username: info.username, user_id: info.user_id, device, key_mode: keyMode });
    this.startAutoSync();
    return { ...this.status(), recovery_code: material.recovery_code };
  }

  /**
   * 退出登录。
   *
   * `POST /auth/logout` 注销的是**当前会话**，服务端会把它连同挂在名下的老式
   * 长期令牌一起作废；随后本地**四个 phix 令牌键一起清掉**（三键 + 旧
   * `phix:refresh`，见 `clearTokens`）。
   * 网络失败也照清不误 —— 本地留着一串已经不认的令牌只会让下次请求 401。
   */
  async logout(forgetToken = true) {
    this.stopAutoSync();
    const client = this.client;
    this.client = null;
    this.dek = null;
    this.keyCheck = '';
    this.recoveryCode = '';
    // 登录时缓存的 MK 也一起抹掉 —— 它等价于"口令派生出来的钥匙"，
    // 登出后留着没有任何好处（见 phix-crypto.cjs 里 MK 缓存那段）。
    try { phixCrypto.clearMkCache(); } catch { /* 老版本没有这个函数，忽略 */ }
    if (client) {
      try { await client.logout(); } catch (error) { this.log(`phix 登出请求失败（本地仍会清掉令牌）：${error?.message || error}`); }
    }
    if (forgetToken) {
      try { clearTokens(); } catch (error) { this.log(`phix 令牌清除失败：${error.message}`); }
    }
    return this.status();
  }

  // ---------------- 换密码 / 切同步口令 ----------------
  /**
   * 取当前账号的凭证材料（`kdf_algo` / `auth_salt`），顺带把 `key_check` 带回来。
   *
   * **`auth_salt` 是登录凭证的盐，注册时定下、永不改变**（`kdf_salt` 会随换包裹
   * 口令而变，用它算 AuthHash 会导致"换了同步口令之后登录失败"）。
   */
  async #credentialMeta(info = null) {
    const me = info || await this.client.me();
    let algo = me.kdf_algo;
    let authSalt = me.auth_salt;
    if (!algo || !authSalt) {
      // `me` 在某些版本里不带这两个字段 → 问一次公开的 keymaterial 接口补齐
      try {
        const meta = await this.client.keymaterial(this.username);
        algo = algo || meta.kdf_algo;
        authSalt = authSalt || meta.auth_salt || meta.kdf_salt;
      } catch { /* 拿不到就退回 v1 老路径 */ }
    }
    return { info: me, algo: algo || phixCrypto.KDF_ALGO_V1, authSalt: authSalt || null };
  }

  /**
   * 换登录密码。
   *
   * - `password` 模式：DEK 由登录密码包裹 → 用新密码重新包裹一次。
   * - `syncphrase` 模式：DEK 由**独立同步口令**包裹，与登录密码无关 →
   *   **一个字节都不动**，只改服务端那边的登录密码。
   *   （PLL 曾经不分模式一律重包裹，结果把"用同步口令包裹"换成"用新密码包裹"，
   *    下次拿同步口令就解不开了 —— 这里照现在的正确行为移植。）
   *
   * v2 账号换密码时：`auth_salt` **沿用旧的**（凭证盐不能变），`auth_hash` 用
   * **新登录密码**重算 —— 否则下次登录用的还是旧凭证。
   */
  async changePassword(oldPassword, newPassword) {
    this.#requireUnlocked();
    const client = this.client;
    const { info, algo, authSalt } = await this.#credentialMeta();
    const proof = phixCrypto.proveDek(this.dek, this.username, info.key_check);
    // 两种模式都必须把 **new_auth_hash** 算出来发给服务器（v2 账号的登录凭证就是它，
    // 服务器 `set_password(new)` 存的是这一串）。少了它，服务器会把**口令原文**
    // 当成凭证存起来 → 之后无论用哪个口令都登不进来（实测踩过）。
    const material = this.keyMode === 'syncphrase'
      // syncphrase：DEK 由独立同步口令包裹，**绝不能**在这里重包裹 key_wrap，
      // 只换登录凭证；`auth_salt` 沿用旧的。
      ? phixCrypto.rewrap(this.dek, this.username, newPassword, 'syncphrase', null, proof,
        algo, authSalt, newPassword)
      : phixCrypto.rewrap(this.dek, this.username, newPassword, 'password', null, proof,
        algo, authSalt, newPassword);
    if (this.keyMode === 'syncphrase') {
      // 只发"换凭证"需要的那几样，key_wrap / recovery_wrap 一律不发
      await client.changePassword(oldPassword, newPassword, proof, {
        kdf_algo: material.kdf_algo, auth_salt: material.auth_salt,
        auth_hash: material.auth_hash, key_mode: 'syncphrase',
      }, { oldAuthSalt: authSalt, oldAlgo: algo });
    } else {
      await client.changePassword(oldPassword, newPassword, proof, material,
        { oldAuthSalt: authSalt, oldAlgo: algo });
    }
    saveConfig({ key_mode: this.keyMode });
    return this.status();
  }

  /** 从强模式切回简单模式：DEK 改回由登录密码包裹。 */
  async useLoginPassword(loginPassword, newLoginPassword = '') {
    this.#requireUnlocked();
    const client = this.client;
    const { info, algo, authSalt } = await this.#credentialMeta();
    const proof = phixCrypto.proveDek(this.dek, this.username, info.key_check);
    const phrase = newLoginPassword || loginPassword;
    const material = phixCrypto.rewrap(this.dek, this.username, phrase, 'password', null, proof,
      algo, authSalt, phrase);
    await client.rewrap(loginPassword, proof, materialsFor(material, 'password'),
      { authSalt, algo });
    this.keyMode = 'password';
    saveConfig({ key_mode: 'password' });
    return this.status();
  }

  /**
   * 切到强模式：DEK 改由**独立同步口令**包裹，服务端从此完全解不开。
   *
   * v2 账号这里不能动 AuthHash：登录口令没变、`auth_salt` 也没变，
   * 只换 `kdf_salt`（包 DEK 的那把）。
   */
  async setSyncPassphrase(loginPassword, syncPassphrase) {
    this.#requireUnlocked();
    const client = this.client;
    const { info, algo, authSalt } = await this.#credentialMeta();
    const proof = phixCrypto.proveDek(this.dek, this.username, info.key_check);
    const material = phixCrypto.rewrap(this.dek, this.username, syncPassphrase, 'syncphrase',
      null, proof, algo, authSalt, loginPassword);
    await client.rewrap(loginPassword, proof, materialsFor(material, 'syncphrase'),
      { authSalt, algo });
    this.keyMode = 'syncphrase';
    saveConfig({ key_mode: 'syncphrase' });
    return this.status();
  }

  // ---------------- 设备 / 会话（P3） ----------------
  /**
   * 会话与设备列表（服务端 `GET /auth/devices`）。
   *
   * `sessions` 是 P3 的正式形态：**一次登录 = 一个会话 = 一台设备**，注销某个
   * 会话 → 它手里的访问令牌**立刻**失效。`devices` 是老式长期令牌，列出来
   * 只是为了兼容老客户端留下的记录。
   *
   * 返回的每一项都补齐了 `device` / `current` / `id` 三个字段，界面不必再
   * 区分两种形态。**响应里没有 refresh 明文，这里也绝不会带出去。**
   */
  async sessions() {
    if (!this.client) throw new cloudsync.PhixError('not_logged_in', '请先登录');
    const data = await this.client.devices();
    return {
      sessions: (data.sessions || []).map((item) => ({
        id: item.id,
        device: item.device || item.name || '',
        created_at: item.created_at || '',
        last_seen_at: item.last_seen_at || '',
        expires_at: item.expires_at || '',
        revoked: Boolean(item.revoked),
        revoked_reason: item.revoked_reason || '',
        current: Boolean(item.current),
        legacy_token_id: item.legacy_token_id ?? null,
        kind: 'session',
      })),
      devices: (data.devices || []).map((item) => ({
        id: item.id,
        device: item.name || item.device || '',
        created_at: item.created_at || '',
        last_used_at: item.last_used_at || '',
        revoked: Boolean(item.revoked),
        current: Boolean(item.current),
        kind: 'legacy',
      })),
      access_ttl: data.access_ttl || 0,
      refresh_ttl: data.refresh_ttl || 0,
    };
  }

  /** 兼容旧调用：只要老式令牌那一列。 */
  async devices() {
    return (await this.sessions()).devices;
  }

  /**
   * 注销会话（别的设备）。
   *
   * - `{ sessionId }`  注销指定的一个会话；
   * - `{ allExceptCurrent: true }` 除了本机全部注销。
   *
   * **只注销服务端那一条会话；本机令牌一个字节都不动**（本机没被注销时，
   * 手里的 JWT 照样有效）。
   */
  async revokeSession({ sessionId = 0, allExceptCurrent = false } = {}) {
    if (!this.client) throw new cloudsync.PhixError('not_logged_in', '请先登录');
    const body = allExceptCurrent ? { all_except_current: true } : { session_id: Number(sessionId) || 0 };
    if (!allExceptCurrent && !body.session_id) {
      throw new cloudsync.PhixError('bad_request', '没有指定要注销哪一台会话');
    }
    const data = await this.client.revokeDevices(body);
    return { revoked: Number(data.revoked) || 0, sessions: Number(data.sessions) || 0, tokens: Number(data.tokens) || 0 };
  }

  /**
   * 重新信任服务器的加密公钥（确认服务器确实换了钥匙之后才该用）。
   *
   * 只在**已登录**时才有意义：手里有令牌就能顺手确认新公钥能不能用
   * （连不上就说明不是"服务器换了钥匙"，而是有人在中间冒充 —— 这时不写固定文件）。
   */
  async trustServerKey() {
    if (!this.client) throw new cloudsync.PhixError('not_logged_in', '请先登录');
    const client = makeClient(this.server || this.#config().server);
    client.trustNewServerKey();
    await client.ensureE2e();
    return this.status();
  }

  // ---------------- 同步 ----------------
  async sync(options = {}) {
    this.#requireUnlocked();
    const config = this.#config();
    const engine = new cloudsync.SyncEngine(this.client, this.dek, this.userId, this.username, {
      dataDir: dataRoot(),
      device: config.device || cloudsync.deviceName(),
      objects: options.objects || config.objects || cloudsync.DEFAULT_OBJECTS,
      siblingApp: 'pll',
    });
    const report = await engine.sync({ dryRun: Boolean(options.dryRun), force: Boolean(options.force) });
    this.lastReport = report;
    if (report.ok) {
      saveConfig({ last_sync_at: cloudsync.nowIso() });
      // 同步可能把云端（网页端 / PLL 写的）那份 AI 服务商与 Key 落进了共享的
      // settings.yaml，而 PHL 自己的运行路径读的是内存里的加密存储 —— 通知上层
      // 把它们收下来，否则"在网页端填的 Key"在客户端里用不了。
      // **dryRun 不算**：预览路径一个字节都不该改。
      if (!options.dryRun && typeof this.onSyncApplied === 'function') {
        try { this.onSyncApplied(report); } catch (error) { this.log(`同步后的 AI 配置回填失败：${error?.message || error}`); }
      }
    }
    return report;
  }

  #requireUnlocked() {
    if (!this.client) throw new cloudsync.PhixError('not_logged_in', '还没登录 phix 账号');
    if (this.dek === null) {
      throw new cloudsync.PhixError(
        'locked',
        '已登录但数据是锁着的 —— 这个账号用的是独立同步口令，请输入同步口令解锁',
      );
    }
  }

  #persistToken(token, what) {
    try { saveToken(token); } catch (error) { this.log(`phix 令牌保存失败（下次要重新登录）：${error.message} ${what}`); }
  }

  /**
   * 登录/注册响应 → 落盘**三串**：老式 `token`、`access_token`、`refresh_token`。
   *
   * 缺哪个就不动哪个（老服务端只给 `token` 时，绝不把已经存着的 refresh 抹掉）。
   * 任何一串都不进日志、不进错误消息。
   */
  #persistTokens(info, what) {
    try {
      const legacy = typeof info?.token === 'string' ? info.token : '';
      const access = typeof info?.access_token === 'string' ? info.access_token : '';
      const refresh = typeof info?.refresh_token === 'string' ? info.refresh_token : '';
      if (legacy) saveToken(legacy);
      saveTokens({ access_token: access || undefined, refresh_token: refresh || undefined });
    } catch (error) {
      this.log(`phix 令牌保存失败（下次要重新登录）：${error.message} ${what}`);
    }
  }

  // ---------------- 自动同步 ----------------
  //
  // 用户 2026-09-19：「每次产生选课、账号、日程等的更改都和服务器同步一次，
  // 服务器端产生更改也同步，用轮询的方法，一秒一次，但是不要让用户察觉」。
  //
  // 所以这里不是"每 N 分钟兜底一次"，而是**一秒一轮的变更探测**：
  //   * 本地有改动（settings.yaml / Schedule / Timetable / School / Profile 的
  //     mtime+大小变了）→ 立刻跑一轮完整同步（把改动推上去）；
  //   * 本地没动 → 只调一次 `GET /sync/manifest`（一层清单，最轻的那个接口），
  //     清单里的 revision 变了才跑完整同步（把云端改动拉下来）。
  // 全程不提示用户：成功不弹、失败只写日志，下一轮再试。
  // `sync_interval_minutes` 仍然有效：作为"无论如何至少完整同步一次"的兜底间隔。
  startAutoSync() {
    const config = this.#config();
    if (config.auto_sync === false) return;
    this.stopAutoSync();
    this.stopped = false;
    this.localSignature = this.#localSignature();
    this.manifestSignature = '';
    this.lastFullSyncAt = 0;
    this.#schedule(AUTO_POLL_MS);
  }

  stopAutoSync() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 本地"被同步的那些文件"的指纹（mtime + 大小）。读不到的文件按 0 算，不会误报。 */
  #localSignature() {
    const parts = [];
    for (const name of ['settings.yaml', 'Schedule', 'Timetable', 'School', 'Profile']) {
      const file = path.join(dataRoot(), name);
      try {
        const stat = fs.statSync(file);
        parts.push(`${name}:${stat.mtimeMs}:${stat.size}`);
      } catch { parts.push(`${name}:-`); }
    }
    return parts.join('|');
  }

  /** 云端清单的指纹：每个对象的 revision 拼起来。取不到就回空串（这轮跳过）。 */
  async #manifestSignature() {
    const manifest = await this.client.manifest();
    const objects = Array.isArray(manifest?.objects) ? manifest.objects : [];
    return objects
      .map((entry) => `${entry?.name || ''}@${Number(entry?.revision) || 0}`)
      .sort()
      .join(',');
  }

  #schedule(delay) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.#tick(); }, delay);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  async #tick() {
    if (this.stopped) return;
    try {
      await this.pollOnce();
    } catch (error) {
      // 静默：轮询失败不打扰用户（离线、令牌过期都会走到这里），下一轮自然重试。
      this.log(`phix 自动同步失败：${error?.message || error}`);
    } finally {
      this.#schedule(AUTO_POLL_MS);
    }
  }

  /**
   * 一轮"变更探测"（一秒一次跑的就是它；单独抽出来是为了能被测试直接调用）：
   *   本地指纹变了 → 完整同步（把改动推上去）；
   *   本地没动、但云端清单变了 → 完整同步（把云端改动拉下来）；
   *   都没变 → 什么都不做（只花一次清单请求）。
   * 返回做了什么，方便测试与排障：`'local' | 'remote' | 'due' | 'none' | 'idle'`。
   */
  async pollOnce() {
    if (!this.client || this.dek === null) return 'idle';
    this.lastPollAt = Date.now();
    const config = this.#config();
    const minutes = Math.max(2, Number(config.sync_interval_minutes) || DEFAULT_INTERVAL_MINUTES);
    const due = Date.now() - (this.lastFullSyncAt || 0) >= minutes * 60_000;
    const local = this.#localSignature();
    const localChanged = Boolean(this.localSignature) && local !== this.localSignature;
    let remoteChanged = false;
    if (!localChanged && !due) {
      // 一秒一次的就是这一下：只取清单，不下载任何对象。
      const signature = await this.#manifestSignature();
      remoteChanged = Boolean(this.manifestSignature) && Boolean(signature) && signature !== this.manifestSignature;
      if (!this.manifestSignature) this.manifestSignature = signature;
    }
    if (!localChanged && !remoteChanged && !due) return 'none';
    await this.sync();
    this.localSignature = this.#localSignature();
    try { this.manifestSignature = await this.#manifestSignature(); } catch { /* 下轮再说 */ }
    this.lastFullSyncAt = Date.now();
    return localChanged ? 'local' : remoteChanged ? 'remote' : 'due';
  }
}

/** `phixCrypto.rewrap` 的结果 → 服务端要的字段（顺序与 Python 一致）。 */
function materialsFor(material, keyMode) {
  return {
    kdf_algo: material.kdf_algo,
    kdf_salt: material.kdf_salt,
    key_wrap: material.key_wrap,
    key_check: material.key_check,
    key_mode: keyMode,
  };
}

/** 给界面看的简报（与 PLL 的 `_brief` 一致）。 */
function brief(report) {
  if (!report) return null;
  return {
    ok: report.ok,
    skipped: report.skipped,
    pulled: report.pulled || [],
    pushed: report.pushed || [],
    errors: report.errors || [],
    conflicts: (report.conflicts || []).length,
    finished_at: report.finished_at,
  };
}

/** 界面上一句话概括一轮同步。 */
function summarize(report) {
  const info = brief(report);
  if (!info) return '';
  if (info.skipped) return info.skipped;
  const parts = [];
  if (info.pulled.length) parts.push(`拉取 ${info.pulled.length} 项`);
  if (info.pushed.length) parts.push(`上传 ${info.pushed.length} 项`);
  if (!parts.length) parts.push('没有需要同步的变化');
  if (info.conflicts) parts.push(`${info.conflicts} 处冲突已记录（数据没丢）`);
  if (info.errors.length) parts.push(`${info.errors.length} 项出错：${info.errors[0]}`);
  return parts.join('，');
}

module.exports = {
  ACCESS_TOKEN_KEY,
  DEFAULT_INTERVAL_MINUTES,
  AUTO_POLL_MS,
  LEGACY_REFRESH_KEY,
  PhixSession,
  REFRESH_TOKEN_KEY,
  TOKEN_KEY,
  brief,
  clearTokens,
  configure,
  dataRoot,
  defaultConfig,
  e2eEnabled,
  loadConfig,
  looksLikeJwt,
  makeClient,
  normalizeServer,
  pinDir,
  saveConfig,
  saveToken,
  saveTokens,
  settingsFile,
  storedToken,
  storedTokens,
  summarize,
};

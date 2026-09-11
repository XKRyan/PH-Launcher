'use strict';
// 账号只认共用数据目录里的 `data/settings.yaml` —— 不再有本机凭据库文件，
// 因此没有"导入账号"这一步：两个程序读写同一份 accounts，谁改的都立刻生效。
//
// 本模块实现与旧 CredentialVault 相同的接口（status / validateCredential /
// saveCredential / removeCredential / getForFill / getForLogin / availability /
// load / discardUnreadable），这样登录、自动填入与设置界面都不用改。
//
// 文件是明文（Lite 规范的既定选择）。PHL 自己的两个开关（自动填入、允许自动
// 重新登录）作为附加键写在对应平台下（`phl_auto_fill` / `phl_auto_login`），
// Lite 不认识但会原样保留；即使被清掉，也只是回到"手动点登录"。
const fs = require('node:fs');
const settingsYaml = require('./settings-yaml.cjs');
const { SITE_BY_PLATFORM, PLATFORM_HOSTS } = require('./shared-accounts.cjs');

const PLATFORM_BY_SITE = Object.freeze(Object.fromEntries(Object.entries(SITE_BY_PLATFORM).map(([platform, site]) => [site, platform])));
const DEFAULT_SITES = Object.freeze(['mail', 'managebac', 'edupage']);
const MAX_USERNAME = 200;
const MAX_SECRET = 512;

const clean = (value, max) => String(value ?? '').replace(/[\u0000\r\n]/g, '').trim().slice(0, max);
const isTrue = (value) => value === true || String(value).toLowerCase() === 'true';
function maskUsername(value) {
  const text = String(value || '');
  const at = text.indexOf('@');
  if (at <= 1) return text ? `${text.slice(0, 1)}•••` : '';
  return `${text.slice(0, 1)}•••${text.slice(at)}`;
}

class SharedAccountStore {
  constructor({ filePath, now = () => new Date(), siteIds = DEFAULT_SITES, fileSystem = fs } = {}) {
    if (!filePath) throw new Error('SharedAccountStore requires the settings.yaml path');
    this.filePath = filePath;
    this.now = now;
    this.siteIds = [...siteIds];
    this.fs = fileSystem;
    this.records = {};
    this.loaded = false;
    this.loadError = '';
  }

  // 明文共用文件永远可用：没有系统密钥、也没有"解不开"的失败态。
  availability() { return { supported: true, reason: '' }; }
  assertAvailable() { /* 始终可用 */ }
  ensureLoaded() { if (!this.loaded) this.load(); }

  load() {
    this.loaded = true;
    this.records = {};
    this.loadError = '';
    let text = '';
    try {
      text = settingsYaml.readTextFile(this.filePath);
    } catch (error) {
      this.loadError = `无法读取共用账号文件：${String(error.message || error).slice(0, 120)}`;
      return this.records;
    }
    if (!text) return this.records;
    const accounts = settingsYaml.readNestedMap(text, 'accounts');
    for (const [platform, siteId] of Object.entries(SITE_BY_PLATFORM)) {
      const entry = accounts[platform];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const username = clean(entry.username || entry.email, MAX_USERNAME);
      if (!username) continue;
      this.records[siteId] = {
        username,
        password: clean(entry.password, MAX_SECRET),
        authcode: siteId === 'mail' ? clean(entry.authcode, MAX_SECRET) : '',
        autoFill: entry.phl_auto_fill === undefined ? true : isTrue(entry.phl_auto_fill),
        autoLogin: siteId === 'mail' ? false : isTrue(entry.phl_auto_login),
        updatedAt: clean(entry.phl_updated_at, 40) || '',
      };
    }
    return this.records;
  }

  status() {
    this.ensureLoaded();
    const sites = {};
    for (const siteId of this.siteIds) {
      const record = this.records[siteId];
      sites[siteId] = record
        ? {
          saved: true,
          username: record.username,
          displayUsername: maskUsername(record.username),
          autoFill: record.autoFill,
          autoLogin: record.autoLogin === true && siteId !== 'mail',
          updatedAt: record.updatedAt,
        }
        : { saved: false, username: '', displayUsername: '', autoFill: false, updatedAt: '' };
    }
    return { ...this.availability(), issue: this.loadError, sites };
  }

  validateCredential(input) {
    this.ensureLoaded();
    const siteId = String(input?.siteId || '');
    if (!this.siteIds.includes(siteId)) throw new Error('此网站不支持保存密码');
    const existing = this.records[siteId];
    const username = clean(input?.username, MAX_USERNAME);
    if (!username) throw new Error('账号不能为空');
    const isMail = siteId === 'mail';
    const password = clean(input?.password, MAX_SECRET) || existing?.password || '';
    const authcode = isMail ? clean(input?.authcode, MAX_SECRET) || existing?.authcode || '' : '';
    if (!password && !authcode) throw new Error(isMail ? '请填写客户端授权码（推荐）或网页密码' : '密码不能为空');
    return { siteId, username, password, authcode, autoFill: input?.autoFill !== false, autoLogin: !isMail && input?.autoLogin === true };
  }

  saveCredential(input) {
    const validated = this.validateCredential(input);
    return this._write({ ...this.records, [validated.siteId]: { ...validated, updatedAt: this.now().toISOString() } });
  }

  removeCredential(siteId) {
    this.ensureLoaded();
    if (!this.siteIds.includes(siteId)) throw new Error('此网站不支持保存密码');
    const existed = Boolean(this.records[siteId]);
    const next = { ...this.records };
    delete next[siteId];
    this._write(next);
    return { existed, status: this.status() };
  }

  /** 读改写整份 accounts：只动 PHL 拥有的平台，其余字段（含 Lite 的）原样保留。 */
  _write(records) {
    const text = settingsYaml.readTextFile(this.filePath);
    const accounts = settingsYaml.readNestedMap(text, 'accounts');
    for (const [platform, siteId] of Object.entries(SITE_BY_PLATFORM)) {
      const record = records[siteId];
      if (!record?.username) { delete accounts[platform]; continue; }
      accounts[platform] = {
        ...(PLATFORM_HOSTS[platform] || {}),
        // 规范里 managebac / mail 用 email、edupage 用 username；
        // 两个键都写，两边的读取代码都能认。
        username: record.username,
        email: record.username,
        password: record.password,
        ...(platform === 'mail' ? { authcode: record.authcode || '' } : {}),
        phl_auto_fill: record.autoFill !== false,
        phl_auto_login: record.autoLogin === true,
        phl_updated_at: record.updatedAt || this.now().toISOString(),
      };
    }
    if (!Object.keys(accounts).length) return this.status();
    // 原子写：替换 accounts 段，文件其余字节原样保留。
    settingsYaml.atomicWriteFileSync(this.filePath, settingsYaml.replaceBlock(text, 'accounts', settingsYaml.serializeNestedMap('accounts', accounts)));
    this.records = records;
    this.loaded = true;
    this.loadError = '';
    return this.status();
  }

  getForFill(siteId, { allowDisabled = false } = {}) {
    this.ensureLoaded();
    if (!this.siteIds.includes(siteId)) return null;
    const record = this.records[siteId];
    if (!record) return null;
    return { username: record.username, password: record.password, authcode: record.authcode, autoFill: allowDisabled ? true : record.autoFill };
  }

  getForLogin(siteId) {
    this.ensureLoaded();
    if (!['edupage', 'managebac'].includes(siteId)) return null;
    const record = this.records[siteId];
    // 共用账号就是"两个程序都用这一份"：账号+密码齐备即允许自动登录，
    // 否则页面会一直像没登录、每次都要手点"登录并同步"。
    if (!record?.username || !record.password) return null;
    return { username: record.username, password: record.password, autoLogin: true };
  }

  /** 共用文件没有加密，不存在解不开的情况；保留接口以兼容调用方。 */
  discardUnreadable() { return false; }
}

module.exports = { DEFAULT_SITES, PLATFORM_BY_SITE, SharedAccountStore, maskUsername };

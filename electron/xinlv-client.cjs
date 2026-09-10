const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const TOKEN_FILE_PREFIX = 'PHXINLV1:';
const DEFAULT_BASE_URL = 'https://xin-lv.com';
const MAX_TOKEN_LENGTH = 512;
const MAX_USERNAME_LENGTH = 200;

function normalizeBaseUrl(value) {
  const parsed = new URL(String(value || DEFAULT_BASE_URL));
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'xin-lv.com') {
    throw new Error('心履服务器地址不受信任');
  }
  return parsed.origin;
}

function normalizeUsername(value) {
  const username = String(value || '').trim();
  if (!username || username.length > MAX_USERNAME_LENGTH || /[\u0000\r\n]/.test(username)) {
    throw new Error('请输入有效的心履账号');
  }
  return username;
}

function normalizeToken(value) {
  const token = String(value || '').trim();
  if (!token || token.length > MAX_TOKEN_LENGTH || /[^A-Za-z0-9._~-]/.test(token)) {
    throw new Error('心履登录令牌无效');
  }
  return token;
}

class XinlvTokenStore {
  constructor({ filePath, safeStorage, fileSystem = fs } = {}) {
    if (!filePath) throw new Error('心履令牌存储路径缺失');
    this.filePath = filePath;
    this.safeStorage = safeStorage;
    this.fileSystem = fileSystem;
    this.record = null;
    this.loaded = false;
    this.issue = '';
  }

  available() {
    try {
      return Boolean(this.safeStorage
        && typeof this.safeStorage.isEncryptionAvailable === 'function'
        && typeof this.safeStorage.encryptString === 'function'
        && typeof this.safeStorage.decryptString === 'function'
        && this.safeStorage.isEncryptionAvailable());
    } catch { return false; }
  }

  load() {
    this.loaded = true;
    this.record = null;
    this.issue = '';
    if (!this.fileSystem.existsSync(this.filePath)) return null;
    if (!this.available()) {
      this.issue = '系统安全存储暂不可用，心履令牌未解锁';
      return null;
    }
    try {
      const raw = this.fileSystem.readFileSync(this.filePath, 'utf8');
      if (!raw.startsWith(TOKEN_FILE_PREFIX)) throw new Error('bad prefix');
      const decoded = this.safeStorage.decryptString(Buffer.from(raw.slice(TOKEN_FILE_PREFIX.length), 'base64'));
      const parsed = JSON.parse(decoded);
      this.record = { username: normalizeUsername(parsed.username), token: normalizeToken(parsed.token) };
    } catch {
      this.issue = '无法解锁以前保存的心履登录状态；原文件未修改';
      this.record = null;
    }
    return this.record;
  }

  ensureLoaded() { if (!this.loaded) this.load(); }

  status() {
    this.ensureLoaded();
    return { loggedIn: Boolean(this.record), username: this.record?.username || '', issue: this.issue };
  }

  get() { this.ensureLoaded(); return this.record; }

  set(username, token) {
    if (!this.available()) throw new Error('系统安全存储不可用，无法保存心履登录状态');
    const record = { username: normalizeUsername(username), token: normalizeToken(token) };
    const encrypted = this.safeStorage.encryptString(JSON.stringify(record));
    if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error('心履登录状态保存失败');
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    this.fileSystem.mkdirSync(path.dirname(this.filePath), { recursive: true });
    try {
      this.fileSystem.writeFileSync(temporaryPath, `${TOKEN_FILE_PREFIX}${encrypted.toString('base64')}`, { encoding: 'utf8', mode: 0o600 });
      this.fileSystem.renameSync(temporaryPath, this.filePath);
    } catch {
      try { this.fileSystem.unlinkSync(temporaryPath); } catch {}
      throw new Error('心履登录状态保存失败，原状态未更改');
    }
    this.record = record;
    this.loaded = true;
    this.issue = '';
    return this.status();
  }

  clear() {
    this.ensureLoaded();
    try { if (this.fileSystem.existsSync(this.filePath)) this.fileSystem.unlinkSync(this.filePath); }
    catch { throw new Error('无法清除心履登录状态'); }
    this.record = null;
    this.issue = '';
    return this.status();
  }
}

class XinlvClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch, tokenStore, device = 'ph-launcher' } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    if (typeof fetchImpl !== 'function') throw new Error('当前系统不支持网络请求');
    if (!tokenStore) throw new Error('心履令牌存储缺失');
    this.fetchImpl = fetchImpl;
    this.tokenStore = tokenStore;
    this.device = String(device || 'ph-launcher').slice(0, 100);
  }

  status() { return this.tokenStore.status(); }

  async request(endpoint, { method = 'GET', body, auth = true, timeoutMs = 30_000 } = {}) {
    const headers = { Accept: 'application/json' };
    const record = this.tokenStore.get();
    if (auth) {
      if (!record) throw new Error('请先登录心履');
      headers.Authorization = `Bearer ${record.token}`;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
      });
      let data = null;
      try { data = await response.json(); } catch {}
      if (!response.ok) {
        if (response.status === 401) this.tokenStore.clear();
        throw new Error(String(data?.error || data?.detail || `心履服务器返回 ${response.status}`).slice(0, 240));
      }
      return data || {};
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('心履服务器响应超时');
      throw error instanceof Error ? error : new Error('心履网络请求失败');
    } finally {
      clearTimeout(timer);
    }
  }

  async login(username, password) {
    const normalized = normalizeUsername(username);
    if (typeof password !== 'string' || !password || password.length > 512) throw new Error('请输入有效的心履密码');
    const data = await this.request('/api/v1/login/', {
      method: 'POST', auth: false, body: { username: normalized, password, device: this.device }, timeoutMs: 30_000,
    });
    this.tokenStore.set(data.username || normalized, data.token);
    return this.status();
  }

  async logout() {
    if (this.tokenStore.get()) {
      try { await this.request('/api/v1/logout/', { method: 'POST', body: {} }); } catch {}
    }
    return this.tokenStore.clear();
  }

  async pullSnapshot() { return this.request('/api/v1/launcher/sync/'); }

  async pushSnapshot(snapshot, revision = 0, deviceId = this.device) {
    return this.request('/api/v1/launcher/sync/push/', {
      method: 'POST', body: { snapshot, revision, device_id: String(deviceId || this.device).slice(0, 100) },
    });
  }

  async chat(message, launcherContext) {
    const body = { message: String(message || '').slice(0, 4000) };
    if (launcherContext && typeof launcherContext === 'object') body.launcher_context = launcherContext;
    return this.request('/api/v1/chat/', { method: 'POST', body, timeoutMs: 90_000 });
  }
}

module.exports = { DEFAULT_BASE_URL, TOKEN_FILE_PREFIX, XinlvTokenStore, XinlvClient, normalizeBaseUrl };

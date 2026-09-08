const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const CREDENTIAL_FILE_PREFIX = 'PHCRED1:';
const CREDENTIAL_VERSION = 1;
const MAX_USERNAME_LENGTH = 200;
const MAX_PASSWORD_LENGTH = 512;
const DEFAULT_SITE_IDS = Object.freeze(['mail', 'managebac', 'edupage']);

function supportedPlatform(platform) {
  return platform === 'win32' || platform === 'darwin';
}

function normalizeSiteIds(siteIds) {
  return new Set((Array.isArray(siteIds) ? siteIds : DEFAULT_SITE_IDS)
    .filter((siteId) => typeof siteId === 'string' && /^[a-z0-9-]{1,64}$/.test(siteId)));
}

function containsUnsafeControlText(value) {
  return /[\u0000\r\n]/.test(value);
}

function normalizeUsername(value) {
  if (typeof value !== 'string') throw new Error('请输入账号');
  const username = value.trim();
  if (!username) throw new Error('请输入账号');
  if (username.length > MAX_USERNAME_LENGTH || containsUnsafeControlText(username)) {
    throw new Error('账号格式无效');
  }
  return username;
}

function normalizePassword(value, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error('请输入密码');
    return '';
  }
  if (typeof value !== 'string') throw new Error('密码格式无效');
  if (value.length > MAX_PASSWORD_LENGTH || containsUnsafeControlText(value)) {
    throw new Error('密码格式无效');
  }
  return value;
}

function maskUsername(username) {
  const value = String(username || '');
  const at = value.indexOf('@');
  if (at > 0) {
    const local = value.slice(0, at);
    return `${local.slice(0, 1)}${local.length > 1 ? '•••' : ''}${value.slice(at)}`;
  }
  return `${value.slice(0, 1)}${value.length > 1 ? '•••' : ''}`;
}

function normalizeStoredRecord(record, siteId) {
  if (!record || typeof record !== 'object') return null;
  try {
    const username = normalizeUsername(record.username);
    // Mail records may hold either the client authcode, the web password,
    // or both; at least one secret must be present. School records never
    // carry an authcode.
    const isMail = siteId === 'mail';
    const authcode = isMail ? normalizePassword(record.authcode || '', { required: false }) : '';
    const password = normalizePassword(record.password, { required: false });
    if (!password && !authcode) throw new Error('empty credential record');
    const updatedAtDate = new Date(record.updatedAt || '');
    const updatedAt = Number.isNaN(updatedAtDate.getTime()) ? '' : updatedAtDate.toISOString();
    const entry = {
      username,
      password,
      autoFill: record.autoFill !== false,
      autoLogin: record.autoLogin === true,
      updatedAt,
    };
    if (isMail) entry.authcode = authcode;
    return entry;
  } catch {
    return null;
  }
}

class CredentialVault {
  constructor({ filePath, safeStorage, platform = process.platform, siteIds = DEFAULT_SITE_IDS, now = () => new Date(), fileSystem = fs } = {}) {
    if (!filePath) throw new Error('Credential vault requires a file path');
    this.filePath = filePath;
    this.safeStorage = safeStorage;
    this.platform = platform;
    this.siteIds = normalizeSiteIds(siteIds);
    this.now = now;
    this.fileSystem = fileSystem;
    this.records = {};
    this.loaded = false;
    this.loadError = '';
  }

  availability() {
    if (!supportedPlatform(this.platform)) {
      return { supported: false, reason: '当前系统暂不支持安全保存密码' };
    }
    if (!this.safeStorage || typeof this.safeStorage.isEncryptionAvailable !== 'function'
      || typeof this.safeStorage.encryptString !== 'function' || typeof this.safeStorage.decryptString !== 'function') {
      return { supported: false, reason: '当前系统无法提供安全存储' };
    }
    try {
      if (!this.safeStorage.isEncryptionAvailable()) {
        return { supported: false, reason: '当前系统密钥暂不可用，请使用网站自身的保持登录功能' };
      }
    } catch {
      return { supported: false, reason: '当前系统密钥暂不可用，请使用网站自身的保持登录功能' };
    }
    return { supported: true, reason: '' };
  }

  assertAvailable() {
    const availability = this.availability();
    if (!availability.supported) throw new Error(availability.reason);
  }

  load() {
    this.loaded = true;
    this.records = {};
    this.loadError = '';
    if (!this.fileSystem.existsSync(this.filePath)) return this.records;
    const availability = this.availability();
    if (!availability.supported) {
      this.loadError = '已保存的密码只能在原来的系统账户中解锁';
      return this.records;
    }
    try {
      const raw = this.fileSystem.readFileSync(this.filePath, 'utf8');
      if (!raw.startsWith(CREDENTIAL_FILE_PREFIX)) throw new Error('unrecognized credential vault');
      const encoded = raw.slice(CREDENTIAL_FILE_PREFIX.length);
      if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        throw new Error('invalid credential ciphertext');
      }
      const decrypted = this.safeStorage.decryptString(Buffer.from(encoded, 'base64'));
      const parsed = JSON.parse(decrypted);
      if (parsed?.version !== CREDENTIAL_VERSION || !parsed?.records || typeof parsed.records !== 'object' || Array.isArray(parsed.records)) {
        throw new Error('unsupported credential vault');
      }
      for (const siteId of this.siteIds) {
        const record = normalizeStoredRecord(parsed.records[siteId], siteId);
        if (Object.hasOwn(parsed.records, siteId) && !record) throw new Error('invalid credential record');
        if (record) this.records[siteId] = record;
      }
    } catch {
      // Never fall back to a readable format and never overwrite an unreadable
      // vault automatically. A changed OS account should not silently erase it.
      this.records = {};
      this.loadError = '无法解锁以前保存的密码；原有加密数据未被修改';
    }
    return this.records;
  }

  ensureLoaded() {
    if (!this.loaded) this.load();
  }

  persistRecords(records) {
    this.assertAvailable();
    if (this.loadError) throw new Error(this.loadError);
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    let descriptor;
    let createdTemporary = false;
    try {
      const payload = JSON.stringify({ version: CREDENTIAL_VERSION, records });
      const encrypted = this.safeStorage.encryptString(payload);
      if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error('encryption unavailable');
      this.fileSystem.mkdirSync(path.dirname(this.filePath), { recursive: true });
      descriptor = this.fileSystem.openSync(temporaryPath, 'wx', 0o600);
      createdTemporary = true;
      this.fileSystem.writeFileSync(descriptor, `${CREDENTIAL_FILE_PREFIX}${encrypted.toString('base64')}`, 'utf8');
      this.fileSystem.fsyncSync(descriptor);
      this.fileSystem.closeSync(descriptor);
      descriptor = undefined;
      // Same-directory rename either replaces the complete encrypted file or
      // fails. Never use a copy-over fallback: it could corrupt the old vault.
      this.fileSystem.renameSync(temporaryPath, this.filePath);
      createdTemporary = false;
    } catch {
      // Storage providers may include their input in errors. Do not propagate
      // that text to the renderer or diagnostics.
      throw new Error('密码未保存，请检查系统安全存储和磁盘空间；原有记录未更改');
    } finally {
      if (descriptor !== undefined) {
        try { this.fileSystem.closeSync(descriptor); } catch { /* Best-effort close. */ }
      }
      if (createdTemporary) {
        try { this.fileSystem.unlinkSync(temporaryPath); } catch { /* Ciphertext only; no secret in diagnostics. */ }
      }
    }
  }

  status() {
    this.ensureLoaded();
    const availability = this.availability();
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
    return {
      ...availability,
      issue: this.loadError,
      sites,
    };
  }

  validateCredential(input) {
    this.ensureLoaded();
    this.assertAvailable();
    if (this.loadError) throw new Error(this.loadError);
    const siteId = String(input?.siteId || '');
    if (!this.siteIds.has(siteId)) throw new Error('此网站不支持保存密码');
    const existing = this.records[siteId];
    const username = normalizeUsername(input?.username);
    const isMail = siteId === 'mail';
    // Mail uses the NetEase client authcode for IMAP/SMTP (recommended); the
    // web password is only a fallback. At least one secret must exist.
    const suppliedPassword = normalizePassword(input?.password, { required: false });
    const suppliedAuthcode = isMail ? normalizePassword(input?.authcode, { required: false }) : '';
    const password = suppliedPassword || (existing ? existing.password : '');
    const authcode = suppliedAuthcode || (existing ? existing.authcode : '') || '';
    if (!password && !authcode) {
      throw new Error(isMail ? '请填写客户端授权码（推荐）或网页密码' : '密码不能为空');
    }
    return { siteId, username, password, authcode, autoFill: input?.autoFill !== false, autoLogin: !isMail && input?.autoLogin === true };
  }

  saveCredential(input) {
    const { siteId, username, password, authcode, autoFill, autoLogin } = this.validateCredential(input);
    const now = this.now();
    const updatedAt = now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : new Date().toISOString();
    const record = {
      username,
      password,
      autoFill,
      // Existing autofill consent never authorizes submitting a login form.
      autoLogin,
      updatedAt,
    };
    // Only mail stores the NetEase client authcode.
    if (siteId === 'mail') record.authcode = authcode || '';
    const nextRecords = { ...this.records, [siteId]: record };
    this.persistRecords(nextRecords);
    this.records = nextRecords;
    return this.status();
  }

  removeCredential(siteId) {
    this.ensureLoaded();
    this.assertAvailable();
    if (this.loadError) throw new Error(this.loadError);
    if (!this.siteIds.has(siteId)) throw new Error('此网站不支持保存密码');
    const existed = Boolean(this.records[siteId]);
    if (existed) {
      const nextRecords = { ...this.records };
      delete nextRecords[siteId];
      this.persistRecords(nextRecords);
      this.records = nextRecords;
    }
    return { existed, status: this.status() };
  }

  getForFill(siteId, { allowDisabled = false } = {}) {
    this.ensureLoaded();
    if (!this.availability().supported || this.loadError || !this.siteIds.has(siteId)) return null;
    const record = this.records[siteId];
    if (!record || (!allowDisabled && !record.autoFill)) return null;
    const entry = { username: record.username, password: record.password };
    if (siteId === 'mail') entry.authcode = record.authcode || '';
    return entry;
  }

  getForLogin(siteId) {
    this.ensureLoaded();
    if (!['edupage', 'managebac'].includes(siteId) || !this.availability().supported || this.loadError) return null;
    const record = this.records[siteId];
    if (record?.autoLogin !== true) return null;
    return { username: record.username, password: record.password, autoLogin: true };
  }
}

module.exports = {
  CREDENTIAL_FILE_PREFIX,
  CREDENTIAL_VERSION,
  DEFAULT_SITE_IDS,
  CredentialVault,
  maskUsername,
  normalizePassword,
  normalizeUsername,
};

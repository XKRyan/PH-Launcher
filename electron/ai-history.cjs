'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const FILE_PREFIX = 'PHAIH1:';
const VERSION = 1;
const MAX_SESSIONS = 30;
const MAX_MEMORIES = 30;
const MAX_MESSAGES = 120;
const MAX_CONTENT_LENGTH = 16_000;
const MAX_TITLE_LENGTH = 100;
const MAX_MEMORY_LENGTH = 500;
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const SAFE_CONNECTION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;

function emptyData() {
  return { version: VERSION, sessions: [], memories: [] };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validId(value, label = '记录 ID') {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`${label}无效`);
  return value;
}

function validConnectionKey(value) {
  if (typeof value !== 'string' || !SAFE_CONNECTION_KEY.test(value)) throw new Error('AI 连接指纹无效');
  return value;
}

function validTimestamp(value) {
  if (typeof value !== 'string') throw new Error('AI 历史时间无效');
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) throw new Error('AI 历史时间无效');
  return value;
}

function normalizeTitle(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('会话标题无效');
  const title = value.trim();
  if (title.length > MAX_TITLE_LENGTH) throw new Error('会话标题过长');
  return title;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length > MAX_MESSAGES) throw new Error('AI 会话消息数量无效');
  const result = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    if (!['user', 'assistant'].includes(message.role)) continue;
    if (typeof message.content !== 'string') throw new Error('AI 会话消息内容无效');
    const content = message.content;
    if (!content.trim() || content.length > MAX_CONTENT_LENGTH) throw new Error('AI 会话消息内容无效');
    result.push({ role: message.role, content });
  }
  if (!result.length) throw new Error('AI 会话没有可保存的消息');
  return result;
}

function normalizeSession(input, updatedAt) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('AI 会话无效');
  return {
    id: validId(input.id, '会话 ID'),
    title: normalizeTitle(input.title),
    connectionKey: validConnectionKey(input.connectionKey),
    messages: normalizeMessages(input.messages),
    updatedAt: validTimestamp(updatedAt),
  };
}

function normalizeMemory(input, updatedAt, generatedId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('长期记忆无效');
  const id = validId(input.id || generatedId, '记忆 ID');
  if (typeof input.text !== 'string') throw new Error('长期记忆内容无效');
  const text = input.text.trim();
  if (!text || text.length > MAX_MEMORY_LENGTH) throw new Error('长期记忆内容无效');
  return { id, text, updatedAt: validTimestamp(updatedAt) };
}

function validateData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== VERSION
      || !Array.isArray(value.sessions) || !Array.isArray(value.memories)
      || value.sessions.length > MAX_SESSIONS || value.memories.length > MAX_MEMORIES) {
    throw new Error('AI 历史文件格式无效');
  }
  const sessions = value.sessions.map((session) => normalizeSession(session, validTimestamp(session?.updatedAt)));
  const memories = value.memories.map((memory) => normalizeMemory(memory, validTimestamp(memory?.updatedAt), ''));
  if (new Set(sessions.map((session) => session.id)).size !== sessions.length
      || new Set(memories.map((memory) => memory.id)).size !== memories.length) {
    throw new Error('AI 历史包含重复 ID');
  }
  const normalized = { version: VERSION, sessions, memories };
  assertTotalSize(normalized);
  return normalized;
}

function assertTotalSize(data) {
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_TOTAL_BYTES) throw new Error('AI 历史总大小超过 3 MB');
}

class AiHistoryStore {
  constructor({ filePath, encrypt, decrypt, now = () => new Date(), fsImpl = fs } = {}) {
    if (typeof filePath !== 'string' || !filePath) throw new Error('AI history filePath is required');
    if (typeof encrypt !== 'function' || typeof decrypt !== 'function') throw new Error('AI history encryption callbacks are required');
    if (typeof now !== 'function') throw new Error('AI history now callback is invalid');
    this.filePath = path.resolve(filePath);
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    this.now = now;
    this.fs = fsImpl;
    this.data = emptyData();
    this.loaded = false;
    this.loadError = '';
  }

  timestamp() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error('当前时间无效');
    return date.toISOString();
  }

  load() {
    if (!this.fs.existsSync(this.filePath)) {
      this.data = emptyData();
      this.loaded = true;
      this.loadError = '';
      return this.snapshot();
    }
    const previous = this.data;
    try {
      const raw = this.fs.readFileSync(this.filePath, 'utf8');
      if (!raw.startsWith(FILE_PREFIX)) throw new Error('unrecognized AI history');
      const encoded = raw.slice(FILE_PREFIX.length);
      if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        throw new Error('invalid AI history ciphertext');
      }
      const decrypted = this.decrypt(Buffer.from(encoded, 'base64'));
      if (typeof decrypted !== 'string') throw new Error('invalid decrypted AI history');
      const parsed = JSON.parse(decrypted);
      const next = validateData(parsed);
      this.data = next;
      this.loaded = true;
      this.loadError = '';
      return this.snapshot();
    } catch {
      this.data = previous;
      this.loaded = true;
      this.loadError = '无法解锁 AI 历史；原有加密数据未被修改';
      throw new Error(this.loadError);
    }
  }

  ensureLoaded() {
    if (!this.loaded) this.load();
    if (this.loadError) throw new Error(this.loadError);
  }

  snapshot() {
    return clone(this.data);
  }

  persist(next) {
    if (this.loadError) throw new Error(this.loadError);
    assertTotalSize(next);
    const directory = path.dirname(this.filePath);
    const temporaryPath = path.join(directory, `.${path.basename(this.filePath)}.${randomUUID()}.tmp`);
    if (path.dirname(path.resolve(temporaryPath)) !== directory) throw new Error('AI 历史临时路径无效');
    let descriptor;
    let temporaryCreated = false;
    try {
      const encrypted = this.encrypt(JSON.stringify(next));
      if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error('invalid AI history encryption');
      this.fs.mkdirSync(directory, { recursive: true });
      descriptor = this.fs.openSync(temporaryPath, 'wx', 0o600);
      temporaryCreated = true;
      this.fs.writeFileSync(descriptor, `${FILE_PREFIX}${encrypted.toString('base64')}`, 'utf8');
      this.fs.fsyncSync(descriptor);
      this.fs.closeSync(descriptor);
      descriptor = undefined;
      this.fs.renameSync(temporaryPath, this.filePath);
      temporaryCreated = false;
    } catch {
      throw new Error('AI 历史未保存；原有记录未更改');
    } finally {
      if (descriptor !== undefined) {
        try { this.fs.closeSync(descriptor); } catch { /* Best-effort close. */ }
      }
      if (temporaryCreated) {
        try { this.fs.unlinkSync(temporaryPath); } catch { /* Encrypted temporary data only. */ }
      }
    }
  }

  saveSession(input) {
    this.ensureLoaded();
    const session = normalizeSession(input, this.timestamp());
    const existingIndex = this.data.sessions.findIndex((item) => item.id === session.id);
    const sessions = this.data.sessions.filter((item) => item.id !== session.id);
    sessions.unshift(session);
    if (existingIndex < 0 && sessions.length > MAX_SESSIONS) throw new Error('AI 会话最多保存 30 个');
    const next = { ...this.data, sessions };
    this.persist(next);
    this.data = next;
    return clone(session);
  }

  removeSession(id) {
    this.ensureLoaded();
    validId(id, '会话 ID');
    const sessions = this.data.sessions.filter((item) => item.id !== id);
    if (sessions.length === this.data.sessions.length) return false;
    const next = { ...this.data, sessions };
    this.persist(next);
    this.data = next;
    return true;
  }

  saveMemory(input) {
    this.ensureLoaded();
    const memory = normalizeMemory(input, this.timestamp(), randomUUID());
    const existingIndex = this.data.memories.findIndex((item) => item.id === memory.id);
    const memories = this.data.memories.filter((item) => item.id !== memory.id);
    memories.unshift(memory);
    if (existingIndex < 0 && memories.length > MAX_MEMORIES) throw new Error('长期记忆最多保存 30 条');
    const next = { ...this.data, memories };
    this.persist(next);
    this.data = next;
    return clone(memory);
  }

  removeMemory(id) {
    this.ensureLoaded();
    validId(id, '记忆 ID');
    const memories = this.data.memories.filter((item) => item.id !== id);
    if (memories.length === this.data.memories.length) return false;
    const next = { ...this.data, memories };
    this.persist(next);
    this.data = next;
    return true;
  }
}

module.exports = { AiHistoryStore };

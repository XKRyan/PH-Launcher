'use strict';

// Xinlv service: credential/token management plus the LWW mood sync engine.
// Follows the reference Windows client's sync rules exactly:
//   1. push all locally dirty entries (uuid upsert, latest-updated wins)
//   2. pull changes since the stored server_time (tombstones included)
//   3. merge: server wins when server updated_at is newer; tombstones delete
//   4. persist the returned server_time for the next incremental pull
// Mood entries live in the encrypted SecureStore (settings.xinlv data block),
// written only through the updateData callback passed in by main.cjs.

const { XinlvClient, XinlvError, MOOD_KEYS, isValidMood } = require('./xinlv-client.cjs');

class XinlvServiceError extends Error {
  constructor(message, code = 'xinlv_error') { super(message); this.name = 'XinlvServiceError'; this.code = code; }
}

function defaultData() {
  return { entries: {}, serverTime: '', dirty: [] };
}

function normalizeEntry(entry) {
  return {
    uuid: String(entry.uuid || ''),
    date: String(entry.date || ''),
    at: entry.at || null,
    mood: entry.mood || '',
    note: String(entry.note || ''),
    deleted: entry.deleted === true,
    intensityLevel: Number.isFinite(Number(entry.intensity_level)) ? Number(entry.intensity_level) : 2,
    intensityPercent: Number.isFinite(Number(entry.intensity_percent)) ? Number(entry.intensity_percent) : 50,
    createdAt: entry.created_at || '',
    updatedAt: String(entry.updated_at || ''),
  };
}

function newUuid() {
  // UUID v4 via crypto — matching the API doc's recommendation.
  const { randomUUID } = require('node:crypto');
  return randomUUID();
}

class XinlvService {
  constructor({ getData, updateData, xinlvClientFactory = null } = {}) {
    this._getData = typeof getData === 'function' ? getData : () => ({ xinlv: defaultData() });
    this._updateData = typeof updateData === 'function' ? updateData : () => {};
    this._clientFactory = xinlvClientFactory;
    this._clientCache = null;
  }

  _data() {
    const data = this._getData();
    if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
      return defaultData();
    }
    return { entries: data.entries, serverTime: data.serverTime || '', dirty: Array.isArray(data.dirty) ? data.dirty : [] };
  }

  _commit(data) {
    this._updateData(data);
  }

  _client() {
    if (this._clientFactory) return this._clientFactory();
    if (!this._clientCache) {
      this._clientCache = new XinlvClient({ token: () => this._credentials().token || '' });
    }
    return this._clientCache;
  }

  _credentials() {
    const data = this._getData();
    return {
      username: String(data.username || ''),
      password: String(data.password || ''),
      token: String(data.token || ''),
    };
  }

  status() {
    const credentials = this._credentials();
    const data = this._data();
    const total = Object.values(data.entries).filter((entry) => !entry.deleted).length;
    return {
      configured: Boolean(credentials.username && credentials.token),
      username: credentials.username,
      tokenPresent: Boolean(credentials.token),
      totalEntries: total,
      pendingSync: data.dirty.length,
      lastServerTime: data.serverTime,
    };
  }

  async login(username, password) {
    const account = String(username || '').trim();
    if (!account || !password) throw new XinlvServiceError('请填写心履账号和密码', 'xinlv_credentials_missing');
    const client = this._clientFactory ? this._clientFactory() : new XinlvClient({ token: () => '' });
    const result = await client.login(account, password);
    this._updateData({ username: result.username || account, token: result.token, password: String(password) });
    this._clientCache = null;
    return this.status();
  }

  async register(username, password) {
    const client = this._clientFactory ? this._clientFactory() : new XinlvClient({ token: () => '' });
    const result = await client.register(String(username || '').trim(), String(password || ''));
    this._updateData({ username: result.username || String(username || '').trim(), token: result.token, password: String(password) });
    this._clientCache = null;
    return this.status();
  }

  async logout() {
    const credentials = this._credentials();
    const client = this._clientCache || (this._clientFactory ? this._clientFactory() : null);
    if (credentials.token && client) {
      try { await client.logout(); } catch { /* token may already be dead */ }
    }
    this._updateData({ token: '' });
    this._clientCache = null;
    return this.status();
  }

  async profile() {
    const client = this._client();
    try { return await client.profile(); } catch (error) {
      if (error.code === 'xinlv_auth') { this._updateData({ token: '' }); this._clientCache = null; }
      throw error;
    }
  }

  // Read-only passthroughs used by the renderer bridge.
  ping() { return this._client().ping(); }
  catalog() { return this.loadCatalog(); }

  recommend(mood) { return this._client().recommend(mood); }
  chat(message) { return this._client().chat(message); }
  chatHistory() { return this._client().chatHistory(); }
  proactive(since) { return this._client().chatProactive(since); }
  async clearChat() { await this._client().chatClear(); return true; }

  // The API documents caching the small content catalog locally so the
  // recommendation view still works offline. It lives beside the entries in
  // the encrypted store, refreshed at most once per day unless forced.
  async loadCatalog({ force = false, maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
    const raw = this._getData();
    const cached = raw.catalog && typeof raw.catalog === 'object' ? raw.catalog : null;
    const fetchedAt = Number(raw.catalogFetchedAt || 0);
    if (!force && cached && Date.now() - fetchedAt < maxAgeMs) return { catalog: cached, cached: true, fetchedAt };
    try {
      const catalog = await this._client().catalog();
      const now = Date.now();
      this._updateData({ catalog, catalogFetchedAt: now });
      return { catalog, cached: false, fetchedAt: now };
    } catch (error) {
      if (cached) return { catalog: cached, cached: true, fetchedAt, error: error.message };
      throw error;
    }
  }

  // Local mood record: upsert into the store and mark dirty for the next sync.
  addMood({ date, at = null, mood, note = '', intensityLevel = 2, intensityPercent = 50 }) {
    if (!isValidMood(mood)) throw new XinlvServiceError('未知心情', 'xinlv_bad_mood');
    const data = this._data();
    const nowIso = new Date().toISOString();
    const uuid = newUuid();
    const entry = normalizeEntry({
      uuid, date: String(date || ''), at, mood, note: String(note || ''),
      deleted: false, intensity_level: intensityLevel, intensity_percent: intensityPercent,
      updated_at: nowIso,
    });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) throw new XinlvServiceError('日期格式不正确', 'xinlv_bad_date');
    data.entries[uuid] = entry;
    if (!data.dirty.includes(uuid)) data.dirty.push(uuid);
    this._commit(data);
    return entry;
  }

  editMood(uuid, patch) {
    const data = this._data();
    const existing = data.entries[String(uuid)];
    if (!existing || existing.deleted) throw new XinlvServiceError('记录不存在', 'xinlv_not_found');
    if (patch.mood !== undefined && !isValidMood(patch.mood)) throw new XinlvServiceError('未知心情', 'xinlv_bad_mood');
    const updated = normalizeEntry({ ...existing, ...patch, uuid: existing.uuid, updated_at: new Date().toISOString() });
    data.entries[existing.uuid] = updated;
    if (!data.dirty.includes(existing.uuid)) data.dirty.push(existing.uuid);
    this._commit(data);
    return updated;
  }

  deleteMood(uuid) {
    const data = this._data();
    const existing = data.entries[String(uuid)];
    if (!existing || existing.deleted) return false;
    existing.deleted = true;
    existing.updated_at = new Date().toISOString();
    if (!data.dirty.includes(existing.uuid)) data.dirty.push(existing.uuid);
    this._commit(data);
    return true;
  }

  listMoods({ sinceDate = '', untilDate = '' } = {}) {
    const data = this._data();
    return Object.values(data.entries)
      .filter((entry) => !entry.deleted)
      .filter((entry) => (!sinceDate || entry.date >= sinceDate) && (!untilDate || entry.date <= untilDate))
      .sort((a, b) => (a.date + (a.at || '')).localeCompare(b.date + (b.at || '')));
  }

  // Full sync round: push dirty → pull since → LWW merge → persist server_time.
  async sync({ force = false } = {}) {
    const credentials = this._credentials();
    if (!credentials.token) throw new XinlvServiceError('尚未登录心履账号', 'xinlv_auth_required');
    const data = this._data();
    const result = { pushed: 0, pulled: 0, errors: [], offline: false };

    const dirtyUuids = force ? Object.keys(data.entries) : data.dirty.filter((uuid) => data.entries[uuid]);
    if (dirtyUuids.length) {
      // Push in batches of 500 per the API contract.
      for (let i = 0; i < dirtyUuids.length; i += 500) {
        const batch = dirtyUuids.slice(i, i + 500).map((uuid) => {
          const entry = data.entries[uuid];
          return {
            uuid: entry.uuid, date: entry.date, at: entry.at || undefined, mood: entry.mood,
            note: entry.note || undefined, intensity_level: entry.intensityLevel,
            intensity_percent: entry.intensityPercent, updated_at: entry.updatedAt,
            deleted: entry.deleted === true,
          };
        });
        try {
          const pushResult = await this._client().pushEntries(batch);
          result.pushed += pushResult.saved + pushResult.updated;
          for (const pushError of pushResult.errors) result.errors.push(pushError.error || '同步错误');
        } catch (error) {
          if (error.code === 'xinlv_auth') { this._updateData({ token: '' }); this._clientCache = null; throw error; }
          result.offline = error.code === 'xinlv_offline';
          result.errors.push(error.message);
          break; // offline: skip pull this round
        }
      }
    }

    if (!result.offline) {
      try {
        const pullResult = await this._client().pullEntries(data.serverTime || null);
        for (const raw of pullResult.entries) {
          const entry = normalizeEntry(raw);
          if (!entry.uuid) continue;
          const local = data.entries[entry.uuid];
          // LWW: server wins when its updated_at is newer; tombstones delete.
          if (!local || String(local.updatedAt || '') < entry.updatedAt) {
            data.entries[entry.uuid] = entry;
            result.pulled += 1;
            const dirtyIndex = data.dirty.indexOf(entry.uuid);
            if (dirtyIndex >= 0) data.dirty.splice(dirtyIndex, 1);
          }
        }
        data.serverTime = pullResult.serverTime || data.serverTime;
      } catch (error) {
        if (error.code === 'xinlv_auth') { this._updateData({ token: '' }); this._clientCache = null; throw error; }
        result.offline = error.code === 'xinlv_offline';
        result.errors.push(error.message);
      }
    }

    // Clear dirty markers only when every push succeeded.
    if (!result.offline && !result.errors.length) data.dirty = [];
    this._commit(data);
    return { ...result, total: Object.values(data.entries).filter((entry) => !entry.deleted).length };
  }
}

module.exports = { XinlvService, XinlvServiceError, XinlvClient, XinlvError, MOOD_KEYS, isValidMood, defaultData, normalizeEntry };

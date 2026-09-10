'use strict';

// Xinlv (心履) REST API client — https://xin-lv.com/api/v1/
// Ported from the reference Windows client (xinlv-windows ApiClient.java),
// following the official API doc (v1). Zero npm dependencies: Node's global
// fetch covers everything.
//
// Error contract:
//   XinlvError(code 'xinlv_auth')        — 401, token invalid → re-login
//   XinlvError(code 'xinlv_rate_limited')— 429
//   XinlvError(code 'xinlv_offline')     — network failure
//   XinlvError(code 'xinlv_api', msg)    — server-provided Chinese message
//
// Crisis safety: chat() surfaces { crisis: true, reply, hotline } unchanged —
// the renderer MUST display the reply and hotline prominently (API doc §6.1).

const BASE = 'https://xin-lv.com';
const MOOD_KEYS = ['happy', 'calm', 'excited', 'grateful', 'tired', 'anxious', 'sad', 'angry', 'lonely', 'numb'];

class XinlvError extends Error {
  constructor(message, code = 'xinlv_api', status = 0) {
    super(message);
    this.name = 'XinlvError';
    this.code = code;
    this.status = status;
  }
}

function isValidMood(mood) { return MOOD_KEYS.includes(mood); }

class XinlvClient {
  constructor({ token = () => '', device = 'ph-launcher-desktop', timeoutMs = 20000, fetchImpl = null } = {}) {
    this._getToken = typeof token === 'function' ? token : () => String(token || '');
    this.device = device;
    this.timeoutMs = timeoutMs;
    this._fetchImpl = fetchImpl || globalThis.fetch;
  }

  async _request(path, { method = 'GET', body = null, auth = true, params = null, timeoutMs = null } = {}) {
    const url = new URL(BASE + path);
    if (params) for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || this.timeoutMs);
    let response;
    try {
      const headers = { Accept: 'application/json' };
      if (body !== null) headers['Content-Type'] = 'application/json';
      if (auth) {
        const token = this._getToken();
        if (!token) throw new XinlvError('尚未登录心履账号', 'xinlv_auth_required');
        headers.Authorization = `Bearer ${token}`;
      }
      response = await this._fetchImpl(url.toString(), {
        method,
        headers,
        body: body === null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      // Configuration errors raised above must not be masked as network failures.
      if (error instanceof XinlvError) throw error;
      if (error && error.name === 'AbortError') throw new XinlvError('心履服务响应超时，请稍后重试', 'xinlv_timeout');
      throw new XinlvError('连不上心履服务器，请检查网络', 'xinlv_offline');
    }
    clearTimeout(timer);
    let parsed;
    try { parsed = await response.json(); } catch {
      throw new XinlvError(`心履服务器返回格式异常（HTTP ${response.status}）`, 'xinlv_format', response.status);
    }
    if (response.status === 401) throw new XinlvError(parsed.error || '心履登录已失效，请重新登录', 'xinlv_auth', 401);
    if (response.status === 429) throw new XinlvError(parsed.error || '操作太频繁，请过几分钟再试', 'xinlv_rate_limited', 429);
    if (response.status >= 400) {
      throw new XinlvError(parsed.error || `心履请求失败（HTTP ${response.status}）`, 'xinlv_api', response.status);
    }
    return parsed;
  }

  async ping() {
    const body = await this._request('/api/v1/ping/', { auth: false, timeoutMs: 6000 });
    return { ok: Boolean(body.ok), version: body.version, serverTime: body.server_time };
  }

  async login(username, password) {
    const body = await this._request('/api/v1/login/', {
      method: 'POST', auth: false,
      body: { username: String(username || '').trim(), password: String(password || ''), device: this.device },
    });
    return { token: body.token, username: body.username, streak: body.streak || 0 };
  }

  async register(username, password, { agree = true } = {}) {
    if (!agree) throw new XinlvError('注册前必须阅读并同意免责声明', 'xinlv_agree_required');
    const body = await this._request('/api/v1/register/', {
      method: 'POST', auth: false,
      body: { username: String(username || '').trim(), password: String(password || ''), agree: true, device: this.device },
    });
    return { token: body.token, username: body.username, streak: body.streak || 0 };
  }

  async logout() {
    await this._request('/api/v1/logout/', { method: 'POST', body: {} });
  }

  async pullEntries(since) {
    const body = await this._request('/api/v1/sync/pull/', {
      params: since ? { since } : null,
    });
    return { serverTime: body.server_time, entries: Array.isArray(body.entries) ? body.entries : [] };
  }

  async pushEntries(entries) {
    const body = await this._request('/api/v1/sync/push/', { method: 'POST', body: { entries } });
    return {
      saved: body.saved || 0, updated: body.updated || 0, skipped: body.skipped || 0,
      errors: Array.isArray(body.errors) ? body.errors : [], serverTime: body.server_time,
    };
  }

  async catalog() { return this._request('/api/v1/catalog/'); }

  async recommend(mood) {
    if (!isValidMood(mood)) throw new XinlvError('未知心情，无法获取推荐', 'xinlv_bad_mood');
    const body = await this._request('/api/v1/recommend/', { params: { mood } });
    return {
      mood: body.mood, info: body.info || null, valence: body.valence,
      songs: Array.isArray(body.songs) ? body.songs : [],
      activities: Array.isArray(body.activities) ? body.activities : [],
      tips: Array.isArray(body.tips) ? body.tips : [],
      practice: body.practice || '',
      video: body.video || null,
    };
  }

  // AI generation can take a while — generous timeout per the reference client.
  async chat(message) {
    const body = await this._request('/api/v1/chat/', {
      method: 'POST', body: { message: String(message || '').slice(0, 4000) }, timeoutMs: 60000,
    });
    return { crisis: body.crisis === true, reply: body.reply || '', hotline: body.hotline || '' };
  }

  async chatHistory() {
    const body = await this._request('/api/v1/chat/history/');
    return Array.isArray(body.messages) ? body.messages : [];
  }

  async chatProactive(since) {
    const body = await this._request('/api/v1/chat/proactive/', { params: since ? { since } : null });
    return { serverTime: body.server_time, messages: Array.isArray(body.messages) ? body.messages : [] };
  }

  async chatClear() {
    await this._request('/api/v1/chat/clear/', { method: 'POST', body: {} });
  }

  async profile() {
    const body = await this._request('/api/v1/profile/');
    return {
      username: body.username, bio: body.bio || '', language: body.language || 'zh',
      avatarUrl: body.avatar_url || '', streak: body.streak || 0,
      badges: Array.isArray(body.badges) ? body.badges : [],
      totalEntries: body.total_entries || 0, dateJoined: body.date_joined || '',
    };
  }
}

module.exports = { XinlvClient, XinlvError, BASE, MOOD_KEYS, isValidMood };

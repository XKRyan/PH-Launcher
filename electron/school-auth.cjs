// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 hzq and Hello Pinghe! Launcher contributors
// Copyright (c) EdupageAPI/edupage-api contributors
// Copyright (c) 2026 PH Launcher contributors
//
// This file adapts login behavior from:
// - Hello Pinghe! Launcher, hellopinghe/managebac/client.py, commit
//   19683149ad5572464d332fbe121c78a2ee5ba359 (GPL-3.0-or-later).
// - edupage-api 0.12.5, edupage_api/login.py, installed wheel source
//   (GPL-3.0-or-later; https://github.com/EdupageAPI/edupage-api).
// It is therefore distributed under GPL-3.0-or-later. This notice must remain
// with source distributions. No student credentials are included in this file.

'use strict';

const { parseHTML } = require('linkedom');
const { encodeRpcBody, parseRpcResponse } = require('./edupage-auth-rpc.cjs');

const ORIGINS = Object.freeze({
  managebac: 'https://shph.managebac.cn',
  edupage: 'https://pingheschool.edupage.org',
});
const FARIA_ACCOUNTS_ORIGIN = 'https://accounts.faria.cn';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 4;

class SchoolAuthError extends Error {
  constructor(code, message, diagnostic = undefined) {
    super(message);
    this.name = 'SchoolAuthError';
    this.code = code;
    if (diagnostic) this.diagnostic = Object.freeze({ ...diagnostic });
  }
}

function fail(code, message, diagnostic) { throw new SchoolAuthError(code, message, diagnostic); }

function siteOrigin(site) {
  const origin = ORIGINS[site];
  if (!origin) fail('URL_NOT_ALLOWED', '未知的学校登录站点');
  return origin;
}

function exactUrl(site, raw) {
  let url;
  try { url = new URL(raw, siteOrigin(site)); } catch {
    fail('URL_NOT_ALLOWED', '学校登录地址无效', { site, phase: 'url-validation', reason: 'invalid-url' });
  }
  if (url.origin !== siteOrigin(site) || url.protocol !== 'https:' || url.username || url.password || url.hash) {
    fail('URL_NOT_ALLOWED', '登录地址不属于已配置的学校站点', {
      site, phase: 'url-validation', reason: 'origin-or-url-shape',
    });
  }
  return url;
}

function manageBacSsoUrl(raw, current = ORIGINS.managebac) {
  if (typeof raw !== 'string' || /[\u0000-\u001f\u007f]/.test(raw)) {
    fail('URL_NOT_ALLOWED', 'ManageBac 单点登录返回了无效地址', {
      site: 'managebac', phase: 'sso-continuation', reason: 'invalid-url-shape',
    });
  }
  let url;
  try { url = new URL(raw, current); } catch {
    fail('URL_NOT_ALLOWED', 'ManageBac 单点登录返回了无效地址', {
      site: 'managebac', phase: 'sso-continuation', reason: 'invalid-url',
    });
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
      || ![ORIGINS.managebac, FARIA_ACCOUNTS_ORIGIN].includes(url.origin)
      || Buffer.byteLength(url.href, 'utf8') > 8192) {
    fail('URL_NOT_ALLOWED', 'ManageBac 单点登录跳转不属于受信任的官方站点', {
      site: 'managebac', phase: 'sso-continuation', reason: 'origin-or-url-shape',
    });
  }
  if (url.origin === FARIA_ACCOUNTS_ORIGIN) {
    const parameters = [...url.searchParams.entries()];
    if (url.pathname !== '/accounts/otsi' || parameters.length !== 1 || parameters[0][0] !== 'token'
        || !parameters[0][1] || parameters[0][1].length > 4096
        || /[\u0000-\u001f\u007f]/.test(parameters[0][1])) {
      fail('URL_NOT_ALLOWED', 'ManageBac 单点登录入口不符合预期', {
        site: 'managebac', phase: 'sso-continuation', reason: 'account-endpoint-shape',
      });
    }
  }
  return url;
}

function requestAllowed(site, url, method) {
  const path = url.pathname;
  if (site === 'managebac') {
    if (method === 'GET' && !url.search && (path === '/login' || path === '/student')) return true;
    if (method === 'POST' && !url.search && path === '/sessions') return true;
    return false;
  }
  if (site === 'edupage') {
    if (method === 'GET' && path === '/login/' && url.search === '?cmd=MainLogin') return true;
    if (method === 'GET' && !url.search && (path === '/user' || path === '/user/')) return true;
    if (method === 'POST' && !url.search && path === '/login/edubarLogin.php') return true;
    if (method === 'POST' && path === '/login/' && [
      '?cmd=MainLogin&akcia=getToken',
      '?cmd=MainLogin&akcia=login',
    ].includes(url.search)) return true;
  }
  return false;
}

function assertRequestAllowed(site, raw, method) {
  const url = exactUrl(site, raw);
  if (!requestAllowed(site, url, method)) {
    fail('URL_NOT_ALLOWED', '学校登录流程发生异常，请在内置网页完成登录', {
      site, phase: 'request-allowlist', reason: 'request-not-allowed',
    });
  }
  return url;
}

function bounded(value, max, label) {
  const text = String(value ?? '');
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) fail('PAGE_CHANGED', `${label}无效`);
  return text;
}

function parseDocument(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_BODY_BYTES) fail('PAGE_TOO_LARGE', '学校登录页面过大');
  // linkedom parses an inert document. Scripts are inspected as text only and
  // are never evaluated, attached to a browser, or allowed to fetch resources.
  return parseHTML(html).document;
}

function loginChallenge(document) {
  return Boolean(document.querySelector(
    'input[name*="captcha" i], input[id*="captcha" i], .g-recaptcha, [data-sitekey], input[name="t2fasec"], input[name="2fform"]',
  ));
}

function parseManageBacForm(html) {
  const document = parseDocument(html);
  const forms = document.querySelectorAll('form#session_form');
  if (forms.length !== 1) fail('LOGIN_REQUIRED', 'ManageBac 登录方式已变化，请在内置网页手动登录');
  const form = forms[0];
  const action = exactUrl('managebac', form.getAttribute('action') || '/sessions');
  if (action.pathname !== '/sessions' || action.search || action.hash || String(form.getAttribute('method') || 'post').toLowerCase() !== 'post') {
    fail('LOGIN_REQUIRED', 'ManageBac 登录方式已变化，请在内置网页手动登录');
  }
  if (loginChallenge(document)) fail('LOGIN_REQUIRED', 'ManageBac 需要人工完成验证码或额外验证');
  const token = bounded(form.querySelector('input[name="authenticity_token"]')?.getAttribute('value'), 2048, 'ManageBac 登录令牌');
  const login = form.querySelector('#session_login') || form.querySelector('input[type="email"]');
  const password = form.querySelector('#session_password') || form.querySelector('input[type="password"]');
  const loginName = login?.getAttribute('name');
  const passwordName = password?.getAttribute('name');
  if (!['login', 'session[login]'].includes(loginName) || !['password', 'session[password]'].includes(passwordName)) {
    fail('LOGIN_REQUIRED', 'ManageBac 登录字段已变化，请在内置网页手动登录');
  }
  const commitNode = form.querySelector('input[name="commit"]');
  const commit = commitNode?.getAttribute('value');
  if (commit != null && (commit.length > 100 || /[\u0000-\u001f\u007f]/.test(commit))) fail('PAGE_CHANGED', 'ManageBac 登录按钮字段无效');
  return { action: action.href, token, loginName, passwordName, commit: commit || '' };
}

function parseEduPageCsrf(html) {
  const document = parseDocument(html);
  if (loginChallenge(document)) fail('LOGIN_REQUIRED', 'EduPage 需要人工完成验证码或额外验证');
  let token = document.querySelector('input[name="csrfauth"]')?.getAttribute('value') || '';
  if (!token) {
    for (const script of document.querySelectorAll('script')) {
      const match = String(script.textContent || '').match(/["']csrftoken["']\s*:\s*["']([^"'\u0000-\u001f]{1,2048})["']/);
      if (match) { token = match[1]; break; }
    }
  }
  return bounded(token, 2048, 'EduPage 登录令牌');
}

function hasManageBacSession(html) {
  const document = parseDocument(html);
  if (document.querySelector('#session_password, form#session_form, input[type="password"]')) return false;
  return Boolean(document.querySelector(
    'a[href="/sessions/sign_out"], form[action="/sessions/sign_out"], [data-current-user-id], a[href^="/student/classes"]',
  ));
}

function jsonObjectAt(source, start) {
  if (source[start] !== '{') return null;
  let depth = 0; let quoted = false; let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) {
      try { return JSON.parse(source.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

function parseEduPageSession(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_BODY_BYTES) fail('PAGE_TOO_LARGE', 'EduPage 登录结果过大');
  const document = parseDocument(html);
  // userhome({...}) is the installed API's authenticated-data marker. Inspect
  // inert script text only; visible text cannot spoof it and nothing executes.
  for (const script of document.querySelectorAll('script')) {
    const source = String(script.textContent || '');
    const marker = /\buserhome\s*\(\s*\{/g;
    let match;
    while ((match = marker.exec(source))) {
      const data = jsonObjectAt(source, marker.lastIndex - 1);
      if (data && /^[\w@.:-]{1,100}$/.test(String(data.userid || '')) && data.dbi && typeof data.dbi === 'object' && !Array.isArray(data.dbi)) {
        return { userId: String(data.userid) };
      }
    }
  }
  return null;
}

function credentialRecord(record) {
  if (!record || record.autoLogin !== true) fail('LOGIN_REQUIRED', '请在启动器中登录此学校账号，或明确开启此站点的自动登录');
  const username = String(record.username ?? '');
  const password = String(record.password ?? '');
  if (!username || username.length > 320 || /[\u0000-\u001f\u007f]/.test(username) || !password || password.length > 2048) {
    fail('LOGIN_REQUIRED', '保存的登录凭据不可用，请在启动器中重新登录此学校账号');
  }
  return { username, password, revision: record.revision == null ? null : String(record.revision) };
}

function sameCredential(first, second) {
  return first.username === second.username && first.password === second.password && first.revision === second.revision;
}

function redirectClassification(site, url) {
  const path = url.pathname.toLowerCase();
  if (site === 'managebac') {
    if (path === '/login' || path === '/login/') return 'credentials';
    if (path === '/student' || path.startsWith('/student/')) return 'portal';
    return 'unsupported';
  }
  if (path.includes('twofactor')) return 'second-factor';
  if (url.searchParams.get('cap') === '1' || url.searchParams.get('lerr') === 'b43b43') return 'captcha';
  if (url.searchParams.get('bad') === '1') return 'credentials';
  if (path === '/user' || path === '/user/') return 'portal';
  if (path === '/login' || path === '/login/' || path === '/login/edubarlogin.php') return 'credentials';
  return 'unsupported';
}

function verificationUrl(site) {
  return site === 'managebac' ? `${ORIGINS.managebac}/student` : `${ORIGINS.edupage}/user`;
}

function redirectUrl(site, location, current) {
  let resolved;
  try { resolved = new URL(location, current).href; } catch {
    fail('PAGE_CHANGED', '学校登录返回了无法识别的跳转，请在内置网页完成登录', {
      site, phase: 'login-redirect', reason: 'invalid-location',
    });
  }
  return exactUrl(site, resolved);
}

function eduPageTicketUrl(raw, current = ORIGINS.edupage) {
  if (typeof raw !== 'string' || /[\u0000-\u001f\u007f]/.test(raw)) {
    fail('URL_NOT_ALLOWED', 'EduPage 登录返回了无效的票据地址，请在内置网页完成登录', {
      site: 'edupage', phase: 'ticket-redirect', reason: 'invalid-url-shape',
    });
  }
  const url = redirectUrl('edupage', raw, current);
  const path = url.pathname.toLowerCase();
  let decodedPath;
  try { decodedPath = decodeURIComponent(url.pathname); } catch {
    fail('URL_NOT_ALLOWED', 'EduPage 登录票据路径无效，请在内置网页完成登录', {
      site: 'edupage', phase: 'ticket-redirect', reason: 'invalid-path-encoding',
    });
  }
  if (/[\u0000-\u001f\u007f]/.test(decodedPath)) {
    fail('URL_NOT_ALLOWED', 'EduPage 登录票据路径无效，请在内置网页完成登录', {
      site: 'edupage', phase: 'ticket-redirect', reason: 'control-character',
    });
  }
  if (Buffer.byteLength(url.href, 'utf8') > 8192) {
    fail('URL_NOT_ALLOWED', 'EduPage 登录票据地址过长，请在内置网页完成登录', {
      site: 'edupage', phase: 'ticket-redirect', reason: 'url-too-long',
    });
  }
  const parameters = [...url.searchParams.entries()];
  if (parameters.length > 32 || parameters.some(([key, value]) => /[\u0000-\u001f\u007f]/.test(key) || /[\u0000-\u001f\u007f]/.test(value))) {
    fail('URL_NOT_ALLOWED', 'EduPage 登录票据参数无效，请在内置网页完成登录', {
      site: 'edupage', phase: 'ticket-redirect', reason: parameters.length > 32 ? 'too-many-parameters' : 'control-character',
    });
  }
  // redirectUrl is an opaque, one-use continuation minted by the login RPC.
  // Keep it inside the known authentication namespace without guessing the
  // server's parameter names or stripping its ticket query.
  if (path === '/' || path === '/user' || path === '/user/' || path.startsWith('/login/')) return url;
  fail('URL_NOT_ALLOWED', 'EduPage 登录返回了未知的票据地址，请在内置网页完成登录', {
    site: 'edupage', phase: 'ticket-redirect', reason: 'path-not-allowed',
  });
}

function failForRedirect(site, classification, status) {
  const diagnostic = { site, phase: 'login-redirect', reason: classification, status };
  if (classification === 'captcha') {
    fail('LOGIN_REQUIRED', '学校登录需要人工完成验证码，请在内置网页继续', diagnostic);
  }
  if (classification === 'second-factor') {
    fail('LOGIN_REQUIRED', '学校登录需要人工完成额外验证，请在内置网页继续', diagnostic);
  }
  if (classification === 'credentials') {
    fail('LOGIN_REQUIRED', '学校未接受账号或密码，请检查后重试', diagnostic);
  }
  fail('LOGIN_REQUIRED', '学校登录方式已变化，请在内置网页完成登录', diagnostic);
}

/**
 * Secure school-session restorer.
 *
 * Required injections:
 *   fetch(site, exactHttpsUrl, options) -> Response-like value. The Electron
 *     adapter must bind this to the site's persistent session and preserve
 *     `redirect: "manual"` so redirects can be validated here.
 *   getCredential(site, { manual }) -> { username, password, autoLogin: true, revision? }
 *     only when the user explicitly consented to automatic login.
 *
 * Public methods:
 *   withSession(site, operation): runs operation; on LOGIN_REQUIRED, restores
 *     once and reruns operation exactly once.
 *   authenticate(site): restores a session, singleflight per site.
 *   invalidate(site): aborts/invalidate in-flight work after account/session
 *     changes. It intentionally does not erase the anti-lockout cooldown.
 */
class SchoolAuthenticator {
  constructor({
    fetch,
    getCredential,
    now = () => Date.now(),
    timeoutMs = 15000,
    cooldownMs = 60000,
    maxBodyBytes = MAX_BODY_BYTES,
  }) {
    if (typeof fetch !== 'function') throw new TypeError('SchoolAuthenticator requires an injected session fetch');
    if (typeof getCredential !== 'function') throw new TypeError('SchoolAuthenticator requires getCredential');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new TypeError('timeoutMs is out of range');
    if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 1000 || cooldownMs > 3600000) throw new TypeError('cooldownMs is out of range');
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > MAX_BODY_BYTES) throw new TypeError('maxBodyBytes is out of range');
    this.fetch = fetch;
    this.getCredential = getCredential;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.cooldownMs = cooldownMs;
    this.maxBodyBytes = maxBodyBytes;
    this.generations = new Map();
    this.inflight = new Map();
    this.controllers = new Map();
    this.lastAttempt = new Map();
    this.firstFailures = new Map();
  }

  invalidate(site) {
    siteOrigin(site);
    this.generations.set(site, (this.generations.get(site) || 0) + 1);
    this.controllers.get(site)?.abort();
    this.controllers.delete(site);
    this.inflight.delete(site);
  }

  async withSession(site, operation) {
    siteOrigin(site);
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    const generation = this.generations.get(site) || 0;
    try {
      const result = await operation();
      this.#operationStillCurrent(site, generation);
      return result;
    } catch (error) {
      this.#operationStillCurrent(site, generation);
      if (error?.code !== 'LOGIN_REQUIRED') throw error;
    }
    this.#operationStillCurrent(site, generation);
    await this.authenticate(site);
    this.#operationStillCurrent(site, generation);
    try {
      const result = await operation();
      this.#operationStillCurrent(site, generation);
      return result;
    } catch (error) {
      this.#operationStillCurrent(site, generation);
      throw error;
    }
  }

  authenticate(site, { manual = false } = {}) {
    siteOrigin(site);
    const existing = this.inflight.get(site);
    if (existing) return existing;
    const generation = this.generations.get(site) || 0;
    const controller = new AbortController();
    this.controllers.set(site, controller);
    const promise = this.#authenticate(site, generation, controller.signal, manual === true).finally(() => {
      if (this.inflight.get(site) === promise) this.inflight.delete(site);
      if (this.controllers.get(site) === controller) this.controllers.delete(site);
    });
    this.inflight.set(site, promise);
    return promise;
  }

  #stillCurrent(site, generation, signal) {
    if (signal.aborted || (this.generations.get(site) || 0) !== generation) fail('SESSION_INVALIDATED', '登录状态已变化，请重试当前操作');
  }

  #operationStillCurrent(site, generation) {
    if ((this.generations.get(site) || 0) !== generation) fail('SESSION_INVALIDATED', '登录状态已变化，请重试当前操作');
  }

  async #authenticate(site, generation, signal, manual) {
    const elapsed = Number(this.now()) - (this.lastAttempt.get(site) ?? -Infinity);
    if (elapsed < this.cooldownMs) {
      const remainingSeconds = Math.max(1, Math.ceil((this.cooldownMs - elapsed) / 1000));
      const previous = this.firstFailures.get(site);
      const prefix = previous?.message || '最近已经提交过一次登录';
      fail('LOGIN_COOLDOWN', `${prefix}；为保护账号，请 ${remainingSeconds} 秒后再试`, {
        site, phase: 'cooldown', reason: 'recent-credential-attempt', remainingSeconds,
        ...(previous?.code ? { previousCode: previous.code } : {}),
      });
    }
    const attemptBefore = this.lastAttempt.get(site);
    try {
      const first = credentialRecord(await this.getCredential(site, { manual }));
      this.#stillCurrent(site, generation, signal);
      if (site === 'managebac') await this.#loginManageBac(first, generation, signal, manual);
      else await this.#loginEduPage(first, generation, signal, manual);
      this.#stillCurrent(site, generation, signal);
      this.firstFailures.delete(site);
      return { site, authenticated: true };
    } catch (error) {
      if (this.lastAttempt.get(site) !== attemptBefore && error instanceof SchoolAuthError
          && error.code !== 'SESSION_INVALIDATED' && !this.firstFailures.has(site)) {
        this.firstFailures.set(site, Object.freeze({ code: error.code, message: error.message }));
      }
      throw error;
    }
  }

  async #confirmedCredential(site, first, generation, signal, manual) {
    const current = credentialRecord(await this.getCredential(site, { manual }));
    this.#stillCurrent(site, generation, signal);
    if (!sameCredential(first, current)) fail('LOGIN_REQUIRED', '自动登录设置已变化，本次未提交账号密码');
    return current;
  }

  async #loginManageBac(first, generation, signal, manual) {
    const page = await this.#request('managebac', `${ORIGINS.managebac}/login`, { signal, canonicalizePortalRedirect: true });
    this.#stillCurrent('managebac', generation, signal);
    // Another trusted view may have completed login while this request was in
    // flight. Accept only the same stable authenticated marker used below.
    if (page.url.pathname === '/student' && hasManageBacSession(page.body)) return;
    const form = parseManageBacForm(page.body);
    const credential = await this.#confirmedCredential('managebac', first, generation, signal, manual);
    const payload = new URLSearchParams({
      authenticity_token: form.token,
      [form.loginName]: credential.username,
      [form.passwordName]: credential.password,
      remember_me: '1',
    });
    if (form.commit) payload.set('commit', form.commit);
    this.lastAttempt.set('managebac', Number(this.now()));
    const result = await this.#request('managebac', form.action, {
      method: 'POST', body: payload.toString(), signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      credentialPost: true,
    });
    this.#stillCurrent('managebac', generation, signal);
    if (result.url.pathname === '/login' || !hasManageBacSession(result.body)) {
      // Verify on a stable authenticated page; a successful status alone is not login proof.
      const verification = await this.#request('managebac', `${ORIGINS.managebac}/student`, { signal });
      this.#stillCurrent('managebac', generation, signal);
      if (!hasManageBacSession(verification.body)) fail('LOGIN_REQUIRED', 'ManageBac 未能自动登录，请在内置网页完成登录或额外验证');
    }
  }

  async #loginEduPage(first, generation, signal, manual) {
    const loginPage = await this.#request('edupage', `${ORIGINS.edupage}/login/?cmd=MainLogin`, { signal, canonicalizePortalRedirect: true });
    this.#stillCurrent('edupage', generation, signal);
    if ((loginPage.url.pathname === '/user' || loginPage.url.pathname === '/user/') && parseEduPageSession(loginPage.body)) return;
    // EduPage's current mainlogin.js and edupage-api 0.12.5 use a two-step RPC.
    // The legacy form POST remains a capability fallback only if getToken does
    // not speak the RPC envelope; a password-bearing RPC is never followed by a
    // second password POST in the same attempt.
    const tokenRaw = await this.#request('edupage', `${ORIGINS.edupage}/login/?cmd=MainLogin&akcia=getToken`, {
      method: 'POST', body: encodeRpcBody({ username: first.username, edupage: '' }), signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json,text/plain' },
      allowCapabilityMiss: true,
    });
    this.#stillCurrent('edupage', generation, signal);
    const tokenResponse = parseRpcResponse(tokenRaw.body);
    const rpcToken = typeof tokenResponse?.token === 'string' && /^[^\u0000-\u001f\u007f]{1,4096}$/.test(tokenResponse.token)
      ? tokenResponse.token : '';
    if (rpcToken) {
      const credential = await this.#confirmedCredential('edupage', first, generation, signal, manual);
      const payload = {
        username: credential.username, password: credential.password,
        userToken: rpcToken, edupage: '', ctxt: '', tu: null, gu: null, au: null,
      };
      this.lastAttempt.set('edupage', Number(this.now()));
      const loginRaw = await this.#request('edupage', `${ORIGINS.edupage}/login/?cmd=MainLogin&akcia=login`, {
        method: 'POST', body: encodeRpcBody(payload), signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json,text/plain' },
        credentialPost: true, rpcCredentialPost: true,
      });
      this.#stillCurrent('edupage', generation, signal);
      const loginResponse = parseRpcResponse(loginRaw.body);
      if (!loginResponse) fail('PAGE_CHANGED', 'EduPage 登录响应无法识别，请在内置网页完成登录');
      if (loginResponse.needCaptcha === '1' || loginResponse.needCaptcha === 1) {
        fail('LOGIN_REQUIRED', 'EduPage 需要人工完成验证码，请在内置网页继续', {
          site: 'edupage', phase: 'rpc-login', reason: 'captcha',
        });
      }
      if (loginResponse.redirectUrl) {
        const ticket = await this.#request('edupage', eduPageTicketUrl(loginResponse.redirectUrl).href, {
          signal, eduPageTicket: true,
        });
        this.#stillCurrent('edupage', generation, signal);
        if (parseEduPageSession(ticket.body)) return;
        const verification = await this.#request('edupage', `${ORIGINS.edupage}/user`, { signal });
        this.#stillCurrent('edupage', generation, signal);
        if (parseEduPageSession(verification.body)) return;
        fail('LOGIN_REQUIRED', 'EduPage 需要在内置网页完成额外验证');
      }
      const errorId = String(loginResponse.err?.error_id || '');
      if (errorId === 'invalid_token') fail('LOGIN_REQUIRED', 'EduPage 登录令牌已失效，请稍后重试', {
        site: 'edupage', phase: 'rpc-login', reason: 'invalid-token',
      });
      fail('LOGIN_REQUIRED', 'EduPage 未接受账号或密码，请检查后重试', {
        site: 'edupage', phase: 'rpc-login', reason: 'credentials',
      });
    }
    if (tokenResponse?.err) fail('LOGIN_REQUIRED', 'EduPage 未接受此账号，请检查后重试', {
      site: 'edupage', phase: 'rpc-token', reason: 'credentials',
    });

    // Fixed legacy fallback from edupage-api 0.12.5. It is reached only before
    // any password-bearing request has been made.
    const csrf = parseEduPageCsrf(loginPage.body);
    const credential = await this.#confirmedCredential('edupage', first, generation, signal, manual);
    const payload = new URLSearchParams({ csrfauth: csrf, username: credential.username, password: credential.password });
    this.lastAttempt.set('edupage', Number(this.now()));
    const result = await this.#request('edupage', `${ORIGINS.edupage}/login/edubarLogin.php`, {
      method: 'POST', body: payload.toString(), signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      credentialPost: true,
    });
    this.#stillCurrent('edupage', generation, signal);
    if (!parseEduPageSession(result.body)) {
      const verification = await this.#request('edupage', `${ORIGINS.edupage}/user`, { signal });
      this.#stillCurrent('edupage', generation, signal);
      if (!parseEduPageSession(verification.body)) fail('LOGIN_REQUIRED', 'EduPage 未能自动登录；请在启动器中检查账号密码，验证码或额外验证请在内置网页完成');
    }
  }

  async #request(site, raw, {
    method = 'GET', body, headers = {}, signal,
    credentialPost = false,
    rpcCredentialPost = false,
    eduPageTicket = false,
    allowCapabilityMiss = false,
    canonicalizePortalRedirect = false,
  } = {}) {
    let url = eduPageTicket ? eduPageTicketUrl(raw) : assertRequestAllowed(site, raw, method);
    if (eduPageTicket && (site !== 'edupage' || method !== 'GET' || body != null)) throw new TypeError('EduPage ticket requests must be credential-free GETs');
    if (credentialPost && method !== 'POST') throw new TypeError('credentialPost requires POST');
    let requestMethod = method;
    let requestBody = body;
    let requestHeaders = { Accept: 'text/html,application/xhtml+xml', ...headers };
    let manageBacSso = false;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      let response;
      try {
        response = await this.fetch(site, url.href, {
          method: requestMethod,
          body: requestBody,
          headers: requestHeaders,
          redirect: 'manual',
          credentials: 'include',
          cache: 'no-store',
          signal: combined,
        });
      } catch (error) {
        if (error instanceof SchoolAuthError) throw error;
        if (signal.aborted) fail('SESSION_INVALIDATED', '登录状态已变化，请重试当前操作');
        fail(timeout.aborted ? 'TIMEOUT' : 'NETWORK_ERROR', timeout.aborted ? '学校登录请求超时' : '暂时无法连接学校登录站点');
      }
      if (!response || !Number.isInteger(response.status) || !response.headers) fail('NETWORK_ERROR', '学校登录返回了无效响应');
      if (response.url) {
        const actual = manageBacSso ? manageBacSsoUrl(response.url, url) : exactUrl(site, response.url);
        if (actual.href !== url.href) fail('URL_NOT_ALLOWED', '网络层绕过了受检的手动重定向');
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirect === MAX_REDIRECTS) fail('PAGE_CHANGED', '学校登录重定向过多');
        const location = response.headers.get('location');
        if (!location) fail('PAGE_CHANGED', '学校登录重定向缺少目标');
        const destination = (site === 'managebac' && (credentialPost || manageBacSso))
          ? manageBacSsoUrl(location, url) : redirectUrl(site, location, url);
        const classification = redirectClassification(site, destination);
        if (credentialPost) {
          if (response.status === 307 || response.status === 308) {
            fail('PAGE_CHANGED', '学校登录响应无法安全处理，请改用内置网页登录', {
              site, phase: 'credential-post', reason: 'post-replay-blocked', status: response.status,
            });
          }
          if (rpcCredentialPost) {
            // RPC normally responds with a JSON redirectUrl. A network redirect
            // from the password POST is not replayed or interpreted as success.
            fail('PAGE_CHANGED', 'EduPage RPC 登录响应发生异常，请在内置网页完成登录', {
              site, phase: 'credential-post', reason: 'unexpected-http-redirect', status: response.status,
            });
          }
          if (site === 'managebac' && destination.origin === FARIA_ACCOUNTS_ORIGIN) {
            // /sessions issued this one-use Faria continuation. Password and
            // form headers stop here; the token is carried only in the official
            // HTTPS GET URL and is never copied to diagnostics.
            url = destination;
            requestMethod = 'GET'; requestBody = undefined;
            requestHeaders = { Accept: requestHeaders.Accept };
            credentialPost = false;
            manageBacSso = true;
            continue;
          }
          if (classification !== 'portal') failForRedirect(site, classification, response.status);
          // A successful credential POST may point at a per-account portal URL.
          // Never request that untrusted target: cookies from the manual response
          // are already stored, so the caller verifies them at a fixed endpoint.
          return { url: destination, body: '', status: response.status, redirected: true };
        }
        if (manageBacSso) {
          if (destination.origin === ORIGINS.managebac) {
            // Never request a server-supplied school callback. Return to the
            // fixed authenticated page and verify the session marker there.
            url = assertRequestAllowed('managebac', verificationUrl('managebac'), 'GET');
            requestMethod = 'GET'; requestBody = undefined;
            requestHeaders = { Accept: requestHeaders.Accept };
            manageBacSso = false;
            continue;
          }
          url = destination;
          requestMethod = 'GET'; requestBody = undefined;
          requestHeaders = { Accept: requestHeaders.Accept };
          continue;
        }
        if (eduPageTicket) {
          // The RPC issued this internal continuation. Follow it only as a
          // credential-free GET and revalidate every hop against the same
          // origin, namespace and size bounds.
          url = eduPageTicketUrl(destination.href, url);
          requestMethod = 'GET'; requestBody = undefined;
          requestHeaders = { Accept: requestHeaders.Accept };
          continue;
        }
        if (classification === 'captcha' || classification === 'second-factor' || classification === 'credentials') {
          failForRedirect(site, classification, response.status);
        }
        if (canonicalizePortalRedirect && classification === 'portal') {
          url = assertRequestAllowed(site, verificationUrl(site), 'GET');
          requestMethod = 'GET'; requestBody = undefined;
          requestHeaders = { Accept: requestHeaders.Accept };
          canonicalizePortalRedirect = false;
          continue;
        }
        if ([301, 302, 303].includes(response.status) && requestMethod === 'POST') {
          requestMethod = 'GET'; requestBody = undefined;
          requestHeaders = { Accept: requestHeaders.Accept };
        }
        url = eduPageTicket ? eduPageTicketUrl(destination.href, url) : assertRequestAllowed(site, destination.href, requestMethod);
        continue;
      }
      if (response.status === 401 || response.status === 403) fail('LOGIN_REQUIRED', '学校站点要求重新登录');
      if (allowCapabilityMiss && [404, 405, 501].includes(response.status)) {
        return { url, body: '', status: response.status, capabilityMiss: true };
      }
      if (response.status < 200 || response.status >= 300) fail('NETWORK_ERROR', '学校登录站点暂时没有正常响应');
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > this.maxBodyBytes) fail('PAGE_TOO_LARGE', '学校登录页面过大');
      let responseBody;
      try {
        responseBody = await this.#readBody(response);
      } catch (error) {
        if (error instanceof SchoolAuthError) throw error;
        if (signal.aborted) fail('SESSION_INVALIDATED', '登录状态已变化，请重试当前操作');
        fail(timeout.aborted ? 'TIMEOUT' : 'NETWORK_ERROR', timeout.aborted ? '学校登录请求超时，请稍后重试' : '学校登录响应读取失败，请稍后重试', {
          site, phase: 'response-body', reason: timeout.aborted ? 'timeout' : 'read-failed',
        });
      }
      const document = parseDocument(responseBody);
      if (loginChallenge(document)) fail('LOGIN_REQUIRED', '学校站点需要人工完成验证码或双重验证');
      return { url, body: responseBody, status: response.status };
    }
    fail('PAGE_CHANGED', '学校登录重定向过多');
  }

  async #readBody(response) {
    if (response.body?.getReader) {
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > this.maxBodyBytes) { await reader.cancel(); fail('PAGE_TOO_LARGE', '学校登录页面过大'); }
        chunks.push(Buffer.from(chunk.value));
      }
      return Buffer.concat(chunks).toString('utf8');
    }
    const body = await response.text();
    if (Buffer.byteLength(body) > this.maxBodyBytes) fail('PAGE_TOO_LARGE', '学校登录页面过大');
    return body;
  }
}

module.exports = {
  ORIGINS,
  SchoolAuthError,
  SchoolAuthenticator,
  assertRequestAllowed,
  parseManageBacForm,
  parseEduPageCsrf,
  hasManageBacSession,
  parseEduPageSession,
};

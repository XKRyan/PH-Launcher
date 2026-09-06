// SPDX-License-Identifier: GPL-3.0-or-later
// Derived in part from Hello Pinghe's MailService (hellopinghe/app/services.py),
// copyright Hello Pinghe contributors, GPL-3.0-or-later:
// https://github.com/huaziqian40-bot/Hello-Pinghe-Launcher @ 19683149ad5572464d332fbe121c78a2ee5ba359
// Reworked as a bounded native Node client for PH Launcher.

'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { extractMailLinks } = require('./mail-links.cjs');

const IMAP_HOST = 'imap.qiye.163.com';
const IMAP_PORT = 993;
const SMTP_HOST = 'smtp.qiye.163.com';
const SMTP_PORT = 994;

const MAX_LIST_LIMIT = 100;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_RAW_MESSAGE_BYTES = 48 * 1024 * 1024;
const MAX_RECIPIENTS = 30;
const MAX_SEND_ATTACHMENTS = 20;
const MAX_PREPARED_DRAFTS = 32;
const PREPARED_DRAFT_TTL_MS = 10 * 60 * 1000;

class MailClientError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailClientError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new MailClientError(code, message);
}

function classifyImapConnectionError(error) {
  const fields = [
    error?.code,
    error?.responseCode,
    error?.responseStatus,
    error?.responseText,
    error?.serverResponseCode,
    error?.message,
  ];
  const signal = fields
    .filter((value) => typeof value === 'string' || typeof value === 'number')
    .map((value) => String(value).slice(0, 2048))
    .join(' ');
  if (/ERR\.LOGIN\.REQCODE/i.test(signal)) {
    return new MailClientError(
      'AUTH_CODE_REQUIRED',
      '邮箱服务器要求客户端授权码。请登录学校邮箱网页版，进入“设置 → 客户端设置”，开启 IMAP/SMTP 并生成授权码，然后填入启动器。',
    );
  }
  if (/ERR\.ILLEGAL\.EMAIL/i.test(signal)) {
    return new MailClientError(
      'IMAP_DISABLED',
      '该邮箱账号尚未开通 IMAP 客户端服务。请在学校邮箱网页版“设置 → 客户端设置”中开启；若没有此选项，请联系学校管理员。',
    );
  }
  return new MailClientError('IMAP_CONNECTION_FAILED', '邮箱连接失败，请检查网络、客户端授权码及 IMAP 服务设置');
}

function utf8Size(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function cleanInline(value, maxLength = 200) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function cleanBody(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .trim();
}

function cleanFilename(value, fallback) {
  const cleaned = cleanInline(value, 200)
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/^\.+$/, '')
    .trim();
  return cleaned || fallback;
}

function safeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function assertHeader(value, label, maxLength) {
  if (typeof value !== 'string') fail('INVALID_DRAFT', `${label}格式不正确`);
  if (/[\r\n\u0000]/.test(value)) fail('INVALID_DRAFT', `${label}不能包含换行或控制字符`);
  if (value.length > maxLength) fail('INVALID_DRAFT', `${label}过长`);
  return value.trim();
}

function isValidEmail(value) {
  if (typeof value !== 'string' || value.length > 320 || /[\s\u0000-\u001f\u007f]/.test(value)) return false;
  const at = value.lastIndexOf('@');
  if (at < 1 || at > 64 || at === value.length - 1) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (domain.length > 255 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return false;
  if (!/^[A-Za-z0-9.-]+$/.test(domain) || domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;
  return domain.split('.').every((label) => label && label.length <= 63 && !label.startsWith('-') && !label.endsWith('-'));
}

function flattenAddressValue(value, out = []) {
  if (!value) return out;
  if (Array.isArray(value)) {
    for (const entry of value) flattenAddressValue(entry, out);
    return out;
  }
  if (value.value && Array.isArray(value.value)) return flattenAddressValue(value.value, out);
  if (value.group && Array.isArray(value.group)) return flattenAddressValue(value.group, out);
  const address = cleanInline(value.address || '', 320).toLowerCase();
  if (isValidEmail(address)) out.push({ name: cleanInline(value.name || '', 120), address });
  return out;
}

function uniqueAddresses(values, limit = 100) {
  const seen = new Set();
  const out = [];
  for (const entry of flattenAddressValue(values)) {
    if (seen.has(entry.address)) continue;
    seen.add(entry.address);
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

function parseRecipientString(value) {
  const raw = assertHeader(value, '收件人', 500);
  const match = raw.match(/^\s*(.*?)\s*<\s*([^<>]+)\s*>\s*$/);
  const address = (match ? match[2] : raw).trim().toLowerCase();
  const name = match ? match[1].trim().replace(/^(["'])(.*)\1$/, '$2') : '';
  if (!isValidEmail(address)) fail('INVALID_DRAFT', `邮箱地址不合法: ${cleanInline(address, 80)}`);
  if (name) assertHeader(name, '收件人姓名', 120);
  return { name, address };
}

function normalizeRecipient(value) {
  if (typeof value === 'string') return parseRecipientString(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_DRAFT', '收件人格式不正确');
  const address = assertHeader(String(value.address || value.email || ''), '邮箱地址', 320).toLowerCase();
  const name = assertHeader(String(value.name || ''), '收件人姓名', 120);
  if (!isValidEmail(address)) fail('INVALID_DRAFT', `邮箱地址不合法: ${cleanInline(address, 80)}`);
  return { name, address };
}

function normalizeRecipientField(value) {
  if (value == null || value === '') return [];
  let values = Array.isArray(value) ? value : [value];
  if (typeof value === 'string' && /[,;]/.test(value)) values = value.split(/[,;]/).filter((part) => part.trim());
  return values.map(normalizeRecipient);
}

function dedupeRecipientFields(fields) {
  const seen = new Set();
  for (const key of ['to', 'cc', 'bcc']) {
    fields[key] = fields[key].filter((entry) => {
      if (seen.has(entry.address)) return false;
      seen.add(entry.address);
      return true;
    });
  }
  return fields;
}

function htmlToPlainText(html) {
  if (!html) return '';
  const source = Buffer.isBuffer(html) ? html.toString('utf8') : String(html);
  if (utf8Size(source) > MAX_BODY_BYTES) fail('MESSAGE_TOO_LARGE', '邮件正文超过 10 MiB 限制');
  let document;
  try {
    const markup = /<(?:html|body)\b/i.test(source) ? source : `<html><body>${source}</body></html>`;
    ({ document } = require('linkedom').parseHTML(markup));
  } catch {
    fail('PARSE_FAILED', '邮件 HTML 正文无法安全解析');
  }
  for (const node of document.querySelectorAll('script,style,noscript,img,picture,source,svg,iframe,frame,object,embed,link,meta')) {
    node.remove();
  }
  for (const br of document.querySelectorAll('br')) br.replaceWith(document.createTextNode('\n'));
  for (const block of document.querySelectorAll('p,div,section,article,header,footer,h1,h2,h3,h4,h5,h6,li,tr,blockquote,pre')) {
    block.append(document.createTextNode('\n'));
  }
  return cleanBody(document.body ? document.body.textContent : document.textContent);
}

function attachmentId(uid, index, attachment) {
  const signature = [uid, index, attachment.filename || '', attachment.size || 0, attachment.checksum || ''].join('\0');
  return `attachment-${index}-${createHash('sha256').update(signature).digest('hex').slice(0, 16)}`;
}

function messageAttachments(uid, parsed) {
  return (Array.isArray(parsed.attachments) ? parsed.attachments : []).map((attachment, index) => {
    const content = Buffer.isBuffer(attachment.content) ? attachment.content : Buffer.from(attachment.content || []);
    const size = Number.isSafeInteger(attachment.size) && attachment.size >= 0 ? attachment.size : content.length;
    return {
      id: attachmentId(uid, index, { ...attachment, size }),
      name: cleanFilename(attachment.filename, `附件-${index + 1}`),
      size,
      _content: content,
    };
  });
}

function hasMimeAttachment(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 20) return false;
  if (String(node.disposition || '').toLowerCase() === 'attachment' || node.dispositionParameters?.filename || node.parameters?.name) return true;
  return Array.isArray(node.childNodes) && node.childNodes.slice(0, 100).some((child) => hasMimeAttachment(child, depth + 1));
}

function formatAddress(entry) {
  return entry.name ? `${entry.name} <${entry.address}>` : entry.address;
}

function safeResultAddresses(value, allowed) {
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  const out = [];
  for (const entry of entries) {
    const raw = typeof entry === 'string' ? entry.trim() : String(entry?.address || '').trim();
    const bracketed = raw.match(/<\s*([^<>]+)\s*>\s*$/);
    const address = (bracketed ? bracketed[1] : raw).toLowerCase();
    if (allowed.has(address) && !out.includes(address)) out.push(address);
  }
  return out;
}

function preparedDigest(prepared) {
  const attachmentDigests = prepared.attachments.map((entry) => ({
    filename: entry.filename,
    contentType: entry.contentType,
    sha256: createHash('sha256').update(entry.content).digest('hex'),
  }));
  return createHash('sha256').update(JSON.stringify({
    to: prepared.to,
    cc: prepared.cc,
    bcc: prepared.bcc,
    subject: prepared.subject,
    text: prepared.text,
    attachments: attachmentDigests,
  })).digest('hex');
}

function defaultImapFactory(options) {
  const { ImapFlow } = require('imapflow');
  return new ImapFlow(options);
}

function defaultSmtpFactory(options) {
  return require('nodemailer').createTransport(options);
}

function defaultParseMail(source) {
  return require('mailparser').simpleParser(source, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipTextLinks: true,
    skipImageLinks: true,
    keepCidLinks: true,
    maxHtmlLengthToParse: MAX_BODY_BYTES,
    checksumAlgo: 'sha256',
  });
}

class SchoolMailClient {
  constructor(options = {}) {
    if (typeof options.getCredential !== 'function') throw new TypeError('SchoolMailClient requires getCredential()');
    const transport = options.transport || {};
    this._getCredential = options.getCredential;
    this._imapFactory = options.imapFactory || transport.imapFactory || defaultImapFactory;
    this._smtpFactory = options.smtpFactory || transport.smtpFactory || defaultSmtpFactory;
    this._parseMail = options.parseMail || transport.parseMail || defaultParseMail;
    this._now = typeof options.now === 'function' ? options.now : Date.now;
    this._epoch = 0;
    this._identityKey = null;
    this._username = null;
    this._session = null;
    this._sessionPromise = null;
    this._connectingClient = null;
    this._contacts = new Map();
    this._harvestedMessages = new Set();
    this._preparedDrafts = new Map();
    this._identityGate = Promise.resolve();
  }

  async _serializedIdentity(work) {
    const previous = this._identityGate;
    let release;
    this._identityGate = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  async _readCredential() {
    let value;
    try {
      value = await this._getCredential();
    } catch {
      fail('CREDENTIAL_UNAVAILABLE', '无法读取邮箱凭据');
    }
    const username = typeof value?.username === 'string' ? value.username.trim().toLowerCase() : '';
    const password = typeof value?.password === 'string' ? value.password : '';
    if (!isValidEmail(username) || !password || /[\r\n\u0000]/.test(username)) {
      fail('LOGIN_REQUIRED', '请先配置有效的学校邮箱和客户端授权码');
    }
    const key = createHash('sha256').update(username).update('\0').update(password).digest('hex');
    return { username, password, key };
  }

  _closeClient(client) {
    if (!client) return;
    try {
      if (typeof client.close === 'function') client.close();
      else if (typeof client.logout === 'function') void Promise.resolve(client.logout()).catch(() => {});
    } catch {
      // Invalidation is best effort; never surface protocol text that may contain auth data.
    }
  }

  _replaceIdentity(key, username) {
    this._epoch += 1;
    const old = this._session?.client;
    const connecting = this._connectingClient;
    this._session = null;
    this._sessionPromise = null;
    this._connectingClient = null;
    this._identityKey = key;
    this._username = username;
    this._contacts.clear();
    this._harvestedMessages.clear();
    this._preparedDrafts.clear();
    this._closeClient(old);
    if (connecting !== old) this._closeClient(connecting);
  }

  async _identity() {
    return this._serializedIdentity(async () => {
      const credential = await this._readCredential();
      if (credential.key !== this._identityKey) this._replaceIdentity(credential.key, credential.username);
      return { ...credential, epoch: this._epoch };
    });
  }

  async _imapSession() {
    return this._serializedIdentity(async () => {
      const credential = await this._readCredential();
      if (credential.key !== this._identityKey) this._replaceIdentity(credential.key, credential.username);
      if (this._session && this._session.client && this._session.client.usable !== false) {
        return { ...this._session, password: credential.password };
      }
      if (this._sessionPromise) return this._sessionPromise;

      const epoch = this._epoch;
      const key = credential.key;
      const pending = (async () => {
        let client;
        try {
          client = this._imapFactory({
            host: IMAP_HOST,
            port: IMAP_PORT,
            secure: true,
            servername: IMAP_HOST,
            auth: { user: credential.username, pass: credential.password },
            logger: false,
            emitLogs: false,
            logRaw: false,
            tls: { rejectUnauthorized: true, servername: IMAP_HOST },
            connectionTimeout: 15_000,
            greetingTimeout: 15_000,
            socketTimeout: 30_000,
          });
          if (epoch === this._epoch && key === this._identityKey) this._connectingClient = client;
          if (!client || typeof client.connect !== 'function') throw new TypeError('invalid IMAP transport');
          if (typeof client.on === 'function') client.on('error', () => {});
          await client.connect();
          if (epoch !== this._epoch || key !== this._identityKey) {
            this._closeClient(client);
            fail('STALE_SESSION', '邮箱账号已切换，旧请求已取消');
          }
          const session = { client, epoch, key, username: credential.username };
          if (this._connectingClient === client) this._connectingClient = null;
          this._session = session;
          if (typeof client.on === 'function') {
            client.on('close', () => {
              if (this._session?.client === client) this._session = null;
            });
          }
          return { ...session, password: credential.password };
        } catch (error) {
          if (this._connectingClient === client) this._connectingClient = null;
          this._closeClient(client);
          if (error instanceof MailClientError) throw error;
          throw classifyImapConnectionError(error);
        }
      })();
      this._sessionPromise = pending;
      try {
        return await pending;
      } finally {
        if (this._sessionPromise === pending) this._sessionPromise = null;
      }
    });
  }

  _assertCurrent(context) {
    if (context.epoch !== this._epoch || context.key !== this._identityKey) {
      fail('STALE_SESSION', '邮箱账号已切换，旧请求已取消');
    }
  }

  _discardSession(client) {
    if (this._session?.client === client) this._session = null;
    this._closeClient(client);
  }

  async _withInbox(work) {
    const context = await this._imapSession();
    let lock;
    try {
      lock = await context.client.getMailboxLock('INBOX', { readOnly: true, description: 'PH Launcher native mail' });
      this._assertCurrent(context);
      const result = await work(context.client, context);
      this._assertCurrent(context);
      return result;
    } catch (error) {
      if (error instanceof MailClientError) throw error;
      this._discardSession(context.client);
      fail('IMAP_REQUEST_FAILED', '邮箱请求失败，请稍后重新打开邮箱');
    } finally {
      try { lock?.release(); } catch { /* no-op */ }
    }
  }

  _harvest(id, addressFields, context) {
    this._assertCurrent(context);
    const messageKey = String(id);
    if (this._harvestedMessages.has(messageKey)) return;
    const perMessage = new Map();
    for (const entry of uniqueAddresses(addressFields)) {
      if (entry.address === context.username || /(?:^|[._-])(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce|notification|system)(?:[._@+-]|$)/i.test(entry.address)) continue;
      const previous = perMessage.get(entry.address);
      if (!previous || (!previous.name && entry.name)) perMessage.set(entry.address, entry);
    }
    for (const entry of perMessage.values()) {
      const current = this._contacts.get(entry.address) || { name: '', address: entry.address, count: 0 };
      current.count += 1;
      if (entry.name && !current.name) current.name = entry.name;
      this._contacts.set(entry.address, current);
    }
    this._harvestedMessages.add(messageKey);
  }

  async list({ unread = false, limit = 30, query = '', cursor = 0 } = {}) {
    if (typeof unread !== 'boolean') fail('INVALID_ARGUMENT', 'unread 必须是布尔值');
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      fail('INVALID_ARGUMENT', `limit 必须是 1 到 ${MAX_LIST_LIMIT} 的整数`);
    }
    if (typeof query !== 'string' || query.length > 80 || /[\u0000-\u001f\u007f]/.test(query) || !Number.isInteger(cursor) || cursor < 0 || cursor > 100_000) fail('INVALID_ARGUMENT', '邮件搜索条件无效');
    query = query.trim();
    return this._withInbox(async (client, context) => {
      const search = query ? { or: [{ subject: query }, { body: query }], ...(unread ? { seen: false } : {}) } : unread ? { seen: false } : { all: true };
      const result = await client.search(search, { uid: true });
      const allUids = Array.isArray(result) ? result : [];
      const selected = allUids.slice().reverse().slice(cursor, cursor + limit);
      const pagination = { total: allUids.length, cursor, nextCursor: cursor + selected.length < allUids.length ? cursor + selected.length : null };
      if (!selected.length) return { items: [], unreadOnly: unread, ...pagination };
      const messages = await client.fetchAll(selected, { uid: true, envelope: true, flags: true, size: true, bodyStructure: true }, { uid: true });
      this._assertCurrent(context);
      const byUid = new Map((Array.isArray(messages) ? messages : []).map((message) => [String(message.uid), message]));
      const out = [];
      for (const uid of selected) {
        const message = byUid.get(String(uid));
        if (!message) continue;
        const envelope = message.envelope || {};
        const from = uniqueAddresses(envelope.from);
        const to = uniqueAddresses(envelope.to);
        const cc = uniqueAddresses(envelope.cc);
        this._harvest(uid, [from, to, cc], context);
        const flags = message.flags instanceof Set ? message.flags : new Set(Array.isArray(message.flags) ? message.flags : []);
        out.push({
          uid: String(uid),
          from,
          date: safeDate(envelope.date || message.internalDate),
          subject: cleanInline(envelope.subject || '(无主题)', 200) || '(无主题)',
          unread: !flags.has('\\Seen'),
          hasAttachments: hasMimeAttachment(message.bodyStructure),
          size: Number.isSafeInteger(message.size) && message.size >= 0 ? Math.min(message.size, MAX_RAW_MESSAGE_BYTES + 1) : null,
        });
      }
      return { items: out, unreadOnly: unread, ...pagination };
    });
  }

  async _parsedMessage(uid) {
    const normalizedUid = String(uid ?? '');
    if (!/^[1-9]\d{0,9}$/.test(normalizedUid)) fail('INVALID_ARGUMENT', '邮件 id 不合法');
    return this._withInbox(async (client, context) => {
      const message = await client.fetchOne(normalizedUid, {
        size: true,
        source: { start: 0, maxLength: MAX_RAW_MESSAGE_BYTES + 1 },
      }, { uid: true });
      if (!message || !message.source) fail('NOT_FOUND', '邮件不存在或已被移动');
      const source = Buffer.isBuffer(message.source) ? message.source : Buffer.from(message.source);
      if ((Number.isFinite(message.size) && message.size > MAX_RAW_MESSAGE_BYTES) || source.length > MAX_RAW_MESSAGE_BYTES) {
        fail('MESSAGE_TOO_LARGE', '邮件整体超过安全读取限制');
      }
      let parsed;
      try {
        parsed = await this._parseMail(source);
      } catch (error) {
        if (error instanceof MailClientError) throw error;
        fail('PARSE_FAILED', '邮件内容无法解析');
      }
      this._assertCurrent(context);
      return { parsed: parsed || {}, context, uid: normalizedUid };
    });
  }

  async read(uid) {
    const { parsed, context, uid: normalizedUid } = await this._parsedMessage(uid);
    const from = uniqueAddresses(parsed.from);
    const to = uniqueAddresses(parsed.to);
    const cc = uniqueAddresses(parsed.cc);
    this._harvest(normalizedUid, [from, to, cc], context);
    let text = parsed.text ? cleanBody(parsed.text) : htmlToPlainText(parsed.html);
    if (utf8Size(text) > MAX_BODY_BYTES) fail('MESSAGE_TOO_LARGE', '邮件正文超过 10 MiB 限制');
    text = text.replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n');
    const links = extractMailLinks(normalizedUid, parsed);
    const attachments = messageAttachments(normalizedUid, parsed);
    const contactCandidates = uniqueAddresses([from, to, cc]).filter((entry) => entry.address !== context.username);
    return {
      uid: normalizedUid,
      from,
      to,
      cc,
      date: safeDate(parsed.date),
      subject: cleanInline(parsed.subject || '(无主题)', 500) || '(无主题)',
      text,
      links: links.map(({ id, label, host }) => ({ id, label, host })),
      attachments: attachments.map(({ id, name, size }) => ({ id, name, size })),
      contactCandidates,
    };
  }

  async attachment(uid, id) {
    const wanted = String(id ?? '');
    if (!/^attachment-\d+-[a-f0-9]{16}$/.test(wanted)) fail('INVALID_ARGUMENT', '附件 id 不合法');
    const { parsed, uid: normalizedUid } = await this._parsedMessage(uid);
    const match = messageAttachments(normalizedUid, parsed).find((entry) => entry.id === wanted);
    if (!match) fail('NOT_FOUND', '附件不存在');
    if (match.size > MAX_ATTACHMENT_BYTES || match._content.length > MAX_ATTACHMENT_BYTES) {
      fail('ATTACHMENT_TOO_LARGE', '附件超过 20 MiB 限制');
    }
    return Buffer.from(match._content);
  }

  async link(uid, id) {
    if (typeof id !== 'string' || !/^link-[a-f0-9]{24}$/.test(id)) fail('INVALID_ARGUMENT', '邮件链接 id 不合法');
    const { parsed, context, uid: normalizedUid } = await this._parsedMessage(uid);
    const match = extractMailLinks(normalizedUid, parsed).find((entry) => entry.id === id);
    this._assertCurrent(context);
    if (!match) fail('NOT_FOUND', '链接不存在或邮件内容已变化，请重新打开邮件');
    return { ...match };
  }

  async contacts({ query = '', limit = 100 } = {}) {
    if (typeof query !== 'string' || query.length > 200) fail('INVALID_ARGUMENT', '联系人搜索词不合法');
    if (!Number.isInteger(limit) || limit < 1 || limit > 300) fail('INVALID_ARGUMENT', '联系人 limit 必须是 1 到 300 的整数');
    const context = await this._identity();
    this._assertCurrent(context);
    const needle = cleanInline(query, 200).toLowerCase();
    return [...this._contacts.values()]
      .filter((entry) => !needle || `${entry.name} ${entry.address}`.toLowerCase().includes(needle))
      .sort((a, b) => b.count - a.count || a.address.localeCompare(b.address))
      .slice(0, limit)
      .map((entry) => ({ name: entry.name, address: entry.address }));
  }

  _normalizeDraft(draft) {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) fail('INVALID_DRAFT', '邮件草稿格式不正确');
    const recipients = dedupeRecipientFields({
      to: normalizeRecipientField(draft.to),
      cc: normalizeRecipientField(draft.cc),
      bcc: normalizeRecipientField(draft.bcc),
    });
    const recipientCount = recipients.to.length + recipients.cc.length + recipients.bcc.length;
    if (!recipientCount) fail('INVALID_DRAFT', '至少需要一个收件人');
    if (recipientCount > MAX_RECIPIENTS) fail('INVALID_DRAFT', `收件人总数不能超过 ${MAX_RECIPIENTS}`);
    const subject = assertHeader(String(draft.subject ?? ''), '主题', 500);
    const textValue = draft.text ?? draft.body;
    if (typeof textValue !== 'string') fail('INVALID_DRAFT', '正文必须是纯文本');
    if (Object.hasOwn(draft, 'html') && draft.html) fail('INVALID_DRAFT', '仅支持纯文本正文');
    const text = cleanBody(textValue);
    if (utf8Size(text) > MAX_BODY_BYTES) fail('INVALID_DRAFT', '正文超过 10 MiB 限制');

    const rawAttachments = draft.attachments == null ? [] : draft.attachments;
    if (!Array.isArray(rawAttachments) || rawAttachments.length > MAX_SEND_ATTACHMENTS) {
      fail('INVALID_DRAFT', `附件必须是数组且不能超过 ${MAX_SEND_ATTACHMENTS} 个`);
    }
    let totalBytes = 0;
    const attachments = rawAttachments.map((attachment, index) => {
      if (!attachment || typeof attachment !== 'object' || attachment.path || attachment.href || attachment.url) {
        fail('INVALID_DRAFT', '附件只能使用本地已读取的字节，不能传入路径或网址');
      }
      const original = attachment.bytes ?? attachment.content;
      if (!Buffer.isBuffer(original) && !(original instanceof Uint8Array)) fail('INVALID_DRAFT', '附件内容必须是 Buffer 或 Uint8Array');
      const content = Buffer.from(original);
      totalBytes += content.length;
      if (content.length > MAX_ATTACHMENT_BYTES || totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
        fail('INVALID_DRAFT', '附件总大小不能超过 20 MiB');
      }
      const filename = cleanFilename(attachment.name || attachment.filename, `附件-${index + 1}`);
      const contentTypeRaw = String(attachment.type || attachment.contentType || 'application/octet-stream');
      const contentType = assertHeader(contentTypeRaw, '附件类型', 120).toLowerCase();
      if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(contentType)) fail('INVALID_DRAFT', '附件类型不合法');
      return { filename, content, contentType };
    });
    return {
      ...recipients,
      subject,
      text,
      attachments,
      confirmation: {
        recipients: [...recipients.to, ...recipients.cc, ...recipients.bcc].map(formatAddress),
        subject: subject || '(无主题)',
        bodyBytes: utf8Size(text),
        attachments: attachments.map((entry) => ({ name: entry.filename, size: entry.content.length })),
      },
    };
  }

  async prepareSend(draft) {
    const prepared = this._normalizeDraft(draft);
    const context = await this._identity();
    this._assertCurrent(context);
    this._prunePreparedDrafts();
    while (this._preparedDrafts.size >= MAX_PREPARED_DRAFTS) {
      this._preparedDrafts.delete(this._preparedDrafts.keys().next().value);
    }
    const generation = randomUUID();
    this._preparedDrafts.set(generation, {
      epoch: context.epoch,
      key: context.key,
      digest: preparedDigest(prepared),
      expiresAt: this._now() + PREPARED_DRAFT_TTL_MS,
    });
    return { ...prepared, _generation: generation };
  }

  _prunePreparedDrafts() {
    const now = this._now();
    for (const [generation, entry] of this._preparedDrafts) {
      if (entry.expiresAt <= now) this._preparedDrafts.delete(generation);
    }
  }

  cancelPreparedSend(draftOrGeneration) {
    const generation = typeof draftOrGeneration === 'string'
      ? draftOrGeneration
      : typeof draftOrGeneration?._generation === 'string' ? draftOrGeneration._generation : '';
    return generation ? this._preparedDrafts.delete(generation) : false;
  }

  async send(draft) {
    const context = await this._identity();
    this._prunePreparedDrafts();
    const generation = typeof draft?._generation === 'string' ? draft._generation : '';
    const authorization = this._preparedDrafts.get(generation);
    if (!authorization || authorization.epoch !== context.epoch || authorization.key !== context.key) {
      fail('STALE_DRAFT', '草稿未经确认或确认后账号已切换，请重新确认后发送');
    }
    const prepared = this._normalizeDraft(draft);
    if (preparedDigest(prepared) !== authorization.digest) {
      this._preparedDrafts.delete(generation);
      fail('STALE_DRAFT', '草稿在确认后发生变化，请重新确认后发送');
    }
    // Consume before touching SMTP: a timeout has unknown delivery state and must never
    // make the same confirmed draft retryable without another explicit confirmation.
    this._preparedDrafts.delete(generation);
    let smtp;
    let attempted = false;
    try {
      smtp = this._smtpFactory({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: true,
        name: 'ph-launcher.local',
        auth: { user: context.username, pass: context.password },
        logger: false,
        debug: false,
        pool: false,
        disableFileAccess: true,
        disableUrlAccess: true,
        tls: { rejectUnauthorized: true, servername: SMTP_HOST },
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
      });
      if (!smtp || typeof smtp.sendMail !== 'function') throw new TypeError('invalid SMTP transport');
      this._assertCurrent(context);
      attempted = true;
      const info = await smtp.sendMail({
        from: context.username,
        to: prepared.to.map(formatAddress),
        cc: prepared.cc.map(formatAddress),
        bcc: prepared.bcc.map(formatAddress),
        subject: prepared.subject,
        text: prepared.text,
        attachments: prepared.attachments,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      this._assertCurrent(context);
      const all = new Set([...prepared.to, ...prepared.cc, ...prepared.bcc].map((entry) => entry.address));
      return {
        messageId: cleanInline(info?.messageId || '', 200) || null,
        accepted: safeResultAddresses(info?.accepted, all),
        rejected: safeResultAddresses(info?.rejected, all),
      };
    } catch (error) {
      if (error instanceof MailClientError && !(attempted && error.code === 'STALE_SESSION')) throw error;
      fail('SEND_FAILED', '发送结果不确定，请先查已发送，不要重复点击');
    } finally {
      try { smtp?.close?.(); } catch { /* no-op */ }
    }
  }

  async invalidate() {
    this._epoch += 1;
    const old = this._session?.client;
    const connecting = this._connectingClient;
    this._identityKey = null;
    this._username = null;
    this._session = null;
    this._sessionPromise = null;
    this._connectingClient = null;
    this._contacts.clear();
    this._harvestedMessages.clear();
    this._preparedDrafts.clear();
    this._closeClient(old);
    if (connecting !== old) this._closeClient(connecting);
  }
}

module.exports = {
  SchoolMailClient,
  MailClientError,
  IMAP_HOST,
  IMAP_PORT,
  SMTP_HOST,
  SMTP_PORT,
  MAX_LIST_LIMIT,
  MAX_BODY_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  MAX_RAW_MESSAGE_BYTES,
  MAX_RECIPIENTS,
  MAX_PREPARED_DRAFTS,
  PREPARED_DRAFT_TTL_MS,
};

'use strict';

const MAX_LIST = 20;
const MAX_CONTACTS = 10;
const MAX_BODY = 6_000;
const MAX_QUERY = 80;
const SENSITIVE_MAIL = /(?:密码|password|验证码|verification\s*code|one[-\s]?time|登录|login|sign[-\s]?in|安全(?:通知|提醒)?|security|重置|reset|恢复账户|account\s*(?:recovery|security))/i;
const CREDENTIAL_LINE = /(?:密码|password|验证码|verification\s*code|one[-\s]?time\s*(?:pass)?code|otp|token|授权码|api\s*key|cookie|登录链接|sign[-\s]?in)/i;

function cleanInline(value, limit) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function safeHeader(value, limit) {
  return cleanInline(value, limit)
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi, '[已隐藏链接]')
    .replace(/\b(?:token|code|otp|password|验证码|授权码)\s*[:=]\s*[^\s<>"'`]+/gi, '[已隐藏敏感信息]')
    .slice(0, limit);
}

function asInteger(value, fallback, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? Math.min(number, maximum) : fallback;
}

function cleanAddresses(values, limit = 3) {
  return (Array.isArray(values) ? values : []).slice(0, limit).map((entry) => ({
    name: safeHeader(entry?.name, 80),
    address: cleanInline(entry?.address, 160).toLowerCase(),
  })).filter((entry) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(entry.address));
}

function sensitiveSubject(subject) {
  return SENSITIVE_MAIL.test(String(subject || ''));
}

function safeSubject(subject) {
  return sensitiveSubject(subject) ? '敏感账号通知（请在邮箱中自行查看）' : safeHeader(subject || '(无主题)', 180) || '(无主题)';
}

function safeBody(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const cleaned = lines.map((line) => {
    if (CREDENTIAL_LINE.test(line)) return '[已隐藏可能包含账号或验证码的信息]';
    return line
      .replace(/\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi, '[已隐藏链接]')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return cleaned.slice(0, MAX_BODY);
}

function sanitizeMailToolArguments(name, input) {
  const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (name === 'list_mail') return { unread: args.unread === true, limit: asInteger(args.limit, 10, MAX_LIST), query: cleanInline(args.query, MAX_QUERY), cursor: Number.isInteger(args.cursor) && args.cursor >= 0 ? Math.min(args.cursor, 100_000) : 0 };
  if (name === 'read_mail') {
    const uid = String(args.uid || '');
    if (!/^[1-9]\d{0,9}$/.test(uid)) throw new Error('邮件 id 无效');
    return { uid };
  }
  if (name === 'search_mail_contacts') return { query: cleanInline(args.query, MAX_QUERY), limit: asInteger(args.limit, 6, MAX_CONTACTS) };
  throw new Error('AI 请求了未授权的邮件操作');
}

function createAiMailReader({ getClient, getRevision, assertAllowed }) {
  if (typeof getClient !== 'function' || typeof getRevision !== 'function' || typeof assertAllowed !== 'function') {
    throw new TypeError('AI mail reader requires guarded mail dependencies');
  }
  async function withCurrent(work) {
    assertAllowed();
    const revision = getRevision();
    const result = await work(getClient());
    assertAllowed();
    if (revision !== getRevision()) throw new Error('邮箱账号已变更，未返回邮件内容');
    return result;
  }
  return {
    async execute(name, input) {
      const args = sanitizeMailToolArguments(name, input);
      if (name === 'list_mail') {
        const listed = await withCurrent((client) => client.list(args));
        return {
          unreadOnly: Boolean(listed?.unreadOnly),
          ...(Number.isInteger(listed?.total) ? { total: listed.total, nextCursor: listed.nextCursor ?? null } : {}),
          items: (listed?.items || []).slice(0, MAX_LIST).map((item) => ({
            uid: String(item?.uid || ''),
            from: cleanAddresses(item?.from),
            date: cleanInline(item?.date, 40),
            subject: safeSubject(item?.subject),
            unread: Boolean(item?.unread),
          })).filter((item) => /^[1-9]\d{0,9}$/.test(item.uid)),
        };
      }
      if (name === 'read_mail') {
        const mail = await withCurrent((client) => client.read(args.uid));
        if (sensitiveSubject(mail?.subject)) {
          return { uid: args.uid, restricted: true, notice: '此邮件可能包含登录、验证码或密码重置信息。请在邮箱中自行查看。' };
        }
        return {
          uid: args.uid,
          from: cleanAddresses(mail?.from),
          to: cleanAddresses(mail?.to),
          date: cleanInline(mail?.date, 40),
          subject: safeSubject(mail?.subject),
          text: safeBody(mail?.text),
        };
      }
      if (name === 'search_mail_contacts') {
        const contacts = await withCurrent((client) => client.contacts(args));
        return (contacts || []).slice(0, MAX_CONTACTS).map((entry) => ({
          name: safeHeader(entry?.name, 80),
          address: cleanInline(entry?.address, 160).toLowerCase(),
        })).filter((entry) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(entry.address));
      }
      throw new Error('AI 请求了未授权的邮件操作');
    },
  };
}

module.exports = { createAiMailReader, sanitizeMailToolArguments, safeBody, safeSubject, MAX_LIST, MAX_CONTACTS, MAX_BODY };

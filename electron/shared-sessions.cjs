'use strict';
// `data/agent/<session-id>.json` — the AI transcripts Pinghe Launcher Lite and
// PH Launcher share (see docs/data-format.md §4).
//
// One session per file, OpenAI chat-message shape. This app writes its own
// transcripts there and lists everything it finds, but it only deletes a shared
// file while its content still matches the copy in the encrypted store: a
// transcript the other application has changed since is left alone.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const APP_NAME = 'PH Launcher';
const SHARED_KIND = 'phl-agent-session';
const MAX_SESSIONS = 60;
const MAX_MESSAGES = 120;
const MAX_CONTENT_LENGTH = 16_000;
const MAX_TITLE_LENGTH = 100;
const MAX_FILE_BYTES = 512 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

function validId(value) {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : '';
}
function cleanTitle(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TITLE_LENGTH) : '';
}
/** Keeps only the roles this app can render and continue; tool traffic is dropped. */
function sharedHistory(messages) {
  const result = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    if (!['user', 'assistant'].includes(message.role)) continue;
    if (typeof message.content !== 'string') continue;
    const content = message.content.slice(0, MAX_CONTENT_LENGTH);
    if (!content.trim()) continue;
    result.push({ role: message.role, content });
    if (result.length >= MAX_MESSAGES) break;
  }
  return result;
}
function sessionPath(directory, id) {
  const safe = validId(id);
  if (!safe) throw new Error('会话 ID 无效，不能写入共用记录');
  const target = path.join(directory, `${safe}.json`);
  if (path.dirname(path.resolve(target)) !== path.resolve(directory)) throw new Error('会话路径无效');
  return target;
}
function sameContent(a, b) {
  const history = (value) => sharedHistory(value?.history ?? value?.messages);
  return cleanTitle(a?.title) === cleanTitle(b?.title) && JSON.stringify(history(a)) === JSON.stringify(history(b));
}

function readSharedSession(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const id = validId(parsed.id) || validId(path.basename(filePath, '.json'));
    const history = sharedHistory(parsed.history);
    if (!id || !history.length) return null;
    return { id, title: cleanTitle(parsed.title), history, app: typeof parsed.app === 'string' ? parsed.app.slice(0, 60) : '', updatedAt: new Date(stat.mtimeMs).toISOString() };
  } catch { return null; }
}

/** Every readable transcript in the shared folder, newest first. */
function listSharedSessions(directory, { limit = MAX_SESSIONS } = {}) {
  let names;
  try { names = fs.readdirSync(directory); } catch { return []; }
  const found = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
    const session = readSharedSession(path.join(directory, name));
    if (session) found.push(session);
    if (found.length >= limit * 2) break;
  }
  found.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return found.slice(0, limit);
}

/** Writes this app's own copy of a transcript. Foreign metadata is preserved. */
function writeSharedSession(directory, session, { now = () => new Date() } = {}) {
  const id = validId(session?.id);
  if (!id) throw new Error('会话 ID 无效，不能写入共用记录');
  const history = sharedHistory(session.messages ?? session.history);
  if (!history.length) throw new Error('会话没有可共用的消息');
  const target = sessionPath(directory, id);
  const previous = readSharedSession(target);
  const payload = {
    version: 1,
    kind: SHARED_KIND,
    id,
    title: cleanTitle(session.title),
    app: APP_NAME,
    updated_at: now().toISOString(),
    history,
  };
  // Never overwrite a transcript the other application rewrote with more context.
  if (previous && previous.app && previous.app !== APP_NAME && previous.history.length > history.length) {
    return { ok: false, reason: 'foreign-newer', path: target };
  }
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${id}.${randomUUID()}.tmp`);
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, target);
  return { ok: true, path: target, session: payload };
}

/** Deletes only a transcript this app still owns byte-for-byte (title + history). */
function removeSharedSession(directory, session) {
  const id = validId(session?.id);
  if (!id) return { removed: false, reason: 'invalid-id' };
  const target = sessionPath(directory, id);
  const current = readSharedSession(target);
  if (!current) return { removed: false, reason: 'absent' };
  if (!sameContent(current, session)) return { removed: false, reason: 'foreign-modified' };
  try {
    fs.unlinkSync(target);
    return { removed: true, reason: '' };
  } catch { return { removed: false, reason: 'unlink-failed' }; }
}

module.exports = {
  APP_NAME,
  MAX_SESSIONS,
  SHARED_KIND,
  listSharedSessions,
  readSharedSession,
  removeSharedSession,
  sessionPath,
  sharedHistory,
  writeSharedSession,
};

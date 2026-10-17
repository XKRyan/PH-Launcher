'use strict';
// The AI transcripts in `data/agent/` are shared with Pinghe Launcher Lite: this
// app writes its own sessions there, lists foreign ones read-only, and never
// deletes a file whose content the other application has changed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiHistoryStore } = require('../electron/ai-history.cjs');
const {
  listSharedSessions, readSharedSession, removeSharedSession, sharedHistory, writeSharedSession,
} = require('../electron/shared-sessions.cjs');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phl-sessions-'));
const now = () => new Date('2026-09-10T13:00:00.000Z');
const crypt = {
  encrypt: (value) => Buffer.from(`enc:${value}`, 'utf8'),
  decrypt: (buffer) => String(buffer).replace(/^enc:/, ''),
};

function store(name = 'store') {
  const directory = path.join(temp, name);
  fs.mkdirSync(directory, { recursive: true });
  return new AiHistoryStore({
    filePath: path.join(directory, 'ai-history.json'),
    sharedDirectory: path.join(directory, 'agent'),
    now,
    ...crypt,
  });
}
const liteSession = {
  id: '20260910-213045',
  title: '最近两周哪些作业还没交',
  history: [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '最近两周哪些作业还没交?' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', name: 'get_ddl', arguments: '{"days": 14}' }] },
    { role: 'tool', tool_call_id: 'call_1', name: 'get_ddl', content: '{"ok":true}' },
    { role: 'assistant', content: '这两周有 3 项。' },
  ],
};

test('this app mirrors its own session into the shared folder in the standard shape', () => {
  const app = store('own');
  app.load();
  app.saveSession({ id: 'local-1', title: 'Study plan', connectionKey: 'local:test-model', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] });
  const file = path.join(temp, 'own', 'agent', 'local-1.json');
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.id, 'local-1');
  assert.equal(written.title, 'Study plan');
  assert.equal(written.app, 'PH Launcher');
  assert.deepEqual(written.history, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]);
  assert.equal(fs.readFileSync(file, 'utf8').endsWith('\n'), true);
  assert.equal(written.version, 1);
  assert.equal(written.kind, 'phl-agent-session');
  // 与共享 Schedule 同一约定：本地时区偏移，不用 UTC 的 Z。
  assert.match(written.updated_at, /[+-]\d{2}:\d{2}$/);
  assert.doesNotMatch(written.updated_at, /Z$/);
  assert.equal(written.updated_at, require('../electron/shared-schedule.cjs').localIso(now()));
});

test('tool and system traffic from the other application is dropped, keeping readable turns', () => {
  assert.deepEqual(sharedHistory(liteSession.history), [
    { role: 'user', content: '最近两周哪些作业还没交?' },
    { role: 'assistant', content: '这两周有 3 项。' },
  ]);
  assert.deepEqual(sharedHistory([{ role: 'tool', content: 'x' }, { role: 'assistant', content: '   ' }, null]), []);
});

test('a foreign transcript shows up as a read-only shared session', () => {
  const directory = path.join(temp, 'foreign', 'agent');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${liteSession.id}.json`), JSON.stringify(liteSession));
  const app = store('foreign');
  const snapshot = app.load();
  const shared = snapshot.sessions.find((session) => session.id === liteSession.id);
  assert.ok(shared, 'the Lite session is listed');
  assert.equal(shared.shared, true);
  assert.match(shared.connectionKey, /^shared:/);
  assert.deepEqual(shared.messages.map((message) => message.role), ['user', 'assistant']);
  // It must not be folded into the encrypted file.
  app.saveSession({ id: 'local-2', title: 'Mine', connectionKey: 'local:test-model', messages: [{ role: 'user', content: 'x' }] });
  const raw = fs.readFileSync(path.join(temp, 'foreign', 'ai-history.json'), 'utf8');
  assert.equal(raw.startsWith('PHAIH1:'), true);
  const stored = JSON.parse(crypt.decrypt(Buffer.from(raw.slice('PHAIH1:'.length), 'base64')));
  assert.deepEqual(stored.sessions.map((session) => session.id), ['local-2']);
});

test('a shared file is deleted only while it still matches this app\'s own copy', () => {
  const app = store('delete');
  app.load();
  app.saveSession({ id: 'local-3', title: 'Mine', connectionKey: 'local:test-model', messages: [{ role: 'user', content: 'x' }] });
  const file = path.join(temp, 'delete', 'agent', 'local-3.json');
  assert.equal(fs.existsSync(file), true);
  // Lite rewrote the transcript with more content: keep the file.
  const rewritten = { ...JSON.parse(fs.readFileSync(file, 'utf8')), app: 'Pinghe Launcher Lite', history: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'longer answer' }] };
  fs.writeFileSync(file, JSON.stringify(rewritten));
  assert.equal(app.removeSession('local-3'), true);
  assert.equal(fs.existsSync(file), true, 'a transcript the other app changed is preserved');
  // Our own untouched file is removed with the session.
  app.saveSession({ id: 'local-4', title: 'Mine again', connectionKey: 'local:test-model', messages: [{ role: 'user', content: 'y' }] });
  const second = path.join(temp, 'delete', 'agent', 'local-4.json');
  assert.equal(fs.existsSync(second), true);
  assert.equal(app.removeSession('local-4'), true);
  assert.equal(fs.existsSync(second), false);
});

test('a foreign session can be hidden locally without deleting the other app\'s file', () => {
  const directory = path.join(temp, 'hide', 'agent');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${liteSession.id}.json`);
  fs.writeFileSync(file, JSON.stringify(liteSession));
  const app = store('hide');
  assert.equal(app.load().sessions.length, 1);
  assert.equal(app.removeSession(liteSession.id), true);
  assert.equal(app.snapshot().sessions.length, 0);
  assert.equal(fs.existsSync(file), true);
});

test('tolerant parsing: broken, oversized and unknown files are ignored, never fatal', () => {
  const directory = path.join(temp, 'broken', 'agent');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'bad.json'), '{not json');
  fs.writeFileSync(path.join(directory, 'empty.json'), JSON.stringify({ id: 'empty', title: 'x', history: [] }));
  fs.writeFileSync(path.join(directory, 'notes.txt'), 'ignored');
  fs.writeFileSync(path.join(directory, 'huge.json'), JSON.stringify({ id: 'huge', title: 'x', history: [{ role: 'user', content: 'y'.repeat(600 * 1024) }] }));
  const listed = listSharedSessions(directory);
  assert.deepEqual(listed.map((session) => session.id), []);
  assert.equal(readSharedSession(path.join(directory, 'bad.json')), null);
  const app = store('broken');
  assert.deepEqual(app.load().sessions, []);
});

test('writing refuses unusable input and never overwrites a longer foreign transcript', () => {
  const directory = path.join(temp, 'guard', 'agent');
  fs.mkdirSync(directory, { recursive: true });
  assert.throws(() => writeSharedSession(directory, { id: '../escape', title: 'x', messages: [{ role: 'user', content: 'y' }] }), /会话 ID/);
  assert.throws(() => writeSharedSession(directory, { id: 'ok-id', title: 'x', messages: [] }), /没有可共用的消息/);
  const target = path.join(directory, 'shared-1.json');
  fs.writeFileSync(target, JSON.stringify({ id: 'shared-1', title: 'Lite', app: 'Pinghe Launcher Lite', history: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'assistant', content: 'c' }] }));
  const result = writeSharedSession(directory, { id: 'shared-1', title: 'Mine', messages: [{ role: 'user', content: 'a' }] });
  assert.deepEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: 'foreign-newer' });
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).title, 'Lite');
  assert.equal(removeSharedSession(directory, { id: 'missing-1' }).removed, false);
});

test.after(() => { try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* no-op */ } });

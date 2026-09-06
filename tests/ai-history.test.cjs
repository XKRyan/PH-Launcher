'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiHistoryStore } = require('../electron/ai-history.cjs');

function xor(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  return Buffer.from(input.map((byte) => byte ^ 0xa7));
}

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-ai-history-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'history.secure');
  const create = (overrides = {}) => new AiHistoryStore({
    filePath,
    encrypt: (text) => xor(text),
    decrypt: (buffer) => xor(buffer).toString('utf8'),
    now: () => new Date('2026-09-06T09:30:00.000Z'),
    ...options,
    ...overrides,
  });
  return { directory, filePath, create };
}

function session(id = 'session-1', content = 'Help me review this idea.') {
  return { id, title: 'Study notes', connectionKey: 'local:0123456789abcdef', messages: [{ role: 'user', content }] };
}

test('missing file loads an empty cloned snapshot', (t) => {
  const f = fixture(t);
  const store = f.create();
  const loaded = store.load();
  assert.deepEqual(loaded, { version: 1, sessions: [], memories: [] });
  loaded.sessions.push({});
  assert.deepEqual(store.snapshot().sessions, []);
});

test('sessions and explicit memories survive restart only as encrypted data', (t) => {
  const f = fixture(t);
  const store = f.create();
  store.load();
  store.saveSession(session());
  const memory = store.saveMemory({ text: 'I prefer concise revision prompts.' });
  const disk = fs.readFileSync(f.filePath, 'utf8');
  assert.match(disk, /^PHAIH1:/);
  assert.doesNotMatch(disk, /Study notes|concise revision/);

  const reloaded = f.create().load();
  assert.equal(reloaded.sessions[0].connectionKey, 'local:0123456789abcdef');
  assert.equal(reloaded.memories[0].id, memory.id);
  assert.equal(reloaded.memories[0].text, 'I prefer concise revision prompts.');
});

test('saveSession strips system, tool, proposal, stream, and arbitrary fields', (t) => {
  const f = fixture(t);
  const store = f.create();
  store.load();
  const saved = store.saveSession({
    id: 'safe-session',
    title: '  A title  ',
    connectionKey: 'sha256:abcdef0123456789',
    messages: [
      { role: 'system', content: 'secret system prompt' },
      { role: 'tool', content: 'private tool result' },
      { role: 'user', content: ' Question ', proposal: { id: 'write' }, stream: true, tools: ['x'] },
      { role: 'assistant', content: ' Answer ', proposal: { id: 'write' }, tool_calls: [{}] },
    ],
  });
  assert.deepEqual(saved.messages, [
    { role: 'user', content: ' Question ' },
    { role: 'assistant', content: ' Answer ' },
  ]);
  assert.equal(saved.title, 'A title');
  assert.equal(saved.updatedAt, '2026-09-06T09:30:00.000Z');
  assert.doesNotMatch(JSON.stringify(store.snapshot()), /system prompt|tool result|proposal|stream|tool_calls/);
});

test('message whitespace survives encrypted persistence while whitespace-only messages remain invalid', (t) => {
  const f = fixture(t);
  const store = f.create();
  store.load();
  const content = '\n    const answer = 42;\n\n';
  store.saveSession(session('formatted', content));
  assert.equal(f.create().load().sessions[0].messages[0].content, content);
  assert.throws(() => store.saveSession(session('blank', ' \n\t ')), /消息内容/);
});

test('message, title, id, connection key, and memory limits are strict', (t) => {
  const f = fixture(t);
  const store = f.create();
  store.load();
  assert.throws(() => store.saveSession(session('../escape')), /会话 ID/);
  assert.throws(() => store.saveSession({ ...session(), title: 'x'.repeat(101) }), /标题过长/);
  assert.throws(() => store.saveSession({ ...session(), connectionKey: 'api-key' }), /连接指纹/);
  assert.throws(() => store.saveSession({ ...session(), messages: Array.from({ length: 121 }, () => ({ role: 'user', content: 'x' })) }), /消息数量/);
  assert.throws(() => store.saveSession(session('long-message', 'x'.repeat(16_001))), /消息内容/);
  assert.throws(() => store.saveMemory({ text: 'x'.repeat(501) }), /记忆内容/);
});

test('thirty-session and thirty-memory caps reject new records but allow updates', (t) => {
  const f = fixture(t);
  const store = f.create();
  store.load();
  for (let index = 0; index < 30; index += 1) store.saveSession(session(`session-${index}`));
  assert.throws(() => store.saveSession(session('session-30')), /最多保存 30/);
  assert.doesNotThrow(() => store.saveSession(session('session-0', 'Updated question')));
  for (let index = 0; index < 30; index += 1) store.saveMemory({ id: `memory-${index}`, text: `Explicit memory ${index}` });
  assert.throws(() => store.saveMemory({ id: 'memory-30', text: 'Too many' }), /最多保存 30/);
  assert.doesNotThrow(() => store.saveMemory({ id: 'memory-0', text: 'Explicitly edited' }));
});

test('aggregate three-megabyte limit rejects without deleting older sessions', (t) => {
  const f = fixture(t);
  const store = f.create();
  store.load();
  const largeMessages = Array.from({ length: 110 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'a'.repeat(15_900) }));
  store.saveSession({ ...session('large-1'), messages: largeMessages });
  const before = store.snapshot();
  assert.throws(() => store.saveSession({ ...session('large-2'), messages: largeMessages }), /超过 3 MB/);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.snapshot().sessions.length, 1);
});

test('remove methods delete exactly one requested record', (t) => {
  const f = fixture(t);
  const store = f.create();
  store.load();
  store.saveSession(session('one'));
  store.saveSession(session('two'));
  store.saveMemory({ id: 'memory-one', text: 'First explicit memory' });
  store.saveMemory({ id: 'memory-two', text: 'Second explicit memory' });
  assert.equal(store.removeSession('one'), true);
  assert.equal(store.removeSession('missing'), false);
  assert.deepEqual(store.snapshot().sessions.map((item) => item.id), ['two']);
  assert.equal(store.removeMemory('memory-one'), true);
  assert.deepEqual(store.snapshot().memories.map((item) => item.id), ['memory-two']);
});

test('bad ciphertext or decryption failure is obvious and cannot overwrite the original file', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.filePath, 'plaintext history', 'utf8');
  const before = fs.readFileSync(f.filePath);
  const store = f.create();
  assert.throws(() => store.load(), /无法解锁 AI 历史/);
  assert.throws(() => store.saveSession(session()), /无法解锁 AI 历史/);
  assert.deepEqual(fs.readFileSync(f.filePath), before);

  fs.writeFileSync(f.filePath, `PHAIH1:${Buffer.from('ciphertext').toString('base64')}`, 'utf8');
  const decrypting = f.create({ decrypt: () => { throw new Error('provider leaked details'); } });
  assert.throws(() => decrypting.load(), /无法解锁 AI 历史/);
});

test('atomic rename failure preserves the previous file, memory, and removes same-directory temp data', (t) => {
  const f = fixture(t);
  const store = f.create();
  store.load();
  store.saveSession(session('stable'));
  const beforeDisk = fs.readFileSync(f.filePath);
  const beforeMemory = store.snapshot();
  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'renameSync') return () => { throw new Error('private path details'); };
      return Reflect.get(target, property);
    },
  });
  store.fs = failingFs;
  assert.throws(() => store.saveSession(session('new-session')), /原有记录未更改/);
  assert.deepEqual(store.snapshot(), beforeMemory);
  assert.deepEqual(fs.readFileSync(f.filePath), beforeDisk);
  assert.deepEqual(fs.readdirSync(f.directory), ['history.secure']);
});

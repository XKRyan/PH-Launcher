"use strict";

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const mainSource = fs.readFileSync(require.resolve('../electron/main.cjs'), 'utf8');
const start = mainSource.indexOf('function mergeXinlvState');
const end = mainSource.indexOf('\nclass SecureStore', start);
assert.ok(start >= 0 && end > start, 'mergeXinlvState must be defined before SecureStore');

const context = {
  createDefaultData: () => ({ xinlv: { username: '', password: '', token: '', entries: {}, serverTime: '', dirty: [] } }),
};
vm.runInNewContext(`${mainSource.slice(start, end)}\nglobalThis.mergeXinlvState = mergeXinlvState;`, context);
const merge = context.mergeXinlvState;

const stored = {
  username: 'student',
  password: 'secret',
  token: 'token-abc',
  entries: { u1: { uuid: 'u1', date: '2026-01-01', mood: 'calm', deleted: false, updatedAt: 'x' } },
  serverTime: 'cursor-1',
  dirty: ['u1'],
};

test('a renderer save cannot wipe Xinlv entries, token or the sync cursor', () => {
  // forRenderer() sends only this redacted shape.
  const redacted = { username: 'student', configured: true, tokenSaved: true, totalEntries: 1, pendingSync: 1 };
  const merged = merge(stored, redacted);
  assert.equal(merged.username, 'student');
  assert.equal(merged.password, 'secret');
  assert.equal(merged.token, 'token-abc');
  assert.equal(merged.serverTime, 'cursor-1');
  assert.deepEqual(JSON.parse(JSON.stringify(merged.entries)), stored.entries);
  assert.deepEqual(JSON.parse(JSON.stringify(merged.dirty)), ['u1']);
});

test('an explicit import may restore mood entries but never credentials or the cursor', () => {
  const imported = {
    username: 'other-account',
    password: 'attacker-password',
    token: 'attacker-token',
    entries: { u9: { uuid: 'u9', date: '2026-02-02', mood: 'happy', deleted: false, updatedAt: 'y' } },
    serverTime: 'attacker-cursor',
    dirty: ['u9'],
  };
  const merged = merge(stored, imported);
  assert.deepEqual(Object.keys(merged.entries), ['u9'], 'imported entries are restored');
  assert.equal(merged.username, 'student');
  assert.equal(merged.password, 'secret');
  assert.equal(merged.token, 'token-abc');
  assert.equal(merged.serverTime, 'cursor-1', 'the local sync cursor stays authoritative');
  assert.deepEqual(merged.dirty, ['u1']);
});

test('the cached content catalog survives saves and can be restored by an import', () => {
  const withCatalog = { ...stored, catalog: { songs: [{ title: '歌' }] }, catalogFetchedAt: 123 };
  const kept = merge(withCatalog, { username: 'student', configured: true });
  assert.equal(kept.catalog.songs.length, 1, 'a renderer save keeps the cached catalog');
  assert.equal(kept.catalogFetchedAt, 123);

  const restored = merge(stored, { catalog: { songs: [{ title: '导入的歌' }] } });
  assert.equal(restored.catalog.songs[0].title, '导入的歌', 'an import can restore the catalog');
});

test('a missing or malformed Xinlv block falls back to defaults instead of throwing', () => {
  const merged = merge(undefined, null);
  assert.equal(merged.username, '');
  assert.equal(merged.password, '');
  assert.equal(merged.token, '');
  assert.equal(merged.serverTime, '');
  assert.equal(Object.keys(merged.entries).length, 0);
  assert.equal(merged.dirty.length, 0);
  const partial = merge({ username: 'student', token: 't' }, { entries: 'not-an-object' });
  assert.equal(Object.keys(partial.entries).length, 0);
  assert.equal(partial.token, 't');
});

test('a plaintext data export strips the Xinlv password and token', () => {  assert.match(mainSource, /exportData\.settings\.ai\.apiKey = '';/);
  assert.match(mainSource, /exportData\.xinlv\.password = '';/);
  assert.match(mainSource, /exportData\.xinlv\.token = '';/);
});

test('the renderer payload never exposes the Xinlv password, token or raw entries', () => {
  const forRendererStart = mainSource.indexOf('  forRenderer() {');
  const forRendererEnd = mainSource.indexOf('\n  }\n}', forRendererStart);
  const body = mainSource.slice(forRendererStart, forRendererEnd);
  assert.match(body, /copy\.xinlv = \{/);
  assert.doesNotMatch(body, /copy\.xinlv\s*=\s*structuredClone/);
  assert.match(body, /tokenSaved: Boolean\(xinlvState\.token\)/);
});

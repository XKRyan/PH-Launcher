"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const { XinlvService, XinlvServiceError, defaultData } = require('../electron/xinlv-service.cjs');

// In-memory stand-in for the encrypted SecureStore xinlv block.
function makeStore(initial = {}) {
  const store = { username: '', password: '', token: '', ...defaultData(), ...initial };
  return {
    store,
    getData: () => store,
    updateData: (patch) => { Object.assign(store, patch); },
  };
}

function makeClient(overrides = {}) {
  const calls = { push: [], pull: [], login: [], logout: 0 };
  const client = {
    async login(username, password) { calls.login.push({ username, password }); return { token: 'token-abc', username, streak: 0 }; },
    async register(username) { return { token: 'token-abc', username, streak: 0 }; },
    async logout() { calls.logout += 1; },
    async pushEntries(entries) { calls.push.push(entries); return overrides.pushResult || { saved: entries.length, updated: 0, skipped: 0, errors: [], serverTime: 't1' }; },
    async pullEntries(since) { calls.pull.push(since); return overrides.pullResult || { serverTime: 't1', entries: [] }; },
    async profile() { return overrides.profile || { username: 'student' }; },
  };
  return { client, calls };
}

function serviceWith(store, client) {
  return new XinlvService({ getData: store.getData, updateData: store.updateData, xinlvClientFactory: () => client });
}

test('xinlv login stores the token in the encrypted store and never in the renderer payload shape', async () => {
  const store = makeStore();
  const { client, calls } = makeClient();
  const service = serviceWith(store, client);
  const status = await service.login(' student ', 'secret');
  assert.deepEqual(calls.login, [{ username: 'student', password: 'secret' }]);
  assert.equal(store.store.token, 'token-abc');
  assert.equal(store.store.username, 'student');
  assert.equal(status.configured, true);
  assert.equal(status.tokenPresent, true);
  assert.equal(status.username, 'student');
});

test('xinlv login rejects empty credentials before calling the API', async () => {
  const store = makeStore();
  const { client, calls } = makeClient();
  const service = serviceWith(store, client);
  await assert.rejects(() => service.login('', ''), (error) => error.code === 'xinlv_credentials_missing');
  assert.equal(calls.login.length, 0);
  assert.equal(store.store.token, '');
});

test('xinlv logout clears only the token and keeps local records', async () => {
  const store = makeStore({ token: 'token-abc', username: 'student', entries: { u1: { uuid: 'u1', date: '2026-01-01', mood: 'calm', deleted: false, updatedAt: 'a' } } });
  const { client, calls } = makeClient();
  const service = serviceWith(store, client);
  const status = await service.logout();
  assert.equal(store.store.token, '');
  assert.equal(status.configured, false);
  assert.equal(Object.keys(store.store.entries).length, 1);
  assert.equal(calls.logout, 1);
});

test('xinlv addMood validates mood and date, marks the entry dirty for sync', () => {
  const store = makeStore({ token: 'token-abc' });
  const service = serviceWith(store, makeClient().client);
  assert.throws(() => service.addMood({ date: '2026-01-01', mood: 'hungry' }), (error) => error.code === 'xinlv_bad_mood');
  assert.throws(() => service.addMood({ date: '01/01/2026', mood: 'calm' }), (error) => error.code === 'xinlv_bad_date');
  const entry = service.addMood({ date: '2026-01-01', mood: 'calm', note: '还行', intensityLevel: 4, intensityPercent: 70 });
  assert.equal(entry.uuid.length, 36, 'entries use uuid v4');
  assert.equal(entry.deleted, false);
  assert.equal(store.store.dirty.includes(entry.uuid), true);
  assert.equal(service.listMoods({}).length, 1);
});

test('xinlv listMoods sorts by date, hides tombstones and honours the date window', () => {
  const store = makeStore({
    token: 'token-abc',
    entries: {
      a: { uuid: 'a', date: '2026-01-03', mood: 'happy', deleted: false, updatedAt: '1' },
      b: { uuid: 'b', date: '2026-01-01', mood: 'sad', deleted: false, updatedAt: '1' },
      c: { uuid: 'c', date: '2026-01-02', mood: 'calm', deleted: true, updatedAt: '1' },
      d: { uuid: 'd', date: '2025-12-31', mood: 'tired', deleted: false, updatedAt: '1' },
    },
  });
  const service = serviceWith(store, makeClient().client);
  assert.deepEqual(service.listMoods({}).map((entry) => entry.uuid), ['d', 'b', 'a']);
  assert.deepEqual(service.listMoods({ sinceDate: '2026-01-01' }).map((entry) => entry.uuid), ['b', 'a']);
  assert.deepEqual(service.listMoods({ sinceDate: '2026-01-01', untilDate: '2026-01-02' }).map((entry) => entry.uuid), ['b']);
});

test('xinlv editMood refreshes updated_at so later writes win, deleteMood writes a tombstone', () => {
  const store = makeStore({ token: 'token-abc' });
  const service = serviceWith(store, makeClient().client);
  const entry = service.addMood({ date: '2026-01-01', mood: 'calm' });
  const edited = service.editMood(entry.uuid, { mood: 'happy', note: '改过了' });
  assert.equal(edited.mood, 'happy');
  assert.equal(edited.note, '改过了');
  assert.ok(edited.updatedAt >= entry.updatedAt);
  assert.equal(store.store.dirty.filter((uuid) => uuid === entry.uuid).length, 1, 'dirty list stays unique');
  assert.equal(service.deleteMood(entry.uuid), true);
  assert.equal(store.store.entries[entry.uuid].deleted, true);
  assert.equal(service.listMoods({}).length, 0);
  assert.equal(service.deleteMood(entry.uuid), false, 'deleting twice is a no-op');
  assert.throws(() => service.editMood(entry.uuid, { mood: 'calm' }), (error) => error.code === 'xinlv_not_found');
});

test('xinlv sync pushes dirty entries then pulls since the stored cursor', async () => {
  const entry = { uuid: 'u1', date: '2026-01-01', mood: 'calm', note: '', deleted: false, intensityLevel: 2, intensityPercent: 30, createdAt: '', updatedAt: '2026-01-01T00:00:00Z' };
  const store = makeStore({ token: 'token-abc', entries: { u1: entry }, dirty: ['u1'], serverTime: 'cursor-1' });
  const { client, calls } = makeClient({ pullResult: { serverTime: 'cursor-2', entries: [] } });
  const service = serviceWith(store, client);
  const result = await service.sync({});
  assert.equal(calls.push.length, 1);
  assert.deepEqual(calls.push[0][0], {
    uuid: 'u1', date: '2026-01-01', at: undefined, mood: 'calm', note: undefined,
    intensity_level: 2, intensity_percent: 30, updated_at: '2026-01-01T00:00:00Z', deleted: false,
  });
  assert.deepEqual(calls.pull, ['cursor-1'], 'pull uses the stored incremental cursor');
  assert.equal(result.pushed, 1);
  assert.equal(store.store.dirty.length, 0, 'successful push clears dirty markers');
  assert.equal(store.store.serverTime, 'cursor-2', 'the returned server_time becomes the next cursor');
});

test('xinlv sync merges server entries with last-write-wins and applies tombstones', async () => {
  const store = makeStore({
    token: 'token-abc',
    entries: {
      newerLocal: { uuid: 'newerLocal', date: '2026-01-01', mood: 'calm', deleted: false, updatedAt: '2026-05-05T00:00:00Z' },
      olderLocal: { uuid: 'olderLocal', date: '2026-01-02', mood: 'sad', deleted: false, updatedAt: '2026-01-01T00:00:00Z' },
      doomed: { uuid: 'doomed', date: '2026-01-03', mood: 'happy', deleted: false, updatedAt: '2026-01-01T00:00:00Z' },
    },
    dirty: [],
  });
  const { client } = makeClient({
    pullResult: {
      serverTime: 'cursor-2',
      entries: [
        { uuid: 'newerLocal', date: '2026-01-01', mood: 'angry', updated_at: '2026-01-01T00:00:00Z' },
        { uuid: 'olderLocal', date: '2026-01-02', mood: 'tired', updated_at: '2026-06-06T00:00:00Z' },
        { uuid: 'doomed', date: '2026-01-03', mood: 'happy', updated_at: '2026-07-07T00:00:00Z', deleted: true },
        { uuid: 'brandNew', date: '2026-01-04', mood: 'lonely', updated_at: '2026-01-04T00:00:00Z' },
      ],
    },
  });
  const service = serviceWith(store, client);
  const result = await service.sync({});
  assert.equal(store.store.entries.newerLocal.mood, 'calm', 'older server copy must not overwrite a newer local edit');
  assert.equal(store.store.entries.olderLocal.mood, 'tired', 'newer server copy wins');
  assert.equal(store.store.entries.doomed.deleted, true, 'server tombstone deletes the local entry');
  assert.equal(store.store.entries.brandNew.mood, 'lonely');
  assert.equal(result.pulled, 3, 'newer server entries, the tombstone and the new entry are all applied');
  assert.deepEqual(service.listMoods({}).map((entry) => entry.uuid), ['newerLocal', 'olderLocal', 'brandNew']);
});

test('xinlv sync without a token refuses to run', async () => {
  const store = makeStore();
  const { client, calls } = makeClient();
  const service = serviceWith(store, client);
  await assert.rejects(() => service.sync({}), (error) => error.code === 'xinlv_auth_required' && error instanceof XinlvServiceError);
  assert.equal(calls.push.length + calls.pull.length, 0);
});

test('xinlv sync keeps dirty entries and reports offline instead of losing data', async () => {
  const entry = { uuid: 'u1', date: '2026-01-01', mood: 'calm', deleted: false, intensityLevel: 2, intensityPercent: 30, updatedAt: 'x' };
  const store = makeStore({ token: 'token-abc', entries: { u1: entry }, dirty: ['u1'], serverTime: 'cursor-1' });
  const { client } = makeClient();
  client.pushEntries = async () => { const error = new Error('连不上心履服务器，请检查网络'); error.code = 'xinlv_offline'; throw error; };
  const service = serviceWith(store, client);
  const result = await service.sync({});
  assert.equal(result.offline, true);
  assert.deepEqual(store.store.dirty, ['u1'], 'unsent changes stay queued');
  assert.equal(result.errors.length, 1);
});

test('xinlv sync drops the token when the server rejects it, without retrying', async () => {
  const entry = { uuid: 'u1', date: '2026-01-01', mood: 'calm', deleted: false, intensityLevel: 2, intensityPercent: 30, updatedAt: 'x' };
  const store = makeStore({ token: 'token-abc', entries: { u1: entry }, dirty: ['u1'] });
  const { client, calls } = makeClient();
  client.pushEntries = async () => { const error = new Error('心履登录已失效，请重新登录'); error.code = 'xinlv_auth'; throw error; };
  const service = serviceWith(store, client);
  await assert.rejects(() => service.sync({}), (error) => error.code === 'xinlv_auth');
  assert.equal(store.store.token, '', 'a dead token is removed so the UI can ask for login');
  assert.equal(calls.push.length, 0, 'no automatic retry is attempted');
});

test('xinlv sync batches large local histories at 500 entries per request', async () => {
  const entries = {};
  const dirty = [];
  for (let index = 0; index < 1200; index += 1) {
    const uuid = `u${index}`;
    entries[uuid] = { uuid, date: '2026-01-01', mood: 'calm', deleted: false, intensityLevel: 2, intensityPercent: 30, updatedAt: 'x' };
    dirty.push(uuid);
  }
  const store = makeStore({ token: 'token-abc', entries, dirty });
  const { client, calls } = makeClient();
  const service = serviceWith(store, client);
  await service.sync({});
  assert.deepEqual(calls.push.map((batch) => batch.length), [500, 500, 200]);
});

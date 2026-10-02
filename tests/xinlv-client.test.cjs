"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const { XinlvClient, XinlvError, MOOD_KEYS, isValidMood } = require('../electron/xinlv-client.cjs');

function jsonResponse(status, body) {
  return { status, json: async () => body };
}

function clientWith(handler, options = {}) {
  const calls = [];
  const client = new XinlvClient({
    token: () => options.token ?? 'token-123',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return handler(url, init); },
    timeoutMs: options.timeoutMs ?? 20000,
  });
  return { client, calls };
}

test('xinlv client exposes the documented mood set', () => {
  assert.equal(MOOD_KEYS.length, 10);
  for (const mood of ['happy', 'calm', 'excited', 'grateful', 'tired', 'anxious', 'sad', 'angry', 'lonely', 'numb']) {
    assert.equal(isValidMood(mood), true, mood);
  }
  assert.equal(isValidMood('hungry'), false);
  assert.equal(isValidMood(''), false);
});

test('xinlv ping is unauthenticated and maps the server payload', async () => {
  const { client, calls } = clientWith(() => jsonResponse(200, { ok: true, version: '1.0', server_time: '2026-01-01T00:00:00Z' }));
  const result = await client.ping();
  assert.deepEqual(result, { ok: true, version: '1.0', serverTime: '2026-01-01T00:00:00Z' });
  assert.equal(calls[0].url, 'https://xin-lv.com/api/v1/ping/');
  assert.equal(calls[0].init.headers.Authorization, undefined);
});

test('xinlv login posts credentials and returns the token without logging them', async () => {
  const { client, calls } = clientWith(() => jsonResponse(200, { token: 'abc', username: 'student', streak: 3 }));
  const result = await client.login('  student  ', 'secret-password');
  assert.deepEqual(result, { token: 'abc', username: 'student', streak: 3 });
  assert.equal(calls[0].url, 'https://xin-lv.com/api/v1/login/');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, undefined, 'login must not send a bearer token');
  assert.deepEqual(JSON.parse(calls[0].init.body), { username: 'student', password: 'secret-password', device: 'ph-launcher-desktop' });
});

test('xinlv register refuses to run without accepting the disclaimer', async () => {
  const { client } = clientWith(() => jsonResponse(200, {}));
  await assert.rejects(() => client.register('student', 'secret', { agree: false }), (error) => error.code === 'xinlv_agree_required');
});

test('xinlv maps 401, 429 and API errors to stable codes with Chinese messages', async () => {
  const unauthorized = clientWith(() => jsonResponse(401, { error: '登录已过期' })).client;
  await assert.rejects(() => unauthorized.profile(), (error) => error.code === 'xinlv_auth' && error.message === '登录已过期' && error.status === 401);

  const limited = clientWith(() => jsonResponse(429, {})).client;
  await assert.rejects(() => limited.profile(), (error) => error.code === 'xinlv_rate_limited' && /过几分钟/.test(error.message));

  const badRequest = clientWith(() => jsonResponse(400, { error: '日期格式不正确' })).client;
  await assert.rejects(() => badRequest.pullEntries(null), (error) => error.code === 'xinlv_api' && error.message === '日期格式不正确');
});

test('xinlv network failure and timeout are distinct, retryable-safe codes', async () => {
  const offline = clientWith(() => { throw new Error('ECONNREFUSED'); }).client;
  await assert.rejects(() => offline.profile(), (error) => error.code === 'xinlv_offline');

  const hanging = clientWith((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); });
  }), { timeoutMs: 5 }).client;
  await assert.rejects(() => hanging.pullEntries(null), (error) => error.code === 'xinlv_timeout');
});

test('xinlv authenticated calls require a stored token', async () => {
  const { client } = clientWith(() => jsonResponse(200, {}), { token: '' });
  await assert.rejects(() => client.profile(), (error) => error.code === 'xinlv_auth_required');
});

test('xinlv pull encodes the since cursor and maps entries plus server_time', async () => {
  const { client, calls } = clientWith(() => jsonResponse(200, { server_time: '2026-02-02T10:00:00Z', entries: [{ uuid: 'u1' }] }));
  const result = await client.pullEntries('2026-02-01T09:00:00+08:00');
  assert.equal(calls[0].url, 'https://xin-lv.com/api/v1/sync/pull/?since=2026-02-01T09%3A00%3A00%2B08%3A00');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer token-123');
  assert.deepEqual(result, { serverTime: '2026-02-02T10:00:00Z', entries: [{ uuid: 'u1' }] });
});

test('xinlv push sends the entry batch and maps counters', async () => {
  const { client, calls } = clientWith(() => jsonResponse(200, { saved: 2, updated: 1, skipped: 0, errors: [], server_time: 'now' }));
  const result = await client.pushEntries([{ uuid: 'u1', mood: 'calm' }]);
  assert.deepEqual(result, { saved: 2, updated: 1, skipped: 0, errors: [], serverTime: 'now' });
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { entries: [{ uuid: 'u1', mood: 'calm' }] });
});

test('xinlv recommend rejects unknown moods before any request', async () => {
  const { client, calls } = clientWith(() => jsonResponse(200, {}));
  await assert.rejects(() => client.recommend('hungry'), (error) => error.code === 'xinlv_bad_mood');
  assert.equal(calls.length, 0);
});

test('xinlv chat surfaces the crisis flag and hotline verbatim', async () => {
  const { client } = clientWith(() => jsonResponse(200, { crisis: true, reply: '请联系专业人士', hotline: '12356' }));
  const result = await client.chat('我不想活了');
  assert.deepEqual(result, { crisis: true, reply: '请联系专业人士', hotline: '12356' });
});

test('xinlv profile maps optional fields defensively', async () => {
  const { client } = clientWith(() => jsonResponse(200, { username: 'student', badges: null, streak: '4' }));
  const result = await client.profile();
  assert.deepEqual(result, {
    username: 'student', bio: '', language: 'zh', avatarUrl: '', streak: '4',
    badges: [], totalEntries: 0, dateJoined: '',
  });
  assert.ok(result instanceof Object && !(result instanceof XinlvError));
});

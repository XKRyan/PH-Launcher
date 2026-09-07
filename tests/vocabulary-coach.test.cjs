'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVocabularyCoach } = require('../electron/vocabulary-coach.cjs');

function config(overrides = {}) {
  return { enabled: true, provider: 'local', localEndpoint: 'http://127.0.0.1:11434', localModel: 'local-model', apiEndpoint: 'https://api.example.test/v1', apiModel: 'api-model', apiKey: 'saved-test-key', ...overrides };
}
function response(content) { return { ok: true, status: 200, headers: { get: () => null }, text: async () => content }; }
function local(value) { return response(JSON.stringify({ message: { content: JSON.stringify(value) } })); }
function api(value) { return response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] })); }

test('local coach is authorized, starts only on demand, and sends only the current fields', async () => {
  let starts = 0; let sent;
  const coach = createVocabularyCoach({
    getConfig: () => config({ provider: 'api' }), authorize: async (provider) => assert.equal(provider, 'local'),
    ensureLocalReady: async (signal) => { assert.equal(signal.aborted, false); starts++; },
    fetchImpl: async (_url, options) => { sent = JSON.parse(options.body); return local({ translation: '证据很清楚。' }); },
  });
  const result = await coach({ kind: 'translation', provider: 'local', word: 'evidence', context: 'The evidence is clear.' });
  assert.deepEqual(result, { source: 'local', kind: 'translation', translation: '证据很清楚。' });
  assert.equal(starts, 1); assert.equal(sent.stream, false); assert.equal(sent.think, false);
  assert.deepEqual(JSON.parse(sent.messages[1].content), { kind: 'translation', provider: 'local', word: 'evidence', language: 'zh-CN', context: 'The evidence is clear.' });
});

test('API uses the saved HTTPS chat endpoint and never starts or falls back to local', async () => {
  let starts = 0; let calls = 0;
  const coach = createVocabularyCoach({
    getConfig: () => config({ provider: 'local' }), authorize: async () => true, ensureLocalReady: async () => { starts++; },
    fetchImpl: async (url, options) => { calls++; assert.equal(String(url), 'https://api.example.test/v1/chat/completions'); assert.equal(options.headers.authorization, 'Bearer saved-test-key'); return api({ verdict: 'spelling', explanation: '拼写少了一个字母。', suggestion: 'evidence' }); },
  });
  const result = await coach({ kind: 'answer', provider: 'api', word: 'evidence', meaning: '证据', answer: 'evidnce' });
  assert.equal(result.verdict, 'spelling'); assert.equal(calls, 1); assert.equal(starts, 0);
  const insecure = createVocabularyCoach({ getConfig: () => config({ apiEndpoint: 'http://api.example.test' }), authorize: async () => true, fetchImpl: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(insecure({ kind: 'answer', provider: 'api', word: 'evidence', meaning: '证据', answer: 'evidence' }), /HTTPS/);
});

test('authorization is required before work and is rechecked before returning a result', async () => {
  let authorized = false; let called = 0;
  const denied = createVocabularyCoach({ getConfig: () => config(), authorize: async () => authorized, fetchImpl: async () => { called++; return local({ translation: '测试。' }); } });
  await assert.rejects(denied({ kind: 'translation', provider: 'local', word: 'test', context: 'This is a test sentence.' }), /授权/);
  assert.equal(called, 0);
  authorized = true;
  const revoked = createVocabularyCoach({ getConfig: () => config(), authorize: async () => (called++ === 0), fetchImpl: async () => local({ translation: '这是一句测试。' }) });
  await assert.rejects(revoked({ kind: 'translation', provider: 'local', word: 'test', context: 'This is a test sentence.' }), /授权/);
});

test('validates strict JSON by task kind and rejects prompt-shaped extra fields', async () => {
  const expression = createVocabularyCoach({ getConfig: () => config(), authorize: async () => true, fetchImpl: async () => local({ corrected: 'The evidence supports the claim.', notes: '表达自然。' }) });
  const value = await expression({ kind: 'expression', provider: 'local', word: 'evidence', expression: 'The evidence support the claim.' });
  assert.deepEqual(value, { source: 'local', kind: 'expression', corrected: 'The evidence supports the claim.', notes: '表达自然。' });
  const malformed = createVocabularyCoach({ getConfig: () => config(), authorize: async () => true, fetchImpl: async () => local({ translation: '翻译', extra: 'no' }) });
  await assert.rejects(malformed({ kind: 'translation', provider: 'local', word: 'test', context: 'This is a test sentence.' }), /格式/);
  await assert.rejects(expression({ kind: 'expression', provider: 'local', word: 'test', expression: 'A test.', school: {} }), /未授权/);
});

test('timeout, cancellation, and a changed configuration discard results', async () => {
  const input = { kind: 'translation', provider: 'local', word: 'test', context: 'This is a test sentence.' };
  const pending = createVocabularyCoach({ getConfig: () => config(), authorize: async () => true, fetchImpl: async () => new Promise(() => {}), timeoutMs: 10 });
  await assert.rejects(pending(input), /超时/);
  const controller = new AbortController();
  const cancelled = createVocabularyCoach({ getConfig: () => config(), authorize: async () => true, fetchImpl: async () => new Promise(() => {}) });
  const run = cancelled(input, { signal: controller.signal }); controller.abort(); await assert.rejects(run, /取消/);
  let current = config();
  const changed = createVocabularyCoach({ getConfig: () => current, authorize: async () => true, fetchImpl: async () => { current = config({ localModel: 'changed' }); return local({ translation: '测试。' }); } });
  await assert.rejects(changed(input), /设置已变更/);
});

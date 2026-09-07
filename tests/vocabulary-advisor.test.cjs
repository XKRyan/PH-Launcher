'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVocabularyAdvisor, validSentence } = require('../electron/vocabulary-advisor.cjs');

function config(overrides = {}) {
  return {
    enabled: true,
    provider: 'local',
    localEndpoint: 'http://127.0.0.1:11434',
    localModel: 'local-vocab',
    apiEndpoint: 'https://api.example.test/v1',
    apiModel: 'remote-vocab',
    apiKey: 'saved-test-key',
    ...overrides,
  };
}

function response(content) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => content,
  };
}

function localEnvelope(result) {
  return JSON.stringify({ message: { content: JSON.stringify(result) } });
}

function apiEnvelope(result) {
  return JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] });
}

const goodMeticulous = 'The meticulous editor checked every citation before the article reached its final readers.';
const goodResilient = 'After several failed trials, the resilient team calmly refined its design and continued working.';

test('local startup hook is demand-only; API and disabled requests never start Ollama', async () => {
  let ai = config(); let starts = 0;
  const value = { ids: ['fixture'], contexts: [{ id: 'fixture', sentence: goodMeticulous }] };
  const advise = createVocabularyAdvisor({ getConfig: () => ai, ensureLocalReady: async () => { starts++; },
    fetchImpl: async () => response(ai.provider === 'api' ? apiEnvelope(value) : localEnvelope(value)) });
  const input = { provider: 'local', level: 'intermediate', candidates: [{ id: 'fixture', word: 'meticulous', meaning: 'careful' }], recent: [], limit: 1 };
  await advise(input); assert.equal(starts, 1);
  ai = config({ provider: 'api' });
  await advise({ ...input, provider: 'api', apiConsent: true }); assert.equal(starts, 1);
  ai.enabled = false;
  await assert.rejects(advise(input), /启用/); assert.equal(starts, 1);
});

test('fenced JSON is accepted without accepting unrelated executable text', async () => {
  const { validateModelResult } = require('../electron/vocabulary-advisor.cjs');
  const candidates = [{ id: 'fixture', word: 'meticulous', meaning: 'careful' }];
  const result = { ids: ['fixture'], contexts: [{ id: 'fixture', sentence: goodMeticulous }] };
  assert.deepEqual(validateModelResult('```json\n' + JSON.stringify(result) + '\n```', candidates, 1), result);
  assert.throws(() => validateModelResult('some instructions\n' + JSON.stringify(result), candidates, 1), /格式/);
});

test('local advisor uses only bounded vocabulary signals and the selected saved local model', async () => {
  const calls = [];
  const candidates = Array.from({ length: 41 }, (_, index) => ({
    id: `id-${index}`,
    word: index === 0 ? 'meticulous' : `word${String.fromCharCode(97 + (index % 26))}`,
    meaning: index === 0 ? 'careful about every detail' : 'x'.repeat(300),
  }));
  const recent = Array.from({ length: 22 }, (_, index) => ({ word: `recent${String.fromCharCode(97 + (index % 26))}`, rating: index + 900 }));
  const advisor = createVocabularyAdvisor({
    // Current provider may differ; choosing local must still use its saved settings.
    getConfig: () => config({ provider: 'api' }),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return response(localEnvelope({ ids: ['id-0'], contexts: [{ id: 'id-0', sentence: goodMeticulous }] }));
    },
  });

  const result = await advisor({ provider: 'local', level: 'foundation', candidates, recent, limit: 5 });
  assert.deepEqual(result, { ids: ['id-0'], contexts: [{ id: 'id-0', sentence: goodMeticulous }], source: 'local' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(calls[0].options.redirect, 'error');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'local-vocab');
  assert.equal(body.stream, false);
  assert.equal(body.think, false);
  assert.equal(body.keep_alive, '10m');
  assert.equal(body.options.num_ctx, 4096);
  assert.equal(Object.hasOwn(body, 'tools'), false);
  const sent = JSON.parse(body.messages[1].content);
  assert.equal(sent.candidates.length, 40);
  assert.equal(sent.candidates[1].meaning.length, 240);
  assert.equal(sent.recent.length, 20);
  assert.equal(Object.hasOwn(sent.recent[0], 'rating'), false, 'raw scores never leave the process');
  assert.equal(sent.recent[0].status, 'review');
  assert.deepEqual(Object.keys(sent).sort(), ['candidates', 'level', 'limit', 'recent']);
  assert.match(body.messages[0].content, /untrusted reference data/i);
});

test('API requires explicit consent, uses HTTPS OpenAI-compatible endpoint, and never falls back', async () => {
  let calls = 0;
  const advisor = createVocabularyAdvisor({
    getConfig: () => config({ provider: 'local' }),
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(String(url), 'https://api.example.test/v1/chat/completions');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.authorization, 'Bearer saved-test-key');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'remote-vocab');
      assert.equal(Object.hasOwn(body, 'tools'), false);
      return response(apiEnvelope({ ids: ['a'], contexts: [{ id: 'a', sentence: goodResilient.replace('resilient', 'adaptable') }] }));
    },
  });
  const input = { provider: 'api', level: 'intermediate', candidates: [{ id: 'a', word: 'adaptable', meaning: 'able to change' }], recent: [] };
  await assert.rejects(advisor(input), /同意使用 API/);
  assert.equal(calls, 0);
  const result = await advisor({ ...input, apiConsent: true });
  assert.deepEqual(result.ids, ['a']);
  assert.equal(result.source, 'api');
  assert.equal(calls, 1);

  const insecure = createVocabularyAdvisor({
    getConfig: () => config({ apiEndpoint: 'http://api.example.test/v1' }),
    fetchImpl: async () => { calls += 1; return response('{}'); },
  });
  await assert.rejects(insecure({ ...input, apiConsent: true }), /HTTPS/);
  assert.equal(calls, 1, 'a rejected API configuration must not try local AI');
});

test('only selected known IDs survive, while malformed contexts are safely omitted', async () => {
  const advisor = createVocabularyAdvisor({
    getConfig: () => config(),
    fetchImpl: async () => response(localEnvelope({
      ids: ['met', 'res'],
      contexts: [
        { id: 'met', sentence: goodMeticulous },
        { id: 'res', sentence: 'The resilient team opened https://example.test/reset and continued its work with careful planning.' },
        { id: 'res', sentence: goodResilient },
        { id: 'met', sentence: goodMeticulous },
        { id: 'outside', sentence: goodResilient },
      ],
    })),
  });
  const result = await advisor({
    provider: 'local', level: 'advanced', limit: 2, recent: [],
    candidates: [
      { id: 'met', word: 'meticulous', meaning: 'very careful' },
      { id: 'res', word: 'resilient', meaning: 'able to recover' },
    ],
  });
  assert.deepEqual(result.contexts, [
    { id: 'met', sentence: goodMeticulous },
    { id: 'res', sentence: goodResilient },
  ]);

  const invalidId = createVocabularyAdvisor({
    getConfig: () => config(),
    fetchImpl: async () => response(localEnvelope({ ids: ['not-a-candidate'], contexts: [] })),
  });
  await assert.rejects(invalidId({ provider: 'local', level: 'foundation', candidates: [{ id: 'met', word: 'meticulous', meaning: 'careful' }], recent: [] }), /无效候选词/);
  assert.equal(validSentence('The resilient team remained resilient while every member planned its next careful improvement.', 'resilient'), false);
  assert.equal(validSentence('The resilient team quietly revised its plan after the unexpected storm changed everything.', 'resilient'), true);
});

test('response size, cancellation, timeout, and changed settings cannot return a stale result', async () => {
  const input = { provider: 'local', level: 'foundation', candidates: [{ id: 'met', word: 'meticulous', meaning: 'careful' }], recent: [] };
  const oversized = createVocabularyAdvisor({
    getConfig: () => config(),
    fetchImpl: async () => response('x'.repeat(64 * 1024 + 1)),
  });
  await assert.rejects(oversized(input), /内容过长/);

  const pending = createVocabularyAdvisor({
    getConfig: () => config(),
    fetchImpl: async () => new Promise(() => {}),
    timeoutMs: 10,
  });
  await assert.rejects(pending(input), /超时/);

  const cancelController = new AbortController();
  const cancellable = createVocabularyAdvisor({
    getConfig: () => config(),
    fetchImpl: async () => new Promise(() => {}),
  });
  const cancelled = cancellable(input, { signal: cancelController.signal });
  cancelController.abort();
  await assert.rejects(cancelled, /取消/);

  let current = config();
  const changed = createVocabularyAdvisor({
    getConfig: () => current,
    fetchImpl: async () => {
      current = config({ localModel: 'another-model' });
      return response(localEnvelope({ ids: ['met'], contexts: [{ id: 'met', sentence: goodMeticulous }] }));
    },
  });
  await assert.rejects(changed(input), /设置已变更/);
});

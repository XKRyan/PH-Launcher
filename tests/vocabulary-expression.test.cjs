'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createExpressionChecker,
  parseLoopbackEndpoint,
  requestLocalOllama,
  validateInput,
  validateResult,
} = require('../electron/vocabulary-expression.cjs');

function localConfig(overrides = {}) {
  return {
    enabled: true,
    provider: 'local',
    localEndpoint: 'http://127.0.0.1:11434',
    localModel: 'qwen-test',
    ...overrides,
  };
}

test('checker uses only saved local endpoint/model and sends only the requested word and sentence', async () => {
  const calls = [];
  const input = { word: 'meticulous', sentence: 'She is meticulous to her notes.' };
  const checker = createExpressionChecker({
    getConfig: () => localConfig(),
    localChat: async (request) => {
      calls.push(request);
      return JSON.stringify({ corrected: 'She is meticulous about her notes.', notes: 'Use “meticulous about” here.' });
    },
  });

  const result = await checker(input);
  assert.deepEqual(result, {
    corrected: 'She is meticulous about her notes.',
    notes: 'Use “meticulous about” here.',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, 'http://127.0.0.1:11434/');
  assert.equal(calls[0].model, 'qwen-test');
  assert.equal(calls[0].messages.length, 2, 'school data and chat history must not be included');
  assert.deepEqual(JSON.parse(calls[0].messages[1].content), input);
  assert.equal(Object.hasOwn(calls[0], 'tools'), false);
  assert.match(calls[0].messages[0].content, /只提供建议，不评分/);
  assert.deepEqual(input, { word: 'meticulous', sentence: 'She is meticulous to her notes.' }, 'input is never overwritten');
});

test('disabled, API, missing-model, and remote configurations fail before any chat call', async () => {
  const rejected = [
    localConfig({ enabled: false }),
    localConfig({ provider: 'api' }),
    localConfig({ localModel: '' }),
    localConfig({ localEndpoint: 'http://example.com:11434' }),
    localConfig({ localEndpoint: 'https://example.com' }),
    localConfig({ localEndpoint: 'http://student:secret@127.0.0.1:11434' }),
  ];
  for (const config of rejected) {
    let calls = 0;
    const checker = createExpressionChecker({
      getConfig: () => config,
      localChat: async () => { calls += 1; return '{}'; },
    });
    await assert.rejects(checker({ word: 'word', sentence: 'A sentence.' }));
    assert.equal(calls, 0);
  }
});

test('loopback parser accepts the same local protocols without widening to remote hosts', () => {
  assert.equal(parseLoopbackEndpoint('http://localhost:11434').hostname, 'localhost');
  assert.equal(parseLoopbackEndpoint('https://127.0.0.1:11434').hostname, '127.0.0.1');
  assert.throws(() => parseLoopbackEndpoint('ftp://127.0.0.1/model'), /本机地址/);
  assert.throws(() => parseLoopbackEndpoint('http://127.0.0.1.example.test'), /本机地址/);
});

test('input is strictly bounded and cannot carry unrelated application data', () => {
  assert.deepEqual(validateInput({ word: '  word ', sentence: ' Example. ' }), { word: 'word', sentence: 'Example.' });
  assert.throws(() => validateInput({ word: 'word', sentence: 'Example.', school: { tasks: [] } }), /未授权字段/);
  assert.throws(() => validateInput({ word: 'x'.repeat(121), sentence: 'Example.' }), /词汇过长/);
  assert.throws(() => validateInput({ word: 'word', sentence: 'x'.repeat(2_001) }), /表达过长/);
  assert.throws(() => validateInput({ word: 'word', sentence: '\0' }), /无效字符/);
});

test('model output must be a small exact JSON object and remains untrusted text', () => {
  globalThis.expressionOwned = false;
  const result = validateResult('{"corrected":"<img onerror=globalThis.expressionOwned=true>","notes":"A suggestion only."}');
  assert.equal(result.corrected, '<img onerror=globalThis.expressionOwned=true>');
  assert.equal(globalThis.expressionOwned, false);
  assert.throws(() => validateResult('```json\n{"corrected":"x","notes":"y"}\n```'), /格式无效/);
  assert.throws(() => validateResult('{"corrected":"x","notes":"y","score":100}'), /格式无效/);
  assert.throws(() => validateResult('{"corrected":"x","notes":[]}'), /说明必须是文字/);
  delete globalThis.expressionOwned;
});

test('timeout rejects even when an injected local chat implementation does not observe abort', async () => {
  const checker = createExpressionChecker({
    getConfig: () => localConfig(),
    localChat: () => new Promise(() => {}),
    timeoutMs: 10,
  });
  await assert.rejects(checker({ word: 'word', sentence: 'A sentence.' }), /纠错超时/);
});

test('default Ollama request is POST-only, non-redirecting, bounded, and has no tools', async () => {
  let observed;
  const output = await requestLocalOllama({
    endpoint: 'http://127.0.0.1:11434/base',
    model: 'qwen-test',
    messages: [{ role: 'user', content: '{"word":"word","sentence":"Sentence."}' }],
    signal: new AbortController().signal,
    fetchImpl: async (url, options) => {
      observed = { url: String(url), options };
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ message: { content: '{"corrected":"Sentence.","notes":"No change."}' } }),
      };
    },
  });
  assert.equal(observed.url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(observed.options.method, 'POST');
  assert.equal(observed.options.redirect, 'error');
  const payload = JSON.parse(observed.options.body);
  assert.equal(payload.stream, false);
  assert.equal(payload.think, false);
  assert.equal(Object.hasOwn(payload, 'tools'), false);
  assert.match(output, /No change/);
});

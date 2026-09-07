'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { streamOllamaChat } = require('../electron/ai-stream.cjs');

function streamedResponse(chunks) {
  return {
    ok: true,
    body: new ReadableStream({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(new TextEncoder().encode(chunk)));
        controller.close();
      },
    }),
  };
}

test('Ollama NDJSON yields text before the final response finishes', async () => {
  const deltas = [];
  const result = await streamOllamaChat({
    url: 'http://127.0.0.1:11434/api/chat', payload: {}, onDelta: (delta) => deltas.push(delta),
    fetchImpl: async () => streamedResponse([
      '{"message":{"content":"你"}', ',"done":false}\n{"message":{"content":"好"},"done":false}\n',
      '{"message":{"content":"！"},"done":true}\n',
    ]),
  });
  assert.deepEqual(deltas, ['你', '好', '！']);
  assert.equal(result.content, '你好！');
});

test('an aborted stream cancels its reader so the local connection can close', async () => {
  let canceled = false;
  const controller = new AbortController();
  controller.abort(new Error('cancel'));
  await assert.rejects(streamOllamaChat({
    url: 'http://127.0.0.1:11434/api/chat', payload: {}, signal: controller.signal, onDelta: () => {},
    fetchImpl: async () => ({ ok: true, body: new ReadableStream({ cancel() { canceled = true; } }) }),
  }), /取消/);
  assert.equal(canceled, true);
});

test('malformed or truncated Ollama streams fail instead of becoming an empty answer', async () => {
  await assert.rejects(
    streamOllamaChat({ url: 'http://127.0.0.1:11434/api/chat', payload: {}, onDelta: () => {}, fetchImpl: async () => streamedResponse(['not json\n']) }),
    /无法识别/,
  );
  await assert.rejects(
    streamOllamaChat({ url: 'http://127.0.0.1:11434/api/chat', payload: {}, onDelta: () => {}, fetchImpl: async () => streamedResponse(['{"message":{"content":"半句"},"done":false}\n']) }),
    /提前结束/,
  );
});

test('stream size is bounded and local requests cannot follow redirects', async () => {
  let request;
  await assert.rejects(
    streamOllamaChat({
      url: 'http://127.0.0.1:11434/api/chat', payload: {}, onDelta: () => {},
      fetchImpl: async (_url, options) => { request = options; return streamedResponse(['x'.repeat(1_000_001)]); },
    }),
    /过长/,
  );
  assert.equal(request.redirect, 'error');
});

test('streaming remains text-only while launcher tools use the confirmed tool path', () => {
  const source = fs.readFileSync(require.resolve('../electron/main.cjs'), 'utf8');
  assert.match(source, /stream: Boolean\(onDelta && !tools\.length\)/);
  assert.match(source, /const launcherTools = .*filter\(tool => !\['upsert_schedule', 'list_schedule', 'preview_edupage_timetable'\]/);
  assert.match(source, /const offeredToolNames = new Set\(tools\.map\(\(tool\) => tool\.function\.name\)\)/);
  assert.match(source, /toolResultMessage\(config\.provider, call, result\)/);
});

test('only an enabled configured local model is prewarmed without blocking startup', () => {
  const source = fs.readFileSync(require.resolve('../electron/main.cjs'), 'utf8');
  assert.match(source, /keep_alive: '10m'/);
  assert.match(source, /function scheduleLocalAiWarmup[\s\S]*config\.provider !== 'local'/);
  assert.match(source, /if \(IS_HEADLESS \|\| !config\?\.enabled \|\| config\.provider !== 'local'/);
  assert.match(source, /createWindow\(\);[\s\S]*scheduleLocalAiWarmup\(\);/);
  assert.match(source, /cancelLocalAiWarmup\(\);\s*vocabularyStudy\?\.invalidate\(\);\s*vocabularyContextQueue\?\.cancel\(\); vocabularyCoachBridge\?\.cancel\(\);\s*aiLauncherReader = null;\s*const saved = secureStore\.updateAi\(config \|\| \{\}\);\s*scheduleLocalAiWarmup\(250\);/);
});

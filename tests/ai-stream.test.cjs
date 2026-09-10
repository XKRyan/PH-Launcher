'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { streamOllamaChat, streamOpenAiChat, sseStream } = require('../electron/ai-stream.cjs');

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

test('Ollama streams content deltas and tool calls from the same response', async () => {
  const deltas = [];
  const result = await streamOllamaChat({
    url: 'http://127.0.0.1:11434/api/chat', payload: {}, onDelta: (delta) => deltas.push(delta),
    fetchImpl: async () => streamedResponse([
      '{"message":{"content":"我先查一下。"},"done":false}\n',
      '{"message":{"content":"","tool_calls":[{"function":{"name":"get_ddl","arguments":{"days":14}}}]},"done":false}\n',
      '{"message":{"content":""},"done":true}\n',
    ]),
  });
  assert.deepEqual(deltas, ['我先查一下。']);
  assert.equal(result.content, '我先查一下。');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'get_ddl');
  assert.equal(result.toolCalls[0].function.arguments, JSON.stringify({ days: 14 }));
});

test('OpenAI SSE streams text and merges fragmented tool calls by index', async () => {
  const deltas = [];
  const result = await streamOpenAiChat({
    url: 'https://example.test/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    payload: { model: 'test', messages: [] },
    onDelta: (delta) => deltas.push(delta),
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).stream, true, 'the request asks for a stream');
      return streamedResponse([
        'data: {"choices":[{"delta":{"content":"今天"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"有两项"}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_ddl","arguments":"{\\"da"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ys\\":14}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    },
  });
  assert.deepEqual(deltas, ['今天', '有两项']);
  assert.equal(result.content, '今天有两项');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].id, 'call_1');
  assert.equal(result.toolCalls[0].function.name, 'get_ddl');
  assert.equal(result.toolCalls[0].function.arguments, '{"days":14}');
});

test('OpenAI SSE reports provider errors and ignores unknown frames', () => {
  const parser = sseStream(() => {});
  parser.push('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
  parser.push(': keep-alive comment\n\n');
  const result = parser.finish();
  assert.equal(result.content, 'ok');

  const failing = sseStream(() => {});
  assert.throws(() => failing.push('data: {"error":{"message":"额度不足"}}\n\n'), /额度不足/);
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

test('streaming works with tools while writes still take the confirmed tool path', () => {
  const source = fs.readFileSync(require.resolve('../electron/main.cjs'), 'utf8');
  // Streaming is no longer restricted to tool-free turns: content deltas and
  // tool calls arrive in the same response and are merged.
  assert.match(source, /stream: Boolean\(onDelta\)/);
  assert.doesNotMatch(source, /stream: Boolean\(onDelta && !tools\.length\)/);
  assert.match(source, /streamOpenAiChat\(\{ url: endpoint, headers, payload, signal: requestSignal, onDelta \}\)/);
  assert.match(source, /body\.toolCalls\?\.length \? \{ tool_calls: body\.toolCalls\.slice\(0, 16\) \}/);
  // The safety property is unchanged: writes are still proposals, never silent.
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

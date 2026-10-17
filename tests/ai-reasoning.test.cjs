'use strict';

/**
 * AI 的「思考内容」与线格式。
 *
 * 这些用例对着 2026-09-22 实际踩到的两个坑：
 *   1. 思考模式的模型（DeepSeek 的 deepseek-flash 等）把思考放在
 *      reasoning_content / thinking 里，与正文分开 —— 之前整段被丢掉，
 *      用户只看到长时间没动静，以为程序卡死。
 *   2. 同一个模型在**工具轮**强制要求把 reasoning_content 原样回传，
 *      否则第二轮被 400 拒：只要 AI 调用了工具就再也走不下去。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const {
  sseStream, anthropicSseStream, ndjsonStream, streamOpenAiChat,
} = require('../electron/ai-stream.cjs');
const {
  openAiMessages, needsReasoningPassthrough, emptyReplyMessage,
} = require('../electron/ai-messages.cjs');

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

function feed(parser, lines) {
  lines.forEach((line) => parser.push(line));
  return parser.finish();
}

test('OpenAI SSE keeps the reasoning stream separate from the answer', () => {
  const answer = [];
  const thinking = [];
  const parser = sseStream((t) => answer.push(t), (t) => thinking.push(t));
  const result = feed(parser, [
    'data: {"choices":[{"delta":{"reasoning_content":"先看课表，"}}]}\n',
    'data: {"choices":[{"delta":{"reasoning_content":"再查 ManageBac。"}}]}\n',
    'data: {"choices":[{"delta":{"content":"物理练习册"}}]}\n',
    'data: {"choices":[{"delta":{"content":" P32。"},"finish_reason":"stop"}]}\n',
    'data: [DONE]\n',
  ]);
  assert.deepEqual(thinking, ['先看课表，', '再查 ManageBac。']);
  assert.deepEqual(answer, ['物理练习册', ' P32。']);
  assert.equal(result.reasoning, '先看课表，再查 ManageBac。');
  assert.equal(result.content, '物理练习册 P32。');
  assert.equal(result.finishReason, 'stop', 'finish_reason 要留下来，空回复时靠它解释原因');
});

test('OpenAI SSE also accepts the alternate `reasoning` field name', () => {
  const thinking = [];
  const parser = sseStream(() => {}, (t) => thinking.push(t));
  const result = feed(parser, [
    'data: {"choices":[{"delta":{"reasoning":"想一下"}}]}\n',
    'data: {"choices":[{"delta":{"content":"好"}}]}\n',
  ]);
  assert.deepEqual(thinking, ['想一下']);
  assert.equal(result.reasoning, '想一下');
});

test('a provider that sends no reasoning still yields an empty reasoning string', () => {
  const parser = sseStream(() => {}, undefined);
  const result = feed(parser, ['data: {"choices":[{"delta":{"content":"嗨"}}]}\n']);
  assert.equal(result.reasoning, '', '没有思考时是空串，不是 undefined');
  assert.equal(result.content, '嗨');
});

test('Anthropic SSE streams thinking blocks and keeps stop_reason', () => {
  const answer = [];
  const thinking = [];
  const parser = anthropicSseStream((t) => answer.push(t), (t) => thinking.push(t));
  const result = feed(parser, [
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"用户要课表。"}}\n',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"今天三节。"}}\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n',
  ]);
  assert.deepEqual(thinking, ['用户要课表。']);
  assert.deepEqual(answer, ['今天三节。']);
  assert.equal(result.reasoning, '用户要课表。');
  assert.equal(result.finishReason, 'end_turn');
});

test('Ollama NDJSON picks up message.thinking', () => {
  const thinking = [];
  const parser = ndjsonStream(() => {}, (t) => thinking.push(t));
  const result = feed(parser, [
    '{"message":{"content":"","thinking":"先查本地资料。"},"done":false}\n',
    '{"message":{"content":"查到了。"},"done":true}\n',
  ]);
  assert.deepEqual(thinking, ['先查本地资料。']);
  assert.equal(result.reasoning, '先查本地资料。');
  assert.equal(result.content, '查到了。');
});

test('streamOpenAiChat forwards reasoning deltas to the caller', async () => {
  const answer = [];
  const thinking = [];
  const result = await streamOpenAiChat({
    url: 'https://example.test/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    payload: { model: 'test', messages: [] },
    onDelta: (delta) => answer.push(delta),
    onReasoning: (delta) => thinking.push(delta),
    fetchImpl: async () => streamedResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"想一想"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"答案"}}]}\n\n',
      'data: [DONE]\n\n',
    ]),
  });
  assert.deepEqual(thinking, ['想一想']);
  assert.deepEqual(answer, ['答案']);
  assert.equal(result.reasoning, '想一想');
});

test('openAiMessages drops internal fields before they reach the provider', () => {
  const wire = openAiMessages([
    { role: 'user', content: '你好', internalFlag: true },
    { role: 'assistant', content: '在的', reasoning: '打招呼', finishReason: 'stop' },
  ], false);
  assert.deepEqual(wire[0], { role: 'user', content: '你好' });
  assert.deepEqual(wire[1], { role: 'assistant', content: '在的' },
    'reasoning / finishReason 是本程序自己的字段，不能发给 provider');
});

test('tool rounds echo reasoning_content back, empty string when there is none', () => {
  const toolTurn = [{
    role: 'assistant', content: '', reasoning: '先查课表',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_ddl', arguments: '{}' } }],
  }, { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' }];

  const withThinking = openAiMessages(toolTurn, true);
  assert.equal(withThinking[0].reasoning_content, '先查课表');

  // 模型这一轮没产生思考时也必须给字符串：实测 null / 缺字段都会被 400 拒，"" 可以。
  const noThinking = openAiMessages([{ ...toolTurn[0], reasoning: undefined }], true);
  assert.equal(noThinking[0].reasoning_content, '');

  // 普通轮不加这个字段（只有工具轮强制要求）
  const plain = openAiMessages([{ role: 'assistant', content: '好', reasoning: 'x' }], true);
  assert.equal('reasoning_content' in plain[0], false);

  // 工具轮的 id / type / function 结构要原样保留
  assert.equal(withThinking[0].tool_calls[0].type, 'function');
  assert.equal(withThinking[0].tool_calls[0].function.name, 'get_ddl');
});

test('only the reasoning_content error triggers the retry', () => {
  assert.equal(needsReasoningPassthrough(new Error(
    'API 返回 400：{"error":{"message":"The `reasoning_content` in the thinking mode must be passed back to the API."}}',
  )), true);
  assert.equal(needsReasoningPassthrough(new Error('API 返回 401：invalid api key')), false,
    '鉴权错误不能靠重试掩盖');
  assert.equal(needsReasoningPassthrough(new Error('The operation was aborted')), false);
  assert.equal(needsReasoningPassthrough(undefined), false);
});

test('an empty reply explains what to change', () => {
  const config = { apiModel: 'deepseek-flash' };
  assert.match(emptyReplyMessage('length', config), /预算/);
  assert.match(emptyReplyMessage('length', config), /deepseek-flash/, '要点出是哪个模型');
  assert.match(emptyReplyMessage('content_filter', config), /拦截/);
  assert.match(emptyReplyMessage('', config), /没有返回任何内容/);
  assert.match(emptyReplyMessage('weird', { localModel: 'qwen2.5:7b' }), /qwen2\.5:7b/,
    '本地模型也要能报出名字');
});

test('main.cjs wires reasoning, streaming-with-tools and the empty-reply hint', () => {
  const source = fs.readFileSync(require.resolve('../electron/main.cjs'), 'utf8');
  assert.match(source, /onReasoning: \(text\) => \{[\s\S]{0,200}?type: 'reasoning'/,
    '思考增量要作为独立的流事件发出去');
  assert.match(source, /let receivedThinking = false/);
  assert.match(source, /const \{ openAiMessages, needsReasoningPassthrough, emptyReplyMessage \} = require\('\.\/ai-messages\.cjs'\)/);
  assert.match(source, /reasoningPassthroughKeys/);
  assert.match(source, /emptyReplyMessage\(lastAssistantFinishReason, config\)/,
    '空回复要走能照着修的提示，而不是"没有收到有效回复"');
  assert.doesNotMatch(source, /'没有收到有效回复。'/);
});

test('the chat surface renders Markdown and a collapsible thinking block', () => {
  const app = fs.readFileSync(require.resolve('../src/app.js'), 'utf8');
  assert.match(app, /function markdownToHtml\(value\)/);
  assert.match(app, /window\.marked/);
  assert.match(app, /window\.DOMPurify/);
  assert.match(app, /purify\.sanitize\(html/);
  assert.match(app, /FORBID_TAGS: \['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'\]/,
    '危险标签要显式禁掉：AI 回复是外部输入，而 window.ph.ai 能写文件/发邮件/交作业');
  // AI 的回复走 Markdown，用户自己打的字仍是纯文本
  assert.match(app, /message\.role === 'assistant' \? markdownToHtml\(visibleContent\) : escapeHtml\(visibleContent\)/);
  assert.match(app, /function thinkingMarkup\(reasoning, hasContent, forceOpen\)/);
  assert.match(app, /class="chat-thinking"/);
  // 流事件里的 reasoning 要攒进消息，并支持展开状态跨重渲染保留
  assert.match(app, /if \(event\.type === 'reasoning'\) message\.reasoning = \(message\.reasoning \|\| ''\) \+ String\(event\.delta \|\| ''\)/);
  assert.match(app, /chat-thinking[\s\S]{0,80}?state\.aiThinkingOpen = event\.target\.open/);
});

test('the vendored renderer is shipped with the app and declared in its notices', () => {
  const html = fs.readFileSync(require.resolve('../src/index.html'), 'utf8');
  assert.match(html, /<script src="\.\/vendor\/marked\.min\.js"><\/script>/);
  assert.match(html, /<script src="\.\/vendor\/purify\.min\.js"><\/script>/);
  const pkg = JSON.parse(fs.readFileSync(require.resolve('../package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('src/**/*'), 'src/vendor 要被打进安装包');
  const notices = fs.readFileSync(require.resolve('../THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.match(notices, /marked\]\(https:\/\/github\.com\/markedjs\/marked\), 12\.0\.2, MIT/);
  assert.match(notices, /DOMPurify\]\(https:\/\/github\.com\/cure53\/DOMPurify\), 3\.1\.6/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { openAiMessages, needsReasoningPassthrough } = require('../electron/ai-messages.cjs');

for (const withStatus of [false, true]) {
  test(`reasoning retry works with status callback ${withStatus}`, async () => {
    const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
    const fn = source.slice(source.indexOf('async function requestAiTurn('), source.indexOf('\nfunction toolResultMessage('));
    let calls = 0;
    const statuses = [];
    const sent = [];
    const request = vm.runInNewContext(`(${fn})`, {
      AbortSignal, URL, AI_REQUEST_TIMEOUT_MS: 10000,
      safeHttpUrl: value => new URL(value),
      openAiMessages, needsReasoningPassthrough, reasoningPassthroughKeys: new Set(),
      streamOpenAiChat: async ({ payload }) => {
        calls++;
        sent.push(payload);
        if (calls === 1) throw new Error('The reasoning_content in the thinking mode must be passed back to the API.');
        return { content: 'ok' };
      },
    });
    const result = await request({ provider: 'api', apiEndpoint: 'https://example.test/v1', apiModel: 'test', apiKey: 'synthetic' },
      [{ role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'test', arguments: '{}' } }] }], [],
      { onDelta() {}, ...(withStatus ? { onStatus: message => statuses.push(message) } : {}) });
    assert.equal(result.content, 'ok');
    assert.equal(calls, 2);
    assert.equal(sent[1].messages[0].reasoning_content, '');
    assert.equal(statuses.length, withStatus ? 1 : 0);
  });
}

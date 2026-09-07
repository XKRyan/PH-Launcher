'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCoachBridge } = require('../electron/vocabulary-coach-bridge.cjs');

function cards() {
  return [{ id: 'card-1', word: 'evidence', meaning: '证据', context: 'The evidence is clear.', contexts: ['New evidence changed the conclusion.'] }];
}

test('bridge sends only the selected stored card and its stored context', async () => {
  const received = []; const current = cards();
  const bridge = createCoachBridge({ getCards: () => current, language: () => 'en', coach: async (input) => { received.push(input); return { source: 'local', kind: 'answer', verdict: 'correct', explanation: 'Correct.', suggestion: 'evidence' }; } });
  const result = await bridge.run({ requestId: 'coach-1', cardId: 'card-1', kind: 'answer', provider: 'local', context: 'The evidence is clear.', answer: 'evidence', mail: 'must-not-pass' });
  assert.equal(result.verdict, 'correct');
  assert.deepEqual(received, [{ kind: 'answer', provider: 'local', word: 'evidence', language: 'en', meaning: '证据', context: 'The evidence is clear.', answer: 'evidence' }]);
  await assert.rejects(bridge.run({ requestId: 'coach-2', cardId: 'card-1', kind: 'translation', provider: 'local', context: 'Unstored context.' }), /例句已变化/);
});

test('late results are discarded after cancel or when the stored word changes', async () => {
  let finish; const current = cards();
  const bridge = createCoachBridge({ getCards: () => current, coach: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = bridge.run({ requestId: 'slow', cardId: 'card-1', kind: 'translation', provider: 'local', context: current[0].context });
  bridge.cancel({ requestId: 'slow' }); finish({ source: 'local', kind: 'translation', translation: '证据很清楚。' });
  assert.deepEqual(await pending, { canceled: true });
  const changed = bridge.run({ requestId: 'changed', cardId: 'card-1', kind: 'translation', provider: 'local', context: current[0].context });
  current[0] = { ...current[0], word: 'proof' }; finish({ source: 'local', kind: 'translation', translation: '证据很清楚。' });
  assert.deepEqual(await changed, { canceled: true });
});

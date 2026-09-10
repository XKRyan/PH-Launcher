const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const vocabulary = require('../electron/vocabulary.cjs');
const reading = require('../electron/vocabulary-reading.cjs');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'vocabulary-ui.js'), 'utf8');
const coachSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'vocabulary-coach-ui.js'), 'utf8');
const now = new Date('2026-09-06T08:00:00.000Z');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function snapshot(data) {
  return { ...vocabulary.snapshot(data, now), advisor: data.advisor, packs: [], catalog: [], placement: { level: '', questions: [] } };
}

function makeData(count, limit = count) {
  const data = vocabulary.emptyVocabulary();
  data.settings.dailyNewLimit = limit;
  vocabulary.addCards(data, Array.from({ length: count }, (_, index) => ({
    word: `word${String.fromCharCode(97 + index)}`,
    meaning: `释义 ${index + 1}`,
    context: `This is word${String.fromCharCode(97 + index)} in a complete example.`,
  })), now);
  return data;
}

function mountUI(data, { coach, prepareBatch, add, lookup, configureAdvisor, importReadingDocument } = {}) {
  const { window, document } = parseHTML('<main id="vocabularyPage" class="active"></main>');
  window.window = window;
  window.console = console;
  window.setInterval = () => 0;
  window.clearInterval = () => {};
  window.requestAnimationFrame = (callback) => callback();
  window.MutationObserver = class { observe() {} disconnect() {} };
  const dialogPrototype = window.HTMLDialogElement?.prototype || window.HTMLElement.prototype;
  dialogPrototype.showModal = function showModal() { this.open = true; this.setAttribute('open', ''); };
  dialogPrototype.close = function close() { this.open = false; this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  window.HTMLElement.prototype.reportValidity = () => true;
  window.FormData = class FormDataStub {
    constructor(form) { this.values = [...form.querySelectorAll('[name]')].map((field) => [field.name, field.value]); }
    *[Symbol.iterator]() { yield* this.values; }
  };
  window.SpeechSynthesisUtterance = class { constructor(word) { this.text = word; } };
  window.speechSynthesis = { cancel() {}, getVoices: () => [], speak() {} };
  const coachCalls = [];
  const prepareCalls = [];
  const cancelCalls = [];
  const addCalls = [];
  const advisorCalls = [];
  window.ph = { vocabulary: {
    get: async () => snapshot(data),
    importReadingDocument: importReadingDocument || (async () => ({ canceled: true })),
    review: async (input) => ({ result: vocabulary.reviewCard(data, input, now), snapshot: snapshot(data) }),
    update: async (input) => ({ result: vocabulary.updateCard(data, input), snapshot: snapshot(data) }),
    batchProgress: async (input) => ({ result: vocabulary.updateBatchProgress(data, input, now), snapshot: snapshot(data) }),
    undo: async () => ({ result: vocabulary.undoReview(data), snapshot: snapshot(data) }),
    configure: async (input) => ({ result: input, snapshot: snapshot(data) }),
    prepareBatch: prepareBatch ? async (input) => { prepareCalls.push(input); return prepareBatch(input); } : undefined,
    cancelPrepareBatch: async (input) => { cancelCalls.push(input); return { ok: true }; },
    configureAdvisor: configureAdvisor ? async (input) => { advisorCalls.push(input); return configureAdvisor(input); } : undefined,
    add: add ? async (input) => { addCalls.push(input); return add(input); } : undefined,
    coach: async (input) => {
      coachCalls.push(input);
      if (!coach) throw new Error('请先启用本地 AI');
      return coach(input);
    },
    cancelCoach: async () => ({ ok: true }),
  }, dictionary: { lookup: async (word) => lookup ? lookup(word) : { exact: null } } };
  const context = vm.createContext(window);
  vm.runInContext(coachSource, context, { filename: 'vocabulary-coach-ui.js' });
  vm.runInContext(source, context, { filename: 'vocabulary-ui.js' });
  return { window, document, coachCalls, prepareCalls, cancelCalls, addCalls, advisorCalls };
}

async function start(data, options) {
  const ui = mountUI(data, options);
  await ui.window.vocabularyUI.mount();
  await ui.window.vocabularyUI.refresh();
  ui.document.querySelector('[data-vocab-action="start"]').click();
  await flush();
  return ui;
}

function preparedBatch(data, source = 'local') {
  const current = snapshot(data);
  return { batchIds: current.queueIds.filter((id) => {
    const card = data.cards.find((item) => item.id === id);
    return card?.schedule?.state === 0 && card.schedule.reps === 0;
  }).slice(0, 5), source, snapshot: current };
}

async function revealAndRate(ui, rating = 3) {
  const reveal = ui.document.querySelector('[data-vocab-action="reveal"]');
  assert.ok(reveal, 'a recall card is ready to reveal');
  reveal.click(); await flush();
  const rate = ui.document.querySelector(`[data-vocab-action="rate"][data-rating="${rating}"]`);
  assert.ok(rate, 'a rating is available');
  rate.click(); await flush(); await flush();
}

test('failed batch preparation renders usable offline preview and a return button', async () => {
  const data = makeData(5);
  const ui = await start(data, { prepareBatch: async () => { throw Error('offline'); } });
  await flush();
  assert.equal(ui.document.querySelector('.vocab-batch-preparing'), null);
  assert.ok(ui.document.querySelector('.vocab-new-batch'));
  assert.ok(ui.document.querySelector('[data-vocab-action="return-study"]'));
  assert.equal(ui.prepareCalls.length, 1);
});

test('reopening midway through previews resumes the next unseen word, then restores remaining recall', async () => {
  const data = makeData(5); data.settings.mode = 'meaning';
  const first = await start(data);
  for (let i = 0; i < 2; i++) { first.document.querySelector('[data-vocab-action="batch-next"]').click(); await flush(); }
  const word = first.document.querySelector('.vocab-new-preview h3').textContent;
  assert.equal(data.batch.index, 2);
  const restarted = await start(data);
  assert.equal(restarted.document.querySelector('.vocab-new-preview h3').textContent, word);
  for (let i = 0; i < 2; i++) { restarted.document.querySelector('[data-vocab-action="batch-next"]').click(); await flush(); }
  restarted.document.querySelector('[data-vocab-action="start-batch-recall"]').click(); await flush();
  await revealAndRate(restarted);
  assert.equal(data.batch.ids.length, 4);
  const again = await start(data);
  assert.ok(again.document.querySelector('.vocab-study-card'));
  assert.equal(again.document.querySelector('.vocab-new-preview'), null);
});

test('five new words all preview before their group enters recall', async () => {
  const data = makeData(5);
  const { document } = await start(data);
  const previews = [];
  for (let index = 0; index < 5; index++) {
    const preview = document.querySelector('.vocab-new-batch');
    assert.ok(preview, `preview ${index + 1} is visible`);
    previews.push(preview.querySelector('h3').textContent);
    assert.match(preview.textContent, /complete example/);
    assert.equal(document.querySelector('.vocab-study-card'), null);
    if (index < 4) {
      document.querySelector('[data-vocab-action="batch-next"]').click();
      await flush();
    }
  }
  assert.ok(document.querySelector('[data-vocab-action="start-batch-recall"]'));
  assert.equal(document.querySelector('.vocab-study-card'), null);
  document.querySelector('[data-vocab-action="start-batch-recall"]').click();
  await flush();
  assert.ok(document.querySelector('.vocab-study-card'));
  assert.match(document.querySelector('.vocab-study-card').textContent, /complete example/);
  assert.equal(data.logs.length, 0);
});

test('skips refill to five unfamiliar previews; recall starts in a different order', async () => {
  const data = makeData(8);
  const ui = await start(data);
  const previews = [];
  for (let i = 0; i < 3; i++) {
    ui.document.querySelector('[data-vocab-action="known-new"]').click(); await flush();
    assert.match(ui.document.querySelector('.vocab-chip').textContent, /1 \/ 5/);
  }
  for (let i = 0; i < 5; i++) {
    previews.push(ui.document.querySelector('.vocab-new-batch h3').textContent);
    ui.document.querySelector(`[data-vocab-action="${i < 4 ? 'batch-next' : 'start-batch-recall'}"]`).click(); await flush();
  }
  assert.equal(new Set(previews).size, 5);
  assert.equal(data.cards.filter(c => c.suspended).length, 3);
  assert.equal(data.logs.length, 0);
  const prompt = ui.document.querySelector('.vocab-study-card').textContent;
  assert.ok(prompt.includes('_____'));
});

test('skipping the last preview of the last group starts recall of only the unfamiliar words', async () => {
  const data = makeData(3);
  const ui = await start(data);
  for (let i = 0; i < 2; i++) { ui.document.querySelector('[data-vocab-action="batch-next"]').click(); await flush(); }
  ui.document.querySelector('[data-vocab-action="known-new"]').click(); await flush();
  assert.equal(ui.document.querySelector('.vocab-new-batch'), null);
  assert.ok(ui.document.querySelector('.vocab-study-card'));
  assert.equal(data.cards.filter(c => c.suspended).length, 1);
  assert.equal(data.logs.length, 0);
});

test('wordbook import is visible from home and reading document import fills an editable draft', async () => {
  const data = makeData(1);
  const ui = mountUI(data, { importReadingDocument: async () => ({ title: 'Test document', text: 'A complete English reading passage.', warning: 'Check the extracted text.' }) });
  await ui.window.vocabularyUI.mount(); await ui.window.vocabularyUI.refresh();
  assert.equal(ui.document.querySelector('[data-vocab-action="import"]').textContent, '导入词书');
  ui.document.querySelector('[data-vocab-action="reading"]').click(); await flush();
  ui.document.querySelector('[data-vocab-action="import-reading"]').click(); await flush(); await flush();
  const form = ui.document.querySelector('#vocabReadingForm');
  assert.equal(form.querySelector('[name="text"]').value, 'A complete English reading passage.');
  assert.equal(form.querySelector('[name="title"]').value, 'Test document');
  assert.match(ui.document.querySelector('#vocabDocumentStatus').textContent, /Check/);
  assert.equal(data.readings.length, 0, 'document is not saved before the user confirms');
});

test('a pure-new queue is labelled as new learning, not review', async () => {
  const data = makeData(1);
  const ui = mountUI(data);
  await ui.window.vocabularyUI.mount();
  await ui.window.vocabularyUI.refresh();
  const button = ui.document.querySelector('[data-vocab-action="start"]');
  assert.equal(button.textContent.replace(/\s+/g, ''), '开始学新词→');
});

test('recognised new words are suspended without a review log', async () => {
  const data = makeData(3);
  const { document } = await start(data);
  const word = document.querySelector('.vocab-new-batch h3').textContent;
  document.querySelector('[data-vocab-action="known-new"]').click();
  await flush();
  assert.equal(data.logs.length, 0);
  assert.equal(data.cards.find((card) => card.word === word).suspended, true);
  assert.ok(document.querySelector('.vocab-new-batch'));
  assert.match(document.querySelector('#vocabularyPage').textContent, /已跳过这个词|新词预览/);
});

test('due reviews go directly to recall, without a new-word preview', async () => {
  const data = makeData(1);
  const card = data.cards[0];
  vocabulary.reviewCard(data, { id: card.id, expectedReps: 0, rating: 1, mode: 'meaning' }, new Date(now.getTime() - 2 * 60000));
  const { document } = await start(data);
  assert.ok(document.querySelector('.vocab-study-card'));
  assert.equal(document.querySelector('.vocab-new-batch'), null);
});

test('a new batch prepares once, can start offline immediately, and ignores the late result', async () => {
  const data = makeData(3);
  let resolvePreparation;
  const ui = mountUI(data, { prepareBatch: () => new Promise((resolve) => { resolvePreparation = resolve; }) });
  await ui.window.vocabularyUI.mount();
  await ui.window.vocabularyUI.refresh();
  ui.document.querySelector('[data-vocab-action="start"]').click();
  await flush();
  assert.equal(ui.prepareCalls.length, 1);
  assert.ok(ui.document.querySelector('.vocab-batch-preparing'));
  assert.ok(ui.document.querySelector('[data-vocab-action="return-study"]'));
  ui.document.querySelector('[data-vocab-action="start-offline-batch"]').click();
  await flush();
  assert.equal(ui.cancelCalls.length, 1);
  assert.ok(ui.document.querySelector('.vocab-new-batch'));
  const offlineWord = ui.document.querySelector('.vocab-new-batch h3').textContent;
  resolvePreparation({ batchIds: data.cards.slice().reverse().map((card) => card.id), source: 'local', snapshot: snapshot(data) });
  await flush(); await flush();
  assert.equal(ui.document.querySelector('.vocab-new-batch h3').textContent, offlineWord);
  assert.equal(data.logs.length, 0);
});

test('missing context is labelled as unavailable instead of silently posing as a blank exercise', async () => {
  const data = makeData(1);
  data.cards[0].context = '';
  data.settings.mode = 'context';
  const { document } = await start(data);
  assert.match(document.querySelector('.vocab-new-batch').textContent, /没有完整例句/);
  document.querySelector('[data-vocab-action="start-batch-recall"]').click();
  await flush();
  assert.match(document.querySelector('.vocab-study-card').textContent, /语境填空暂不可用/);
  assert.match(document.querySelector('.vocab-study-card').textContent, /这次会用看词回忆练习/);
});

test('a context blank is used only when the word occurs exactly once', async () => {
  const data = makeData(1);
  data.settings.mode = 'context';
  data.cards[0].context = 'worda appears here, then worda appears again.';
  const { document } = await start(data);
  document.querySelector('[data-vocab-action="start-batch-recall"]').click();
  await flush();
  const study = document.querySelector('.vocab-study-card');
  assert.match(study.textContent, /语境填空暂不可用/);
  assert.match(study.textContent, /看词回忆练习/);
  assert.doesNotMatch(study.textContent, /_____/);
});

test('finishing a five-word group prepares exactly one second group', async () => {
  const data = makeData(10);
  data.settings.mode = 'meaning';
  const ui = await start(data, { prepareBatch: async () => preparedBatch(data) });
  await flush(); await flush();
  assert.equal(ui.prepareCalls.length, 1);
  for (let index = 0; index < 4; index++) {
    ui.document.querySelector('[data-vocab-action="batch-next"]').click();
    await flush();
  }
  const recall = ui.document.querySelector('[data-vocab-action="start-batch-recall"]');
  assert.ok(recall, ui.document.querySelector('#vocabularyPage').textContent);
  recall.click(); await flush();
  for (let index = 0; index < 5; index++) await revealAndRate(ui);
  assert.equal(ui.prepareCalls.length, 2);
  assert.ok(ui.document.querySelector('.vocab-new-batch'));
  await flush(); await flush();
  assert.equal(ui.prepareCalls.length, 2, 'renders do not silently prepare the same group again');
});

test('a due review starts the next new batch through prepareBatch', async () => {
  const data = makeData(3);
  data.settings.mode = 'meaning';
  const due = data.cards[0];
  vocabulary.reviewCard(data, { id: due.id, expectedReps: 0, rating: 1, mode: 'meaning' }, new Date(now.getTime() - 2 * 60000));
  const ui = await start(data, { prepareBatch: async () => preparedBatch(data) });
  assert.equal(ui.prepareCalls.length, 0);
  assert.ok(ui.document.querySelector('.vocab-study-card'));
  await revealAndRate(ui);
  assert.equal(ui.prepareCalls.length, 1);
  assert.ok(ui.document.querySelector('.vocab-new-batch'));
});

test('skipping known words refills the current group without another paid recommendation or review logs', async () => {
  const data = makeData(6);
  const ui = await start(data, { prepareBatch: async () => preparedBatch(data) });
  assert.equal(ui.prepareCalls.length, 1);
  for (let index = 0; index < 5; index++) {
    const known = ui.document.querySelector('[data-vocab-action="known-new"]');
    assert.ok(known, `preview ${index + 1} can be skipped`);
    known.click(); await flush(); await flush();
  }
  assert.equal(data.logs.length, 0);
  assert.equal(ui.prepareCalls.length, 1);
  assert.ok(ui.document.querySelector('.vocab-new-batch'));
});

test('a cancelled preparation returns to a usable offline batch exactly once', async () => {
  const data = makeData(2);
  const ui = await start(data, { prepareBatch: async () => ({ canceled: true, snapshot: snapshot(data) }) });
  await flush(); await flush();
  assert.equal(ui.prepareCalls.length, 1);
  assert.equal(ui.document.querySelector('.vocab-batch-preparing'), null);
  assert.ok(ui.document.querySelector('.vocab-new-batch'));
  assert.ok(ui.document.querySelector('[data-vocab-action="return-study"]'));
});

test('API next-group recommendation sends no consent or request until its separate risk check is accepted', async () => {
  const data = makeData(1);
  const ui = mountUI(data, { configureAdvisor: async (input) => ({ result: input, snapshot: snapshot(data) }) });
  await ui.window.vocabularyUI.mount(); await ui.window.vocabularyUI.refresh();
  const provider = ui.document.querySelector('#vocabAdvisorProvider');
  for (const option of provider.querySelectorAll('option')) option.toggleAttribute('selected', option.value === 'api');
  Object.defineProperty(provider, 'value', { value: 'api', configurable: true });
  provider.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  await flush();
  assert.equal(ui.advisorCalls.length, 0);
  assert.ok(ui.document.querySelector('#vocabAdvisorApiConsent'));
  ui.document.querySelector('#vocabAdvisorApiConsent').checked = true;
  ui.document.querySelector('#vocabRememberApiConsent').checked = true;
  ui.document.querySelector('[data-vocab-action="confirm-advisor-api"]').click();
  await flush();
  assert.equal(JSON.stringify(ui.advisorCalls), JSON.stringify([{ provider: 'api', apiConsent: true, rememberApiConsent: true }]));
});

test('drag-selecting an in-reader phrase looks it up and adds its original sentence without re-rendering the reader', async () => {
  const data = makeData(0);
  reading.saveReading(data, { title: 'A reading', text: 'The evidence is clear.' }, now);
  const ui = mountUI(data, {
    lookup: async () => ({ exact: { word: 'evidence', translation: '证据', phonetic: '/ˈevɪdəns/' } }),
    add: async (input) => ({ result: { added: 1, contextsAdded: 0 }, snapshot: snapshot(data) }),
  });
  await ui.window.vocabularyUI.mount(); await ui.window.vocabularyUI.refresh();
  ui.document.querySelector('[data-vocab-action="tools"]').click();
  await flush();
  ui.document.querySelector('[data-vocab-action="reading"]').click();
  await flush();
  assert.match(ui.document.querySelector('#vocabularyPage').textContent, /我的阅读书架/);
  ui.document.querySelector('[data-vocab-action="open-reading"]').click();
  await flush();
  const reader = ui.document.querySelector('.vocab-reader-text');
  const selectedNode = reader.querySelector('[data-word="evidence"]').firstChild;
  ui.window.getSelection = () => ({ isCollapsed: false, rangeCount: 1, toString: () => 'evidence', getRangeAt: () => ({ startContainer: selectedNode, endContainer: selectedNode }), removeAllRanges() {} });
  reader.dispatchEvent(new ui.window.Event('mouseup', { bubbles: true }));
  await flush(); await flush();
  assert.equal(ui.addCalls.length, 1);
  assert.equal(JSON.stringify(ui.addCalls[0][0]), JSON.stringify({ word: 'evidence', meaning: '证据', context: 'The evidence is clear.', subject: '阅读生词', source: 'A reading' }));
  assert.ok(ui.document.querySelector('.vocab-reader-text'));
  assert.match(ui.document.querySelector('#vocabDialog').textContent, /已加入词本/);
});

test('example translation is lazy, honors the selected API, and keeps the example selection offline', async () => {
  const data = makeData(1); data.settings.advisorProvider = 'api'; data.advisor = { apiConsented: true };
  const ui = await start(data, {
    coach: async (input) => ({ source: input.provider, kind: 'translation', translation: '这是一个完整例句。' }),
    lookup: async () => ({ exact: { word: 'worda', translation: '词义' } }),
    add: async (input) => ({ result: { added: 1 }, snapshot: snapshot(data) }),
  });
  const details = ui.document.querySelector('[data-coach-translation]');
  assert.equal(ui.coachCalls.length, 0, 'a collapsed translation must not request AI');
  details.open = true; details.dispatchEvent(new ui.window.Event('toggle', { bubbles: true })); await flush(); await flush();
  assert.equal(ui.coachCalls.length, 1); assert.equal(ui.coachCalls[0].provider, 'api');
  assert.match(details.textContent, /API AI/); assert.doesNotMatch(details.textContent, /本地 AI 检查中/);
  const text = ui.document.querySelector('.vocab-example-text'); const node = text.firstChild;
  ui.window.getSelection = () => ({ isCollapsed: false, rangeCount: 1, toString: () => 'worda', getRangeAt: () => ({ startContainer: node, endContainer: node }), removeAllRanges() {} });
  text.dispatchEvent(new ui.window.Event('mouseup', { bubbles: true })); await flush(); await flush();
  assert.equal(ui.addCalls.length, 1);
  assert.equal(ui.addCalls[0][0].context, 'This is worda in a complete example.');
  assert.equal(ui.addCalls[0][0].source, '背单词例句');
});

test('own expression accepts a local suggestion only when saved and an open editor blocks rating shortcuts', async () => {
  const data = makeData(1);
  const card = data.cards[0];
  vocabulary.reviewCard(data, { id: card.id, expectedReps: 0, rating: 1, mode: 'meaning' }, new Date(now.getTime() - 2 * 60000));
  const { window, document, coachCalls } = await start(data, { coach: async (input) => ({ source: input.provider, kind: 'expression', corrected: `${input.expression} Corrected.`, notes: '调整搭配。' }) });
  document.querySelector('[data-vocab-action="reveal"]').click();
  await flush();
  document.querySelector('[data-vocab-action="expression"]').click();
  await flush();
  const editor = document.querySelector('#vocabEditForm [name="ownExample"]');
  assert.equal(editor, null);
  const expression = document.querySelector('#vocabExpressionForm [name="ownExample"]');
  expression.value = 'I use worda in my own sentence.';
  expression.dispatchEvent(new window.Event('input', { bubbles: true }));
  const reviewCount = data.logs.length;
  const ratingKey = new window.Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(ratingKey, 'key', { value: '3' });
  document.dispatchEvent(ratingKey);
  assert.equal(data.logs.length, reviewCount);
  assert.equal(expression.value, 'I use worda in my own sentence.');
  assert.deepEqual(coachCalls, []);
  document.querySelector('[data-vocab-action="check-expression"]').click();
  await flush(); await flush();
  assert.equal(coachCalls.length, 1);
  assert.equal(coachCalls[0].cardId, card.id);
  assert.equal(coachCalls[0].expression, 'I use worda in my own sentence.');
  assert.equal(expression.value, 'I use worda in my own sentence.');
  assert.match(document.querySelector('#vocabExpressionAdvice').textContent, /建议|调整搭配/);
  document.querySelector('[data-coach-apply]').click();
  assert.equal(expression.value, 'I use worda in my own sentence. Corrected.');
  assert.equal(data.cards[0].ownExample, '');
  document.querySelector('[data-vocab-action="save-expression"]').click();
  await flush(); await flush();
  assert.equal(data.cards[0].ownExample, 'I use worda in my own sentence. Corrected.');
  assert.equal(data.logs.length, reviewCount);
});

test('local AI failure leaves the expression draft intact', async () => {
  const data = makeData(1);
  const card = data.cards[0];
  vocabulary.reviewCard(data, { id: card.id, expectedReps: 0, rating: 1, mode: 'meaning' }, new Date(now.getTime() - 2 * 60000));
  const { window, document, coachCalls } = await start(data);
  document.querySelector('[data-vocab-action="reveal"]').click();
  await flush();
  document.querySelector('[data-vocab-action="expression"]').click();
  await flush();
  const expression = document.querySelector('#vocabExpressionForm [name="ownExample"]');
  expression.value = 'My draft must survive.';
  expression.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.querySelector('[data-vocab-action="check-expression"]').click();
  await flush(); await flush();
  assert.equal(coachCalls.length, 1);
  assert.equal(expression.value, 'My draft must survive.');
  assert.match(document.querySelector('#vocabExpressionAdvice').textContent, /所选 AI 尚未就绪/);
  assert.equal(data.logs.length, 1);
});

function hash(day, id) {
  let value = 2166136261;
  for (const char of `${day}|${id}`) { value ^= char.charCodeAt(0); value = Math.imul(value, 16777619); }
  return value >>> 0;
}

test('new-word shuffle is stable, respects quota, and undo restores its place', () => {
  const data = makeData(7, 2);
  const expected = [...data.cards].sort((a, b) => hash('2026-09-06', a.id) - hash('2026-09-06', b.id) || a.id.localeCompare(b.id)).slice(0, 2).map((card) => card.id);
  const first = vocabulary.queue(data, now).map((card) => card.id);
  assert.deepEqual(first, expected);
  assert.deepEqual(vocabulary.queue(data, now).map((card) => card.id), first);
  vocabulary.reviewCard(data, { id: first[0], expectedReps: 0, rating: 3, mode: 'meaning' }, now);
  assert.equal(vocabulary.queue(data, now).filter((card) => card.schedule.state === 0).length, 1);
  vocabulary.undoReview(data);
  assert.deepEqual(vocabulary.queue(data, now).map((card) => card.id), first);
});

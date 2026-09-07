const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'vocabulary-ui.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'vocabulary.css'), 'utf8');

test('new cards use a preview batch and advanced tools are not default tabs', () => {
  assert.match(ui, /slice\(0, 5\)/);
  assert.match(ui, /新词预览 · 第/);
  assert.match(ui, /'start-batch-recall'/);
  assert.match(ui, /'known-new'/);
  assert.match(ui, /开始学新词/);
  assert.match(ui, /更多工具/);
  assert.doesNotMatch(ui, /<button data-vocab-action="reading" class="\$\{state\.view === 'reading'/);
});

test('dialog close control has a square centered target and a concentric focus ring', () => {
  assert.match(css, /\.vocab-dialog-head > button \{ display: grid; place-items: center;/);
  assert.match(css, /width: 2rem; height: 2rem; min-width: 2rem; padding: 0; line-height: 1;/);
  assert.match(css, /\.vocab-dialog-head > button:focus-visible \{ outline-offset: 2px;/);
});

test('due-review dashboard translates real dynamic state and round trips without touching study content', async () => {
  const { window } = parseHTML('<html><body><main id="vocabularyPage"></main></body></html>');
  const context = {
    window, document: window.document, console, queueMicrotask,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: callback => callback(),
    setInterval: () => 0,
    clearInterval: () => {},
  };
  const cards = [
    ...Array.from({ length: 5 }, (_, index) => ({ id: `due-${index}`, word: `review-${index}`, meaning: `用户释义 ${index}`, subject: '用户词本', schedule: { state: 2, reps: 1 } })),
    ...Array.from({ length: 4 }, (_, index) => ({ id: `new-${index}`, word: `new-${index}`, meaning: `用户释义 ${index + 5}`, subject: '用户词本', schedule: { state: 0, reps: 0 } })),
  ];
  window.ph = { vocabulary: { get: async () => ({
    cards,
    queueIds: cards.map(card => card.id),
    stats: { total: cards.length, todayReviews: 8, todayWords: 6, days: [], nextDue: null },
    study: { newAtLevel: 4, level: 'intermediate' },
    settings: { level: 'intermediate', advisorProvider: 'off', advisorIntroSeen: true },
    advisor: { localAvailable: false },
  }) } };
  for (const file of ['locales/en.js', 'i18n.js', 'vocabulary-ui.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'), context);
  }
  window.i18n.mount('en');
  await window.vocabularyUI.refresh();
  await new Promise(resolve => setImmediate(resolve));

  const page = window.document.getElementById('vocabularyPage');
  assert.match(page.textContent, /6 unique words/);
  assert.match(page.textContent, /Complete today’s due reviews first\./);
  assert.match(page.textContent, /5 due words will appear first; new words will be previewed in groups after the reviews\./);
  assert.match(page.textContent, /4 new words available after the reviews/);
  assert.doesNotMatch(page.textContent, /(?:个不同单词|到期词会先出现|复习后还有)/);

  window.i18n.apply('zh-CN');
  assert.match(page.textContent, /6 个不同单词/);
  assert.match(page.textContent, /先完成今天到期的复习。/);
  assert.match(page.textContent, /有 5 个到期词会先出现；新词会在复习后按小组预览。/);
  assert.match(page.textContent, /复习后还有 4 个新词可学/);
  assert.match(page.textContent, /用户词本/);

  window.i18n.apply('en');
  assert.match(page.textContent, /6 unique words/);
  assert.match(page.textContent, /用户词本/);
});

test('check due words shows progress and starts a newly available review', async () => {
  const { window } = parseHTML('<html><body><main id="vocabularyPage"></main></body></html>');
  const context = {
    window, document: window.document, console, queueMicrotask,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: callback => callback(), setInterval: () => 0, clearInterval: () => {}
  };
  let reads = 0;
  const empty = { cards: [], queueIds: [], intervals: { 1: null, 2: null, 3: null, 4: null }, stats: { total: 1, todayReviews: 0, todayWords: 0, days: [], nextDue: null }, study: {}, settings: { mode: 'mixed', advisorProvider: 'off', advisorIntroSeen: true } };
  const firstDue = { ...empty, cards: [{ id: 'due-old', word: 'review', meaning: '复习', subject: 'My words', schedule: { state: 2, reps: 1 } }], queueIds: ['due-old'], stats: { ...empty.stats, todayReviews: 1 } };
  const newDue = { ...empty, cards: [{ id: 'due-now', word: 'evidence', meaning: '证据', subject: 'My words', schedule: { state: 2, reps: 1 } }], queueIds: ['due-now'], stats: { ...empty.stats, todayReviews: 1 } };
  window.ph = { vocabulary: { get: async () => (++reads === 1 ? firstDue : newDue), review: async () => ({ snapshot: empty, result: { nextDue: null } }) } };
  for (const file of ['locales/en.js', 'i18n.js', 'vocabulary-ui.js']) vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'), context);
  window.i18n.mount('en');
  await window.vocabularyUI.refresh();
  const page = window.document.getElementById('vocabularyPage');
  page.querySelector('[data-vocab-action="start"]').click();
  await new Promise(resolve => setImmediate(resolve));
  page.querySelector('[data-vocab-action="reveal"]').click();
  page.querySelector('[data-vocab-action="rate"]').click();
  await new Promise(resolve => setImmediate(resolve));
  const check = page.querySelector('[data-vocab-action="check-due"]');
  assert.ok(check, 'empty study view should offer a due-word check');
  check.click();
  assert.match(page.textContent, /正在检查到期词/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 2);
  assert.match(page.textContent, /evidence/);
  assert.match(page.textContent, /Found 1 due words\. Review started\./);
});

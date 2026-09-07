'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const appSource = fs.readFileSync(require.resolve('../src/app.js'), 'utf8');
const indexSource = fs.readFileSync(require.resolve('../src/index.html'), 'utf8');
const refinements = fs.readFileSync(require.resolve('../src/refinements.css'), 'utf8');
const badgeSource = appSource.slice(
  appSource.indexOf('function setNavCountBadge'),
  appSource.indexOf('\nfunction renderDashboard', appSource.indexOf('function setNavCountBadge')),
);

function harness(vocabulary = {}) {
  const { window } = parseHTML(indexSource);
  const context = {
    window: { ph: { vocabulary } },
    document: window.document,
    $: (selector) => window.document.querySelector(selector),
    vocabularyBadgeRequest: 0,
  };
  vm.runInNewContext(`${badgeSource}\nthis.badges = { setNavCountBadge, updateVocabularyBadge, refreshVocabularyBadge };`, context);
  return { window, badges: context.badges };
}

test('plan and vocabulary use the same centered badge structure', () => {
  const { window } = harness();
  const plan = window.document.querySelector('#navTaskCount');
  const vocabulary = window.document.querySelector('#vocabularyDueCount');
  assert.ok(plan.classList.contains('nav-count-badge'));
  assert.ok(vocabulary.classList.contains('nav-count-badge'));
  assert.equal(vocabulary.getAttribute('aria-hidden'), 'true');
  assert.match(refinements, /\.nav-item > \.nav-count-badge[\s\S]*display:inline-grid[\s\S]*place-items:center/);
  assert.match(refinements, /font-size:clamp\(12px,\.75rem,14px\)/);
  assert.match(refinements, /line-height:1/);
});

test('zero is hidden, large counts show 99+, and accessible text keeps the real count', () => {
  const ui = harness();
  ui.badges.setNavCountBadge('#vocabularyDueCount', '#vocabularyNav', '背单词', 0);
  assert.equal(ui.window.document.querySelector('#vocabularyDueCount').classList.contains('hidden'), true);
  assert.equal(ui.window.document.querySelector('#vocabularyNav').getAttribute('aria-label'), '背单词');
  ui.badges.setNavCountBadge('#vocabularyDueCount', '#vocabularyNav', '背单词', 143);
  assert.equal(ui.window.document.querySelector('#vocabularyDueCount').textContent, '99+');
  assert.equal(ui.window.document.querySelector('#vocabularyDueCount').dataset.count, '143');
  assert.equal(ui.window.document.querySelector('#vocabularyNav').getAttribute('aria-label'), '背单词，143 项待处理');
});

test('vocabulary badge consumes stats.due and never treats queued new words as due reviews', async () => {
  let calls = 0;
  const ui = harness({ get: async () => { calls += 1; return { stats: { due: 4 }, queueIds: Array(80).fill('new-word') }; } });
  await ui.badges.refreshVocabularyBadge();
  assert.equal(calls, 1);
  assert.equal(ui.window.document.querySelector('#vocabularyDueCount').textContent, '4');
  assert.equal(ui.window.document.querySelector('#vocabularyDueCount').dataset.count, '4');
});

test('lightweight due-count IPC is preferred and mutation events update immediately when available', async () => {
  let lightweightCalls = 0;
  let fullCalls = 0;
  const ui = harness({
    dueCount: async () => { lightweightCalls += 1; return { due: 7 }; },
    get: async () => { fullCalls += 1; return { stats: { due: 99 } }; },
  });
  await ui.badges.refreshVocabularyBadge();
  ui.badges.updateVocabularyBadge({ due: 2 });
  assert.equal(lightweightCalls, 1);
  assert.equal(fullCalls, 0);
  assert.equal(ui.window.document.querySelector('#vocabularyDueCount').textContent, '2');
});

test('startup, vocabulary navigation, mutation events, and minute rollover all have refresh hooks', () => {
  assert.match(appSource, /void refreshVocabularyBadge\(\)/);
  assert.match(appSource, /route === 'vocabulary'[\s\S]*refreshVocabularyBadge\(\)/);
  assert.match(appSource, /vocabulary\?\.onChanged\?\.\(\(payload\) => updateVocabularyBadge\(payload\)\)/);
  assert.match(appSource, /setInterval\(\(\) => \{ updateClock\(\); refreshVocabularyBadge\(\); void window\.mailUI\?\.open\?\.\(\); \}, 60_000\)/);
});

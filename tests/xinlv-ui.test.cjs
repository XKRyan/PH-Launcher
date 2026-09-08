"use strict";

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const source = fs.readFileSync(require.resolve('../src/xinlv-ui.js'), 'utf8');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness({ configured = true, loginFails = false, chatResult = { crisis: false, reply: '我在听。', hotline: '' } } = {}) {
  const { window } = parseHTML('<!doctype html><html><body><section id="psychologyPage"></section><section id="xinlvPage"></section></body></html>');
  const calls = { status: 0, list: 0, add: [], edit: [], remove: [], sync: 0, login: [], recommend: [], chat: [], clearChat: 0, logout: 0, opened: [] };
  const entries = [
    { uuid: 'e1', date: '2026-09-06', mood: 'calm', note: '<img src=x onerror=alert(1)>今天还行', intensityLevel: 3, intensityPercent: 50, deleted: false, createdAt: '2026-09-06T20:00:00Z', updatedAt: '2026-09-06T20:00:00Z' },
    { uuid: 'e2', date: '2026-09-04', mood: 'anxious', note: '', intensityLevel: 4, intensityPercent: 70, deleted: false, createdAt: '2026-09-04T09:00:00Z', updatedAt: '2026-09-04T09:00:00Z' },
  ];
  window.ph = {
    xinlv: {
      status: async () => { calls.status += 1; return { configured, username: configured ? 'student' : '', tokenPresent: configured, totalEntries: entries.length, pendingSync: 0, lastServerTime: 'cursor-1' }; },
      list: async () => { calls.list += 1; return entries; },
      add: async (input) => { calls.add.push(input); return { uuid: 'new', ...input }; },
      edit: async (input) => { calls.edit.push(input); return input; },
      remove: async (uuid) => { calls.remove.push(uuid); return true; },
      sync: async () => { calls.sync += 1; return { pushed: 1, pulled: 2, errors: [], offline: false, total: entries.length }; },
      login: async (input) => { calls.login.push(input); if (loginFails) { const error = new Error('账号或密码不正确'); throw error; } return { configured: true, username: input.username, tokenPresent: true, totalEntries: 0, pendingSync: 0 }; },
      register: async (input) => { calls.login.push({ ...input, register: true }); return { configured: true, username: input.username }; },
      logout: async () => { calls.logout += 1; return { configured: false }; },
      profile: async () => ({ username: 'student', streak: 12, badges: ['第一周'], totalEntries: 2, dateJoined: '2026-01-01' }),
      history: async () => [{ role: 'user', content: '你好', created_at: '2026-09-06T20:00:00Z' }, { role: 'assistant', content: '我在。', created_at: '2026-09-06T20:01:00Z' }],
      proactive: async () => ({ serverTime: 'cursor-2', messages: [] }),
      recommend: async (mood) => { calls.recommend.push(mood); return { mood, info: { title: '焦虑的时候', text: '先做三次深呼吸。' }, tips: ['写下来'], activities: ['散步 10 分钟'], songs: [{ title: '安静的歌', artist: '某人', url: 'https://example.test/song' }, { title: '坏链接', url: 'javascript:alert(1)' }], practice: '4-7-8 呼吸', video: null }; },
      chat: async (message) => { calls.chat.push(message); return chatResult; },
      clearChat: async () => { calls.clearChat += 1; return true; },
    },
    system: { openUrl: async (url) => { calls.opened.push(url); return true; } },
  };
  window.navigate = () => {};
  window.confirmAction = async () => true;
  window.refreshAccountSettings = async () => {};
  vm.runInNewContext(source, { window, document: window.document, console, setTimeout, clearTimeout, Promise, Date, Number, Object, Array, String, Math, RegExp, JSON, Map, Set, Intl });
  return { window, document: window.document, calls, entries };
}

function click(window, node) {
  assert.ok(node, 'expected a clickable node');
  node.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
}

function submit(window, form) {
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

test('xinlv page shows its own login form instead of an embedded webpage when signed out', async () => {
  const ui = harness({ configured: false });
  await ui.window.xinlvUI.open();
  const page = ui.document.querySelector('#xinlvPage');
  assert.match(page.textContent, /登录心履/);
  assert.equal(page.querySelector('iframe'), null, 'the module must never embed the Xinlv website');
  assert.equal(page.querySelector('webview'), null);
  assert.equal(page.querySelector('[data-xinlv-entry-form]'), null, 'no record form before login');
  assert.ok(page.querySelector('[data-xinlv-login-form]'), 'the page offers its own login form');
});

test('xinlv login failure surfaces the message and never retries automatically', async () => {
  const ui = harness({ configured: false, loginFails: true });
  await ui.window.xinlvUI.open();
  const form = ui.document.querySelector('[data-xinlv-login-form]');
  form.querySelector('[name="username"]').value = 'student';
  form.querySelector('[name="password"]').value = 'wrong-password';
  submit(ui.window, form);
  await settle();
  assert.equal(ui.calls.login.length, 1, 'a failed login must not be retried automatically');
  assert.match(ui.document.querySelector('#xinlvPage').textContent, /账号或密码不正确/);
  assert.equal(ui.document.querySelector('#xinlvPage [data-xinlv-entry-form]'), null);
});

test('xinlv records a mood locally with intensity and renders the timeline safely', async () => {
  const ui = harness();
  await ui.window.xinlvUI.open();
  await settle();
  const syncBefore = ui.calls.sync;
  const page = ui.document.querySelector('#xinlvPage');
  assert.equal(ui.calls.list, 2, 'open() loads once and the automatic sync round refreshes once');
  assert.equal(page.querySelector('iframe'), null);
  assert.equal(page.querySelector('.xinlv-mood-grid img'), null, 'stored notes must never become DOM markup');
  assert.match(page.querySelector('.xinlv-timeline').textContent, /<img src=x onerror=alert\(1\)>今天还行/);
  click(ui.window, page.querySelector('[data-xinlv-mood="happy"]'));
  click(ui.window, page.querySelector('[data-xinlv-intensity="5"]'));
  const form = ui.document.querySelector('[data-xinlv-entry-form]');
  form.querySelector('[name="note"]').value = '今天很顺利';
  submit(ui.window, form);
  await settle();
  assert.equal(ui.calls.add.length, 1);
  const saved = ui.calls.add[0];
  assert.equal(saved.date, new Date().toLocaleDateString('sv-SE'));
  assert.equal(saved.mood, 'happy');
  assert.equal(saved.note, '今天很顺利');
  assert.equal(saved.intensity_level, 5);
  assert.equal(saved.intensity_percent, 90);
  // Local saves are pushed after a short debounce so a burst of edits is one request.
  await new Promise((resolve) => setTimeout(resolve, 4200));
  assert.equal(ui.calls.sync, syncBefore + 1, 'a local save schedules exactly one sync round');
});

test('xinlv editing and deleting a record goes through the API, not the DOM', async () => {
  const ui = harness();
  await ui.window.xinlvUI.open();
  await settle();
  click(ui.window, ui.document.querySelector('[data-xinlv-edit="e2"]'));
  let form = ui.document.querySelector('[data-xinlv-entry-form]');
  assert.equal(form.querySelector('[name="date"]').value, '2026-09-04');
  assert.equal(form.querySelector('[name="note"]').value, '');
  click(ui.window, ui.document.querySelector('[data-xinlv-mood="tired"]'));
  form = ui.document.querySelector('[data-xinlv-entry-form]');
  submit(ui.window, form);
  await settle();
  assert.equal(ui.calls.edit.length, 1);
  assert.equal(ui.calls.edit[0].uuid, 'e2');
  assert.equal(ui.calls.edit[0].patch.mood, 'tired');
  click(ui.window, ui.document.querySelector('[data-xinlv-delete="e1"]'));
  await settle();
  assert.deepEqual(ui.calls.remove, ['e1']);
});

test('xinlv recommendations render server content as text and only open http links', async () => {
  const ui = harness();
  await ui.window.xinlvUI.open();
  await settle();
  click(ui.window, ui.document.querySelector('[data-xinlv-tab="recommend"]'));
  await settle();
  click(ui.window, ui.document.querySelector('[data-xinlv-recommend="anxious"]'));
  await settle();
  assert.deepEqual(ui.calls.recommend, ['anxious']);
  const page = ui.document.querySelector('#xinlvPage');
  assert.match(page.textContent, /先做三次深呼吸/);
  assert.match(page.textContent, /散步 10 分钟/);
  const songButtons = [...page.querySelectorAll('[data-xinlv-open-url]')];
  assert.equal(songButtons.length, 1, 'a javascript: URL must not become a clickable button');
  click(ui.window, songButtons[0]);
  assert.deepEqual(ui.calls.opened, ['https://example.test/song']);
  assert.equal(page.querySelector('.xinlv-song-list img'), null);
});

test('xinlv chat shows a crisis banner with the hotline and keeps the reply', async () => {
  const ui = harness({ chatResult: { crisis: true, reply: '请联系专业人士', hotline: '12356' } });
  await ui.window.xinlvUI.open();
  await settle();
  click(ui.window, ui.document.querySelector('[data-xinlv-tab="chat"]'));
  await settle();
  const form = ui.document.querySelector('[data-xinlv-chat-form]');
  form.querySelector('[name="message"]').value = '我很难受';
  submit(ui.window, form);
  await settle();
  assert.deepEqual(ui.calls.chat, ['我很难受']);
  const page = ui.document.querySelector('#xinlvPage');
  assert.ok(page.querySelector('.xinlv-crisis'), 'crisis replies must render a prominent banner');
  assert.match(page.querySelector('.xinlv-crisis').textContent, /12356/);
  assert.match(page.querySelector('.xinlv-chat-log').textContent, /请联系专业人士/);
  click(ui.window, page.querySelector('[data-xinlv-dismiss-crisis]'));
  assert.equal(ui.document.querySelector('.xinlv-crisis'), null);
});

test('xinlv profile reads server stats and logout clears the local session', async () => {
  const ui = harness();
  await ui.window.xinlvUI.open();
  await settle();
  click(ui.window, ui.document.querySelector('[data-xinlv-tab="profile"]'));
  await settle();
  const page = ui.document.querySelector('#xinlvPage');
  assert.match(page.textContent, /连续记录天数/);
  assert.match(page.textContent, /12/);
  assert.match(page.textContent, /第一周/);
  click(ui.window, page.querySelector('[data-xinlv-logout]'));
  await settle();
  assert.equal(ui.calls.logout, 1);
  assert.match(ui.document.querySelector('#xinlvPage').textContent, /登录心履/);
});

test('xinlv sync button reports pushed and pulled counts', async () => {
  const ui = harness();
  await ui.window.xinlvUI.open();
  await settle();
  const before = ui.calls.sync;
  click(ui.window, ui.document.querySelector('#xinlvPage [data-xinlv-sync]'));
  await settle();
  assert.equal(ui.calls.sync, before + 1);
  assert.match(ui.document.querySelector('#xinlvPage').textContent, /同步完成：上传 1 条，下载 2 条/);
});

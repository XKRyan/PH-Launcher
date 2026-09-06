const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const source = fs.readFileSync(require.resolve('../src/mail-ui.js'), 'utf8');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = () => { let resolve; let reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };

function harness({ saved = true, sendResult = { ok: true } } = {}) {
  const { window } = parseHTML('<!doctype html><html><body><section id="mailPage"></section></body></html>');
  const calls = { status: 0, list: [], contacts: 0, read: [], download: [], send: [] };
  window.ph = { mail: {
    status: async () => { calls.status += 1; return { saved }; },
    list: async (options) => { calls.list.push(options); return { items: [{ uid: 'one', subject: '<img src=x>', from: { name: '学校通知', address: 'notice@example.test' }, date: '2026-09-06T08:00:00Z', unread: true }, { uid: 'two', subject: '普通邮件', from: { address: 'teacher@example.test' }, date: '2026-09-05T08:00:00Z', unread: false }] }; },
    contacts: async () => { calls.contacts += 1; return [{ name: '李老师', address: 'teacher@example.test' }]; },
    read: async (uid) => { calls.read.push(uid); return { uid, subject: '<b>纯文本</b>', from: { name: '学校通知', address: 'notice@example.test' }, to: { address: 'student@example.test' }, date: '2026-09-06T08:00:00Z', text: '正文 <img src=x>', attachments: [{ id: 'a1', name: '安排.pdf', size: 2048 }] }; },
    download: async (input) => { calls.download.push(input); return { ok: true, canceled: false }; },
    send: async (input) => { calls.send.push(input); return sendResult; },
  } };
  vm.runInNewContext(source, { window, document: window.document, console, setTimeout, clearTimeout, Promise, Date });
  return { window, document: window.document, calls };
}

function click(window, node) { node.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })); }

test('mail UI lists a bounded inbox, safely renders plain text, and saves attachments', async () => {
  const ui = harness();
  ui.window.mailUI.mount();
  await ui.window.mailUI.open();
  assert.equal(ui.calls.list.length, 1);
  assert.equal(ui.calls.list[0].unread, false);
  assert.equal(ui.calls.list[0].limit, 100);
  assert.match(ui.document.querySelector('#mailPage').textContent, /最近 100 封邮件/);
  assert.equal(ui.document.querySelector('#mailPage img'), null, 'email HTML must never become DOM markup');
  click(ui.window, ui.document.querySelector('[data-mail-open="one"]'));
  await settle();
  assert.deepEqual(ui.calls.read, ['one']);
  assert.match(ui.document.querySelector('.mail-text').textContent, /正文 <img src=x>/);
  assert.ok(ui.document.querySelector('.mail-message').innerHTML.indexOf('mail-attachments') < ui.document.querySelector('.mail-message').innerHTML.indexOf('mail-text'), 'attachments appear before long message body');
  assert.ok(ui.document.querySelector('[data-mail-open="one"]').classList.contains('unread'), 'read-only PEEK must not pretend to change server unread flags');
  click(ui.window, ui.document.querySelector('[data-mail-download="a1"]'));
  await settle();
  assert.equal(ui.calls.download.length, 1);
  assert.equal(ui.calls.download[0].uid, 'one');
  assert.equal(ui.calls.download[0].attachmentId, 'a1');
});

test('mail buttons show actual domains before the body and only send message/link IDs on deliberate click', async () => {
  const ui = harness();
  const opened = [];
  ui.window.ph.mail.read = async uid => ({ uid, subject: 'Reset request', text: 'Click the button below.', links: [{ id: 'link-abc', label: '<img src=x onerror=alert(1)> Reset password', host: 'shph.managebac.cn' }] });
  ui.window.ph.mail.openLink = async input => { opened.push(input); return { ok: true }; };
  await ui.window.mailUI.open();
  click(ui.window, ui.document.querySelector('[data-mail-open="one"]')); await settle();
  assert.equal(opened.length, 0, 'reading never follows links');
  assert.equal(ui.document.querySelector('img,a,iframe'), null);
  const button = ui.document.querySelector('[data-mail-link]');
  assert.match(button.textContent, /shph\.managebac\.cn/);
  const markup = ui.document.querySelector('.mail-message').innerHTML;
  assert.ok(markup.indexOf('mail-links') < markup.indexOf('mail-text'));
  click(ui.window, button); await settle();
  assert.equal(opened.length, 1); assert.equal(opened[0].uid, 'one'); assert.equal(opened[0].linkId, 'link-abc'); assert.equal(opened[0].url, undefined);
});

test('mail UI uses known message-header contacts and sends only after an explicit form submit', async () => {
  const ui = harness();
  await ui.window.mailUI.open();
  assert.equal(ui.document.querySelector('option[value="teacher@example.test"]').textContent, '李老师');
  click(ui.window, ui.document.querySelector('[data-mail-compose]'));
  const form = ui.document.querySelector('[data-mail-compose-form]');
  form.querySelector('[name=to]').value = 'teacher@example.test';
  form.querySelector('[name=subject]').value = '作业问题';
  form.querySelector('[name=text]').value = '老师好';
  form.dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(ui.calls.send.length, 1);
  assert.equal(ui.calls.send[0].to, 'teacher@example.test');
  assert.equal(ui.calls.send[0].cc, '');
  assert.equal(ui.calls.send[0].subject, '作业问题');
  assert.equal(ui.calls.send[0].text, '老师好');
  assert.equal(ui.document.querySelector('[data-mail-compose-form]'), null, 'successful send clears the compose form');
  assert.match(ui.document.querySelector('#mailPage').textContent, /邮件已发送/);
});

test('first inbox sync harvests contacts before querying autocomplete, and login stays editable', async () => {
  const ui = harness();
  let listed = false;
  const list = ui.window.ph.mail.list;
  ui.window.ph.mail.list = async (...args) => { const result = await list(...args); listed = true; return result; };
  ui.window.ph.mail.contacts = async () => { assert.ok(listed); return []; };
  await ui.window.mailUI.open();
  assert.ok(ui.document.querySelector('[data-mail-login]'));
});

test('a send failure is shown once and is not retried automatically', async () => {
  const ui = harness({ sendResult: { ok: false, error: '服务器暂时不可用' } });
  await ui.window.mailUI.open();
  click(ui.window, ui.document.querySelector('[data-mail-compose]'));
  const form = ui.document.querySelector('[data-mail-compose-form]');
  form.querySelector('[name=to]').value = 'teacher@example.test';
  form.querySelector('[name=subject]').value = '测试';
  form.querySelector('[name=text]').value = '正文';
  form.dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(ui.calls.send.length, 1);
  assert.match(ui.document.querySelector('.mail-form-error').textContent, /服务器暂时不可用/);
  assert.equal(ui.document.querySelector('[name=subject]').value, '测试', 'failed send keeps the draft for a deliberate retry');
});

test('an inbox refresh does not discard a compose draft already being typed', async () => {
  const ui = harness();
  await ui.window.mailUI.open();
  click(ui.window, ui.document.querySelector('[data-mail-compose]'));
  const subject = ui.document.querySelector('[name=subject]');
  subject.value = '仍在编辑的主题';
  subject.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  await ui.window.mailUI.open();
  assert.equal(ui.document.querySelector('[name=subject]').value, '仍在编辑的主题');
});

test('mail UI directs an unsigned-in user to account login without requesting messages', async () => {
  const ui = harness({ saved: false });
  await ui.window.mailUI.open();
  assert.equal(ui.calls.list.length, 0);
  assert.match(ui.document.querySelector('#mailPage').textContent, /请先在“设置 → 网站 → 账号记忆”中登录平和邮箱/);
});

test('clear advances the UI session so an old refresh and contacts response cannot repopulate a new account', async () => {
  const { window } = parseHTML('<!doctype html><html><body><section id="mailPage"></section></body></html>');
  const list = deferred(); const contacts = deferred();
  window.ph = { mail: { status: async () => ({ saved: true }), list: () => list.promise, contacts: () => contacts.promise } };
  vm.runInNewContext(source, { window, document: window.document, console, setTimeout, clearTimeout, Promise, Date });
  window.mailUI.mount();
  const opening = window.mailUI.open();
  await settle();
  window.mailUI.clear();
  list.resolve({ items: [{ uid: 'old', subject: '旧账号机密邮件', from: { address: 'old@example.test' } }] });
  contacts.resolve([{ name: '旧联系人', address: 'old@example.test' }]);
  await opening; await settle();
  assert.doesNotMatch(window.document.querySelector('#mailPage').textContent, /旧账号机密邮件|旧联系人|old@example\.test/);
  assert.match(window.document.querySelector('#mailPage').textContent, /邮箱账号已清除/);
});

test('clear also invalidates an old read and a pending send result', async () => {
  const { window } = parseHTML('<!doctype html><html><body><section id="mailPage"></section></body></html>');
  const read = deferred(); const send = deferred();
  window.ph = { mail: {
    status: async () => ({ saved: true }),
    list: async () => ({ items: [{ uid: 'old', subject: '旧主题', from: { address: 'old@example.test' }, unread: true }] }),
    contacts: async () => [], read: () => read.promise, send: () => send.promise,
  } };
  vm.runInNewContext(source, { window, document: window.document, console, setTimeout, clearTimeout, Promise, Date });
  await window.mailUI.open();
  click(window, window.document.querySelector('[data-mail-open="old"]'));
  await settle();
  click(window, window.document.querySelector('[data-mail-compose]'));
  const form = window.document.querySelector('[data-mail-compose-form]');
  form.querySelector('[name=to]').value = 'teacher@example.test';
  form.querySelector('[name=subject]').value = '旧账号发信';
  form.querySelector('[name=text]').value = '旧账号正文';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  window.mailUI.clear();
  read.resolve({ uid: 'old', subject: '旧主题', text: '旧账号邮件正文', from: { address: 'old@example.test' }, attachments: [] });
  send.resolve({ ok: true });
  await settle(); await settle();
  const text = window.document.querySelector('#mailPage').textContent;
  assert.doesNotMatch(text, /旧主题|旧账号邮件正文|旧账号发信|邮件已发送/);
  assert.equal(window.document.querySelector('[data-mail-compose-form]'), null);
});

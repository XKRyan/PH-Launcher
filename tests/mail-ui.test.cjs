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
  const calls = { status: 0, list: [], contacts: 0, read: [], download: [], send: [], harvest: 0 };
  const timers = [];
  // 可控时钟：自动同步按「数据多久没更新」判断，测试里要能把时间往前拨。
  let clock = Date.parse('2026-09-19T05:20:00Z');
  class FakeDate extends Date {
    constructor(...args) { if (!args.length) super(clock); else super(...args); }
    static now() { return clock; }
  }
  window.ph = { mail: {
    status: async () => { calls.status += 1; return { saved }; },
    list: async (options) => { calls.list.push(options); return { items: [{ uid: 'one', subject: '<img src=x>', from: { name: '学校通知', address: 'notice@example.test' }, date: '2026-09-06T08:00:00Z', unread: true }, { uid: 'two', subject: '普通邮件', from: { address: 'teacher@example.test' }, date: '2026-09-05T08:00:00Z', unread: false }] }; },
    contacts: async () => { calls.contacts += 1; return [{ name: '李老师', address: 'teacher@example.test' }]; },
    read: async (uid) => { calls.read.push(uid); return { uid, markedSeen: true, subject: '<b>纯文本</b>', from: { name: '学校通知', address: 'notice@example.test' }, to: [{ name: 'Student', address: 'student@example.test' }], date: '2026-09-06T08:00:00Z', text: '正文 <img src=x>', attachments: [{ id: 'a1', name: '安排.pdf', size: 2048 }] }; },
    download: async (input) => { calls.download.push(input); return { ok: true, canceled: false }; },
    harvestContacts: async () => { calls.harvest += 1; return { folders: 2 }; },
    send: async (input) => { calls.send.push(input); return sendResult; },
  } };
  vm.runInNewContext(source, { window, document: window.document, console, setTimeout, clearTimeout, Promise, Date: FakeDate, File: window.File, Uint8Array, ArrayBuffer,
    // 自动同步用的定时器在测试里只登记、不真的跑（否则测试进程会被挂住）。
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval: () => {},
    // 真实渲染进程里一直有 btoa/atob（内嵌图片会就地转成 data: URL）
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    atob: (value) => Buffer.from(value, 'base64').toString('binary') });
  return { window, document: window.document, calls, timers, advance: (ms) => { clock += ms; } };
}

function click(window, node) { node.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })); }

test('confirmed reads update unread rows and counts even after switching to another message', async () => {
  const ui = harness();
  const first = deferred();
  ui.window.ph.mail.read = (uid) => uid === 'one' ? first.promise : Promise.resolve({ uid, markedSeen: true, text: 'second body' });
  const counts = [];
  ui.window.mailUI.onUnreadChange((count) => counts.push(count));
  await ui.window.mailUI.open();
  click(ui.window, ui.document.querySelector('[data-mail-open="one"]'));
  click(ui.window, ui.document.querySelector('[data-mail-open="two"]'));
  await settle();
  first.resolve({ uid: 'one', markedSeen: true, text: 'first body' });
  await settle();
  assert.equal(ui.document.querySelector('[data-mail-open="one"]').classList.contains('unread'), false);
  assert.equal(ui.window.mailUI.unreadCount(), 0);
  assert.equal(counts.at(-1), 0);
  assert.match(ui.document.querySelector('.mail-text').textContent, /second body/);
  click(ui.window, ui.document.querySelector('[data-mail-filter="unread"]'));
  assert.equal(ui.document.querySelectorAll('[data-mail-open]').length, 0);
});

test('an older inbox refresh cannot restore the unread flag after a confirmed read', async () => {
  const ui = harness();
  await ui.window.mailUI.open();
  const listing = deferred();
  ui.window.ph.mail.list = () => listing.promise;
  ui.advance(3 * 60 * 1000);
  const refreshing = ui.window.mailUI.open();
  await settle();
  click(ui.window, ui.document.querySelector('[data-mail-open="one"]'));
  await settle();
  listing.resolve({ items: [{ uid: 'one', unread: true }] });
  await refreshing;
  assert.equal(ui.document.querySelector('[data-mail-open="one"]').classList.contains('unread'), false);
  assert.equal(ui.window.mailUI.unreadCount(), 0);
  // Only overlapping snapshots are reconciled: a later external mark-unread wins.
  ui.advance(3 * 60 * 1000);
  ui.window.ph.mail.list = async () => ({ items: [{ uid: 'one', unread: true }] });
  await ui.window.mailUI.open();
  assert.equal(ui.window.mailUI.unreadCount(), 1);
});

test('unconfirmed server writes preserve unread status and display a retry notice with the body', async () => {
  for (const detail of [{ markedSeen: false, markSeenError: 'STORE rejected' }, { markedSeen: false }, {}]) {
    const ui = harness();
    ui.window.ph.mail.read = async (uid) => ({ uid, text: 'available body', ...detail });
    await ui.window.mailUI.open();
    click(ui.window, ui.document.querySelector('[data-mail-open="one"]'));
    await settle();
    assert.equal(ui.document.querySelector('[data-mail-open="one"]').classList.contains('unread'), true);
    assert.equal(ui.window.mailUI.unreadCount(), 1);
    assert.match(ui.document.querySelector('.mail-status').textContent, /未能在服务器标记为已读/);
    assert.match(ui.document.querySelector('.mail-text').textContent, /available body/);
  }
});

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
  assert.equal(ui.document.querySelector('[data-mail-open="one"]').classList.contains('unread'), false, 'opening a mail flips its list entry to read immediately');
  // 抬头默认只有一行（发件人 · 时间 + 两个小字），明细与附件点开才出现。
  assert.equal(ui.document.querySelectorAll('.mail-meta-detail').length, 0, '默认不展开详细信息');
  assert.equal(ui.document.querySelectorAll('.mail-attachments').length, 0, '默认不展开附件');
  assert.equal(ui.document.querySelectorAll('.mail-meta-line').length, 1, '抬头就一行');
  click(ui.window, ui.document.querySelector('[data-mail-meta-toggle]'));
  click(ui.window, ui.document.querySelector('[data-mail-attach-toggle]'));
  assert.ok(ui.document.querySelector('.mail-message').innerHTML.indexOf('mail-attachments') < ui.document.querySelector('.mail-message').innerHTML.indexOf('mail-text'), 'attachments appear before long message body');
  assert.equal(ui.document.querySelectorAll('.mail-recipient-row').length, 1, 'recipients render as per-address rows');
  assert.equal(ui.document.querySelectorAll('.mail-recipient-extra').length, 0, 'fewer than six recipients stay expanded');
  click(ui.window, ui.document.querySelector('[data-mail-download="a1"]'));
  await settle();
  assert.equal(ui.calls.download.length, 1);
  assert.equal(ui.calls.download[0].uid, 'one');
  assert.equal(ui.calls.download[0].attachmentId, 'a1');
});

// 2026-09-19 用户要求：「第二行的发件人和时间旁边有两个小字，一个是详细信息（展开是
// 发件人收件人和时间），另一个是展开附件（展开是附件），用发件人收件人时间一样那种字，
// 一个一行，然后回复和转发按钮和这两行小字并列，做的再小一些」。
test('抬头第二行：发件人·时间 + 「详细信息」「展开附件」两个小字 + 回复转发并列', async () => {
  const ui = harness();
  await ui.window.mailUI.open();
  click(ui.window, ui.document.querySelector('[data-mail-open="one"]'));
  await settle();
  const line = ui.document.querySelector('.mail-meta-line');
  assert.ok(line, '抬头就一行');
  assert.match(line.textContent, /学校通知/, '这一行里有发件人');
  const meta = line.querySelector('[data-mail-meta-toggle]');
  const attach = line.querySelector('[data-mail-attach-toggle]');
  assert.equal(meta.textContent, '详细信息');
  assert.match(attach.textContent, /^展开附件/);
  assert.ok(line.querySelector('[data-mail-reply]') && line.querySelector('[data-mail-forward]'), '回复/转发和这两个小字并列在同一行');
  assert.equal(ui.document.querySelector('.mail-meta-detail'), null, '默认不展开');
  assert.equal(ui.document.querySelector('.mail-attachments'), null, '默认不展开附件');
  // 「详细信息」只展开 发件人/收件人/时间，不带附件
  click(ui.window, meta);
  const detail = ui.document.querySelector('.mail-meta-detail');
  assert.ok(detail);
  assert.match(detail.textContent, /发件人/);
  assert.match(detail.textContent, /收件人/);
  assert.match(detail.textContent, /时间/);
  assert.equal(detail.querySelector('.mail-attachments'), null, '附件归「展开附件」那一项管');
  assert.equal(ui.document.querySelector('[data-mail-meta-toggle]').getAttribute('aria-expanded'), 'true');
  assert.equal(detail.querySelectorAll('.mail-meta-dl div').length >= 3, true, '发件人/收件人/时间一个一行');
  // 「展开附件」只展开附件
  click(ui.window, ui.document.querySelector('[data-mail-attach-toggle]'));
  const list = ui.document.querySelector('.mail-attachments');
  assert.ok(list, '点开后出现附件');
  assert.equal(list.querySelectorAll('button').length, 1);
  assert.match(list.textContent, /安排\.pdf/);
  // 再点一次各自收起来（每次 render 之后都要重新取节点：旧的已经脱离 DOM）
  click(ui.window, ui.document.querySelector('[data-mail-meta-toggle]'));
  click(ui.window, ui.document.querySelector('[data-mail-attach-toggle]'));
  assert.ok(ui.document.querySelector('.mail-meta-detail') === null, '再点一次收起来');
  assert.ok(ui.document.querySelector('.mail-attachments') === null);
});

// 没有附件时「展开附件」也要给出明确答复，而不是装死。
test('没有附件的邮件：展开附件说「这封邮件没有附件。」', async () => {
  const ui = harness();
  ui.window.ph.mail.read = async uid => ({ uid, subject: 'No files', text: '正文', to: [{ address: 'student@example.test' }], date: '2026-09-06T08:00:00Z' });
  await ui.window.mailUI.open();
  click(ui.window, ui.document.querySelector('[data-mail-open="one"]'));
  await settle();
  click(ui.window, ui.document.querySelector('[data-mail-attach-toggle]'));
  assert.match(ui.document.querySelector('.mail-attach-empty').textContent, /没有附件/);
});

// 2026-09-19 用户要求：「邮件中的链接那个不要做了，去掉，没意义」——
// 「邮件中的链接」那张清单已删除；正文里的链接照旧按原文显示，只是不再单独列出来。
test('邮件阅读页不再有「邮件中的链接」清单（正文照旧原样显示）', async () => {
  const ui = harness();
  ui.window.ph.mail.read = async uid => ({
    uid, subject: 'Reset request', text: 'Click the button below.',
    to: [{ address: 'student@example.test' }],
    links: [{ id: 'link-abc', label: 'Reset password', host: 'shph.managebac.cn' }],
  });
  await ui.window.mailUI.open();
  click(ui.window, ui.document.querySelector('[data-mail-open="one"]'));
  await settle();
  assert.equal(ui.document.querySelector('.mail-message iframe'), null, 'plain-text mail renders no HTML iframe');
  assert.equal(ui.document.querySelector('.mail-links'), null, '链接清单已经去掉');
  assert.equal(ui.document.querySelector('[data-mail-link]'), null, '不再有"在浏览器打开"的按钮');
  assert.match(ui.document.querySelector('.mail-text').textContent, /Click the button below/);
});

test('mail recipients beyond five collapse and expand on toggle, and HTML mail renders in a sandboxed frame', async () => {
  const ui = harness();
  const many = Array.from({ length: 8 }, (_, index) => ({ name: `Person ${index + 1}`, address: `person${index + 1}@example.test` }));
  ui.window.ph.mail.read = async uid => ({ uid, subject: 'Group mail', text: 'plain fallback', html: '<p>formatted <b>body</b></p><script>steal()</script>', to: many, cc: [{ name: 'Extra', address: 'extra@example.test' }] });
  await ui.window.mailUI.open();
  click(ui.window, ui.document.querySelector('[data-mail-open="one"]'));
  await settle();
  assert.ok(ui.document.querySelector('.mail-preview-frame'), 'HTML mail renders in a sandboxed iframe');
  assert.equal(ui.document.querySelector('.mail-preview-frame').getAttribute('sandbox'), 'allow-same-origin', 'iframe sandbox must not allow scripts');
  const srcdoc = ui.document.querySelector('.mail-preview-frame').getAttribute('srcdoc');
  assert.doesNotMatch(srcdoc, /<script/i, 'scripts are stripped from the stored HTML');
  click(ui.window, ui.document.querySelector('[data-mail-meta-toggle]')); // 收件人明细要先展开抬头
  assert.equal(ui.document.querySelectorAll('.mail-recipient-row').length, 9, 'eight to + one cc recipients');
  assert.equal(ui.document.querySelectorAll('.mail-recipient-row.mail-recipient-extra').length, 4, 'rows beyond five are collapsed');
  click(ui.window, ui.document.querySelector('[data-mail-recipient-toggle]'));
  assert.equal(ui.document.querySelectorAll('.mail-recipient-row.mail-recipient-extra').length, 0, 'toggle reveals collapsed recipients');
  assert.match(ui.document.querySelector('[data-mail-recipient-toggle]').textContent, /收起收件人/);
  click(ui.window, ui.document.querySelector('[data-mail-recipient-toggle]'));
  assert.equal(ui.document.querySelectorAll('.mail-recipient-row.mail-recipient-extra').length, 4, 'toggle collapses again');
});

// ---------------------------------------------------------------- 回复 / 转发 / 内嵌图片
// 与网页端（D:\phix\website\static\app\app.js）逐字一致的语义：
//   回复 → 收件人取 Reply-To（没有就用 From）、主题加 `Re: `、引用块 `> ` 逐行；
//   转发 → 收件人**留空**、主题加 `Fwd: `、**把原附件一并带上**。

function replyHarness(overrides = {}) {
  const ui = harness();
  // linkedom 没有 File 构造器；转发带附件那条路要用它把字节包成"可发送的文件"。
  if (typeof ui.window.File !== 'function') {
    ui.window.File = class File {
      constructor(parts, name, options = {}) {
        this.name = name;
        this.type = options.type || '';
        this.size = parts.reduce((total, part) => total + (part?.byteLength || part?.length || 0), 0);
        this._parts = parts;
      }
      async arrayBuffer() {
        const first = this._parts[0];
        if (first instanceof Uint8Array) return first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength);
        return new ArrayBuffer(0);
      }
    };
  }
  ui.window.ph.mail.downloadBytes = async (input) => { (ui.calls.downloadBytes = ui.calls.downloadBytes || []).push(input); return { data: new Uint8Array([1, 2, 3]), contentType: 'application/pdf' }; };
  // 外部图片也由主进程取回来（沙箱 iframe 里 <img src="https://…"> 加载不出来）
  ui.window.ph.mail.fetchImage = async (input) => { (ui.calls.fetchImage = ui.calls.fetchImage || []).push(input); return { data: new Uint8Array([9, 9, 9]), contentType: 'image/gif' }; };
  ui.window.ph.mail.read = async (uid) => ({
    uid,
    subject: '关于月考安排',
    from: { name: '教务处', address: 'academic@example.test' },
    replyTo: [{ name: '年级组', address: 'grade@example.test' }],
    to: [{ address: 'student@example.test' }],
    date: '2026-09-13T08:12:00+08:00',
    text: '第一行\n第二行',
    html: '<p>第一行</p><p>第二行</p><img src="cid:logo@example.test">',
    attachments: [{ id: 'a1', name: '安排.pdf', size: 2048, contentId: 'logo@example.test', inline: true }],
    ...overrides,
  });
  return ui;
}

test('点「回复」：收件人取 Reply-To、主题加 `Re: `、正文是逐行 `> ` 的引用块', async () => {
  const ui = replyHarness();
  await ui.window.mailUI.open();
  click(ui.window, ui.document.querySelector('[data-mail-open="one"]'));
  await settle();
  click(ui.window, ui.document.querySelector('[data-mail-reply]'));
  await settle();
  const form = ui.document.querySelector('[data-mail-compose-form]');
  assert.ok(form, '回复会打开撰写窗');
  assert.equal(form.querySelector('[name=to]').value, 'grade@example.test', 'Reply-To 优先于 From');
  assert.equal(form.querySelector('[name=subject]').value, 'Re: 关于月考安排');
  // 注意：引用块是**写进 textarea 的 HTML**，linkedom 不像真浏览器那样把
  // `&gt;` 解码回 `>`（真浏览器里 .value 就是 `> 第一行`），所以两种写法都认。
  const body = form.querySelector('[name=text]').value;
  assert.match(body, /---------- 原始邮件 ----------/);
  assert.match(body, /^(?:>|&gt;) 第一行$/m);
  assert.match(body, /^(?:>|&gt;) 第二行$/m);
  assert.match(body, /------------------/);
  assert.match(ui.document.querySelector('.mail-compose-head').textContent, /回复邮件/);
});

test('点「转发」：收件人留空、主题加 `Fwd: `、原附件自动带上（可逐个删掉）', async () => {
  const ui = replyHarness();
  await ui.window.mailUI.open();
  click(ui.window, ui.document.querySelector('[data-mail-open="one"]'));
  await settle();
  click(ui.window, ui.document.querySelector('[data-mail-forward]'));
  await settle();
  await settle();
  const form = ui.document.querySelector('[data-mail-compose-form]');
  assert.ok(form, '转发会打开撰写窗');
  assert.equal(form.querySelector('[name=to]').value, '', '转发不预填收件人');
  assert.equal(form.querySelector('[name=subject]').value, 'Fwd: 关于月考安排');
  assert.deepEqual([...new Set((ui.calls.downloadBytes || []).map((entry) => entry.attachmentId))], ['a1'], '原附件按 id 取回来（内嵌图片也走同一个通道，所以按 id 去重）');
  assert.match(ui.document.querySelector('.mail-attach-count').textContent, /1 个附件/);
  const remove = ui.document.querySelector('[data-mail-attach-remove="0"]');
  assert.ok(remove, '带上的附件要能单独删掉');
  click(ui.window, remove);
  assert.equal(ui.document.querySelector('.mail-attach-list'), null, '删掉之后清单就空了');
});

test('正文图片：`cid:` 与外部 http 图片都取回来转成 data: URL；取不到的整段删掉', async () => {
  const ui = replyHarness({ html: '<p>x</p><img src="cid:logo@example.test"><img src="https://cdn.example.test/a.gif"><img src="https://cdn.example.test/broken.gif">' });
  // 第二张取得回来、第三张取不到
  ui.window.ph.mail.fetchImage = async (input) => {
    if (String(input.url).includes('broken')) throw new Error('取不到');
    return { data: new Uint8Array([9, 9, 9]), contentType: 'image/gif' };
  };
  await ui.window.mailUI.open();
  click(ui.window, ui.document.querySelector('[data-mail-open="one"]'));
  for (let i = 0; i < 6; i += 1) await settle();
  const srcdoc = ui.document.querySelector('.mail-preview-frame').getAttribute('srcdoc');
  assert.match(srcdoc, /src="data:[^"]+;base64,/, 'cid 图片换成取回的字节');
  assert.ok((srcdoc.match(/src="data:/g) || []).length === 2, '两张能取到的图都换成了 data:（实际：' + (srcdoc.match(/src="data:/g) || []).length + '）');
  assert.doesNotMatch(srcdoc, /src="cid:/, '不能再留 cid:');
  assert.doesNotMatch(srcdoc, /broken\.gif/, '取不到的那张整段删掉 —— 不留"框框加小图标"的破图');
  assert.doesNotMatch(srcdoc, /<img[^>]*(?:cid:|phl-mail:|https?:)/i, '正文里不该再有加载不出来的 img');
});

test('引用块用的是纯文本版本，不会把 HTML 标签塞进正文', async () => {
  const ui = replyHarness({ text: '', html: '<div>甲</div><div>乙</div>' });
  await ui.window.mailUI.open();
  click(ui.window, ui.document.querySelector('[data-mail-open="one"]'));
  await settle();
  click(ui.window, ui.document.querySelector('[data-mail-reply]'));
  await settle();
  const body = ui.document.querySelector('[name=text]').value;
  assert.match(body, /^(?:>|&gt;) 甲$/m);
  assert.doesNotMatch(body, /<div>/, '引用里不能出现 HTML 标签');
});

test('mail UI uses known message-header contacts and sends only after an explicit form submit', async () => {  const ui = harness();
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

// 2026-09-19 用户要求：「收割联系人这个按钮去掉，改成每次登录和收到邮件、发送邮件的时候
// 自动收割，不要让用户察觉」；「所有同步、刷新全都自动，最多来一行不起眼的小字」。
test('收割联系人和刷新都没有按钮：自动收割，角落只留一行「当前数据：<时间>」', async () => {
  const ui = harness();
  await ui.window.mailUI.open();
  assert.equal(ui.document.querySelector('[data-mail-harvest]'), null, '收割联系人按钮已去掉');
  assert.equal(ui.document.querySelector('[data-mail-refresh]'), null, '刷新按钮已去掉');
  assert.ok(ui.document.querySelector('.mail-data-stamp'), '角落有一行数据时间');
  assert.match(ui.document.querySelector('.mail-data-stamp').textContent, /当前数据：/);
  assert.ok(ui.calls.harvest >= 1, '打开邮箱就自动收割一次（不声不响）');
  // 后台定时器：每 3 分钟一次，数据放旧之后到点会自动再取一次
  const timer = ui.timers.find((entry) => entry.ms >= 60000);
  assert.ok(timer, '装了后台同步定时器');
  assert.equal(timer.ms, 180000, '每 3 分钟对一次');
  const before = ui.calls.list.length;
  timer.fn();
  await settle(); await settle();
  assert.equal(ui.calls.list.length, before, '刚取过就不重复取（免得白白打扰服务器）');
  ui.advance(5 * 60 * 1000);
  timer.fn();
  await settle(); await settle(); await settle();
  assert.ok(ui.calls.list.length > before, '数据放旧之后定时器会自动再取一次');
  assert.equal(ui.document.querySelector('[data-mail-harvest]'), null);
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
  vm.runInNewContext(source, { window, document: window.document, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, Promise, Date });
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
  vm.runInNewContext(source, { window, document: window.document, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, Promise, Date });
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

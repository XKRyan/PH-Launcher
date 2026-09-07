'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SchoolMailClient,
  MailClientError,
  IMAP_HOST,
  IMAP_PORT,
  SMTP_HOST,
  SMTP_PORT,
  MAX_BODY_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_RAW_MESSAGE_BYTES,
  MAX_PREPARED_DRAFTS,
  PREPARED_DRAFT_TTL_MS,
} = require('../electron/mail-client.cjs');

const attachmentBytes = Buffer.from('safe attachment bytes\n', 'utf8');
const plainMail = Buffer.from([
  'From: "Teacher Name" <teacher@shphschool.com>',
  'To: Student <student@shphschool.com>',
  'Cc: Helper <helper@example.org>',
  'Date: Fri, 06 Sep 2026 08:30:00 +0800',
  'Subject: Native inbox test',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="ph-boundary"',
  '',
  '--ph-boundary',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Hello from the native mailbox.=0ASecond line.',
  '--ph-boundary',
  'Content-Type: application/octet-stream',
  'Content-Disposition: attachment; filename="../unsafe?.txt"',
  'Content-Transfer-Encoding: base64',
  '',
  attachmentBytes.toString('base64'),
  '--ph-boundary--',
  '',
].join('\r\n'), 'utf8');

const htmlMail = Buffer.from([
  'From: Tracker <tracker@example.org>',
  'To: Student <student@shphschool.com>',
  'Date: Fri, 06 Sep 2026 09:00:00 +0800',
  'Subject: HTML only',
  'MIME-Version: 1.0',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><body><img src="https://tracker.invalid/pixel"><script>steal()</script><p>Hello &amp; world</p><a href="https://external.invalid/path">Visible label</a></body></html>',
].join('\r\n'), 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class FakeImap {
  constructor(options, state) {
    this.options = options;
    this.state = state;
    this.usable = true;
    this.closed = false;
    this.lockOptions = [];
    this.fetchOneCalls = [];
    this.listeners = new Map();
  }

  on(event, listener) {
    const list = this.listeners.get(event) || [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  async connect() {
    this.state.connectCalls += 1;
    if (this.state.connectError) throw this.state.connectError;
  }

  close() {
    this.closed = true;
    this.usable = false;
    for (const listener of this.listeners.get('close') || []) listener();
  }

  async getMailboxLock(path, options) {
    this.lockOptions.push(options);
    this.state.lockPaths.push(path);
    this.state.currentFolder = path;
    return { release: () => { this.state.releaseCalls += 1; } };
  }

  async *list() {
    for (const entry of this.state.listMailboxes || []) yield entry;
  }

  async search(query, options) {
    this.state.searchCalls.push({ query, options, folder: this.state.currentFolder || null });
    if (this.state.searchResults && this.state.currentFolder in this.state.searchResults) {
      return this.state.searchResults[this.state.currentFolder];
    }
    return this.state.uids;
  }

  async fetchAll(uids, query, options) {
    this.state.fetchAllCalls.push({ uids, query, options });
    if (this.state.fetchAllWait) await this.state.fetchAllWait.promise;
    return this.state.messages.filter((entry) => uids.map(String).includes(String(entry.uid)));
  }

  async fetchOne(uid, query, options) {
    this.fetchOneCalls.push({ uid, query, options });
    const message = this.state.messages.find((entry) => String(entry.uid) === String(uid));
    const source = this.state.sources.get(String(uid));
    if (!source && !message) return false;
    const size = this.state.reportedSizes.get(String(uid)) ?? source?.length ?? 0;
    return { uid: Number(uid), size, source, envelope: message?.envelope || null };
  }
}

function createHarness(overrides = {}) {
  let credential = overrides.credential || { username: 'student@shphschool.com', password: 'client-auth-code' };
  const state = {
    connectCalls: 0,
    releaseCalls: 0,
    lockPaths: [],
    currentFolder: null,
    searchCalls: [],
    searchResults: null,
    fetchAllCalls: [],
    listMailboxes: [
      { path: 'INBOX', name: 'INBOX', specialUse: '' },
      { path: '&XfJT0ZAB-', name: '已发送', specialUse: '\\Sent' },
      { path: '&g0l6P3ux-', name: '草稿箱', specialUse: '\\Drafts' },
    ],
    uids: [101, 102],
    messages: [
      {
        uid: 101,
        envelope: {
          from: [{ name: 'Teacher\u0000 Name', address: 'TEACHER@shphschool.com' }],
          to: [{ name: 'Student', address: 'student@shphschool.com' }],
          cc: [{ name: 'Helper', address: 'helper@example.org' }],
          date: new Date('2026-09-06T00:30:00.000Z'),
          subject: 'Subject\r\nInjected',
        },
        flags: new Set(),
        size: plainMail.length,
        bodyStructure: { type: 'multipart/mixed', childNodes: [{ type: 'text/plain' }, { type: 'application/octet-stream', disposition: 'attachment', dispositionParameters: { filename: 'lesson.pdf' } }] },
      },
      {
        uid: 102,
        envelope: {
          from: [{ name: 'Updates', address: 'no-reply@example.org' }],
          to: [{ name: 'Student', address: 'student@shphschool.com' }],
          cc: [],
          date: new Date('2026-09-06T01:00:00.000Z'),
          subject: 'Seen message',
        },
        flags: new Set(['\\Seen']),
        size: htmlMail.length,
      },
    ],
    sources: new Map([['101', plainMail], ['102', htmlMail]]),
    reportedSizes: new Map(),
    fetchAllWait: null,
    connectError: null,
    imaps: [],
    smtpOptions: [],
    smtpMessages: [],
    smtpSendCalls: 0,
    smtpError: null,
    smtpWait: null,
    ...overrides.state,
  };
  const client = new SchoolMailClient({
    getCredential: async () => credential,
    imapFactory: (options) => {
      const imap = new FakeImap(options, state);
      state.imaps.push(imap);
      return imap;
    },
    smtpFactory: (options) => {
      state.smtpOptions.push(options);
      return {
        async sendMail(message) {
          state.smtpSendCalls += 1;
          state.smtpMessages.push(message);
          if (state.smtpWait) await state.smtpWait.promise;
          if (state.smtpError) throw state.smtpError;
          return {
            messageId: '<safe-id@example.org>',
            accepted: message.to,
            rejected: [],
          };
        },
        close() {},
      };
    },
  });
  return {
    client,
    state,
    setCredential(value) { credential = value; },
  };
}

test('keyword lookup uses read-only server search and paginates older matching messages', async () => {
  const { client, state } = createHarness();
  state.uids = [1, 2, 3, 4, 5];
  state.messages = state.uids.map(uid => ({ uid, envelope: { subject: 'University talk', from: [] }, flags: new Set() }));
  const first = await client.list({ query: '大学宣讲', limit: 2 });
  assert.deepEqual(state.searchCalls[0].query, { or: [{ subject: '大学宣讲' }, { body: '大学宣讲' }] });
  assert.deepEqual(first.items.map(item => item.uid), ['5', '4']);
  assert.equal(first.nextCursor, 2);
  const second = await client.list({ query: '大学宣讲', limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map(item => item.uid), ['3', '2']);
  assert.equal(second.total, 5);
  await assert.rejects(client.list({ query: 'x\r\nBODY secret' }), /条件无效/);
  await assert.rejects(client.list({ cursor: -1 }), /条件无效/);
});

test('list is bounded, sanitized, newest-first, and uses TLS/read-only IMAP', async () => {
  const { client, state } = createHarness();
  const result = await client.list({ unread: false, limit: 2 });

  assert.deepEqual(result.items.map((entry) => entry.uid), ['102', '101']);
  assert.equal(result.items[0].unread, false);
  assert.equal(result.items[1].unread, true);
  assert.equal(result.items[1].hasAttachments, true);
  assert.equal(result.items[0].hasAttachments, false);
  assert.equal(state.fetchAllCalls[0].query.bodyStructure, true);
  assert.equal(result.items[1].subject, 'Subject Injected');
  assert.deepEqual(result.items[1].from, [{ name: 'Teacher Name', address: 'teacher@shphschool.com' }]);
  assert.deepEqual(state.searchCalls[0], { query: { all: true }, options: { uid: true }, folder: 'INBOX' });
  assert.equal(state.imaps[0].lockOptions[0].readOnly, true);
  assert.equal(state.imaps[0].options.host, IMAP_HOST);
  assert.equal(state.imaps[0].options.port, IMAP_PORT);
  assert.equal(state.imaps[0].options.secure, true);
  assert.equal(state.imaps[0].options.tls.rejectUnauthorized, true);
  assert.equal(state.imaps[0].options.logger, false);
  assert.equal(state.imaps[0].options.logRaw, false);
  assert.equal(state.connectCalls, 1);

  await assert.rejects(() => client.list({ limit: 101 }), (error) => error.code === 'INVALID_ARGUMENT');
});

test('read parses local MIME, does not mark seen, and returns bounded Buffer attachment', async () => {
  const { client, state } = createHarness();
  const mail = await client.read('101');

  assert.equal(mail.uid, '101');
  assert.equal(mail.subject, 'Native inbox test');
  assert.deepEqual(mail.from, [{ name: 'Teacher Name', address: 'teacher@shphschool.com' }]);
  assert.deepEqual(mail.to, [{ name: 'Student', address: 'student@shphschool.com' }]);
  assert.match(mail.text, /Hello from the native mailbox\.\nSecond line\./);
  assert.equal(mail.attachments.length, 1);
  assert.equal(mail.attachments[0].name, '.._unsafe_.txt');
  assert.equal(mail.attachments[0].size, attachmentBytes.length);
  assert.deepEqual(mail.contactCandidates.map((entry) => entry.address), ['teacher@shphschool.com', 'helper@example.org']);

  const content = await client.attachment('101', mail.attachments[0].id);
  assert.ok(Buffer.isBuffer(content));
  assert.deepEqual(content, attachmentBytes);
  assert.equal(state.imaps[0].fetchOneCalls[0].query.source.maxLength, MAX_RAW_MESSAGE_BYTES + 1);
  assert.ok(state.imaps[0].lockOptions.every((entry) => entry.readOnly === true));
  assert.equal(typeof state.imaps[0].messageFlagsAdd, 'undefined');
});

test('HTML-only messages become inert text without remote resources or scripts', async () => {
  const { client } = createHarness();
  const mail = await client.read('102');
  assert.match(mail.text, /Hello & world/);
  assert.match(mail.text, /Visible label/);
  assert.doesNotMatch(mail.text, /https:\/\//);
  assert.doesNotMatch(mail.text, /tracker\.invalid|external\.invalid|steal/);
});

test('real multipart MIME retains a reset button as metadata and resolves only that current message link', async () => {
  const { client, state } = createHarness();
  const destination = 'https://shph.managebac.cn/reset?token=fixture-only&amp;source=mail';
  state.sources.set('102', Buffer.from([
    'From: Notice <notice@example.com>', 'To: Student <student@shphschool.com>', 'Subject: Password reset request',
    'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="links-test"', '',
    '--links-test', 'Content-Type: text/plain; charset=utf-8', '', 'Click the button below.\n\n\n\nInstructions.',
    '--links-test', 'Content-Type: text/html; charset=utf-8', '', `<p>Click the button.</p><a href="${destination}"><img src="cid:button" alt="Reset password"></a>`,
    '--links-test--', '',
  ].join('\r\n')));
  const detail = await client.read('102');
  assert.equal(detail.links.length, 1); assert.equal(detail.links[0].label, 'Reset password');
  assert.equal(detail.links[0].host, 'shph.managebac.cn'); assert.equal(detail.links[0].url, undefined);
  assert.doesNotMatch(JSON.stringify(detail), /fixture-only|\n\n\n/);
  const target = await client.link('102', detail.links[0].id);
  assert.equal(target.url, 'https://shph.managebac.cn/reset?token=fixture-only&source=mail');
  await assert.rejects(() => client.link('101', detail.links[0].id), error => error.code === 'NOT_FOUND');
  await assert.rejects(() => client.link('102', 'https://example.com'), error => error.code === 'INVALID_ARGUMENT');
  assert.equal(state.smtpSendCalls, 0);
});

test('contacts only contain headers observed for the current account and reset on account switch', async () => {
  const { client, setCredential } = createHarness();
  assert.deepEqual(await client.contacts(), []);
  await client.list({ limit: 2 });
  assert.deepEqual(await client.contacts(), [
    { name: 'Helper', address: 'helper@example.org' },
    { name: 'Teacher Name', address: 'teacher@shphschool.com' },
  ]);
  assert.deepEqual(await client.contacts({ query: 'teacher' }), [
    { name: 'Teacher Name', address: 'teacher@shphschool.com' },
  ]);

  setCredential({ username: 'other@shphschool.com', password: 'other-code' });
  assert.deepEqual(await client.contacts(), []);
});

test('epoch prevents an old account list request from flowing into a new account', async () => {
  const wait = deferred();
  const { client, state, setCredential } = createHarness({ state: { fetchAllWait: wait } });
  const oldRequest = client.list({ limit: 2 });
  while (!state.fetchAllCalls.length) await new Promise((resolve) => setImmediate(resolve));

  setCredential({ username: 'other@shphschool.com', password: 'other-code' });
  assert.deepEqual(await client.contacts(), []);
  wait.resolve();
  await assert.rejects(oldRequest, (error) => error instanceof MailClientError && error.code === 'STALE_SESSION');
  assert.equal(state.imaps[0].closed, true);
  assert.deepEqual(await client.contacts(), []);
});

test('prepareSend validates plain text and send consumes one confirmed account generation', async () => {
  const { client, state } = createHarness();
  const prepared = await client.prepareSend({
    to: 'Teacher <teacher@shphschool.com>',
    cc: 'helper@example.org; teacher@shphschool.com',
    subject: 'A question',
    text: 'Plain text only',
  });
  assert.match(prepared._generation, /^[0-9a-f-]{36}$/);
  assert.deepEqual(prepared.confirmation.recipients, ['Teacher <teacher@shphschool.com>', 'helper@example.org']);

  const result = await client.send(prepared);
  assert.deepEqual(result, {
    messageId: '<safe-id@example.org>',
    accepted: ['teacher@shphschool.com'],
    rejected: [],
  });
  assert.equal(state.smtpSendCalls, 1);
  assert.equal(state.smtpOptions[0].host, SMTP_HOST);
  assert.equal(state.smtpOptions[0].port, SMTP_PORT);
  assert.equal(state.smtpOptions[0].secure, true);
  assert.equal(state.smtpOptions[0].tls.rejectUnauthorized, true);
  assert.equal(state.smtpOptions[0].logger, false);
  assert.equal(state.smtpOptions[0].debug, false);
  assert.equal(state.smtpOptions[0].disableFileAccess, true);
  assert.equal(state.smtpOptions[0].disableUrlAccess, true);
  assert.equal(state.smtpMessages[0].from, 'student@shphschool.com');
  assert.equal(state.smtpMessages[0].html, undefined);

  await assert.rejects(() => client.send(prepared), (error) => error.code === 'STALE_DRAFT');
  assert.equal(state.smtpSendCalls, 1, 'a confirmed draft is one-shot and cannot be double-sent');
});

test('confirmed draft cannot be sent after account switch or invalidation', async () => {
  const harness = createHarness();
  const first = await harness.client.prepareSend({ to: 'teacher@example.org', subject: '', text: 'hello' });
  harness.setCredential({ username: 'other@shphschool.com', password: 'other-code' });
  await assert.rejects(() => harness.client.send(first), (error) => error.code === 'STALE_DRAFT');
  assert.equal(harness.state.smtpSendCalls, 0);

  const second = await harness.client.prepareSend({ to: 'teacher@example.org', subject: '', text: 'hello' });
  await harness.client.invalidate();
  await assert.rejects(() => harness.client.send(second), (error) => error.code === 'STALE_DRAFT');
  assert.equal(harness.state.smtpSendCalls, 0);
});

test('prepared drafts expire, are capped, and can be cancelled explicitly', async () => {
  let now = 1_000;
  let credential = { username: 'student@shphschool.com', password: 'code' };
  const smtpMessages = [];
  const client = new SchoolMailClient({
    now: () => now,
    getCredential: async () => credential,
    imapFactory: () => { throw new Error('not used'); },
    smtpFactory: () => ({
      async sendMail(message) {
        smtpMessages.push(message);
        return { accepted: message.to, rejected: [], messageId: 'id' };
      },
      close() {},
    }),
  });
  const cancelled = await client.prepareSend({ to: 'teacher@example.org', subject: '', text: 'cancel me' });
  assert.equal(client.cancelPreparedSend(cancelled), true);
  await assert.rejects(() => client.send(cancelled), (error) => error.code === 'STALE_DRAFT');

  const oldest = await client.prepareSend({ to: 'teacher@example.org', subject: '', text: 'oldest' });
  for (let index = 1; index <= MAX_PREPARED_DRAFTS; index += 1) {
    await client.prepareSend({ to: 'teacher@example.org', subject: '', text: `draft ${index}` });
  }
  await assert.rejects(() => client.send(oldest), (error) => error.code === 'STALE_DRAFT');

  const expired = await client.prepareSend({ to: 'teacher@example.org', subject: '', text: 'expire' });
  now += PREPARED_DRAFT_TTL_MS + 1;
  await assert.rejects(() => client.send(expired), (error) => error.code === 'STALE_DRAFT');
  assert.equal(smtpMessages.length, 0);
  void credential;
});

test('account switch after SMTP begins reports uncertain result, never ordinary stale', async () => {
  const wait = deferred();
  const { client, state, setCredential } = createHarness({ state: { smtpWait: wait } });
  const prepared = await client.prepareSend({ to: 'teacher@example.org', subject: 'x', text: 'body' });
  const sending = client.send(prepared);
  while (!state.smtpSendCalls) await new Promise((resolve) => setImmediate(resolve));
  setCredential({ username: 'other@shphschool.com', password: 'other-code' });
  await client.contacts();
  wait.resolve();
  await assert.rejects(sending, (error) => {
    assert.equal(error.code, 'SEND_FAILED');
    assert.equal(error.message, '发送结果不确定，请先查已发送，不要重复点击');
    return true;
  });
  assert.equal(state.smtpSendCalls, 1);
});

test('SMTP is attempted once and uncertain failure is safe and non-retryable', async () => {
  const { client, state } = createHarness();
  state.smtpError = new Error('server leaked student@shphschool.com client-auth-code');
  const prepared = await client.prepareSend({ to: 'teacher@example.org', subject: 'Test', text: 'body' });
  await assert.rejects(() => client.send(prepared), (error) => {
    assert.equal(error.code, 'SEND_FAILED');
    assert.equal(error.message, '发送结果不确定，请先查已发送，不要重复点击');
    assert.doesNotMatch(error.message, /student@|client-auth-code/);
    return true;
  });
  await assert.rejects(() => client.send(prepared), (error) => error.code === 'STALE_DRAFT');
  assert.equal(state.smtpSendCalls, 1);
});

test('draft validation rejects header injection, HTML, paths, and size overflows', async () => {
  const { client } = createHarness();
  await assert.rejects(() => client.prepareSend({ to: 'victim@example.org\r\nBcc: x@example.org', subject: 'x', text: 'x' }), (error) => error.code === 'INVALID_DRAFT');
  await assert.rejects(() => client.prepareSend({ to: 'victim@example.org', subject: 'x', text: 'x', html: '<b>x</b>' }), (error) => error.code === 'INVALID_DRAFT');
  await assert.rejects(() => client.prepareSend({
    to: 'victim@example.org', subject: 'x', text: 'x', attachments: [{ name: 'x', path: 'C:\\secret.txt' }],
  }), (error) => error.code === 'INVALID_DRAFT');
  await assert.rejects(() => client.prepareSend({
    to: 'victim@example.org', subject: 'x', text: 'x', attachments: [{ name: 'x.bin', content: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) }],
  }), (error) => error.code === 'INVALID_DRAFT');
  await assert.rejects(() => client.prepareSend({
    to: 'victim@example.org', subject: 'x', text: 'a'.repeat(MAX_BODY_BYTES + 1),
  }), (error) => error.code === 'INVALID_DRAFT');
});

test('oversized incoming message is rejected before parsing and errors never expose credentials', async () => {
  const tooLarge = createHarness();
  tooLarge.state.reportedSizes.set('101', MAX_RAW_MESSAGE_BYTES + 1);
  await assert.rejects(() => tooLarge.client.read('101'), (error) => error.code === 'MESSAGE_TOO_LARGE');

  const failed = createHarness();
  failed.state.connectError = new Error('bad student@shphschool.com / client-auth-code');
  await assert.rejects(() => failed.client.list(), (error) => {
    assert.equal(error.code, 'IMAP_CONNECTION_FAILED');
    assert.doesNotMatch(error.message, /student@|client-auth-code/);
    return true;
  });
});

test('known Coremail authorization errors are actionable without exposing server text or credentials', async () => {
  const required = createHarness();
  const requiredError = new Error('student@shphschool.com secret-code ERR.LOGIN.REQCODE raw server response');
  requiredError.responseStatus = 'NO';
  requiredError.responseText = 'authentication rejected: ERR.LOGIN.REQCODE secret-code';
  required.state.connectError = requiredError;
  await assert.rejects(() => required.client.list(), (error) => {
    assert.equal(error.code, 'AUTH_CODE_REQUIRED');
    assert.match(error.message, /设置 → 客户端设置/);
    assert.match(error.message, /授权码/);
    assert.doesNotMatch(error.message, /student@|secret-code|raw server response|ERR\.LOGIN/);
    return true;
  });

  const disabled = createHarness();
  const disabledError = new Error('ERR.ILLEGAL.EMAIL user=student@shphschool.com password=secret-code');
  disabledError.responseText = 'NO [ERR.ILLEGAL.EMAIL] protocol disabled for account';
  disabled.state.connectError = disabledError;
  await assert.rejects(() => disabled.client.list(), (error) => {
    assert.equal(error.code, 'IMAP_DISABLED');
    assert.match(error.message, /尚未开通 IMAP/);
    assert.match(error.message, /学校管理员/);
    assert.doesNotMatch(error.message, /student@|secret-code|ERR\.ILLEGAL/);
    return true;
  });
});

test('harvestContacts scans INBOX and sent folders, dedupes and filters addresses', async () => {
  const { client, state } = createHarness({
    state: {
      searchResults: { 'INBOX': [101, 102], '&XfJT0ZAB-': [201] },
      messages: [
        {
          uid: 101,
          envelope: {
            from: [{ name: 'Teacher', address: 'TEACHER@shphschool.com' }],
            to: [{ name: 'Student', address: 'student@shphschool.com' }],
            cc: [{ name: 'Helper', address: 'helper@example.org' }],
          },
        },
        {
          uid: 102,
          envelope: {
            from: [{ name: 'Updates', address: 'no-reply@example.org' }],
            to: [{ name: 'Student', address: 'student@shphschool.com' }],
            cc: [],
          },
        },
        {
          uid: 201,
          envelope: {
            from: [{ name: 'Student', address: 'student@shphschool.com' }],
            to: [{ name: 'Teacher', address: 'teacher@shphschool.com' }],
            cc: [],
          },
        },
      ],
    },
  });
  const result = await client.harvestContacts({ perFolder: 400 });
  assert.equal(result.folders, 2);
  assert.equal(result.scanned.length, 2);
  assert.deepEqual(
    result.scanned.map((entry) => entry.mailbox),
    ['INBOX', '&XfJT0ZAB-'],
  );
  const addresses = result.contacts.map((entry) => entry.address);
  assert.ok(addresses.includes('teacher@shphschool.com'));
  assert.ok(addresses.includes('helper@example.org'));
  assert.ok(!addresses.includes('student@shphschool.com'), 'own address is excluded');
  assert.ok(!addresses.some((entry) => /no-reply/.test(entry)), 'system addresses are excluded');
  const teacher = result.contacts.find((entry) => entry.address === 'teacher@shphschool.com');
  assert.equal(teacher.count, 2, 'counted once from inbox From and once from sent To');
  // Drafts folder is outside the scan scope.
  assert.ok(!state.lockPaths.includes('&g0l6P3ux-'));
});

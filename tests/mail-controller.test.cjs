'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMailController, safeAttachmentFilename, UNCERTAIN_SEND } = require('../electron/mail-controller.cjs');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(options = {}) {
  let accountRevision = options.revision || 'account-a';
  const events = [];
  const calls = {
    getClient: 0,
    prepare: [],
    cancel: [],
    send: [],
    read: [],
    attachment: [],
    messageDialogs: [],
    saveDialogs: [],
    writes: [],
    links: [],
    external: [],
  };
  const client = {
    async prepareSend(draft) {
      events.push('prepare');
      calls.prepare.push(draft);
      if (options.prepareError) throw options.prepareError;
      return {
        ...draft,
        _generation: 'one-shot-token',
        confirmation: {
          recipients: [draft.to, draft.cc].filter(Boolean),
          subject: draft.subject || '(无主题)',
          bodyBytes: Buffer.byteLength(draft.text || ''),
        },
      };
    },
    cancelPreparedSend(prepared) {
      events.push('cancel-token');
      calls.cancel.push(prepared);
      if (options.cancelError) throw options.cancelError;
      return true;
    },
    async send(prepared) {
      events.push('send');
      calls.send.push(prepared);
      if (options.sendWait) await options.sendWait.promise;
      if (options.sendError) throw options.sendError;
      return options.sendResult || { accepted: ['teacher@example.test'], rejected: [] };
    },
    async read(uid) {
      calls.read.push(uid);
      return options.readResult || {
        uid,
        attachments: [{ id: 'attachment-1', name: '../../report.pdf', size: 4 }],
      };
    },
    async attachment(uid, id) {
      calls.attachment.push({ uid, id });
      return options.attachmentBytes || Buffer.from('data');
    },
    async link(uid, linkId) {
      calls.links.push({ uid, linkId });
      if (options.linkError) throw options.linkError;
      return options.linkResult === undefined ? { url: 'https://example.com/course', label: 'untrusted label', host: 'example.com' } : options.linkResult;
    },
    list: async () => ({ items: [] }),
    contacts: async () => [],
  };
  const dialog = {
    async showMessageBox(window, config) {
      events.push('confirm-dialog');
      calls.messageDialogs.push({ window, config });
      if (options.messageWait) return options.messageWait.promise;
      return { response: options.messageResponse ?? 1 };
    },
    async showSaveDialog(window, config) {
      events.push('save-dialog');
      calls.saveDialogs.push({ window, config });
      if (options.saveWait) return options.saveWait.promise;
      return options.saveResult || { canceled: false, filePath: 'C:\\chosen\\saved.bin' };
    },
  };
  const controller = createMailController({
    getClient() {
      calls.getClient += 1;
      if (options.getClientError) throw options.getClientError;
      return client;
    },
    status: () => ({ saved: true }),
    revision: () => accountRevision,
    dialog,
    getWindow: () => 'main-window',
    async writeFile(filePath, bytes) {
      events.push('write');
      calls.writes.push({ filePath, bytes });
      if (options.writeError) throw options.writeError;
    },
    openExternal: async (url) => {
      calls.external.push(url);
      if (options.externalError) throw options.externalError;
    },
    getLanguage: () => options.language || 'zh-CN',
  });
  return {
    controller,
    client,
    calls,
    events,
    setRevision(value) { accountRevision = value; },
  };
}

const draft = {
  to: 'teacher@example.test',
  cc: 'helper@example.test',
  subject: 'Question',
  text: 'Hello',
  html: '<b>must not cross boundary</b>',
  bcc: 'hidden@example.test',
  attachments: [{ path: 'C:\\secret.txt' }],
};

test('confirmation cancellation never sends and releases the prepared token', async () => {
  const h = harness({ messageResponse: 0 });
  const result = await h.controller.send(draft);
  assert.deepEqual(result, { canceled: true });
  assert.equal(h.calls.send.length, 0);
  assert.equal(h.calls.cancel.length, 1);
  assert.deepEqual(h.events, ['prepare', 'confirm-dialog', 'cancel-token']);
});

test('controller sends only after explicit confirmation and strips privileged draft fields', async () => {
  const h = harness({ messageResponse: 1 });
  const result = await h.controller.send(draft);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(h.events, ['prepare', 'confirm-dialog', 'send', 'cancel-token']);
  assert.deepEqual(h.calls.prepare[0], {
    to: draft.to,
    cc: draft.cc,
    subject: draft.subject,
    text: draft.text,
  });
  assert.equal(h.calls.send[0]._generation, 'one-shot-token');
  assert.equal(h.calls.messageDialogs[0].config.defaultId, 0);
  assert.equal(h.calls.messageDialogs[0].config.cancelId, 0);
  assert.match(h.calls.messageDialogs[0].config.detail, /teacher@example\.test/);
  assert.match(h.calls.messageDialogs[0].config.detail, /Question/);
});

test('account switch while confirmation is open rejects the old draft without sending', async () => {
  const confirmation = deferred();
  const h = harness({ messageWait: confirmation });
  const pending = h.controller.send(draft);
  while (!h.calls.messageDialogs.length) await new Promise((resolve) => setImmediate(resolve));
  h.setRevision('account-b');
  confirmation.resolve({ response: 1 });
  await assert.rejects(pending, /邮箱账号已修改/);
  assert.equal(h.calls.send.length, 0);
  assert.equal(h.calls.cancel.length, 1);
});

test('duplicate click is rejected while the first confirmation is pending', async () => {
  const confirmation = deferred();
  const h = harness({ messageWait: confirmation });
  const first = h.controller.send(draft);
  while (!h.calls.messageDialogs.length) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => h.controller.send(draft), /不要重复点击/);
  assert.equal(h.calls.prepare.length, 1);
  assert.equal(h.calls.send.length, 0);
  confirmation.resolve({ response: 0 });
  assert.deepEqual(await first, { canceled: true });
});

test('partial SMTP acceptance is never reported as full success', async () => {
  const h = harness({ sendResult: { accepted: ['one@example.test'], rejected: ['two@example.test'] } });
  const result = await h.controller.send(draft);
  assert.equal(result.ok, false);
  assert.match(result.error, /部分收件人未接受/);
  assert.match(result.error, /不要向全部收件人重复发送/);
  assert.equal(h.calls.send.length, 1);
});

test('empty or thrown SMTP result is reported as uncertain without retry', async () => {
  const empty = harness({ sendResult: { accepted: [], rejected: [] } });
  assert.deepEqual(await empty.controller.send(draft), { ok: false, error: UNCERTAIN_SEND });
  assert.equal(empty.calls.send.length, 1);

  const failed = harness({ sendError: new Error('socket timeout with secrets') });
  assert.deepEqual(await failed.controller.send(draft), { ok: false, error: UNCERTAIN_SEND });
  assert.equal(failed.calls.send.length, 1);
});

test('account switch after SMTP begins becomes uncertain, never a stale success', async () => {
  const sendWait = deferred();
  const h = harness({ sendWait });
  const pending = h.controller.send(draft);
  while (!h.calls.send.length) await new Promise((resolve) => setImmediate(resolve));
  h.setRevision('account-b');
  sendWait.resolve();
  assert.deepEqual(await pending, { ok: false, error: UNCERTAIN_SEND });
  assert.equal(h.calls.send.length, 1);
});

test('a getClient failure does not leave the duplicate-send lock engaged', async () => {
  const h = harness({ getClientError: new Error('mail unavailable') });
  await assert.rejects(() => h.controller.send(draft), /mail unavailable/);
  await assert.rejects(() => h.controller.send(draft), /mail unavailable/);
  assert.equal(h.calls.getClient, 2);
});

test('attachment save-dialog cancellation never downloads bytes or writes a file', async () => {
  const h = harness({ saveResult: { canceled: true } });
  const result = await h.controller.download({ uid: '101', attachmentId: 'attachment-1' });
  assert.deepEqual(result, { canceled: true });
  assert.deepEqual(h.calls.read, ['101']);
  assert.equal(h.calls.attachment.length, 0);
  assert.equal(h.calls.writes.length, 0);
});

test('attachment filename is inert and only the native chosen path is written', async () => {
  const bytes = Buffer.from([0, 1, 2, 3]);
  const h = harness({
    readResult: { uid: '101', attachments: [{ id: 'attachment-1', name: '..\\..\\CON. ' }] },
    attachmentBytes: bytes,
    saveResult: { canceled: false, filePath: 'D:\\User Chosen\\answer.bin' },
  });
  const result = await h.controller.download({ uid: '101', attachmentId: 'attachment-1' });
  assert.deepEqual(result, { ok: true });
  assert.equal(h.calls.saveDialogs[0].config.defaultPath, '_CON');
  assert.deepEqual(h.calls.attachment, [{ uid: '101', id: 'attachment-1' }]);
  assert.equal(h.calls.writes[0].filePath, 'D:\\User Chosen\\answer.bin');
  assert.deepEqual(h.calls.writes[0].bytes, bytes);
});

test('account switch in the attachment dialog rejects before fetching or writing bytes', async () => {
  const saveWait = deferred();
  const h = harness({ saveWait });
  const pending = h.controller.download({ uid: '101', attachmentId: 'attachment-1' });
  while (!h.calls.saveDialogs.length) await new Promise((resolve) => setImmediate(resolve));
  h.setRevision('account-b');
  saveWait.resolve({ canceled: false, filePath: 'D:\\chosen.bin' });
  await assert.rejects(pending, /邮箱账号已修改/);
  assert.equal(h.calls.attachment.length, 0);
  assert.equal(h.calls.writes.length, 0);
});

test('safeAttachmentFilename blocks traversal, control names, and Windows devices', () => {
  assert.equal(safeAttachmentFilename('../../folder/answer.pdf'), 'answer.pdf');
  assert.equal(safeAttachmentFilename('..\\..\\NUL'), '_NUL');
  assert.equal(safeAttachmentFilename('...'), '附件');
  assert.equal(safeAttachmentFilename('bad<name>?*.txt'), 'bad_name___.txt');
  assert.ok(safeAttachmentFilename('a'.repeat(300)).length <= 180);
});

test('mail link cancellation never opens the browser and does not trust a forged URL field', async () => {
  const h = harness({ messageResponse: 0, linkResult: { url: 'https://example.com/path?token=secret', label: '恶意标签', host: 'example.com' } });
  const result = await h.controller.openLink({ uid: '101', linkId: 'link-1', url: 'https://evil.example/' });
  assert.deepEqual(result, { canceled: true });
  assert.deepEqual(h.calls.links, [{ uid: '101', linkId: 'link-1' }]);
  assert.deepEqual(h.calls.external, []);
  assert.doesNotMatch(h.calls.messageDialogs[0].config.detail, /token|secret|恶意/);
});

test('dangerous or missing extracted links fail without showing or opening a URL', async () => {
  for (const linkResult of [{ url: 'javascript:alert(1)' }, { url: 'http://example.test/' }, null]) {
    const h = harness({ linkResult });
    const result = await h.controller.openLink({ uid: '101', linkId: 'link-1' });
    assert.deepEqual(result, { ok: false, error: '无法打开邮件链接，请稍后重试' });
    assert.equal(h.calls.messageDialogs.length, 0);
    assert.equal(h.calls.external.length, 0);
  }
});

test('account switch during link confirmation blocks opening and duplicate clicks are single-flight', async () => {
  const confirmation = deferred();
  const h = harness({ messageWait: confirmation });
  const first = h.controller.openLink({ uid: '101', linkId: 'link-1' });
  while (!h.calls.messageDialogs.length) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await h.controller.openLink({ uid: '101', linkId: 'link-1' }), { canceled: true });
  h.setRevision('account-b');
  confirmation.resolve({ response: 1 });
  await assert.rejects(first, /邮箱账号已修改/);
  assert.equal(h.calls.external.length, 0);
});

test('link opening failures are sanitized and successful opening receives only the verified URL', async () => {
  const failed = harness({ externalError: new Error('token=secret') });
  const failure = await failed.controller.openLink({ uid: '101', linkId: 'link-1' });
  assert.deepEqual(failure, { ok: false, error: '无法打开邮件链接，请稍后重试' });
  assert.doesNotMatch(failure.error, /token|secret|example/);
  const success = harness({ language: 'en' });
  assert.deepEqual(await success.controller.openLink({ uid: '101', linkId: 'link-1' }), { ok: true });
  assert.deepEqual(success.calls.external, ['https://example.com/course']);
  assert.match(success.calls.messageDialogs[0].config.detail, /^Destination website: https:\/\/example\.com\n/);
  assert.match(success.calls.messageDialogs[0].config.detail, /does not mean the website is trustworthy/);
});

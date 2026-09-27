const test = require('node:test');
const assert = require('node:assert/strict');
const { SchoolDataClient, readUrl } = require('../electron/school-data.cjs');
const { buildMultipart, formEncode } = require('../electron/multipart.cjs');

// Synthetic fixtures only: no student data, no real tokens.
const response = (body, status = 200, headers = {}) => new Response(body, { status, headers });
const TOKEN = 'synthetic-csrf-token';
const dropboxHtml = `<html><head><meta name="csrf-token" content="${TOKEN}"></head><body>
<form action="/student/classes/21/core_tasks/31/dropbox/upload" method="post">
<input type="hidden" name="_method" value="patch"/>
<input type="hidden" name="authenticity_token" value="${TOKEN}"/>
<input type="hidden" name="dropbox[assets_attributes][0][file_cache]" value=""/>
<input type="file" name="dropbox[assets_attributes][0][file]"/>
<input type="submit" name="commit" value="Upload Files"/>
</form></body></html>`;
const linkedDropboxHtml = '<html><body><a href="/student/classes/21/core_tasks/31/dropbox/new">Upload</a></body></html>';
const discussionHtml = `<html><head><meta name="csrf-token" content="${TOKEN}"></head><body><div class="discussion" id="discussion_31"><div class="fr-view">Topic</div></div></body></html>`;

function bodyText(body) {
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  return String(body ?? '');
}

test('multipart writer builds a complete body with copied fields and one file', () => {
  const { body, contentType } = buildMultipart({
    fields: { _method: 'patch', authenticity_token: TOKEN, repeated: ['a', 'b'] },
    file: { field: 'dropbox[assets_attributes][0][file]', filename: 'essay.docx', bytes: Buffer.from('synthetic-bytes'), contentType: 'application/octet-stream' },
  });
  const boundary = contentType.match(/boundary=(.+)$/)?.[1];
  assert.match(contentType, /^multipart\/form-data; boundary=----PHLauncherFormBoundary[0-9a-f]{24}$/);
  const text = body.toString('utf8');
  assert.equal(text.startsWith(`--${boundary}\r\n`), true);
  assert.equal(text.endsWith(`--${boundary}--\r\n`), true);
  for (const field of ['_method', 'authenticity_token', 'repeated']) assert.match(text, new RegExp(`name="${field.replace(/[[\]]/g, '\\$&')}"`));
  assert.match(text, /Content-Disposition: form-data; name="dropbox\[assets_attributes\]\[0\]\[file\]"; filename="essay\.docx"/);
  assert.match(text, /synthetic-bytes/);
  assert.equal((text.match(/name="repeated"/g) || []).length, 2);
});

test('multipart writer rejects empty uploads, oversized forms and unsafe names', () => {
  assert.throws(() => buildMultipart({ file: { field: 'f', filename: 'a.txt', bytes: Buffer.alloc(0) } }), /文件是空的/);
  assert.throws(() => buildMultipart({ fields: Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`f${i}`, 'x'])) }), /字段过多/);
  assert.throws(() => buildMultipart({ fields: { 'bad\r\nname': 'x' } }), /字段名不合法/);
});

test('form encoder keeps a Rails reply payload to the four allowed keys', () => {
  const body = new URLSearchParams(formEncode({ 'reply[body]': 'a<br>b', 'reply[notify_via_email]': '0', 'reply[private]': '1', commit: 'Comment' }));
  assert.deepEqual([...body.keys()].sort(), ['commit', 'reply[body]', 'reply[notify_via_email]', 'reply[private]']);
  assert.equal(body.get('commit'), 'Comment');
});

test('school write allowlist accepts only a task dropbox and a discussion reply', () => {
  assert.equal(readUrl('managebac', '/student/classes/21/core_tasks/31/dropbox/upload', 'POST'), 'https://shph.managebac.cn/student/classes/21/core_tasks/31/dropbox/upload');
  assert.equal(readUrl('managebac', '/student/classes/21/dropbox/upload', 'POST'), 'https://shph.managebac.cn/student/classes/21/dropbox/upload');
  assert.equal(readUrl('managebac', '/student/classes/21/discussions/31/replies', 'POST'), 'https://shph.managebac.cn/student/classes/21/discussions/31/replies');
  for (const value of [
    '/student/classes/21/units', '/student/classes/21/leave', '/student/classes/21/discussions/31',
    '/student/classes/21/core_tasks/31/dropbox/upload?x=1', '/student/profile', '/sessions',
  ]) {
    assert.throws(() => readUrl('managebac', value, 'POST'), { code: 'URL_NOT_ALLOWED' }, value);
  }
  assert.throws(() => readUrl('managebac', 'https://shph.managebac.cn.evil.test/student/classes/21/dropbox/upload', 'POST'), { code: 'URL_NOT_ALLOWED' });
});

test('upload resolves the page form, copies every hidden field and posts the file once', async () => {
  const requests = [];
  const client = new SchoolDataClient({ pause: async () => {}, fetch: async (site, url, init) => {
    requests.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (init.method === 'GET') return response(dropboxHtml);
    return response('', 302, { location: '/student/classes/21/core_tasks/31' });
  } });
  const result = await client.submitTaskFile('21', '31', { bytes: Buffer.from('essay-bytes'), filename: 'essay.docx' });
  assert.equal(result.taskId, '31');
  const post = requests.find((request) => request.method === 'POST');
  assert.equal(post.url, 'https://shph.managebac.cn/student/classes/21/core_tasks/31/dropbox/upload');
  assert.match(post.headers['Content-Type'], /^multipart\/form-data; boundary=/);
  assert.equal(post.headers['X-CSRF-Token'], TOKEN);
  const text = bodyText(post.body);
  for (const field of ['_method', 'authenticity_token', 'dropbox[assets_attributes][0][file_cache]', 'commit']) assert.match(text, new RegExp(`name="${field.replace(/[[\]]/g, '\\$&')}"`));
  assert.match(text, /essay-bytes/);
  // One file part, no second file, and no quiet retry.
  assert.equal(requests.filter((request) => request.method === 'POST').length, 1);
  assert.equal((text.match(/filename=/g) || []).length, 1);
});

test('upload follows only same-class dropbox links when the task page has no form', async () => {
  const requests = [];
  const client = new SchoolDataClient({ pause: async () => {}, fetch: async (site, url) => {
    requests.push(url);
    if (url.endsWith('/dropbox/new')) return response(dropboxHtml);
    return response(linkedDropboxHtml);
  } });
  await client.submitTaskFile('21', '31', { bytes: Buffer.from('bytes'), filename: 'essay.docx' });
  assert.deepEqual(requests.slice(0, 2), [
    'https://shph.managebac.cn/student/classes/21/core_tasks/31',
    'https://shph.managebac.cn/student/classes/21/core_tasks/31/dropbox/new',
  ]);
  const client2 = new SchoolDataClient({ pause: async () => {}, fetch: async () => response('<html><body><a href="https://evil.test/student/classes/21/core_tasks/31/dropbox/new">x</a><a href="/student/classes/99/core_tasks/31/dropbox/new">y</a></body></html>') });
  await assert.rejects(client2.submitTaskFile('21', '31', { bytes: Buffer.from('bytes'), filename: 'e.docx' }), { code: 'NO_SUBMISSION' });
});

test('upload refuses empty, oversized or unsupported submissions before any request', async () => {
  let calls = 0;
  const client = new SchoolDataClient({ pause: async () => {}, fetch: async () => { calls += 1; return response('<html><body>no form</body></html>'); } });
  await assert.rejects(client.submitTaskFile('21', '31', { bytes: Buffer.alloc(0), filename: 'a.docx' }), { code: 'INVALID_FILE' });
  await assert.rejects(client.submitTaskFile('21', '31', { bytes: Buffer.alloc(24 * 1024 * 1024 + 1), filename: 'a.docx' }), { code: 'FILE_TOO_LARGE' });
  await assert.rejects(client.submitTaskFile('../sessions', '31', { bytes: Buffer.from('x'), filename: 'a.docx' }), { code: 'INVALID_ID' });
  assert.equal(calls, 0);
});

test('discussion reply posts an escaped, urlencoded comment with the page token', async () => {
  const requests = [];
  const client = new SchoolDataClient({ pause: async () => {}, fetch: async (site, url, init) => {
    requests.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (init.method === 'GET') return response(discussionHtml);
    return response('', 302, { location: '/student/classes/21/discussions/31' });
  } });
  const result = await client.replyToDiscussion('21', '31', 'First line\n<b>not markup</b> & <script>', { private: true });
  assert.equal(result.private, true);
  const post = requests.find((request) => request.method === 'POST');
  assert.equal(post.url, 'https://shph.managebac.cn/student/classes/21/discussions/31/replies');
  assert.equal(post.headers['X-CSRF-Token'], TOKEN);
  assert.equal(post.headers['X-Requested-With'], 'XMLHttpRequest');
  assert.match(post.headers['Content-Type'], /^application\/x-www-form-urlencoded/);
  const form = new URLSearchParams(bodyText(post.body));
  assert.deepEqual([...form.keys()].sort(), ['commit', 'reply[body]', 'reply[notify_via_email]', 'reply[private]']);
  assert.equal(form.get('commit'), 'Comment');
  assert.equal(form.get('reply[private]'), '1');
  assert.equal(form.get('reply[notify_via_email]'), '0');
  assert.equal(form.get('reply[body]'), 'First line<br>&lt;b&gt;not markup&lt;/b&gt; &amp; &lt;script&gt;');
});

test('discussion reply requires content, a token and nothing beyond the reply body', async () => {
  const client = new SchoolDataClient({ pause: async () => {}, fetch: async (site, url, init) => {
    if (init.method === 'GET') return response('<html><body><div class="discussion" id="discussion_31"></div></body></html>');
    return response('');
  } });
  await assert.rejects(client.replyToDiscussion('21', '31', '   '), { code: 'INVALID_BODY' });
  await assert.rejects(client.replyToDiscussion('21', '31', 'x'.repeat(12_001)), { code: 'INVALID_BODY' });
  await assert.rejects(client.replyToDiscussion('21', '31', 'hello'), { code: 'PAGE_CHANGED' });
  const raw = new SchoolDataClient({ pause: async () => {}, fetch: async () => response('') });
  await assert.rejects(raw.request('managebac', '/student/classes/21/discussions/31/replies', {
    method: 'POST', body: formEncode({ 'reply[body]': 'hi', 'reply[notify_via_email]': '0', 'reply[private]': '0', commit: 'Comment', 'reply[pinned]': '1' }),
    contentType: 'application/x-www-form-urlencoded',
  }), { code: 'WRITE_NOT_ALLOWED' });
  await assert.rejects(raw.request('managebac', '/student/classes/21/discussions/31/replies', {
    method: 'POST', body: formEncode({ 'reply[body]': 'hi', 'reply[notify_via_email]': '0', 'reply[private]': '0', commit: 'Delete' }),
    contentType: 'application/x-www-form-urlencoded',
  }), { code: 'WRITE_NOT_ALLOWED' });
});

test('writes fail closed on an expired session and never treat it as success', async () => {
  const client = new SchoolDataClient({ pause: async () => {}, fetch: async (site, url, init) => {
    if (init.method === 'GET') return response(dropboxHtml);
    return response('', 302, { location: '/login' });
  } });
  await assert.rejects(client.submitTaskFile('21', '31', { bytes: Buffer.from('bytes'), filename: 'e.docx' }), { code: 'LOGIN_REQUIRED' });
  const rejected = new SchoolDataClient({ pause: async () => {}, fetch: async (site, url, init) => {
    if (init.method === 'GET') return response(dropboxHtml);
    return response('rejected', 422);
  } });
  await assert.rejects(rejected.submitTaskFile('21', '31', { bytes: Buffer.from('bytes'), filename: 'e.docx' }), { code: 'NETWORK_ERROR' });
});

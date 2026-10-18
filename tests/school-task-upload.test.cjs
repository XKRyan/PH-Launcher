const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTaskUploadManager, readSelectedFile, MAX_BYTES } = require('../electron/school-task-upload.cjs');
function harness(overrides = {}) {
  let revision = 'account-a'; let time = 0; const writes = [];
  const manager = createTaskUploadManager({ getRevision: () => revision,
    chooseFile: async () => path.join(os.tmpdir(), 'essay.docx'),
    readFile: async () => Buffer.from('chosen content'), now: () => time,
    submit: async (...args) => { writes.push(args); return { verification: 'confirmed' }; }, ...overrides });
  return { manager, writes, changeAccount: () => { revision = 'account-b'; }, expire: () => { time += 600001; } };
}
test('choosing never uploads; confirmation uses single-use token and does not claim receipt', async () => {
  const h = harness(); const item = await h.manager.prepare('21', '31');
  assert.deepEqual(Object.keys(item).sort(), ['courseId', 'filename', 'size', 'taskId', 'token']);
  assert.equal(h.writes.length, 0);
  assert.equal((await h.manager.confirm(item.token)).verification, 'unverified');
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0][2].bytes.toString(), 'chosen content');
  await assert.rejects(h.manager.confirm(item.token), /重新选择/);
});
test('cancel, replacement, expiry and changed account revoke pending selections', async () => {
  for (const action of ['cancel', 'replace', 'expire', 'account']) {
    const h = harness(); const item = await h.manager.prepare('21', '31');
    if (action === 'cancel') h.manager.cancel(item.token);
    if (action === 'replace') await h.manager.prepare('21', '32');
    if (action === 'expire') h.expire();
    if (action === 'account') h.changeAccount();
    await assert.rejects(h.manager.confirm(item.token)); assert.equal(h.writes.length, 0);
  }
});
test('picker cancellation and account changes while picking do not authorize uploads', async () => {
  const canceled = harness({ chooseFile: async () => null });
  assert.deepEqual(await canceled.manager.prepare('21', '31'), { canceled: true });
  const changed = harness({ chooseFile: async () => { changed.changeAccount(); return 'a.docx'; } });
  await assert.rejects(changed.manager.prepare('21', '31'), /账号已变化/);
  assert.equal(changed.writes.length, 0);
});
test('invalid ids and empty/large files are rejected before writing', async () => {
  const h = harness(); await assert.rejects(h.manager.prepare('../21', '31'));
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(MAX_BYTES + 1)]) {
    const bad = harness({ readFile: async () => bytes });
    await assert.rejects(bad.manager.prepare('21', '31'), /24 MB/); assert.equal(bad.writes.length, 0);
  }
});
test('double click and network failure never replay a submission', async () => {
  let finish; let calls = 0;
  const h = harness({ submit: () => { calls++; return new Promise((_, reject) => { finish = reject; }); } });
  const item = await h.manager.prepare('21', '31'); const first = h.manager.confirm(item.token);
  await assert.rejects(h.manager.confirm(item.token));
  await assert.rejects(h.manager.prepare('21', '31'), /当前文件操作/);
  finish(new Error('network timeout')); await assert.rejects(first, /network timeout/);
  await assert.rejects(h.manager.confirm(item.token)); assert.equal(calls, 1);
});
test('file reader rejects directories/empty files and reads bounded binary content', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-upload-'));
  try {
    const file = path.join(root, 'work.bin'); fs.writeFileSync(file, Buffer.from([0, 10, 255]));
    assert.deepEqual(await readSelectedFile(file), Buffer.from([0, 10, 255]));
    fs.writeFileSync(file, ''); await assert.rejects(readSelectedFile(file)); await assert.rejects(readSelectedFile(root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('upload IPC validates main renderer and never accepts a renderer file path', () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8');
  assert.match(main, /assertMainRenderer\(event\); return handler\(\.\.\.args\)/);
  assert.match(preload, /submitTaskUpload: \(token\) => ipcRenderer.invoke\('school:submit-task-upload', token\)/);
  assert.match(main, /schoolHandle\('submit-task-upload', \(token\) => taskUploads.confirm\(token\)\)/);
});

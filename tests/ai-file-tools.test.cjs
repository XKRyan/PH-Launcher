'use strict';
// The AI file and school write tools: what the model may ask for, what reaches
// the confirmation card, and what a confirmed proposal is allowed to execute.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  AI_EXTERNAL_WRITE_TOOLS, AI_WORKSPACE_TOOLS, PendingActionStore,
  applyActions, createAction, effectActions, sanitizeToolArguments, toolKind,
} = require('../electron/ai-tools.cjs');
const { listWorkspace, planDocxWrite, readTextFile, resolveInside } = require('../electron/ai-workspace-tools.cjs');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phl-ai-files-'));
const workspace = path.join(tempDir, 'workspace');
fs.mkdirSync(path.join(workspace, 'drafts'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'plan.md'), '# Weekly plan\n- read chapter 3\n');
fs.writeFileSync(path.join(workspace, 'drafts', 'notes.txt'), 'Draft notes');
const outside = path.join(tempDir, 'outside.txt');
fs.writeFileSync(outside, 'must never be readable');
const data = () => ({ tasks: [], notes: [], schedule: [], calendarEvents: [], settings: { ai: { workspace } } });

test('the workspace tool surface is small, explicit and read-only on its own', () => {
  assert.deepEqual(AI_WORKSPACE_TOOLS.map((tool) => tool.function.name), ['list_workspace', 'read_text_file', 'read_docx']);
  assert.deepEqual(AI_EXTERNAL_WRITE_TOOLS.map((tool) => tool.function.name), ['create_docx', 'append_to_docx', 'send_email', 'submit_managebac_task', 'reply_discussion']);
  for (const tool of [...AI_WORKSPACE_TOOLS, ...AI_EXTERNAL_WRITE_TOOLS]) {
    assert.equal(tool.function.parameters.additionalProperties, false, tool.function.name);
  }
  assert.equal(toolKind('list_workspace'), 'read');
  assert.equal(toolKind('read_text_file'), 'read');
  for (const name of ['create_docx', 'append_to_docx', 'send_email', 'submit_managebac_task', 'reply_discussion']) {
    assert.equal(toolKind(name), 'write', name);
  }
});

test('mail recipients are validated before anything is proposed', () => {
  assert.deepEqual(sanitizeToolArguments('send_email', { to: 'A@Example.com, b@example.com', subject: 'Hi', body: 'Body' }, data()),
    { to: 'a@example.com, b@example.com', subject: 'Hi', body: 'Body' });
  assert.deepEqual(sanitizeToolArguments('send_email', { to: 'a@example.com', subject: 'Hi\nBcc: x@y.com', body: 'Body' }, data()).subject, 'Hi Bcc: x@y.com');
  // Trailing separators are ignored, but every real part must be an address.
  assert.equal(sanitizeToolArguments('send_email', { to: 'a@example.com; ;', subject: 's', body: 'b' }, data()).to, 'a@example.com');
  for (const to of ['not-an-address', 'a@b', 'name <a@b.com>', 'a@example.com; b', 'a@example.com,b@example.com,c@example.com,d@example.com,e@example.com,f@example.com']) {
    assert.throws(() => sanitizeToolArguments('send_email', { to, subject: 's', body: 'b' }, data()), /收件人|地址/, to);
  }
  assert.throws(() => sanitizeToolArguments('send_email', { to: 'a@example.com', subject: 's', body: '   ' }, data()), /正文/);
});

test('workspace paths stay relative and identifiers stay numeric', () => {
  assert.deepEqual(sanitizeToolArguments('read_text_file', { path: 'drafts/notes.txt' }, data()), { path: 'drafts/notes.txt' });
  for (const value of ['../outside.txt', 'C:\\Windows\\win.ini', '/etc/passwd', '~/.ssh/id_rsa', 'drafts/../../x']) {
    assert.throws(() => sanitizeToolArguments('read_text_file', { path: value }, data()), /相对路径|离开工作区/, value);
  }
  assert.deepEqual(sanitizeToolArguments('create_docx', { path: 'essay', title: 'T', paragraphs: ['a'] }, data()), { path: 'essay.docx', title: 'T', paragraphs: ['a'] });
  assert.throws(() => sanitizeToolArguments('create_docx', { path: 'e.docx', title: '  ', paragraphs: ['a'] }, data()), /标题/);
  assert.throws(() => sanitizeToolArguments('create_docx', { path: 'e.docx', title: 'T', paragraphs: ['   '] }, data()), /段落/);
  assert.deepEqual(sanitizeToolArguments('submit_managebac_task', { courseId: '21', taskId: '31', filePath: 'drafts/notes.txt' }, data()),
    { courseId: '21', taskId: '31', filePath: 'drafts/notes.txt' });
  assert.throws(() => sanitizeToolArguments('submit_managebac_task', { courseId: '21; rm', taskId: '31', filePath: 'a.txt' }, data()), /编号/);
  assert.deepEqual(sanitizeToolArguments('reply_discussion', { courseId: '21', discussionId: '31', body: 'Thanks\n老师' }, data()),
    { courseId: '21', discussionId: '31', body: 'Thanks\n老师', private: false });
  assert.throws(() => sanitizeToolArguments('reply_discussion', { courseId: '21', discussionId: '31', body: 'x'.repeat(12_001) }, data()), /过长/);
});

test('the workspace sandbox resolves inside the root only', () => {
  assert.equal(resolveInside(workspace, 'drafts/notes.txt'), path.join(fs.realpathSync(workspace), 'drafts', 'notes.txt'));
  for (const value of ['..', '../outside.txt', path.join(tempDir, 'outside.txt'), 'drafts/../../outside.txt']) {
    assert.throws(() => resolveInside(workspace, value), /离开工作区|相对路径/, value);
  }
  assert.equal(planDocxWrite(workspace, 'create_docx', { path: 'drafts/summary', title: 'Summary', paragraphs: ['One'] }).relative, 'drafts/summary.docx');
  assert.throws(() => planDocxWrite(workspace, 'append_to_docx', { path: 'drafts/missing.docx', paragraphs: ['One'] }), /还不存在/);
});

test('listing and reading never leave the workspace or read binary files', async () => {
  const listing = await listWorkspace(workspace, {});
  assert.deepEqual(listing.files.map((file) => file.path), ['drafts/notes.txt', 'plan.md']);
  assert.equal(listing.truncated, false);
  const text = await readTextFile(workspace, { path: 'plan.md' });
  assert.match(text.text, /Weekly plan/);
  await assert.rejects(readTextFile(workspace, { path: '../outside.txt' }), /离开工作区|相对路径/);
  fs.writeFileSync(path.join(workspace, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  await assert.rejects(readTextFile(workspace, { path: 'binary.bin' }), /不是文本文件/);
  await assert.rejects(listWorkspace(workspace, { subdir: 'nope' }), /不存在/);
});

test('file proposals carry a plan, not the file bytes, and are re-checked on execution', async () => {
  const store = new PendingActionStore();
  const action = createAction('create_docx', { path: 'drafts/summary', title: 'Summary', paragraphs: ['First', 'Second'] }, data());
  assert.equal(action.type, 'docx-create');
  assert.equal(action.plan.path, path.join(fs.realpathSync(workspace), 'drafts', 'summary.docx'));
  const proposal = store.create([action], data());
  assert.equal(proposal.groups[0].type, 'workspace-file');
  assert.match(proposal.groups[0].title, /新建 Word 文档：drafts\/summary\.docx/);
  assert.equal(proposal.groups[0].items[0].primary, 'Summary');
  const committed = store.commit(proposal.id, data());
  assert.equal(committed.effects.length, 1);
  assert.equal(committed.effects[0].type, 'docx-create');
  // Nothing was written by confirming; only the effect executor may touch disk.
  assert.equal(fs.existsSync(action.plan.path), false);
});

test('school writes become effects that never mutate launcher data', () => {
  const store = new PendingActionStore();
  const before = data();
  const actions = [
    createAction('send_email', { to: 'teacher@example.com', subject: 'Question', body: 'Hello' }, before),
    createAction('submit_managebac_task', { courseId: '21', taskId: '31', filePath: 'drafts/notes.txt' }, before),
    createAction('reply_discussion', { courseId: '21', discussionId: '31', body: 'Thanks for the feedback', private: true }, before),
  ];
  assert.deepEqual(actions.map((action) => action.type), ['send-email', 'submit-task', 'reply-discussion']);
  assert.equal(actions[1].relative, 'drafts/notes.txt');
  assert.equal(actions[1].filename, 'notes.txt');
  assert.equal(actions[1].bytes, Buffer.byteLength('Draft notes'));
  const applied = applyActions(before, actions);
  assert.deepEqual(applied.data, before, 'effects must not change launcher data');
  assert.deepEqual(applied.counts, { tasksAdded: 0, notesAdded: 0, calendarEvents: 0, lessonsAdded: 0, lessonsUpdated: 0, unchanged: 0, tasksChanged: 0 });
  assert.equal(effectActions(actions).length, 3);
  const proposal = store.create(actions, before);
  assert.deepEqual(proposal.groups.map((group) => group.type), ['email', 'managebac-submission', 'managebac-reply']);
  assert.match(proposal.groups[0].title, /发送邮件给 teacher@example\.com/);
  assert.match(proposal.groups[2].title, /私密回复讨论/);
  const committed = store.commit(proposal.id, before);
  assert.equal(committed.effects.length, 3);
  assert.throws(() => store.commit(proposal.id, before), /过期或已经处理/, 'a confirmed list cannot run twice');
});

test('a missing workspace or file blocks the proposal instead of guessing', () => {
  const withoutWorkspace = { ...data(), settings: { ai: {} } };
  assert.throws(() => createAction('create_docx', { path: 'a', title: 'T', paragraphs: ['x'] }, withoutWorkspace), /工作区/);
  assert.throws(() => createAction('submit_managebac_task', { courseId: '21', taskId: '31', filePath: 'drafts/notes.txt' }, withoutWorkspace), /工作区/);
  assert.throws(() => createAction('submit_managebac_task', { courseId: '21', taskId: '31', filePath: 'missing.txt' }, data()), /找不到要提交的文件/);
  const empty = path.join(workspace, 'empty.bin');
  fs.writeFileSync(empty, '');
  assert.throws(() => createAction('submit_managebac_task', { courseId: '21', taskId: '31', filePath: 'empty.bin' }, data()), /是空的/);
});

test('a confirmed list is bound to unchanged launcher data', () => {
  const store = new PendingActionStore();
  const snapshot = data();
  const proposal = store.create([createAction('create_tasks', { tasks: [{ title: 'Essay' }] }, snapshot)], snapshot);
  assert.throws(() => store.commit(proposal.id, { ...snapshot, tasks: [{ id: 'x', title: 'Other' }] }), /数据已发生变化/);
});

test.after(() => { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* no-op */ } });

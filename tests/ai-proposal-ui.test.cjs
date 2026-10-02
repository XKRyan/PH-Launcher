'use strict';
// The confirmation card must be honest about what confirming will do: local data
// writes are saved, while file/mail/school actions really happen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const appSource = fs.readFileSync(require.resolve('../src/app.js'), 'utf8');

function harness() {
  const { window } = parseHTML('<html><body></body></html>');
  const context = {
    window, document: window.document, console, URL, Date, Intl, structuredClone,
    crypto: { randomUUID: () => 'test-id' },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
  };
  vm.runInNewContext(`${appSource}\nthis.__proposalUi = { proposalMarkup, committedSummary, effectOutcome };`, context);
  return context.__proposalUi;
}
const ui = harness();

const localProposal = {
  id: 'p-1',
  title: 'AI 建议的更改',
  groups: [{ type: 'tasks', title: '添加 1 个任务', items: [{ primary: 'Essay', secondary: 'English' }] }],
};
const fileProposal = {
  id: 'p-2',
  title: 'AI 建议的更改',
  groups: [{ type: 'workspace-file', title: '新建 Word 文档：drafts/summary.docx', items: [{ primary: 'Summary', secondary: '2 段' }] }],
};
const mailProposal = {
  id: 'p-3',
  title: 'AI 建议的更改',
  groups: [{ type: 'email', title: '发送邮件给 teacher@example.com', items: [{ primary: 'Question', secondary: '12 字 · 确认后还会再弹出一次系统确认' }] }],
};

test('a local change list promises a save and keeps the write wording', () => {
  const html = ui.proposalMarkup(localProposal);
  assert.match(html, /只有确认后才会保存到 PH Launcher/);
  assert.match(html, /核对无误，确认写入/);
  assert.match(html, /data-confirm-proposal="p-1"/);
  assert.match(html, /data-cancel-proposal="p-1"/);
  assert.match(html, /等待确认/);
});

test('an external action is announced as executed, not saved', () => {
  for (const [proposal, expected] of [[fileProposal, /只有确认后才会执行；邮件、提交和回复发布后无法撤回/], [mailProposal, /发送前还会再弹出一次系统确认/]]) {
    const html = ui.proposalMarkup(proposal);
    assert.match(html, expected);
    assert.doesNotMatch(html, /才会保存到 PH Launcher/);
    assert.match(html, /核对无误，确认执行/);
    assert.match(html, /新建 Word 文档：drafts\/summary\.docx|发送邮件给 teacher@example\.com/);
  }
});

test('a resolved card keeps its buttons disabled and shows the outcome status', () => {
  const committed = ui.proposalMarkup({ ...localProposal, status: 'committed' });
  assert.match(committed, /已写入/);
  assert.match(committed, /class="ai-proposal-card resolved"/);
  const canceled = ui.proposalMarkup({ ...mailProposal, status: 'canceled' });
  assert.match(canceled, /已取消/);
  assert.equal(ui.proposalMarkup(null), '');
  assert.equal(ui.proposalMarkup({ id: 'x' }), '');
});

test('titles and items from the model are rendered as inert text', () => {
  const hostile = ui.proposalMarkup({
    id: 'p-4',
    title: '<img src=x onerror=alert(1)>',
    groups: [{ type: 'email', title: '<script>bad()</script>', items: [{ primary: '<b>bold</b>', secondary: '"quoted"' }] }],
  });
  assert.doesNotMatch(hostile, /<img|<script|<b>bold<\/b>/);
  assert.match(hostile, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(hostile, /&lt;b&gt;bold&lt;\/b&gt;/);
});

test('the toast summary lists what happened and marks a failed effect as an error', () => {
  assert.equal(ui.committedSummary({ tasksAdded: 2, notesAdded: 1, unchanged: 3 }), '2 个任务、1 条笔记、3 项已存在');
  assert.equal(ui.committedSummary({}), '没有需要重复写入的内容');
  const ok = ui.effectOutcome([{ type: 'docx-create', ok: true, message: '已写入工作区文件 drafts/summary.docx' }]);
  // Objects cross the VM boundary, so compare fields instead of prototypes.
  assert.equal(ok.text, '已写入工作区文件 drafts/summary.docx');
  assert.equal(ok.failed, false);
  const failed = ui.effectOutcome([{ type: 'submit-task', ok: true, message: '已提交 a.docx' }, { type: 'send-email', ok: false, message: '发送结果不确定，请到已发送中核对' }]);
  assert.equal(failed.failed, true);
  assert.match(failed.text, /已提交 a\.docx；发送结果不确定/);
  assert.equal(ui.effectOutcome([]).text, '');
  assert.equal(ui.effectOutcome(undefined).failed, false);
});

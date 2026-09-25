'use strict';
// 2026-09-19 用户要求：「我的课程界面加一个 discussion 界面」。
// ManageBac 只有「按课程」的讨论接口，所以这一栏是把每门课的讨论汇总起来：
// 读到的缓存住、再进不重复请求、换了账号/快照会重读、失败只提示不挡路。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const settle = () => new Promise((resolve) => setImmediate(resolve));

const COURSES = [
  { id: '21', name: 'Biology HL', grade: '6' },
  { id: '22', name: 'Chinese A', grade: '5' },
];

function harness({ failFor = [], discussionError = '' } = {}) {
  const { window } = parseHTML('<html><body><section id="schoolPage" class="page active"></section></body></html>');
  const document = window.document;
  window.HTMLElement.prototype.showModal = function () { this.open = true; };
  window.HTMLElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  const snapshot = {
    edupage: null,
    managebac: { fetchedAt: '2026-09-19T05:20:00.000Z', courses: COURSES, tasks: [], warnings: [] },
    preferences: {},
    accounts: { managebac: { saved: true } },
    status: {},
  };
  const calls = { discussions: [], discussion: [] };
  const api = {
    get: async () => snapshot,
    sync: async () => snapshot,
    preferences: async () => snapshot,
    discussions: async (courseId) => {
      calls.discussions.push(courseId);
      if (failFor.includes(courseId)) throw new Error('读取失败');
      const items = courseId === '21'
        ? [{ id: '301', title: 'Unit 2 questions', author: 'Ms Teacher', category: 'Biology HL', preview: 'Ask here' }]
        : [{ id: '401', title: 'Poetry thread', author: 'Mr Poet', category: 'Chinese A', preview: 'Share a poem' }];
      return { courseId, discussions: items, url: `https://shph.managebac.cn/student/classes/${courseId}/discussions`, fetchedAt: '2026-09-19T05:20:00.000Z' };
    },
    discussion: async (courseId, id) => {
      calls.discussion.push({ courseId, id });
      if (discussionError) throw new Error(discussionError);
      return { courseId, discussionId: id, title: 'Unit 2 questions', main: { author: 'Ms Teacher', date: 'Sep 18, 10:00 AM', body: '正文', attachments: [] }, comments: [], url: 'https://shph.managebac.cn/student/classes/21/discussions/301', fetchedAt: '2026-09-19T05:20:00.000Z' };
    },
  };
  const context = { window: { ph: { school: api, system: { openUrl: async () => {} } }, openSite: async () => {} }, document, Intl, Date, URL, setInterval: () => 0, console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/school-ui.js'), 'utf8'), context);
  const click = (selector) => {
    const node = document.querySelector(selector);
    assert.ok(node, `missing ${selector}`);
    node.dispatchEvent(new window.Event('click', { bubbles: true }));
  };
  return { context, window, document, calls, click };
}

test('讨论栏把每门课程的讨论汇总到一起，一门课只读一次', async () => {
  const ui = harness();
  await ui.context.window.schoolUI.open('courses'); await settle();
  assert.ok(ui.document.querySelector('[data-course-tab="discussions"]'), '要有「讨论」这一栏');
  ui.click('[data-course-tab="discussions"]');
  await settle(); await settle(); await settle();
  assert.deepEqual(ui.calls.discussions.sort(), ['21', '22'], '按课程读讨论');
  const rows = ui.document.querySelectorAll('.school-discussion-list .school-discussion-row');
  assert.equal(rows.length, 2);
  const text = ui.document.querySelector('#schoolPage').textContent;
  assert.match(text, /Unit 2 questions/);
  assert.match(text, /Poetry thread/);
  assert.match(text, /Biology HL/, '每一行要标出是哪门课');
  assert.match(text, /Chinese A/);
  // 再切走再切回来：不重复请求
  ui.click('[data-course-tab="courses"]'); await settle();
  ui.click('[data-course-tab="discussions"]'); await settle();
  assert.equal(ui.calls.discussions.length, 2, '缓存住了，再进不重复读');
});

test('讨论栏搜索框按标题/课程/作者过滤', async () => {
  const ui = harness();
  await ui.context.window.schoolUI.open('courses'); await settle();
  ui.click('[data-course-tab="discussions"]');
  await settle(); await settle(); await settle();
  const input = ui.document.querySelector('[data-school-field="query"]');
  assert.ok(input, '讨论栏要有搜索框');
  input.value = 'poet';
  input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  await settle();
  const rows = [...ui.document.querySelectorAll('.school-discussion-list .school-discussion-row')];
  assert.equal(rows.length, 1, '按作者也能搜到');
  assert.match(rows[0].textContent, /Poetry thread/);
});

test('点一条讨论打开详情对话框；读不到也不挡路', async () => {
  const ui = harness();
  await ui.context.window.schoolUI.open('courses'); await settle();
  ui.click('[data-course-tab="discussions"]');
  await settle(); await settle(); await settle();
  ui.click('.school-discussion-list .school-discussion-row');
  await settle(); await settle();
  assert.deepEqual(ui.calls.discussion, [{ courseId: '21', id: '301' }]);
  const dialog = ui.document.querySelector('dialog');
  assert.ok(dialog, '要弹出讨论详情');
  assert.match(dialog.textContent, /正文/);
});

test('个别课程读不到时只提示一门课失败，其它照常显示', async () => {
  const ui = harness({ failFor: ['22'] });
  await ui.context.window.schoolUI.open('courses'); await settle();
  ui.click('[data-course-tab="discussions"]');
  await settle(); await settle(); await settle();
  const page = ui.document.querySelector('#schoolPage').textContent;
  assert.match(page, /Unit 2 questions/, '读到的课照常显示');
  assert.match(page, /Chinese A/, '没读到的那门课在提示里点名');
  assert.match(page, /下次打开会重试/);
});

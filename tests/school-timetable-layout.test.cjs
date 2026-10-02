"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'school-ui.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'school.css'), 'utf8');
const inference = require('../src/school-selection-inference.js');
const settle = () => new Promise((resolve) => setImmediate(resolve));

function monday() {
  const value = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}

function harness() {
  const weekStart = monday();
  const saturday = new Date(`${weekStart}T12:00:00Z`); saturday.setUTCDate(saturday.getUTCDate() + 5);
  const lesson = (id, date, course) => ({ id, date, start: '08:45', end: '09:25', course, room: 'Jinding A-308', teacher: 'Ms Geography', groups: ['g1'], groupKey: 'g1', cancelled: false });
  const snapshot = {
    edupage: { weekStart, fetchedAt: new Date().toISOString(), lessons: [lesson('weekday', weekStart, 'Geography1'), lesson('weekend', saturday.toISOString().slice(0, 10), 'Weekend Lab')], options: [], missingDates: [] },
    managebac: null, preferences: { groups: ['g1'] }, status: {},
  };
  const { window } = parseHTML('<html><body><section id="schoolPage" class="page active"></section></body></html>');
  window.HTMLElement.prototype.showModal = function () { this.open = true; };
  window.HTMLElement.prototype.close = function () { this.open = false; };
  const exported = [];
  const api = { get: async () => snapshot, sync: async () => snapshot, preferences: async () => snapshot,
    exportTimetable: async (input) => { exported.push(input); return { ok: true }; } };
  const context = { window: { ph: { school: api, system: { openUrl: async () => {} } }, schoolSelectionInference: inference, openSite: async () => {} }, document: window.document, Intl, Date, URL, setInterval: () => 0, console };
  vm.runInNewContext(source, context);
  const click = (selector) => {
    const node = window.document.querySelector(selector);
    assert.ok(node, `missing ${selector}`);
    node.dispatchEvent(new window.Event('click', { bubbles: true }));
  };
  return { window, context, document: window.document, exported, click };
}

test('timetable defaults to five weekdays and restores intact weekend data on request', async () => {
  const ui = harness();
  ui.context.window.schoolUI.open('timetable'); await settle();
  assert.equal(ui.document.querySelectorAll('.school-tt-head').length, 6, '左上角 + 五天');
  assert.equal(ui.document.querySelectorAll('.school-tt-cell').length % 5, 0, '每天一列');
  assert.doesNotMatch(ui.document.querySelector('#schoolPage').textContent, /Weekend Lab/);
  const toggle = ui.document.querySelector('[data-school-action="toggle-weekend"]');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  toggle.dispatchEvent(new ui.window.Event('click', { bubbles: true }));
  assert.equal(ui.document.querySelectorAll('.school-tt-head').length, 8, '左上角 + 七天');
  assert.match(ui.document.querySelector('#schoolPage').textContent, /Weekend Lab/);
  assert.equal(ui.document.querySelector('[data-school-action="toggle-weekend"]').getAttribute('aria-pressed'), 'true');
});

// 2026-09-19 用户要求：「课表界面的大小布局等参考 phl lite」——
// 版式改成 Lite 那样：行 = 节次、列 = 星期，一节课一张小卡片（标题 + 教室·老师）。
test('课表按节次对齐：一节课一张小卡，卡片里有课程、教室和老师，详情在 title/aria 里', async () => {
  const ui = harness();
  ui.context.window.schoolUI.open('timetable'); await settle();
  const card = ui.document.querySelector('[data-id="weekday"]');
  assert.ok(card, '有课卡');
  assert.match(card.textContent, /Geography1/);
  assert.equal(card.querySelector('.school-lesson-room').textContent, 'Jinding A-308');
  assert.equal(card.querySelector('.school-lesson-teacher').textContent, 'Ms Geography');
  assert.match(card.getAttribute('aria-label'), /Geography1.*Jinding A-308.*Ms Geography.*完整详情/);
  // 卡片落在 08:45（P2）那一行：第 1 行是星期表头，所以 P2 = 第 3 行
  const cell = card.closest('.school-tt-cell');
  assert.equal(cell.style.gridRow, '3', '08:45 归到 P2 行');
  assert.match(ui.document.querySelector('.school-tt-time b').textContent, /P1/);
  assert.match(css, /\.school-timetable\s*\{[^}]*grid-template-columns:62px repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(css, /\.school-timetable\.school-days-7\s*\{[^}]*repeat\(7,minmax\(0,1fr\)\)/);
  assert.match(css, /\.school-lesson b\s*\{[^}]*font-size:\.72rem/, '课卡字号要小（Lite 是 11.5px 那一档）');
  // 用户要求「可以高一点点，到现在的 150% 左右」：行高在自然高度上 ×1.5。
  assert.match(source, /ROW_HEIGHT_SCALE = 1\.5/);
});

// 2026-09-19 用户要求：「加上和网页端一样的导出课表功能」——
// 方向与页面相反：**行 = 星期（周一…周日）+ 日期，列 = 节次**；CSV 带 BOM。
test('导出课表 CSV：行 = 星期、列 = 节次、UTF-8 带 BOM，且用的是当前这一周的数据', async () => {
  const ui = harness();
  ui.context.window.schoolUI.open('timetable'); await settle();
  ui.click('[data-school-action="export-menu"]');
  assert.ok(ui.document.querySelector('#schoolExportMenu'), '点开是站内小下拉');
  assert.equal(ui.document.querySelector('[data-school-action="export-menu"]').getAttribute('aria-expanded'), 'true');
  ui.click('[data-school-action="export-csv"]');
  await settle(); await settle();
  assert.equal(ui.exported.length, 1, '真的走了导出通道');
  const payload = ui.exported[0];
  assert.equal(payload.format, 'csv');
  assert.match(payload.name, /^课表-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.ok(payload.text.startsWith('\ufeff'), 'CSV 必须带 BOM（不然 Excel 中文乱码）');
  const lines = payload.text.replace(/^\ufeff/, '').trim().split('\r\n');
  assert.match(lines[0], /^星期,日期,P1 08:00-08:40,P2 08:45-09:25/, '第一行是表头：星期 / 日期 / 各节次');
  assert.equal(lines.length, 8, '表头 + 七天');
  assert.match(lines[1], /^周一,\d{4}-\d{2}-\d{2},/, '每一行 = 一天');
  assert.match(payload.text, /Geography1 · Jinding A-308 · Ms Geography/, '格子里的课要带上教室和老师');
  assert.match(payload.text, /Weekend Lab/, '周六的课也在（和网页端一样导出整周）');
  assert.ok(ui.document.querySelector('#schoolExportMenu').hasAttribute('hidden'), '导出后菜单收起');
});

// 「我的课表」曾经报 Cannot read properties of undefined (reading 'join')：
// 退回共用快照兜底时课里没有 `groups`（共用那份用单数 `group`）。
test('课里缺 groups 时不再炸（补齐成数组），界面照常显示', async () => {
  const ui = harness();
  await ui.context.window.schoolUI.open('timetable');
  await settle();
  const snapshot = ui.context.window.schoolUI.snapshot();
  const broken = { ...snapshot.edupage };
  broken.lessons = [{ id: 'shared:1', date: broken.weekStart, start: '08:45', end: '09:25', course: 'Physics', room: 'A208', teacher: 'Jing Zhang', group: 'G1', groupKey: 'g1', cancelled: false }];
  ui.context.window.ph.school.get = async () => ({ ...snapshot, edupage: broken });
  await ui.context.window.schoolUI.refresh();
  await settle(); await settle();
  assert.equal(ui.document.querySelectorAll('#schoolPage [role="alert"]').length, 0, '不该出现报错');
  const card = ui.document.querySelector('[data-id="shared:1"]');
  assert.ok(card, '课还在');
  assert.match(card.textContent, /Physics/);
  assert.match(card.getAttribute('aria-label'), /G1/, '缺的 groups 用单数 group 补上');
});

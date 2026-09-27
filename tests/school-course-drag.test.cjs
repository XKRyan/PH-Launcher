"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness(snapshot) {
  const { window } = parseHTML('<html><body><section id="schoolPage" class="page active"></section></body></html>');
  const document = window.document;
  window.HTMLElement.prototype.showModal = function () { this.open = true; };
  window.HTMLElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  let current = snapshot;
  const calls = { preferences: [] };
  const api = {
    get: async () => current,
    sync: async () => current,
    login: async () => ({ ok: true, snapshot: current }),
    preferences: async (change) => {
      calls.preferences.push(change);
      current = { ...current, preferences: { ...current.preferences, ...change } };
      return current;
    },
  };
  const context = { window: { ph: { school: api, system: { openUrl: async () => {} } }, openSite: async () => {} }, document, Intl, Date, URL, setInterval: () => 0, console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/course-order.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/school-ui.js'), 'utf8'), context);
  return { context, window, document, calls };
}

const snapshotWith = (preferences) => ({
  edupage: null,
  managebac: {
    fetchedAt: new Date().toISOString(),
    courses: [
      { id: 'c1', name: 'Biology', grade: '6' },
      { id: 'c2', name: 'Economics', grade: '5' },
      { id: 'c3', name: 'English', grade: '7' },
    ],
    tasks: [],
  },
  preferences,
  status: {},
});

function cardOrder(document) {
  return [...document.querySelectorAll('[data-school-drag]')].map((node) => node.dataset.id);
}

function drag(window, document, { from, to, below }) {
  const source = document.querySelector(`[data-school-drag][data-id="${from}"]`);
  const target = document.querySelector(`[data-school-drag][data-id="${to}"]`);
  assert.ok(source && target, 'drag endpoints must exist');
  const transfer = { effectAllowed: '', dropEffect: '', setData() {}, getData: () => from };
  target.getBoundingClientRect = () => ({ top: 100, height: 40, bottom: 140, left: 0, right: 300 });
  const fire = (node, type, extra = {}) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { dataTransfer: transfer, clientY: below ? 135 : 105, ...extra });
    node.dispatchEvent(event);
  };
  fire(source, 'dragstart');
  fire(target, 'dragover');
  const marked = target.classList.contains('is-drop-before') || target.classList.contains('is-drop-after');
  fire(target, 'drop');
  fire(source, 'dragend');
  return marked;
}

test('course cards render as draggable rows in the saved manual order', async () => {
  const ui = harness(snapshotWith({ courseOrder: ['c3', 'c1'] }));
  ui.context.window.schoolUI.open('courses');
  await settle();
  assert.equal(ui.document.querySelectorAll('[data-school-drag]').length, 3, 'every course is draggable');
  assert.equal(JSON.stringify(cardOrder(ui.document)), JSON.stringify(['c3', 'c1', 'c2']), 'saved order first, new courses appended');
  assert.equal(ui.document.querySelector('[data-school-drag]').getAttribute('draggable'), 'true');
  assert.match(ui.document.querySelector('#schoolPage').textContent, /拖动课程卡片可调整顺序/);
  assert.equal(ui.document.querySelector('[data-school-field="course-sort"]').value, 'manual');
});

test('dragging a course above another persists the new order', async () => {
  const ui = harness(snapshotWith({ courseOrder: ['c1', 'c2', 'c3'] }));
  ui.context.window.schoolUI.open('courses');
  await settle();
  const marked = drag(ui.window, ui.document, { from: 'c3', to: 'c1', below: false });
  assert.equal(marked, true, 'the drop target shows an insertion marker');
  await settle();
  assert.equal(ui.calls.preferences.length, 1);
  assert.equal(JSON.stringify(ui.calls.preferences[0].courseOrder), JSON.stringify(['c3', 'c1', 'c2']));
  assert.equal(JSON.stringify(cardOrder(ui.document)), JSON.stringify(['c3', 'c1', 'c2']), 'DOM order updates immediately');
});

test('dropping a course below another inserts it after the target', async () => {
  const ui = harness(snapshotWith({ courseOrder: ['c1', 'c2', 'c3'] }));
  ui.context.window.schoolUI.open('courses');
  await settle();
  drag(ui.window, ui.document, { from: 'c1', to: 'c3', below: true });
  await settle();
  assert.equal(JSON.stringify(ui.calls.preferences.at(-1).courseOrder), JSON.stringify(['c2', 'c3', 'c1']));
});

test('dropping a course on itself changes nothing', async () => {
  const ui = harness(snapshotWith({ courseOrder: ['c1', 'c2', 'c3'] }));
  ui.context.window.schoolUI.open('courses');
  await settle();
  drag(ui.window, ui.document, { from: 'c2', to: 'c2', below: true });
  await settle();
  assert.equal(ui.calls.preferences.length, 0, 'no write for a no-op drop');
  assert.equal(JSON.stringify(cardOrder(ui.document)), JSON.stringify(['c1', 'c2', 'c3']));
});

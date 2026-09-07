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
  const api = { get: async () => snapshot, sync: async () => snapshot, preferences: async () => snapshot };
  const context = { window: { ph: { school: api, system: { openUrl: async () => {} } }, schoolSelectionInference: inference, openSite: async () => {} }, document: window.document, Intl, Date, URL, setInterval: () => 0, console };
  vm.runInNewContext(source, context);
  return { window, context, document: window.document };
}

test('timetable defaults to five weekdays and restores intact weekend data on request', async () => {
  const ui = harness();
  ui.context.window.schoolUI.open('timetable'); await settle();
  assert.equal(ui.document.querySelectorAll('.school-grid-header > div').length, 5);
  assert.equal(ui.document.querySelectorAll('.school-day-column').length, 5);
  assert.doesNotMatch(ui.document.querySelector('#schoolPage').textContent, /Weekend Lab/);
  const toggle = ui.document.querySelector('[data-school-action="toggle-weekend"]');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  toggle.dispatchEvent(new ui.window.Event('click', { bubbles: true }));
  assert.equal(ui.document.querySelectorAll('.school-grid-header > div').length, 7);
  assert.equal(ui.document.querySelectorAll('.school-day-column').length, 7);
  assert.match(ui.document.querySelector('#schoolPage').textContent, /Weekend Lab/);
  assert.equal(ui.document.querySelector('[data-school-action="toggle-weekend"]').getAttribute('aria-pressed'), 'true');
});

test('a 40-minute card gives course, room and teacher enough vertical space plus full accessible detail', async () => {
  const ui = harness();
  ui.context.window.schoolUI.open('timetable'); await settle();
  const card = ui.document.querySelector('[data-id="weekday"]');
  assert.match(card.getAttribute('style'), /height:186px/);
  assert.equal(card.querySelector('.school-lesson-room').textContent, 'Jinding A-308');
  assert.equal(card.querySelector('.school-lesson-teacher').textContent, 'Ms Geography');
  assert.match(card.getAttribute('aria-label'), /Geography1.*Jinding A-308.*Ms Geography.*完整详情/);
  assert.match(css, /font-size:clamp\(14px,1rem,17px\)/, 'lesson text must stay bounded at 16–24px global font settings');
  assert.match(css, /repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(css, /repeat\(7,minmax\(0,1fr\)\)/);
});

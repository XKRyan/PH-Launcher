'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const appSource = fs.readFileSync(require.resolve('../src/app.js'), 'utf8');
const focusSource = appSource.slice(
  appSource.indexOf('function ensureTimer()'),
  appSource.indexOf('\nasync function loadHardwareProfile'),
);

function harness() {
  let now = new Date('2026-09-06T08:00:00.000Z').getTime();
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const { window } = parseHTML(`<html><body>
    <span id="miniFocusTime"></span><span id="focusTime"></span><i id="miniFocusProgress"></i><div id="focusRing"></div>
    <b id="miniFocusPhase"></b><span id="focusModeLabel"></span><span id="focusPhaseLabel"></span>
    <button id="miniFocusPlay"></button><button id="focusPlay"><span id="focusPlayIcon"></span><b id="focusPlayLabel"></b></button>
    <button id="focusReset"><b id="focusResetLabel"></b></button><span id="focusTargetLabel"></span>
    <button id="miniFocusTarget"></button><button id="focusOpenTarget"></button>
    <div id="focusPresets"><button data-focus="25" data-break="5"></button><button data-focus="45" data-break="10"></button></div>
    <dialog id="focusSettingsDialog"></dialog><form id="focusSettingsForm"></form>
    <input id="focusMinutesInput"><input id="focusGoalInput"><select id="focusTargetInput"></select><p id="focusSettingsHint"></p>
    <span id="focusStatMinutes"></span><span id="focusStatSessions"></span><span id="focusStatDays"></span><div id="focusHistory"></div>
  </body></html>`);
  window.document.querySelector('#focusSettingsDialog').showModal = () => {};
  window.document.querySelector('#focusSettingsDialog').close = () => {};
  Object.defineProperty(window.document.querySelector('#focusTargetInput'), 'value', { value: '', writable: true });
  const calls = { routes: [], sites: [], toasts: [], persisted: 0, notifications: [] };
  const state = {
    data: { settings: {}, focusSessions: [], customSites: [{ id: 'kognity', name: 'Kognity' }] },
    timerFinishing: false,
  };
  const context = {
    window: { ph: { system: { notify: async (message) => { calls.notifications.push(message); } } } },
    document: window.document,
    state,
    Date: FakeDate,
    setTimeout: (callback) => { callback(); return 0; },
    $: (selector) => window.document.querySelector(selector),
    $$: (selector) => [...window.document.querySelectorAll(selector)],
    customSites: () => state.data.customSites,
    escapeHtml: (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])),
    icon: (id) => `<svg><use href="#${id}"/></svg>`,
    uid: () => `session-${state.data.focusSessions.length + 1}`,
    persistData: async () => { calls.persisted += 1; },
    toast: (message, type) => { calls.toasts.push({ message, type }); },
    navigate: (route) => { calls.routes.push(route); },
    openSite: (site) => { calls.sites.push(site); },
    renderDashboard: () => {},
  };
  vm.runInNewContext(`${focusSource}\nrenderFocusStats = () => {}; this.focus = { ensureTimer, timerDisplayMs, updateTimerUi, toggleTimer, resetTimer, renderFocusSettings, saveFocusSettings, finishTimerPhase, openFocusTarget, focusTargetInfo };`, context);
  return { window, state, calls, focus: context.focus, advance(ms) { now += ms; } };
}

test('real clock pause/resume preserves remaining time and a running settings edit applies next round', async () => {
  const ui = harness();
  const timer = ui.focus.ensureTimer();
  const oldSessions = ui.state.data.focusSessions;
  ui.focus.toggleTimer();
  ui.advance(5 * 60_000);
  ui.focus.toggleTimer();
  assert.equal(timer.remainingMs, 20 * 60_000);
  assert.equal(timer.sessionStarted, true);

  ui.focus.renderFocusSettings();
  ui.window.document.querySelector('#focusMinutesInput').value = '45';
  ui.window.document.querySelector('#focusGoalInput').value = '完成 Math 练习 1–5 题';
  ui.window.document.querySelector('#focusTargetInput').value = 'route:vocabulary';
  ui.focus.saveFocusSettings({ preventDefault() {} });
  assert.equal(timer.remainingMs, 20 * 60_000, 'editing must not replace the paused current round');
  assert.equal(timer.durationMs, 25 * 60_000);
  assert.equal(timer.nextFocusMinutes, 45);
  assert.equal(timer.target, 'route:vocabulary');
  assert.equal(timer.goal, '完成 Math 练习 1–5 题');
  assert.equal(ui.state.data.focusSessions, oldSessions, 'settings must not replace historical statistics');

  ui.focus.toggleTimer();
  ui.advance(20 * 60_000);
  assert.equal(ui.focus.timerDisplayMs(timer), 0);
  await ui.focus.finishTimerPhase();
  assert.equal(ui.state.data.focusSessions.length, 1);
  assert.equal(ui.state.data.focusSessions[0].minutes, 25);
  assert.equal(ui.state.data.focusSessions[0].completed, true);
  assert.equal(ui.state.data.focusSessions[0].target, 'route:vocabulary');
  assert.equal(ui.state.data.focusSessions[0].goal, '完成 Math 练习 1–5 题');
});

test('ending an active round resets it without creating a completed or canceled session', () => {
  const ui = harness();
  const timer = ui.focus.ensureTimer();
  ui.focus.toggleTimer();
  ui.advance(3 * 60_000);
  ui.focus.resetTimer();
  assert.equal(ui.state.data.focusSessions.length, 0);
  assert.equal(timer.running, false);
  assert.equal(timer.sessionStarted, false);
  assert.equal(timer.remainingMs, 25 * 60_000);
  assert.match(ui.calls.toasts.at(-1).message, /未计入完成记录/);
});

test('targets are exact launcher routes or existing custom sites, never arbitrary programs or URLs', () => {
  const ui = harness();
  const timer = ui.focus.ensureTimer();
  timer.target = 'route:notes';
  ui.focus.openFocusTarget();
  timer.target = 'site:kognity';
  ui.focus.openFocusTarget();
  timer.target = 'site:https://evil.test';
  ui.focus.openFocusTarget();
  timer.target = 'exe:C:\\Windows\\notepad.exe';
  ui.focus.openFocusTarget();
  assert.deepEqual(ui.calls.routes, ['notes']);
  assert.deepEqual(ui.calls.sites, ['kognity']);
  assert.equal(ui.focus.focusTargetInfo('route:settings'), null);
});

test('custom duration is integer-only from 1 through 180 minutes', () => {
  const ui = harness();
  const timer = ui.focus.ensureTimer();
  ui.focus.renderFocusSettings();
  ui.window.document.querySelector('#focusMinutesInput').value = '181';
  ui.focus.saveFocusSettings({ preventDefault() {} });
  assert.equal(timer.focusMinutes, 25);
  assert.equal(ui.calls.toasts.at(-1).type, 'error');
  ui.window.document.querySelector('#focusMinutesInput').value = '1';
  ui.focus.saveFocusSettings({ preventDefault() {} });
  assert.equal(timer.focusMinutes, 1);
  assert.equal(timer.remainingMs, 60_000);
});

test('pause state keeps a visible SVG and the dedicated stylesheet restores its stroke', () => {
  const ui = harness();
  ui.focus.ensureTimer();
  ui.focus.toggleTimer();
  assert.equal(ui.window.document.querySelector('#focusPlay').classList.contains('timer-pause-icon'), true);
  assert.match(ui.window.document.querySelector('#focusPlayIcon').innerHTML, /#i-pause/);
  const css = fs.readFileSync(require.resolve('../src/focus.css'), 'utf8');
  assert.match(css, /\.timer-pause-icon[\s\S]*stroke:\s*currentColor\s*!important/);
});

test('focus controls are wired to real click and submit events', () => {
  assert.match(appSource, /\$\('#focusPlay'\)\.addEventListener\('click', toggleTimer\)/);
  assert.match(appSource, /\$\('#focusReset'\)\.addEventListener\('click', resetTimer\)/);
  assert.match(appSource, /\$\('#focusSettingsForm'\)\.addEventListener\('submit', saveFocusSettings\)/);
});

'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createReminderWindowManager } = require('../electron/reminder-window.cjs');

test('reminder UI offers complete, snooze, and cancel-this-occurrence in both languages', () => {
  const html = fs.readFileSync(require.resolve('../src/reminder.html'), 'utf8');
  const { window } = parseHTML(html);
  const calls = []; let show;
  window.reminder = { onShow: callback => { show = callback; }, onError: () => {}, complete: () => calls.push('complete'), snooze: () => calls.push('snooze'), cancelOccurrence: () => calls.push('cancel'), close: () => calls.push('close') };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/reminder.js'), 'utf8'), { window, document: window.document, Date });
  show({ title: 'Club', body: 'Bring notes', dueAt: Date.now(), appearance: { lang: 'en' } });
  assert.equal(window.document.querySelector('#complete').textContent, 'Complete this event');
  assert.equal(window.document.querySelector('#snooze').textContent, 'Snooze 5 min');
  assert.equal(window.document.querySelector('#cancelOccurrence').textContent, 'Cancel this event');
  for (const id of ['complete', 'snooze', 'cancelOccurrence']) window.document.querySelector(`#${id}`).click();
  assert.deepEqual(calls, ['complete', 'snooze', 'cancel']);
  show({ appearance: { lang: 'zh-CN' } });
  assert.deepEqual(['complete', 'snooze', 'cancelOccurrence'].map(id => window.document.querySelector(`#${id}`).textContent), ['完成本次', '稍后 5 分钟', '取消本次']);
});

test('reminder preload exposes only explicit action messages', () => {
  let api; const sent = [];
  vm.runInNewContext(fs.readFileSync(require.resolve('../electron/reminder-preload.cjs'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, ipcRenderer: { on() {}, send: channel => sent.push(channel) } }; },
    Object,
  });
  api.complete(); api.snooze(); api.cancelOccurrence(); api.close();
  assert.deepEqual(sent, ['reminder:complete', 'reminder:snooze', 'reminder:cancel-occurrence', 'reminder:close']);
});

function fakeElectron() {
  const windows = []; const handlers = new Map();
  class BrowserWindow {
    constructor() { this.destroyed = false; this.listeners = new Map(); this.onceListeners = new Map(); this.webContents = { mainFrame: {}, sends: [], getURL: () => pathToFileURL(path.join(__dirname, '..', 'src', 'reminder.html')).href, on() {}, setWindowOpenHandler() {}, send: (...args) => this.webContents.sends.push(args) }; windows.push(this); }
    setMenuBarVisibility() {} once(name, fn) { this.onceListeners.set(name, fn); } on(name, fn) { this.listeners.set(name, fn); }
    loadFile() { return Promise.resolve(); } isDestroyed() { return this.destroyed; } show() {} focus() {}
    close() { if (this.destroyed) return; this.destroyed = true; this.listeners.get('closed')?.(); } destroy() { this.close(); }
  }
  const ipcMain = { on: (name, fn) => handlers.set(name, fn), removeListener: (name, fn) => { if (handlers.get(name) === fn) handlers.delete(name); } };
  return { BrowserWindow, ipcMain, windows, emit(name, target) { handlers.get(name)({ sender: target.webContents, senderFrame: target.webContents.mainFrame }); } };
}

test('reminder actions tolerate reentrant removal and keep the window actionable after persistence failure', () => {
  const reentrant = fakeElectron(); let manager;
  manager = createReminderWindowManager({ ...reentrant, path, onComplete: item => manager.remove(item.id) });
  manager.enqueue({ id: 'one', title: 'One' });
  assert.doesNotThrow(() => reentrant.emit('reminder:complete', reentrant.windows[0]));
  assert.equal(reentrant.windows[0].isDestroyed(), true);
  manager.dispose();

  const failing = fakeElectron(); let attempts = 0;
  const retryable = createReminderWindowManager({ ...failing, path, onCancelOccurrence: () => { if (++attempts === 1) throw new Error('disk full'); } });
  retryable.enqueue({ id: 'two', title: 'Two' });
  failing.emit('reminder:cancel-occurrence', failing.windows[0]);
  assert.equal(failing.windows[0].isDestroyed(), false);
  assert.deepEqual(failing.windows[0].webContents.sends.at(-1), ['reminder:error', 'disk full']);
  failing.emit('reminder:cancel-occurrence', failing.windows[0]);
  assert.equal(failing.windows[0].isDestroyed(), true);
  retryable.dispose();
});

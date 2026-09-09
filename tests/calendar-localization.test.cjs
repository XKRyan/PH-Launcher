'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');

if (process.versions.electron && process.argv.includes('--calendar-localization-child')) {
  runFixture();
} else {
  test('calendar localizes dates and ARIA while language switches preserve open drafts', { skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY, timeout: 30000 }, async () => {
    const path = require('node:path');
    const { spawn } = require('node:child_process');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(require('electron'), [__filename, '--calendar-localization-child'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Calendar localization fixture timed out')); }, 25000);
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    assert.equal(result.code, 0, result.stderr.slice(-1200));
    assert.match(result.stdout, /PH_CALENDAR_LOCALIZATION_OK/);
  });
}

function runFixture() {
  const fs = require('node:fs');
  const path = require('node:path');
  const { app, BrowserWindow } = require('electron');
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    const browser = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
    const web = browser.webContents;
    await web.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><body><main id="calendarPage"></main></body></html>'));
    await web.executeJavaScript(`
      window.fixtureLanguage = 'zh-CN';
      window.i18n = { locale: () => window.fixtureLanguage, t: value => value };
      window.ph = { calendar: { get: async () => [], save: async () => [], remove: async () => [], chooseFiles: async () => [{ path: 'C:\\\\School\\\\Alex Zhang\\\\draft.pdf', name: 'draft.pdf' }], openFile: async () => true } };
      HTMLDialogElement.prototype.showModal = function () { this.open = true; };
      HTMLDialogElement.prototype.close = function () { this.open = false; };
      window.switchFixtureLanguage = language => { window.fixtureLanguage = language; window.dispatchEvent(new CustomEvent('ph:language-changed', { detail: { language } })); };
      void 0;
    `);
    await web.executeJavaScript(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'calendar-ui.js'), 'utf8'));
    await web.executeJavaScript('window.calendarUI.mount()');

    assert.equal(await web.executeJavaScript(`document.querySelector('.cal-week-heading span').textContent`), '周一');
    await web.executeJavaScript(`document.querySelector('[data-cal-view="month"]').click()`);
    assert.equal(await web.executeJavaScript(`document.querySelector('.cal-weekday').textContent`), '周一');
    await web.executeJavaScript(`document.querySelector('[data-cal-view="week"]').click()`);

    await web.executeJavaScript(`document.querySelector('.cal-week-heading').click()`);
    await web.executeJavaScript(`(() => { const form = document.querySelector('[data-cal-form]'); form.elements.title.value = 'Alex 的未保存安排'; form.elements.date.value = '2026-10-12'; form.elements.allDay.checked = false; form.elements.allDay.dispatchEvent(new Event('change', { bubbles: true })); form.elements.start.value = '13:15'; form.elements.end.value = '14:45'; form.querySelector('[name="repeatWeekdays"][value="1"]').checked = true; form.querySelector('[name="repeatWeekdays"][value="5"]').checked = true; form.elements.reminderMinutes.value = '15'; form.elements.notes.value = 'Bring draft.pdf'; form.elements.color.value = 'wine'; form.elements.notes.focus(); })()`);
    await web.executeJavaScript(`document.querySelector('[data-cal-attachment-select]').click()`);
    await new Promise(resolve => setTimeout(resolve, 20));
    await web.executeJavaScript(`window.switchFixtureLanguage('en')`);

    const english = await web.executeJavaScript(`(() => { const form = document.querySelector('[data-cal-form]'); return {
      weekday: document.querySelector('.cal-week-heading span').textContent,
      heading: document.querySelector('.cal-date-controls h3').textContent,
      dayAria: document.querySelector('.cal-week-heading').getAttribute('aria-label'),
      addAria: document.querySelector('.cal-add-in-day').getAttribute('aria-label'),
      title: form.elements.title.value, date: form.elements.date.value, allDay: form.elements.allDay.checked,
      start: form.elements.start.value, end: form.elements.end.value, reminder: form.elements.reminderMinutes.value,
      notes: form.elements.notes.value, color: form.elements.color.value, repeats: [...form.querySelectorAll('[name="repeatWeekdays"]:checked')].map(input => input.value), focused: document.activeElement.name,
      attachment: document.querySelector('[data-cal-attachment-open]')?.textContent, dialogText: document.querySelector('#calendarEventDialog').textContent
    }; })()`);
    assert.equal(english.weekday, 'Mon');
    assert.match(english.heading, /[A-Z][a-z]{2}/);
    assert.match(english.dayAria, /events, view or add an event$/);
    assert.match(english.addAria, /^Add an event on /);
    assert.deepEqual({ title: english.title, date: english.date, allDay: english.allDay, start: english.start, end: english.end, reminder: english.reminder, notes: english.notes, color: english.color, repeats: english.repeats, focused: english.focused }, { title: 'Alex 的未保存安排', date: '2026-10-12', allDay: false, start: '13:15', end: '14:45', reminder: '15', notes: 'Bring draft.pdf', color: 'wine', repeats: ['1', '5'], focused: 'notes' });
    assert.match(english.dialogText, /Edit event|Add event/);
    assert.equal(english.attachment, 'draft.pdf');

    await web.executeJavaScript(`window.switchFixtureLanguage('zh-CN')`);
    assert.equal(await web.executeJavaScript(`document.querySelector('.cal-week-heading span').textContent`), '周一');
    assert.equal(await web.executeJavaScript(`document.querySelector('[data-cal-form]').elements.title.value`), 'Alex 的未保存安排');
    browser.destroy();
    process.stdout.write('PH_CALENDAR_LOCALIZATION_OK\n');
    app.exit(0);
  }).catch(error => { process.stderr.write(`${error.stack}\n`); app.exit(1); });
}

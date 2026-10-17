const assert = require('node:assert/strict');
const test = require('node:test');
const { MAX_CALENDAR_EVENTS, isCalendarDate, isCalendarTime, normalizeCalendarEvent, normalizeCalendarEvents, upsertCalendarEvent, removeCalendarEvent } = require('../electron/calendar.cjs');

const event = { id: 'fixture-1', title: '完成 Biology IA', date: '2026-09-06', start: '15:00', end: '16:00', notes: '整理实验数据', color: 'green' };

if (process.versions.electron && process.argv.includes('--calendar-dom-child')) {
  runCalendarDomFixture();
} else {

test('calendar dates validate month lengths, leap years, bounds, and exact format without timezone conversion', () => {
  for (const value of ['2024-02-29', '2000-02-29', '2026-09-06', '1900-01-01', '2199-12-31']) assert.equal(isCalendarDate(value), true, value);
  for (const value of ['2026-02-29', '1900-02-29', '2100-02-29', '2026-04-31', '2026-00-01', '2026-13-01', '2026-09-00', '2026-9-6', '2026-09-06T00:00:00Z', '1899-12-31', '2200-01-01', null]) assert.equal(isCalendarDate(value), false, String(value));
});

test('calendar times are strict 24-hour values, with all-day represented by two empty fields', () => {
  for (const value of ['00:00', '09:05', '23:59']) assert.equal(isCalendarTime(value), true);
  for (const value of ['24:00', '25:00', '12:60', '9:05', '12:00:00', '']) assert.equal(isCalendarTime(value), false);
  assert.deepEqual(normalizeCalendarEvent({ ...event, start: '', end: '' }), { ...event, start: '', end: '', reminderMinutes: null });
  for (const times of [{ start: '15:00', end: '' }, { start: '', end: '16:00' }, { start: '16:00', end: '16:00' }, { start: '23:00', end: '01:00' }, { start: null, end: null }]) assert.throws(() => normalizeCalendarEvent({ ...event, ...times }));
});

test('calendar normalization creates IDs, trims titles, and whitelists fields', () => {
  const normalized = normalizeCalendarEvent({ title: '  阅读 English Paper 1  ', date: '2026-09-06', unexpected: 'ignore-me' }, { idFactory: () => 'fixture-created' });
  assert.deepEqual(normalized, { id: 'fixture-created', title: '阅读 English Paper 1', date: '2026-09-06', start: '', end: '', notes: '', color: 'green', reminderMinutes: null });
  assert.equal(normalizeCalendarEvent({ ...event, notes: 'one\r\ntwo' }).notes, 'one\ntwo');
  assert.equal(normalizeCalendarEvent({ ...event, reminderMinutes: 15 }).reminderMinutes, 15);
  assert.throws(() => normalizeCalendarEvent({ ...event, reminderMinutes: 7 }));
  assert.throws(() => normalizeCalendarEvent({ ...event, start: '', end: '', reminderMinutes: 5 }));
});

test('calendar validation rejects malformed and overlong text, IDs, colors and dates', () => {
  for (const change of [{ title: '' }, { title: 'x'.repeat(121) }, { title: 'a\nb' }, { notes: 'x'.repeat(4001) }, { notes: 'a\u0000b' }, { id: '<script>' }, { color: 'url(javascript:)' }, { date: '2026-02-30' }]) assert.throws(() => normalizeCalendarEvent({ ...event, ...change }));
  assert.throws(() => normalizeCalendarEvent(null));
  assert.throws(() => normalizeCalendarEvent([]));
});

test('imported calendar entries are deduplicated, validated and deterministically sorted', () => {
  const allDay = { ...event, id: 'all-day', start: '', end: '' };
  const earlier = { ...event, id: 'earlier', date: '2026-09-05' };
  const result = normalizeCalendarEvents([event, null, { ...event, title: 'duplicate' }, { ...event, id: 'invalid', date: 'bad' }, { title: 'missing ID' }, allDay, earlier]);
  assert.deepEqual(result.map((item) => item.id), ['earlier', 'all-day', 'fixture-1']);
  assert.deepEqual(normalizeCalendarEvents({}), []);
});

test('calendar create, edit and delete return new arrays and preserve unrelated events', () => {
  const original = [event];
  const created = upsertCalendarEvent(original, { title: 'TOK exhibition', date: '2026-09-08', color: 'gold' });
  assert.equal(created.length, 2);
  assert.equal(original.length, 1);
  const edited = upsertCalendarEvent(created, { ...event, title: 'Biology IA 初稿' });
  assert.equal(edited.find((item) => item.id === event.id).title, 'Biology IA 初稿');
  assert.equal(original[0].title, event.title);
  const removed = removeCalendarEvent(edited, event.id);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].title, 'TOK exhibition');
  assert.equal(edited.length, 2);
});

test('stale edits and invalid deletes are rejected while a repeated delete is idempotent', () => {
  assert.throws(() => upsertCalendarEvent([], event));
  assert.throws(() => removeCalendarEvent([event], 'bad/id'));
  assert.deepEqual(removeCalendarEvent([event], 'missing'), [{ ...event, reminderMinutes: null }]);
});

test('calendar size is bounded while editing an existing entry at the cap remains possible', () => {
  const full = Array.from({ length: MAX_CALENDAR_EVENTS }, (_, index) => ({ ...event, id: `event-${index}` }));
  assert.throws(() => upsertCalendarEvent(full, { title: 'one too many', date: event.date }));
  assert.equal(upsertCalendarEvent(full, { ...full[0], title: 'edited' }).length, MAX_CALENDAR_EVENTS);
  assert.equal(normalizeCalendarEvents([...full, { ...event, id: 'overflow' }]).length, MAX_CALENDAR_EVENTS);
});

test('real calendar UI switches week/month/year and creates, edits, deletes safely', { skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY, timeout: 30000 }, async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawn } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-calendar-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(profile).startsWith('ph-calendar-test-'));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const env = { ...process.env, PH_CALENDAR_TEST_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [__filename, '--calendar-dom-child'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Calendar DOM fixture timed out')); }, 25000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  assert.equal(result.code, 0, result.stderr.slice(-1200));
  assert.ok(result.stdout.includes('PH_CALENDAR_DOM_OK'));
});
}

function runCalendarDomFixture() {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { app, BrowserWindow } = require('electron');
  const profile = process.env.PH_CALENDAR_TEST_PROFILE;
  assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(profile).startsWith('ph-calendar-test-'));
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  app.disableHardwareAcceleration();
  let stage = 'create-window';
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, width: 1250, height: 950, webPreferences: { nodeIntegration: false, sandbox: true, contextIsolation: true } });
    const web = window.webContents;
    const root = path.resolve(__dirname, '..');
    const css = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8') + fs.readFileSync(path.join(root, 'src', 'calendar.css'), 'utf8');
    await web.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><style>${css}</style></head><body><main id="calendarPage" style="padding:35px"></main></body></html>`)}`);
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const seed = { ...event, date: today, title: '<img src=x onerror="window.calendarXss=true">' };
    await web.executeJavaScript(`window.fixtureEvents = ${JSON.stringify([seed])}; window.confirmAction = async () => true; window.confirm = () => true; window.ph = {calendar: {
      get: async () => structuredClone(window.fixtureEvents),
      save: async (value) => { const entry = {...value, id: value.id || 'fixture-added'}; window.fixtureEvents = [...window.fixtureEvents.filter(item => item.id !== entry.id), entry]; return structuredClone(window.fixtureEvents); },
      remove: async (id) => { window.fixtureEvents = window.fixtureEvents.filter(item => item.id !== id); return structuredClone(window.fixtureEvents); }
    }}; void 0;`);
    await web.executeJavaScript(fs.readFileSync(path.join(root, 'src', 'calendar-ui.js'), 'utf8'));
    const run = (code) => web.executeJavaScript(code);
    const eventually = async (expression) => {
      for (let attempt = 0; attempt < 30; attempt++) {
        if (await run(expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      throw new Error(`Calendar fixture condition failed at ${stage}`);
    };
    stage = 'mount-and-escape';
    await run('window.calendarUI.mount()');
    assert.equal(await run(`document.querySelectorAll('.cal-week-day').length`), 7, 'default view should be week');
    assert.equal(await run(`document.querySelectorAll('#calendarPage img').length`), 0);
    assert.equal(await run(`Boolean(window.calendarXss)`), false);
    stage = 'switch-views';
    await run(`document.querySelector('[data-cal-view=month]').click()`);
    assert.equal(await run(`document.querySelectorAll('.cal-month-cell').length`), 42);
    await run(`document.querySelector('[data-cal-view=year]').click()`);
    assert.equal(await run(`document.querySelectorAll('.cal-mini-month').length`), 12);
    await run(`document.querySelector('[data-cal-month="${now.getMonth()}"]').click()`);
    assert.equal(await run(`document.querySelectorAll('.cal-month-cell').length`), 42);
    await run(`document.querySelector('[data-cal-view=week]').click()`);
    assert.equal(await run(`document.querySelectorAll('.cal-week-day').length`), 7);
    stage = 'create-timed-event';
    await run(`document.querySelector('[data-cal-view=month]').click()`);
    assert.equal(await run(`document.querySelectorAll('.cal-month-cell').length`), 42);
    await run(`document.querySelector('.cal-day-number[data-cal-day="${today}"]').click()`);
    assert.equal(await run(`document.getElementById('calendarEventDialog').open`), true);
    await run(`(() => { const form = document.querySelector('[data-cal-form]'); form.elements.title.value = 'Fixture calendar event'; form.elements.allDay.checked = false; form.elements.allDay.dispatchEvent(new Event('change', {bubbles:true})); form.elements.start.value = '13:00'; form.elements.end.value = '14:00'; form.requestSubmit(); })()`);
    await eventually(`window.fixtureEvents.length === 2 && !document.getElementById('calendarEventDialog').open`);
    assert.equal(await run(`window.fixtureEvents.find(item => item.id === 'fixture-added').start`), '13:00');
    stage = 'edit-event';
    await run(`document.querySelector('[data-cal-edit=fixture-added]').click(); document.querySelector('[data-cal-form]').elements.title.value = 'Edited fixture event'; document.querySelector('[data-cal-form]').requestSubmit()`);
    await eventually(`window.fixtureEvents.some(item => item.title === 'Edited fixture event') && !document.getElementById('calendarEventDialog').open`);
    stage = 'delete-event';
    await run(`document.querySelector('[data-cal-edit=fixture-added]').click(); document.querySelector('[data-cal-delete]').click()`);
    await eventually(`window.fixtureEvents.length === 1 && !document.getElementById('calendarEventDialog').open`);
    stage = 'mount-idempotency';
    await run('window.calendarUI.mount()');
    assert.equal(await run(`document.querySelectorAll('#calendarEventDialog').length`), 1);
    window.destroy();
    process.stdout.write('PH_CALENDAR_DOM_OK\n');
    app.exit(0);
  }).catch((error) => {
    process.stderr.write(`Calendar DOM fixture failed at ${stage}: ${error.message}\n${error.stack || ''}\n`);
    app.exit(1);
  });
}

'use strict';

// Real layout is essential here: DOM shims do not implement grid tracks,
// offsetParent, ResizeObserver or the cascade between duplicate CSS rules.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.join(__dirname, '..');
const childMode = Boolean(process.versions.electron) && process.argv.includes('--school-clock-child');

if (childMode) {
  const { app, BrowserWindow, session } = require('electron');
  const profile = process.env.PH_SCHOOL_CLOCK_PROFILE;
  assert.ok(profile);
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  app.disableHardwareAcceleration();
  const deadline = setTimeout(() => app.exit(2), 20000);
  app.whenReady().then(async () => {
    // Only synthetic content; fail closed on every attempted HTTP request.
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { backgroundThrottling: false } });
    const run = (code) => win.webContents.executeJavaScript(code);
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<html><head></head><body><section id="schoolPage" class="page active"></section></body></html>'));
    await win.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'src/school.css'), 'utf8'));
    // Deliberately use a host timezone other than the school timezone.
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setTimezoneOverride', { timezoneId: 'America/Los_Angeles' });
    await run(`
      window.clockDate = '2026-09-21T00:20:00Z';
      const RealDate = Date;
      window.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : [window.clockDate])); }
        static now() { return new RealDate(window.clockDate).valueOf(); }
      };
      window.setInterval = (callback, delay) => { if (delay === 30000) window.clockTick = callback; return 0; };
      const snapshot = {
        edupage: { weekStart: '2026-09-21', accountKey: 'synthetic', fetchedAt: clockDate, missingDates: [], lessons: [
          { id: 'synthetic-lesson', date: '2026-09-21', start: '08:00', end: '08:40', course: 'Synthetic course', groupKey: 'g1', groups: ['g1'], teacher: 'Fixture', room: 'Test', cancelled: false }
        ] }, preferences: { accountKey: 'synthetic', groups: ['g1'] }, status: {}, accounts: {}
      };
      window.ph = { school: { get: async () => snapshot } };
      void 0;
    `);
    await run(fs.readFileSync(path.join(root, 'src/school-ui.js'), 'utf8'));
    await run('schoolUI.open("timetable")');
    const settle = () => run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await settle();
    const geometry = () => run(`(() => {
      const grid = document.querySelector('#schoolTimetableGrid');
      const line = grid.querySelector('.school-now-line');
      const rect = node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
      return { grid: rect(grid), rows: [...grid.querySelectorAll('.school-tt-time')].map(rect),
        firstDay: rect(grid.querySelector('.school-tt-head:not(.school-tt-corner)')),
        line: line && rect(line), label: line?.getAttribute('aria-label'),
        style: line && { background: getComputedStyle(line).backgroundColor, border: getComputedStyle(line).borderTopWidth, dotTop: getComputedStyle(line, '::before').top, dotMargin: getComputedStyle(line, '::before').marginTop },
        localHour: new Date().getHours(), count: grid.querySelectorAll('.school-now-line').length };
    })()`);
    const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1.1, `${label}: got ${actual}, expected ${expected}`);
    const center = (value) => (value.line.top + value.line.bottom) / 2;
    const at = async (time) => { await run(`clockDate = ${JSON.stringify(time)}; clockTick()`); return geometry(); };
    let value = await geometry();
    process.stdout.write('PH_SCHOOL_CLOCK_INITIAL=' + JSON.stringify(value) + '\n');
    assert.equal(value.localHour, 17, 'host clock is Los Angeles on Sunday');
    assert.equal(value.label, '当前时间 08:20', 'date and clock use Shanghai Monday');
    close(center(value), (value.rows[0].top + value.rows[0].bottom) / 2, 'P1 midpoint');
    close(value.line.left, value.firstDay.left, 'line starts at actual weekday track');
    assert.equal(value.style.border, '0px', 'single line, no second border stripe');
    assert.equal(value.style.dotMargin, '0px', 'dot has no stale second-rule offset');

    // Make every row a different height and enlarge the gaps. This also tests
    // row reflow without a render or a clock tick.
    await run(`document.querySelector('#schoolTimetableGrid').style.gridTemplateRows = '30px 80px 60px 100px 50px 90px 35px 75px 65px 85px 55px 95px 40px'; document.querySelector('#schoolTimetableGrid').style.gap = '12px';`);
    await settle();
    value = await geometry();
    close(center(value), (value.rows[0].top + value.rows[0].bottom) / 2, 'ResizeObserver follows resized tracks');
    close(value.line.left, value.firstDay.left, 'ResizeObserver follows column gap');
    value = await at('2026-09-21T00:42:30Z');
    close(center(value), (value.rows[0].bottom + value.rows[1].top) / 2, '08:42:30 midway through break');
    value = await at('2026-09-21T08:30:00Z');
    close(center(value), value.rows[10].bottom + (value.rows[11].top - value.rows[10].bottom) * 5 / 95, 'long break after P10');
    value = await at('2026-09-21T04:20:00Z');
    close(center(value), (value.rows[5].top + value.rows[5].bottom) / 2, 'short lunch banner');
    value = await at('2026-09-21T00:40:00Z');
    close(center(value), value.rows[0].bottom, 'exact period end');
    value = await at('2026-09-21T00:45:00Z');
    close(center(value), value.rows[1].top, 'exact period start');
    value = await at('2026-09-21T12:30:00Z');
    close(center(value), value.rows[11].bottom, 'last period endpoint');
    assert.equal((await at('2026-09-21T12:30:01Z')).line, null, 'after last period');
    assert.equal((await at('2026-09-20T23:59:59Z')).line, null, 'before first period');

    await at('2026-09-21T00:20:00Z');
    await run(`document.querySelector('[data-school-action="toggle-weekend"]').click()`);
    await settle();
    value = await geometry();
    close(center(value), (value.rows[0].top + value.rows[0].bottom) / 2, 'seven-day rerender');
    assert.equal(value.count, 1, 'rerender leaves exactly one line');
    win.setSize(700, 600);
    await run(`const scroller = document.querySelector('.school-timetable-scroll'); scroller.style.maxHeight = '220px'; scroller.scrollLeft = 100; scroller.scrollTop = 35;`);
    await settle();
    value = await geometry();
    close(center(value), (value.rows[0].top + value.rows[0].bottom) / 2, 'scroll and window resize preserve row alignment');
    close(value.line.left, value.firstDay.left, 'horizontal scroll preserves column alignment');
    await run(`document.querySelector('#schoolPage').style.zoom = '1.25'`);
    await settle();
    value = await geometry();
    close(center(value), (value.rows[0].top + value.rows[0].bottom) / 2, 'page zoom preserves row alignment');
    close(value.line.left, value.firstDay.left, 'page zoom preserves column alignment');
    await run(`document.querySelector('#schoolPage').style.display = 'none'; clockTick()`);
    await settle();
    assert.equal((await geometry()).line, null, 'hidden layout has no bogus zero-position line');
    await run(`document.querySelector('#schoolPage').style.display = 'block'`);
    await settle();
    value = await geometry();
    close(center(value), (value.rows[0].top + value.rows[0].bottom) / 2, 'showing page restores line');
    await run(`document.querySelector('[data-school-action="week"][data-delta="7"]').click()`);
    await settle();
    assert.equal(await run('document.querySelector(".school-now-line") === null'), true, 'no line in a different week');
    process.stdout.write('PH_SCHOOL_CLOCK_REPORT=passed geometry, timezone, variable rows, gaps, endpoints, resize, scroll, zoom, visibility, rerender, week\n');
    clearTimeout(deadline);
    win.destroy();
    app.exit(0);
  }).catch((error) => { process.stderr.write(error.stack + '\n'); app.exit(1); });
} else {
  const test = require('node:test');
  const { spawn } = require('node:child_process');
  test('current-time indicator follows real timetable geometry and Shanghai clock', { timeout: 30000 }, async (t) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-school-clock-'));
    t.after(() => {
      const resolved = path.resolve(profile);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('ph-school-clock-'));
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const environment = { ...process.env, PH_SCHOOL_CLOCK_PROFILE: profile };
    delete environment.ELECTRON_RUN_AS_NODE;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(require('electron'), [__filename, '--school-clock-child'], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Clock fixture timed out')); }, 25000);
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /PH_SCHOOL_CLOCK_REPORT=passed/);
  });
}

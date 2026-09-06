// This fixture never contacts a school: its temporary Electron session serves
// all HTTPS responses locally. Only synthetic credentials enter these forms.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { credentialAutofillScript, CREDENTIAL_ISOLATED_WORLD_ID } = require('../electron/credential-autofill.cjs');

const childMode = Boolean(process.versions.electron) && process.argv.includes('--credential-dom-child');

if (childMode) {
  const { app, BrowserWindow, session } = require('electron');
  const temporaryProfile = process.env.PH_CREDENTIAL_TEST_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'ph-credential-electron-'));
  assert.equal(path.dirname(path.resolve(temporaryProfile)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporaryProfile).startsWith('ph-credential-electron-'));
  app.setPath('userData', temporaryProfile);
  app.setPath('sessionData', temporaryProfile);
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    const fixtureSession = session.fromPartition(`credential-dom-${process.pid}`);
    let pageContent = '';
    let receivedRequests = 0;
    await fixtureSession.protocol.handle('https', () => {
      receivedRequests += 1;
      return new Response(pageContent, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    });
    const window = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: {
      session: fixtureSession, nodeIntegration: false, sandbox: true, contextIsolation: true,
    } });
    const web = window.webContents;
    const origin = 'https://shph.managebac.cn';
    const fixture = { username: 'fixture-student', password: 'fixture-not-a-real-password' };
    const form = `<form id="login" action="/sessions" method="post"><label>Account<input name="username" autocomplete="username"></label><label>Password<input name="password" type="password" autocomplete="current-password"></label><button type="submit">Log in</button></form>`;
    const instrumentation = `<script>
      window.interceptedSetters = 0;
      window.formSubmissions = 0;
      window.changes = [];
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      Object.defineProperty(HTMLInputElement.prototype, 'value', {
        ...descriptor, set(value) { window.interceptedSetters++; descriptor.set.call(this, value); },
      });
      document.addEventListener('input', (event) => window.changes.push(event.target.name));
      document.addEventListener('submit', (event) => { event.preventDefault(); window.formSubmissions++; });
    </script>`;
    const load = async (content, pathname = '/login') => {
      pageContent = `<!doctype html><html><body>${content}</body></html>`;
      await web.loadURL(`${origin}${pathname}`);
    };
    const fill = () => web.executeJavaScriptInIsolatedWorld(CREDENTIAL_ISOLATED_WORLD_ID, [{
      code: credentialAutofillScript('managebac', fixture, { expectedUrl: web.getURL() }),
    }]);
    let checks = 0;
    await load(form + instrumentation);
    assert.deepEqual(await fill(), { filled: true });
    const observation = await web.executeJavaScript(`({
      usernameMatches: document.querySelector('[name=username]').value === 'fixture-student',
      passwordMatches: document.querySelector('[name=password]').value === 'fixture-not-a-real-password',
      interceptedSetters: window.interceptedSetters,
      formSubmissions: window.formSubmissions,
      changes: window.changes,
      globalSecret: typeof window.credential !== 'undefined'
    })`);
    assert.deepEqual(observation, {
      usernameMatches: true, passwordMatches: true, interceptedSetters: 0, formSubmissions: 0,
      changes: ['username', 'password'], globalSecret: false,
    });
    checks += 1;
    assert.equal((await fill()).reason, 'fields-not-empty');
    checks += 1;

    await load(form.replace('action="/sessions"', 'action="https://evil.test/collect"'));
    assert.equal((await fill()).reason, 'untrusted-form-action');
    assert.equal(await web.executeJavaScript(`document.querySelector('[name=password]').value.length`), 0);
    checks += 1;

    await load(form.replace('current-password', 'new-password'));
    assert.equal((await fill()).reason, 'not-login-form');
    checks += 1;

    await load(form.replace('</form>', '<input type="password" name="confirmation" style="display:none"></form>'));
    assert.equal((await fill()).reason, 'not-login-form');
    checks += 1;

    await load(form);
    const staleScript = credentialAutofillScript('managebac', fixture, { expectedUrl: `${origin}/login` });
    await web.executeJavaScript(`history.replaceState({}, '', '/another-page')`);
    const staleResult = await web.executeJavaScriptInIsolatedWorld(CREDENTIAL_ISOLATED_WORLD_ID, [{ code: staleScript }]);
    assert.equal(staleResult.reason, 'untrusted-page');
    checks += 1;

    assert.ok(receivedRequests >= 5);
    window.destroy();
    process.stdout.write(`PH_CREDENTIAL_DOM_REPORT=${JSON.stringify({ ok: true, checks, externalNetwork: false })}\n`);
    app.exit(0);
  }).catch(() => {
    // Never dump executed script text, which contains the synthetic password.
    process.stderr.write('Credential isolated-world fixture failed.\n');
    app.exit(1);
  });
} else {
  const test = require('node:test');
  const { spawn } = require('node:child_process');
  const noDisplay = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  test('real Electron DOM confirms isolated-world autofill, no submission, and navigation/action guards', { skip: noDisplay, timeout: 30000 }, async (t) => {
    const env = { ...process.env };
    const temporaryProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-credential-electron-'));
    env.PH_CREDENTIAL_TEST_PROFILE = temporaryProfile;
    t.after(() => {
      const resolved = path.resolve(temporaryProfile);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('ph-credential-electron-'));
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(require('electron'), [__filename, '--credential-dom-child'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Credential DOM fixture timed out')); }, 25000);
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    assert.equal(result.code, 0, `Electron credential fixture exited ${result.code}; check count: ${result.stdout.match(/PH_CREDENTIAL_DOM_REPORT=.*/)?.[0] || 'unavailable'}`);
    const line = result.stdout.split(/\r?\n/).find((value) => value.startsWith('PH_CREDENTIAL_DOM_REPORT='));
    assert.ok(line, 'Electron did not produce a DOM fixture report');
    const report = JSON.parse(line.slice('PH_CREDENTIAL_DOM_REPORT='.length));
    assert.deepEqual(report, { ok: true, checks: 6, externalNetwork: false });
  });
}

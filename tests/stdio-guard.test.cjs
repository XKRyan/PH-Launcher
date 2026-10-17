const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { guardStdio } = require('../electron/stdio-guard.cjs');

test('stdio guard handles only broken pipes and installs once', () => {
  const stream = new EventEmitter();
  guardStdio([stream, null]);
  guardStdio([stream]);
  assert.equal(stream.listenerCount('error'), 1);
  assert.doesNotThrow(() => stream.emit('error', Object.assign(new Error('pipe'), { code: 'EPIPE' })));
  const other = Object.assign(new Error('disk'), { code: 'EIO' });
  assert.throws(() => stream.emit('error', other), (error) => error === other);
});

test('guard is installed before loading Electron', () => {
  const main = readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  assert.ok(main.indexOf("require('./stdio-guard.cjs').guardStdio()") < main.indexOf("require('electron')"));
});

test('console logging survives actual closed stdout and stderr pipes', { timeout: 10000 }, async () => {
  const modulePath = path.join(__dirname, '../electron/stdio-guard.cjs');
  const script = `
    require(${JSON.stringify(modulePath)}).guardStdio();
    process.on('message', () => {
      console.log('normal output after parent disconnected');
      console.error('IPC rejection after parent disconnected');
      setTimeout(() => {
        console.error('another rejection');
        process.send('alive');
        process.disconnect();
      }, 100);
    });
    process.send('ready');
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let alive = false;
  child.on('message', (message) => {
    if (message === 'ready') {
      child.stdout.destroy();
      child.stderr.destroy();
      child.send('write');
    }
    if (message === 'alive') alive = true;
  });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  assert.equal(code, 0);
  assert.equal(alive, true);
});

test('Electron IPC rejection survives disconnected console pipes', { timeout: 25000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-stdio-test-'));
  const env = { ...process.env, PH_STDIO_TEST_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [path.join(__dirname, 'fixtures/stdio-electron.cjs')], {
    env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  let alive = false;
  child.on('message', (message) => {
    if (message === 'ready') {
      child.stdout.destroy();
      child.stderr.destroy();
      child.send('reject');
    }
    if (message === 'alive') alive = true;
  });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  assert.equal(code, 0);
  assert.equal(alive, true);
});

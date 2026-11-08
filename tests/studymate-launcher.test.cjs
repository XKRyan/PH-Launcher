'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStudyMateLauncher, candidateRoots } = require('../electron/studymate-launcher.cjs');

test('StudyMate root candidates include the local D: install and user folders', () => {
  const roots = candidateRoots({ env: { USERPROFILE: 'C:\\Users\\A', LOCALAPPDATA: 'C:\\Users\\A\\AppData\\Local' }, configured: 'E:\\Apps\\StudyMate' });
  assert.equal(roots[0], 'E:\\Apps\\StudyMate');
  assert.ok(roots.includes('D:\\deepstudy'));
  assert.ok(roots.some(root => /deepstudy$/i.test(root)));
});

test('an already running StudyMate is handed to the caller without spawning', async () => {
  const spawned = [];
  const launcher = createStudyMateLauncher({
    platform: 'win32',
    env: { USERPROFILE: 'C:\\Users\\A' },
    getConfiguredRoot: () => 'D:\\deepstudy',
    healthCheck: async () => true,
    exists: () => false,
    spawnProcess: (...args) => spawned.push(args),
  });
  const status = await launcher.status();
  assert.equal(status.running, true);
  assert.equal(status.url, 'http://127.0.0.1:8765');
  const result = await launcher.open();
  assert.deepEqual({ opened: result.opened, running: result.running, spawned: result.spawned }, { opened: true, running: true, spawned: false });
  assert.equal(spawned.length, 0);
});

test('a local StudyMate install starts detached and waits for health', async () => {
  let up = false;
  const spawned = [];
  const files = new Set(['D:\\deepstudy\\.venv\\Scripts\\pythonw.exe', 'D:\\deepstudy\\deepstudy.pyw']);
  const launcher = createStudyMateLauncher({
    platform: 'win32',
    env: {},
    getConfiguredRoot: () => 'D:\\deepstudy',
    healthCheck: async () => up,
    exists: file => files.has(file),
    spawnProcess: (command, args, options) => {
      spawned.push({ command, args, options });
      up = true;
      return { unref() {} };
    },
    waitMs: 0,
    waitAttempts: 3,
  });
  const result = await launcher.open();
  assert.equal(result.opened, true);
  assert.equal(result.spawned, true);
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0].args[0].endsWith('deepstudy.pyw'));
  assert.equal(spawned[0].options.cwd, 'D:\\deepstudy');
  assert.equal(spawned[0].options.detached, true);
});

test('a missing StudyMate install reports available:false instead of throwing', async () => {
  const launcher = createStudyMateLauncher({
    platform: 'win32',
    env: {},
    getConfiguredRoot: () => '',
    healthCheck: async () => false,
    exists: () => false,
    spawnProcess: () => { throw new Error('must not spawn'); },
  });
  const status = await launcher.status();
  assert.equal(status.available, false);
  assert.equal(status.running, false);
  const result = await launcher.open();
  assert.equal(result.opened, false);
  assert.equal(result.available, false);
});

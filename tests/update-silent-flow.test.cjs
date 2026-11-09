'use strict';

/**
 * 静默更新流程的运行时测试。
 *
 * 把 electron / electron-updater 换成内存桩，真正调用 auto-updater.cjs 的
 * startSilentCheck / manualCheck / handleUserChoice，验证：
 *   · 发现新版本后自动静默下载，进度只进内部状态，不触发任何通知/弹窗事件；
 *   · 下载完成也绝不自动安装，只有用户点「重启并安装」才 quitAndInstall；
 *   · 下载失败 → error，点「更新」会重试；
 *   · 跳过本版本 → 不下载、不弹卡片；
 *   · 检查失败 ≠ 已是最新版本。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const MODULE_PATH = require.resolve('../electron/auto-updater.cjs');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error('waitFor timed out');
}

function makeHarness({ platform = 'win32', version = '2.0.12', skipped = '', latestVersion = '2.0.13', checkThrows = false, noUpdate = false, downloadFails = false } = {}) {
  const handlers = new Map();
  const sent = [];
  const installs = [];
  let downloadCalls = 0;
  let checkCalls = 0;
  let currentSkip = skipped;
  const quit = { called: false };

  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    emit(event, ...args) {
      for (const fn of handlers.get(event) || []) fn(...args);
    },
    async checkForUpdates() {
      checkCalls += 1;
      if (checkThrows) throw new Error('offline');
      return { updateInfo: noUpdate ? null : { version: latestVersion } };
    },
    async downloadUpdate() {
      downloadCalls += 1;
      if (downloadFails && downloadCalls === 1) throw new Error('network down');
      autoUpdater.emit('download-progress', { percent: 15 });
      autoUpdater.emit('download-progress', { percent: 87 });
      autoUpdater.emit('update-downloaded', {});
    },
    quitAndInstall(...args) {
      installs.push(args);
    },
  };

  const electron = {
    app: {
      getVersion: () => version,
      getPath: (name) => (name === 'exe' ? path.join(os.tmpdir(), 'PHLauncherTest.app', 'Contents', 'MacOS', 'PH Launcher') : path.join(os.tmpdir(), 'phl-update-test')),
      quit: () => { quit.called = true; },
    },
    shell: { openExternal: async () => {} },
  };

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron;
    if (request === 'electron-updater') return { autoUpdater };
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[MODULE_PATH];
  let mod;
  try {
    mod = require(MODULE_PATH);
  } finally {
    Module._load = originalLoad;
  }
  mod.initAutoUpdater({
    getPlatform: () => platform,
    getSkippedVersion: () => currentSkip,
    setSkippedVersion: (v) => { currentSkip = v; },
    sendToRenderer: (channel, payload) => sent.push({ channel, payload }),
  }, { schedule: false });

  return {
    mod,
    autoUpdater,
    sent,
    installs,
    quit,
    get downloadCalls() { return downloadCalls; },
    get checkCalls() { return checkCalls; },
    get skipVersion() { return currentSkip; },
  };
}

function stubFetch(ok = true) {
  const previous = global.fetch;
  global.fetch = async () => ({
    ok,
    json: async () => ({ ok: true, release_notes: '测试版本说明' }),
  });
  return () => { global.fetch = previous; };
}

test('启动静默检查 → 自动静默下载，进度只发 app:update-state，不弹通知/不自动安装', async () => {
  const restoreFetch = stubFetch();
  try {
    const h = makeHarness();
    await h.mod.startSilentCheck();
    await waitFor(() => h.mod.getUpdateState().downloaded === true);

    const state = h.mod.getUpdateState();
    assert.equal(state.version, '2.0.13');
    assert.equal(state.downloaded, true);
    assert.equal(state.percent, 100);
    assert.equal(h.downloadCalls, 1, '检查到新版本后应自动下载一次');
    assert.equal(h.installs.length, 0, '下载完成后不能自动安装');
    assert.equal(h.quit.called, false);

    const progress = h.sent.filter((e) => e.channel === 'app:update-state' && e.payload.phase === 'downloading');
    assert.ok(progress.length > 0, '应广播下载进度状态');
    assert.ok(progress.some((e) => e.payload.percent === 15), '应广播 15% 的中间进度');
    assert.ok(h.sent.some((e) => e.channel === 'app:update-state' && e.payload.phase === 'downloaded'));
    assert.ok(!h.sent.some((e) => e.channel === 'app:update-progress'), '不能再用旧的弹窗进度事件');
    assert.equal(h.mod.getPendingUpdate()?.downloaded, true, '启动补拉要能拿到已下载状态');
  } finally {
    restoreFetch();
  }
});

test('手动检查返回 new + 当前下载状态（未下完也如实返回进度）', async () => {
  const restoreFetch = stubFetch();
  try {
    const h = makeHarness();
    const result = await h.mod.manualCheck();
    assert.equal(result.ok, true);
    assert.equal(result.status, 'new');
    assert.equal(result.version, '2.0.13');
    assert.equal(typeof result.percent, 'number');
    assert.equal(typeof result.downloaded, 'boolean');

    await waitFor(() => h.mod.getUpdateState().downloaded === true);
    const again = await h.mod.manualCheck();
    assert.equal(again.status, 'new');
    assert.equal(again.downloaded, true, '手动再检查时已下载要返回 downloaded');
    assert.equal(h.checkCalls, 1, '已有更新时手动检查不应重复联网');
  } finally {
    restoreFetch();
  }
});

test('下载失败 → error；用户点「更新」重试下载，仍不自动安装', async () => {
  const restoreFetch = stubFetch();
  try {
    const h = makeHarness({ downloadFails: true });
    await h.mod.startSilentCheck();
    await waitFor(() => h.mod.getUpdateState().phase === 'error');
    assert.equal(h.mod.getPendingUpdate()?.phase, 'error');

    const retried = await h.mod.handleUserChoice('update');
    assert.equal(retried.action, 'download-started');
    await waitFor(() => h.mod.getUpdateState().downloaded === true);
    assert.equal(h.downloadCalls, 2, '重试应再下载一次');
    assert.equal(h.installs.length, 0);
  } finally {
    restoreFetch();
  }
});

test('只有已下载后点「重启并安装」才 quitAndInstall（Windows）', async () => {
  const restoreFetch = stubFetch();
  try {
    const h = makeHarness();
    await h.mod.startSilentCheck();
    await waitFor(() => h.mod.getUpdateState().downloaded === true);

    const result = await h.mod.handleUserChoice('update');
    assert.equal(result.ok, true);
    assert.equal(result.action, 'install');
    await waitFor(() => h.installs.length === 1, 2000);
    assert.equal(h.installs[0][0], true, 'isSilent=true');
    assert.equal(h.installs[0][1], true, 'isForceRunAfter=true，安装后要自动重启');
  } finally {
    restoreFetch();
  }
});

test('被跳过的新版本：不下载、不返回待办、状态保持 idle', async () => {
  const restoreFetch = stubFetch();
  try {
    const h = makeHarness({ skipped: '2.0.13' });
    const result = await h.mod.startSilentCheck();
    assert.equal(result.status, 'skipped');
    assert.equal(h.downloadCalls, 0, '跳过的版本不应该在后台下载');
    assert.equal(h.mod.getPendingUpdate(), null);
    assert.equal(h.mod.getUpdateState().phase, 'idle');
  } finally {
    restoreFetch();
  }
});

test('检查失败明确返回 failed，绝不报「已是最新」', async () => {
  const restoreFetch = stubFetch();
  try {
    const h = makeHarness({ checkThrows: true });
    const result = await h.mod.manualCheck();
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /检查失败/);
    assert.equal(h.mod.getPendingUpdate(), null);
  } finally {
    restoreFetch();
  }
});

test('并发检查去重：同时触发两次只联网一次', async () => {
  const restoreFetch = stubFetch();
  try {
    const h = makeHarness();
    const [a, b] = await Promise.all([h.mod.startSilentCheck(), h.mod.startSilentCheck()]);
    assert.equal(a.status, 'new');
    assert.equal(b.status, 'new');
    assert.equal(h.checkCalls, 1);
    await waitFor(() => h.mod.getUpdateState().downloaded === true);
  } finally {
    restoreFetch();
  }
});

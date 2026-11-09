/* ============================================================================
 * PHL 账号/同步一致性修复的回归测试（2026-11-09）
 *
 * 覆盖用户报的那串 bug 的根因：
 *   · `phix:*` IPC 的 `{ok,data}` 包装必须被 account-bridge 解开 —— 否则设置页
 *     账号卡片一直"未登录"，方向页永远 0 项，准备清单退化成一条假步骤；
 *   · 同步方向/准备计划/登录失败必须如实传播，不能"密码错了也当成功"；
 *   · `settings.ai` 默认同步（并迁移旧默认对象），否则网页端配的 AI 拉不下来；
 *   · 主进程任意入口（向导/设置/后台自动同步）改了状态都要广播，渲染进程统一刷新；
 *   · 账号界面必须有 PHL 主题与明显的跳过入口（共享 account-ui.js 不改）。
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const HERE = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

const BRIDGE = read('src/account-bridge.js');
const THEME = read('src/account-theme.js');
const MAIN = read('electron/main.cjs');
const PRELOAD = read('electron/preload.cjs');
const APP = read('src/app.js');
const HTML = read('src/index.html');
const cloudsync = require('../electron/cloudsync.cjs');
const phixSession = require('../electron/phix-session.cjs');

// ---------------------------------------------------------------- 工具
function makeBridge(overrides = {}) {
  const calls = { prepareDirection: [], login: [] };
  const phix = {
    status: async () => ({ ok: true, data: { logged_in: false } }),
    profile: async () => ({ ok: true, data: null }),
    login: async (input) => { calls.login.push(input); return { ok: true, data: { logged_in: true } }; },
    register: async () => ({ ok: true, data: {} }),
    logout: async () => ({ ok: true, data: {} }),
    syncPreview: async () => ({ ok: true, data: { report: {} } }),
    sync: async () => ({ ok: true, data: {} }),
    preparePlan: async () => ({ ok: true, data: [] }),
    prepareStep: async () => ({ ok: true, data: { ok: true } }),
    prepareDirection: async (input) => { calls.prepareDirection.push(input); return { ok: true, data: { ok: true } }; },
    saveProfile: async () => ({ ok: true, data: {} }),
    ...overrides.phix,
  };
  const credentials = {
    status: async () => ({ sites: {} }),
    ...overrides.credentials,
  };
  const window = { ph: { phix, credentials } };
  vm.runInNewContext(BRIDGE, { window, console });
  return { bridge: window.AccountBridge, calls, window };
}

// ---------------------------------------------------------------- 桥接：解包装
test('桥接解开 {ok,data}：已登录状态、显示名、同步时间都能读到', async () => {
  const { bridge } = makeBridge({
    phix: {
      status: async () => ({
        ok: true,
        data: {
          logged_in: true, username: 'hzq', server: 'https://phix.ing/api/v1',
          last_sync_at: '2026-11-09T06:38:40.000Z', unlocked: true,
        },
      }),
      profile: async () => ({ ok: true, data: { display_name: 'haku', avatar: '' } }),
    },
    credentials: { status: async () => ({ sites: { edupage: { saved: true, username: 'hzq' } } }) },
  });
  const status = await bridge.status();
  assert.equal(status.loggedIn, true, '不能把 {ok,data} 包装当数据，否则这里恒为 false');
  assert.equal(status.username, 'hzq');
  assert.equal(status.displayName, 'haku');
  assert.match(status.syncedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(status.accounts.find((a) => a.id === 'edupage').loggedIn, true);
  assert.equal(status.accounts.find((a) => a.id === 'managebac').loggedIn, false);
});

test('桥接把同步预览的报告折成方向页的"云端 N 项 / 本地 N 项"', async () => {
  const { bridge } = makeBridge({
    phix: {
      syncPreview: async () => ({
        ok: true,
        data: {
          report: {
            pulled: ['schedule', 'profile'],
            pushed: ['settings.ui'],
            conflicts: [],
            errors: [],
          },
        },
      }),
    },
  });
  const probe = await bridge.probe();
  assert.equal(probe.remote.count, 2);
  assert.equal(probe.local.count, 1);
  assert.equal(probe.objects.find((o) => o.id === 'schedule').remote, 1);
  assert.equal(probe.objects.find((o) => o.id === 'settings.ui').local, 1);
});

test('桥接必须如实传播登录/注册失败（不能密码错了也返回 ok）', async () => {
  const { bridge } = makeBridge({
    phix: {
      login: async () => ({ ok: false, error: '密码不对（或这个账号的密钥材料已损坏）' }),
      register: async () => ({ ok: false, error: '账号已存在' }),
    },
  });
  const login = await bridge.login('hzq', 'wrong');
  assert.equal(login.ok, false);
  assert.match(login.error, /密码不对/);
  const register = await bridge.register('hzq', 'x');
  assert.equal(register.ok, false);
  assert.match(register.error, /账号已存在/);
});

test('桥接解开准备计划数组与逐步结果；失败步骤带 detail', async () => {
  const { bridge } = makeBridge({
    phix: {
      preparePlan: async () => ({ ok: true, data: [{ id: 'sync', label: '同步你的数据' }, { id: 'school', label: '登录学校账号' }] }),
      prepareStep: async (id) => (id === 'school'
        ? { ok: true, data: { ok: false, detail: '1 个需要重新登录' } }
        : { ok: true, data: { ok: true, detail: '拉取 3 项' } }),
    },
  });
  const plan = await bridge.preparePlan();
  assert.equal(plan.length, 2);
  assert.equal(plan[0].id, 'sync');
  const ok = await bridge.prepareStep('sync');
  assert.equal(ok.ok, true);
  assert.equal(ok.detail, '拉取 3 项');
  const failed = await bridge.prepareStep('school');
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /重新登录/);
});

test('方向选择只记方向、不立刻跑同步；merge 不覆盖任何一侧', async () => {
  const { bridge, calls } = makeBridge();
  assert.equal((await bridge.sync('cloud')).ok, true);
  assert.equal((await bridge.sync('local')).ok, true);
  assert.equal((await bridge.sync('merge')).ok, true);
  assert.deepEqual(calls.prepareDirection.map((c) => c.direction), ['remote', 'local', '']);
});

// ---------------------------------------------------------------- 同步对象默认值
test('settings.ai 默认参与同步（网页端/PLL 配的 AI 能拉下来）', () => {
  assert.ok(cloudsync.DEFAULT_OBJECTS.includes('settings.ai'), 'cloudsync 默认对象要含 AI 配置');
  assert.ok(cloudsync.DEFAULT_OBJECTS.includes('settings.accounts'));
});

test('旧的默认对象清单会自动升级为含 settings.ai 的新默认', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phl-account-sync-'));
  try {
    phixSession.configure({ dataDir: dir });
    const oldDefault = ['settings.accounts', 'settings.lessons', 'settings.ui', 'schedule', 'timetable', 'school', 'profile'];
    phixSession.saveConfig({ objects: oldDefault });
    const config = phixSession.loadConfig();
    assert.ok(config.objects.includes('settings.ai'), '旧默认集合应升级');
    assert.match(fs.readFileSync(path.join(dir, 'settings.yaml'), 'utf8'), /settings\.ai/);

    // 用户自定义过的清单不能被"升级"改掉
    phixSession.saveConfig({ objects: ['schedule', 'mood'] });
    assert.deepEqual(phixSession.loadConfig().objects, ['schedule', 'mood']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('phix-session 的默认配置也同步 AI 配置', () => {
  assert.ok(phixSession.defaultConfig().objects.includes('settings.ai'));
});

// ---------------------------------------------------------------- 主进程/渲染进程接线
test('准备清单第一项是真的同步步骤，会报告拉取/上传结果', () => {
  assert.match(MAIN, /id: 'sync',\s*\n\s*label: '同步你的数据'/);
  assert.match(MAIN, /const prefer = \(prepareDirection === 'remote' \|\| prepareDirection === 'local'\)/);
  assert.match(MAIN, /afterPhixSync\(report\)/);
});

test('同步结束统一收尾：AI 回灌、账号广播、数据广播、phix 变化广播', () => {
  assert.match(MAIN, /function afterPhixSync\(report\)/);
  assert.match(MAIN, /adoptAiProvidersFromSharedSettings\(\)/);
  assert.match(MAIN, /publishCredentialChange\(\)/);
  assert.match(MAIN, /sendToRenderer\('data:changed', secureStore\.forRenderer\(\)\)/);
  assert.match(MAIN, /function broadcastPhixChanged\(\)/);
  assert.match(MAIN, /sendToRenderer\('phix:changed'/);
  // 后台自动同步也要收尾（onSyncApplied 里）
  assert.match(MAIN, /onSyncApplied: \(\) => \{[\s\S]*?broadcastPhixChanged\(\)/);
});

test('preload 暴露方向记录与 phix:changed 事件', () => {
  assert.match(PRELOAD, /prepareDirection: \(input\) => ipcRenderer\.invoke\('phix:prepare-direction', input\)/);
  assert.match(PRELOAD, /onChanged: \(callback\) => on\('phix:changed', callback\)/);
});

test('渲染进程在账号流程/同步事件后统一刷新所有页面', () => {
  assert.match(APP, /async function refreshAfterPhixChange\(/);
  assert.match(APP, /window\.ph\.phix\?\.onChanged/);
  assert.match(APP, /onFinish: finishAccountFlow/);
  assert.match(APP, /refreshAfterPhixChange\('account-flow'\)/);
  // 设置页的云同步 section 每次打开都要重新读状态
  assert.match(APP, /if \(section === 'cloud'\)[\s\S]*?phixUI\?\.refresh/);
});

test('设置页：隐藏的独立同步口令行必须真的不显示', () => {
  const PHIX_CSS = read('src/phix.css');
  assert.match(PHIX_CSS, /\[hidden\]\s*\{\s*display:\s*none\s*!important/,
    '.phix-row 的 display:flex 会盖掉 [hidden]，必须有显式隐藏规则');
});

test('账号界面加载 PHL 主题增强，且共享 account-ui.js 保持独立', () => {
  assert.match(HTML, /account-theme\.js/);
  assert.ok(!THEME.includes('firstRun('), '增强层不应改共享界面的行为逻辑');
  assert.match(THEME, /paui-skip-cta/, '登录页要有明显的跳过按钮');
  assert.match(THEME, /paui-skip-direction/, '方向页也要能跳过');
  assert.match(THEME, /phl-bar-shimmer/, '进度条要有动效');
  assert.match(THEME, /prefers-reduced-motion/, '要尊重减少动效设置');
});

// ---------------------------------------------------------------- AI 配置同步
test('空 AI 配置的同步载荷必须稳定（不能每轮盖新时间戳导致空推）', () => {
  const aiConfig = require('../electron/ai-config.cjs');
  const a = aiConfig.serializeAiConfig({ providers: [], default_index: 0 });
  const b = aiConfig.serializeAiConfig({ providers: [], default_index: 0 });
  assert.deepEqual(a, b, '两次序列化必须完全一致');
  assert.equal(a.updated_at, '', '空配置不应有"现在"的时间戳');
  assert.equal(a.updated_by, '');
  const p1 = cloudsync.aiSyncPayload({ providers: [], default_index: 0 });
  const p2 = cloudsync.aiSyncPayload({ providers: [], default_index: 0 });
  assert.deepEqual(p1, p2, '空配置每轮 collect 出来的载荷要一样');

  const withProvider = aiConfig.serializeAiConfig({
    providers: [{ name: 'TestAI', protocol: 'openai', base_url: 'https://example.invalid/v1', model: 'm', api_key: 'k' }],
    updated_at: '2026-11-09T15:00:00+08:00',
  });
  assert.equal(withProvider.updated_at, '2026-11-09T15:00:00+08:00', '有配置时沿用给定时间戳');
  assert.equal(withProvider.providers[0].api_key, 'k', 'Key 必须随载荷上云（端到端加密）');
});

test('登录/恢复后把本机旧 AI 配置迁进共享 settings.yaml；云端已有则不抢', () => {
  assert.match(MAIN, /function migrateLocalAiToSharedSettings\(/);
  assert.match(MAIN, /if \(aiConfig\.providersOf\(current\)\.length\) return false;/,
    '共享文件已有配置时不覆盖');
  assert.match(MAIN, /migrateLocalAiToSharedSettings\(\);/);
  // 云端配置收下来后：本机还是 off/未启用时自动投影成 API 连接
  assert.match(MAIN, /latest\.provider === 'off'/);
  assert.match(MAIN, /secureStore\.updateAi\(\{ enabled: true, provider: 'api' \}, \{ silent: true \}\)/);
});

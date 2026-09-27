'use strict';

/**
 * AI 服务商配置归一化 / 迁移 / 多服务商自检（2026-09-13 三端统一）。
 *
 *    node --test tests/ai-provider-config.test.cjs
 *
 * 覆盖验收要求：
 * 1. 旧扁平形态 → 迁移成 providers[]（不丢字段、不让 AI 失效）
 * 2. 写回时保留 workspace / workspaces / localModel / localEndpoint 等本地专有字段
 * 3. 多服务商时按 default_index 选默认（投影到 apiEndpoint/apiModel/apiKey/apiProtocol）
 * 4. updated_by / updated_at 正确
 * 5. cloudsync 的 settings.ai 载荷是规范形态，往返之后本地扁平形态仍然完整
 *
 * 全部用假 Key（sk-fake-*），不涉及真实凭据，也不发任何网络请求。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const aiConfig = require('../electron/ai-config.cjs');
const cloudsync = require('../electron/cloudsync.cjs');

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
const APP_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
const PAGE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');

// ---------------------------------------------------------------- 主进程片段
/**
 * 从 main.cjs 里取出**真实的** `createDefaultData` / `mergeDefaults` / `SecureStore`
 * 三块代码在 vm 里跑（它们在 Electron 主进程里无法直接 require）。
 * 只补它们真正用到的依赖，别的都留桩，绝不整份执行 main.cjs。
 */
function mainHarness() {
  const extract = (startMarker, endMarker) => {
    const start = MAIN_SOURCE.indexOf(startMarker);
    assert.ok(start > 0, `找不到 ${startMarker}`);
    const end = endMarker ? MAIN_SOURCE.indexOf(endMarker, start) : MAIN_SOURCE.length;
    assert.ok(end > start, `找不到 ${startMarker} 的结尾 ${endMarker}`);
    return MAIN_SOURCE.slice(start, end);
  };
  const code = [
    // SecureStore.forRenderer() 会用到 dataRoot()（导出数据目录），补一个只读的桩
    'function dataRoot() { return { settings: "", launcher: "", phix: "" }; }',
    // 密钥桥（把服务商写进共用的 settings.yaml）：这一段在真实代码里靠 dataRoot +
    // 云同步模块，单测里不需要真文件，桩掉即可 —— 它有自己的用例。
    `function writeAiProvidersToSharedSettings() { globalThis.__aiBridgeWrites = (globalThis.__aiBridgeWrites || 0) + 1; }`,
    extract('function createDefaultData() {', '\nfunction mergeDefaults('),
    extract('function mergeDefaults(', '\n// AI file tools are confined'),
    extract('function normalizeWorkspacePath(', '\n// Xinlv state is split by trust level'),
    extract('class SecureStore {', '\nconst schoolState = new SchoolCache('),
  ].join('\n');
  const context = {
    aiConfig,
    structuredClone,
    path, fs, os, console, process,
    safeStorage: { decryptString: () => '', isEncryptionAvailable: () => false },
    createDefaultData: null,
    mergeWorkspaceState: (value) => value,
    mergeXinlvState: (value) => value,
    normalizeCustomSites: (value) => (Array.isArray(value) ? value : []),
    vocabulary: require('../electron/vocabulary.cjs'),
    calendar: require('../electron/calendar.cjs'),
    DATA_VERSION: 1,
    AI_CONTROL_CONSENT_VERSION: 1,
    AI_MAIL_CONSENT_VERSION: 2,
    CLEAN_DISPLAY_DEFAULTS: {},
    DEFAULT_SHORTCUTS: {},
    DATA_ENCRYPTION: false,
    IS_HEADLESS: true,
  };
  vm.runInNewContext(`${code}
this.__main = { createDefaultData, mergeDefaults, SecureStore };`, context);
  return context.__main;
}

const main = mainHarness();

/**
 * 跑**真实的**密钥桥（`writeAiProvidersToSharedSettings` /
 * `adoptAiProvidersFromSharedSettings`），只把 `dataRoot()` 指到一个临时目录。
 * 这两段在真实代码里散落在 main.cjs 里、依赖 Electron 的 app.getPath，所以照上面的
 * 做法把它们原样取出来执行 —— 测的是同一份代码，不是复制品。
 */
function keyBridgeHarness(dir, store) {
  const slice = (startMarker, endMarker) => {
    const start = MAIN_SOURCE.indexOf(startMarker);
    assert.ok(start > 0, `找不到 ${startMarker}`);
    const end = endMarker ? MAIN_SOURCE.indexOf(endMarker, start) : MAIN_SOURCE.length;
    assert.ok(end > start, `找不到 ${startMarker} 的结尾`);
    return MAIN_SOURCE.slice(start, end);
  };
  const code = [
    slice('function aiSettingsFilePath() {', '\nfunction adoptAiProvidersFromSharedSettings()'),
    slice('function adoptAiProvidersFromSharedSettings() {', '\nfunction aiConnectionKey()'),
  ].join('\n');
  const context = {
    aiConfig,
    syncCloudsync: cloudsync,
    secureStore: store,
    dataRoot: () => ({ settings: path.join(dir, 'settings.yaml') }),
    console,
  };
  vm.runInNewContext(`${code}
this.__bridge = { writeAiProvidersToSharedSettings, adoptAiProvidersFromSharedSettings };`, context);
  return context.__bridge;
}

function memoryStore(ai) {
  const store = new main.SecureStore(path.join(os.tmpdir(), 'ph-launcher-ai-config-test.json'));
  store.data.settings.ai = { ...store.data.settings.ai, ...ai };
  store.save = () => {};
  return store;
}

// ---------------------------------------------------------------- 1. 归一化 / 迁移
test('旧扁平形态读取时自动迁移成一条 providers，且不丢任何字段', () => {
  const legacy = {
    enabled: true,
    provider: 'api',
    apiEndpoint: 'https://api.deepseek.com/v1',
    apiModel: 'deepseek-chat',
    apiKey: 'sk-fake-legacy',
    localEndpoint: 'http://127.0.0.1:11434',
    localModel: 'qwen3.5:2b',
    workspace: '/tmp/ws',
    workspaces: ['/tmp/ws'],
    permissionMode: 'chat',
    launcherControlEnabled: false,
  };
  const migrated = aiConfig.migrateFlatConfig(legacy);
  assert.equal(migrated.providers.length, 1, '旧扁平形态迁移成一条');
  assert.deepEqual(migrated.providers[0], {
    name: '来自客户端',
    protocol: 'openai',
    base_url: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    api_key: 'sk-fake-legacy',
  });
  // 本地专有字段一个都没丢
  for (const key of ['enabled', 'provider', 'localEndpoint', 'localModel', 'workspace', 'workspaces', 'permissionMode']) {
    assert.deepEqual(migrated[key], legacy[key], `${key} 不许丢`);
  }
  assert.equal(migrated.apiEndpoint, 'https://api.deepseek.com/v1', '扁平字段继续可用');

  // 已经是规范形态的不动（不能每次读取都重新投影一遍默认项）
  const canonical = { providers: [{ name: 'A', base_url: 'https://a/v1', model: 'm', api_key: 'sk-fake-a', protocol: 'openai' }], default_index: 0, workspace: '/w' };
  assert.deepEqual(aiConfig.migrateFlatConfig(canonical).providers, canonical.providers);

  // 没有配置时不凭空造服务商
  assert.deepEqual(aiConfig.migrateFlatConfig({ provider: 'off' }).providers, []);
});

test('mergeDefaults 走的是同一条迁移路径（老用户 profile 第一次读取就升级）', () => {
  const data = main.mergeDefaults({
    version: 1,
    settings: {
      ai: {
        enabled: true, provider: 'api',
        apiEndpoint: 'https://api.moonshot.cn/v1', apiModel: 'kimi-k2', apiKey: 'sk-fake-kimi',
        workspace: '/students/notes', localModel: 'qwen3.5:2b',
      },
    },
  });
  const ai = data.settings.ai;
  assert.equal(ai.providers.length, 1, '老 profile 读一次就有 providers[]');
  assert.equal(ai.providers[0].base_url, 'https://api.moonshot.cn/v1');
  assert.equal(ai.providers[0].model, 'kimi-k2');
  assert.equal(ai.providers[0].api_key, 'sk-fake-kimi', 'Key 不许在迁移中丢');
  assert.equal(ai.workspace, '/students/notes', 'workspace 保留');
  assert.equal(ai.localModel, 'qwen3.5:2b', 'localModel 保留（本地 AI 还要用）');
  assert.equal(ai.apiProtocol, 'openai', '运行路径拿到协议');
});

// ---------------------------------------------------------------- 2. 多服务商 + 默认项
test('多服务商时按 default_index 选默认并投影到运行字段', () => {
  const store = memoryStore({
    enabled: true,
    provider: 'api',
    workspace: '/w',
    workspaces: ['/w'],
    localModel: 'qwen3.5:2b',
    localEndpoint: 'http://127.0.0.1:11434',
  });
  const saved = store.updateAi({
    enabled: true,
    provider: 'api',
    default_index: 1,
    providers: [
      { name: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', api_key: 'sk-fake-1' },
      { name: '备用', protocol: 'anthropic', base_url: 'https://api.moonshot.cn/v1', model: 'kimi-k2', api_key: 'sk-fake-2' },
    ],
  });
  const stored = () => store.data.settings.ai;
  assert.equal(saved.providers.length, 2, '两个服务商都存下了');
  assert.equal(saved.default_index, 1);
  assert.equal(saved.apiEndpoint, 'https://api.moonshot.cn/v1', '默认那条投影到 apiEndpoint');
  assert.equal(saved.apiModel, 'kimi-k2');
  assert.equal(saved.apiProtocol, 'anthropic', '协议一起投影（PHL 会走 /v1/messages）');
  assert.equal(stored().apiKey, 'sk-fake-2', '默认那条的 Key 投影给运行路径（存在主进程里）');
  // 本地专有字段一个都不能丢
  assert.equal(saved.workspace, '/w');
  assert.deepEqual(saved.workspaces, ['/w']);
  assert.equal(saved.localModel, 'qwen3.5:2b');
  assert.equal(saved.localEndpoint, 'http://127.0.0.1:11434');
  assert.equal(saved.provider, 'api');

  // 切默认项 → 运行字段跟着换（这是"多服务商"真正生效的地方）
  const switched = store.updateAi({ default_index: 0 });
  assert.equal(switched.apiEndpoint, 'https://api.deepseek.com/v1');
  assert.equal(switched.apiModel, 'deepseek-chat');
  assert.equal(switched.apiProtocol, 'openai');
  assert.equal(stored().apiKey, 'sk-fake-1', '换默认项 → 运行用的 Key 也跟着换');
  assert.equal(switched.workspace, '/w', '切默认项不许动工作区');

  // 渲染进程拿到的副本：没有明文 Key，但知道"哪个有 Key"
  const rendered = store.forRenderer().settings.ai;
  assert.equal(rendered.apiKey, '', 'API Key 绝不回传渲染进程');
  assert.equal(rendered.apiKeySaved, true);
  assert.equal(rendered.providers.length, 2);
  for (const row of rendered.providers) {
    assert.equal(Object.hasOwn(row, 'api_key'), false, '服务商列表也不带明文 Key');
    assert.equal(row.api_key_saved, true);
  }
});

test('界面上留空的 API Key 保留旧值，只删该删的那条', () => {
  const store = memoryStore({ enabled: true, provider: 'api' });
  store.updateAi({
    enabled: true,
    provider: 'api',
    providers: [
      { name: 'A', protocol: 'openai', base_url: 'https://a/v1', model: 'ma', api_key: 'sk-fake-a' },
      { name: 'B', protocol: 'openai', base_url: 'https://b/v1', model: 'mb', api_key: 'sk-fake-b' },
    ],
    default_index: 0,
  });
  const after = store.updateAi({
    providers: [
      { name: 'A', protocol: 'openai', base_url: 'https://a/v1', model: 'ma2', api_key: '' },
      { name: 'B', protocol: 'openai', base_url: 'https://b/v1', model: 'mb', api_key: '', clear_api_key: true },
    ],
    default_index: 0,
  });
  const keys = store.data.settings.ai.providers.map((row) => row.api_key);
  assert.deepEqual(keys, ['sk-fake-a', ''], '留空 = 保留旧 Key；clear_api_key 才真的删');
  assert.equal(after.providers[0].model, 'ma2', '其它字段照改');
  assert.equal(store.data.settings.ai.apiKey, 'sk-fake-a', '投影用的是默认那条的 Key');

  // 缺 Base URL / 没有服务商 / 缺模型 → 明确报错，不许默默存一份用不了的配置
  assert.throws(() => store.updateAi({ provider: 'api', providers: [], default_index: 0 }), /至少一个服务商/);
  assert.throws(() => store.updateAi({
    provider: 'api',
    providers: [{ name: 'X', protocol: 'openai', base_url: '', model: 'm', api_key: 'k' }],
    default_index: 0,
  }), /Base URL/);
  assert.throws(() => store.updateAi({
    provider: 'api',
    providers: [{ name: 'X', protocol: 'openai', base_url: 'https://x/v1', model: '', api_key: 'k' }],
    default_index: 0,
  }), /模型名称/);
});

// ---------------------------------------------------------------- 3. updated_by / updated_at
test('真改配置时盖 updated_at / updated_by，只是读取或切换时不乱盖', () => {
  const store = memoryStore({ enabled: true, provider: 'api' });
  const first = store.updateAi({
    enabled: true,
    provider: 'api',
    providers: [{ name: 'A', protocol: 'openai', base_url: 'https://a/v1', model: 'ma', api_key: 'sk-fake-a' }],
    default_index: 0,
  });
  assert.equal(first.updated_by, 'phl', 'PHL 写的就署名 phl');
  assert.match(first.updated_at, /^\d{4}-\d{2}-\d{2}T/);

  // 只改工作区（不碰服务商）不许把署名/时间戳改掉
  const workspaceOnly = store.updateAi({ workspace: '/tmp/x' });
  assert.equal(workspaceOnly.updated_by, 'phl');
  assert.equal(workspaceOnly.updated_at, first.updated_at, '没动服务商就不该刷新时间戳');

  // 云端(网页端)写进来的时间戳/署名要原样保留，供合并判断
  const cloud = aiConfig.mergeAiProviders({ ...first, providers: first.providers }, {
    providers: first.providers,
    default_index: first.default_index,
    updated_at: '2030-01-01T00:00:00+08:00',
    updated_by: 'web',
  }, {});
  assert.equal(cloud.updated_and_kept_placeholder, undefined);
  assert.equal(cloud.updated_at, '2030-01-01T00:00:00+08:00');
  assert.equal(cloud.updated_by, 'web');

  const written = store.updateAi({ providers: [
    { name: 'A', protocol: 'openai', base_url: 'https://a/v1', model: 'ma3', api_key: '' },
  ], default_index: 0 });
  assert.equal(written.updated_by, 'phl');
});

// ---------------------------------------------------------------- 4. 与同步对象的一致性
test('同步载荷是规范形态：只带 providers/default_index/updated_at/updated_by', () => {
  const ai = {
    enabled: true, provider: 'api',
    apiEndpoint: 'https://api.deepseek.com/v1', apiModel: 'deepseek-chat', apiKey: 'sk-fake-1',
    localModel: 'qwen3.5:2b', workspace: '/w', workspaces: ['/w'],
    permissionMode: 'chat', launcherControlEnabled: false,
    controlConsentVersion: 1, controlConsentAcceptedAt: '2026-01-01T00:00:00.000Z',
    mailReadEnabled: false, mailConsentVersion: 0, mailConsentAcceptedAt: '',
    providers: [{ name: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', api_key: 'sk-fake-1' }],
    default_index: 0,
  };
  const payload = cloudsync.aiSyncPayload(ai);
  // 元信息**两个键必须同时存在**：只写一个会让"第一轮少一个键、第二轮才出现"，
  // 两轮载荷哈希不同 → 每轮空推一份配置（跨端同步收敛的前提）。
  assert.deepEqual(Object.keys(payload).sort(),
    ['default_index', 'providers', 'updated_at', 'updated_by']);
  assert.equal(payload.updated_by, 'phl', '本机从没记过署名 → 按本机自己写的记 phl');
  assert.deepEqual(payload.providers[0], {
    name: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat', api_key: 'sk-fake-1',
  });

  // 第二次读同一份配置：两个元信息字段都必须稳定（否则每轮同步都会空推一份）
  const again = cloudsync.aiSyncPayload({
    ...ai, updated_at: payload.updated_at, updated_by: payload.updated_by,
  });
  assert.equal(again.updated_at, payload.updated_at, '时间戳必须稳定');
  assert.equal(again.updated_by, payload.updated_by, '署名必须稳定');
  assert.equal(JSON.stringify(again), JSON.stringify(payload), '整份载荷逐字节一致');
});

test('同步往返：网页端写的规范形态落回本地时保留本地专有字段', () => {
  const local = {
    enabled: true, provider: 'api',
    apiEndpoint: 'https://api.deepseek.com/v1', apiModel: 'deepseek-chat', apiKey: 'sk-fake-1',
    apiProtocol: 'openai', localEndpoint: 'http://127.0.0.1:11434', localModel: 'qwen3.5:2b',
    workspace: '/w', workspaces: ['/w', '/old'],
    permissionMode: 'confirm', launcherControlEnabled: true,
    controlConsentVersion: 1, controlConsentAcceptedAt: '2026-01-01T00:00:00.000Z',
    mailReadEnabled: false, mailConsentVersion: 0, mailConsentAcceptedAt: '',
    providers: [{ name: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', api_key: 'sk-fake-1' }],
    default_index: 0,
    updated_at: '2026-02-01T00:00:00+08:00', updated_by: 'phl',
  };
  const fromWeb = {
    providers: [
      { name: 'DeepSeek', protocol: 'anthropic', base_url: 'https://api.deepseek.com/anthropic', model: 'deepseek-reasoner', api_key: 'sk-fake-web' },
      { name: '网页新增', protocol: 'openai', base_url: 'https://web.example.test/v1', model: 'web-model', api_key: 'sk-fake-web2' },
    ],
    default_index: 1,
    updated_at: '2030-03-01T00:00:00+08:00',
    updated_by: 'web',
  };

  const merged = cloudsync.mergeAiSection(local, fromWeb);
  assert.equal(merged.providers.length, 2, '网页端新增的服务商落到了本地');
  assert.equal(merged.default_index, 1);
  assert.equal(merged.apiEndpoint, 'https://web.example.test/v1');
  assert.equal(merged.apiProtocol, 'openai');
  assert.equal(merged.apiKey, 'sk-fake-web2');
  assert.equal(merged.updated_at, '2030-03-01T00:00:00+08:00');
  // 本机这边的改动都输给了更新的远端 → 署名沿用远端那份（别抢"网页端改的"这个功）
  assert.equal(merged.updated_by, 'web', '纯采纳远端时不抢署名');
  for (const key of ['workspace', 'workspaces', 'localEndpoint', 'localModel', 'permissionMode',
    'launcherControlEnabled', 'controlConsentVersion', 'controlConsentAcceptedAt']) {
    assert.deepEqual(merged[key], local[key], `${key} 不许被同步覆盖/丢掉`);
  }

  // 远端时间戳更老（或没有时间信息）→ 不许覆盖本地那条，也不做删除推断：
  // 本地独有的服务商保留，不会被静默删掉。
  const base = (row) => ({ providers: [row], default_index: 0 });
  const remoteRow = { name: 'DeepSeek', protocol: 'openai', base_url: 'https://old.example.test/v1', model: 'old', api_key: 'sk-fake-old' };
  const stale = cloudsync.mergeAiSection(
    { ...local, updated_at: '2000-01-01T00:00:00+08:00' },
    { ...base(remoteRow), updated_at: '1999-01-01T00:00:00+08:00', updated_by: 'phl' },
  );
  assert.equal(stale.providers.find((row) => row.name === 'DeepSeek').base_url,
    'https://api.deepseek.com/v1', '更老的远端不许改本地那条');

  // 本地独有的服务商（没有基版时）绝不能被静默删掉
  const withLocalOnly = cloudsync.mergeAiSection(
    {
      ...local,
      updated_at: '2000-01-01T00:00:00+08:00',
      providers: [...local.providers, { name: '本机独有', protocol: 'openai', base_url: 'https://mine/v1', model: 'mm', api_key: 'sk-fake-mine' }],
    },
    { providers: [remoteRow], default_index: 0, updated_at: '1999-01-01T00:00:00+08:00', updated_by: 'phl' },
  );
  assert.ok(withLocalOnly.providers.some((row) => row.name === '本机独有'), '本地独有的服务商不许被静默删掉');

  // 反过来：远端确实更新 → 采信远端那份（用户在网页端刚改完，应该生效）
  const fresher = cloudsync.mergeAiSection(
    { ...local, updated_at: '1999-01-01T00:00:00+08:00' },
    { ...base(remoteRow), updated_at: '2020-01-01T00:00:00+08:00', updated_by: 'web' },
  );
  assert.equal(fresher.providers.find((row) => row.name === 'DeepSeek').base_url,
    'https://old.example.test/v1', '更新的远端要生效');
  assert.equal(fresher.updated_by, 'web');

  // 远端还是老扁平形态 → 只取并集，不许清空本地
  const oldShape = cloudsync.mergeAiSection(local, { provider: 'api', apiModel: 'old-model', apiKey: 'sk-fake-old' });
  assert.ok(oldShape.providers.length >= 1, '老形态的远端不许清掉本地配置');

  // 本机完全没配过 → 纯拉远端：内容与署名都应该是远端那份
  const fresh = cloudsync.mergeAiSection({ enabled: true, provider: 'api', workspace: '/keep' }, fromWeb);
  assert.equal(fresh.providers.length, 2);
  assert.equal(fresh.updated_by, 'web', '纯拉远端不许抢署名');
  assert.equal(fresh.updated_at, '2030-03-01T00:00:00+08:00');
  assert.equal(fresh.apiEndpoint, 'https://web.example.test/v1');
  assert.equal(fresh.workspace, '/keep', '本机的工作区照样保留');
});

test('SyncEngine 的 collect/apply 走的是规范形态（真引擎，临时目录）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-launcher-ai-sync-'));
  fs.writeFileSync(path.join(root, 'settings.yaml'), [
    'version: 1',
    'ai:',
    '  enabled: true',
    '  provider: api',
    '  apiEndpoint: https://api.deepseek.com/v1',
    '  apiModel: deepseek-chat',
    '  apiKey: sk-fake-local',
    '  workspace: /w',
    '  localModel: qwen3.5:2b',
    '  providers:',
    '    - name: DeepSeek',
    '      protocol: openai',
    '      base_url: https://api.deepseek.com/v1',
    '      model: deepseek-chat',
    '      api_key: sk-fake-local',
    '  default_index: 0',
    '',
  ].join('\n'), 'utf8');

  const engine = new cloudsync.SyncEngine(null, Buffer.alloc(32), 1, 'tester', { root, dataDir: root, objects: ['settings.ai'] });
  const collected = engine.collect('settings.ai');
  // 元信息两个键必须都在（只写一个会让两轮载荷不同 → 空推），别的字段一概不上云
  assert.deepEqual(Object.keys(collected.ai).sort(),
    ['default_index', 'providers', 'updated_at', 'updated_by']);
  assert.equal(collected.ai.providers[0].api_key, 'sk-fake-local');
  assert.equal(collected.ai.workspace, undefined, '本地专有字段不上云');

  engine.apply('settings.ai', {
    ai: cloudsync.mergeAiPayload(null, collected.ai, {
      providers: [{ name: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-reasoner', api_key: 'sk-fake-web' }],
      default_index: 0,
      updated_at: '2030-03-01T00:00:00+08:00',
      updated_by: 'web',
    }, []),
  });
  const after = cloudsync.readSettingsSection(path.join(root, 'settings.yaml'), 'ai');
  assert.equal(after.providers[0].model, 'deepseek-reasoner', '云端改的模型落回本地');
  assert.equal(after.apiModel, 'deepseek-reasoner', '运行路径跟着变');
  assert.equal(after.workspace, '/w', 'workspace 保留');
  assert.equal(after.localModel, 'qwen3.5:2b', '本地模型设置保留');
  assert.equal(after.updated_by, 'web');
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 5. 渲染层
function rendererHarness(ai) {
  const { window } = parseHTML(PAGE_SOURCE);
  window.ph = { ai: { configure: async () => ({}) } };
  const context = {
    window, document: window.document, console, URL, Date, Intl,
    crypto: { randomUUID: () => 'test-id' },
    setTimeout: (callback) => { callback(); return 0; },
    clearTimeout: () => {}, setInterval: () => 0,
  };
  vm.runInNewContext(`${APP_SOURCE}
this.__aiConfigUi = {
  state, renderAiConfig, readAiProvidersFromPanel, blankAiProvider,
  // #aiConfigPanel 的点击监听在真实运行里由 DOMContentLoaded → init() → bindEvents()
  // 装上；这里直接调同一个处理逻辑，避免依赖 linkedom 的事件派发时序。
  panelClick: (target) => handleAiConfigPanelClick({ target }),
};`, context);
  const runtime = context.__aiConfigUi;
  runtime.state.data = { settings: { ai: { ...ai, providers: (ai.providers || []).map((row) => ({ ...row })) } }, tasks: [], schedule: [], focusSessions: [], customSites: [] };
  // 真实路径是点击派发：`#aiConfigPanel` 上的监听函数在第一个 await 之前全是同步的，
  // 所以派发完就能立刻断言 DOM（与 ai-navigation 等既有测试同一套做法）。
  return {
    window,
    runtime,
    click: (selector) => {
      const node = window.document.querySelector(selector);
      assert.ok(node, `missing ${selector}`);
      runtime.panelClick(node);
    },
  };
}

test('AI 设置面板渲染出多服务商列表（字段名与网页端一致）', () => {
  const ui = rendererHarness({
    enabled: true,
    provider: 'api',
    default_index: 1,
    providers: [
      { name: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', api_key_saved: true },
      { name: '备用', protocol: 'anthropic', base_url: 'https://api.moonshot.cn/v1', model: 'kimi-k2', api_key_saved: false },
    ],
    updated_at: '2030-03-01T00:00:00+08:00',
    updated_by: 'web',
  });
  ui.runtime.renderAiConfig();
  const panel = ui.window.document.querySelector('#aiConfigPanel');
  const cards = panel.querySelectorAll('.ai-provider-card');
  assert.equal(cards.length, 2, '两个服务商各一张卡');
  for (const field of ['name', 'protocol', 'base_url', 'model', 'api_key']) {
    assert.equal(panel.querySelectorAll(`[data-provider-field="${field}"]`).length, 2, `每张卡都有 ${field}`);
  }
  assert.equal(panel.querySelectorAll('input[name="aiDefaultProvider"]:checked').length, 1, '只能选一个默认');
  assert.equal(panel.querySelector('input[name="aiDefaultProvider"]:checked').value, '1');
  assert.match(panel.textContent, /网页端/, '告诉用户配置是随账号同步的');
  assert.match(panel.textContent, /web/, '显示上次是谁改的');
  assert.match(panel.textContent, /API Key/, '界面说明密钥也在同步范围内（不静默上传）');
  assert.equal(panel.querySelector('[data-provider-field="api_key"]').value, '', 'Key 永不回显');
  assert.match(panel.querySelector('[data-provider-field="api_key"]').getAttribute('placeholder'), /已保存/);
  assert.ok(panel.querySelector('#addApiProvider'), '有添加按钮');
  assert.equal(panel.querySelectorAll('[data-remove-provider]').length, 2, '每张卡都能删');
  assert.match(panel.querySelector('#saveApiAi').textContent, /同步到账号/, '保存按钮如实说明会同步');
});

test('添加 / 删除服务商时先读回界面上已填的内容（不丢编辑）', () => {
  const ui = rendererHarness({
    enabled: true,
    provider: 'api',
    default_index: 0,
    providers: [{ name: 'A', protocol: 'openai', base_url: 'https://a/v1', model: 'ma', api_key_saved: false }],
  });
  ui.runtime.renderAiConfig();
  const panel = ui.window.document.querySelector('#aiConfigPanel');
  // 模拟用户手填第二段内容（不改 state，只改 DOM，就像真实输入）
  panel.querySelector('[data-provider-field="name"]').value = '改过的名字';
  panel.querySelector('[data-provider-field="model"]').value = '改过的模型';
  ui.click('#addApiProvider');
  const afterAdd = ui.window.document.querySelectorAll('.ai-provider-card');
  assert.equal(afterAdd.length, 2, '加了一条');
  assert.equal(afterAdd[0].querySelector('[data-provider-field="name"]').value, '改过的名字', '手填的名字不许丢');
  assert.equal(afterAdd[0].querySelector('[data-provider-field="model"]').value, '改过的模型');

  // 删掉第一条 → 默认项跟着落到还剩下的那条
  ui.click('[data-remove-provider="0"]');
  const afterRemove = ui.window.document.querySelectorAll('.ai-provider-card');
  assert.equal(afterRemove.length, 1);
  assert.equal(ui.runtime.state.data.settings.ai.default_index, 0);
});

test('面板读回的服务商列表可以原样提交（留空 Key 不覆盖已保存的）', () => {
  const ui = rendererHarness({
    enabled: true,
    provider: 'api',
    default_index: 0,
    providers: [
      { name: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', api_key_saved: true },
    ],
  });
  ui.runtime.renderAiConfig();
  const submitted = ui.runtime.readAiProvidersFromPanel();
  assert.equal(submitted.providers.length, 1);
  assert.equal(submitted.providers[0].api_key, '', 'Key 不回显，留空 = 后端保留旧值');
  assert.equal(submitted.providers[0].model, 'deepseek-chat');
  assert.equal(submitted.providers[0].api_key_saved, true, '界面知道这个服务商已经存过 Key');
  assert.equal(submitted.default_index, 0);
});

// ---------------------------------------------------------------- 6. anthropic 协议
test('anthropic 协议：SSE 解析器认得 text_delta 与分片的 tool_use', async () => {
  const { anthropicSseStream, streamAnthropicChat } = require('../electron/ai-stream.cjs');
  const deltas = [];
  const parser = anthropicSseStream((text) => deltas.push(text));
  parser.push('event: message_start\ndata: {"type":"message_start"}\n\n');
  parser.push('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n');
  parser.push('event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"list_tasks"}}\n\n');
  parser.push('event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"status\\":\\"open\\"}"}}\n\n');
  parser.push('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  const result = parser.finish();
  assert.equal(result.content, '你好');
  assert.deepEqual(deltas, ['你好']);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].id, 'toolu_1');
  assert.equal(result.toolCalls[0].function.name, 'list_tasks');
  assert.equal(result.toolCalls[0].function.arguments, '{"status":"open"}');

  // 流式请求的**请求形状**（用假 fetch，绝不发真实请求、不碰任何真实凭据）
  let seen = null;
  let pumped = false;
  const response = {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          if (pumped) return { done: true };
          pumped = true;
          return {
            done: false,
            value: new TextEncoder().encode(
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n'),
          };
        },
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
  };
  const streamed = await streamAnthropicChat({
    fetchImpl: async (url, init) => { seen = { url: String(url), init }; return response; },
    url: new URL('https://api.moonshot.cn/v1/messages'),
    headers: { 'x-api-key': 'sk-fake-test', 'anthropic-version': '2023-06-01' },
    payload: { model: 'kimi-k2', max_tokens: 1024, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] },
    onDelta: () => {},
  });
  assert.equal(streamed.content, 'hi');
  assert.equal(seen.url, 'https://api.moonshot.cn/v1/messages');
  assert.equal(seen.init.headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.stream, true);
  assert.equal(body.model, 'kimi-k2');
});

test('main.cjs 里 anthropic 走的是 /v1/messages，且协议来自服务商配置', () => {
  assert.match(MAIN_SOURCE, /config\.apiProtocol \|\| ''/, '协议从投影字段读');
  assert.match(MAIN_SOURCE, /requestAnthropicTurn\(config, messages, tools, endpoint/, 'anthropic 有独立请求路径');
  assert.match(MAIN_SOURCE, /\/v1\/messages/, '端点拼 /v1/messages');
  assert.match(MAIN_SOURCE, /'x-api-key': config\.apiKey/, 'anthropic 用 x-api-key 头');
  assert.match(MAIN_SOURCE, /anthropic-version/, '必须带 anthropic-version');
  assert.match(MAIN_SOURCE, /input_schema/, '工具定义转成 input_schema');
  assert.match(MAIN_SOURCE, /tool_result/, '工具结果转成 tool_result 内容块');
});

// ---------------------------------------------------------------- 7. 密钥真正上云 / 双向对齐
/**
 * 用户的核心要求：**在任何一个产品里填了服务商与 Key，网页端和客户端都能用**。
 * 网页端没有本地存储，它只读同步对象 `settings.ai` 里的 `api_key` —— 所以 Key
 * 必须真的进那一份（服务端只存端到端密文），而且两个方向都要对齐：
 *   推：客户端保存 → 共用 settings.yaml 里有明文 key → 云同步推给账号
 *   拉：云同步把网页端的配置落进 settings.yaml → 收进内存 → 本机运行路径能用
 */
function keyBridgeFixture(ai) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-launcher-ai-key-'));
  const store = memoryStore(ai);
  const bridge = keyBridgeHarness(dir, store);
  const settingsPath = path.join(dir, 'settings.yaml');
  return {
    store,
    bridge,
    settingsPath,
    section: () => cloudsync.readSettingsSection(settingsPath, 'ai') || {},
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('① 客户端保存后，共用的 settings.yaml 里确实有 api_key（网页端才用得上）', () => {
  const fixture = keyBridgeFixture({ enabled: true, provider: 'api', localModel: 'qwen3.5:2b', workspace: '/w' });
  fixture.store.updateAi({
    enabled: true,
    provider: 'api',
    default_index: 0,
    providers: [{
      name: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat', api_key: 'sk-fake-phl-key',
    }],
  });
  fixture.bridge.writeAiProvidersToSharedSettings();   // 真实代码里由 updateAi 内部调用

  const section = fixture.section();
  assert.equal(section.providers.length, 1, '服务商写进了共用的那一份');
  assert.equal(section.providers[0].api_key, 'sk-fake-phl-key', '**api_key 必须真的在里面**');
  assert.equal(section.providers[0].base_url, 'https://api.deepseek.com/v1');
  assert.equal(section.providers[0].model, 'deepseek-chat');

  // 这一份就是云同步上云的载荷：钥匙必须出现在其中
  const payload = cloudsync.aiSyncPayload(section);
  assert.equal(payload.providers[0].api_key, 'sk-fake-phl-key', '同步载荷里带着 Key');
  assert.deepEqual(Object.keys(payload.providers[0]).sort(),
    ['api_key', 'base_url', 'model', 'name', 'protocol']);
  fixture.cleanup();
});

test('② 推的时候不覆盖文档里其它字段（工作区/PLL 的字段都要留住）', () => {
  const fixture = keyBridgeFixture({ enabled: true, provider: 'api' });
  const existing = [
    'version: 1',
    'ai:',
    '  enabled: true',
    '  active_model: kimi-k2',
    '  localModel: qwen3.5:2b',
    '  workspace: /w',
    '',
  ].join('\n');
  fs.writeFileSync(fixture.settingsPath, existing, 'utf8');
  fixture.store.data.settings.ai.providers = [{
    name: 'A', protocol: 'openai', base_url: 'https://a/v1', model: 'ma', api_key: 'sk-fake-a',
  }];
  fixture.bridge.writeAiProvidersToSharedSettings();
  const section = fixture.section();
  assert.equal(section.providers[0].api_key, 'sk-fake-a');
  assert.equal(section.workspace, '/w', '别的字段保留');
  assert.equal(section.active_model, 'kimi-k2', 'PLL/未知字段保留');
  assert.equal(section.updated_by, 'phl', '客户端改的就署 phl');
  assert.match(section.updated_at, /^\d{4}-\d{2}-\d{2}T/, '盖了时间戳');
  fixture.cleanup();
});

test('③ 网页端填的 Key（本地没有）→ 同步后本机能用', () => {
  const fixture = keyBridgeFixture({ enabled: true, provider: 'api', apiEndpoint: 'https://api.deepseek.com/v1' });
  // 模拟：云同步把网页端的配置合并写进了共享文件（本地 store 里没有 key）
  cloudsync.writeSettingsSection(fixture.settingsPath, 'ai', {
    providers: [{ name: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', api_key: 'sk-fake-from-web' }],
    default_index: 0,
    updated_at: '2030-03-01T00:00:00+08:00',
    updated_by: 'web',
  });
  assert.equal(fixture.store.data.settings.ai.providers.length, 0, '前提：本地还没有 provider');

  assert.equal(fixture.bridge.adoptAiProvidersFromSharedSettings(), true, '确实收下了新配置');
  const adopted = fixture.store.data.settings.ai;
  assert.equal(adopted.providers[0].api_key, 'sk-fake-from-web', '网页端的 Key 收到了本机');
  assert.equal(adopted.apiEndpoint, 'https://api.deepseek.com/v1', '运行路径（默认服务商）跟着更新');
  assert.equal(adopted.apiKey, 'sk-fake-from-web', '运行用的扁平 Key 字段也更新了');
  assert.equal(adopted.provider, 'api', '本地专有字段不动');

  // 再收一次不应该有任何变化（否则每轮同步都白写一次，永远收敛不了）
  assert.equal(fixture.bridge.adoptAiProvidersFromSharedSettings(), false, '幂等：没变化就不写');
  // 共享文件里的时间戳/署名不许被本机的回写抢走
  const section = fixture.section();
  assert.equal(section.updated_by, 'web', '不抢署名');
  assert.equal(section.updated_at, '2030-03-01T00:00:00+08:00', '不重盖时间戳');
  fixture.cleanup();
});

test('④ 本地已有 Key 时优先用本地的，网页端只补本地缺的那一条', () => {
  const fixture = keyBridgeFixture({
    enabled: true,
    provider: 'api',
    providers: [{ name: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', api_key: 'sk-fake-local' }],
    default_index: 0,
  });
  cloudsync.writeSettingsSection(fixture.settingsPath, 'ai', {
    providers: [
      { name: 'DeepSeek', protocol: 'anthropic', base_url: 'https://api.deepseek.com/anthropic', model: 'deepseek-reasoner', api_key: 'sk-fake-from-web' },
      { name: '网页新增', protocol: 'openai', base_url: 'https://web.example.test/v1', model: 'web-model', api_key: 'sk-fake-web2' },
    ],
    default_index: 0,
    updated_at: '2030-03-01T00:00:00+08:00',
    updated_by: 'web',
  });
  fixture.bridge.adoptAiProvidersFromSharedSettings();
  const rows = fixture.store.data.settings.ai.providers;
  const deepseek = rows.find((row) => row.name === 'DeepSeek');
  assert.equal(deepseek.api_key, 'sk-fake-local', '同名服务商：本机已填的 Key 优先');
  assert.equal(deepseek.base_url, 'https://api.deepseek.com/v1', '本机已有的字段不被覆盖');
  assert.equal(deepseek.model, 'deepseek-chat', '本机已有的模型不被覆盖');
  const added = rows.find((row) => row.name === '网页新增');
  assert.equal(added.api_key, 'sk-fake-web2', '本机没有的服务商整条收下');
  assert.equal(added.base_url, 'https://web.example.test/v1');
  fixture.cleanup();
});

test('④b 同名服务商在本机**缺**某个字段时，用云端那份补齐', () => {
  const fixture = keyBridgeFixture({
    enabled: true,
    provider: 'api',
    providers: [{ name: 'DeepSeek', protocol: 'openai', base_url: '', model: '', api_key: '' }],
    default_index: 0,
  });
  cloudsync.writeSettingsSection(fixture.settingsPath, 'ai', {
    providers: [{
      name: 'DeepSeek', protocol: 'anthropic', base_url: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-reasoner', api_key: 'sk-fake-from-web',
    }],
    default_index: 0,
    updated_at: '2030-03-01T00:00:00+08:00',
    updated_by: 'web',
  });
  fixture.bridge.adoptAiProvidersFromSharedSettings();
  const row = fixture.store.data.settings.ai.providers[0];
  assert.equal(row.base_url, 'https://api.deepseek.com/anthropic', '本机缺 base_url → 收下云端的');
  assert.equal(row.model, 'deepseek-reasoner', '本机缺 model → 收下云端的');
  assert.equal(row.api_key, 'sk-fake-from-web', '本机没有 Key → 收下云端的');
  assert.equal(row.protocol, 'anthropic', '云端明确写了 anthropic → 跟云端（openai 只是默认值，不是用户选的）');
  assert.equal(fixture.store.data.settings.ai.apiKey, 'sk-fake-from-web', '运行用的扁平 Key 也补上');
  fixture.cleanup();
});

test('⑤ 本地没配过 AI 时，推的方向不碰共享文件（别把云端那份清掉）', () => {
  const fixture = keyBridgeFixture({ enabled: false, provider: 'off' });
  const before = [
    'version: 1',
    'ai:',
    '  providers:',
    '    - name: DeepSeek',
    '      protocol: openai',
    '      base_url: https://api.deepseek.com/v1',
    '      model: deepseek-chat',
    '      api_key: sk-fake-from-web',
    '  default_index: 0',
    '',
  ].join('\n');
  fs.writeFileSync(fixture.settingsPath, before, 'utf8');
  fixture.bridge.writeAiProvidersToSharedSettings();
  assert.equal(fs.readFileSync(fixture.settingsPath, 'utf8'), before, '一个字节都不该动');
  fixture.cleanup();
});

test('⑥ 同步载荷永远不会丢掉 api_key 字段（哪怕是空串）', () => {
  for (const ai of [
    { providers: [{ name: 'A', protocol: 'openai', base_url: 'https://a/v1', model: 'm', api_key: 'sk-fake-a' }], default_index: 0 },
    { providers: [{ name: 'A', protocol: 'openai', base_url: 'https://a/v1', model: 'm' }], default_index: 0 },
    { provider: 'api', apiEndpoint: 'https://a/v1', apiModel: 'm', apiKey: 'sk-fake-legacy' },
  ]) {
    const payload = cloudsync.aiSyncPayload(ai);
    assert.equal(payload.providers.length, 1);
    assert.ok(Object.hasOwn(payload.providers[0], 'api_key'), '规范形态必须带 api_key 字段');
  }
  const legacy = cloudsync.aiSyncPayload({ provider: 'api', apiEndpoint: 'https://a/v1', apiModel: 'm', apiKey: 'sk-fake-legacy' });
  assert.equal(legacy.providers[0].api_key, 'sk-fake-legacy', '老扁平配置的 Key 也要带上云');
});

test('⑧ 端到端：客户端填 Key → 上云对象里有 → 网页端再加一条 → 本机能用 → 再保存不丢', () => {
  const fixture = keyBridgeFixture({ enabled: false, provider: 'off' });
  const write = () => fixture.bridge.writeAiProvidersToSharedSettings();
  const adopt = () => fixture.bridge.adoptAiProvidersFromSharedSettings();

  // 1) 客户端填好并保存
  fixture.store.updateAi({
    enabled: true, provider: 'api', default_index: 0,
    providers: [{ name: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', api_key: 'sk-fake-e2e' }],
  });
  write();
  // 上云的载荷就是这一份（含明文 key；服务端只存端到端密文）
  const engine = new cloudsync.SyncEngine(null, Buffer.alloc(32), 1, 'tester',
    { root: path.dirname(fixture.settingsPath), dataDir: path.dirname(fixture.settingsPath), objects: ['settings.ai'] });
  const pushed = engine.collect('settings.ai');
  assert.equal(pushed.ai.providers[0].api_key, 'sk-fake-e2e', '上云对象里必须有 key');

  // 2) 网页端加了第二个服务商并设为默认（云同步把它落进共享文件）
  cloudsync.writeSettingsSection(fixture.settingsPath, 'ai', {
    providers: [
      { name: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', api_key: 'sk-fake-e2e' },
      { name: '网页新增', protocol: 'anthropic', base_url: 'https://web.example.test/v1', model: 'web-model', api_key: 'sk-fake-web' },
    ],
    default_index: 1,
    updated_at: '2030-01-01T00:00:00+08:00',
    updated_by: 'web',
  });
  assert.equal(adopt(), true);
  assert.equal(fixture.store.data.settings.ai.apiKey, 'sk-fake-web', '网页端填的 Key 在本机运行路径上能用');
  assert.equal(fixture.store.data.settings.ai.apiProtocol, 'anthropic', '协议跟着网页端选的默认项');
  assert.equal(fixture.store.data.settings.ai.apiEndpoint, 'https://web.example.test/v1');

  // 3) 本机再保存一次（界面不回显 Key，只改了模型名）
  fixture.store.updateAi({
    enabled: true, provider: 'api', default_index: 1,
    providers: [
      { name: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', api_key: '' },
      { name: '网页新增', protocol: 'anthropic', base_url: 'https://web.example.test/v1', model: 'web-model-2', api_key: '' },
    ],
  });
  write();
  const rows = fixture.section().providers;
  assert.equal(rows.length, 2, '两条都在（不许把网页端那条挤掉）');
  assert.equal(rows.find((row) => row.name === '网页新增').api_key, 'sk-fake-web', '网页端的 Key 不许丢');
  assert.equal(rows.find((row) => row.name === 'DeepSeek').api_key, 'sk-fake-e2e', '本机的 Key 也不许丢');
  assert.equal(rows.find((row) => row.name === '网页新增').model, 'web-model-2', '本机这次改的字段生效了');

  // 4) 再收一次不该有任何变化（否则每轮同步都白写一次）
  assert.equal(adopt(), false, '幂等：没有变化就不写');
  fixture.cleanup();
});

test('⑨ 同一份配置连续 collect 三次逐字节一致（否则每轮同步都会空推）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-launcher-ai-conv-'));
  cloudsync.writeSettingsSection(path.join(root, 'settings.yaml'), 'ai', {
    enabled: true, provider: 'api', workspace: '/w',
    providers: [{ name: 'A', protocol: 'openai', base_url: 'https://a/v1', model: 'm', api_key: 'sk-fake' }],
    default_index: 0,
  });
  const engine = new cloudsync.SyncEngine(null, Buffer.alloc(32), 1, 'tester',
    { root, dataDir: root, objects: ['settings.ai'] });
  const first = engine.collect('settings.ai');
  const second = engine.collect('settings.ai');
  const third = engine.collect('settings.ai');
  assert.equal(JSON.stringify(second), JSON.stringify(first), '第二次必须完全一致');
  assert.equal(JSON.stringify(third), JSON.stringify(first), '第三次必须完全一致');
  assert.equal(cloudsync.hashDocument(second), cloudsync.hashDocument(first), '哈希必须稳定');
  // 而且**不许**在读取路径上偷偷写本地文件（dryRun/预览也不能落盘）
  const before = fs.readFileSync(path.join(root, 'settings.yaml'), 'utf8');
  engine.collect('settings.ai');
  assert.equal(fs.readFileSync(path.join(root, 'settings.yaml'), 'utf8'), before, 'collect 是纯读');
  fs.rmSync(root, { recursive: true, force: true });
});

test('⑩ 渲染进程永远拿不到明文 Key，但界面知道"已保存"', () => {
  const store = memoryStore({ enabled: true, provider: 'api' });
  const rendered = store.updateAi({
    enabled: true,
    provider: 'api',
    providers: [{
      name: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat', api_key: 'sk-fake-never-leak',
    }],
  });
  assert.equal(rendered.apiKey, '', '扁平 Key 不回传');
  assert.equal(rendered.apiKeySaved, true);
  assert.equal(Object.hasOwn(rendered.providers[0], 'api_key'), false, '服务商列表里没有明文 Key');
  assert.equal(rendered.providers[0].api_key_saved, true);
  assert.equal(JSON.stringify(rendered).includes('sk-fake-never-leak'), false, '整份载荷里搜不到明文');
  assert.equal(JSON.stringify(store.updateAi({ workspace: '/tmp/x' })).includes('sk-fake-never-leak'), false,
    '其它保存路径也不泄漏');
});

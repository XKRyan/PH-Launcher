'use strict';
// phix 首启引导的**行为**测试：把真的 `src/index.html` + 真的 `src/app.js` 装进
// linkedom，点真的按钮，看真的 DOM 变没变。
//
// 为什么要有这一份：`phix-onboarding.test.cjs` 只做 `assert.match(APP_SOURCE, /phixObHave/)`
// 这类**字符串**断言 —— 源码里字写得再对，只要渲染时抛异常（比如调了一个不存在的
// 函数 `esc()`），对用户来说就是"点了没反应"，而字符串断言照样全绿。
// 2026-09-17 用户实测踩到的正是这个：点「有，去登录」毫无反应（ReferenceError），
// 只能退出引导去设置里登录。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');

const noop = () => {};
const asyncNoop = async () => ({ ok: true, data: {} });

/** 起一个"足够真"的界面：真 HTML、真 app.js，只有 window.ph 是假的。 */
function harness({ phix = {} } = {}) {
  const { window, document } = parseHTML(HTML);
  // linkedom 不实现 <dialog>.showModal/close：补最小实现（我们的断言不依赖渲染）。
  for (const dialog of document.querySelectorAll('dialog')) {
    if (typeof dialog.showModal !== 'function') dialog.showModal = function showModal() { this.setAttribute('open', ''); };
    if (typeof dialog.close !== 'function') dialog.close = function close() { this.removeAttribute('open'); };
  }

  const log = { login: [], register: [], ping: [], sync: 0 };
  const base = {
    system: { version: async () => '1.0.7', showData: asyncNoop, platform: 'win32' },
    data: { get: async () => ({ settings: { language: 'zh', onboardingCompleted: false, ai: {}, customSites: [] }, meta: { platform: 'win32' }, notes: [], tasks: [], schedule: [], focusSessions: [], ib: null }), onChanged: noop },
    ai: { deploymentState: async () => ({ stage: 'idle' }), onDeployment: noop, onStatus: noop, onStream: noop, onToolEvent: noop },
    ib: { commandCatalog: async () => [] },
    credentials: { status: async () => ({ supported: true, issue: '', sites: {} }), onChanged: noop },
    sites: { onState: noop, action: asyncNoop },
    shortcuts: { register: async () => ({}), onAction: noop, onResults: noop },
    mail: { onCleared: noop, onUnreadChange: noop },
    school: { sync: asyncNoop, onChanged: noop },
    phix: {
      status: async () => ({ ok: true, data: { logged_in: false, server: '', username: '' } }),
      restore: async () => ({ ok: true, data: { logged_in: false } }),
      ping: async (server) => { log.ping.push(server || ''); return { ok: true, data: { server: server || 'http://resolved.example', version: 1 } }; },
      login: async (input) => { log.login.push(input); return phix.login ? phix.login(input) : { ok: true, data: { logged_in: true, unlocked: true } }; },
      register: async (input) => { log.register.push(input); return { ok: true, data: { logged_in: true, unlocked: true, recovery_code: 'ABCD-EFGH' } }; },
      sync: async () => { log.sync += 1; return { ok: true, data: {} }; },
      profile: async () => null,
      onChanged: noop,
    },
  };
  window.ph = new Proxy(base, {
    get: (target, key) => (key in target ? target[key] : new Proxy({}, { get: () => noop })),
  });
  window.i18n = { locale: () => 'zh', mount: noop, settings: noop, t: (key) => key };
  window.confirm = () => true;
  window.confirmAction = async () => true;
  window.CustomEvent = window.CustomEvent || class CustomEvent { constructor(type) { this.type = type; } };
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  window.localStorage = { getItem: () => null, setItem: noop };
  window.matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop });

  const context = {
    window, document, console, setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Date, Number, Object, Array, String, Math, RegExp, JSON, Map, Set,
    Boolean, Error, TypeError, URL, URLSearchParams, Intl, AbortController,
    CustomEvent: window.CustomEvent,
    MutationObserver: window.MutationObserver || class { observe() {} disconnect() {} },
    HTMLElement: window.HTMLElement, Event: window.Event, Node: window.Node,
    fetch: async () => ({ ok: false, status: 0, json: async () => ({}) }),
    navigator: window.navigator, location: window.location,
    localStorage: window.localStorage, requestAnimationFrame: window.requestAnimationFrame,
  };
  context.globalThis = context;
  vm.runInNewContext(`${APP}\n;globalThis.__expose = { state, bindEvents, openPhixOnboarding, renderPhixOnboarding, resolvePhixServer };`, context, { filename: 'app.js' });
  const exposed = context.__expose;
  // 真应用里这一步在 init() 里做（DOMContentLoaded 之后）；这里显式调一次，
  // 因为我们要测的就是"委托绑上之后，点按钮有没有反应"。
  exposed.bindEvents();

  const click = (node) => {
    assert.ok(node, 'expected a clickable node');
    node.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const text = (id) => document.getElementById(id)?.textContent || '';
  return { window, document, log, click, settle, text, ...exposed };
}

test('引导第 0 步：点「有，去登录」会真的走到登录页（不再是点了没反应）', () => {
  const app = harness();
  app.openPhixOnboarding(0);
  assert.ok(app.document.getElementById('phixObHave'), '第 0 步要有「有，去登录」');
  app.click(app.document.getElementById('phixObHave'));
  assert.equal(app.state.phixOnboardingStep, 1, '点了之后步骤要推进到登录');
  const box = app.document.getElementById('phixObLoginBox');
  assert.ok(box, '必须渲染出登录框（渲染过程中抛异常就会是 null）');
  // 输入框的提示文字在 placeholder 里（textContent 看不到），所以查 innerHTML。
  assert.match(box.innerHTML, /placeholder="账号"/);
  assert.match(box.innerHTML, /placeholder="密码"/);
});

test('登录页**只问账号和密码**：没有服务器地址输入框、没有模式口令输入框', () => {
  const app = harness();
  app.openPhixOnboarding(1);
  assert.ok(app.document.getElementById('phixObUsername'), '要有账号');
  assert.ok(app.document.getElementById('phixObPassword'), '要有密码');
  assert.equal(app.document.getElementById('phixObServer'), null, '不该有服务器地址输入框');
  assert.equal(app.document.getElementById('phixObRegServer'), null, '注册页也不该有');
  // 同步口令那一行存在但**默认藏着**：只有强模式账号才露出来。
  const row = app.document.getElementById('phixObPassphraseRow');
  assert.ok(row, '口令行要在 DOM 里（需要时露出来）');
  assert.equal(row.hasAttribute('hidden'), true, '默认必须藏着');
  assert.ok(app.document.getElementById('phixObDoLogin'), '要有登录按钮');
});

test('引导第 0 步：点「没有，注册一个」会走到注册页', () => {
  const app = harness();
  app.openPhixOnboarding(0);
  app.click(app.document.getElementById('phixObRegister'));
  assert.equal(app.state.phixOnboardingStep, 2);
  assert.ok(app.document.getElementById('phixObRegUsername'), '注册页要渲染出来');
  assert.ok(app.document.getElementById('phixObRegPassword'));
});

test('登录：服务器地址是自动得出的（先探测），界面不问用户', async () => {
  const app = harness();
  app.openPhixOnboarding(1);
  app.document.getElementById('phixObUsername').value = 'someone';
  app.document.getElementById('phixObPassword').value = 'pw-123456';
  app.click(app.document.getElementById('phixObDoLogin'));
  await app.settle();
  assert.equal(app.log.login.length, 1, '应该发出一次登录');
  assert.equal(app.log.login[0].username, 'someone');
  assert.equal(app.log.login[0].password, 'pw-123456');
  assert.ok(app.log.login[0].server, '登录必须带一个服务器地址（自动解析出来的）');
  assert.equal(app.log.login[0].sync_passphrase, '', '登录时不再问同步口令');
  assert.equal(app.log.sync, 1, '登录成功后要拉一次同步');
  assert.equal(app.document.getElementById('phixOnboardingDialog').hasAttribute('open'), false, '登录成功 → 关掉引导进下一步');
});

test('登录：账号或密码没填就地提示，不发请求', async () => {
  const app = harness();
  app.openPhixOnboarding(1);
  app.document.getElementById('phixObUsername').value = 'someone';
  app.click(app.document.getElementById('phixObDoLogin'));
  await app.settle();
  assert.equal(app.log.login.length, 0);
  assert.match(app.text('phixObError'), /账号和密码/);
});

test('登录期间有"正在登录并同步…"提示（不会让人以为卡住了）', async () => {
  let release;
  const app = harness({ phix: { login: () => new Promise((resolve) => { release = resolve; }) } });
  app.openPhixOnboarding(1);
  app.document.getElementById('phixObUsername').value = 'someone';
  app.document.getElementById('phixObPassword').value = 'pw-123456';
  app.click(app.document.getElementById('phixObDoLogin'));
  await app.settle();
  assert.match(app.text('phixObError'), /正在登录/, '请求还没回来时要有提示');
  assert.equal(app.document.getElementById('phixObDoLogin').hasAttribute('disabled'), true, '按钮要禁用（防连点）');
  release({ ok: true, data: { logged_in: true, unlocked: true } });
  await app.settle();
});

test('强模式账号：密码对了但数据锁着 → 露出口令行并要求解锁，而不是当成登录失败', async () => {
  const app = harness({ phix: { login: () => ({ ok: true, data: { logged_in: true, unlocked: false, key_mode: 'syncphrase' } }) } });
  app.openPhixOnboarding(1);
  app.document.getElementById('phixObUsername').value = 'someone';
  app.document.getElementById('phixObPassword').value = 'pw-123456';
  app.click(app.document.getElementById('phixObDoLogin'));
  await app.settle();
  const row = app.document.getElementById('phixObPassphraseRow');
  assert.equal(row.hasAttribute('hidden'), false, '这时才把口令行露出来');
  assert.match(app.text('phixObError'), /独立同步口令/);
  assert.ok(app.document.getElementById('phixObUsePassphrase'), '要有"用口令登录"按钮');
});

test('用口令登录：带上口令再发一次，成功后进下一步', async () => {
  let called = 0;
  const app = harness({
    phix: {
      login: (input) => {
        called += 1;
        if (!input.sync_passphrase) return { ok: true, data: { logged_in: true, unlocked: false } };
        return { ok: true, data: { logged_in: true, unlocked: true } };
      },
    },
  });
  app.openPhixOnboarding(1);
  app.document.getElementById('phixObUsername').value = 'someone';
  app.document.getElementById('phixObPassword').value = 'pw-123456';
  app.click(app.document.getElementById('phixObDoLogin'));
  await app.settle();
  app.document.getElementById('phixObSyncphrase').value = 'my-sync-phrase';
  app.click(app.document.getElementById('phixObUsePassphrase'));
  await app.settle();
  assert.equal(called, 2);
  assert.equal(app.log.login[1].sync_passphrase, 'my-sync-phrase');
  assert.equal(app.document.getElementById('phixOnboardingDialog').hasAttribute('open'), false);
});

test('登录失败：把主进程给的中文原因原样显示，引导留着不关', async () => {
  const app = harness({ phix: { login: () => ({ ok: false, error: '账号或密码不对', code: 'bad_credentials' }) } });
  app.openPhixOnboarding(1);
  app.document.getElementById('phixObUsername').value = 'someone';
  app.document.getElementById('phixObPassword').value = 'pw-123456';
  app.click(app.document.getElementById('phixObDoLogin'));
  await app.settle();
  assert.match(app.text('phixObError'), /账号或密码不对/);
  assert.equal(app.document.getElementById('phixOnboardingDialog').hasAttribute('open'), true);
  assert.equal(app.document.getElementById('phixObDoLogin').hasAttribute('disabled'), false, '失败后按钮要能再点');
});

test('引导里不再出现服务器地址这回事（界面文案层面也核一遍）', () => {
  const app = harness();
  app.openPhixOnboarding(1);
  const html = app.document.getElementById('phixOnboardingContent').innerHTML;
  assert.equal(/服务器地址|Server address/.test(html), false, '登录页不该提服务器地址');
  assert.equal(/192\.168\.5\.41/.test(html), false, '更不该把内网地址写死在界面上');
});

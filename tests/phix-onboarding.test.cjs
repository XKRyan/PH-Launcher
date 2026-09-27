'use strict';
// phix 首启引导（onboarding）、profile 读写、头像压缩。
//
// 首启引导分四条分支：
//   1. 盘上有令牌（restore 命中）→ 跳过整个 phix 引导
//   2. 无令牌 + 有账号 → 登录 → 同步 → 进原有引导
//   3. 无令牌 + 无账号 → 注册 → 同步 → 进原有引导
//   4. 无令牌 + 跳过 → 直接进原有引导
//
// profile 是普通同步对象，本地映射到 `data/Profile` JSON 文件。
// 头像压缩走 Canvas（测试里没有真实 Canvas，只测辅助函数）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const cs = require('../electron/cloudsync.cjs');
const session = require('../electron/phix-session.cjs');
const phixCrypto = require('../electron/phix-crypto.cjs');

// ---------------------------------------------------------------- helpers
function makeRoot(settings = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phix-onboard-'));
  if (settings) fs.writeFileSync(path.join(root, 'settings.yaml'), settings, 'utf8');
  return root;
}

const SETTINGS_FIXTURE = [
  'version: 1',
  'phix:',
  '  server: http://127.0.0.1:8931',
  '  username: someone',
  '  user_id: 12',
  '',
].join('\n');

// ---------------------------------------------------------------- 首启引导分支
test('restore 命中（盘上有令牌）→ 返回 logged_in，跳过引导', async () => {
  const root = makeRoot(SETTINGS_FIXTURE);
  session.configure({ dataDir: root });
  // 写入一个假令牌到 secrets_extra
  session.saveTokens({ access_token: 'fake-jwt.abc.def', refresh_token: 'refresh-xyz' });
  const api = new session.PhixSession();
  // restore 需要 server + 至少一个令牌
  const result = await api.restore('http://127.0.0.1:8931', 'someone');
  // restore 不会真正解 DEK（DEK 只在内存），但会返回 status（含 logged_in）
  assert.ok(result, 'restore 返回 status 对象');
  assert.equal(result.logged_in, true, '有令牌时 logged_in 为 true');
  // 引导层看到 logged_in=true → 跳过 phix 引导
});

test('restore 没命中（无令牌）→ 返回 null，引导层应弹引导', async () => {
  const root = makeRoot();  // 空配置
  session.configure({ dataDir: root });
  const api = new session.PhixSession();
  const result = await api.restore();
  assert.equal(result, null, '没有令牌时 restore 返回 null');
});

test('有账号 → 登录分支：通过假服务端走完整登录流程', async () => {
  const root = makeRoot();
  session.configure({ dataDir: root });
  const user = 'newuser';
  const password = 'Test-Pass-1';
  const dek = Buffer.alloc(32, 7);
  const material = phixCrypto.materialFromDek(dek, user, password);

  // 起一个假服务端
  const http = require('node:http');
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = request.url.includes('/ping')
        ? { ok: true, version: 1, enc: 0 }
        : request.url.includes('/auth/keymaterial')
          ? { ok: true, kdf_algo: material.kdf_algo, auth_salt: material.auth_salt }
          : {
            ok: true, user_id: 1, username: user, token: 'tok',
            access_token: 'access-jwt', refresh_token: 'refresh-jwt',
            kdf_algo: material.kdf_algo, kdf_salt: material.kdf_salt,
            key_wrap: material.key_wrap, key_check: material.key_check,
            key_mode: 'password', recovery_salt: material.recovery_salt,
          };
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const api = new session.PhixSession();
    const status = await api.login(`http://127.0.0.1:${port}`, user, password);
    assert.equal(status.logged_in, true, '登录成功后 logged_in=true');
    assert.ok(api.dek, '登录成功后 DEK 已解出');
    assert.equal(api.username, user);
    // 检查令牌已落盘
    const stored = session.storedTokens();
    assert.ok(stored.access, 'access_token 已落盘');
    assert.ok(stored.refresh, 'refresh_token 已落盘');
    // 模拟引导层行为：登录成功 → 同步 → 进原有引导
    // （同步需要解锁的 DEK + 客户端，这里只验证状态可以推进）
    assert.equal(api.status().logged_in, true);
  } finally {
    server.close();
  }
});

test('无账号 + 跳过 → 直接进原有引导', () => {
  // 这个分支纯前端逻辑：用户点了"跳过"按钮
  // 在 app.js 里 `closePhixOnboarding()` + `proceedToOriginalOnboarding()` 被调用
  // 这里验证的是 cloudsync 不受影响
  const root = makeRoot(SETTINGS_FIXTURE);
  session.configure({ dataDir: root });
  const config = session.loadConfig();
  assert.equal(config.server, 'http://127.0.0.1:8931');
  // 跳过不影响任何本地数据
});

test('无账号 → 注册分支：通过假服务端走完整注册流程', async () => {
  const root = makeRoot();
  session.configure({ dataDir: root });
  const user = 'reguser';
  const password = 'Reg-Pass-1';
  const dek = Buffer.alloc(32, 8);
  const material = phixCrypto.newMaterial(user, password);

  const http = require('node:http');
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = request.url.includes('/ping')
        ? { ok: true, version: 1, enc: 0 }
        : {
          ok: true, user_id: 2, username: user, token: 'reg-tok',
          access_token: 'reg-access', refresh_token: 'reg-refresh',
          kdf_algo: material.kdf_algo, kdf_salt: material.kdf_salt,
          key_wrap: material.key_wrap, key_check: material.key_check,
          key_mode: 'password', recovery_salt: material.recovery_salt,
        };
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const api = new session.PhixSession();
    const result = await api.register(`http://127.0.0.1:${port}`, user, password);
    assert.equal(result.logged_in, true, '注册后 logged_in=true');
    assert.ok(api.dek, '注册后 DEK 已解出');
    assert.ok(result.recovery_code, '注册后有恢复码');
    assert.equal(api.username, user);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------- profile 读写
test('profile 对象的 collect / apply 往返：写入后能读回来', () => {
  const root = makeRoot();
  const engine = new cs.SyncEngine(
    { server: 'http://fake', authToken: () => '', manifest: async () => ({ objects: [] }) },
    Buffer.alloc(32, 9), 7, 'tester', { dataDir: root, device: 'test' });

  // collect 初始为 null
  assert.equal(engine.collect('profile'), null);

  // apply 写入
  const profile = { display_name: '测试用户', avatar: 'data:image/png;base64,abc', updated_at: '2026-09-13T10:00:00+08:00' };
  engine.apply('profile', profile);

  // collect 读回来
  const loaded = engine.collect('profile');
  assert.ok(loaded, 'profile 文件已写入');
  assert.equal(loaded.display_name, '测试用户');
  assert.equal(loaded.avatar, 'data:image/png;base64,abc');
  assert.equal(loaded.updated_at, '2026-09-13T10:00:00+08:00');
});

test('profile 三方合并：取 updated_at 较新的那份', () => {
  const root = makeRoot();
  const engine = new cs.SyncEngine(
    { server: 'http://fake', authToken: () => '', manifest: async () => ({ objects: [] }) },
    Buffer.alloc(32, 9), 7, 'tester', { dataDir: root, device: 'test' });

  const base = { display_name: '旧名', updated_at: '2026-01-01T00:00:00+08:00' };
  const local = { display_name: '本地名', updated_at: '2026-06-01T00:00:00+08:00' };
  const remote = { display_name: '远端名', updated_at: '2026-09-01T00:00:00+08:00' };
  const [merged] = engine.merge('profile', base, local, remote);
  assert.equal(merged.display_name, '远端名', '远端更新 → 取远端');
  assert.equal(merged.updated_at, '2026-09-01T00:00:00+08:00');
});

test('mood 对象的 collect / apply 往返：写入后能读回来', () => {
  const root = makeRoot();
  const engine = new cs.SyncEngine(
    { server: 'http://fake', authToken: () => '', manifest: async () => ({ objects: [] }) },
    Buffer.alloc(32, 9), 7, 'tester', { dataDir: root, device: 'test' });

  const mood = { entries: [{ id: 'm1', ts: '2026-09-13T10:00:00+08:00', text: '开心', intensity: 8 }] };
  engine.apply('mood', mood);

  const loaded = engine.collect('mood');
  assert.ok(loaded, 'mood 文件已写入');
  assert.equal(loaded.entries.length, 1);
  assert.equal(loaded.entries[0].text, '开心');
});

// ---------------------------------------------------------------- 头像压缩函数
test('compressAvatar 辅助函数（Canvas 逻辑的纯函数部分）：裁剪与缩放参数', () => {
  // compressAvatar 在 app.js 里依赖真实 Canvas；这里测试其核心逻辑
  // 用一个简化版本验证"等比缩放居中裁剪"的数学
  function computeCrop(srcWidth, srcHeight, targetSize) {
    const minDim = Math.min(srcWidth, srcHeight);
    const sx = (srcWidth - minDim) / 2;
    const sy = (srcHeight - minDim) / 2;
    return { sx, sy, sw: minDim, sh: minDim, dw: targetSize, dh: targetSize };
  }

  // 正方形 → 无裁剪
  const square = computeCrop(512, 512, 256);
  assert.equal(square.sx, 0);
  assert.equal(square.sy, 0);
  assert.equal(square.sw, 512);

  // 横图 → 左右裁
  const wide = computeCrop(1024, 512, 256);
  assert.equal(wide.sx, 256);
  assert.equal(wide.sy, 0);
  assert.equal(wide.sw, 512);

  // 竖图 → 上下裁
  const tall = computeCrop(512, 1024, 256);
  assert.equal(tall.sx, 0);
  assert.equal(tall.sy, 256);
  assert.equal(tall.sh, 512);
});

// ---------------------------------------------------------------- DEFAULT_OBJECTS 包含 profile
test('DEFAULT_OBJECTS 包含 profile（默认勾选）', () => {
  assert.ok(cs.DEFAULT_OBJECTS.includes('profile'), 'cloudsync DEFAULT_OBJECTS 含 profile');
  // mood 不在 DEFAULT_OBJECTS 里（不默认勾选）
  assert.ok(!cs.DEFAULT_OBJECTS.includes('mood'), 'mood 不在 DEFAULT_OBJECTS 里');
});

// ---------------------------------------------------------------- 首启引导前端逻辑（DOM 层）
// 注意：这一组只做**源码字符串**断言，属于最弱的防线；真正"点了有没有反应"
// 由 `phix-onboarding-ui.test.cjs` 用真 DOM 驱动（那边能抓到渲染时抛异常这类问题）。
test('phix 首启引导对话框渲染：step 0 显示"有账号/没有账号"两个按钮', () => {
  const APP_SOURCE = fs.readFileSync(require.resolve('../src/app.js'), 'utf8');
  // 验证 renderPhixOnboarding 函数存在且包含关键 UI 元素
  assert.match(APP_SOURCE, /function renderPhixOnboarding/);
  assert.match(APP_SOURCE, /phixObHave/);
  assert.match(APP_SOURCE, /phixObRegister/);
  assert.match(APP_SOURCE, /phixObDoLogin/);
  assert.match(APP_SOURCE, /phixObDoRegister/);
  assert.match(APP_SOURCE, /phixObUsername/);
  // 验证跳过按钮
  assert.match(APP_SOURCE, /phixOnboardingSkip/);
  // 验证 restore 调用
  assert.match(APP_SOURCE, /tryPhixRestore/);
});

test('phix 引导登录页**不问服务器地址、不问模式口令**（用户明确要求）', () => {
  const APP_SOURCE = fs.readFileSync(require.resolve('../src/app.js'), 'utf8');
  // 曾经的 bug：这两个输入框既没必要，又因为调了不存在的 `esc()` 让整页渲染崩掉。
  assert.equal(/id="phixObServer"/.test(APP_SOURCE), false, '不该有服务器地址输入框');
  assert.equal(/id="phixObRegServer"/.test(APP_SOURCE), false, '注册页也不该有');
  // 口令行要在 DOM 里（强模式账号才露出来），但默认 hidden。
  assert.match(APP_SOURCE, /id="phixObPassphraseRow" hidden/);
  // 服务器地址改成自动解析（探测候选），界面不再写死内网地址。
  assert.match(APP_SOURCE, /async function resolvePhixServer/);
  assert.equal(/value="\$\{esc\(PHIX_DEFAULT_SERVER\)\}"/.test(APP_SOURCE), false,
    '不该把服务器地址预填进输入框');
});

test('app.js 里不再调用不存在的转义函数（那个 `esc is not defined` 让引导登录整个点不动）', () => {
  const APP_SOURCE = fs.readFileSync(require.resolve('../src/app.js'), 'utf8');
  // app.js 自己的转义函数叫 escapeHtml；`esc` 是 phix-ui.js 里的名字。
  assert.equal(/(?<![A-Za-z0-9_$.])esc\(/.test(APP_SOURCE), false,
    'app.js 里用 escapeHtml，不要出现裸的 esc(');
});

test('phix 默认服务器是公网入口，内网地址不进源码（隐私红线）', () => {
  const APP_SOURCE = fs.readFileSync(require.resolve('../src/app.js'), 'utf8');
  assert.match(APP_SOURCE, /PHIX_PUBLIC_SERVER.*https:\/\/phix\.ing\/api\/v1/);
  // 公开仓库里绝不能出现 RFC1918 内网地址（部署者用 PHIX_LAN_SERVER/.phix-local.json 指定）。
  assert.equal(/(?:^|[^.\d])(?:192\.168|10\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}(?!\d)/.test(APP_SOURCE), false,
    'app.js 不该硬编码内网 IP');
});

test('主进程服务器候选来自 phix-servers.cjs（内网地址不入库）', () => {
  const SRC = fs.readFileSync(require.resolve('../electron/phix-servers.cjs'), 'utf8');
  assert.match(SRC, /PUBLIC_DEFAULT = 'https:\/\/phix\.ing\/api\/v1'/);
  assert.match(SRC, /PHIX_LAN_SERVER/);
  assert.match(SRC, /\.phix-local\.json/);
  assert.equal(/(?:^|[^.\d])(?:192\.168|10\.\d{1,3}\.\d{1,3})\.\d{1,3}(?!\d)/.test(SRC), false,
    'phix-servers.cjs 不该硬编码内网 IP');
  const MAIN = fs.readFileSync(require.resolve('../electron/main.cjs'), 'utf8');
  assert.match(MAIN, /require\('\.\/phix-servers\.cjs'\)/);
});

test('index.html 包含 phixOnboardingDialog', () => {
  const HTML = fs.readFileSync(require.resolve('../src/index.html'), 'utf8');
  assert.ok(HTML.includes('phixOnboardingDialog'), 'HTML 里有 phixOnboardingDialog');
  assert.ok(HTML.includes('phixOnboardingContent'), 'HTML 里有 phixOnboardingContent');
  assert.ok(HTML.includes('phixOnboardingSkip'), 'HTML 里有跳过按钮');
});

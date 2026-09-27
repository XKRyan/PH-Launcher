'use strict';
// phix 会话层（`electron/phix-session.cjs`）与设置页面板（`src/phix-ui.js`）。
//
// 会话层盯三件事：配置写在共用 `settings.yaml` 的 `phix:` 段里且不碰别的段、
// 令牌与 PLL 共用同一个键、**DEK 绝不落盘**。
// 界面层用 linkedom 起一个最小 DOM，检查未登录/已登录两种形态与各个按钮的接线。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const session = require('../electron/phix-session.cjs');
const cs = require('../electron/cloudsync.cjs');
const phixCrypto = require('../electron/phix-crypto.cjs');

const UI_SOURCE = fs.readFileSync(require.resolve('../src/phix-ui.js'), 'utf8');

const SETTINGS_FIXTURE = [
  '# Pinghe Launcher Lite 配置',
  'version: 1',
  'wizard_done: true',
  'accounts:',
  '  edupage:',
  '    username: someone@example.com',
  '    password: pw1',
  'lessons:',
  '- subject: TOK',
  '  teacher: Jiabin Xu',
  "  group: 'F'",
  'agent:',
  '  mode: confirm',
  'phix:',
  '  server: http://127.0.0.1:8931',
  '  username: someone',
  '  user_id: 12',
  '  device: 家里的台式机',
  '  key_mode: password',
  '  auto_sync: true',
  '  sync_interval_minutes: 10',
  '  objects: [schedule, timetable]',
  '  last_sync_at: 2026-09-12T11:00:00+08:00',
  'secrets_extra:',
  "  phix:token: token-from-pll",
  'future_section:',
  '  nested:',
  '    key: keep-me',
  '',
].join('\n');

function makeRoot(settings = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phix-session-'));
  if (settings) fs.writeFileSync(path.join(root, 'settings.yaml'), settings, 'utf8');
  return root;
}

// ---------------------------------------------------------------- 配置读写
test('读配置：从共用 settings.yaml 的 phix 段取值，缺项用默认值', () => {
  const root = makeRoot(SETTINGS_FIXTURE);
  session.configure({ dataDir: root });
  const config = session.loadConfig();
  assert.equal(config.server, 'http://127.0.0.1:8931');
  assert.equal(config.username, 'someone');
  assert.equal(config.user_id, 12);
  assert.equal(config.device, '家里的台式机');
  assert.deepEqual(config.objects, ['schedule', 'timetable']);
  assert.equal(config.last_sync_at, '2026-09-12T11:00:00+08:00');

  // 空目录 → 全默认，并且报错而不是猜一个目录
  const empty = makeRoot();
  session.configure({ dataDir: empty });
  const fallback = session.loadConfig();
  assert.equal(fallback.server, '');
  assert.deepEqual(fallback.objects, [...cs.DEFAULT_OBJECTS]);
  assert.equal(fallback.auto_sync, true);
  assert.equal(fallback.sync_interval_minutes, 10);
});

test('写配置：只动 phix 段，注释、别的段与未知字段一个都不丢', () => {
  const root = makeRoot(SETTINGS_FIXTURE);
  session.configure({ dataDir: root });
  session.saveConfig({ auto_sync: false, sync_interval_minutes: 30, objects: ['schedule'] });

  const text = fs.readFileSync(path.join(root, 'settings.yaml'), 'utf8');
  assert.ok(text.startsWith('# Pinghe Launcher Lite 配置\n'));
  assert.match(text, /future_section:\n {2}nested:\n {4}key: keep-me/);
  assert.match(text, /^accounts:\n {2}edupage:\n {4}username: someone@example\.com$/m);
  assert.match(text, /^lessons:\n- subject: TOK\n {2}teacher: Jiabin Xu\n {2}group: 'F'$/m, '顶格列表项必须原样留住');
  assert.match(text, /^agent:\n {2}mode: confirm$/m);
  assert.ok(text.includes('token-from-pll'), 'secrets_extra 段不许被抹掉');

  const config = session.loadConfig();
  assert.equal(config.auto_sync, false);
  assert.equal(config.sync_interval_minutes, 30);
  assert.deepEqual(config.objects, ['schedule']);

  // 反复写不会重复段落
  session.saveConfig({ auto_sync: true });
  const again = fs.readFileSync(path.join(root, 'settings.yaml'), 'utf8');
  assert.equal((again.match(/^phix:$/gm) || []).length, 1);
  assert.equal((again.match(/^accounts:$/gm) || []).length, 1);
  assert.equal((again.match(/^- subject:/gm) || []).length, 1);
});

test('令牌与 PLL 共用同一个键（secrets_extra["phix:token"]）', () => {
  const root = makeRoot(SETTINGS_FIXTURE);
  session.configure({ dataDir: root });
  assert.equal(session.storedToken(), 'token-from-pll', 'PLL 登录过，PHL 打开就是已配置');
  assert.equal(session.TOKEN_KEY, 'phix:token');
});

test('secrets_extra 里带冒号的键不会把 phix 段读歪', () => {
  // 回归：段头正则若写成宽松的 `phix\\s*:`，会命中缩进两层的 `phix:token:`，
  // 于是读出来的"phix 段"只有一把令牌，真正的 phix 段被跳过。
  const root = makeRoot(SETTINGS_FIXTURE);
  session.configure({ dataDir: root });
  const config = session.loadConfig();
  assert.equal(config.server, 'http://127.0.0.1:8931');
  assert.equal(config.username, 'someone');
  assert.equal(config.user_id, 12);
  assert.equal(config.last_sync_at, '2026-09-12T11:00:00+08:00');
  assert.equal(config.objects.length, 2);

  // 写完一圈之后再读，server / username 仍然在（登录后不该"掉配置"）
  session.saveConfig({ last_sync_at: '2026-09-12T12:00:00+08:00' });
  const again = session.loadConfig();
  assert.equal(again.server, 'http://127.0.0.1:8931');
  assert.equal(again.username, 'someone');
  assert.equal(again.last_sync_at, '2026-09-12T12:00:00+08:00');
  assert.equal(session.storedToken(), 'token-from-pll', '令牌不能被写丢');
  const text = fs.readFileSync(path.join(root, 'settings.yaml'), 'utf8');
  assert.equal((text.match(/^phix:$/gm) || []).length, 1);
  assert.match(text, /^secrets_extra:\n {2}phix:token: token-from-pll$/m);
});

test('没有 settings.yaml 时也能写：新文件里带上 phix 段', () => {
  const root = makeRoot();
  session.configure({ dataDir: root });
  session.saveConfig({ server: 'http://127.0.0.1:8931', username: 'someone' });
  const text = fs.readFileSync(path.join(root, 'settings.yaml'), 'utf8');
  assert.match(text, /^phix:\n/);
  assert.equal(session.loadConfig().username, 'someone');
});

test('PLL 写出来的选课格式（libyaml 默认风格）照样读得对', () => {
  // PLL 用 yaml.safe_dump 落盘：`lessons:` 换行后紧跟顶格 `- subject: …`，
  // 值不加引号。段解析必须跟上这种写法，否则一读就是空选课。
  const root = makeRoot([
    'version: 1',
    'lessons:',
    '- subject: Computer Science HL',
    '  teacher: Anqi Wang',
    '  group: P',
    '- subject: TOK',
    '  teacher: Jiabin Xu',
    '  group: F',
    'ui:',
    '  course_order: []',
    '',
  ].join('\n'));
  session.configure({ dataDir: root });
  const engine = new cs.SyncEngine({ server: 'http://x' }, Buffer.alloc(32, 1), 1, 'u', { dataDir: root });
  assert.equal(engine.collect('settings.lessons').lessons.length, 2);
  assert.deepEqual(engine.collect('settings.lessons').lessons[0],
    { subject: 'Computer Science HL', teacher: 'Anqi Wang', group: 'P' });
  assert.deepEqual(engine.collect('settings.ui').ui, { course_order: [] });
});

test('normalizeServer 容错：补协议、去尾斜杠、剥 /api/v1', () => {
  assert.equal(session.normalizeServer('127.0.0.1:8931'), 'http://127.0.0.1:8931');
  assert.equal(session.normalizeServer('http://127.0.0.1:8931/'), 'http://127.0.0.1:8931');
  assert.equal(session.normalizeServer('http://127.0.0.1:8931/api/v1'), 'http://127.0.0.1:8931');
  assert.equal(session.normalizeServer('https://phix.example.com/api/v1/'), 'https://phix.example.com');
  assert.throws(() => session.normalizeServer('   '), /服务器地址/);
});

// ---------------------------------------------------------------- 会话状态
test('未登录时的状态：configured 跟着配置走，logged_in/unlocked 都是假', () => {
  const root = makeRoot(SETTINGS_FIXTURE);
  session.configure({ dataDir: root });
  const api = new session.PhixSession();
  const status = api.status();
  assert.equal(status.configured, true, '配置里有 server + username');
  assert.equal(status.logged_in, false);
  assert.equal(status.unlocked, false);
  assert.equal(status.has_token, true, 'PLL 留下的令牌也算已配置');
  assert.equal(status.server, 'http://127.0.0.1:8931');
  assert.equal(status.username, 'someone');
  assert.equal(status.device, '家里的台式机');
  assert.equal(status.recovery_code, '');
  assert.deepEqual(status.state.objects, {}, '还没有同步过就没有对象记录');
});

test('DEK 只放内存：会话对象上没有任何写盘的密钥字段', () => {
  const root = makeRoot(SETTINGS_FIXTURE);
  session.configure({ dataDir: root });
  const api = new session.PhixSession();
  assert.equal(api.dek, null);
  const status = api.status();
  assert.equal(JSON.stringify(status).includes('dek'), false, '状态里不许出现 DEK');
  assert.equal(Object.keys(status).some((key) => /dek|kek|key_wrap/i.test(key)), false);
});

test('未解锁就同步：明确报"锁着"，而不是偷偷用空密钥', async () => {
  const root = makeRoot(SETTINGS_FIXTURE);
  session.configure({ dataDir: root });
  const api = new session.PhixSession();
  await assert.rejects(() => api.sync(), (error) => {
    assert.equal(error.code, 'not_logged_in');
    return true;
  });
  api.client = { token: 'x', server: 'http://x' };
  api.dek = null;
  await assert.rejects(() => api.sync(), (error) => {
    assert.equal(error.code, 'locked');
    assert.match(error.message, /同步口令/);
    return true;
  });
});

test('未登录时 devices / unlock 报错而不是崩', async () => {
  const root = makeRoot(SETTINGS_FIXTURE);
  session.configure({ dataDir: root });
  const api = new session.PhixSession();
  await assert.rejects(() => api.devices(), (error) => error.code === 'not_logged_in');
  await assert.rejects(() => api.unlock('phrase'), (error) => error.code === 'not_logged_in');
});

test('口令不对时给出带 code 的中文错误（不是裸的密码学异常）', async () => {
  const root = makeRoot(SETTINGS_FIXTURE);
  session.configure({ dataDir: root });
  const api = new session.PhixSession();
  // 造一份"解不开"的密钥材料：kdf_salt 与 key_wrap 不配套
  const material = require('../electron/phix-crypto.cjs').newMaterial('someone', 'right-phrase');
  api.client = {
    token: 'x',
    server: 'http://x',
    me: async () => ({
      username: 'someone', key_wrap: material.key_wrap, kdf_salt: '00'.repeat(16),
      key_check: material.key_check, kdf_algo: material.kdf_algo, key_mode: 'syncphrase',
    }),
  };
  await assert.rejects(() => api.unlock('right-phrase'), (error) => {
    assert.equal(error.code, 'bad_passphrase', '必须带 code，界面才好判');
    assert.equal(error.message, '同步口令不对');
    assert.equal(error.name, 'PhixError');
    return true;
  });
  // 解不开时不许把 DEK 留在内存里
  assert.equal(api.dek, null);
});

test('登录时密码不对同样归一成 bad_passphrase', async () => {
  const root = makeRoot(SETTINGS_FIXTURE);
  session.configure({ dataDir: root });
  const material = require('../electron/phix-crypto.cjs').newMaterial('someone', 'right-phrase');
  // 起一个只回"用别的密码包裹"的材料的假服务端：走**真实 HTTP 路径**，
  // 只换服务端行为（客户端现在用 node:http，不是 fetch，所以不能顶 fetch）。
  const server = http.createServer((request, response) => {
    request.on('data', () => {});
    request.on('end', () => {
      // /ping 报"不支持加密"，让客户端退回明文，测试就不必掺和信封
      const payload = request.url.includes('/ping')
        ? { ok: true, version: 1, enc: 0 }
        : {
          ok: true, user_id: 1, username: 'someone', token: 'tok',
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
    await assert.rejects(
      () => api.login(`http://127.0.0.1:${port}`, 'someone', 'wrong-password'),
      (error) => {
        assert.equal(error.code, 'bad_passphrase');
        assert.match(error.message, /密码不对/);
        return true;
      },
    );
    assert.equal(api.dek, null, '解不开就不许留下 DEK');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------------- 应用层加密传输（客户端侧）
//
// 用**本地假服务端**跑真实 HTTP，覆盖：探测启用 / 公钥固定 / 换公钥拒绝 / 重新信任 /
// 服务端不支持或不可达时退回明文。不走真服务的完整攻击面测试在
// D:\phix\server\devtools\test_transport_e2e.cjs（41 项）。
async function withFakeServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('加密客户端：探测到 enc=1 就启用，并把公钥固定到 pinDir', async () => {
  const { pk } = phixCrypto.newX25519KeyPair();
  const seen = [];
  await withFakeServer((request, response) => {
    seen.push({ url: request.url, enc: request.headers['x-phix-enc'] });
    const payload = request.url.includes('/ping')
      ? { ok: true, version: 1, enc: 1, pk: phixCrypto.b64e(pk) }
      : { ok: true, echo: true };
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(payload));
  }, async (base) => {
    const pinDir = makeRoot();
    const client = new cs.PhixClient(base, null, 30000, { pinDir });
    assert.equal(client.e2e, true, '默认开启');
    assert.equal(client.encrypted, false, '还没探测');
    assert.equal(await client.ensureE2e(), true);
    assert.equal(client.encrypted, true);
    const pinFile = client.pinPath();
    assert.ok(fs.existsSync(pinFile), '公钥固定文件应写出来');
    assert.equal(fs.readFileSync(pinFile, 'utf8').trim(), pk.toString('hex'));
    assert.match(path.basename(pinFile), /^127\.0\.0\.1_\d+\.txt$/, 'host 里的冒号换成下划线');

    // 第二次：复用已记住的公钥，不该再打 /ping
    const before = seen.length;
    assert.equal(await client.ensureE2e(), true);
    assert.equal(seen.length, before, '不该重复探测');
  });
});

test('加密客户端：公钥变了要拒绝连接，重新信任之后能连', async () => {
  const first = phixCrypto.newX25519KeyPair();
  const second = phixCrypto.newX25519KeyPair();
  let current = first.pk;
  await withFakeServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true, version: 1, enc: 1, pk: phixCrypto.b64e(current) }));
  }, async (base) => {
    const pinDir = makeRoot();
    const c1 = new cs.PhixClient(base, null, 30000, { pinDir });
    assert.equal(await c1.ensureE2e(), true);
    assert.equal(fs.readFileSync(c1.pinPath(), 'utf8').trim(), first.pk.toString('hex'));

    // 服务器"换了钥匙"
    current = second.pk;
    const c2 = new cs.PhixClient(base, null, 30000, { pinDir });
    await assert.rejects(() => c2.ensureE2e(), (error) => {
      assert.equal(error.code, 'server_key_changed');
      assert.match(error.message, /公钥和本机记住的不一样/);
      return true;
    });
    assert.equal(c2.encrypted, false, '拒绝之后不能用加密');

    // 重新信任 → 能连，且固定文件换成新公钥
    c2.trustNewServerKey();
    assert.equal(await c2.ensureE2e(), true);
    assert.equal(fs.readFileSync(c2.pinPath(), 'utf8').trim(), second.pk.toString('hex'));
  });
});

test('加密客户端：服务端不支持 / 不可达 → 退回明文，绝不抛错', async () => {
  await withFakeServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true, version: 1, enc: 0 }));   // 老服务端
  }, async (base) => {
    const client = new cs.PhixClient(base, null, 30000, { pinDir: makeRoot() });
    assert.equal(await client.ensureE2e(), false, 'enc=0 就不启用');
    assert.equal(client.encrypted, false);
    assert.equal(client.e2e, false, '退回明文后不再反复探测');
  });

  // 端口上什么都没有
  const offline = new cs.PhixClient('http://127.0.0.1:1', null, 1500, { pinDir: makeRoot() });
  assert.equal(await offline.ensureE2e(), false);
  assert.equal(offline.encrypted, false);
  // 显式关掉时连探测都不做
  const disabled = new cs.PhixClient('http://127.0.0.1:1', null, 1500, { e2e: false, pinDir: makeRoot() });
  assert.equal(await disabled.ensureE2e(), false);
});

test('加密客户端：Enc=1 但公钥缺/长度不对 → 退回明文而不是崩', async () => {
  for (const pk of [undefined, '', 'AAAA']) {
    await withFakeServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true, version: 1, enc: 1, pk }));
    }, async (base) => {
      const client = new cs.PhixClient(base, null, 30000, { pinDir: makeRoot() });
      assert.equal(await client.ensureE2e(), false, `pk=${JSON.stringify(pk)} 不该启用`);
      assert.equal(client.encrypted, false);
    });
  }
});

test('session 把 pinDir 指到 .sync/pinned（与 PLL 同一位置）', () => {
  const root = makeRoot(SETTINGS_FIXTURE);
  session.configure({ dataDir: root });
  assert.equal(session.pinDir(), path.join(root, '.sync', 'pinned'));
  assert.equal(session.loadConfig().e2e, true, '默认开启加密传输');
  const client = session.makeClient('http://127.0.0.1:8931');
  assert.equal(client.e2e, true);
  assert.equal(client.pinPath(), path.join(root, '.sync', 'pinned', '127.0.0.1_8931.txt'));

  // 配置里关掉就跟着关
  session.saveConfig({ e2e: false });
  assert.equal(session.e2eEnabled(), false);
  assert.equal(session.makeClient('http://127.0.0.1:8931').e2e, false);
  session.saveConfig({ e2e: true });
  assert.equal(session.e2eEnabled(), true);
});

test('对象名不做百分号编码（AAD 必须与服务端的 request.path 一致）', () => {
  // 回归：曾经用 encodeURIComponent，`agent:x` 变成 `agent%3Ax`，
  // 客户端算 AAD 用 %3A、服务端用 `:`，结果"信封解密失败（内容被改过或路径不匹配）"。
  assert.equal(cs.PhixClient.objectRoute('agent:20260912-092518'), '/sync/objects/agent:20260912-092518');
  assert.equal(cs.PhixClient.objectRoute('schedule'), '/sync/objects/schedule');
  assert.equal(cs.PhixClient.objectRoute('settings.accounts'), '/sync/objects/settings.accounts');
  for (const bad of ['', 'a/b', 'a?b', 'a#b', 'a b', 'a\nb']) {
    assert.throws(() => cs.PhixClient.objectRoute(bad), /对象名不合法/, JSON.stringify(bad));
  }
});

test('syncphrase 模式下改登录密码：必须发 new_auth_hash 且绝不重包裹 key_wrap', async () => {
  // 复现踩过的坑：服务器存的是 **AuthHash**。syncphrase 模式下改登录密码时
  //   ① DEK 由独立同步口令包裹，key_wrap 一个字节都不能动；
  //   ② AuthHash 必须用**新登录口令**重算，否则用户再也登不进来。
  // 曾经这里漏了 ②，于是 new_password 被当成凭证存起来（服务器 set_password 存的是它），
  // 结果新旧口令全部 bad_credentials。
  const root = makeRoot(SETTINGS_FIXTURE);
  session.configure({ dataDir: root });
  const user = 'someone';
  const oldPw = 'Old-Login-1';
  const newPw = 'New-Login-2';
  const phrase = 'own-sync-phrase';
  const dek = Buffer.alloc(32, 42);
  const plain = phixCrypto.newKeyCheckPlain();
  const keyCheck = phixCrypto.makeKeyCheck(dek, user, plain);
  const material0 = phixCrypto.materialFromDek(dek, user, oldPw);
  const authSalt = material0.auth_salt;

  const calls = [];
  const api = new session.PhixSession();
  api.username = user;
  api.userId = 7;
  api.server = 'http://127.0.0.1:1';
  api.dek = dek;
  api.keyMode = 'syncphrase';
  api.keyCheck = keyCheck;
  api.client = {
    token: 'tok',
    server: api.server,
    me: async () => ({
      username: user, kdf_algo: phixCrypto.KDF_ALGO_V2, kdf_salt: material0.kdf_salt,
      auth_salt: authSalt, key_check: keyCheck, key_wrap: material0.key_wrap,
      key_mode: 'syncphrase',
    }),
    keymaterial: async () => ({ kdf_algo: phixCrypto.KDF_ALGO_V2, auth_salt: authSalt }),
    changePassword: async (oldPassword, newPassword, proof, material, options) => {
      calls.push({ oldPassword, newPassword, proof, material, options });
      return { ok: true };
    },
  };

  const status = await api.changePassword(oldPw, newPw);
  assert.equal(status.key_mode, 'syncphrase');
  assert.equal(calls.length, 1);
  const call = calls[0];

  // ① 凭证必须是 **AuthHash**，不是口令原文
  const newCredential = cs.PhixClient.credential(call.newPassword, { material: call.material, prefix: 'new_' });
  assert.deepEqual(Object.keys(newCredential), ['new_auth_hash'], '必须发 new_auth_hash');
  assert.equal(newCredential.new_auth_hash,
    phixCrypto.authHashHex(newPw, authSalt, phixCrypto.KDF_ALGO_V2), '用新登录口令算');
  const oldCredential = cs.PhixClient.credential(call.oldPassword,
    { authSalt: call.options.oldAuthSalt, algo: call.options.oldAlgo, prefix: 'old_' });
  assert.deepEqual(Object.keys(oldCredential), ['old_auth_hash'], '旧凭证也发 AuthHash');
  assert.equal(oldCredential.old_auth_hash,
    phixCrypto.authHashHex(oldPw, authSalt, phixCrypto.KDF_ALGO_V2));

  // ② 不许带 key_wrap / recovery_wrap（DEK 的包裹方式不能被动）
  assert.equal('key_wrap' in call.material, false, 'syncphrase 下不许重包裹');
  assert.equal('recovery_wrap' in call.material, false);
  assert.equal(call.material.auth_salt, authSalt, 'auth_salt 沿用旧的（永不改变）');
});

test('password 模式下改登录密码：仍要重包裹 key_wrap，且凭证也用 AuthHash', async () => {
  const root = makeRoot(SETTINGS_FIXTURE);
  session.configure({ dataDir: root });
  const user = 'someone';
  const oldPw = 'Old-Login-1';
  const newPw = 'New-Login-2';
  const dek = Buffer.alloc(32, 43);
  const plain = phixCrypto.newKeyCheckPlain();
  const keyCheck = phixCrypto.makeKeyCheck(dek, user, plain);
  const material0 = phixCrypto.materialFromDek(dek, user, oldPw);

  const calls = [];
  const api = new session.PhixSession();
  api.username = user;
  api.userId = 7;
  api.server = 'http://127.0.0.1:1';
  api.dek = dek;
  api.keyMode = 'password';
  api.keyCheck = keyCheck;
  api.client = {
    token: 'tok',
    server: api.server,
    me: async () => ({
      username: user, kdf_algo: phixCrypto.KDF_ALGO_V2, kdf_salt: material0.kdf_salt,
      auth_salt: material0.auth_salt, key_check: keyCheck, key_wrap: material0.key_wrap,
      key_mode: 'password',
    }),
    keymaterial: async () => ({ kdf_algo: phixCrypto.KDF_ALGO_V2, auth_salt: material0.auth_salt }),
    changePassword: async (o, n, proof, material, options) => {
      calls.push({ material, options });
      return { ok: true };
    },
  };

  await api.changePassword(oldPw, newPw);
  const { material } = calls[0];
  assert.ok(material.key_wrap, 'password 模式要带上新的 key_wrap');
  assert.equal(material.auth_salt, material0.auth_salt, 'auth_salt 沿用旧的');
  assert.equal(
    phixCrypto.unwrapDek(material.key_wrap, newPw, material.kdf_salt, user, material.kdf_algo).equals(dek),
    true, '新口令能解出新包裹的 DEK');
  assert.equal(
    cs.PhixClient.credential(newPw, { material, prefix: 'new_' }).new_auth_hash,
    phixCrypto.authHashHex(newPw, material0.auth_salt, phixCrypto.KDF_ALGO_V2));
});

test('切同步口令 / 切回：AuthHash 不变（登录口令没变），只有 key_wrap 换包裹', async () => {
  const root = makeRoot(SETTINGS_FIXTURE);
  session.configure({ dataDir: root });
  const user = 'someone';
  const loginPw = 'Login-Pw-1';
  const phrase = 'own-sync-phrase';
  const dek = Buffer.alloc(32, 44);
  const keyCheck = phixCrypto.makeKeyCheck(dek, user, phixCrypto.newKeyCheckPlain());
  const material0 = phixCrypto.materialFromDek(dek, user, loginPw);
  const expectedAuthHash = phixCrypto.authHashHex(loginPw, material0.auth_salt, phixCrypto.KDF_ALGO_V2);

  const calls = [];
  const makeApi = () => {
    const api = new session.PhixSession();
    api.username = user; api.userId = 7; api.server = 'http://127.0.0.1:1';
    api.dek = dek; api.keyCheck = keyCheck;
    api.client = {
      token: 'tok', server: api.server,
      me: async () => ({
        username: user, kdf_algo: phixCrypto.KDF_ALGO_V2, kdf_salt: material0.kdf_salt,
        auth_salt: material0.auth_salt, key_check: keyCheck, key_wrap: material0.key_wrap,
        key_mode: api.keyMode,
      }),
      keymaterial: async () => ({ kdf_algo: phixCrypto.KDF_ALGO_V2, auth_salt: material0.auth_salt }),
      rewrap: async (password, proof, material, options) => {
        calls.push({ password, material, options });
        return { ok: true };
      },
    };
    return api;
  };

  const toStrong = makeApi();
  await toStrong.setSyncPassphrase(loginPw, phrase);
  // 发出去的凭证必须是 AuthHash（服务器存的就是它），且用**登录口令 + 同一个 auth_salt** 算，
  // 所以切同步口令不会改变 AuthHash —— 这就是"切完还能用登录密码登进来"的根本原因。
  const strongCredential = cs.PhixClient.credential(calls[0].password, {
    authSalt: calls[0].options.authSalt, algo: calls[0].options.algo,
  });
  assert.deepEqual(Object.keys(strongCredential), ['auth_hash'], '切强模式也要发 AuthHash');
  assert.equal(strongCredential.auth_hash, expectedAuthHash, '切强模式不该改 AuthHash');
  assert.equal(calls[0].options.authSalt, material0.auth_salt, 'auth_salt 不变');
  assert.equal(calls[0].options.algo, phixCrypto.KDF_ALGO_V2);
  assert.equal(
    phixCrypto.unwrapDek(calls[0].material.key_wrap, phrase, calls[0].material.kdf_salt, user,
      calls[0].material.kdf_algo).equals(dek), true, '现在用同步口令包裹');

  calls.length = 0;
  const toSimple = makeApi();
  toSimple.keyMode = 'syncphrase';
  await toSimple.useLoginPassword(loginPw);
  const simpleCredential = cs.PhixClient.credential(calls[0].password, {
    authSalt: calls[0].options.authSalt, algo: calls[0].options.algo,
  });
  assert.equal(simpleCredential.auth_hash, expectedAuthHash, '切回也不改 AuthHash');
  assert.equal(
    phixCrypto.unwrapDek(calls[0].material.key_wrap, loginPw, calls[0].material.kdf_salt, user,
      calls[0].material.kdf_algo).equals(dek), true, '现在用登录口令包裹');
});

test('账号目录名：纯点串与空串都落到 default，含点但非纯点照常保留', () => {  const root = makeRoot(SETTINGS_FIXTURE);
  session.configure({ dataDir: root });
  const cases = [
    ['.', 'default'], ['..', 'default'], ['...', 'default'], ['', 'default'],
    [null, 'default'], [undefined, 'default'],
    ['a/b', 'a_b'], ['中文', '__'], ['a.b', 'a.b'], ['v1.2', 'v1.2'],
    [' '.repeat(3), '___'], ['x'.repeat(100), 'x'.repeat(60)],
  ];
  for (const [input, expected] of cases) {
    assert.equal(cs.safeAccountName(input), expected, `safeAccountName(${JSON.stringify(input)})`);
  }
  // 纯点串时目录必须仍在本账号目录之下，不能爬到上一级
  for (const name of ['.', '..', '...']) {
    const engine = new cs.SyncEngine({ server: 'http://x' }, Buffer.alloc(32, 1), 1, name, { dataDir: root });
    assert.equal(engine.accountDir, path.join(root, '.sync', 'accounts', 'default'));
    assert.equal(path.dirname(engine.accountDir), path.join(root, '.sync', 'accounts'));
  }
});

test('loadSnapshot 逐字节比对：状态里的 sha256 还在但对不上快照 → 不算基版', () => {
  const root = makeRoot('');
  const engine = new cs.SyncEngine({ server: 'http://x' }, Buffer.alloc(32, 1), 1, 'tester', { dataDir: root });
  // 正常记一次
  engine.saveState({ objects: {} });
  engine.saveSnapshot('schedule', { events: [{ id: 1 }] });
  engine.saveState({
    objects: { schedule: { revision: 3, sha256: cs.hashDocument({ events: [{ id: 1 }] }) } },
  });
  assert.deepEqual(engine.loadSnapshot('schedule'), { events: [{ id: 1 }] });

  // 快照被别的程序改写（状态里的 sha256 仍然在，但内容已经对不上）
  cs.writeJson(engine._snapshotPath('schedule'), { events: [{ id: 1 }, { id: 2 }] });
  const state = cs.readJson(engine.statePath, {});
  assert.ok(state.objects.schedule.sha256, '状态里的 sha256 还在');
  assert.equal(engine.loadSnapshot('schedule'), null, '对不上就返回 null → 走"没有基版"的并集语义');

  // 快照文件被删掉也一样
  fs.rmSync(engine._snapshotPath('schedule'), { force: true });
  assert.equal(engine.loadSnapshot('schedule'), null);
});

test('状态摘要读的是按账号的目录，老布局还能兜底', () => {
  const root = makeRoot(SETTINGS_FIXTURE);
  session.configure({ dataDir: root });
  const file = path.join(root, 'settings.yaml');

  // 新布局：.sync/accounts/<账号>/state.json
  const accountDir = path.join(root, '.sync', 'accounts', 'someone');
  fs.mkdirSync(accountDir, { recursive: true });
  cs.writeJson(path.join(accountDir, 'state.json'), {
    version: 1, kind: 'phix-sync-state', last_sync_at: '2026-09-12T10:00:00+08:00',
    objects: { schedule: { revision: 7 }, school: { revision: 3 } },
    conflicts: [{ object: 'settings.ui', note: '示例' }],
  });
  const api = new session.PhixSession();
  const summary = api.status().state;
  assert.equal(summary.last_sync_at, '2026-09-12T10:00:00+08:00');
  assert.deepEqual(summary.objects, { schedule: 7, school: 3 });
  assert.equal(summary.conflicts.length, 1);

  // 新位置没有时**就地迁移**老布局（与同步引擎同一段逻辑），界面与引擎看到的是同一份
  fs.rmSync(path.join(root, '.sync', 'accounts'), { recursive: true, force: true });
  fs.writeFileSync(path.join(root, '.sync', 'state.json'),
    `${JSON.stringify({ version: 1, kind: 'phix-sync-state', last_sync_at: '2026-09-11T09:00:00+08:00', username: 'someone', objects: { timetable: { revision: 2, sha256: 'old' } } }, null, 2)}\n`, 'utf8');
  const fallback = new session.PhixSession().status().state;
  assert.equal(fallback.last_sync_at, '2026-09-11T09:00:00+08:00');
  assert.deepEqual(fallback.objects, { timetable: 2 });
  assert.equal(fs.existsSync(path.join(root, '.sync', 'accounts', 'someone', 'state.json')), true, '顺手把老状态搬过去');
  assert.equal(fs.existsSync(path.join(root, '.sync', 'state.json')), true, '老文件仍在');
  void file;
});

test('没同步过时状态摘要不炸：空对象、空冲突', () => {
  const root = makeRoot(SETTINGS_FIXTURE);
  session.configure({ dataDir: root });
  const summary = new session.PhixSession().status().state;
  assert.deepEqual(summary.objects, {});
  assert.deepEqual(summary.conflicts, []);
  assert.equal(summary.last_sync_at, '');
});

test('摘要文案（与 PLL 的 _brief 同口径）', () => {
  assert.equal(session.summarize({ ok: true, pulled: ['a'], pushed: ['b'], conflicts: [], errors: [] }), '拉取 1 项，上传 1 项');
  assert.equal(session.summarize({ ok: true, pulled: [], pushed: [], conflicts: [], errors: [] }), '没有需要同步的变化');
  assert.match(session.summarize({ ok: false, skipped: '对方程序在运行' }), /对方程序在运行/);
  assert.match(session.summarize({ ok: true, conflicts: [{}, {}], errors: ['炸了'] }), /2 处冲突.*1 项出错/);
  assert.equal(session.brief(null), null);
});

// ---------------------------------------------------------------- 界面
function harness({ status, calls = {} } = {}) {
  const { window } = parseHTML('<!doctype html><html><body><div id="phixSettings"></div></body></html>');
  const log = { sync: [], login: [], register: [], unlock: [], saveSettings: [], ping: [], logout: 0, devices: 0, openDataDir: 0, trustKey: 0, changePassword: [], setPassphrase: [], revoke: [] };
  const defaultStatus = {
    configured: true, server: 'http://127.0.0.1:8931', username: 'someone', user_id: 12,
    logged_in: true, unlocked: true, key_mode: 'password', auto_sync: true,
    sync_interval_minutes: 10, last_sync_at: '2026-09-12T11:00:00+08:00', recovery_code: '',
    device: '家里的台式机', objects: ['schedule', 'settings.lessons', 'settings.ui', 'settings.accounts', 'timetable'],
    has_token: true, last_report: null, state: { last_sync_at: '', objects: {}, conflicts: [] },
  };
  window.ph = {
    phix: {
      status: async () => ({ ok: true, data: status ?? defaultStatus }),
      ping: async (server) => { log.ping.push(server); return { ok: true, data: { server: server || 'http://resolved.example', version: 1, server_time: '2026-09-12T11:00:00+08:00' } }; },
      login: async (input) => { log.login.push(input); return { ok: true, data: defaultStatus }; },
      register: async (input) => { log.register.push(input); return { ok: true, data: { ...defaultStatus, recovery_code: 'ABCD-EFGH' } }; },
      unlock: async (phrase) => { log.unlock.push(phrase); return { ok: true, data: defaultStatus }; },
      logout: async () => { log.logout += 1; return { ok: true, data: { ...defaultStatus, logged_in: false } }; },
      sync: async (input) => {
        log.sync.push(input || {});
        return { ok: true, data: { report: { ok: true, pulled: ['schedule'], pushed: [], conflicts: [], errors: [] }, summary: { ok: true, pulled: ['schedule'], pushed: [], conflicts: 0, errors: [] } } };
      },
      syncPreview: async () => ({ ok: true, data: {} }),
      conflicts: async () => ({ ok: true, data: { conflicts: [] } }),
      devices: async () => { log.devices += 1; return { ok: true, data: { devices: [{ device: '笔记本', last_used_at: '2026-09-11T10:00:00+08:00' }] } }; },
      // P3：界面改问 sessions（会话 = 一次登录 = 一台设备），老接口留着兼容
      sessions: async () => {
        log.devices += 1;
        return {
          ok: true,
          data: {
            sessions: [{ id: 4, device: '笔记本', current: false, last_seen_at: '2026-09-11T10:00:00+08:00' }],
            devices: [],
            access_ttl: 900, refresh_ttl: 2592000,
          },
        };
      },
      revokeSession: async (input) => { log.revoke.push(input); return { ok: true, data: { revoked: 1 } }; },
      saveSettings: async (input) => { log.saveSettings.push(input); return { ok: true, data: defaultStatus }; },
      setPassphrase: async (input) => { log.setPassphrase.push(input); return { ok: true, data: defaultStatus }; },
      useLoginPassword: async () => ({ ok: true, data: defaultStatus }),
      changePassword: async (input) => { log.changePassword.push(input); return { ok: true, data: defaultStatus }; },
      openDataDir: async () => { log.openDataDir += 1; return { ok: true, data: { path: 'D:\\data\\.sync' } }; },
      trustKey: async () => { log.trustKey += 1; return { ok: true, data: defaultStatus }; },
    },
    ...calls,
  };
  window.confirm = () => true;
  vm.runInNewContext(UI_SOURCE, {
    window, document: window.document, console, setTimeout, clearTimeout, Promise,
    Date, Number, Object, Array, String, Math, RegExp, JSON, Map, Set, Boolean, Error,
    CustomEvent: window.CustomEvent,
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { window, document: window.document, log, settle };
}

const click = (window, node) => {
  assert.ok(node, 'expected a clickable node');
  node.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
};

const textOf = (document) => document.getElementById('phixSettings').textContent;
/** 界面跑在另一个 vm 上下文里，对象原型与本文件不同，比较前先归一化。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

test('未登录时显示登录表单：只有账号与密码（不再问服务器地址/同步口令）', async () => {
  const { document, settle } = harness({ status: { configured: false, server: '', username: '', logged_in: false, unlocked: false, key_mode: 'password', auto_sync: true, sync_interval_minutes: 10, last_sync_at: '', recovery_code: '', device: '本机', objects: [], has_token: false, state: {} } });
  await settle();
  assert.ok(document.getElementById('phixUsername'), '要有账号');
  assert.ok(document.getElementById('phixPassword'), '要有密码');
  assert.equal(document.getElementById('phixServer'), null, '用户不该填服务器地址（界面自动解析）');
  assert.equal(document.getElementById('phixSyncphrase'), null, '登录页不问模式口令');
  assert.ok(document.getElementById('phixLogin'));
  assert.ok(document.getElementById('phixRegister'));
  assert.equal(document.getElementById('phixMainBox'), null, '未登录不显示已登录那一块');
  assert.match(textOf(document), /服务器只存密文/);
});

test('已登录时显示状态、同步按钮、自动同步与同步内容勾选', async () => {
  const { document, settle } = harness();
  await settle();
  assert.equal(document.getElementById('phixLoginBox'), null);
  assert.match(textOf(document), /someone/);
  assert.match(textOf(document), /家里的台式机/);
  assert.match(textOf(document), /登录密码/);
  assert.ok(document.getElementById('phixSync'));
  assert.ok(document.getElementById('phixPreview'));
  assert.ok(document.getElementById('phixLogout'));
  // linkedom 不实现 checked 属性，看 HTML 里的 checked 特性。
  assert.equal(document.getElementById('phixAuto').hasAttribute('checked'), true);
  assert.equal(document.getElementById('phixInterval').value, '10');
  const boxes = [...document.querySelectorAll('[data-phix-object]')];
  assert.equal(boxes.length, 9, '九个可选同步内容');
  assert.equal(boxes.filter((node) => node.hasAttribute('checked')).length, 5);
});

test('已登录但没解锁时提示输入同步口令', async () => {
  const { document, settle } = harness({ status: { configured: true, server: 'http://x', username: 'someone', logged_in: true, unlocked: false, key_mode: 'syncphrase', auto_sync: true, sync_interval_minutes: 10, last_sync_at: '', recovery_code: '', device: '本机', objects: [], has_token: true, state: {} } });
  await settle();
  assert.match(textOf(document), /未解锁/);
  const locked = document.getElementById('phixLocked');
  assert.equal(locked.hasAttribute('hidden'), false);
  assert.ok(document.getElementById('phixUnlockPass'));
  assert.match(textOf(document), /独立同步口令/);
});

test('注册：只要账号密码（服务器地址由界面解析）', async () => {
  const root = { configured: true, server: 'http://127.0.0.1:8931', username: '', logged_in: false, unlocked: false, key_mode: 'password', auto_sync: true, sync_interval_minutes: 10, last_sync_at: '', recovery_code: '', device: '本机', objects: [], has_token: false, state: {} };
  const { window, document, log, settle } = harness({ status: root });
  await settle();
  document.getElementById('phixUsername').value = 'someone';
  document.getElementById('phixPassword').value = 'secret123';
  click(window, document.getElementById('phixRegister'));
  await settle();
  await settle();
  assert.equal(log.register.length, 1);
  assert.equal(log.register[0].key_mode, 'password');
  assert.equal(log.register[0].password, 'secret123');
  assert.equal(log.register[0].server, 'http://127.0.0.1:8931', '服务器地址由界面解析后带上');
});

test('点"立即同步"发 dry_run:false，点"预览"发 dry_run:true', async () => {
  const { window, document, log, settle } = harness();
  await settle();
  click(window, document.getElementById('phixSync'));
  await settle();
  await settle();
  assert.equal(log.sync.length, 1);
  assert.equal(log.sync[0].dry_run, false);
  assert.match(textOf(document), /拉取 1 项/);

  click(window, document.getElementById('phixPreview'));
  await settle();
  await settle();
  assert.equal(log.sync.length, 2);
  assert.equal(log.sync[1].dry_run, true);
  assert.match(textOf(document), /预览/);
});

test('保存同步设置：把自动同步、间隔与勾选内容一起发出去', async () => {
  const { window, document, log, settle } = harness();
  await settle();
  document.getElementById('phixAuto').removeAttribute('checked');
  document.getElementById('phixInterval').value = '30';
  for (const node of document.querySelectorAll('[data-phix-object]')) {
    if (['schedule', 'timetable'].includes(node.dataset.phixObject)) node.setAttribute('checked', '');
    else node.removeAttribute('checked');
  }
  click(window, document.getElementById('phixSaveOptions'));
  await settle();
  await settle();
  assert.equal(log.saveSettings.length, 1);
  assert.deepEqual(plain(log.saveSettings[0]), { auto_sync: false, sync_interval_minutes: 30, objects: ['schedule', 'timetable'] });
});

test('一个同步内容都不勾时会拦下来，不发请求', async () => {
  const { window, document, log, settle } = harness();
  await settle();
  for (const node of document.querySelectorAll('[data-phix-object]')) node.removeAttribute('checked');
  click(window, document.getElementById('phixSaveOptions'));
  await settle();
  assert.equal(log.saveSettings.length, 0);
  assert.match(textOf(document), /至少要选一项/);
});

test('登录：**只要账号密码** —— 服务器地址与同步口令都不再问用户', async () => {
  const { window, document, log, settle } = harness({ status: { configured: false, server: 'http://127.0.0.1:8931', username: '', logged_in: false, unlocked: false, key_mode: 'password', auto_sync: true, sync_interval_minutes: 10, last_sync_at: '', recovery_code: '', device: '本机', objects: [], has_token: false, state: {} } });
  await settle();
  // 表单里没有这两个输入框了（用户要求）
  assert.equal(document.getElementById('phixServer'), null, '不该有服务器地址输入框');
  assert.equal(document.getElementById('phixSyncphrase'), null, '不该有同步口令输入框（登录页）');
  // 服务器地址改成"显示出来给用户看"的一行小字（自动解析的结果）
  assert.ok(document.getElementById('phixPassphraseRow'), '解锁行要在 DOM 里');
  assert.ok(document.getElementById('phixPassphraseRow').hasAttribute('hidden'), '默认藏着');

  click(window, document.getElementById('phixLogin'));
  await settle();
  assert.equal(log.login.length, 0, '空表单不发请求');
  assert.match(textOf(document), /账号和密码都要填/);

  document.getElementById('phixUsername').value = 'someone';
  document.getElementById('phixPassword').value = 'secret123';
  click(window, document.getElementById('phixLogin'));
  await settle();
  await settle();
  assert.equal(log.login.length, 1);
  assert.deepEqual(plain(log.login[0]), {
    server: 'http://127.0.0.1:8931', username: 'someone', password: 'secret123',
  }, '只发账号密码；服务器地址是界面自己解析出来的');
});

test('服务器地址由界面自己解析（配置里有就用它；没有就问主进程 ping）', async () => {
  // 配置里记着服务器 → 登录时直接用它（不再 ping）
  const remembered = harness({ status: { configured: true, server: 'http://remembered.example:8931', username: 'someone', logged_in: false, unlocked: false, key_mode: 'password', auto_sync: true, sync_interval_minutes: 10, last_sync_at: '', recovery_code: '', device: '本机', objects: [], has_token: false, state: {} } });
  await remembered.settle();
  remembered.document.getElementById('phixUsername').value = 'someone';
  remembered.document.getElementById('phixPassword').value = 'secret123';
  click(remembered.window, remembered.document.getElementById('phixLogin'));
  await remembered.settle();
  await remembered.settle();
  assert.equal(remembered.log.login.length, 1);
  assert.equal(remembered.log.login[0].server, 'http://remembered.example:8931');
  assert.deepEqual(remembered.log.ping, [], '记着地址就不用再探测');
  assert.match(textOf(remembered.document), /服务器：http:\/\/remembered\.example:8931/);

  // 没记着 → ping 一次，用主进程解析出来的地址
  const fresh = harness({ status: { configured: false, server: '', username: '', logged_in: false, unlocked: false, key_mode: 'password', auto_sync: true, sync_interval_minutes: 10, last_sync_at: '', recovery_code: '', device: '本机', objects: [], has_token: false, state: {} } });
  await fresh.settle();
  fresh.document.getElementById('phixUsername').value = 'someone';
  fresh.document.getElementById('phixPassword').value = 'secret123';
  click(fresh.window, fresh.document.getElementById('phixLogin'));
  await fresh.settle();
  await fresh.settle();
  assert.deepEqual(fresh.log.ping, [''], '登录前先问主进程该连哪台');
  assert.equal(fresh.log.login[0].server, 'http://resolved.example');
  assert.match(textOf(fresh.document), /自动探测/);
});

test('登录后数据还锁着（强模式）→ 露出口令行，解锁后继续同步', async () => {
  const root = { configured: true, server: 'http://127.0.0.1:8931', username: '', logged_in: false, unlocked: false, key_mode: 'password', auto_sync: true, sync_interval_minutes: 10, last_sync_at: '', recovery_code: '', device: '本机', objects: [], has_token: false, state: {} };
  const { window, document, log, settle } = harness({
    status: root,
    calls: {
      phix: {
        status: async () => ({ ok: true, data: root }),
        login: async (input) => { log.login.push(input); return { ok: true, data: { ...root, logged_in: true, unlocked: false, key_mode: 'syncphrase' } }; },
        unlock: async (phrase) => { log.unlock.push(phrase); return { ok: true, data: { ...root, logged_in: true, unlocked: true } }; },
        sync: async (input) => { log.sync.push(input || {}); return { ok: true, data: { summary: { pulled: [], pushed: [] } } }; },
      },
    },
  });
  await settle();
  document.getElementById('phixUsername').value = 'someone';
  document.getElementById('phixPassword').value = 'secret123';
  click(window, document.getElementById('phixLogin'));
  await settle();
  await settle();
  assert.equal(log.login.length, 1);
  const row = document.getElementById('phixPassphraseRow');
  assert.ok(row, '口令行要在 DOM 里');
  assert.equal(row.hasAttribute('hidden'), false,
    '这时才问口令；当前 DOM：' + document.getElementById('phixSettings').innerHTML.slice(0, 200));
  assert.match(textOf(document), /独立同步口令/);

  document.getElementById('phixLoginPassphrase').value = 'my-phrase';
  click(window, document.getElementById('phixUnlockNow'));
  await settle();
  await settle();
  assert.deepEqual(log.unlock, ['my-phrase']);
  assert.ok(log.sync.length >= 1, '解锁之后要接着同步');
});

test('主进程报错时把中文原因显示出来（不吞掉）', async () => {
  const { window, document, settle, log } = harness();
  await settle();
  window.ph.phix.sync = async () => { log.sync.push({}); return { ok: false, error: '对方程序正在运行，这轮同步先跳过', code: 'skipped' }; };
  click(window, document.getElementById('phixSync'));
  await settle();
  await settle();
  assert.match(textOf(document), /对方程序正在运行/);
});

test('解锁 / 退出 / 改密码 / 切同步口令 / 设备 / 打开目录 / 重新信任公钥都接上了', async () => {
  const { window, document, log, settle } = harness();
  await settle();
  assert.ok(document.getElementById('phixTrustKey'), '高级设置里有"重新信任公钥"入口');
  document.getElementById('phixOldPass').value = 'old123';
  document.getElementById('phixNewPass').value = 'new12345';
  click(window, document.getElementById('phixChangePass'));
  await settle();
  assert.deepEqual(plain(log.changePassword), [{ old_password: 'old123', new_password: 'new12345' }]);

  document.getElementById('phixSpLogin').value = 'old123';
  document.getElementById('phixSpNew').value = 'phrase123';
  click(window, document.getElementById('phixSetSp'));
  await settle();
  assert.deepEqual(plain(log.setPassphrase), [{ login_password: 'old123', sync_passphrase: 'phrase123' }]);

  document.getElementById('phixUnlockPass').value = 'phrase123';
  click(window, document.getElementById('phixUnlock'));
  await settle();
  assert.deepEqual(log.unlock, ['phrase123']);

  click(window, document.getElementById('phixSessions'));
  await settle();
  assert.equal(log.devices, 1);
  assert.match(textOf(document), /笔记本/);

  click(window, document.getElementById('phixOpenDir'));
  await settle();
  assert.equal(log.openDataDir, 1);

  click(window, document.getElementById('phixTrustKey'));
  await settle();
  assert.equal(log.trustKey, 1, '重新信任公钥要发到主进程');

  click(window, document.getElementById('phixLogout'));
  await settle();
  assert.equal(log.logout, 1);
});

test('新密码太短时拦下来，不发请求', async () => {
  const { window, document, log, settle } = harness();
  await settle();
  document.getElementById('phixOldPass').value = 'old123';
  document.getElementById('phixNewPass').value = '123';
  click(window, document.getElementById('phixChangePass'));
  await settle();
  assert.equal(log.changePassword.length, 0);
  assert.match(textOf(document), /新密码至少 6 位/);
});

test('界面把用户填的内容当文本渲染，不用 innerHTML 注入', async () => {
  const { document, settle } = harness({ status: { configured: true, server: 'http://x', username: '<img src=x onerror=alert(1)>', logged_in: true, unlocked: true, key_mode: 'password', auto_sync: true, sync_interval_minutes: 10, last_sync_at: '', recovery_code: '', device: '<b>本机</b>', objects: [], has_token: true, state: { conflicts: [{ object: 'settings.ai', note: '<b>炸弹</b>' }] } } });
  await settle();
  assert.equal(document.querySelectorAll('#phixSettings img').length, 0, '不该出现注入进来的 img 标签');
  assert.deepEqual(
    [...document.querySelectorAll('#phixSettings *')].filter((node) => node.hasAttribute && node.hasAttribute('onerror')),
    [],
    '不该出现注入进来的事件属性',
  );
  assert.match(textOf(document), /<img src=x onerror=alert\(1\)>/, '原样当文字显示');
  assert.match(textOf(document), /<b>炸弹<\/b>/);
});

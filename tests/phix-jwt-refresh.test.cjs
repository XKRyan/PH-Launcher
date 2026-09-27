'use strict';
// phix P3：短期访问令牌（JWT）+ refresh 轮换 —— **客户端侧的自动续期**。
//
// 服务端那边已经跑通（`D:\phix\server\devtools\test_jwt.py`，52 项）；
// 这里盯的是 PHL 自己这三件事，全部走**真实 HTTP**（本地假服务端，只换服务端行为）：
//   1. 登录/注册后 `access_token` 当 Bearer 用，`refresh_token` **单独**落盘；
//   2. `401 + code == token_expired` → 续期一次 → 用新令牌**重试原请求一次**；
//   3. 续期失败**不重试**；`rotated:false` **不覆盖**本地 refresh；登出清两组令牌。
//
// 不打真服务的那部分（网络攻击面）在 `D:\phix\server\devtools\test_phl_jwt.py`。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const cs = require('../electron/cloudsync.cjs');
const session = require('../electron/phix-session.cjs');
const phixCrypto = require('../electron/phix-crypto.cjs');

const ACCESS = 'jwt.access.first';
const ACCESS2 = 'jwt.access.second';
const REFRESH = 'refresh-first-value';
const REFRESH2 = 'refresh-second-value';
const LEGACY = 'legacy-long-token';

/**
 * 假服务端：只实现"令牌这件事"，行为照 `views_auth.py` 的真实口径。
 *
 * `access` 指向**当前有效的**那串 access（过期测试只要把它换掉就行）；
 * `validRefresh` 是服务端认的那串 refresh（轮换之后就变成新的那串）。
 */
function makeServer(options = {}) {
  const state = {
    access: options.access ?? ACCESS,
    validRefresh: options.validRefresh ?? REFRESH,
    tokenPayload: null,                 // POST /auth/refresh 的请求体
    revokeBodies: [],                   // POST /auth/devices/revoke 的请求体
    refreshReply: null,                 // 想自己控制响应时给一个函数
    failRefreshWith: null,              // 想让续期失败：给 { status, error }
    revoked: false,
    calls: [],
    authorization: [],
  };

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      const route = request.url.split('?')[0].replace('/api/v1', '');
      state.calls.push(route);
      state.authorization.push({ route, auth: request.headers.authorization || '' });

      const send = (status, payload) => {
        response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(payload));
      };
      const expired = () => send(401, {
        ok: false,
        error: { code: 'token_expired', message: '登录状态已过期，请用 refresh 令牌续期' },
      });
      const unauthorized = (message) => send(401, {
        ok: false, error: { code: 'unauthorized', message: message || '登录状态无效，请重新登录' },
      });

      // ---- 免认证 ----
      if (route === '/ping') {
        return send(200, { ok: true, version: 1, enc: 0 });   // enc:0 → 走明文路径
      }
      if (route === '/auth/keymaterial') {
        return send(200, {
          ok: true, username: body.username, kdf_algo: options.kdfAlgo || phixCrypto.KDF_ALGO_V1,
          auth_salt: options.authSalt || null, kdf_salt: options.authSalt || null,
        });
      }
      if (route === '/auth/login' || route === '/auth/register') {
        return send(200, {
          ok: true, user_id: 7, username: body.username || 'someone',
          session_id: 3, token: LEGACY, access_token: ACCESS, refresh_token: REFRESH,
          expires_in: 900, rotated: undefined,
          key_wrap: options.keyWrap || 'PHIX1.a.b', kdf_salt: options.kdfSalt || '00'.repeat(16),
          key_check: options.keyCheck || '', key_mode: 'password',
          kdf_algo: options.kdfAlgo || phixCrypto.KDF_ALGO_V1,
        });
      }
      if (route === '/auth/refresh') {
        state.tokenPayload = body;
        if (state.failRefreshWith) {
          const fail = state.failRefreshWith;
          return send(fail.status || 401, {
            ok: false, error: { code: fail.code || 'unauthorized', message: fail.message || '续期凭据无效，请重新登录' },
          });
        }
        if (typeof state.refreshReply === 'function') return state.refreshReply(send, body);
        // 正常轮换：新的 access + **新的** refresh
        const next = state.nextRefresh || REFRESH2;
        state.validRefresh = next;
        state.access = ACCESS2;
        return send(200, {
          ok: true, session_id: 3, access_token: ACCESS2, refresh_token: next,
          rotated: true, expires_in: 900,
        });
      }

      // ---- 需要认证 ----
      const bearer = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!bearer || state.revoked) {
        return state.revoked ? unauthorized('这个会话已被注销，请重新登录') : unauthorized();
      }
      if (route === '/auth/devices') {
        return send(200, {
          ok: true,
          sessions: [
            { id: 3, device: '家里的台式机', current: true, last_seen_at: '2026-09-12T10:00:00+08:00' },
            { id: 4, device: '笔记本', current: false, created_at: '2026-09-11T09:00:00+08:00' },
          ],
          devices: [{ id: 9, name: '旧设备', last_used_at: '2026-09-10T08:00:00+08:00' }],
          access_ttl: 900, refresh_ttl: 2592000,
        });
      }
      if (route === '/auth/devices/revoke') {
        state.revokeBodies.push(body);
        return send(200, { ok: true, revoked: 3, sessions: 3, tokens: 0 });
      }
      if (route === '/auth/logout') return send(200, { ok: true, revoked: true, session_id: 3 });
      if (bearer === state.access) return send(200, { ok: true, route, user_id: 7 });
      if (String(bearer).startsWith('jwt.')) return expired();
      return unauthorized();
    });
  });

  return { state, server };
}

async function withServer(run, options = {}) {
  const { state, server } = makeServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`, state);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const clientFor = (base, state, extra = {}) => new cs.PhixClient(base, null, 5000, {
  e2e: false,
  accessToken: state.access,
  refreshToken: state.validRefresh,
  ...extra,
});

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'phix-jwt-'));
const readSecrets = (root) => cs.parseYamlSection(fs.readFileSync(path.join(root, 'settings.yaml'), 'utf8'), 'secrets_extra') || {};

// ---------------------------------------------------------------- 1. 续期成功 + 重试一次
test('P3：401 token_expired → 续期一次 → 新 access 重试原请求（只重试一次）', async () => {
  await withServer(async (base, state) => {
    const client = clientFor(base, state);
    state.access = 'jwt.stale';                       // 手里的 access 已过期
    const data = await client.me();
    assert.equal(data.ok, true, '重试之后拿到了业务数据');
    const protectedCalls = state.calls.filter((route) => route === '/auth/me');
    assert.equal(protectedCalls.length, 2, '原请求只重试一次（总共两次：失败的 + 成功的）');
    assert.equal(state.calls.filter((route) => route === '/auth/refresh').length, 1, '续期只发生一次');
    assert.equal(client.accessToken, ACCESS2, '内存里换成了新的 access');
    assert.equal(client.token, ACCESS2, '兼容字段 token 也跟着走（PLL 同口径）');
  });
});

test('P3：续期成功时把响应里的新 refresh 存下来（响应里有就必须存）', async () => {
  const saved = [];
  await withServer(async (base, state) => {
    const client = clientFor(base, state, { persist: (tokens) => saved.push(tokens) });
    state.access = 'jwt.stale';
    await client.me();
    assert.equal(client.refreshToken, REFRESH2, '轮换后的 refresh 落到内存');
    assert.deepEqual(saved.map((hit) => hit.refresh_token), [REFRESH2], '落盘回调只报了一次，且是新那串');
    assert.deepEqual(saved.map((hit) => hit.access_token), [ACCESS2]);
  });
});

test('P3：rotated:false（宽限期内重复续期）→ 只换 access，**不覆盖**本地 refresh、也不报错', async () => {
  const saved = [];
  await withServer(async (base, state) => {
    const client = clientFor(base, state, { persist: (tokens) => saved.push(tokens) });
    state.refreshReply = (send) => {
      state.access = ACCESS2;      // 宽限期也给新的 access（服务端就是这么干的）
      return send(200, {
        ok: true, session_id: 3, access_token: ACCESS2, rotated: false, expires_in: 900,
        // 服务端在宽限期内**不重发** refresh：响应里没有 refresh_token 字段
      });
    };
    state.access = 'jwt.stale';
    const data = await client.me();
    assert.equal(data.ok, true, '宽限期不是错误，重试照样成功');
    assert.equal(client.accessToken, ACCESS2, 'access 换新');
    assert.equal(client.refreshToken, REFRESH, '本地那串 refresh 一个字节都没动');
    assert.deepEqual(saved, [{ access_token: ACCESS2, refresh_token: REFRESH }], '落盘时 refresh 保持原值');
  });
});

// ---------------------------------------------------------------- 2. 续期失败不重试
test('P3：续期失败**不重试**（旧 refresh 连点会被判重放）', async () => {
  await withServer(async (base, state) => {
    const client = clientFor(base, state);
    state.access = 'jwt.stale';
    state.failRefreshWith = { status: 401, message: '续期凭据无效，请重新登录' };
    await assert.rejects(() => client.me(), (error) => {
      assert.equal(error.code, 'refresh_failed', '带 code，界面能判');
      assert.match(error.message, /重新登录/);
      return true;
    });
    assert.equal(state.calls.filter((route) => route === '/auth/refresh').length, 1, '续期只试一次');
    assert.equal(state.calls.filter((route) => route === '/auth/me').length, 1, '原请求不重试');
  });
});

test('P3：宽限期外重放旧 refresh（服务端识破）→ 上报中文原因，绝不重试', async () => {
  await withServer(async (base, state) => {
    const client = clientFor(base, state);
    state.access = 'jwt.stale';
    // 服务端在宽限期外拿到"上一个"refresh = 判定重放 → 撤销整个会话
    state.refreshReply = (send, body) => {
      if (body.refresh_token === REFRESH) {
        return send(401, {
          ok: false,
          error: { code: 'unauthorized', message: '续期凭据已被使用过，为安全起见本次登录已作废，请重新登录' },
        });
      }
      return send(401, { ok: false, error: { code: 'unauthorized', message: '续期凭据无效，请重新登录' } });
    };
    await assert.rejects(() => client.me(), (error) => {
      assert.equal(error.code, 'refresh_failed', '归一成"续期失败"，界面据此提示重新登录');
      assert.match(error.message, /已被使用过/);
      return true;
    });
    assert.equal(state.calls.filter((route) => route === '/auth/refresh').length, 1,
      '**绝不用旧 refresh 连点**（第二次就会被判重放、整个会话作废）');
    assert.equal(state.calls.filter((route) => route === '/auth/me').length, 1, '原请求不重试');
  });
});

test('P3：会话被服务端注销 → 续期也救不回来，报"重新登录"而不是接着重试', async () => {
  await withServer(async (base, state) => {
    const client = clientFor(base, state);
    state.access = 'jwt.stale';
    // 会话被注销后，refresh 也只会拿到 unauthorized（不是 token_expired）
    state.refreshReply = (send) => send(401, {
      ok: false, error: { code: 'unauthorized', message: '这个会话已被注销，请重新登录' },
    });
    await assert.rejects(() => client.me(), (error) => {
      assert.equal(error.code, 'refresh_failed');
      assert.match(error.message, /已被注销/);
      return true;
    });
    assert.equal(state.calls.filter((route) => route === '/auth/refresh').length, 1, '续期只试一次');
    assert.equal(state.calls.filter((route) => route === '/auth/me').length, 1, '不重试');
  });
});

test('P3：不是"令牌过期"的 401（比如凭据无效）不拿去续期', async () => {
  await withServer(async (base, state) => {
    // 手里的那串服务端根本不认（会话被撤 / 令牌无效）→ unauthorized，不是 token_expired
    const client = clientFor(base, state, { accessToken: 'not-a-live-token' });
    await assert.rejects(() => client.me(), (error) => {
      assert.equal(error.code, 'unauthorized');
      return true;
    });
    assert.equal(state.calls.filter((route) => route === '/auth/refresh').length, 0, '没去续期');
  });
});

test('P3：没有 refresh 令牌时不假装能续期，直接报"重新登录"', async () => {
  await withServer(async (base, state) => {
    const client = clientFor(base, state, { refreshToken: '' });
    state.access = 'jwt.stale';
    await assert.rejects(() => client.me(), (error) => {
      assert.equal(error.code, 'token_expired', '就像以前那样把过期原样抛出去');
      return true;
    });
    assert.equal(state.calls.filter((route) => route === '/auth/refresh').length, 0);
  });
});

// ---------------------------------------------------------------- 3. 并发续期只发一次
test('P3：并发请求撞上过期 → 共用一次续期（不会拿旧 refresh 连点）', async () => {
  await withServer(async (base, state) => {
    const client = clientFor(base, state);
    state.access = 'jwt.stale';
    const results = await Promise.all([client.me(), client.manifest()]);
    assert.equal(results.length, 2);
    assert.equal(state.calls.filter((route) => route === '/auth/refresh').length, 1, '只续期一次');
    assert.equal(state.calls.filter((route) => route === '/auth/me').length, 2, '各自重试一次');
    assert.equal(state.calls.filter((route) => route === '/sync/manifest').length, 2);
  });
});

// ---------------------------------------------------------------- 4. 登录/注册怎么用令牌
test('P3：登录后 access 当 Bearer、refresh 单独存；老式 token 也留着（语义不变）', async () => {
  await withServer(async (base, state) => {
    const client = new cs.PhixClient(base, null, 5000, { e2e: false });
    const info = await client.login('someone', 'pw-123');
    assert.equal(info.access_token, ACCESS);
    assert.equal(info.refresh_token, REFRESH);
    assert.equal(client.accessToken, ACCESS, '业务请求优先用 access');
    assert.equal(client.token, ACCESS, 'client.token 就是这一轮该用的 Bearer（PLL 同口径）');
    assert.equal(client.authToken(), ACCESS, 'authToken 优先返回 access');

    await client.me();
    const call = state.authorization.find((hit) => hit.route === '/auth/me');
    assert.equal(call.auth, `Bearer ${ACCESS}`, '业务请求带的是 access，不是老令牌');
    // 续期之后：业务请求改用新 access（老令牌那一串仍留在 `phix:token` 里）
    state.access = 'jwt.stale';
    await client.me();
    assert.equal(client.accessToken, ACCESS2);
    assert.equal(state.authorization.filter((hit) => hit.route === '/auth/me').pop().auth, `Bearer ${ACCESS2}`);
  });
});

test('P3：老客户端风格（只给 token）照旧能发请求', async () => {
  await withServer(async (base, state) => {
    state.access = LEGACY;                  // 老式令牌就是"当前有效凭据"
    const client = new cs.PhixClient(base, LEGACY, 5000, { e2e: false });
    const data = await client.me();
    assert.equal(data.ok, true);
    assert.equal(state.authorization.find((hit) => hit.route === '/auth/me').auth, `Bearer ${LEGACY}`);
  });
});

// ---------------------------------------------------------------- 5. 会话层：落盘位置与语义
test('P3：会话层把两串令牌存进 secrets_extra，且**不覆盖** PLL 写的老令牌语义', async () => {
  const root = tmpRoot();
  const material = phixCrypto.newMaterial('someone', 'pw-123');
  await withServer(async (base, state) => {
    session.configure({ dataDir: root });
    session.saveConfig({ e2e: false });
    fs.writeFileSync(path.join(root, 'settings.yaml'), [
      'version: 1',
      'phix:',
      '  server: ' + base,
      '  username: someone',
      'secrets_extra:',
      '  phix:token: token-from-pll',
      '',
    ].join('\n'), 'utf8');

    const api = new session.PhixSession({ log: () => {} });
    const status = await api.login(base, 'someone', 'pw-123');
    assert.equal(status.logged_in, true);

    const secrets = readSecrets(root);
    assert.equal(secrets[session.TOKEN_KEY], LEGACY, 'phix:token 现在是本次登录的老式令牌');
    assert.equal(secrets[session.ACCESS_TOKEN_KEY], ACCESS, 'access_token 单独一个键');
    assert.equal(secrets[session.REFRESH_TOKEN_KEY], REFRESH, 'refresh_token 单独一个键');
    assert.equal(status.has_token, true);
    assert.equal(status.has_access_token, true);
    assert.equal(status.has_refresh_token, true);
    // 状态里**只报有没有**，绝不回传令牌本身
    assert.equal(JSON.stringify(status).includes(REFRESH), false);
    assert.equal(JSON.stringify(status).includes(ACCESS), false);
    assert.equal(JSON.stringify(status).includes(LEGACY), false);
    // DEK/KEK 一律不落盘
    const text = fs.readFileSync(path.join(root, 'settings.yaml'), 'utf8');
    assert.equal(/key_wrap|key_check|kdf_salt|dek/i.test(text), false, 'DEK/密钥材料一个字节都不落盘');
    void material;
  }, { keyWrap: material.key_wrap, kdfSalt: material.kdf_salt, keyCheck: material.key_check });
});

test('P3：会话层续期之后把新 refresh 落盘，业务请求自动重试', async () => {
  const root = tmpRoot();
  const material = phixCrypto.newMaterial('someone', 'pw-123');
  await withServer(async (base, state) => {
    session.configure({ dataDir: root });
    session.saveConfig({ e2e: false });
    const api = new session.PhixSession({ log: () => {} });
    await api.login(base, 'someone', 'pw-123');

    state.access = 'jwt.stale';                 // 15 分钟到了
    const data = await api.client.me();          // 会话层直接用同一个客户端
    assert.equal(data.ok, true, '过期的 access 被自动续上并重试');
    assert.equal(readSecrets(root)[session.REFRESH_TOKEN_KEY], REFRESH2, '新 refresh 已落盘');
    assert.equal(readSecrets(root)[session.ACCESS_TOKEN_KEY], ACCESS2);
  }, { keyWrap: material.key_wrap, kdfSalt: material.kdf_salt, keyCheck: material.key_check });
});

test('P3：登出 → 调 /auth/logout，本地**三串**令牌一起清掉', async () => {
  const root = tmpRoot();
  const material = phixCrypto.newMaterial('someone', 'pw-123');
  await withServer(async (base, state) => {
    session.configure({ dataDir: root });
    session.saveConfig({ e2e: false });
    const api = new session.PhixSession({ log: () => {} });
    await api.login(base, 'someone', 'pw-123');
    assert.ok(readSecrets(root)[session.REFRESH_TOKEN_KEY], '登出前 refresh 在盘上');

    state.revoked = true;                        // 服务端注销这条会话
    const status = await api.logout();
    assert.equal(state.calls.includes('/auth/logout'), true, '确实调了登出接口');
    const logoutCall = state.authorization.find((hit) => hit.route === '/auth/logout');
    assert.equal(logoutCall.auth, `Bearer ${ACCESS}`, '登出用的是 access');
    assert.equal(status.logged_in, false);
    const secrets = readSecrets(root);
    assert.equal(secrets[session.TOKEN_KEY], undefined, '老式令牌清掉');
    assert.equal(secrets[session.ACCESS_TOKEN_KEY], undefined, 'access 清掉');
    assert.equal(secrets[session.REFRESH_TOKEN_KEY], undefined, 'refresh 清掉');
    assert.equal(status.has_access_token, false);
    assert.equal(status.has_refresh_token, false);
  }, { keyWrap: material.key_wrap, kdfSalt: material.kdf_salt, keyCheck: material.key_check });
});

test('P3：登出请求失败也照清本地令牌（留着一串不认的没用）', async () => {
  const root = tmpRoot();
  session.configure({ dataDir: root });
  const api = new session.PhixSession({ log: () => {} });
  api.client = { authToken: () => 'x', logout: async () => { throw new Error('连不上'); } };
  session.saveToken('legacy-here');
  session.saveTokens({ access_token: 'a', refresh_token: 'r' });
  const status = await api.logout();
  assert.equal(status.logged_in, false);
  const secrets = readSecrets(root);
  assert.equal(secrets[session.TOKEN_KEY], undefined);
  assert.equal(secrets[session.ACCESS_TOKEN_KEY], undefined);
  assert.equal(secrets[session.REFRESH_TOKEN_KEY], undefined);
});

test('P3：老令牌 + 新访问令牌并存时，登录态判定与 Bearer 取值都对', async () => {
  const root = tmpRoot();
  await withServer(async (base, state) => {
    session.configure({ dataDir: root });
    session.saveConfig({ server: base, username: 'someone', e2e: false });
    session.saveToken('legacy-only');           // 只有 PLL 留下的老令牌
    const api = new session.PhixSession({ log: () => {} });
    assert.equal(api.status().has_token, true);
    assert.equal(api.status().has_access_token, false);

    const client = session.makeClient(base, null, undefined, { withTokens: true });
    assert.equal(client.authToken(), 'legacy-only', '没有 access 时退回老令牌');
    assert.equal(client.refreshToken, '');

    session.saveTokens({ access_token: ACCESS, refresh_token: REFRESH });
    const withJwt = session.makeClient(base, null, undefined, { withTokens: true });
    assert.equal(withJwt.authToken(), ACCESS, '有 access 就用 access');
    assert.equal(withJwt.refreshToken, REFRESH, 'refresh 一起恢复');
    state.access = ACCESS;
    assert.equal((await withJwt.me()).ok, true);
  }, { e2e: false });
});

// ---------------------------------------------------------------- 6. 设备 / 会话
test('P3：会话列表规范化（sessions + devices + TTL），一条 refresh 明文都不带', async () => {
  await withServer(async (base, state) => {
    const api = new session.PhixSession({ log: () => {} });
    api.client = {
      authToken: () => ACCESS,
      devices: async () => ({
        sessions: [
          { id: 3, device: '家里的台式机', last_seen_at: '2026-09-12T10:00:00+08:00', current: true },
          { id: 4, device: '笔记本', created_at: '2026-09-11T09:00:00+08:00', current: false },
          { id: 5, device: '', revoked: true, revoked_reason: 'manual' },
        ],
        devices: [{ id: 9, name: '旧设备', last_used_at: '2026-09-10T08:00:00+08:00' }],
        access_ttl: 900, refresh_ttl: 2592000,
      }),
    };
    const data = await api.sessions();
    assert.equal(data.sessions.length, 3);
    assert.equal(data.sessions[0].device, '家里的台式机');
    assert.equal(data.sessions[0].current, true);
    assert.equal(data.sessions[2].device, '', '没名字就是空串，中文占位由界面补（见 phix-sessions-ui）');
    assert.equal(data.sessions[2].revoked, true);
    assert.equal(data.devices[0].device, '旧设备', '老式令牌那一列也能用同一个字段名');
    assert.equal(data.devices[0].kind, 'legacy');
    assert.equal(data.access_ttl, 900);
    assert.equal(data.refresh_ttl, 2592000);
    assert.equal(JSON.stringify(data).includes('refresh_token'), false, '列表里不许有 refresh 明文');

    // 兼容旧调用：devices() 只要老式那一列
    assert.deepEqual((await api.devices()).map((item) => item.device), ['旧设备']);
    assert.equal(state.calls.length, 0, '这一段不发真请求');
  });
});

test('P3：注销某一台会话 / 注销除本机外全部 → 参数拼对，且不动本机令牌', async () => {
  const root = tmpRoot();
  await withServer(async (base, state) => {
    session.configure({ dataDir: root });
    session.saveConfig({ e2e: false });
    session.saveTokens({ access_token: ACCESS, refresh_token: REFRESH });
    const api = new session.PhixSession({ log: () => {} });
    api.client = new cs.PhixClient(base, null, 5000, {
      e2e: false, accessToken: ACCESS, refreshToken: REFRESH,
    });
    state.access = ACCESS;

    const one = await api.revokeSession({ sessionId: 42 });
    assert.equal(one.revoked, 3);
    assert.equal(state.revokeBodies?.[0]?.session_id, 42);
    await api.revokeSession({ allExceptCurrent: true });
    assert.equal(state.revokeBodies?.[1]?.all_except_current, true);
    assert.equal(readSecrets(root)[session.REFRESH_TOKEN_KEY], REFRESH, '本机令牌一个字节都没动');

    await assert.rejects(() => api.revokeSession({}), (error) => error.code === 'bad_request');
    const empty = new session.PhixSession({ log: () => {} });
    await assert.rejects(() => empty.sessions(), (error) => error.code === 'not_logged_in');
  }, {});
});

// 让上面的假服务端记下 /auth/devices/revoke 的请求体
test('P3：注销接口把 session_id / all_except_current 原样发给服务端', async () => {
  await withServer(async (base, state) => {
    const client = new cs.PhixClient(base, null, 5000, { e2e: false, accessToken: ACCESS });
    state.access = ACCESS;
    await client.revokeDevices({ session_id: 7 });
    await client.revokeDevices({ all_except_current: true });
    assert.deepEqual(state.revokeBodies, [{ session_id: 7 }, { all_except_current: true }]);
    assert.equal(state.calls.includes('/auth/devices/revoke'), true);

    // 会话列表走真 HTTP 也照样规范化
    const api = new session.PhixSession({ log: () => {} });
    api.client = client;
    const data = await api.sessions();
    assert.equal(data.sessions.length, 2);
    assert.equal(data.sessions[1].device, '笔记本');
    assert.equal(data.devices[0].device, '旧设备');
    assert.equal(state.authorization.find((hit) => hit.route === '/auth/devices').auth, `Bearer ${ACCESS}`);
  }, {});
});

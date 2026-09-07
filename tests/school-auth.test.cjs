// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SchoolAuthenticator,
  assertRequestAllowed,
  parseManageBacForm,
  parseEduPageCsrf,
  hasManageBacSession,
  parseEduPageSession,
} = require('../electron/school-auth.cjs');

const mbForm = ({ action = '/sessions', extra = '' } = {}) => `<!doctype html><html><body>
  <form id="session_form" action="${action}" method="post">
    <input type="hidden" name="authenticity_token" value="csrf-mb">
    <input id="session_login" name="session[login]" type="email">
    <input id="session_password" name="session[password]" type="password">
    <input name="commit" value="Sign in">
    ${extra}
  </form>
  <script>globalThis.schoolAuthScriptRan = true</script>
</body></html>`;
const mbSession = '<html><body><nav><a href="/student/classes/my">My classes</a></nav></body></html>';
const eduLogin = '<html><script>window.bootstrap={"csrftoken":"csrf-edu"};globalThis.schoolAuthScriptRan=true</script></html>';
const eduSession = '<html><script>userhome({"userid":"Student-42","dbi":{"classes":{}}});globalThis.schoolAuthScriptRan=true</script></html>';
const rpc = (value) => JSON.stringify(value);

function response(status, body = '', location = '') {
  const headers = new Headers();
  if (location) headers.set('location', location);
  headers.set('content-length', String(Buffer.byteLength(body)));
  return { status, headers, url: '', text: async () => body };
}

function loginRequired() {
  const error = new Error('expired');
  error.code = 'LOGIN_REQUIRED';
  return error;
}

test('login parsers are inert, bounded and accept only the fixed upstream fields', () => {
  delete globalThis.schoolAuthScriptRan;
  assert.deepEqual(parseManageBacForm(mbForm()), {
    action: 'https://shph.managebac.cn/sessions',
    token: 'csrf-mb',
    loginName: 'session[login]',
    passwordName: 'session[password]',
    commit: 'Sign in',
  });
  assert.equal(parseEduPageCsrf(eduLogin), 'csrf-edu');
  assert.equal(hasManageBacSession(mbSession), true);
  assert.deepEqual(parseEduPageSession(eduSession), { userId: 'Student-42' });
  assert.equal(globalThis.schoolAuthScriptRan, undefined);
  assert.throws(() => parseManageBacForm(mbForm({ action: 'https://evil.example/sessions' })), { code: 'URL_NOT_ALLOWED' });
  assert.throws(() => parseManageBacForm(mbForm({ extra: '<div class="g-recaptcha"></div>' })), { code: 'LOGIN_REQUIRED' });
  assert.throws(() => parseEduPageCsrf('<input name="captcha">'), { code: 'LOGIN_REQUIRED' });
});

test('request allowlist is exact by site, HTTPS origin, path, query and method', () => {
  assert.equal(assertRequestAllowed('managebac', '/login', 'GET').href, 'https://shph.managebac.cn/login');
  assert.equal(assertRequestAllowed('edupage', '/login/?cmd=MainLogin', 'GET').href, 'https://pingheschool.edupage.org/login/?cmd=MainLogin');
  assert.equal(assertRequestAllowed('edupage', '/login/?cmd=MainLogin&akcia=getToken', 'POST').href, 'https://pingheschool.edupage.org/login/?cmd=MainLogin&akcia=getToken');
  for (const entry of [
    ['managebac', 'http://shph.managebac.cn/login', 'GET'],
    ['managebac', 'https://evil.example/login', 'GET'],
    ['managebac', '/sessions?next=/student', 'POST'],
    ['managebac', '/student/classes/my', 'GET'],
    ['edupage', '/login/index.php', 'GET'],
    ['edupage', '/login/?cmd=Other', 'GET'],
    ['edupage', '/login/edubarLogin.php', 'GET'],
    ['edupage', '/login/?cmd=MainLogin&akcia=getToken&extra=1', 'POST'],
  ]) assert.throws(() => assertRequestAllowed(...entry), (error) => {
    assert.equal(error.code, 'URL_NOT_ALLOWED');
    assert.ok(error.diagnostic);
    assert.doesNotMatch(JSON.stringify(error.diagnostic), /evil|next|index|other/i);
    return true;
  });
});

test('withSession restores ManageBac once, ignores the landing target and verifies at fixed /student', async () => {
  const calls = [];
  const fetch = async (site, url, options) => {
    calls.push({ site, url, ...options });
    if (url.endsWith('/login')) return response(200, mbForm());
    if (url.endsWith('/sessions')) return response(302, '', '/student/classes/my?welcome=account-state');
    if (url.endsWith('/student')) return response(200, mbSession);
    throw new Error(`unexpected ${url}`);
  };
  let credentialReads = 0;
  const auth = new SchoolAuthenticator({
    fetch,
    getCredential: async () => { credentialReads += 1; return { username: 'student@example.test', password: 'not-a-real-password', autoLogin: true, revision: 'v1' }; },
  });
  let operations = 0;
  const result = await auth.withSession('managebac', async () => {
    operations += 1;
    if (operations === 1) throw loginRequired();
    return 'restored';
  });
  assert.equal(result, 'restored');
  assert.equal(operations, 2);
  assert.equal(credentialReads, 2, 'consent and credential are re-read immediately before POST');
  assert.equal(calls.length, 3);
  assert.equal(calls[1].redirect, 'manual');
  assert.equal(calls[2].url, 'https://shph.managebac.cn/student');
  assert.equal(calls[2].method, 'GET', 'verification uses a new credential-free GET');
  assert.equal(calls[2].body, undefined);
  const submitted = new URLSearchParams(calls[1].body);
  assert.equal(submitted.get('remember_me'), '1');
  assert.equal(submitted.get('session[login]'), 'student@example.test');
  assert.equal(submitted.get('session[password]'), 'not-a-real-password');
});

test('ManageBac consumes the fixed Faria China OTSI continuation as GET and verifies only /student', async () => {
  const calls = [];
  const auth = new SchoolAuthenticator({
    getCredential: async () => ({ username: 'student@example.test', password: 'synthetic-password', autoLogin: true }),
    fetch: async (site, url, options) => {
      calls.push({ url, method: options.method, body: options.body, headers: options.headers });
      if (url.endsWith('/login')) return response(200, mbForm());
      if (url.endsWith('/sessions')) return response(302, '', 'https://accounts.faria.cn/accounts/otsi?token=synthetic-one-time-ticket');
      if (url.includes('accounts.faria.cn/accounts/otsi')) {
        return response(302, '', 'https://shph.managebac.cn/sso/callback?token=synthetic-return-ticket');
      }
      if (url.endsWith('/student')) return response(200, mbSession);
      throw new Error(`unexpected ${url}`);
    },
  });
  await auth.authenticate('managebac');
  assert.deepEqual(calls.map(({ url, method }) => [new URL(url).origin + new URL(url).pathname, method]), [
    ['https://shph.managebac.cn/login', 'GET'],
    ['https://shph.managebac.cn/sessions', 'POST'],
    ['https://accounts.faria.cn/accounts/otsi', 'GET'],
    ['https://shph.managebac.cn/student', 'GET'],
  ]);
  assert.equal(calls.some(({ url }) => url.includes('/sso/callback')), false, 'server callback is replaced by fixed verification');
  assert.equal(calls[2].body, undefined);
  assert.deepEqual(Object.keys(calls[2].headers), ['Accept']);
  assert.equal(Object.keys(calls[2].headers).some((name) => /authorization|content-type/i.test(name)), false);
});

test('ManageBac Faria continuation rejects alternate hosts, paths and query shapes without leaking tokens', async () => {
  const locations = [
    'https://accounts.faria.org/accounts/otsi?token=synthetic-secret',
    'https://accounts.faria.cn/accounts/sign-in?token=synthetic-secret',
    'https://accounts.faria.cn/accounts/otsi?token=synthetic-secret&next=unknown',
  ];
  for (const location of locations) {
    const calls = [];
    const auth = new SchoolAuthenticator({
      getCredential: async () => ({ username: 'student', password: 'synthetic', autoLogin: true }),
      fetch: async (site, url) => {
        calls.push(url);
        return url.endsWith('/login') ? response(200, mbForm()) : response(302, '', location);
      },
    });
    await assert.rejects(auth.authenticate('managebac'), (error) => {
      assert.equal(error.code, 'URL_NOT_ALLOWED');
      assert.doesNotMatch(error.message + JSON.stringify(error.diagnostic), /synthetic-secret/);
      return true;
    });
    assert.equal(calls.length, 2);
  }
});

test('ManageBac Faria continuation revalidates every cross-origin hop and never contacts a third host', async () => {
  const calls = [];
  const auth = new SchoolAuthenticator({
    getCredential: async () => ({ username: 'student', password: 'synthetic', autoLogin: true }),
    fetch: async (site, url) => {
      calls.push(url);
      if (url.endsWith('/login')) return response(200, mbForm());
      if (url.endsWith('/sessions')) return response(302, '', 'https://accounts.faria.cn/accounts/otsi?token=synthetic-ticket');
      return response(302, '', 'https://evil.example/steal');
    },
  });
  await assert.rejects(auth.authenticate('managebac'), { code: 'URL_NOT_ALLOWED' });
  assert.equal(calls.length, 3);
  assert.equal(calls.some((url) => url.includes('evil.example')), false);
});

test('ManageBac password POST never replays through a 307/308 Faria redirect', async () => {
  for (const status of [307, 308]) {
    const calls = [];
    const auth = new SchoolAuthenticator({
      getCredential: async () => ({ username: 'student', password: 'synthetic', autoLogin: true }),
      fetch: async (site, url, options) => {
        calls.push({ url, method: options.method });
        return url.endsWith('/login') ? response(200, mbForm())
          : response(status, '', 'https://accounts.faria.cn/accounts/otsi?token=must-not-be-requested');
      },
    });
    await assert.rejects(auth.authenticate('managebac'), (error) => {
      assert.equal(error.code, 'PAGE_CHANGED');
      assert.equal(error.diagnostic.reason, 'post-replay-blocked');
      return true;
    });
    assert.deepEqual(calls.map(({ method }) => method), ['GET', 'POST']);
  }
});

test('missing explicit auto-login consent never starts network login', async () => {
  let networkCalls = 0;
  const auth = new SchoolAuthenticator({
    fetch: async () => { networkCalls += 1; return response(500); },
    getCredential: async () => ({ username: 'student', password: 'secret', autoLogin: false }),
  });
  await assert.rejects(auth.authenticate('managebac'), { code: 'LOGIN_REQUIRED' });
  assert.equal(networkCalls, 0);
});

test('revoked or changed consent is checked before POST and no password is submitted', async () => {
  const calls = [];
  let reads = 0;
  const auth = new SchoolAuthenticator({
    fetch: async (site, url, options) => { calls.push({ url, options }); return response(200, mbForm()); },
    getCredential: async () => {
      reads += 1;
      return reads === 1
        ? { username: 'student', password: 'secret', autoLogin: true, revision: '1' }
        : { username: 'student', password: 'secret', autoLogin: false, revision: '2' };
    },
  });
  await assert.rejects(auth.authenticate('managebac'), { code: 'LOGIN_REQUIRED' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'GET');
});

test('concurrent restore is singleflight and cooldown prevents repeated POST attempts', async () => {
  let now = 100000;
  let posts = 0;
  const auth = new SchoolAuthenticator({
    now: () => now,
    cooldownMs: 60000,
    getCredential: async () => ({ username: 'student', password: 'wrong-synthetic', autoLogin: true }),
    fetch: async (site, url) => {
      if (url.endsWith('/login')) return response(200, mbForm());
      if (url.endsWith('/sessions')) { posts += 1; await new Promise((resolve) => setImmediate(resolve)); return response(302, '', '/login'); }
      throw new Error(`unexpected ${url}`);
    },
  });
  const pair = await Promise.allSettled([auth.authenticate('managebac'), auth.authenticate('managebac')]);
  assert.deepEqual(pair.map((item) => item.status), ['rejected', 'rejected']);
  assert.equal(pair[0].reason.code, 'LOGIN_REQUIRED');
  assert.equal(pair[1].reason, pair[0].reason, 'callers share one login promise');
  assert.equal(posts, 1);
  now += 1000;
  await assert.rejects(auth.authenticate('managebac'), { code: 'LOGIN_COOLDOWN' });
  assert.equal(posts, 1);
});

test('invalidate cancels an in-flight login before the credential POST', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let posts = 0;
  const auth = new SchoolAuthenticator({
    getCredential: async () => ({ username: 'student', password: 'synthetic', autoLogin: true }),
    fetch: async (site, url) => {
      if (url.endsWith('/login')) { await gate; return response(200, mbForm()); }
      if (url.endsWith('/sessions')) { posts += 1; return response(200, mbSession); }
      throw new Error(`unexpected ${url}`);
    },
  });
  const pending = auth.authenticate('managebac');
  auth.invalidate('managebac');
  release();
  await assert.rejects(pending, { code: 'SESSION_INVALIDATED' });
  assert.equal(posts, 0);
});

test('an invalidated old action cannot initiate a fresh login after it reports expiry', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let credentialReads = 0;
  let networkCalls = 0;
  const auth = new SchoolAuthenticator({
    getCredential: async () => { credentialReads += 1; return { username: 'student', password: 'synthetic', autoLogin: true }; },
    fetch: async () => { networkCalls += 1; return response(500); },
  });
  const pending = auth.withSession('managebac', async () => {
    await gate;
    throw loginRequired();
  });
  auth.invalidate('managebac');
  release();
  await assert.rejects(pending, { code: 'SESSION_INVALIDATED' });
  assert.equal(credentialReads, 0);
  assert.equal(networkCalls, 0);
});

test('EduPage RPC consumes the same-origin ticket with GET, then verifies at fixed /user', async () => {
  const calls = [];
  const auth = new SchoolAuthenticator({
    getCredential: async () => ({ username: 'student', password: 'synthetic', autoLogin: true }),
    fetch: async (site, url, options) => {
      calls.push({ url, ...options });
      if (url.endsWith('/login/?cmd=MainLogin')) return response(200, eduLogin);
      if (url.endsWith('akcia=getToken')) return response(200, rpc({ token: 'synthetic-token' }));
      if (url.endsWith('akcia=login')) return response(200, rpc({ status: 'OK', redirectUrl: '/user/?eqa=synthetic-account-state' }));
      if (url.includes('/user/?eqa=')) return response(302, '', '/user');
      if (url.endsWith('/user')) return response(200, eduSession);
      throw new Error(`unexpected ${url}`);
    },
  });
  assert.deepEqual(await auth.authenticate('edupage'), { site: 'edupage', authenticated: true });
  assert.deepEqual(calls.map((call) => [new URL(call.url).pathname + new URL(call.url).search, call.method]), [
    ['/login/?cmd=MainLogin', 'GET'],
    ['/login/?cmd=MainLogin&akcia=getToken', 'POST'],
    ['/login/?cmd=MainLogin&akcia=login', 'POST'],
    ['/user/?eqa=synthetic-account-state', 'GET'],
    ['/user', 'GET'],
  ]);
});

test('captcha/MFA and cross-origin redirects stop for user action without retries', async () => {
  for (const location of ['/login/twofactor?sn=1', 'https://evil.example/user']) {
    let posts = 0;
    const auth = new SchoolAuthenticator({
      getCredential: async () => ({ username: 'student', password: 'synthetic', autoLogin: true }),
      fetch: async (site, url) => {
        if (url.endsWith('/login/?cmd=MainLogin')) return response(200, eduLogin);
        if (url.endsWith('akcia=getToken')) return response(200, rpc({ token: 'synthetic-token' }));
        if (url.endsWith('akcia=login')) { posts += 1; return response(200, rpc({ status: 'FAIL', redirectUrl: location })); }
        return response(200, '<input name="t2fasec"><input name="2fform">');
      },
    });
    await assert.rejects(auth.authenticate('edupage'), { code: location.startsWith('https:') ? 'URL_NOT_ALLOWED' : 'LOGIN_REQUIRED' });
    assert.equal(posts, 1);
  }
});

test('EduPage redirect failure flags become useful login errors without leaking query data', async () => {
  const cases = [
    ['/login/?bad=1&username=student%40example.test', 'credentials', /账号或密码/],
    ['/login/?cap=1&csrfauth=must-not-leak', 'captcha', /验证码/],
    ['/login/?lerr=b43b43&password=must-not-leak', 'captcha', /验证码/],
    ['/login/twofactor?sn=secret-state', 'second-factor', /额外验证/],
  ];
  for (const [location, reason, message] of cases) {
    const auth = new SchoolAuthenticator({
      getCredential: async () => ({ username: 'student', password: 'synthetic', autoLogin: true }),
      fetch: async (site, url) => url.endsWith('/login/?cmd=MainLogin')
        ? response(200, eduLogin)
        : response(302, '', location),
    });
    await assert.rejects(auth.authenticate('edupage'), (error) => {
      assert.equal(error.code, 'LOGIN_REQUIRED');
      assert.match(error.message, message);
      assert.deepEqual(error.diagnostic, {
        site: 'edupage', phase: 'login-redirect', reason, status: 302,
      });
      assert.doesNotMatch(JSON.stringify(error.diagnostic), /student|csrf|password|secret/i);
      assert.doesNotMatch(error.message, /bad=|cap=|lerr=|twofactor|https?:/i);
      return true;
    });
  }
});

test('credential POST never follows or replays any HTTP redirect', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const calls = [];
    const auth = new SchoolAuthenticator({
      getCredential: async () => ({ username: 'student', password: 'synthetic', autoLogin: true }),
      fetch: async (site, url, options) => {
        calls.push({ url, method: options.method });
        if (url.endsWith('/login/?cmd=MainLogin')) return response(200, eduLogin);
        if (url.endsWith('akcia=getToken')) return response(200, rpc({ token: 'synthetic-token' }));
        return response(status, '', '/user/?eqa=must-not-be-requested');
      },
    });
    await assert.rejects(auth.authenticate('edupage'), (error) => {
      assert.equal(error.code, 'PAGE_CHANGED');
      assert.equal(error.diagnostic.reason, [307, 308].includes(status) ? 'post-replay-blocked' : 'unexpected-http-redirect');
      assert.equal(error.diagnostic.status, status);
      return true;
    });
    assert.deepEqual(calls.map(({ method }) => method), ['GET', 'POST', 'POST']);
  }
});

test('an existing queried portal session is canonicalized to fixed verification without credentials', async () => {
  const calls = [];
  const auth = new SchoolAuthenticator({
    getCredential: async () => ({ username: 'student', password: 'must-not-submit', autoLogin: true }),
    fetch: async (site, url, options) => {
      calls.push({ url, method: options.method, body: options.body });
      if (url.endsWith('/login/?cmd=MainLogin')) return response(302, '', '/user/?eqa=existing-session');
      if (url.endsWith('/user')) return response(200, eduSession);
      throw new Error(`unexpected ${url}`);
    },
  });
  assert.deepEqual(await auth.authenticate('edupage'), { site: 'edupage', authenticated: true });
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname + new URL(url).search), [
    '/login/?cmd=MainLogin', '/user',
  ]);
  assert.equal(calls.every(({ method, body }) => method === 'GET' && body === undefined), true);
});

test('account invalidation after credential response prevents verification under a new generation', async () => {
  let releasePost;
  const postGate = new Promise((resolve) => { releasePost = resolve; });
  const calls = [];
  const auth = new SchoolAuthenticator({
    getCredential: async () => ({ username: 'student', password: 'synthetic', autoLogin: true, revision: '1' }),
    fetch: async (site, url, options) => {
      calls.push({ url, method: options.method });
      if (url.endsWith('/login/?cmd=MainLogin')) return response(200, eduLogin);
      if (url.endsWith('akcia=getToken')) return response(200, rpc({ token: 'synthetic-token' }));
      if (url.endsWith('akcia=login')) { await postGate; return response(200, rpc({ status: 'OK', redirectUrl: '/user/?eqa=old-account' })); }
      throw new Error(`unexpected ${url}`);
    },
  });
  const pending = auth.authenticate('edupage');
  await new Promise((resolve) => setImmediate(resolve));
  auth.invalidate('edupage');
  releasePost();
  await assert.rejects(pending, { code: 'SESSION_INVALIDATED' });
  assert.deepEqual(calls.map(({ method }) => method), ['GET', 'POST', 'POST']);
});

test('response read failures are translated to a plain safe error', async () => {
  const auth = new SchoolAuthenticator({
    getCredential: async () => ({ username: 'student', password: 'synthetic', autoLogin: true }),
    fetch: async () => ({
      status: 200,
      headers: new Headers(),
      url: '',
      text: async () => { throw new Error('URL_NOT_ALLOWED https://secret.invalid/?password=leak'); },
    }),
  });
  await assert.rejects(auth.authenticate('edupage'), (error) => {
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.equal(error.message, '学校登录响应读取失败，请稍后重试');
    assert.deepEqual(error.diagnostic, {
      site: 'edupage', phase: 'response-body', reason: 'read-failed',
    });
    assert.doesNotMatch(JSON.stringify(error), /secret|password|https?:|URL_NOT_ALLOWED/i);
    return true;
  });
});

test('malformed redirect locations fail closed without exposing parser details', async () => {
  const auth = new SchoolAuthenticator({
    getCredential: async () => ({ username: 'student', password: 'synthetic', autoLogin: true }),
    fetch: async (site, url) => {
      if (url.endsWith('/login/?cmd=MainLogin')) return response(200, eduLogin);
      if (url.endsWith('akcia=getToken')) return response(200, rpc({ token: 'synthetic-token' }));
      return response(200, rpc({ status: 'OK', redirectUrl: 'https://[' }));
    },
  });
  await assert.rejects(auth.authenticate('edupage'), (error) => {
    assert.equal(error.code, 'PAGE_CHANGED');
    assert.equal(error.message, '学校登录返回了无法识别的跳转，请在内置网页完成登录');
    assert.deepEqual(error.diagnostic, {
      site: 'edupage', phase: 'login-redirect', reason: 'invalid-location',
    });
    assert.doesNotMatch(error.message, /invalid|url|https?:/i);
    return true;
  });
});

test('a 200 response without a stable logged-in marker is rejected', async () => {
  const auth = new SchoolAuthenticator({
    getCredential: async () => ({ username: 'student', password: 'synthetic', autoLogin: true }),
    fetch: async (site, url) => {
      if (url.endsWith('/login')) return response(200, mbForm());
      if (url.endsWith('/sessions')) return response(200, '<html><h1>Welcome</h1></html>');
      if (url.endsWith('/student')) return response(200, '<html><h1>Welcome</h1></html>');
      throw new Error(`unexpected ${url}`);
    },
  });
  await assert.rejects(auth.authenticate('managebac'), { code: 'LOGIN_REQUIRED' });
});

test('EduPage falls back to the legacy form only before a password-bearing RPC', async () => {
  const calls = [];
  const auth = new SchoolAuthenticator({
    getCredential: async () => ({ username: 'student', password: 'legacy-synthetic', autoLogin: true }),
    fetch: async (site, url, options) => {
      calls.push({ url, method: options.method, body: options.body });
      if (url.endsWith('/login/?cmd=MainLogin')) return response(200, eduLogin);
      if (url.endsWith('akcia=getToken')) return response(200, 'legacy-server-without-rpc');
      if (url.endsWith('/login/edubarLogin.php')) return response(302, '', '/user/?eqa=legacy-ticket');
      if (url.endsWith('/user')) return response(200, eduSession);
      throw new Error(`unexpected ${url}`);
    },
  });
  await auth.authenticate('edupage');
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname + new URL(url).search), [
    '/login/?cmd=MainLogin',
    '/login/?cmd=MainLogin&akcia=getToken',
    '/login/edubarLogin.php',
    '/user',
  ]);
  assert.equal(calls[1].body.includes('legacy-synthetic'), false);
  assert.equal(new URLSearchParams(calls[2].body).get('password'), 'legacy-synthetic');
});

test('EduPage treats a missing getToken endpoint as a pre-password capability fallback', async () => {
  const calls = [];
  const auth = new SchoolAuthenticator({
    getCredential: async () => ({ username: 'student', password: 'legacy-synthetic', autoLogin: true }),
    fetch: async (site, url, options) => {
      calls.push({ url, method: options.method });
      if (url.endsWith('/login/?cmd=MainLogin')) return response(200, eduLogin);
      if (url.endsWith('akcia=getToken')) return response(404, 'not found');
      if (url.endsWith('/login/edubarLogin.php')) return response(200, eduSession);
      throw new Error(`unexpected ${url}`);
    },
  });
  await auth.authenticate('edupage');
  assert.equal(calls.filter(({ method }) => method === 'POST').length, 2);
  assert.equal(calls.some(({ url }) => url.endsWith('akcia=login')), false);
});

test('an RPC credential failure never triggers a second legacy password POST', async () => {
  const calls = [];
  const auth = new SchoolAuthenticator({
    getCredential: async () => ({ username: 'student', password: 'wrong-synthetic', autoLogin: true }),
    fetch: async (site, url, options) => {
      calls.push({ url, method: options.method });
      if (url.endsWith('/login/?cmd=MainLogin')) return response(200, eduLogin);
      if (url.endsWith('akcia=getToken')) return response(200, rpc({ token: 'synthetic-token' }));
      if (url.endsWith('akcia=login')) return response(200, rpc({ status: 'FAIL', err: { error_id: 'bad_login', error_text: 'untrusted text' } }));
      throw new Error(`unexpected ${url}`);
    },
  });
  await assert.rejects(auth.authenticate('edupage'), (error) => {
    assert.equal(error.code, 'LOGIN_REQUIRED');
    assert.match(error.message, /账号或密码/);
    assert.doesNotMatch(error.message, /untrusted/);
    return true;
  });
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname + new URL(url).search), [
    '/login/?cmd=MainLogin',
    '/login/?cmd=MainLogin&akcia=getToken',
    '/login/?cmd=MainLogin&akcia=login',
  ]);
});

test('manual credential intent is propagated but cannot bypass cooldown; first failure survives', async () => {
  let now = 100000;
  let posts = 0;
  const intents = [];
  const auth = new SchoolAuthenticator({
    now: () => now,
    cooldownMs: 60000,
    getCredential: async (site, options) => {
      intents.push({ site, manual: options.manual });
      return { username: 'student', password: 'synthetic', autoLogin: true };
    },
    fetch: async (site, url) => {
      if (url.endsWith('/login')) return response(200, mbForm());
      if (url.endsWith('/sessions')) {
        posts += 1;
        return posts === 1 ? response(302, '', '/login') : response(302, '', '/student');
      }
      if (url.endsWith('/student')) return response(200, mbSession);
      throw new Error(`unexpected ${url}`);
    },
  });
  await assert.rejects(auth.authenticate('managebac', { manual: true }), { code: 'LOGIN_REQUIRED' });
  assert.deepEqual(intents, [
    { site: 'managebac', manual: true },
    { site: 'managebac', manual: true },
  ]);
  now += 1000;
  await assert.rejects(auth.authenticate('managebac', { manual: true }), (error) => {
    assert.equal(error.code, 'LOGIN_COOLDOWN');
    assert.match(error.message, /账号或密码/);
    assert.equal(error.diagnostic.remainingSeconds, 59);
    assert.equal(error.diagnostic.previousCode, 'LOGIN_REQUIRED');
    return true;
  });
  assert.equal(intents.length, 2, 'cooldown is checked before reading even manual credentials');
  now += 59000;
  await auth.authenticate('managebac');
  now += 1000;
  await assert.rejects(auth.authenticate('managebac'), (error) => {
    assert.equal(error.code, 'LOGIN_COOLDOWN');
    assert.doesNotMatch(error.message, /账号或密码/);
    assert.equal(error.diagnostic.previousCode, undefined, 'success clears the remembered failure');
    return true;
  });
});

test('EduPage RPC ticket navigation rejects unknown same-origin paths without requesting them', async () => {
  const calls = [];
  const auth = new SchoolAuthenticator({
    getCredential: async () => ({ username: 'student', password: 'synthetic', autoLogin: true }),
    fetch: async (site, url) => {
      calls.push(url);
      if (url.endsWith('/login/?cmd=MainLogin')) return response(200, eduLogin);
      if (url.endsWith('akcia=getToken')) return response(200, rpc({ token: 'synthetic-token' }));
      return response(200, rpc({ status: 'OK', redirectUrl: '/dashboard/?eqa=must-not-be-requested' }));
    },
  });
  await assert.rejects(auth.authenticate('edupage'), { code: 'URL_NOT_ALLOWED' });
  assert.equal(calls.some((url) => url.includes('/dashboard/')), false);
});

test('EduPage RPC accepts a server-minted root continuation with bounded opaque query fields', async () => {
  const calls = [];
  const auth = new SchoolAuthenticator({
    getCredential: async () => ({ username: 'student', password: 'synthetic', autoLogin: true }),
    fetch: async (site, url) => {
      calls.push(url);
      if (url.endsWith('/login/?cmd=MainLogin')) return response(200, eduLogin);
      if (url.endsWith('akcia=getToken')) return response(200, rpc({ token: 'synthetic-token' }));
      if (url.endsWith('akcia=login')) return response(200, rpc({ status: 'OK', redirectUrl: '/?opaque_name=opaque-value' }));
      if (url.endsWith('/?opaque_name=opaque-value')) return response(302, '', '/user/?server_step=2');
      if (url.endsWith('/user/?server_step=2')) return response(302, '', '/user');
      if (url.endsWith('/user')) return response(200, eduSession);
      throw new Error(`unexpected ${url}`);
    },
  });
  await auth.authenticate('edupage');
  assert.deepEqual(calls.slice(3).map((url) => new URL(url).pathname + new URL(url).search), [
    '/?opaque_name=opaque-value', '/user/?server_step=2', '/user',
  ]);
});

test('EduPage RPC accepts an edubarLogin GET continuation without replaying the password POST', async () => {
  const calls = [];
  const auth = new SchoolAuthenticator({
    getCredential: async () => ({ username: 'student', password: 'synthetic', autoLogin: true }),
    fetch: async (site, url, options) => {
      calls.push({ url, method: options.method, body: options.body });
      if (url.endsWith('/login/?cmd=MainLogin')) return response(200, eduLogin);
      if (url.endsWith('akcia=getToken')) return response(200, rpc({ token: 'synthetic-token' }));
      if (url.endsWith('akcia=login')) return response(200, rpc({ status: 'OK', redirectUrl: '/login/edubarLogin.php?gu=opaque-gu&au=opaque-au' }));
      if (url.includes('/login/edubarLogin.php?')) return response(302, '', '/user');
      if (url.endsWith('/user')) return response(200, eduSession);
      throw new Error(`unexpected ${url}`);
    },
  });
  await auth.authenticate('edupage');
  const continuation = calls.find(({ url }) => url.includes('/login/edubarLogin.php?'));
  assert.deepEqual({ method: continuation.method, body: continuation.body }, { method: 'GET', body: undefined });
  assert.equal(calls.filter(({ method }) => method === 'POST').length, 2);
});

test('EduPage RPC continuation bounds reject excessive parameters, length and decoded controls before GET', async () => {
  const tickets = [
    `/?${Array.from({ length: 33 }, (_, index) => `p${index}=x`).join('&')}`,
    `/?ticket=${'x'.repeat(8192)}`,
    '/?ticket=%00hidden',
    '/login/%00hidden',
  ];
  for (const redirectUrl of tickets) {
    const calls = [];
    const auth = new SchoolAuthenticator({
      getCredential: async () => ({ username: 'student', password: 'synthetic', autoLogin: true }),
      fetch: async (site, url) => {
        calls.push(url);
        if (url.endsWith('/login/?cmd=MainLogin')) return response(200, eduLogin);
        if (url.endsWith('akcia=getToken')) return response(200, rpc({ token: 'synthetic-token' }));
        return response(200, rpc({ status: 'OK', redirectUrl }));
      },
    });
    await assert.rejects(auth.authenticate('edupage'), { code: 'URL_NOT_ALLOWED' });
    assert.equal(calls.length, 3, 'invalid continuation is rejected before its GET');
  }
});

test('cooldown never remembers an unknown exception message as the first failure', async () => {
  let now = 100000;
  const auth = new SchoolAuthenticator({
    now: () => now,
    cooldownMs: 60000,
    getCredential: async () => ({ username: 'student', password: 'synthetic', autoLogin: true }),
    fetch: async (site, url) => {
      if (url.endsWith('/login/?cmd=MainLogin')) return response(200, eduLogin);
      if (url.endsWith('akcia=getToken')) return response(200, rpc({ token: 'synthetic-token' }));
      return { status: 200, url: '', headers: { get() { throw new Error('unknown-provider-secret'); } } };
    },
  });
  await assert.rejects(auth.authenticate('edupage'), /unknown-provider-secret/);
  now += 1000;
  await assert.rejects(auth.authenticate('edupage'), (error) => {
    assert.equal(error.code, 'LOGIN_COOLDOWN');
    assert.doesNotMatch(error.message, /unknown-provider-secret/);
    assert.equal(error.diagnostic.previousCode, undefined);
    return true;
  });
});

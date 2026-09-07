// This real-Electron fixture uses loopback-only servers and a temporary profile.
// It never sends school credentials or contacts an external network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { inflateRawSync } = require('node:zlib');
const { createSchoolFetch, MAX_RESPONSE_BYTES } = require('../electron/school-transport.cjs');
const { SchoolDataClient } = require('../electron/school-data.cjs');
const { SchoolAuthenticator } = require('../electron/school-auth.cjs');

const childMode = Boolean(process.versions.electron) && process.argv.includes('--school-transport-child');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function readForm(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.once('end', () => resolve(new URLSearchParams(body)));
    request.once('error', reject);
  });
}

function decodeRpcParameters(form) {
  const eqap = form.get('eqap') || '';
  assert.ok(eqap.startsWith('dz:'));
  assert.equal(form.get('eqaz'), '1');
  assert.equal(form.get('eqacs'), createHash('sha1').update(eqap).digest('hex'));
  const encoded = inflateRawSync(Buffer.from(eqap.slice(3), 'base64')).toString('utf8');
  return JSON.parse(new URLSearchParams(encoded).get('rpcparams'));
}

function eqz(value) {
  return `eqz:${Buffer.from(JSON.stringify(value), 'utf8').toString('base64')}`;
}

if (childMode) {
  const { app, net, session } = require('electron');
  const profile = process.env.PH_SCHOOL_TRANSPORT_TEST_PROFILE;
  assert.ok(profile);
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  app.disableHardwareAcceleration();
  const deadline = setTimeout(() => app.exit(2), 20000);

  app.whenReady().then(async () => {
    let externalHits = 0;
    let queriedAuthLandingHits = 0;
    const fixedAuthUserCookieStates = [];
    let rpcTicketHits = 0;
    const rpcFixedUserCookieStates = [];
    const rpcChecks = {
      initialGet: false, tokenCookie: false, tokenHeader: false, tokenBody: false,
      loginCookie: false, loginHeader: false, loginBody: false,
    };
    const external = http.createServer((request, response) => {
      externalHits += 1;
      response.writeHead(200); response.end('must not be reached');
    });
    const externalPort = await listen(external);
    const local = http.createServer((request, response) => {
      if (request.url === '/auth/login/?cmd=MainLogin') { response.writeHead(200); response.end('<input name="csrfauth" value="synthetic-csrf">'); return; }
      if (request.url === '/auth/login/edubarLogin.php') {
        let body = ''; request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
          const form = new URLSearchParams(body);
          if (form.get('username') !== 'synthetic-student' || form.get('password') !== 'synthetic-password' || form.get('csrfauth') !== 'synthetic-csrf') { response.writeHead(401); response.end(); return; }
          response.writeHead(302, { Location: '/user/?eqa=synthetic', 'Set-Cookie': 'synthetic_auth=present; Path=/; SameSite=Lax' }); response.end();
        }); return;
      }
      if (request.url === '/auth/user/?eqa=synthetic') {
        queriedAuthLandingHits += 1;
        response.writeHead(500); response.end('queried landing must not be requested'); return;
      }
      if (request.url === '/auth/user') {
        const hasPostCookie = request.headers.cookie?.includes('synthetic_auth=present') || false;
        fixedAuthUserCookieStates.push(hasPostCookie);
        if (!hasPostCookie) { response.writeHead(302, { Location: '/login/?cmd=MainLogin' }); response.end(); return; }
        response.writeHead(200); response.end('<script>userhome({"userid":"Student-synthetic","dbi":{},"userrow":{"TriedaID":-7}});</script>'); return;
      }
      if (request.url === '/rpc-auth/login/?cmd=MainLogin') {
        rpcChecks.initialGet = request.method === 'GET';
        response.writeHead(200, { 'Set-Cookie': 'rpc_bootstrap=present; Path=/; SameSite=Lax' });
        response.end('<script>window.bootstrap={"csrftoken":"rpc-csrf"};</script>'); return;
      }
      if (request.url === '/rpc-auth/login/?cmd=MainLogin&akcia=getToken') {
        readForm(request).then((form) => {
          rpcChecks.tokenCookie = request.headers.cookie?.includes('rpc_bootstrap=present') || false;
          rpcChecks.tokenHeader = request.method === 'POST'
            && request.headers['content-type'] === 'application/x-www-form-urlencoded'
            && /application\/json/.test(request.headers.accept || '');
          const params = decodeRpcParameters(form);
          rpcChecks.tokenBody = params.username === 'rpc-synthetic-student' && params.edupage === '';
          response.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Set-Cookie': 'rpc_token_stage=present; Path=/; SameSite=Lax',
          });
          response.end(eqz({ token: 'rpc-synthetic-token' }));
        }).catch((error) => { response.writeHead(400); response.end(String(error.message)); });
        return;
      }
      if (request.url === '/rpc-auth/login/?cmd=MainLogin&akcia=login') {
        readForm(request).then((form) => {
          const cookie = request.headers.cookie || '';
          rpcChecks.loginCookie = cookie.includes('rpc_bootstrap=present') && cookie.includes('rpc_token_stage=present');
          rpcChecks.loginHeader = request.method === 'POST'
            && request.headers['content-type'] === 'application/x-www-form-urlencoded'
            && /application\/json/.test(request.headers.accept || '');
          const params = decodeRpcParameters(form);
          rpcChecks.loginBody = params.username === 'rpc-synthetic-student'
            && params.password === 'rpc-synthetic-password'
            && params.userToken === 'rpc-synthetic-token'
            && params.edupage === '' && params.ctxt === ''
            && params.tu === null && params.gu === null && params.au === null;
          response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end(eqz({ status: 'OK', redirectUrl: '/user/?eqa=synthetic-ticket' }));
        }).catch((error) => { response.writeHead(400); response.end(String(error.message)); });
        return;
      }
      if (request.url === '/rpc-auth/user/?eqa=synthetic-ticket') {
        rpcTicketHits += 1;
        const cookie = request.headers.cookie || '';
        if (!cookie.includes('rpc_bootstrap=present') || !cookie.includes('rpc_token_stage=present')) {
          response.writeHead(401); response.end(); return;
        }
        response.writeHead(302, {
          Location: '/user',
          'Set-Cookie': 'rpc_authenticated=present; Path=/; SameSite=Lax',
        });
        response.end(); return;
      }
      if (request.url === '/rpc-auth/user') {
        const authenticated = request.headers.cookie?.includes('rpc_authenticated=present') || false;
        rpcFixedUserCookieStates.push(authenticated);
        if (!authenticated) { response.writeHead(302, { Location: '/login/?cmd=MainLogin' }); response.end(); return; }
        response.writeHead(200); response.end('<script>userhome({"userid":"Student-rpc-synthetic","dbi":{},"userrow":{"TriedaID":-8}});</script>'); return;
      }
      if (request.url === '/direct') { response.writeHead(200); response.end('direct'); return; }
      if (request.url === '/redirect') { response.writeHead(302, { Location: '/direct' }); response.end(); return; }
      if (request.url === '/user') { response.writeHead(302, { Location: '/user/' }); response.end(); return; }
      if (request.url === '/user/') { response.writeHead(200); response.end('synthetic user page'); return; }
      if (request.url === '/redirect-cookie') { response.writeHead(302, { Location: '/cookie', 'Set-Cookie': 'school_transport_cookie=present; Path=/; SameSite=Lax' }); response.end(); return; }
      if (request.url === '/empty') { response.writeHead(204); response.end(); return; }
      if (request.url === '/post') {
        let body = ''; request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => { response.writeHead(200); response.end(JSON.stringify({ method: request.method, contentType: request.headers['content-type'], body })); }); return;
      }
      if (request.url === '/external') { response.writeHead(302, { Location: `http://127.0.0.1:${externalPort}/probe` }); response.end(); return; }
      if (request.url === '/set-cookie') { response.writeHead(200, { 'Set-Cookie': 'school_transport_cookie=present; Path=/; SameSite=Lax' }); response.end('set'); return; }
      if (request.url === '/cookie') { response.writeHead(request.headers.cookie?.includes('school_transport_cookie=present') ? 200 : 401); response.end('cookie'); return; }
      if (request.url === '/slow') { setTimeout(() => { response.writeHead(200); response.end('slow'); }, 1000); return; }
      if (request.url === '/large') {
        response.writeHead(200, { 'Transfer-Encoding': 'chunked' });
        for (let index = 0; index < 8; index += 1) response.write(Buffer.alloc(1024 * 1024));
        response.end(Buffer.alloc(1));
        return;
      }
      response.writeHead(404); response.end();
    });
    const localPort = await listen(local);
    const base = `http://127.0.0.1:${localPort}`;
    const fixtureSession = session.fromPartition(`school-transport-${process.pid}`);
    const schoolFetch = createSchoolFetch({ net, getSession: () => fixtureSession });
    try {
      const direct = await schoolFetch('fixture', `${base}/direct`, { redirect: 'manual' });
      assert.equal(direct.status, 200); assert.equal(await direct.text(), 'direct');

      const redirected = await schoolFetch('fixture', `${base}/redirect`, { redirect: 'manual' });
      assert.equal(redirected.status, 302); assert.equal(redirected.headers.get('location'), '/direct');

      const client = new SchoolDataClient({ fetch: (site, url, init) => schoolFetch(site, `${base}${new URL(url).pathname}`, init) });
      assert.equal(await client.request('edupage', '/user'), 'synthetic user page');
      assert.equal((await schoolFetch('fixture', `${base}/empty`)).status, 204);
      const posted = await schoolFetch('fixture', `${base}/post`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'synthetic=hello%20world' });
      assert.deepEqual(await posted.json(), { method: 'POST', contentType: 'application/x-www-form-urlencoded', body: 'synthetic=hello%20world' });
      assert.equal((await schoolFetch('fixture', `${base}/redirect-cookie`)).status, 302);
      assert.equal((await schoolFetch('fixture', `${base}/cookie`)).status, 200, 'login redirect cookies must survive manual redirect');

      assert.equal((await schoolFetch('fixture', `${base}/set-cookie`)).status, 200);
      assert.equal((await schoolFetch('fixture', `${base}/cookie`)).status, 200);

      const authFetch = (site, url, init) => { const parsed = new URL(url); return schoolFetch(site, `${base}/auth${parsed.pathname}${parsed.search}`, init); };
      const authenticatedReader = new SchoolDataClient({ fetch: authFetch });
      const auth = new SchoolAuthenticator({ fetch: authFetch, getCredential: () => ({ username: 'synthetic-student', password: 'synthetic-password', autoLogin: true }) });
      const authenticatedBody = await auth.withSession('edupage', () => authenticatedReader.request('edupage', '/user'));
      assert.match(authenticatedBody, /Student-synthetic/);
      assert.equal(queriedAuthLandingHits, 0, 'the queried post-auth landing target must never be requested');
      assert.deepEqual(fixedAuthUserCookieStates, [false, true, true], 'initial failure, fixed verification, then successful operation retry must share the POST cookie');

      const rpcSession = session.fromPartition(`school-transport-rpc-${process.pid}`);
      const rpcSchoolFetch = createSchoolFetch({ net, getSession: () => rpcSession });
      const rpcAuthFetch = (site, url, init) => { const parsed = new URL(url); return rpcSchoolFetch(site, `${base}/rpc-auth${parsed.pathname}${parsed.search}`, init); };
      const rpcReader = new SchoolDataClient({ fetch: rpcAuthFetch });
      const rpcAuth = new SchoolAuthenticator({
        fetch: rpcAuthFetch,
        getCredential: () => ({ username: 'rpc-synthetic-student', password: 'rpc-synthetic-password', autoLogin: true }),
      });
      const rpcAuthenticatedBody = await rpcAuth.withSession('edupage', () => rpcReader.request('edupage', '/user'));
      assert.match(rpcAuthenticatedBody, /Student-rpc-synthetic/);
      assert.equal(rpcTicketHits, 1, 'the RPC redirectUrl ticket must be requested exactly once');
      assert.deepEqual(rpcFixedUserCookieStates, [false, true, true], 'RPC identity exists only after the ticket GET, then fixed verification and operation retry share it');
      assert.deepEqual(rpcChecks, {
        initialGet: true, tokenCookie: true, tokenHeader: true, tokenBody: true,
        loginCookie: true, loginHeader: true, loginBody: true,
      });

      const controller = new AbortController();
      const pending = schoolFetch('fixture', `${base}/slow`, { signal: controller.signal });
      setTimeout(() => controller.abort(), 20);
      await assert.rejects(pending, (error) => error?.name === 'AbortError');

      await assert.rejects(schoolFetch('fixture', `${base}/large`), (error) => error?.code === 'BODY_TOO_LARGE');

      const externalRedirect = await schoolFetch('fixture', `${base}/external`, { redirect: 'manual' });
      assert.equal(externalRedirect.status, 302);
      assert.equal(externalHits, 0);
      process.stdout.write(`PH_SCHOOL_TRANSPORT_REPORT=${JSON.stringify({ ok: true, direct200: true, manual302: true, cookieRoundTrip: true, authQueriedLandingContacted: queriedAuthLandingHits, authFixedUserCookieStates: fixedAuthUserCookieStates, authRetrySucceeded: true, rpcTicketContacted: rpcTicketHits, rpcFixedUserCookieStates, rpcChecks, rpcRetrySucceeded: true, abort: true, bodyLimit: MAX_RESPONSE_BYTES, externalRedirectContacted: externalHits })}\n`);
      app.exit(0);
    } finally {
      local.close(); external.close(); clearTimeout(deadline);
    }
  }).catch(() => {
    process.stderr.write('School transport Electron fixture failed.\n');
    app.exit(1);
  });
} else {
  const test = require('node:test');
  const { spawn } = require('node:child_process');
  test('real Electron school transport returns manual redirects without following them', { timeout: 30000 }, async (t) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-school-transport-'));
    t.after(() => {
      const resolved = path.resolve(profile);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('ph-school-transport-'));
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const environment = { ...process.env, PH_SCHOOL_TRANSPORT_TEST_PROFILE: profile };
    delete environment.ELECTRON_RUN_AS_NODE;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(require('electron'), [__filename, '--school-transport-child'], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('School transport Electron fixture timed out')); }, 25000);
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    assert.equal(result.code, 0, `Electron school transport fixture exited ${result.code}; report: ${result.stdout.match(/PH_SCHOOL_TRANSPORT_REPORT=.*/)?.[0] || 'unavailable'}`);
    const line = result.stdout.split(/\r?\n/).find((value) => value.startsWith('PH_SCHOOL_TRANSPORT_REPORT='));
    assert.ok(line, 'Electron did not produce a school transport report');
    assert.deepEqual(JSON.parse(line.slice('PH_SCHOOL_TRANSPORT_REPORT='.length)), {
      ok: true, direct200: true, manual302: true, cookieRoundTrip: true, abort: true,
      authQueriedLandingContacted: 0, authFixedUserCookieStates: [false, true, true],
      authRetrySucceeded: true, bodyLimit: MAX_RESPONSE_BYTES, externalRedirectContacted: 0,
      rpcTicketContacted: 1, rpcFixedUserCookieStates: [false, true, true],
      rpcChecks: {
        initialGet: true, tokenCookie: true, tokenHeader: true, tokenBody: true,
        loginCookie: true, loginHeader: true, loginBody: true,
      },
      rpcRetrySucceeded: true,
    });
  });
}

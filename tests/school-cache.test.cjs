const test = require('node:test');
const assert = require('node:assert/strict');
const { SchoolCache } = require('../electron/school-cache.cjs');
const { SchoolDataError } = require('../electron/school-data.cjs');
const week = '2026-09-07';
const next = '2026-09-14';
const fixture = (weekStart = week, accountKey = 'a') => ({ source: 'edupage', weekStart, accountKey, lessons: [], fetchedAt: '2026-09-06T10:00:00Z' });

test('cache reuses fresh data, refetches expired data, and coalesces concurrent requests', async () => {
  let time = 0; let requests = 0;
  const cache = new SchoolCache({ now: () => time });
  const operation = async () => { requests += 1; return fixture(); };
  await Promise.all([cache.sync('edupage', { weekStart: week }, operation), cache.sync('edupage', { weekStart: week }, operation)]);
  assert.equal(requests, 1);
  await cache.sync('edupage', { weekStart: week, force: false }, operation);
  assert.equal(requests, 1);
  time += 120001;
  await cache.sync('edupage', { weekStart: week, force: false }, operation);
  assert.equal(requests, 2);
});
test('temporary failures keep verified cached content; expired login removes it', async () => {
  const cache = new SchoolCache();
  await cache.sync('edupage', { weekStart: week }, async () => fixture());
  await assert.rejects(cache.sync('edupage', { weekStart: week }, async () => { throw new SchoolDataError('NETWORK_ERROR', '暂时离线'); }));
  assert.equal(cache.snapshot().edupage.accountKey, 'a');
  assert.equal(cache.snapshot().status.edupage.state, 'stale');
  await assert.rejects(cache.sync('edupage', { weekStart: week }, async () => { throw new SchoolDataError('LOGIN_REQUIRED', '请重新登录'); }));
  assert.equal(cache.snapshot().edupage, null);
});
test('switching weeks cannot be overwritten by late results', async () => {
  const cache = new SchoolCache(); let resolve;
  const promise = cache.sync('edupage', { weekStart: week }, () => new Promise((r) => { resolve = r; }));
  await Promise.resolve();
  await cache.sync('edupage', { weekStart: next }, async () => fixture(next));
  resolve(fixture()); await promise;
  assert.equal(cache.snapshot().edupage.weekStart, next);
  assert.equal(cache.snapshot({ weekStart: week }).edupage.weekStart, week);
});
test('account invalidation rejects in-flight results and clears all old weeks', async () => {
  const cache = new SchoolCache(); let resolve;
  const promise = cache.sync('edupage', { weekStart: week }, () => new Promise((r) => { resolve = r; }));
  await Promise.resolve(); cache.invalidate('edupage'); resolve(fixture());
  await assert.rejects(promise, { code: 'ACCOUNT_CHANGED' });
  assert.equal(cache.snapshot().edupage, null);
  await cache.sync('edupage', { weekStart: week }, async () => fixture());
  await cache.sync('edupage', { weekStart: next }, async () => fixture(next, 'b'));
  assert.equal(cache.snapshot({ weekStart: week }).edupage, null);
  assert.equal(cache.snapshot({ weekStart: next }).edupage.accountKey, 'b');
});
test('snapshot input rejects invalid dates and sources', async () => {
  const cache = new SchoolCache();
  assert.throws(() => cache.snapshot({ weekStart: '2026-02-31' }), { code: 'INVALID_DATE' });
  await assert.rejects(cache.sync('__proto__', {}, async () => ({})), { code: 'INVALID_SOURCE' });
});

test('expired old account is removed before a failed automatic relogin', async () => {
  const { SchoolAuthenticator } = require('../electron/school-auth.cjs');
  const cache = new SchoolCache();
  await cache.sync('edupage', { weekStart: week }, async () => fixture());
  const auth = new SchoolAuthenticator({
    getCredential: () => ({ username: 'new-synthetic-account', password: 'synthetic-only', autoLogin: true }),
    fetch: async () => {
      assert.equal(cache.snapshot().edupage, null, 'old account must be gone before a new login starts');
      throw new Error('synthetic offline');
    },
  });
  await assert.rejects(auth.withSession('edupage', () => cache.sync('edupage', { weekStart: week }, async () => {
    throw new SchoolDataError('LOGIN_REQUIRED', '登录过期');
  })), { code: 'NETWORK_ERROR' });
  assert.equal(cache.snapshot().edupage, null);
});


test('partial assignments retain same-account cached tasks, but confirmed empty and new accounts do not', async () => {
  const cache = new SchoolCache();
  const snapshot = (extra = {}) => ({ source: 'managebac', accountKey: 'a', fetchedAt: new Date().toISOString(), tasks: [], taskFailedCourses: [], ...extra });
  const old = { id:'21:1', courseId:'21', title:'Old work' };
  await cache.sync('managebac', {}, async () => snapshot({tasks:[old]}));
  const partial = await cache.sync('managebac', {}, async () => snapshot({taskFailedCourses:['21']}));
  assert.equal(partial.tasks[0].stale,true);
  const empty = await cache.sync('managebac', {}, async () => snapshot());
  assert.equal(empty.tasks.length,0);
  await cache.sync('managebac', {}, async () => snapshot({tasks:[old]}));
  const other = await cache.sync('managebac', {}, async () => snapshot({accountKey:'b',taskFailedCourses:['21']}));
  assert.equal(other.tasks.length,0);
});

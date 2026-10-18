const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { SchoolAuthError } = require('../electron/school-auth.cjs');
const { SchoolDataError } = require('../electron/school-data.cjs');
const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');

function fixture(authenticate = async () => {}) {
  const calls = [];
  const attempts = [];
  const context = vm.createContext({
    taskUploadInFlight: false,
    rememberSchoolAttempt: (site) => attempts.push(site),
    SchoolAuthError, SchoolDataError, schoolSessionMutations: new Set(),
    invalidateSchoolSnapshots: () => calls.push('invalidate'),
    schoolAuthenticator: { authenticate: async (site, options) => { calls.push(['authenticate', site, options.manual]); await authenticate(); }, withSession: () => { throw new Error('must not log in a second time'); } },
    schoolState: { key: (site, week) => { if (site === 'edupage' && week !== '2026-09-07') throw new Error('invalid date'); }, sync: async (site, options, operation) => { calls.push(['sync', site, options.force]); return operation(); } },
    schoolClient: { syncEduPage: async () => { calls.push('read'); return {}; }, syncManageBac: async () => ({}) },
    SITES: { edupage: { partition: 'fixture' }, managebac: { partition: 'fixture2' } },
    session: { fromPartition: (id) => id }, siteStoragePersistence: { schedule: () => calls.push('flush') },
    schoolSnapshot: () => ({ epochs: { edupage: 2 } }),
    // 同步结果要写进共用文件：这个函数定义在 loginSchoolAccount 之前，
    // 不在下面的切片里，所以在这里打桩并记录调用顺序。
    publishSchoolSnapshot: (site) => calls.push(['publish', site]),
    // applySharedLessonSelection 与 loginSchoolAccount 在同一段切片里（真身会跑），
    // 没有课表缓存时它立刻返回 0，不会写任何偏好。
    schoolCache: { edupage: null },
    console,
  });
  vm.runInContext(source.slice(source.indexOf('function assertSchoolSessionReady('), source.indexOf('function readSchoolDetail(')), context);
  vm.runInContext(source.slice(source.indexOf('async function loginSchoolAccount('), source.indexOf('function updateSchoolPreferences(')), context);
  return { calls, attempts, context, run: (site = 'edupage', options = { weekStart: '2026-09-07' }) => context.loginSchoolAccount(site, options) };
}

function attemptFixture(records) {
  const context = vm.createContext({
    createHash: require('node:crypto').createHash,
    credentialVault: { getForFill: (site) => records[site] || null },
  });
  vm.runInContext(source.slice(source.indexOf('const attemptedSchoolAccounts'), source.indexOf('function syncSchoolAfterAccountsArrived(')), context);
  return context;
}

test('a submitted school password is never auto-submitted again until the account or password changes', () => {
  const records = { edupage: { username: 'student@example.test', password: 'wrong-1' }, managebac: { username: 'student@example.test', password: '' } };
  const context = attemptFixture(records);
  // 没有密码的平台不算待同步
  assert.deepEqual([...context.pendingSchoolAccounts()], ['edupage']);
  // 提交过一次（失败也算）之后，后续每轮 phix 同步都不能再交同一份密码
  context.rememberSchoolAttempt('edupage');
  assert.deepEqual([...context.pendingSchoolAccounts()], []);
  assert.deepEqual([...context.pendingSchoolAccounts()], []);
  // 任一端改了密码 → 允许再试一次
  records.edupage = { ...records.edupage, password: 'fixed-2' };
  assert.deepEqual([...context.pendingSchoolAccounts()], ['edupage']);
  // 指纹只在内存里，不含明文密码
  context.rememberSchoolAttempt('edupage');
  assert.doesNotMatch(JSON.stringify(vm.runInContext('[...attemptedSchoolAccounts.values()]', context)), /fixed-2|wrong-1/);
});

test('explicit account login locks session changes, authenticates once, then reads without automatic second login', async () => {
  let finish;
  const f = fixture(() => new Promise((resolve) => { finish = resolve; }));
  const pending = f.run();
  assert.throws(() => f.context.assertSchoolSessionReady('edupage'), /正在更新/);
  finish();
  assert.equal((await pending).ok, true);
  assert.deepEqual(f.calls, ['invalidate', ['authenticate', 'edupage', true], 'invalidate', ['sync', 'edupage', true], 'read', 'flush', ['publish', 'edupage']]);
  assert.deepEqual(f.attempts, ['edupage']);
});

test('direct login validates source/date before touching credentials', async () => {
  const f = fixture();
  await assert.rejects(f.run('mail'), /未知学校账号/);
  await assert.rejects(f.run('edupage', {}), /invalid date/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.attempts.length, 0);
});

test('direct login preserves typed first failure and never leaks unknown provider errors', async () => {
  const known = fixture(async () => { throw new SchoolAuthError('LOGIN_REQUIRED', '账号或密码未通过验证'); });
  assert.equal((await known.run()).error.message, '账号或密码未通过验证');
  assert.equal(known.calls.some((item) => Array.isArray(item) && item[0] === 'sync'), false);
  const unknown = fixture(async () => { throw new Error('password=DO-NOT-EXPOSE'); });
  assert.doesNotMatch(JSON.stringify(await unknown.run()), /DO-NOT-EXPOSE|password/);
  assert.doesNotThrow(() => unknown.context.assertSchoolSessionReady('edupage'));
});

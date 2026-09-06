const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');

function fixture() {
  const handlers = new Map(); let saved = null; let invalidations = 0; let resolveClear; let rejectClear;
  const clearing = new Promise((resolve, reject) => { resolveClear = resolve; rejectClear = reject; });
  const context = vm.createContext({
    schoolSessionMutations: new Set(),
    invalidateSchoolSnapshots: () => { invalidations += 1; },
    assertMainRenderer: () => {},
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    credentialStatus: () => ({ sites: { edupage: { username: 'old-fixture', autoLogin: false } } }),
    credentialVault: { validateCredential: (input) => input, saveCredential: (input) => { saved = input; } },
    SITES: { edupage: {} }, disposeSiteView: () => {}, clearSiteStorage: () => clearing,
    publishCredentialChange: () => ({ saved: Boolean(saved) }),
  });
  vm.runInContext(main.slice(main.indexOf('function assertSchoolSessionReady('), main.indexOf('function readSchoolDetail(')), context);
  vm.runInContext(main.slice(main.indexOf("  ipcMain.handle('credentials:save'"), main.indexOf("  ipcMain.handle('credentials:remove'")), context);
  return { context, handlers, resolveClear, rejectClear, get saved() { return saved; }, get invalidations() { return invalidations; } };
}

test('account switch blocks new school work and commits credentials only after clearing old cookies', async () => {
  const f = fixture();
  const saving = f.handlers.get('credentials:save')({}, { siteId: 'edupage', username: 'new-fixture', password: 'synthetic', autoLogin: false });
  assert.equal(f.saved, null);
  assert.throws(() => vm.runInContext("assertSchoolSessionReady('edupage')", f.context), /正在更新/);
  assert.doesNotThrow(() => vm.runInContext("assertSchoolSessionReady('managebac')", f.context));
  f.resolveClear(); await saving;
  assert.equal(f.saved.username, 'new-fixture');
  assert.equal(f.invalidations, 2, 'invalidate before and after the async mutation');
  assert.doesNotThrow(() => vm.runInContext("assertSchoolSessionReady('edupage')", f.context));
});

test('failed cookie clearing does not activate new automatic-login credentials', async () => {
  const f = fixture();
  const saving = f.handlers.get('credentials:save')({}, { siteId: 'edupage', username: 'new-fixture', password: 'synthetic', autoLogin: true });
  f.rejectClear(new Error('fixture provider details'));
  await assert.rejects(saving, /本次账号修改未保存/);
  assert.equal(f.saved, null);
  assert.equal(f.invalidations, 2);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');

test('macOS diagnostic runs isolate real Keychain identity without changing ordinary launches', () => {
  const block = source.slice(source.indexOf("let headlessUserData = ''"), source.indexOf('// School portals'));
  for (const platform of ['darwin', 'win32']) {
    for (const headless of [true, false]) {
      const calls = [];
      vm.runInNewContext(block, {
        IS_HEADLESS: headless,
        IS_CAPTURE: false,
        CAPTURE_SITE: '',
        CAPTURE_KEEPS_PROFILE: false,
        process: { platform, argv: [] },
        fs: { mkdtempSync: () => '/tmp/ph-launcher-headless-fixture' },
        os: { tmpdir: () => '/tmp' },
        path: path.posix,
        app: { setName: (name) => calls.push(['name', name]), setPath: (...args) => calls.push(['path', ...args]) },
      });
      assert.deepEqual(calls.filter(([key]) => key === 'name'), headless && platform === 'darwin'
        ? [['name', 'PH Launcher Test ph-launcher-headless-fixture']] : []);
      assert.equal(calls.some(([key]) => key === 'path'), headless);
    }
  }
  assert.doesNotMatch(block, /mock-keychain|setUsePlainTextEncryption|delete-generic-password/);
});

test('only an explicit preview run may keep a real profile', () => {
  const block = source.slice(source.indexOf("let headlessUserData = ''"), source.indexOf('// School portals'));
  const calls = [];
  vm.runInNewContext(block, {
    IS_HEADLESS: true,
    IS_CAPTURE: true,
    CAPTURE_SITE: '',
    process: { platform: 'win32', argv: ['electron', '.', '--capture-ui', '--user-data-dir=/tmp/profile'] },
    fs: { mkdtempSync: () => '/tmp/ph-launcher-headless-fixture' },
    os: { tmpdir: () => '/tmp' },
    path: path.posix,
    app: { setName: (name) => calls.push(['name', name]), setPath: (...args) => calls.push(['path', ...args]) },
  });
  assert.equal(calls.length, 0, 'a preview with --user-data-dir keeps the requested profile');
  assert.match(source, /const CAPTURE_KEEPS_PROFILE = \(IS_CAPTURE \|\| Boolean\(CAPTURE_SITE\)\) && process\.argv\.some\(\(arg\) => arg\.startsWith\('--user-data-dir='\)\)/,
    'the escape hatch is limited to capture runs with an explicit profile');
});

test('self-test failures are bounded, diagnostic, and isolated from normal launches', () => {
  assert.match(source, /const SELF_TEST_TIMEOUT_MS = 90_000/);
  assert.match(source, /function armSelfTestTimeout\(\)[\s\S]*IS_SELF_TEST[\s\S]*setTimeout\(\(\) => failSelfTest/);
  assert.match(source, /function failSelfTest\(error\)[\s\S]*SELF_TEST_ERROR[\s\S]*app\.exit\(1\)/);
  assert.match(source, /if \(IS_SELF_TEST\) runSelfTest\(\)\.catch\(failSelfTest\)/);
  assert.match(source, /webContents\.on\('did-fail-load'[\s\S]*IS_SELF_TEST[\s\S]*failSelfTest/);
  assert.match(source, /webContents\.on\('render-process-gone'[\s\S]*IS_SELF_TEST[\s\S]*failSelfTest/);
  assert.match(source, /if \(!checks\.success\) throw new Error\('one or more self-test checks failed'\)/);
  assert.match(source, /SELF_TEST_STAGE \$\{stage\}/);
  assert.match(source, /selfTestStage\('app-ready'\);[\s\S]*armSelfTestTimeout\(\);[\s\S]*secureStore = new SecureStore/);
  assert.match(source, /function failSelfTest\(error\) \{\s*if \(!IS_SELF_TEST \|\| selfTestSettled\) return;/);
});

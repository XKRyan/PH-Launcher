const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(require.resolve('../src/app.js'), 'utf8');
const indexSource = fs.readFileSync(require.resolve('../src/index.html'), 'utf8');
const start = appSource.indexOf('async function saveCredentialFromDialog(event)');
const end = appSource.indexOf('\nasync function connectWithSavedCredential', start);
assert.ok(start >= 0 && end > start, 'credential submit handler must be present');
const submitHandler = appSource.slice(start, end);

function harness({ siteId = 'edupage', saveError, connectError, connected = true } = {}) {
  const nodes = Object.fromEntries([
    ['credentialRiskAccepted', { checked: true }],
    ['saveCredentialButton', { disabled: false, textContent: '保存并登录' }],
    ['credentialSiteId', { value: siteId }],
    ['credentialUsername', { value: 'student@example.test' }],
    ['credentialPassword', { value: 'fixture-secret' }],
    ['credentialAutoFill', { checked: true }],
    ['credentialAutoLogin', { checked: false }],
    ['credentialAuthcode', { value: 'fixture-authcode' }],
    ['credentialConnectStatus', { hidden: true, className: '', textContent: '' }],
    ['credentialDialog', { open: true, close() { this.open = false; } }],
  ]);
  const calls = [];
  const toasts = [];
  const context = {
    credentialSubmitInFlight: false,
    state: { credentialStatus: null },
    BUILTIN_SITE_META: { edupage: { name: 'EduPage' }, managebac: { name: 'ManageBac' }, mail: { name: '平和邮箱' } },
    $: (selector) => nodes[selector.slice(1)],
    renderCredentialSettings: () => calls.push('render'),
    toast: (message, type) => toasts.push({ message, type }),
    window: {
      ph: {
        credentials: {
          save: async (credential) => {
            calls.push('save');
            assert.equal(nodes.credentialPassword.value, '', 'password must clear before the save promise settles');
            if (saveError) throw new Error(saveError);
            return { supported: true, sites: { [siteId]: { saved: true } } };
          },
        },
      },
      schoolUI: {
        connect: async (id, options) => {
          calls.push('connect');
          assert.equal(id, siteId);
          assert.equal(options.approved, true);
          assert.equal(nodes.credentialAutoLogin.checked, false, 'one-time login must not enable auto-login');
          if (connectError) throw new Error(connectError);
          return connected;
        },
      },
      mailUI: {
        connect: async () => { calls.push('mail-connect'); return true; },
      },
    },
  };
  vm.runInNewContext(`${submitHandler}\nglobalThis.submitCredential = saveCredentialFromDialog;`, context);
  return { calls, context, nodes, toasts };
}

test('school account save clears the password, then connects once with explicit approval', async () => {
  const ui = harness();
  await ui.context.submitCredential({ preventDefault() {} });
  assert.deepEqual(ui.calls, ['save', 'render', 'connect']);
  assert.equal(ui.nodes.credentialPassword.value, '');
  assert.equal(ui.nodes.credentialAutoLogin.checked, false);
  assert.equal(ui.nodes.credentialDialog.open, false);
  assert.match(ui.toasts.at(-1).message, /已登录并同步/);
});

test('save failure is reported separately and never starts a school connection', async () => {
  const ui = harness({ saveError: '安全存储不可用' });
  await ui.context.submitCredential({ preventDefault() {} });
  assert.deepEqual(ui.calls, ['save']);
  assert.match(ui.toasts.at(-1).message, /无法保存账号：安全存储不可用/);
});

test('connection failure is reported after saving, without claiming a successful login', async () => {
  const ui = harness({ connectError: '登录已过期' });
  await ui.context.submitCredential({ preventDefault() {} });
  assert.deepEqual(ui.calls, ['save', 'render', 'connect']);
  assert.match(ui.toasts.at(-1).message, /账号已保存，但无法连接 EduPage：登录已过期/);
  assert.doesNotMatch(ui.toasts.map((entry) => entry.message).join('\n'), /已登录并同步/);
});

test('mail saves first, then hands off to the native mail client without schoolUI.connect', async () => {
  const ui = harness({ siteId: 'mail' });
  await ui.context.submitCredential({ preventDefault() {} });
  assert.deepEqual(ui.calls, ['save', 'render', 'mail-connect', 'render']);
  assert.match(ui.toasts.at(-1).message, /已登录并同步最近邮件/);
  assert.equal(ui.nodes.credentialConnectStatus.className, 'credential-connect-status ok');
});

test('app exposes the school account dialog and keeps automatic re-login opt-in', () => {
  assert.match(appSource, /window\.openSchoolAccount\s*=\s*openCredentialDialog/);
  assert.match(appSource, /autoLogin:\s*\$\('#credentialSiteId'\)\.value !== 'mail' && \$\('#credentialAutoLogin'\)\.checked/);
  assert.match(indexSource, /id="credentialAutoLogin" type="checkbox"\/>/);
});

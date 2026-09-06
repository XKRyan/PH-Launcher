const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { CREDENTIAL_ORIGINS, CREDENTIAL_ISOLATED_WORLD_ID, isCredentialUrlAllowed, credentialAutofillScript } = require('../electron/credential-autofill.cjs');

const credential = { username: 'fixture-student', password: 'fixture-secret' };

function pageFixture(options = {}) {
  class Input {
    constructor(values) {
      Object.assign(this, { type: 'text', name: '', id: '', autocomplete: '', placeholder: '', disabled: false, readOnly: false, isConnected: true, value: '', events: [], style: { display: 'block', visibility: 'visible', opacity: '1' }, attributes: {} }, values);
    }
    get value() { return this.storedValue || ''; }
    set value(value) { this.storedValue = value; }
    closest() { return this.inert ? {} : null; }
    getClientRects() { return this.noRect ? [] : [{ width: 120, height: 32 }]; }
    getAttribute(name) { return this.attributes[name] || null; }
    dispatchEvent(event) { this.events.push(event.type); }
  }
  const url = new URL(options.url || 'https://shph.managebac.cn/login');
  const form = { name: 'login', id: 'login-form', isConnected: true, action: new URL('/sessions', url).href, ...options.form };
  const username = new Input({ name: 'username', form, ...options.username });
  const password = new Input({ type: 'password', name: 'password', form, ...options.password });
  const extras = (options.extras || []).map((input) => new Input({ form, ...input }));
  const inputs = options.inputs || [username, password, ...extras];
  const buttons = options.buttons || [];
  const document = { baseURI: url.href, querySelectorAll: (selector) => selector === 'input' ? inputs : buttons };
  const window = { getComputedStyle: (input) => input.style };
  window.self = window;
  window.top = options.iframe ? {} : window;
  const context = { document, window, location: url, URL, HTMLInputElement: Input, Event: class Event { constructor(type) { this.type = type; } } };
  return { username, password, form, inputs, extras, context };
}

function execute(page, options = {}) {
  return JSON.parse(JSON.stringify(vm.runInNewContext(credentialAutofillScript('managebac', credential, options), page.context)));
}

test('only each exact approved HTTPS origin is authorized for its own credentials', () => {
  assert.ok(CREDENTIAL_ISOLATED_WORLD_ID > 0);
  assert.notEqual(CREDENTIAL_ISOLATED_WORLD_ID, 0);
  for (const [siteId, origin] of Object.entries(CREDENTIAL_ORIGINS)) {
    assert.equal(isCredentialUrlAllowed(siteId, `${origin}/login?next=home`), true);
    assert.equal(isCredentialUrlAllowed(siteId, `${origin}:443/login`), true);
    for (const rejected of [origin.replace('https:', 'http:'), `${origin}:8443/`, `${origin}.evil.test/`, origin.replace('https://', 'https://evil.'), origin.replace('https://', 'https://student:password@'), 'https://qiye.163.com/', 'https://other-school.edupage.org/', 'file:///C:/login.html', 'javascript:void(0)']) {
      assert.equal(isCredentialUrlAllowed(siteId, rejected), false, rejected);
    }
    for (const [otherSite, otherOrigin] of Object.entries(CREDENTIAL_ORIGINS)) {
      if (otherSite !== siteId) assert.equal(isCredentialUrlAllowed(siteId, otherOrigin), false);
    }
  }
  assert.equal(isCredentialUrlAllowed('constructor', 'https://example.test'), false);
  assert.equal(isCredentialUrlAllowed('custom', 'https://example.test'), false);
});

test('valid visible login form fills once, dispatches normal changes, and never submits', () => {
  const page = pageFixture();
  let submitted = false;
  page.form.submit = page.form.requestSubmit = () => { submitted = true; };
  assert.deepEqual(execute(page), { filled: true });
  assert.equal(page.username.value, credential.username);
  assert.equal(page.password.value, credential.password);
  assert.deepEqual(page.username.events, ['input', 'change']);
  assert.deepEqual(page.password.events, ['input', 'change']);
  assert.equal(submitted, false);
  assert.equal(execute(page).reason, 'fields-not-empty');
});

test('origin, exact URL, and top-frame checks are repeated inside the evaluated script', () => {
  for (const page of [pageFixture({ url: 'https://shph.managebac.cn.evil.test/login' }), pageFixture({ iframe: true })]) {
    assert.equal(execute(page).reason, 'untrusted-page');
    assert.equal(page.password.value, '');
  }
  const page = pageFixture();
  assert.equal(execute(page, { expectedUrl: 'https://shph.managebac.cn/other-login' }).reason, 'untrusted-page');
  assert.equal(page.password.value, '');
  assert.throws(() => credentialAutofillScript('managebac', credential, { expectedOrigin: 'https://evil.test' }));
  assert.throws(() => credentialAutofillScript('managebac', credential, { expectedUrl: 'https://evil.test' }));
});

test('external, insecure, alternate-port, and password-reset form actions are rejected', () => {
  for (const action of ['https://evil.test/collect', 'http://shph.managebac.cn/login', 'https://shph.managebac.cn:8443/login', 'https://shph.managebac.cn/password/reset', 'javascript:void(0)']) {
    const page = pageFixture({ form: { action } });
    assert.equal(execute(page).reason, 'untrusted-form-action', action);
    assert.equal(page.password.value, '');
  }
  const page = pageFixture();
  page.context.document.querySelectorAll = (selector) => selector === 'input' ? page.inputs : [{ form: page.form, formAction: 'https://evil.test/collect' }];
  assert.equal(execute(page).reason, 'untrusted-form-action');
  assert.equal(page.password.value, '');
});

test('reset, signup, new-password, and multi-password forms never receive a saved secret', () => {
  const pages = [
    pageFixture({ url: 'https://shph.managebac.cn/users/password/reset' }),
    pageFixture({ form: { id: 'register' } }),
    pageFixture({ password: { autocomplete: 'new-password' } }),
    pageFixture({ password: { name: 'confirm_password' } }),
    pageFixture({ extras: [{ type: 'password', name: 'confirmation' }] }),
    pageFixture({ extras: [{ type: 'password', name: 'confirmation', noRect: true }] }),
  ];
  for (const page of pages) {
    assert.equal(execute(page).filled, false);
    assert.equal(page.password.value, '');
  }
});

test('hidden, read-only, inert, disconnected and disabled fields cannot be filled', () => {
  for (const field of ['username', 'password']) {
    for (const value of [{ readOnly: true }, { disabled: true }, { isConnected: false }, { inert: true }, { noRect: true }, { style: { display: 'none' } }, { style: { visibility: 'hidden' } }, { style: { opacity: '0' } }]) {
      const page = pageFixture({ [field]: value });
      assert.equal(execute(page).filled, false);
      assert.equal(page.password.value, '');
    }
  }
});

test('captcha, unlabelled text fields, conflicting username fields, and username-only pages fail safely', () => {
  for (const page of [
    pageFixture({ username: { name: 'captcha', id: 'code' } }),
    pageFixture({ username: { name: 'anything', autocomplete: 'one-time-code' } }),
    pageFixture({ extras: [{ name: 'other_username' }] }),
    pageFixture({ password: { form: null } }),
    pageFixture({ password: { type: 'hidden' } }),
  ]) {
    assert.equal(execute(page).filled, false);
    assert.equal(page.password.value, '');
  }
});

test('explicit autocomplete username wins over unrelated email and existing user input is preserved', () => {
  const explicit = pageFixture({ username: { autocomplete: 'section-login username' }, extras: [{ type: 'email', name: 'recovery_email' }] });
  assert.equal(execute(explicit).filled, true);
  assert.equal(explicit.extras[0].value, '');
  for (const page of [pageFixture({ username: { value: 'already-typing' } }), pageFixture({ password: { value: 'already-typing' } })]) {
    const before = { username: page.username.value, password: page.password.value };
    assert.equal(execute(page).reason, 'fields-not-empty');
    assert.equal(page.username.value, before.username);
    assert.equal(page.password.value, before.password);
  }
});

test('the factory validates credentials and safely quotes secret content without leaking it in result', () => {
  assert.throws(() => credentialAutofillScript('custom', credential));
  assert.throws(() => credentialAutofillScript('managebac', { username: '', password: 'a' }));
  assert.throws(() => credentialAutofillScript('managebac', { username: 'a', password: '' }));
  const page = pageFixture();
  const unusual = { username: 'student', password: '\"; globalThis.leak = true; // \\ test' };
  const result = vm.runInNewContext(credentialAutofillScript('managebac', unusual), page.context);
  assert.equal(result.filled, true);
  assert.equal(page.password.value, unusual.password);
  assert.equal(page.context.leak, undefined);
  assert.equal(JSON.stringify(result).includes(unusual.password), false);
});

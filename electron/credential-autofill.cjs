const { normalizePassword, normalizeUsername } = require('./credential-vault.cjs');

// Password permission is intentionally narrower than browsing permission. A
// redirect to a mail provider or another school's subdomain never inherits it.
const CREDENTIAL_ORIGINS = Object.freeze({
  mail: 'https://mail.shphschool.com',
  managebac: 'https://shph.managebac.cn',
  edupage: 'https://pingheschool.edupage.org',
});
// World 0 belongs to the page and 999 is Electron's context-isolation world.
const CREDENTIAL_ISOLATED_WORLD_ID = 1001;

function isCredentialUrlAllowed(siteId, value) {
  if (!Object.hasOwn(CREDENTIAL_ORIGINS, siteId)) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && url.origin === CREDENTIAL_ORIGINS[siteId];
  } catch {
    return false;
  }
}

/** Execute this only in an isolated world of the school's top-level frame. */
function credentialAutofillScript(siteId, credential, options = {}) {
  const expectedOrigin = CREDENTIAL_ORIGINS[siteId];
  if (!Object.hasOwn(CREDENTIAL_ORIGINS, siteId)
    || (options.expectedOrigin && options.expectedOrigin !== expectedOrigin)
    || (options.expectedUrl && !isCredentialUrlAllowed(siteId, options.expectedUrl))) {
    throw new Error('此页面不允许填入密码');
  }
  const username = normalizeUsername(credential?.username);
  const password = normalizePassword(credential?.password, { required: true });
  const payload = JSON.stringify({ expectedOrigin, expectedUrl: options.expectedUrl || '', username, password });

  return `(() => {
    try {
      const credential = ${payload};
      const unchangedPage = () => window.top === window.self
        && location.origin === credential.expectedOrigin
        && (!credential.expectedUrl || location.href === credential.expectedUrl);
      if (!unchangedPage()) return { filled: false, reason: 'untrusted-page' };
      const unsafeTarget = (url) => /(?:reset|recover|forgot|change|register|signup|sign-up|new-password|password-reset|password-change)/i.test(url.pathname + url.search);
      if (unsafeTarget(new URL(location.href))) return { filled: false, reason: 'not-login-form' };
      const visible = (input) => {
        if (!input.isConnected || input.disabled || input.readOnly || input.type === 'hidden'
          || input.closest('[inert], [aria-hidden="true"]')) return false;
        const style = window.getComputedStyle(input);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
          && style.opacity !== '0' && [...input.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0);
      };
      const allInputs = [...document.querySelectorAll('input')];
      const passwords = allInputs.filter((input) => input.type.toLowerCase() === 'password' && visible(input));
      if (!passwords.length) return { filled: false, reason: 'no-password-input' };
      if (passwords.length !== 1) return { filled: false, reason: 'ambiguous-form' };
      const passwordInput = passwords[0];
      const form = passwordInput.form;
      if (!form || !form.isConnected) return { filled: false, reason: 'no-login-form' };
      const formInputs = allInputs.filter((input) => input.form === form);
      if (formInputs.filter((input) => input.type.toLowerCase() === 'password').length !== 1) {
        return { filled: false, reason: 'not-login-form' };
      }
      const passwordHint = [passwordInput.autocomplete, passwordInput.name, passwordInput.id].join(' ');
      if (/new.?password|confirm|repeat|old.?password|reset|change/i.test(passwordHint)
        || /reset|recover|change|register|signup/i.test([form.name, form.id].join(' '))) {
        return { filled: false, reason: 'not-login-form' };
      }
      const allowedAction = (value) => {
        try {
          const url = new URL(value || location.href, document.baseURI);
          return !url.username && !url.password && url.origin === credential.expectedOrigin && !unsafeTarget(url);
        } catch { return false; }
      };
      const formSafe = () => form.isConnected && allowedAction(form.action)
        && [...document.querySelectorAll('button[formaction], input[formaction]')]
          .filter((button) => button.form === form).every((button) => allowedAction(button.formAction));
      if (!formSafe()) return { filled: false, reason: 'untrusted-form-action' };
      const candidates = formInputs.filter((input) => ['text', 'email', 'tel'].includes(input.type.toLowerCase())
        && visible(input) && !/one-time-code|new-password/i.test(input.autocomplete));
      const strongCandidates = candidates.filter((input) => /(?:^|\\s)username(?:\\s|$)/i.test(input.autocomplete));
      const hintedCandidates = candidates.filter((input) => input.type.toLowerCase() === 'email'
        || /user.?name|login|account|e.?mail|账号|账户|帐户|用户名|邮箱|用戶/i.test([
          input.name, input.id, input.placeholder, input.getAttribute('aria-label'),
        ].filter(Boolean).join(' ')));
      const matches = strongCandidates.length ? strongCandidates : hintedCandidates;
      if (matches.length !== 1) return { filled: false, reason: matches.length ? 'ambiguous-form' : 'no-username-input' };
      const usernameInput = matches[0];
      // Never overwrite an in-progress login, even when the user clicks fill.
      if (passwordInput.value || (usernameInput.value && usernameInput.value !== credential.username)) {
        return { filled: false, reason: 'fields-not-empty' };
      }
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      if (!descriptor || typeof descriptor.set !== 'function') return { filled: false, reason: 'fill-failed' };
      if (!unchangedPage() || !formSafe() || !visible(usernameInput) || !visible(passwordInput)
        || usernameInput.form !== form || passwordInput.form !== form) return { filled: false, reason: 'page-changed' };
      descriptor.set.call(usernameInput, credential.username);
      descriptor.set.call(passwordInput, credential.password);
      for (const input of [usernameInput, passwordInput]) {
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { filled: true };
    } catch { return { filled: false, reason: 'fill-failed' }; }
  })()`;
}

module.exports = { CREDENTIAL_ORIGINS, CREDENTIAL_ISOLATED_WORLD_ID, isCredentialUrlAllowed, credentialAutofillScript };

'use strict';
// The `accounts` block of the shared `settings.yaml` (see docs/data-format.md §3).
//
// Pinghe Launcher Lite and PH Launcher use different field names for the same
// platforms, so the mapping lives here as pure functions: the caller reads the
// file, decides whether the user asked to import or export, and does the writing.
const SITE_BY_PLATFORM = Object.freeze({ edupage: 'edupage', managebac: 'managebac', mail: 'mail' });
const PLATFORM_HOSTS = Object.freeze({
  managebac: { base_url: 'https://shph.managebac.cn' },
  mail: { imap_host: 'imap.qiye.163.com', smtp_host: 'smtp.qiye.163.com' },
});
const SUPPORTED_PLATFORMS = Object.freeze([...Object.keys(SITE_BY_PLATFORM), 'xinlv']);
const MAX_FIELD_LENGTH = 512;

function clean(value) {
  return String(value ?? '').replace(/[\u0000\r\n]/g, ' ').trim().slice(0, MAX_FIELD_LENGTH);
}

/** What the shared block contains, for display and for planning an import. */
function describeSharedAccounts(accounts) {
  const platforms = [];
  for (const [platform, values] of Object.entries(accounts && typeof accounts === 'object' ? accounts : {})) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    const username = clean(values.username || values.email);
    const password = clean(values.password);
    const authcode = clean(values.authcode);
    if (!username && !password && !authcode) continue;
    platforms.push({
      platform,
      supported: SUPPORTED_PLATFORMS.includes(platform),
      username,
      hasPassword: Boolean(password),
      hasAuthcode: Boolean(authcode),
    });
  }
  return platforms;
}

/**
 * Accounts to copy into the local encrypted vault.
 * A platform already saved here is never replaced, and an entry without both a
 * user name and a usable secret is skipped instead of producing a broken login.
 */
function planImport(accounts, savedSites = {}) {
  const imported = []; const skipped = [];
  for (const [platform, siteId] of Object.entries(SITE_BY_PLATFORM)) {
    const values = accounts?.[platform];
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    if (savedSites?.[siteId]?.saved) { skipped.push({ platform, reason: 'already-saved' }); continue; }
    const username = clean(values.username || values.email);
    const password = clean(values.password);
    const authcode = platform === 'mail' ? clean(values.authcode) : '';
    if (!username || (!password && !authcode)) { skipped.push({ platform, reason: 'incomplete' }); continue; }
    imported.push({ platform, siteId, username, password, authcode });
  }
  return { imported, skipped };
}

/**
 * The `accounts` block to write: platforms this app owns are refreshed, and every
 * other platform already in the file is carried over unchanged.
 */
function buildAccountsBlock(existing, records = {}, xinlv = {}, { pruneMissing = false } = {}) {
  const merged = {};
  for (const [platform, values] of Object.entries(existing && typeof existing === 'object' ? existing : {})) {
    if (values && typeof values === 'object' && !Array.isArray(values)) merged[platform] = { ...values };
  }
  for (const [platform, siteId] of Object.entries(SITE_BY_PLATFORM)) {
    const record = records?.[siteId];
    if (!record?.username) {
      // 自动镜像时，本机删掉的账号也要从共享文件里去掉，否则下次启动又会被读回来。
      if (pruneMissing) delete merged[platform];
      continue;
    }
    merged[platform] = {
      ...(PLATFORM_HOSTS[platform] || {}),
      username: clean(record.username),
      password: clean(record.password),
      ...(platform === 'mail' ? { authcode: clean(record.authcode) } : {}),
    };
  }
  if (xinlv?.username && xinlv?.token) merged.xinlv = { username: clean(xinlv.username), token: clean(xinlv.token) };
  else if (pruneMissing) delete merged.xinlv;
  return merged;
}

/** Platforms this app can write into the shared file. */
function ownedPlatforms(records = {}, xinlv = {}) {
  const owned = [];
  for (const [platform, siteId] of Object.entries(SITE_BY_PLATFORM)) if (records?.[siteId]?.username) owned.push(platform);
  if (xinlv?.username && xinlv?.token) owned.push('xinlv');
  return owned;
}

module.exports = { MAX_FIELD_LENGTH, PLATFORM_HOSTS, SITE_BY_PLATFORM, SUPPORTED_PLATFORMS, buildAccountsBlock, describeSharedAccounts, ownedPlatforms, planImport };

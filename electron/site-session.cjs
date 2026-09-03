const STORAGE_ACCESS_PERMISSIONS = new Set(['storage-access', 'top-level-storage-access']);
const ALLOWED_SITE_PERMISSIONS = new Set([
  'fullscreen',
  'notifications',
  'clipboard-sanitized-write',
  ...STORAGE_ACCESS_PERMISSIONS,
]);

function hostMatches(hostname, suffixes) {
  const host = String(hostname || '').toLowerCase();
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isTrustedSiteUrl(site, rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' && hostMatches(parsed.hostname, site.trustedHosts);
  } catch {
    return false;
  }
}

function isAllowedSitePermission(site, permission, context = {}) {
  if (!ALLOWED_SITE_PERMISSIONS.has(permission)) return false;
  const topLevelUrl = context.topLevelUrl || '';
  const requestingUrl = context.requestingUrl || topLevelUrl;
  const embeddingUrl = context.embeddingUrl || topLevelUrl;
  if (!isTrustedSiteUrl(site, topLevelUrl)) return false;
  if (!isTrustedSiteUrl(site, requestingUrl)) return false;
  if (!isTrustedSiteUrl(site, embeddingUrl)) return false;

  // Storage Access may expose a site's cookies to an embedded frame. It is only
  // granted when the requester and its embedding page are both part of this
  // site's explicitly approved HTTPS host set.
  if (STORAGE_ACCESS_PERMISSIONS.has(permission)) {
    return Boolean(context.requestingUrl && embeddingUrl);
  }
  return true;
}

class SiteStoragePersistence {
  constructor({ delayMs = 750, flushTimeoutMs = 4_000, onError = () => {} } = {}) {
    this.delayMs = delayMs;
    this.flushTimeoutMs = flushTimeoutMs;
    this.onError = onError;
    this.sessions = new Set();
    this.timers = new Map();
  }

  watch(siteSession) {
    if (!siteSession || this.sessions.has(siteSession)) return;
    this.sessions.add(siteSession);
    // Deliberately ignore the event's Cookie object. PH Launcher never reads,
    // copies, logs or rewrites a site's cookie value.
    siteSession.cookies.on('changed', () => this.schedule(siteSession));
  }

  schedule(siteSession) {
    const previous = this.timers.get(siteSession);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.timers.delete(siteSession);
      this.flushSession(siteSession).catch(this.onError);
    }, this.delayMs);
    timer.unref?.();
    this.timers.set(siteSession, timer);
  }

  async flushSession(siteSession) {
    let timer;
    try {
      await Promise.race([
        Promise.all([
          siteSession.cookies.flushStore(),
          siteSession.flushStorageData(),
        ]),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('网站登录数据写入超时')), this.flushTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async flushAll() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    const results = await Promise.allSettled(
      [...this.sessions].map((siteSession) => this.flushSession(siteSession)),
    );
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), '网站登录数据写入失败');
  }
}

module.exports = {
  SiteStoragePersistence,
  isAllowedSitePermission,
  isTrustedSiteUrl,
};

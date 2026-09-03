const crypto = require('node:crypto');

const CUSTOM_SITE_PREFIX = 'custom-';
const MAX_CUSTOM_SITES = 12;
const CUSTOM_SITE_COLORS = ['green', 'wine', 'gold', 'blue', 'slate'];
const CUSTOM_SITE_ID_PATTERN = /^custom-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function normalizeCustomSiteName(value) {
  const name = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
  if (!name) throw new Error('请填写网页名称');
  return name;
}

function normalizeCustomSiteUrl(value) {
  const raw = String(value || '');
  if (raw.length > 2048 || /[\u0000-\u001f\u007f]/.test(raw)) throw new Error('网址过长或包含无效字符');
  let input = raw.trim();
  if (input && !/^[a-z][a-z\d+.-]*:/i.test(input)) input = `https://${input}`;
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('请输入有效的网址');
  }
  if (parsed.protocol !== 'https:') throw new Error('为保护账号安全，自定义网页仅支持 HTTPS');
  if (parsed.username || parsed.password) throw new Error('网址中不能包含账号或密码');
  if (!parsed.hostname || parsed.hostname.length > 253) throw new Error('请输入有效的网址');
  return parsed.toString();
}

function normalizeCustomSiteShortcut(value) {
  return String(value || '').replace(/\s+/g, '').trim().slice(0, 80);
}

function customSiteOrigin(value) {
  return new URL(normalizeCustomSiteUrl(value)).origin;
}

function isTrustedCustomSiteUrl(record, value) {
  try {
    const target = new URL(String(value || ''));
    return target.protocol === 'https:' && target.origin === customSiteOrigin(record?.url);
  } catch {
    return false;
  }
}

function normalizeCustomSiteRecord(value, options = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const id = String(options.id || source.id || '').trim();
  if (!CUSTOM_SITE_ID_PATTERN.test(id)) throw new Error('自定义网页标识无效');
  const color = CUSTOM_SITE_COLORS.includes(source.color) ? source.color : 'green';
  return {
    id,
    name: normalizeCustomSiteName(source.name),
    url: normalizeCustomSiteUrl(source.url),
    color,
    shortcut: normalizeCustomSiteShortcut(source.shortcut),
    shortcutEnabled: Boolean(source.shortcutEnabled && normalizeCustomSiteShortcut(source.shortcut)),
  };
}

function normalizeCustomSites(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const ids = new Set();
  for (const candidate of value) {
    if (result.length >= MAX_CUSTOM_SITES) break;
    try {
      const site = normalizeCustomSiteRecord(candidate);
      if (ids.has(site.id)) continue;
      ids.add(site.id);
      result.push(site);
    } catch {}
  }
  return result;
}

function upsertCustomSite(current, input, idFactory = () => crypto.randomUUID()) {
  const sites = normalizeCustomSites(current);
  const requestedId = String(input?.id || '').trim();
  const existingIndex = sites.findIndex((site) => site.id === requestedId);
  if (requestedId && existingIndex < 0) throw new Error('要编辑的网页已不存在');
  if (existingIndex < 0 && sites.length >= MAX_CUSTOM_SITES) {
    throw new Error(`最多可添加 ${MAX_CUSTOM_SITES} 个自定义网页`);
  }
  let id = existingIndex >= 0 ? sites[existingIndex].id : '';
  if (!id) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = `${CUSTOM_SITE_PREFIX}${idFactory()}`;
      if (!sites.some((site) => site.id === candidate)) {
        id = candidate;
        break;
      }
    }
    if (!id) throw new Error('无法创建唯一的网页标识，请重试');
  }
  const site = normalizeCustomSiteRecord(input, { id });
  if (existingIndex >= 0) sites[existingIndex] = site;
  else sites.push(site);
  return { sites, site, created: existingIndex < 0 };
}

function removeCustomSite(current, id) {
  const sites = normalizeCustomSites(current);
  const next = sites.filter((site) => site.id !== id);
  if (next.length === sites.length) throw new Error('要删除的网页已不存在');
  return next;
}

function reorderCustomSites(current, orderedIds) {
  const sites = normalizeCustomSites(current);
  if (!Array.isArray(orderedIds) || orderedIds.length !== sites.length) throw new Error('网页排序数据无效');
  const byId = new Map(sites.map((site) => [site.id, site]));
  const ordered = [];
  for (const rawId of orderedIds) {
    const id = String(rawId || '');
    const site = byId.get(id);
    if (!site) throw new Error('网页排序数据无效');
    ordered.push(site);
    byId.delete(id);
  }
  if (byId.size) throw new Error('网页排序数据无效');
  return ordered;
}

function runtimeCustomSite(record) {
  const site = normalizeCustomSiteRecord(record);
  const hostname = new URL(site.url).hostname;
  return {
    ...site,
    custom: true,
    partition: `persist:ph-site-${site.id}`,
    trustedHosts: [hostname],
  };
}

module.exports = {
  CUSTOM_SITE_COLORS,
  CUSTOM_SITE_ID_PATTERN,
  MAX_CUSTOM_SITES,
  customSiteOrigin,
  isTrustedCustomSiteUrl,
  normalizeCustomSiteName,
  normalizeCustomSiteRecord,
  normalizeCustomSites,
  normalizeCustomSiteUrl,
  removeCustomSite,
  reorderCustomSites,
  runtimeCustomSite,
  upsertCustomSite,
};

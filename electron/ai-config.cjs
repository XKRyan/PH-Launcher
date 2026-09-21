'use strict';

/**
 * AI 服务商配置的**规范形态**与归一化（三端统一，2026-09-13）。
 *
 * 背景：AI 服务商（名称/协议/Base URL/模型/API Key）要和平台凭据一样"在哪填都同步到
 * 账号上，三端都能用"。历史形态有三种：
 *
 * ```
 * 网页端（phix 官网，规范来源）
 *   {"providers":[{"name","protocol","base_url","model","api_key"}], "default_index":0}
 *
 * PLL（Python）
 *   本地 settings.yaml 的 ai 段是 {"providers":[{id,name,protocol,base_url,api_key,
 *   models:[...],notes}], "active_provider_id", "active_model"}；
 *   同步出去的载荷还被包了一层 {"ai": {...}}
 *
 * PHL（本仓库）
 *   扁平单服务商：{provider:'api'|'local'|'off', apiEndpoint, apiModel, apiKey,
 *                localEndpoint, localModel, workspace, workspaces, ...}
 * ```
 *
 * 本模块只做两件事，绝不接管运行逻辑：
 *
 * 1. **读**：`normalizeAiConfig` 按 ①规范形态 → ②PLL 包装 → ③PHL 扁平 →
 *    ④更早的单服务商 依次探测，一律归一成规范形态。
 * 2. **写**：`serializeAiConfig` 输出规范形态（带 `updated_at` / `updated_by`）；
 *    `mergeAiProviders` 做合并写（只动 providers/default_index/元信息，
 *    `workspace` / `workspaces` / `localModel` / `localEndpoint` / `enabled` /
 *    `provider` 这些本地专有字段一个都不丢）。
 *
 * 运行路径（`api` 模式取默认服务商的 base_url/model/key，`local` 模式仍走 Ollama）
 * 由 `projectRuntimeFields` 把"默认服务商"投影回既有的扁平字段，
 * 于是 main.cjs / 词卡 / 教练那些既有的运行代码完全不用改。
 */

const PROTOCOLS = Object.freeze(['openai', 'anthropic']);
const WRITERS = Object.freeze(['phl', 'pll', 'web']);
/** 规范形态里由本模块写入的键；合并写时按这些键清理，别的一律保留。 */
const CANONICAL_KEYS = Object.freeze(['providers', 'default_index', 'updated_at', 'updated_by']);

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function text(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' ? value.trim() : '';
}

function firstOf(value) {
  if (!Array.isArray(value)) return '';
  for (const item of value) {
    const found = text(item);
    if (found) return found;
  }
  return '';
}

function protocolOf(value) {
  const proto = text(value).toLowerCase();
  return PROTOCOLS.includes(proto) ? proto : 'openai';
}

/** 本地时间戳（带时区偏移，与 PLL `filestore.now_iso` 同款）。 */
function nowIso(date = new Date()) {
  const moment = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(moment.getTime())) return '';
  const offset = -moment.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const pad = (value) => String(Math.floor(Math.abs(value))).padStart(2, '0');
  return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`
    + `T${pad(moment.getHours())}:${pad(moment.getMinutes())}:${pad(moment.getSeconds())}`
    + `${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}

/** 任意形态的一条服务商 → 规范的一条。`models` 列表取第一个。 */
function normalizeProvider(raw) {
  const row = isObject(raw) ? raw : {};
  return {
    name: text(row.name) || text(row.label) || text(row.title),
    protocol: protocolOf(row.protocol || row.api_type),
    base_url: text(row.base_url) || text(row.baseUrl) || text(row.api_base)
      || text(row.apiEndpoint) || text(row.endpoint) || text(row.url),
    model: text(row.model) || text(row.model_name) || firstOf(row.models),
    api_key: text(row.api_key) || text(row.apiKey) || text(row.key) || text(row.token),
  };
}

/**
 * 剥掉 PLL 的 `{"ai": {...}}` 包装（只剥一层）。
 *
 * 判据不能只看"里面有 providers"：PHL 自己的配置也可能带 `providers: []`
 * （默认值），而 `{"api": {...}}` 在 PHL 的扁平形态里根本不存在。真正要区分的是
 * **外层是不是 PHL 的扁平形态**（apiEndpoint / localEndpoint / launcherControlEnabled
 * 这些字段只有 PHL 有）—— 是的话就别剥，否则会把扁平的 Key 当成嵌套配置往外丢。
 */
function unwrap(doc) {
  if (!isObject(doc)) return {};
  const flatOuter = Boolean(doc.apiEndpoint || doc.localEndpoint || doc.localModel
    || Object.hasOwn(doc, 'launcherControlEnabled') || Object.hasOwn(doc, 'permissionMode'));
  const inner = doc.ai;
  if (isObject(inner) && !flatOuter) {
    const innerLooksLikeConfig = Boolean(inner.providers || inner.provider || inner.base_url
      || inner.api_key || inner.apiKey || inner.apiModel);
    if (innerLooksLikeConfig && !(Array.isArray(doc.providers) && !Array.isArray(inner.providers))) {
      return inner;
    }
  }
  return doc;
}

function flatCandidates(doc) {
  const apiKey = text(doc.api_key) || text(doc.apiKey);
  const baseUrl = text(doc.base_url) || text(doc.apiEndpoint) || text(doc.endpoint);
  const model = text(doc.model) || text(doc.apiModel) || firstOf(doc.models);
  if (!baseUrl && !apiKey && !model) return [];
  // **别把"出厂默认值"当成用户配过的服务商**：PHL 的 apiEndpoint 默认就是
  // `https://api.openai.com/v1`，只看它就等于凭空造一条没有 Key、没有模型的服务商 ——
  // 那会污染合并结果（实测：同步来的真服务商旁边多出一条 `来自客户端`，
  // 默认项还指到了它，于是本地和云端来回改 index，永远收敛不了）。
  // 只有用户确实填过东西（Key 或模型名）时才算一条能用的配置。
  const touched = Boolean(apiKey || model);
  if (!touched) return [];
  let name = text(doc.name);
  if (!name) name = doc.provider || doc.apiModel || doc.apiKey ? '来自客户端' : '';
  return [normalizeProvider({
    name, protocol: doc.protocol, base_url: baseUrl, model, api_key: apiKey,
  })];
}

/** 从任意历史形态里**尽量**取出服务商列表。 */
function providersOf(doc) {
  const cfg = unwrap(doc);
  if (!isObject(cfg) || !Object.keys(cfg).length) return [];
  const rows = cfg.providers;
  if (Array.isArray(rows) && rows.length) return rows.filter(isObject).map(normalizeProvider);
  if (isObject(rows)) {
    const mapped = Object.entries(rows).filter(([, item]) => isObject(item)).map(([name, item]) => {
      const row = normalizeProvider(item);
      if (!row.name) row.name = text(name);
      return row;
    });
    if (mapped.length) return mapped;
  }
  // `providers` 是空数组时**继续往下探测扁平字段**：PHL 的默认值就是 `providers: []`，
  // 而真正的配置可能还躺在 apiEndpoint/apiModel/apiKey 里（老用户第一次升级就是这种）。
  return flatCandidates(cfg);
}

function indexOf(value, count) {
  const index = Number.parseInt(value, 10);
  if (!Number.isFinite(index) || count <= 0) return 0;
  return index >= 0 && index < count ? index : 0;
}

/**
 * 任意历史形态 → 规范形态（**读**的一侧；不含 `updated_at`/`updated_by`）。
 * `_extra` 是"认不出来的其它字段"，合并写回时会原样保留，绝不静默丢字段。
 */
function normalizeAiConfig(doc) {
  const cfg = unwrap(doc);
  const providers = providersOf(doc);
  const extra = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (!CANONICAL_KEYS.includes(key) && key !== 'ai') extra[key] = value;
  }
  return {
    providers,
    default_index: indexOf(cfg.default_index, providers.length),
    _extra: extra,
  };
}

function isEmptyConfig(doc) {
  return providersOf(doc).length === 0;
}

/**
 * 把"默认服务商"投影回既有的**扁平字段**（PHL 的运行路径全靠它们）。
 *
 * - `providers` 为空 → 不动扁平字段（本地可能还留着 apiEndpoint/apiModel）
 * - 否则 `apiEndpoint`/`apiModel`/`apiKey`/`apiProtocol` 跟随默认那条；
 *   **空值不覆盖**：同步下来的那份可能缺某个字段（或者它是脱敏后的副本），
 *   拿空串去盖会把本机本来能用的配置改坏 —— 缺的字段就保持原样。
 */
function projectRuntimeFields(current, providers, defaultIndex) {
  const next = { ...(current || {}) };
  if (!providers.length) return next;
  const row = providers[indexOf(defaultIndex, providers.length)];
  if (row.base_url) next.apiEndpoint = row.base_url;
  next.apiProtocol = row.protocol || next.apiProtocol || 'openai';
  if (row.model) next.apiModel = row.model;
  if (row.api_key) next.apiKey = row.api_key;
  return next;
}

/**
 * 合并写：只更新 `providers`/`default_index`/`updated_at`/`updated_by`，
 * 本地专有字段（workspace/workspaces/localModel/localEndpoint/enabled/provider/
 * 权限确认信息…）**原样保留**。
 *
 * 没给 `writer` 就不盖 `updated_at`/`updated_by`（读取路径用它，避免每次读都改哈希）。
 */
function mergeAiProviders(current, canonical, { writer = '' } = {}) {
  const base = isObject(current) ? current : {};
  const incoming = isObject(canonical) ? canonical : {};
  const providers = Array.isArray(incoming.providers)
    ? incoming.providers.filter(isObject).map(normalizeProvider)
    : providersOf(base);
  const next = { ...base, ...(isObject(incoming._extra) ? incoming._extra : {}) };
  next.providers = providers;
  next.default_index = indexOf(
    incoming.default_index === undefined ? base.default_index : incoming.default_index,
    providers.length,
  );
  const stamp = text(incoming.updated_at);
  const by = text(incoming.updated_by);
  if (stamp) next.updated_at = stamp;
  if (by) next.updated_by = WRITERS.includes(by) ? by : text(base.updated_by);
  if (writer && WRITERS.includes(writer)) {
    if (!next.updated_at) next.updated_at = nowIso();
    next.updated_by = writer;
  }
  return projectRuntimeFields(next, providers, next.default_index);
}

/** 规范化结果 → **上云用的规范形态**。 */
function serializeAiConfig(canonical, writer = 'phl') {
  const cfg = isObject(canonical) ? canonical : {};
  const providers = (Array.isArray(cfg.providers) ? cfg.providers : []).filter(isObject).map(normalizeProvider);
  return {
    providers,
    default_index: indexOf(cfg.default_index, providers.length),
    updated_at: text(cfg.updated_at) || nowIso(),
    updated_by: WRITERS.includes(text(cfg.updated_by)) ? text(cfg.updated_by) : (WRITERS.includes(writer) ? writer : 'phl'),
  };
}

/**
 * 读取时**迁移**旧扁平形态：自动变成一条 provider。
 *
 * 只在"还没有 providers 数组"时动手 —— 已有规范列表就原样留着，
 * 免得每次读取都按扁平字段重新投影一遍默认项。
 */
function migrateFlatConfig(doc, { writer = '' } = {}) {
  const base = isObject(doc) ? doc : {};
  if (Array.isArray(base.providers) && base.providers.length) {
    return mergeAiProviders(base, base, { writer: '' });
  }
  const providers = providersOf(base);
  if (!providers.length) {
    return { ...base, providers: [], default_index: 0 };
  }
  return mergeAiProviders({ ...base, providers: [] }, { providers, default_index: 0 }, { writer });
}

/** 给界面用的（**绝不含 api_key 明文**，只报"有没有保存"）。 */
function publicAiConfig(doc) {
  const normalized = normalizeAiConfig(doc);
  return {
    providers: normalized.providers.map((row) => ({
      name: row.name,
      protocol: row.protocol,
      base_url: row.base_url,
      model: row.model,
      api_key_saved: Boolean(row.api_key),
    })),
    default_index: normalized.default_index,
    updated_at: text(unwrap(doc).updated_at),
    updated_by: text(unwrap(doc).updated_by),
  };
}

/**
 * 界面提交的一份列表 → 规范形态。
 *
 * `api_key` 留空 = **保留旧值**（老规矩：界面上永远不回显 Key）。
 * `clear_api_key: true` 才是真的删。
 */
function applySubmittedProviders(current, submitted, { writer = 'phl', defaultIndex } = {}) {
  const base = isObject(current) ? current : {};
  const oldRows = providersOf(base);
  const oldByName = new Map(oldRows.map((row) => [row.name, row]));
  const rows = (Array.isArray(submitted) ? submitted : []).filter(isObject).map((raw) => {
    const row = normalizeProvider(raw);
    const previous = oldByName.get(row.name);
    if (!row.api_key) {
      if (raw.clear_api_key === true) row.api_key = '';
      else if (previous) row.api_key = previous.api_key;
    }
    return row;
  });
  return mergeAiProviders(base, { providers: rows, default_index: defaultIndex }, { writer });
}

module.exports = {
  PROTOCOLS,
  WRITERS,
  CANONICAL_KEYS,
  nowIso,
  normalizeProvider,
  providersOf,
  normalizeAiConfig,
  isEmptyConfig,
  projectRuntimeFields,
  mergeAiProviders,
  serializeAiConfig,
  migrateFlatConfig,
  publicAiConfig,
  applySubmittedProviders,
};

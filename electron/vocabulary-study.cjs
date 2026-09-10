'use strict';
const { createHash, randomInt } = require('node:crypto');
const vocabulary = require('./vocabulary.cjs');
const { selectConfig } = require('./vocabulary-advisor.cjs');

function createVocabularyStudy({ getData, getConfig, getRevision, change, snapshot, advise, getConsent = () => '', saveConsent = () => {}, now = () => new Date() }) {
  let consentKey = '';
  let active = null;
  let prefetchTask = null;
  let prefetched = null;
  let lastAttempt = null;
  const connectionKey = () => {
    const ai = getConfig();
    return createHash('sha256').update(JSON.stringify([
      ai.enabled, ai.provider, ai.localEndpoint, ai.localModel, ai.apiEndpoint, ai.apiModel, ai.apiKey,
    ])).digest('hex');
  };
  const available = (provider) => { try { selectConfig(getConfig(), provider); return true; } catch { return false; } };
  const consentConnectionKey = () => {
    const ai = getConfig();
    return createHash('sha256').update(JSON.stringify(['vocabulary-consent-v1', ai.apiEndpoint, ai.apiModel, ai.apiKey])).digest('hex');
  };
  function status() {
    const provider = getData().settings.advisorProvider || 'local';
    const localAvailable = available('local'), apiAvailable = available('api');
    const remembered = getConsent();
    const apiConsented = Boolean((consentKey || remembered) && (consentKey === consentConnectionKey() || remembered === consentConnectionKey()));
    const notice = provider === 'off' ? '使用离线学习流程'
      : provider === 'local' ? localAvailable ? '使用已配置的本地模型；连接失败时自动离线' : '尚未配置可用的本地 AI，将离线学习'
        : !apiAvailable ? '尚未配置可用的 API，将离线学习' : !apiConsented ? '请先确认词汇学习记录的 API 使用范围' : '使用已授权的 API 推荐，可能产生费用';
    const configIssue = (() => { try { if (provider !== 'off') selectConfig(getConfig(), provider); return ''; } catch (error) { return error.message; } })();
    return { provider, localAvailable, apiAvailable, apiConsented, apiConsentRemembered: Boolean(remembered && remembered === consentConnectionKey()), notice: configIssue ? `${configIssue}；可点击“连接与检查”` : notice, lastAttempt };
  }
  function cancel({ requestId } = {}) {
    if (active && (!requestId || active.id === requestId)) {
      active.controller.abort(new Error('已取消词汇推荐'));
      active = null;
    }
    // A foreground cancellation must also stop the single background request;
    // otherwise it could compete with a new check or prepare call.
    if (prefetchTask) {
      prefetchTask.controller.abort(new Error('已取消词汇预准备'));
      prefetchTask = null;
    }
    prefetched = null;
    return { ok: true };
  }
  function invalidate() { consentKey = ''; lastAttempt = null; cancel(); }
  function configure({ provider, apiConsent = false, rememberApiConsent = false, revokeApiConsent = false } = {}) {
    if (!['local', 'api', 'off'].includes(provider)) throw new Error('请选择词汇推荐方式');
    cancel();
    lastAttempt = null;
    if (revokeApiConsent) { saveConsent(''); consentKey = ''; }
    else if (provider === 'api' && apiConsent === true && available('api')) {
      const key = consentConnectionKey();
      saveConsent(rememberApiConsent ? key : '');
      consentKey = key;
    }
    return change((data) => { data.settings.advisorProvider = provider; return { provider }; });
  }
  function authorize(provider) {
    const selected = status();
    if (provider !== selected.provider || provider === 'off') throw new Error('请选择当前词汇推荐方式');
    if (provider === 'local' && !selected.localAvailable) throw new Error('尚未配置可用的本地 AI');
    if (provider === 'api' && !selected.apiAvailable) throw new Error('尚未配置可用的 API');
    if (provider === 'api' && !selected.apiConsented) throw new Error('请先确认词汇学习记录的 API 使用范围');
    return true;
  }
  function recent(data) {
    const byId = new Map(data.cards.map((card) => [card.id, card]));
    return [
      ...data.logs.slice(-30).map((log) => ({ word: byId.get(log.cardId)?.word, rating: log.rating, at: log.at })),
      ...data.cards.filter((card) => card.knownAt && card.suspended).map((card) => ({ word: card.word, known: true, at: card.knownAt })),
    ].filter((item) => item.word).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 20)
      .map(({ at, ...signal }) => signal);
  }
  function candidatesFor(data, subject, excludeIds = []) {
    const excluded = new Set(Array.isArray(excludeIds) ? excludeIds.filter((id) => typeof id === 'string') : []);
    return vocabulary.newCandidates(data, now(), subject, 40)
      .filter((card) => !excluded.has(card.id) && !card.knownAt);
  }
  function fillIds(ids, candidates, limit) {
    const allowed = new Set(candidates.map((card) => card.id));
    const result = [...new Set(ids || [])].filter((id) => allowed.has(id)).slice(0, limit);
    for (const card of candidates) { if (result.length >= limit) break; if (!result.includes(card.id)) result.push(card.id); }
    return result;
  }
  async function prefetch({ subject = '', excludeIds = [], requestId } = {}) {
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(requestId)) throw new Error('预准备请求无效');
    if (active || prefetchTask) return { skipped: true, reason: 'busy' };
    subject = String(subject || '').slice(0, 60);
    const data = getData(); const selected = status();
    if (selected.provider === 'off' || (selected.provider === 'local' ? !selected.localAvailable : !selected.apiAvailable || !selected.apiConsented)) return { skipped: true, reason: 'unavailable' };
    const candidates = candidatesFor(data, subject, excludeIds);
    const limit = Math.min(5, candidates.length);
    if (!limit) return { skipped: true, reason: 'empty' };
    const task = { id: requestId, controller: new AbortController() }; prefetchTask = task;
    const configKey = connectionKey(); const level = data.settings.level || 'intermediate';
    try {
      const result = await advise({ provider: selected.provider, apiConsent: selected.apiConsented, level,
        candidates: candidates.map(({ id, word, meaning }) => ({ id, word, meaning })), recent: recent(data), limit }, { signal: task.controller.signal });
      if (prefetchTask !== task || task.controller.signal.aborted) return { canceled: true };
      // The cache is data-only. It never writes batches, cards, contexts, logs, or schedules.
      prefetched = { provider: selected.provider, configKey, subject, level, excludeIds: new Set(excludeIds),
        candidateIds: candidates.map((card) => card.id), ids: fillIds(result.ids, candidates, limit), contexts: result.contexts || [], source: result.source || selected.provider };
      return { ok: true, source: prefetched.source };
    } catch (error) {
      if (task.controller.signal.aborted || prefetchTask !== task) return { canceled: true };
      return { ok: false, notice: connectionError(error) };
    } finally { if (prefetchTask === task) prefetchTask = null; }
  }
  async function prepare({ subject = '', excludeIds = [], requestId, offline = false } = {}) {
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(requestId)) throw new Error('学习请求无效');
    if (active) { active.controller.abort(new Error('已取消词汇推荐')); active = null; }
    if (prefetchTask) { prefetchTask.controller.abort(new Error('已开始新的学习请求')); prefetchTask = null; }
    const task = { id: requestId, controller: new AbortController() };
    active = task;
    const canceled = () => task.controller.signal.aborted || active !== task;
    subject = String(subject || '').slice(0, 60);
    const data = getData();
    const revision = getRevision();
    const queued = vocabulary.queue(data, now(), subject);
    const limit = Math.min(5, queued.filter((card) => card.schedule.state === 0).length);
    if (!limit) { active = null; return { batchIds: [], source: 'offline', notice: '', snapshot: snapshot(subject) }; }
    const candidates = candidatesFor(data, subject, excludeIds);
    const selected = status();
    let ids = candidates.slice(0, limit).map((card) => card.id), contexts = [], source = 'offline';
    let notice = selected.notice;
    const cached = prefetched;
    let cacheAuthorized = false;
    if (cached && !offline) { try { authorize(selected.provider); cacheAuthorized = true; } catch {} }
    const canUseCache = !offline && cacheAuthorized && cached && cached.provider === selected.provider && cached.configKey === connectionKey()
      && cached.subject === subject && cached.level === (data.settings.level || 'intermediate');
    if (canUseCache) {
      // Scores can change while a group is in progress. Revalidate against the
      // current candidates and fill any gaps, without turning cache reuse into a write.
      ids = fillIds(cached.ids, candidates, limit);
      contexts = cached.contexts;
      source = cached.source;
      notice = source === 'local' ? '本地 AI 已根据近期学习情况安排这一组；例句请自行核对' : 'API 已根据近期学习情况安排这一组；例句请自行核对';
      prefetched = null;
    } else if (cached && (!offline || cached.provider !== selected.provider || cached.configKey !== connectionKey() || cached.subject !== subject || cached.level !== (data.settings.level || 'intermediate'))) {
      prefetched = null;
    }
    if (!canUseCache && !offline && selected.provider !== 'off' && (selected.provider === 'local' ? selected.localAvailable : selected.apiAvailable && selected.apiConsented)) {
      try {
        const result = await advise({ provider: selected.provider, apiConsent: selected.apiConsented,
          level: data.settings.level || 'intermediate', candidates: candidates.map(({ id, word, meaning }) => ({ id, word, meaning })), recent: recent(data), limit }, { signal: task.controller.signal });
        if (!canceled() && revision === getRevision()) {
          const allowed = new Set(candidates.map((card) => card.id));
          ids = fillIds(result.ids, candidates, limit);
          if (!ids.length) throw Error('没有可用推荐');
          contexts = result.contexts || []; source = result.source;
          notice = source === 'local' ? '本地 AI 已根据近期学习情况安排这一组；例句请自行核对' : 'API 已根据近期学习情况安排这一组；例句请自行核对';
        }
      } catch (error) {
        notice = `${connectionError(error)}；本组继续离线学习`;
      }
    } else if (offline) notice = '已切换离线学习，不等待 AI';
    if (canceled()) return { canceled: true, batchIds: [], source: 'offline', notice: '', snapshot: snapshot(subject) };
    active = null;
    if (!offline && selected.provider !== 'off') lastAttempt = { ok: source !== 'offline', notice, provider: selected.provider };
    if (revision !== getRevision()) return { canceled: true, batchIds: [], source: 'offline', notice: '词书或学习设置已变化，请重新开始', snapshot: snapshot(subject) };
    const availableIds = new Set(data.cards.filter((card) => !card.suspended && card.schedule.state === 0).map((card) => card.id));
    ids = ids.filter((id) => availableIds.has(id));
    const result = change((next) => {
      next.batch = { day: vocabulary.dateKey(now()), ids, phase: 'preview', index: 0 };
      for (const entry of contexts) {
        const card = next.cards.find((item) => item.id === entry.id && ids.includes(item.id));
        if (!card || typeof entry.sentence !== 'string' || entry.sentence.length > 450 || vocabulary.cloze(entry.sentence, card.word) === entry.sentence) continue;
        if (!card.context) { card.context = entry.sentence; card.contextSource = 'AI 生成例句，请核对'; }
        else if (![card.context, ...(card.contexts || [])].includes(entry.sentence)) card.contexts = [...(card.contexts || []).slice(-11), entry.sentence];
      }
      return { ids };
    });
    const ownSnapshot = subject ? snapshot(subject) : result.snapshot;
    if (ownSnapshot.study?.newAtLevel === 0 && ownSnapshot.settings.level) notice += '；当前词书没有此难度的新词，可在推荐词书中加入更合适的词';
    return { batchIds: ids, source, notice, snapshot: ownSnapshot };
  }
  function startRecall({ ids, subject = '' } = {}) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 5 || new Set(ids).size !== ids.length) throw new Error('学习分组无效');
    subject = String(subject || '').slice(0, 60);
    const allowed = new Set(vocabulary.queue(getData(), now(), subject).filter(card => card.schedule.state === 0 && card.schedule.reps === 0).map(card => card.id));
    if (ids.some(id => !allowed.has(id))) throw new Error('词书已变化，请重新开始这一组');
    const order = [...ids];
    for (let i = order.length - 1; i > 0; i--) { const j = randomInt(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
    if (order.length > 1 && order.every((id, i) => id === ids[i])) order.push(order.shift());
    const result = change(data => { data.batch = { day: vocabulary.dateKey(now()), ids: order, phase: 'recall', index: 0 }; return { ids: order }; });
    return { ...result, snapshot: subject ? snapshot(subject) : result.snapshot };
  }
  async function check({ requestId } = {}) {
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(requestId)) throw new Error('连接检查请求无效');
    cancel();
    const selected = status();
    const task = { id: requestId, controller: new AbortController() };
    active = task;
    try {
      if (selected.provider === 'off') throw new Error('请选择本地 AI 或 API AI');
      selectConfig(getConfig(), selected.provider);
      if (selected.provider === 'api' && !selected.apiConsented) throw new Error('请先确认词汇学习记录的 API 使用范围');
      await advise({ provider: selected.provider, apiConsent: selected.apiConsented, level: 'intermediate', limit: 1,
        candidates: [{ id: 'connection-test', word: 'evidence', meaning: 'information supporting a conclusion' }], recent: [] }, { signal: task.controller.signal });
      if (active !== task || task.controller.signal.aborted) return { canceled: true };
      lastAttempt = { ok: true, provider: selected.provider, notice: `${selected.provider === 'local' ? '本地 AI' : 'API'} 连接成功，可以生成词汇推荐和例句` };
    } catch (error) {
      if (active !== task || task.controller.signal.aborted) return { canceled: true };
      lastAttempt = { ok: false, provider: selected.provider, notice: connectionError(error) };
    } finally { if (active === task) active = null; }
    return { ...lastAttempt, snapshot: snapshot() };
  }
  return { status, configure, authorize, prepare, prefetch, cancel, invalidate, startRecall, check };
}
function connectionError(error) {
  const message = String(error?.message || '');
  if (/超时|timeout/i.test(message)) return 'AI 等待超时（90 秒），模型可能仍在加载或被其他对话占用；稍后重试';
  if (/返回 401|返回 403/.test(message)) return 'API 身份验证失败，请在 AI 设置中检查 Key 与服务地址';
  if (/返回 404/.test(message)) return '没有找到模型或接口，请核对已安装模型名称与服务地址';
  if (/返回 429/.test(message)) return 'API 已限流或额度不足，请检查服务商账户';
  if (/格式|候选词|建议/.test(message)) return 'AI 已响应，但没有返回可用的词汇建议；请重试或换用支持 JSON 的模型';
  if (/^(请先|请填写|本地 AI 地址|API 地址|请选择|需要先)/.test(message)) return message;
  return '无法连接所选 AI 服务，请检查服务是否运行、地址与网络';
}
module.exports = { createVocabularyStudy };

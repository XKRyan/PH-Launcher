'use strict';
const { createHash } = require('node:crypto');
const vocabulary = require('./vocabulary.cjs');
const { selectConfig } = require('./vocabulary-advisor.cjs');

function createVocabularyStudy({ getData, getConfig, getRevision, change, snapshot, advise, now = () => new Date() }) {
  let consentKey = '';
  let active = null;
  const connectionKey = () => {
    const ai = getConfig();
    return createHash('sha256').update(JSON.stringify([ai.enabled, ai.provider, ai.apiEndpoint, ai.apiModel, ai.apiKey])).digest('hex');
  };
  const available = (provider) => { try { selectConfig(getConfig(), provider); return true; } catch { return false; } };
  function status() {
    const provider = getData().settings.advisorProvider || 'local';
    const localAvailable = available('local'), apiAvailable = available('api');
    const apiConsented = Boolean(consentKey && consentKey === connectionKey());
    const notice = provider === 'off' ? '使用离线学习流程'
      : provider === 'local' ? localAvailable ? '使用已配置的本地模型；连接失败时自动离线' : '尚未配置可用的本地 AI，将离线学习'
        : !apiAvailable ? '尚未配置可用的 API，将离线学习' : !apiConsented ? '请先确认词汇学习记录的 API 使用范围' : '使用已授权的 API 推荐，可能产生费用';
    return { provider, localAvailable, apiAvailable, apiConsented, notice };
  }
  function cancel({ requestId } = {}) {
    if (active && (!requestId || active.id === requestId)) {
      active.controller.abort(new Error('已取消词汇推荐'));
      active = null;
    }
    return { ok: true };
  }
  function invalidate() { consentKey = ''; cancel(); }
  function configure({ provider, apiConsent = false } = {}) {
    if (!['local', 'api', 'off'].includes(provider)) throw new Error('请选择词汇推荐方式');
    cancel();
    consentKey = provider === 'api' && apiConsent === true && available('api') ? connectionKey() : '';
    return change((data) => { data.settings.advisorProvider = provider; return { provider }; });
  }
  function recent(data) {
    const byId = new Map(data.cards.map((card) => [card.id, card]));
    return [
      ...data.logs.slice(-30).map((log) => ({ word: byId.get(log.cardId)?.word, rating: log.rating, at: log.at })),
      ...data.cards.filter((card) => card.knownAt && card.suspended).map((card) => ({ word: card.word, known: true, at: card.knownAt })),
    ].filter((item) => item.word).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 20)
      .map(({ at, ...signal }) => signal);
  }
  async function prepare({ subject = '', requestId, offline = false } = {}) {
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(requestId)) throw new Error('学习请求无效');
    cancel();
    const task = { id: requestId, controller: new AbortController() };
    active = task;
    const canceled = () => task.controller.signal.aborted || active !== task;
    subject = String(subject || '').slice(0, 60);
    const data = getData();
    const revision = getRevision();
    const queued = vocabulary.queue(data, now(), subject);
    const limit = Math.min(5, queued.filter((card) => card.schedule.state === 0).length);
    if (!limit) { active = null; return { batchIds: [], source: 'offline', notice: '', snapshot: snapshot(subject) }; }
    const candidates = vocabulary.newCandidates(data, now(), subject, 40);
    const selected = status();
    let ids = candidates.slice(0, limit).map((card) => card.id), contexts = [], source = 'offline';
    let notice = selected.notice;
    if (!offline && selected.provider !== 'off' && (selected.provider === 'local' ? selected.localAvailable : selected.apiAvailable && selected.apiConsented)) {
      try {
        const result = await advise({ provider: selected.provider, apiConsent: selected.apiConsented,
          level: data.settings.level || 'intermediate', candidates: candidates.map(({ id, word, meaning }) => ({ id, word, meaning })), recent: recent(data), limit }, { signal: task.controller.signal });
        if (!canceled() && revision === getRevision()) {
          const allowed = new Set(candidates.map((card) => card.id));
          ids = [...new Set(result.ids)].filter((id) => allowed.has(id)).slice(0, limit);
          if (!ids.length) throw Error('没有可用推荐');
          contexts = result.contexts || []; source = result.source;
          notice = source === 'local' ? '本地 AI 已根据近期学习情况安排这一组；例句请自行核对' : 'API 已根据近期学习情况安排这一组；例句请自行核对';
        }
      } catch {
        notice = 'AI 暂不可用，已按当前难度继续离线学习';
      }
    } else if (offline) notice = '已切换离线学习，不等待 AI';
    if (canceled()) return { canceled: true, batchIds: [], source: 'offline', notice: '', snapshot: snapshot(subject) };
    active = null;
    if (revision !== getRevision()) return { canceled: true, batchIds: [], source: 'offline', notice: '词书或学习设置已变化，请重新开始', snapshot: snapshot(subject) };
    const availableIds = new Set(data.cards.filter((card) => !card.suspended && card.schedule.state === 0).map((card) => card.id));
    ids = ids.filter((id) => availableIds.has(id));
    const result = change((next) => {
      next.batch = { day: vocabulary.dateKey(now()), ids };
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
  return { status, configure, prepare, cancel, invalidate };
}
module.exports = { createVocabularyStudy };

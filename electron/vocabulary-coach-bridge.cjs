'use strict';
// Only a saved word and its stored example can be sent by the study UI.
function createCoachBridge({ getCards, coach, language = () => 'zh-CN' }) {
  let active;
  function cancel({ requestId } = {}) {
    if (active && (!requestId || active.id === requestId)) { active.controller.abort(); active = null; }
    return { ok: true };
  }
  async function run(input = {}) {
    const { requestId, cardId, kind, provider } = input;
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(requestId)) throw Error('学习请求无效');
    const card = getCards().find(item => item.id === cardId);
    if (!card) throw Error('词条已变化，请重新打开');
    const expectedWord = card.word, expectedMeaning = card.meaning;
    const contexts = [card.context, ...(card.contexts || []), ...(card.encounters || []).map(item => item.context)];
    const context = input.context || '';
    if (context && !contexts.includes(context)) throw Error('例句已变化，请重新打开');
    const payload = { kind, provider, word: card.word, language: language(),
      ...(card.meaning ? { meaning: String(card.meaning).replace(/\s+/g, ' ').slice(0, 500) } : {}),
      ...(context ? { context: context.replace(/\s+/g, ' ').slice(0, 1200) } : {}),
      ...(kind === 'answer' ? { answer: input.answer } : {}),
      ...(kind === 'expression' ? { expression: String(input.expression || '').replace(/\s+/g, ' ') } : {}) };
    cancel();
    const task = { id: requestId, controller: new AbortController() }; active = task;
    try {
      const result = await coach(payload, { signal: task.controller.signal });
      if (active !== task || task.controller.signal.aborted || !getCards().some(item => item.id === cardId && item.word === expectedWord && item.meaning === expectedMeaning && (!context || [item.context, ...(item.contexts || []), ...(item.encounters || []).map(entry => entry.context)].includes(context)))) return { canceled: true };
      return result;
    } finally { if (active === task) active = null; }
  }
  return { run, cancel };
}
module.exports = { createCoachBridge };

'use strict';

const MAX_QUEUE = 40;
const BATCH_SIZE = 5;

function createContextQueue({ getCards, getProvider, authorize, advise, saveContexts, onStatus } = {}) {
  if (![getCards, getProvider, authorize, advise, saveContexts].every((fn) => typeof fn === 'function')) throw new TypeError('context queue dependencies are required');
  if (onStatus !== undefined && typeof onStatus !== 'function') throw new TypeError('onStatus must be a function');
  let pending = [];
  let task = null;
  let inFlight = 0;
  let runner = Promise.resolve();
  const report = (status) => onStatus?.(status);
  const hasContext = (card) => Boolean(String(card?.context || '').trim() || (card?.contexts || []).some((value) => String(value || '').trim()));
  const current = (id) => getCards().find((card) => card?.id === id);
  function eligible(id) {
    const card = current(id);
    return card && !card.suspended && !hasContext(card) && typeof card.word === 'string' && typeof card.meaning === 'string'
      ? { id: card.id, word: card.word, meaning: card.meaning } : null;
  }
  function start() {
    if (task || !pending.length) return;
    const controller = new AbortController(); task = { controller };
    runner = (async () => {
      try {
        while (!controller.signal.aborted && pending.length) {
          const provider = getProvider();
          if (provider === 'off') { pending = []; report({ state: 'skipped', reason: 'off' }); break; }
          try { await authorize(provider); } catch { pending = []; report({ state: 'skipped', reason: 'unauthorized', provider }); break; }
          const candidates = pending.splice(0, BATCH_SIZE).map((id) => eligible(id)).filter(Boolean);
          if (!candidates.length) continue;
          inFlight = candidates.length;
          report({ state: 'working', provider, count: candidates.length, remaining: pending.length });
          let result;
          try {
            result = await advise({ provider, apiConsent: provider === 'api', level: 'intermediate', candidates, recent: [], limit: candidates.length }, { signal: controller.signal });
          } catch (error) {
            if (!controller.signal.aborted) report({ state: 'failed', provider, error: String(error?.message || '') });
            // Do not retry automatically: a background import must never turn
            // into repeated paid API calls or an endless local-model loop.
            inFlight = 0; continue;
          }
          if (controller.signal.aborted || getProvider() !== provider) { inFlight = 0; report({ state: 'canceled', provider }); break; }
          try { await authorize(provider); } catch { inFlight = 0; report({ state: 'canceled', provider }); break; }
          const byId = new Map(candidates.map((card) => [card.id, card]));
          const updates = [];
          for (const item of result?.contexts || []) {
            const expected = byId.get(item?.id); const card = expected && current(expected.id);
            if (!card || card.word !== expected.word || card.meaning !== expected.meaning || hasContext(card) || typeof item.sentence !== 'string') continue;
            updates.push({ id: card.id, word: expected.word, meaning: expected.meaning, context: item.sentence });
          }
          if (updates.length) await saveContexts(updates);
          inFlight = 0;
          report({ state: 'completed', provider, added: updates.length, remaining: pending.length });
        }
      } finally { inFlight = 0; task = null; if (!pending.length) report({ state: 'idle' }); }
    })().catch((error) => { task = null; report({ state: 'failed', error: String(error?.message || '') }); });
  }
  function enqueue(ids) {
    if (!Array.isArray(ids)) throw new Error('词条列表无效');
    const known = new Set(pending); let queued = 0; let skipped = 0;
    for (const id of ids) {
      if (typeof id !== 'string' || known.has(id) || !eligible(id) || pending.length + inFlight >= MAX_QUEUE) { skipped++; continue; }
      pending.push(id); known.add(id); queued++;
    }
    if (queued) { report({ state: 'queued', queued, skipped, total: pending.length }); start(); }
    return { queued, skipped, total: pending.length };
  }
  function cancel() {
    pending = [];
    if (task) task.controller.abort(new Error('已取消例句生成'));
    report({ state: 'canceled' });
    return { ok: true };
  }
  async function idle() { await runner; }
  return { enqueue, cancel, idle };
}

module.exports = { createContextQueue, MAX_QUEUE, BATCH_SIZE };

const { randomUUID } = require('node:crypto');
const { createEmptyCard, fsrs } = require('ts-fsrs');
const reading = require('./vocabulary-reading.cjs');
const { findContext } = require('./vocabulary-contexts.cjs');

const MAX_CARDS = 10000;
const MAX_LOGS = 30000;
const MODES = ['mixed', 'meaning', 'spelling', 'context'];
const text = (value, limit) => String(value ?? '').replaceAll('\0', '').trim().slice(0, limit);
const wordKey = (value) => text(value, 100).normalize('NFKC').toLowerCase().replaceAll('’', "'");
const dateKey = (value) => {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const plain = (value) => JSON.parse(JSON.stringify(value));
const validDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const integer = (value, low, high, fallback) => Number.isInteger(value) && value >= low && value <= high ? value : fallback;

function emptyVocabulary() {
  return { version: 1, settings: { dailyNewLimit: 10, retention: 0.9, mode: 'mixed' }, cards: [], logs: [], readings: [], readingLogs: [], batch: null };
}

function cleanSchedule(raw, now) {
  if (!raw || !validDate(raw.due)) return plain(createEmptyCard(now));
  if (!Number.isInteger(raw.state) || raw.state < 0 || raw.state > 3) return plain(createEmptyCard(now));
  const result = plain(createEmptyCard(now));
  result.due = new Date(raw.due).toISOString();
  for (const key of ['stability', 'difficulty']) {
    if (!Number.isFinite(raw[key]) || raw[key] < 0 || raw[key] > 1000000) return plain(createEmptyCard(now));
    result[key] = raw[key];
  }
  for (const key of ['elapsed_days', 'scheduled_days', 'reps', 'lapses', 'learning_steps']) {
    if (!Number.isInteger(raw[key]) || raw[key] < 0 || raw[key] > 1000000) return plain(createEmptyCard(now));
    result[key] = raw[key];
  }
  result.state = raw.state;
  if (validDate(raw.last_review)) result.last_review = new Date(raw.last_review).toISOString();
  const validLearningStep = result.state === 1 ? result.learning_steps <= 1 : result.learning_steps === 0;
  if (!validLearningStep) return plain(createEmptyCard(now));
  if (result.state === 0 && (result.stability !== 0 || result.difficulty !== 0 || result.elapsed_days !== 0
      || result.scheduled_days !== 0 || result.reps !== 0 || result.lapses !== 0 || result.last_review)) return plain(createEmptyCard(now));
  if (result.lapses > result.reps) return plain(createEmptyCard(now));
  if (result.state !== 0 && (!result.last_review || result.stability <= 0 || result.difficulty < 1 || result.difficulty > 10)) return plain(createEmptyCard(now));
  return result;
}

function cleanCard(raw, now = new Date()) {
  const word = text(raw?.word, 100);
  const meaning = text(raw?.meaning, 4000);
  if (!word || !meaning || !/^[a-zA-Z][a-zA-Z '\-’]*$/.test(word)) return null;
  const example = findContext(word);
  return {
    id: /^[a-zA-Z0-9-]{1,80}$/.test(raw.id || '') ? raw.id : randomUUID(),
    word, meaning, phonetic: text(raw.phonetic, 200), definition: text(raw.definition, 4000),
    context: text(raw.context || example?.sentence, 1600), ownExample: text(raw.ownExample, 1600),
    contextSource: text(raw.contextSource || (!raw.context && example ? 'PH Launcher 原创例句' : ''), 80),
    frequency: integer(raw.frequency, 0, 1000000, 0),
    level: ['foundation', 'intermediate', 'advanced'].includes(raw.level) ? raw.level : example?.level || '',
    knownAt: validDate(raw.knownAt) ? raw.knownAt : '',
    contexts: [...new Set((Array.isArray(raw.contexts) ? raw.contexts : []).map((s) => text(s, 1600)).filter(Boolean))].slice(0, 12),
    encounters: (Array.isArray(raw.encounters) ? raw.encounters : []).filter((e) => e && validDate(e.at) && e.context)
      .slice(-24).map((e) => ({ readingId: text(e.readingId, 80), context: text(e.context, 1600), at: e.at })),
    subject: text(raw.subject, 60) || '我的生词', source: text(raw.source, 500),
    createdAt: validDate(raw.createdAt) ? raw.createdAt : now.toISOString(),
    suspended: raw.suspended === true,
    schedule: cleanSchedule(raw.schedule, now),
  };
}

function normalizeVocabulary(raw, now = new Date()) {
  const result = emptyVocabulary();
  const settings = raw?.settings || {};
  result.settings.dailyNewLimit = integer(settings.dailyNewLimit, 0, 100, 10);
  result.settings.retention = [0.8, 0.85, 0.9, 0.95].includes(settings.retention) ? settings.retention : 0.9;
  result.settings.mode = MODES.includes(settings.mode) ? settings.mode : 'mixed';
  result.settings.level = ['foundation', 'intermediate', 'advanced'].includes(settings.level) ? settings.level : '';
  result.settings.advisorProvider = ['local', 'api', 'off'].includes(settings.advisorProvider) ? settings.advisorProvider : 'local';
  result.settings.advisorIntroSeen = settings.advisorIntroSeen === true;
  const placement = settings.placement;
  if (placement && ['self','toefl-legacy','toefl-current','ielts','quiz','default'].includes(placement.source)) {
    result.settings.placement = { source: placement.source, recommendedLevel: result.settings.level,
      completedAt: typeof placement.completedAt === 'string' && Number.isFinite(Date.parse(placement.completedAt)) ? new Date(placement.completedAt).toISOString() : null };
  }
  const keys = new Set();
  const ids = new Set();
  for (const item of (Array.isArray(raw?.cards) ? raw.cards : []).slice(0, MAX_CARDS)) {
    const card = cleanCard(item, now);
    if (!card || keys.has(wordKey(card.word))) continue;
    if (ids.has(card.id)) card.id = randomUUID();
    keys.add(wordKey(card.word)); ids.add(card.id); result.cards.push(card);
  }
  result.logs = (Array.isArray(raw?.logs) ? raw.logs : []).slice(-MAX_LOGS).filter((log) =>
    ids.has(log?.cardId) && validDate(log.at) && [1, 2, 3, 4].includes(log.rating)
  ).map((log) => ({ id: text(log.id, 80) || randomUUID(), cardId: log.cardId, at: log.at,
    rating: log.rating, wasNew: log.wasNew === true, mode: MODES.includes(log.mode) ? log.mode : 'meaning',
    previous: log.previous ? cleanSchedule(log.previous, now) : null,
  }));
  result.readings = reading.normalizeReadings(raw?.readings);
  result.readingLogs = reading.normalizeReadingLogs(raw?.readingLogs, result.readings);
  if (raw?.batch && Array.isArray(raw.batch.ids)) {
    const phase = ['preview', 'recall'].includes(raw.batch.phase) ? raw.batch.phase : 'preview';
    const index = integer(raw.batch.index, 0, 4, 0);
    result.batch = { day: raw.batch.day, ids: [...new Set(raw.batch.ids.filter((id) => ids.has(id)))].slice(0, 5), phase, index };
  }
  return result;
}

function scheduler(data) {
  return fsrs({ request_retention: data.settings.retention, enable_fuzz: false, maximum_interval: 3650,
    learning_steps: ['1m', '10m'], relearning_steps: ['10m'] });
}

// A new-word order should feel mixed, while still being stable for one day so a
// refresh never changes the group a learner has just started.  Card IDs are
// random at creation time, unlike import time and alphabetical word order.
function dailyNewOrder(card, day) {
  let hash = 2166136261;
  for (const char of `${day}|${card.id}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function cardLevel(card) {
  if (['foundation', 'intermediate', 'advanced'].includes(card.level)) return card.level;
  if (card.frequency > 0) return card.frequency <= 3000 ? 'foundation' : card.frequency <= 6000 ? 'intermediate' : 'advanced';
  return '';
}

function newCandidates(data, now = new Date(), subject = '', limit = 40) {
  const day = dateKey(now);
  const levels = ['foundation', 'intermediate', 'advanced'];
  const target = levels.indexOf(data.settings.level);
  const distance = (card) => {
    if (target < 0) return 0;
    const level = levels.indexOf(cardLevel(card));
    return level < 0 ? 3 : Math.abs(level - target);
  };
  return data.cards.filter((card) => !card.suspended && card.schedule.state === 0 && (!subject || card.subject === subject))
    .sort((a, b) => distance(a) - distance(b) || dailyNewOrder(a, day) - dailyNewOrder(b, day) || a.id.localeCompare(b.id))
    .slice(0, Math.min(10000, Math.max(0, limit)));
}

function queue(data, now = new Date(), subject = '') {
  const day = dateKey(now);
  const learnedToday = new Set(data.logs.filter((l) => l.wasNew && dateKey(l.at) === day).map((l) => l.cardId)).size;
  const active = data.cards.filter((c) => !c.suspended && (!subject || c.subject === subject));
  const due = active.filter((c) => c.schedule.state !== 0 && Date.parse(c.schedule.due) <= now.getTime())
    .sort((a, b) => Date.parse(a.schedule.due) - Date.parse(b.schedule.due));
  const pinned = data.batch?.ids || [];
  const fresh = newCandidates(data, now, subject, MAX_CARDS)
    .sort((a, b) => (pinned.includes(a.id) ? pinned.indexOf(a.id) : 99) - (pinned.includes(b.id) ? pinned.indexOf(b.id) : 99))
    .slice(0, Math.max(0, data.settings.dailyNewLimit - learnedToday));
  return [...due, ...fresh];
}

function snapshot(data, now = new Date(), subject = '') {
  const today = data.logs.filter((l) => dateKey(l.at) === dateKey(now));
  const active = data.cards.filter((c) => !c.suspended);
  const list = queue(data, now, subject);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    days.push({ day: dateKey(d), count: data.logs.filter((l) => dateKey(l.at) === dateKey(d)).length });
  }
  const nextDue = active.filter((c) => c.schedule.state !== 0 && Date.parse(c.schedule.due) > now.getTime())
    .sort((a, b) => Date.parse(a.schedule.due) - Date.parse(b.schedule.due))[0]?.schedule.due || null;
  const selected = list[0];
  const intervals = selected ? Object.fromEntries([1, 2, 3, 4].map((rating) =>
    [rating, scheduler(data).next(selected.schedule, now, rating).card.due.toISOString()])) : {};
  return { settings: data.settings, cards: data.cards, batch: data.batch ? plain(data.batch) : null, queueIds: list.map((c) => c.id), intervals,
    study: { level: data.settings.level || '',
      newAtLevel: active.filter((c) => c.schedule.state === 0 && (!subject || c.subject === subject) && (!data.settings.level || cardLevel(c) === data.settings.level)).length,
      hasContext: list.filter((c) => [c.context, ...(c.contexts || []), ...(c.encounters || []).map((entry) => entry.context)].some((context) => usableCloze(context, c.word))).length },
    readings: data.readings, readingStats: reading.readingStats(data, now),
    stats: { total: data.cards.length, due: active.filter((c) => c.schedule.state !== 0 && Date.parse(c.schedule.due) <= now).length,
      newAvailable: list.filter((c) => c.schedule.state === 0).length,
      todayReviews: today.length, todayWords: new Set(today.map((l) => l.cardId)).size,
      recallRate: today.length ? Math.round(today.filter((l) => l.rating > 1).length / today.length * 100) : null,
      learned: active.filter((c) => c.schedule.state !== 0).length,
      difficult: active.filter((c) => c.schedule.lapses >= 3).length, days, nextDue },
    undoAvailable: Boolean(data.logs.at(-1)?.previous) };
}

function addCards(data, entries, now = new Date()) {
  if (!Array.isArray(entries) || entries.length > 1000) throw new Error('一次最多添加 1000 个词条');
  const keys = new Set(data.cards.map((c) => wordKey(c.word)));
  const staged = [];
  let duplicates = 0;
  let invalid = 0;
  let contextsAdded = 0;
  for (const input of entries) {
    const card = cleanCard({ ...input, id: randomUUID(), schedule: null, createdAt: now.toISOString(), suspended: false }, now);
    if (!card) { invalid++; continue; }
    if (keys.has(wordKey(card.word))) {
      duplicates++;
      const existing = data.cards.find((item) => wordKey(item.word) === wordKey(card.word)) || staged.find((item) => wordKey(item.word) === wordKey(card.word));
      const context = text(input.context, 1600);
      if (existing && usableCloze(context, existing.word) && ![existing.context, ...(existing.contexts || [])].includes(context)) {
        if (!existing.context) { existing.context = context; existing.contextSource = text(input.source, 80); }
        else existing.contexts = [...(existing.contexts || []).slice(-11), context];
        contextsAdded++;
      }
      continue;
    }
    keys.add(wordKey(card.word)); staged.push(card);
  }
  if (data.cards.length + staged.length > MAX_CARDS) throw new Error(`词本最多容纳 ${MAX_CARDS} 个词条，请先整理词本`);
  data.cards.push(...staged);
  return { added: staged.length, duplicates, invalid, contextsAdded };
}

function reviewCard(data, { id, rating, expectedReps, mode, subject = '' }, now = new Date()) {
  if (![1, 2, 3, 4].includes(rating)) throw new Error('请选择真实的回忆情况');
  const card = data.cards.find((c) => c.id === id);
  if (!card || card.suspended) throw new Error('词条已变更，请重新开始');
  if (card.schedule.reps !== expectedReps) throw new Error('这次复习已经记录，请刷新词卡');
  const scope = typeof subject === 'string' ? subject.slice(0, 60) : '';
  if (!queue(data, now, scope).some((c) => c.id === id)) throw new Error('尚未到复习时间，或今天的新词额度已用完');
  const previous = plain(card.schedule);
  const result = scheduler(data).next(card.schedule, now, rating);
  card.schedule = plain(result.card);
  data.logs.push({ id: randomUUID(), cardId: card.id, at: now.toISOString(), rating,
    wasNew: previous.state === 0, mode: MODES.includes(mode) ? mode : 'meaning', previous });
  data.logs = data.logs.slice(-MAX_LOGS);
  if (Array.isArray(data.batch?.ids)) {
    data.batch.ids = data.batch.ids.filter((batchId) => batchId !== card.id);
    if (!data.batch.ids.length) delete data.batch;
  }
  return { nextDue: card.schedule.due, lapses: card.schedule.lapses };
}

function undoReview(data) {
  const log = data.logs.at(-1);
  if (!log?.previous) throw new Error('没有可撤销的复习');
  const card = data.cards.find((c) => c.id === log.cardId);
  if (!card) throw new Error('词条已删除，无法撤销');
  card.schedule = plain(log.previous);
  data.logs.pop();
  return { word: card.word };
}

function updateCard(data, input) {
  const card = data.cards.find((c) => c.id === input.id);
  if (!card) throw new Error('找不到词条');
  if (typeof input.suspended === 'boolean') card.suspended = input.suspended;
  if (input.suspended === true && input.known === true && card.schedule.state === 0) card.knownAt = new Date().toISOString();
  if (input.suspended === false) card.knownAt = '';
  if (input.suspended === true && input.known === true && Array.isArray(data.batch?.ids)) {
    data.batch.ids = data.batch.ids.filter((batchId) => batchId !== card.id);
    if (!data.batch.ids.length) delete data.batch;
  }
  for (const key of ['context', 'ownExample', 'subject', 'meaning']) {
    if (typeof input[key] !== 'string') continue;
    const value = text(input[key], key === 'subject' ? 60 : key === 'meaning' ? 4000 : 1600);
    if (['subject', 'meaning'].includes(key) && !value) throw new Error('科目和释义不能为空');
    card[key] = value;
  }
  return { id: card.id };
}

function updateBatchProgress(data, { ids, phase = 'preview', index = 0 } = {}, now = new Date()) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 5 || new Set(ids).size !== ids.length) throw new Error('学习分组无效');
  if (!['preview', 'recall'].includes(phase) || !Number.isInteger(index) || index < 0 || index > 4) throw new Error('学习进度无效');
  const allowed = new Set(data.cards.filter((card) => !card.suspended && card.schedule.state === 0).map((card) => card.id));
  const valid = ids.filter((id) => allowed.has(id));
  if (!valid.length) { delete data.batch; return { ids: [] }; }
  data.batch = { day: dateKey(now), ids: [...new Set(valid)].slice(0, 5), phase, index: Math.min(index, valid.length - 1) };
  return { ids: data.batch.ids, phase: data.batch.phase, index: data.batch.index };
}

function removeCard(data, id) {
  data.cards = data.cards.filter((c) => c.id !== id);
  data.logs = data.logs.filter((l) => l.cardId !== id);
  return { ok: true };
}

function configure(data, input) {
  const normalized = normalizeVocabulary({ settings: { ...data.settings, ...input } });
  if (normalized.settings.level !== data.settings.level) delete data.batch;
  data.settings = normalized.settings;
  return data.settings;
}

function importVocabulary(data, raw, now = new Date()) {
  if (!raw || raw.format !== 'ph-vocabulary' || raw.version !== 1 || !Array.isArray(raw.data?.cards)) throw new Error('请选择 PH Launcher 导出的词本 JSON');
  if (raw.data.cards.length > MAX_CARDS) throw new Error('词本文件超过 10000 个词条');
  const imported = normalizeVocabulary(raw.data, now);
  if (raw.data.cards.length && !imported.cards.length) throw new Error('文件中没有可用词条');
  const keys = new Set(data.cards.map((c) => wordKey(c.word)));
  const ids = new Set(data.cards.map((c) => c.id));
  const mapping = new Map();
  const staged = [];
  for (const card of imported.cards) {
    if (keys.has(wordKey(card.word))) continue;
    const oldId = card.id;
    if (ids.has(card.id)) card.id = randomUUID();
    mapping.set(oldId, card.id); ids.add(card.id); keys.add(wordKey(card.word)); staged.push(card);
  }
  if (data.cards.length + staged.length > MAX_CARDS) throw new Error('合并后超过 10000 个词条');
  data.cards.push(...staged);
  data.logs.push(...imported.logs.filter((l) => mapping.has(l.cardId)).map((l) => ({ ...l, id: randomUUID(), cardId: mapping.get(l.cardId), previous: null })));
  data.logs = data.logs.sort((a, b) => a.at.localeCompare(b.at)).slice(-MAX_LOGS);
  const readingIds = new Set(data.readings.map((r) => r.id));
  const fingerprints = new Set(data.readings.map((r) => r.fingerprint));
  const readingMapping = new Map();
  for (const item of imported.readings) {
    if (fingerprints.has(item.fingerprint) || data.readings.length >= 100) continue;
    const previousId = item.id;
    if (readingIds.has(item.id)) item.id = randomUUID();
    readingIds.add(item.id); fingerprints.add(item.fingerprint); readingMapping.set(previousId, item.id); data.readings.push(item);
  }
  data.readingLogs.push(...imported.readingLogs.filter((l) => readingMapping.has(l.readingId)).map((l) => ({ ...l, readingId: readingMapping.get(l.readingId) })));
  data.readingLogs = data.readingLogs.sort((a, b) => a.at.localeCompare(b.at)).slice(-3000);
  return { added: staged.length, duplicates: imported.cards.length - staged.length, invalid: raw.data.cards.length - imported.cards.length };
}

function parseWordList(raw) {
  if (typeof raw !== 'string' || raw.length > 500000) throw new Error('文本过长，请分批导入');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length > 1000) throw new Error('一次最多导入 1000 行');
  return lines.map((line) => {
    const [word, meaning, context, subject] = line.split('\t');
    return { word: text(word, 100), meaning: text(meaning, 4000), context: text(context, 1600), subject: text(subject, 60) || '导入词本', source: '自行导入' };
  });
}

function cloze(context, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![a-zA-Z])${escaped}(?![a-zA-Z])`, 'gi');
  return context.replace(pattern, '_____');
}

function usableCloze(context, word) {
  if (typeof context !== 'string' || typeof word !== 'string' || !context || !word) return false;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![a-zA-Z])${escaped}(?![a-zA-Z])`, 'gi');
  return (context.match(pattern) || []).length === 1;
}

const STOP_WORDS = new Set('the a an and or but of in on at to for is are was were be been being this that these those i you he she it we they my your his her its our their as with by from not have has had do does did can could will would should may might must if so than then there here which who what when where how all some any no into about up out one two also very'.split(' '));

function paragraphCandidates(raw, dictionary, known = []) {
  const passage = text(raw, 20000);
  const knownKeys = new Set(known.map((c) => wordKey(c.word)));
  const words = [...new Set((passage.match(/[a-zA-Z]+(?:['’-][a-zA-Z]+)*/g) || []).map(wordKey))]
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w)).slice(0, 300);
  const sentences = passage.match(/[^.!?\n]+[.!?]?/g) || [passage];
  const result = [];
  for (const word of words) {
    const entry = dictionary.lookup(word).exact;
    if (!entry || wordKey(entry.word) !== wordKey(word)) continue;
    result.push({ word: entry.word, meaning: entry.translation || entry.definition, phonetic: entry.phonetic,
      definition: entry.definition, context: text(sentences.find((s) => usableCloze(s, word)) || '', 1600),
      subject: '阅读生词', source: '我的阅读材料', saved: knownKeys.has(wordKey(entry.word)) });
    if (result.length >= 80) break;
  }
  return result;
}

module.exports = { emptyVocabulary, normalizeVocabulary, snapshot, queue, addCards, reviewCard,
  undoReview, updateCard, updateBatchProgress, removeCard, configure, importVocabulary, parseWordList, paragraphCandidates,
  wordKey, cloze, usableCloze, dateKey, cardLevel, newCandidates, MAX_CARDS };

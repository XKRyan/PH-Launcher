const { randomUUID, createHash } = require('node:crypto');
const tokens = (text) => (String(text || '').match(/[a-zA-Z]+(?:['’-][a-zA-Z]+)*/g) || []);
const key = (word) => String(word).toLowerCase().replaceAll('’', "'");
const bounded = (text, max) => String(text ?? '').replaceAll('\0', '').trim().slice(0, max);
const validDate = (date) => typeof date === 'string' && Number.isFinite(Date.parse(date));
const day = (date) => { const d = new Date(date); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const digest = (text) => createHash('sha256').update(text).digest('hex');

function normalizeReadings(raw) {
  const readings = []; const ids = new Set();
  for (const item of (Array.isArray(raw) ? raw : []).slice(0, 100)) {
    const text = bounded(item?.text, 20000);
    if (!text || !tokens(text).length) continue;
    const id = /^[a-zA-Z0-9-]{1,80}$/.test(item.id || '') && !ids.has(item.id) ? item.id : randomUUID();
    ids.add(id);
    readings.push({ id, title: bounded(item.title, 120) || '我的阅读', text, fingerprint: digest(text),
      createdAt: validDate(item.createdAt) ? item.createdAt : new Date().toISOString(),
      lastReadAt: validDate(item.lastReadAt) ? item.lastReadAt : '',
      readCount: Number.isInteger(item.readCount) && item.readCount >= 0 ? Math.min(item.readCount, 100000) : 0,
      wordCount: tokens(text).length });
  }
  return readings;
}

function normalizeReadingLogs(raw, readings) {
  const ids = new Set(readings.map((r) => r.id));
  return (Array.isArray(raw) ? raw : []).slice(-3000).filter((l) => l && ids.has(l.readingId) && validDate(l.at))
    .map((l) => ({ readingId: l.readingId, at: l.at, words: Math.max(0, Math.min(20000, Number(l.words) || 0)),
      seconds: Math.max(0, Math.min(14400, Number(l.seconds) || 0)), unknownCount: Math.max(0, Math.min(20000, Number(l.unknownCount) || 0)) }));
}

function saveReading(data, input, now = new Date()) {
  if (typeof input?.text !== 'string' || input.text.length > 20000) throw new Error('每篇最多 20000 字符，请按章节分段');
  const text = bounded(input.text, 20000);
  if (!tokens(text).length) throw new Error('请粘贴一段含英文的阅读材料');
  const existing = data.readings.find((r) => r.fingerprint === digest(text));
  if (existing) return { id: existing.id, duplicate: true };
  if (data.readings.length >= 100) throw new Error('最多保存 100 篇阅读，请先导出备份并整理');
  const reading = { id: randomUUID(), title: bounded(input.title, 120) || '我的阅读', text,
    fingerprint: digest(text), createdAt: now.toISOString(), lastReadAt: '', readCount: 0, wordCount: tokens(text).length };
  data.readings.unshift(reading);
  return { id: reading.id };
}

function finishReading(data, input, now = new Date()) {
  const reading = data.readings.find((r) => r.id === input?.id);
  if (!reading) throw new Error('找不到这篇文章');
  if (input.expectedReadCount !== reading.readCount) throw new Error('这次阅读已经记录，请重新打开文章');
  const allTokens = tokens(reading.text).map(key);
  const tokenSet = new Set(allTokens);
  const unknown = new Set((Array.isArray(input.unknownWords) ? input.unknownWords : []).slice(0, 500).map(key).filter((w) => tokenSet.has(w)));
  const unknownCount = allTokens.filter((w) => unknown.has(w)).length;
  const seconds = Number.isFinite(input.seconds) ? Math.round(Math.max(0, Math.min(14400, input.seconds))) : 0;
  const at = now.toISOString();
  data.readingLogs.push({ readingId: reading.id, at, words: allTokens.length, seconds, unknownCount });
  data.readingLogs = data.readingLogs.slice(-3000);
  reading.readCount++; reading.lastReadAt = at;
  const sentences = reading.text.match(/[^.!?\n]+[.!?]?/g) || [reading.text];
  let encounters = 0;
  for (const card of data.cards) {
    if (!tokenSet.has(key(card.word))) continue;
    card.encounters ||= [];
    if (card.encounters.some((e) => e.readingId === reading.id)) continue;
    const context = sentences.find((s) => tokens(s).map(key).includes(key(card.word)));
    if (!context) continue;
    card.encounters.push({ readingId: reading.id, context: bounded(context, 1600), at });
    card.encounters = card.encounters.slice(-24);
    encounters++;
  }
  return { words: allTokens.length, seconds, unknownCount, encounters,
    markedKnownPercent: Math.round((1 - unknownCount / Math.max(1, allTokens.length)) * 1000) / 10 };
}

function readingStats(data, now = new Date()) {
  const logs = data.readingLogs || [];
  const today = logs.filter((l) => day(l.at) === day(now));
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date(now); date.setDate(date.getDate() - i);
    days.push({ day: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
      words: logs.filter((l) => day(l.at) === day(date)).reduce((n, l) => n + l.words, 0) });
  }
  return { todayWords: today.reduce((n, l) => n + l.words, 0), todaySeconds: today.reduce((n, l) => n + l.seconds, 0),
    totalWords: logs.reduce((n, l) => n + l.words, 0), days };
}
module.exports = { tokens, normalizeReadings, normalizeReadingLogs, saveReading, finishReading, readingStats };

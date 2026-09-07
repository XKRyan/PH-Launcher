'use strict';

// Catalog entries are *filters* over the already-bundled ECDICT database, not
// copied proprietary word lists. ECDICT is MIT-licensed; its `oxford`, `tags`,
// `collins`, and `frq` fields are exposed as source metadata, not PH claims
// about official exams or a learner's proficiency.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
let cachedCatalog = null;

const SOURCE = 'ECDICT（skywind3000/ECDICT）';
const LICENSE = 'MIT License';
const SOURCE_URL = 'https://github.com/skywind3000/ECDICT';
const CATALOG = Object.freeze([
  { id: 'ecdict-oxford-core', name: '核心起步词', description: 'ECDICT 标注的 Oxford 3000 核心词；适合先打基础，不等同于任何考试词表。', levels: ['foundation', 'intermediate'], source: SOURCE, license: LICENSE, sourceUrl: SOURCE_URL },
  { id: 'ecdict-gk', name: '高中常见词', description: 'ECDICT 的 gk 标签筛选；可作高中阅读复习参考，非官方高考大纲。', levels: ['intermediate'], source: SOURCE, license: LICENSE, sourceUrl: SOURCE_URL },
  { id: 'ecdict-high-frequency', name: '高频阅读词', description: 'ECDICT 的 COCA 词频序号前 3,000；语料频率不是精确难度等级或考试词表。', levels: ['foundation', 'intermediate'], source: SOURCE, license: LICENSE, sourceUrl: SOURCE_URL },
  { id: 'ecdict-collins-core', name: '常用核心词', description: 'ECDICT 的 Collins 3 星及以上标注；这是常用度索引，不代表进阶难度。', levels: ['foundation', 'intermediate'], source: SOURCE, license: LICENSE, sourceUrl: SOURCE_URL },
  { id: 'ecdict-reading-extended', name: '阅读扩展词', description: 'ECDICT 的 COCA 词频序号 3,001–10,000；用于扩展阅读，不是精确难度等级。', levels: ['advanced'], source: SOURCE, license: LICENSE, sourceUrl: SOURCE_URL },
  { id: 'ecdict-toefl-core', name: '托福核心参考词', description: 'ECDICT 的 toefl 标签中，词频序号 1–6,000 的非官方核心整理；仅作备考参考，不代表官方考试词表或覆盖率。', levels: ['intermediate', 'advanced'], source: SOURCE, license: LICENSE, sourceUrl: SOURCE_URL },
  { id: 'ecdict-toefl-extended', name: '托福扩展参考词', description: 'ECDICT 的 toefl 标签中，排除词频序号 1–6,000 后的词（含未知词频）；仅作非官方备考参考。', levels: ['advanced'], source: SOURCE, license: LICENSE, sourceUrl: SOURCE_URL },
  { id: 'ecdict-ielts-reference', name: '雅思参考词', description: 'ECDICT 的 ielts 标签筛选；这是非官方阅读与备考参考，不代表官方雅思词表或覆盖率。', levels: ['intermediate', 'advanced'], source: SOURCE, license: LICENSE, sourceUrl: SOURCE_URL },
  { id: 'ecdict-cet4-reference', name: '四级参考词', description: 'ECDICT 的 cet4 标签筛选；这是非官方大学英语四级复习参考，不代表官方大纲或覆盖率。', levels: ['foundation', 'intermediate'], source: SOURCE, license: LICENSE, sourceUrl: SOURCE_URL },
  { id: 'ecdict-cet6-reference', name: '六级参考词', description: 'ECDICT 的 cet6 标签筛选；这是非官方大学英语六级复习参考，不代表官方大纲或覆盖率。', levels: ['intermediate', 'advanced'], source: SOURCE, license: LICENSE, sourceUrl: SOURCE_URL },
  { id: 'ecdict-gre-extended', name: 'GRE 扩展参考词', description: 'ECDICT 的 gre 标签筛选；这是非官方进阶阅读与备考参考，不代表官方 GRE 词表或覆盖率。', levels: ['advanced'], source: SOURCE, license: LICENSE, sourceUrl: SOURCE_URL },
  { id: 'ecdict-deep-reading', name: '深度阅读词', description: 'ECDICT 的 COCA 词频序号 10,001–30,000；用于较高难度阅读扩展，不是精确难度等级。', levels: ['advanced'], source: SOURCE, license: LICENSE, sourceUrl: SOURCE_URL },
]);

const clauses = Object.freeze({
  'ecdict-oxford-core': 'oxford = 1',
  'ecdict-gk': "(' ' || tags || ' ') LIKE '% gk %'",
  'ecdict-high-frequency': 'frq BETWEEN 1 AND 3000',
  'ecdict-collins-core': 'collins >= 3',
  'ecdict-reading-extended': 'frq BETWEEN 3001 AND 10000',
  'ecdict-toefl-core': "(' ' || COALESCE(tags, '') || ' ') LIKE '% toefl %' AND frq BETWEEN 1 AND 6000",
  // ECDICT uses zero (and occasionally no value) where a frequency rank is
  // unknown. Keep those tagged terms in the extension rather than dropping
  // them or reintroducing the core's first 6,000 ranks.
  'ecdict-toefl-extended': "(' ' || COALESCE(tags, '') || ' ') LIKE '% toefl %' AND (frq = 0 OR frq > 6000 OR frq IS NULL)",
  'ecdict-ielts-reference': "(' ' || COALESCE(tags, '') || ' ') LIKE '% ielts %'",
  'ecdict-cet4-reference': "(' ' || COALESCE(tags, '') || ' ') LIKE '% cet4 %'",
  'ecdict-cet6-reference': "(' ' || COALESCE(tags, '') || ' ') LIKE '% cet6 %'",
  'ecdict-gre-extended': "(' ' || COALESCE(tags, '') || ' ') LIKE '% gre %'",
  'ecdict-deep-reading': 'frq BETWEEN 10001 AND 30000',
});

function catalog(databasePath = '') {
  if (!databasePath) return CATALOG.map((item) => ({ ...item, count: null }));
  const filename = path.resolve(databasePath);
  const stat = fs.statSync(filename);
  const key = `${filename}:${stat.mtimeMs}:${stat.size}`;
  if (cachedCatalog?.key === key) return structuredClone(cachedCatalog.items);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec('PRAGMA query_only = ON;');
    const items = CATALOG.map((item) => ({ ...item, count: Number(database.prepare(`SELECT count(*) AS count FROM entries WHERE ${clauses[item.id]}`).get().count) }));
    cachedCatalog = { key, items };
    return structuredClone(items);
  } finally { database.close(); }
}

function normalizeLimit(value) {
  const limit = Number(value);
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 500;
}

function words(id, limit = 500, databasePath = '', options = {}) {
  const clause = clauses[id];
  if (!clause) throw new Error('未知词书');
  if (!databasePath) throw new Error('词书需要已准备好的离线词典数据');
  const requested = normalizeLimit(limit);
  const excluded = new Set((options.excludeWords instanceof Set ? [...options.excludeWords] : Array.isArray(options.excludeWords) ? options.excludeWords : [])
    .map((word) => String(word || '').trim().toLowerCase()).filter(Boolean));
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec('PRAGMA query_only = ON;');
    // Fetch a small surplus so punctuation-only/foreign-script dictionary
    // entries never consume the user's bounded import allowance.
    const rows = database.prepare(`SELECT word FROM entries WHERE ${clause}
      ORDER BY CASE WHEN frq BETWEEN 1 AND 999999999 THEN 0 ELSE 1 END, frq, word COLLATE NOCASE
      LIMIT 10000`).all();
    const seen = new Set();
    return rows.map((row) => String(row.word || '').trim())
      .filter((word) => /^[A-Za-z]+(?:[ '-][A-Za-z]+)*$/.test(word))
      .filter((word) => {
        const key = word.toLowerCase();
        if (seen.has(key) || excluded.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, requested);
  } finally { database.close(); }
}

module.exports = { catalog, words, normalizeLimit };

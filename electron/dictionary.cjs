const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

function normalizeSearchKey(value) {
  return String(value || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function parseExchange(rawValue) {
  const labels = {
    p: '过去式',
    d: '过去分词',
    i: '现在分词',
    3: '第三人称单数',
    r: '比较级',
    t: '最高级',
    s: '复数',
    0: '原形',
  };
  return String(rawValue || '')
    .split('/')
    .map((item) => item.split(':'))
    .filter(([type, word]) => labels[type] && word)
    .map(([type, word]) => ({ label: labels[type], word }));
}

function compactEntry(row) {
  if (!row) return null;
  return {
    word: row.word,
    phonetic: row.phonetic,
    definition: row.definition,
    translation: row.translation,
    pos: row.pos,
    collins: row.collins,
    oxford: Boolean(row.oxford),
    tags: row.tags ? row.tags.split(/\s+/).filter(Boolean) : [],
    bnc: row.bnc,
    frq: row.frq,
    exchange: parseExchange(row.exchange),
  };
}

class OfflineDictionary {
  constructor(databasePath) {
    this.databasePath = databasePath;
    this.database = null;
    this.statements = null;
  }

  open() {
    if (this.database) return;
    if (!fs.existsSync(this.databasePath)) throw new Error('离线词典数据缺失，请重新安装 PH Launcher');
    this.database = new DatabaseSync(this.databasePath, { readOnly: true });
    this.database.exec('PRAGMA query_only = ON;');
    this.statements = {
      exact: this.database.prepare(`
        SELECT word, phonetic, definition, translation, pos, collins, oxford, tags, bnc, frq, exchange
        FROM entries WHERE word = ? COLLATE NOCASE LIMIT 1
      `),
      normalized: this.database.prepare(`
        SELECT word, phonetic, definition, translation, pos, collins, oxford, tags, bnc, frq, exchange
        FROM entries WHERE search_key = ?
        ORDER BY CASE WHEN word = ? COLLATE NOCASE THEN 0 ELSE 1 END, length(word), frq = 0, frq
        LIMIT 1
      `),
      prefix: this.database.prepare(`
        SELECT word, phonetic, substr(translation, 1, 180) AS translation
        FROM entries WHERE search_key >= ? AND search_key < ?
        ORDER BY CASE WHEN search_key = ? THEN 0 ELSE 1 END, length(word), frq = 0, frq, word COLLATE NOCASE
        LIMIT 18
      `),
      chinese: this.database.prepare(`
        SELECT word, phonetic, substr(translation, 1, 180) AS translation
        FROM entries WHERE translation LIKE ? ESCAPE '\\'
        ORDER BY frq = 0, frq, length(word)
        LIMIT 18
      `),
      metadata: this.database.prepare('SELECT key, value FROM metadata'),
    };
  }

  info() {
    this.open();
    const metadata = Object.fromEntries(this.statements.metadata.all().map((row) => [row.key, row.value]));
    return {
      entryCount: Number(metadata.entry_count || 0),
      source: metadata.source || 'skywind3000/ECDICT',
      sourceCommit: metadata.source_commit || '',
      license: metadata.license || 'MIT',
    };
  }

  lookup(rawQuery) {
    this.open();
    const query = String(rawQuery || '').trim().slice(0, 80);
    if (!query) return { query: '', exact: null, suggestions: [] };
    const key = normalizeSearchKey(query);
    let exact = this.statements.exact.get(query);
    if (!exact && key) exact = this.statements.normalized.get(key, query);

    let suggestions = [];
    if (key) {
      const upperBound = `${key}\uffff`;
      suggestions = this.statements.prefix.all(key, upperBound, key);
    } else if (/\p{Script=Han}/u.test(query) && query.length >= 1) {
      const escaped = query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
      suggestions = this.statements.chinese.all(`%${escaped}%`);
    }
    const seen = new Set();
    suggestions = suggestions.filter((item) => {
      const normalized = item.word.toLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
    return { query, exact: compactEntry(exact), suggestions };
  }

  close() {
    this.database?.close();
    this.database = null;
    this.statements = null;
  }
}

module.exports = { OfflineDictionary, normalizeSearchKey, parseExchange };

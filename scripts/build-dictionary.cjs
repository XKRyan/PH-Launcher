const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { parse } = require('csv-parse');

const projectRoot = path.join(__dirname, '..');
const defaultInput = path.join(projectRoot, '.cache', 'ECDICT-meta', 'ecdict.csv');
const inputPath = path.resolve(process.argv[2] || defaultInput);
const outputDirectory = path.join(projectRoot, 'assets', 'dictionary');
const outputPath = path.join(outputDirectory, 'ecdict.db');
const temporaryPath = path.join(outputDirectory, `ecdict-building-${process.pid}.db`);

function clean(value, limit) {
  return String(value || '').replaceAll('\0', '').trim().slice(0, limit);
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function searchKey(word) {
  return word.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

async function build() {
  if (!fs.existsSync(inputPath)) throw new Error(`ECDICT CSV not found: ${inputPath}`);
  fs.mkdirSync(outputDirectory, { recursive: true });
  if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);

  let sourceCommit = 'unknown';
  try {
    sourceCommit = execFileSync('git', ['-C', path.dirname(inputPath), 'rev-parse', 'HEAD'], {
      windowsHide: true,
      encoding: 'utf8',
    }).trim();
  } catch {}

  const database = new DatabaseSync(temporaryPath);
  database.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = MEMORY;
    PRAGMA page_size = 4096;
    CREATE TABLE entries (
      id INTEGER PRIMARY KEY,
      word TEXT NOT NULL,
      search_key TEXT NOT NULL,
      phonetic TEXT NOT NULL DEFAULT '',
      definition TEXT NOT NULL DEFAULT '',
      translation TEXT NOT NULL DEFAULT '',
      pos TEXT NOT NULL DEFAULT '',
      collins INTEGER NOT NULL DEFAULT 0,
      oxford INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '',
      bnc INTEGER NOT NULL DEFAULT 0,
      frq INTEGER NOT NULL DEFAULT 0,
      exchange TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
  `);
  const insert = database.prepare(`
    INSERT INTO entries
      (word, search_key, phonetic, definition, translation, pos, collins, oxford, tags, bnc, frq, exchange)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const parser = fs.createReadStream(inputPath).pipe(parse({
    bom: true,
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
  }));

  let inserted = 0;
  let skipped = 0;
  database.exec('BEGIN');
  for await (const row of parser) {
    const word = clean(row.word, 160);
    const translation = clean(row.translation, 5_000);
    const definition = clean(row.definition, 5_000);
    const key = searchKey(word);
    if (!word || !key || (!translation && !definition)) {
      skipped += 1;
      continue;
    }
    insert.run(
      word,
      key,
      clean(row.phonetic, 160),
      definition,
      translation,
      clean(row.pos, 240),
      numberOrZero(row.collins),
      numberOrZero(row.oxford),
      clean(row.tag, 360),
      numberOrZero(row.bnc),
      numberOrZero(row.frq),
      clean(row.exchange, 1_200),
    );
    inserted += 1;
    if (inserted % 50_000 === 0) {
      database.exec('COMMIT; BEGIN');
      console.log(`Imported ${inserted.toLocaleString('en-US')} entries`);
    }
  }
  database.exec('COMMIT');
  database.exec(`
    CREATE INDEX idx_entries_word ON entries(word COLLATE NOCASE);
    CREATE INDEX idx_entries_search_key ON entries(search_key, word COLLATE NOCASE);
    CREATE INDEX idx_entries_frequency ON entries(frq, bnc);
  `);
  const metadata = database.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)');
  metadata.run('entry_count', String(inserted));
  metadata.run('skipped_count', String(skipped));
  metadata.run('source', 'skywind3000/ECDICT');
  metadata.run('source_commit', sourceCommit);
  metadata.run('license', 'MIT');
  metadata.run('built_at', new Date().toISOString());
  database.exec('ANALYZE; VACUUM;');
  database.close();

  fs.copyFileSync(temporaryPath, outputPath);
  fs.unlinkSync(temporaryPath);
  console.log(`Dictionary ready: ${outputPath}`);
  console.log(`Entries: ${inserted.toLocaleString('en-US')}; skipped: ${skipped.toLocaleString('en-US')}`);
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

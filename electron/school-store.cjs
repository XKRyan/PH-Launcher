// Encrypted on-disk persistence for school snapshots (EduPage weeks and
// ManageBac courses/tasks). The launcher used to keep this in memory only, so
// every launch re-downloaded everything and pages showed spinners. Storing it
// lets the splash paint real data and refresh in the background.
const fs = require('node:fs');
const path = require('node:path');

const PREFIX = 'PHL-SCHOOL-1:';
const MAX_BYTES = 24 * 1024 * 1024;
const MAX_ENTRIES = 8;

class SchoolStore {
  constructor({ filePath, safeStorage, fileSystem = fs } = {}) {
    this.filePath = filePath;
    this.safeStorage = safeStorage;
    this.fs = fileSystem;
    this.error = '';
    this.lastSavedAt = 0;
  }

  _encrypt(text) {
    if (this.safeStorage && this.safeStorage.isEncryptionAvailable()) {
      return PREFIX + 'enc:' + this.safeStorage.encryptString(text).toString('base64');
    }
    return PREFIX + 'plain:' + Buffer.from(text, 'utf8').toString('base64');
  }

  _decrypt(raw) {
    if (raw.startsWith(PREFIX + 'enc:')) {
      if (!this.safeStorage || !this.safeStorage.isEncryptionAvailable()) throw new Error('encryption unavailable');
      return this.safeStorage.decryptString(Buffer.from(raw.slice((PREFIX + 'enc:').length), 'base64'));
    }
    if (raw.startsWith(PREFIX + 'plain:')) return Buffer.from(raw.slice((PREFIX + 'plain:').length), 'base64').toString('utf8');
    throw new Error('unrecognized school cache');
  }

  load() {
    this.error = '';
    try {
      if (!this.fs.existsSync(this.filePath)) return null;
      const raw = this.fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(this._decrypt(raw));
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) throw new Error('bad shape');
      const entries = parsed.entries
        .filter((entry) => entry && typeof entry.key === 'string' && entry.data && typeof entry.data === 'object')
        .slice(0, MAX_ENTRIES)
        .map((entry) => ({ key: entry.key, at: Number(entry.at) || 0, data: entry.data }));
      if (!entries.length) return null;
      return { entries, week: typeof parsed.week === 'string' ? parsed.week : '' };
    } catch (error) {
      // A cache that cannot be read is never fatal: the next sync rewrites it.
      this.error = String(error?.message || error).slice(0, 120);
      return null;
    }
  }

  save(payload) {
    if (!payload || !Array.isArray(payload.entries) || !payload.entries.length) return false;
    try {
      const text = JSON.stringify({ version: 1, savedAt: Date.now(), entries: payload.entries.slice(0, MAX_ENTRIES), week: payload.week || '' });
      if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) return false;
      const directory = path.dirname(this.filePath);
      this.fs.mkdirSync(directory, { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      this.fs.writeFileSync(temporary, this._encrypt(text), { encoding: 'utf8', mode: 0o600 });
      try { this.fs.renameSync(temporary, this.filePath); }
      catch { this.fs.writeFileSync(this.filePath, this._encrypt(text), { encoding: 'utf8', mode: 0o600 }); try { this.fs.unlinkSync(temporary); } catch {} }
      this.lastSavedAt = Date.now();
      this.error = '';
      return true;
    } catch (error) {
      this.error = String(error?.message || error).slice(0, 120);
      return false;
    }
  }
}

module.exports = { SchoolStore, SCHOOL_STORE_PREFIX: PREFIX, SCHOOL_STORE_MAX_BYTES: MAX_BYTES };

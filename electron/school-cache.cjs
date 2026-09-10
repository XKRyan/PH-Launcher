// PH Launcher school snapshots. No credentials or cookies are stored here.
// In-memory, bounded, account-sensitive stale-while-revalidate cache.
const { SchoolDataError } = require('./school-data.cjs');
const { SchoolAuthError } = require('./school-auth.cjs');
const TTL = { edupage: 120000, managebac: 180000 };
const RECOVERABLE = new Set(['NETWORK_ERROR', 'TIMEOUT', 'PAGE_CHANGED', 'PAGE_TOO_LARGE']);
const dateValid = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;

class SchoolCache {
  constructor({ now = () => Date.now(), onChange = null } = {}) {
    this.now = now;
    this.onChange = typeof onChange === 'function' ? onChange : null;
    this.current = { edupage: null, managebac: null };
    this.epoch = { edupage: 0, managebac: 0 };
    this.status = { edupage: { state: 'idle' }, managebac: { state: 'idle' } };
    this.entries = new Map();
    this.pending = new Map();
    this.week = '';
  }
  _changed() {
    if (!this.onChange) return;
    try { this.onChange(this.exportForStorage()); } catch { /* persistence must never break sync */ }
  }
  // Restore snapshots written by a previous launch so the UI has data before
  // any network request. Everything is marked stale so a refresh still runs.
  hydrate(persisted) {
    if (!persisted || !Array.isArray(persisted.entries)) return 0;
    let restored = 0;
    for (const entry of persisted.entries) {
      if (!entry || typeof entry.key !== 'string' || !entry.data) continue;
      if (!entry.key.startsWith('edupage:') && !entry.key.startsWith('managebac:')) continue;
      if (this.entries.has(entry.key)) continue;
      this.entries.set(entry.key, { at: Number(entry.at) || 0, data: entry.data });
      restored += 1;
      const source = entry.key.startsWith('edupage:') ? 'edupage' : 'managebac';
      this.status[source] = { state: 'stale', updatedAt: entry.data.fetchedAt || '' };
    }
    const week = persisted.week || [...this.entries.keys()].filter((key) => key.startsWith('edupage:')).sort().at(-1)?.slice('edupage:'.length) || '';
    if (week) {
      this.week = week;
      this.current.edupage = this.entries.get(`edupage:${week}`)?.data || null;
    }
    if (this.entries.has('managebac:')) this.current.managebac = this.entries.get('managebac:').data;
    return restored;
  }
  exportForStorage() {
    return { week: this.week, entries: [...this.entries.entries()].map(([key, entry]) => ({ key, at: entry.at, data: entry.data })) };
  }
  key(source, week) {
    if (!Object.hasOwn(TTL, source)) throw new SchoolDataError('INVALID_SOURCE', '未知学校数据源');
    if (source === 'edupage' && !dateValid(week)) throw new SchoolDataError('INVALID_DATE', '请选择正确的课表日期');
    return `${source}:${source === 'edupage' ? week : ''}`;
  }
  selectWeek(week) {
    const key = this.key('edupage', week);
    this.week = week;
    this.current.edupage = this.entries.get(key)?.data || null;
  }
  snapshot(options = {}) {
    if (options?.weekStart) this.selectWeek(options.weekStart);
    return { ...this.current, status: structuredClone(this.status), epochs: { ...this.epoch } };
  }
  invalidate(source) {
    for (const site of source && Object.hasOwn(TTL, source) ? [source] : Object.keys(TTL)) {
      this.epoch[site] += 1;
      this.current[site] = null;
      this.status[site] = { state: 'idle' };
      for (const key of this.entries.keys()) if (key.startsWith(`${site}:`)) this.entries.delete(key);
      // Old promises cannot write after their epoch has been revoked.
      for (const key of this.pending.keys()) if (key.startsWith(`${site}:`)) this.pending.delete(key);
    }
  }
  async sync(source, { weekStart, force = true } = {}, operation) {
    const key = this.key(source, weekStart);
    if (source === 'edupage') this.selectWeek(weekStart);
    const cached = this.entries.get(key);
    if (!force && cached && this.now() - cached.at < TTL[source]) return cached.data;
    if (this.pending.has(key)) return this.pending.get(key);
    const epoch = this.epoch[source];
    this.status[source] = { state: 'syncing', updatedAt: cached?.data.fetchedAt || '' };
    const pending = Promise.resolve().then(operation).then((data) => {
      if (this.epoch[source] !== epoch) throw new SchoolDataError('ACCOUNT_CHANGED', '登录状态已改变，请重新同步');
      if (source === 'edupage') {
        const other = [...this.entries.values()].find((entry) => entry.data.source === source);
        if (other && other.data.accountKey !== data.accountKey) {
          // A newly verified identity may replace the old one, never combine it.
          this.invalidate(source);
        }
      }
      this.entries.delete(key);
      this.entries.set(key, { at: this.now(), data });
      while (this.entries.size > 9) this.entries.delete(this.entries.keys().next().value);
      if (source !== 'edupage' || this.week === weekStart) this.current[source] = data;
      this.status[source] = { state: 'ready', updatedAt: data.fetchedAt, error: '' };
      this._changed();
      return data;
    }).catch((error) => {
      if (this.epoch[source] !== epoch) throw error;
      if (!RECOVERABLE.has(error.code)) this.invalidate(source);
      this.status[source] = { state: this.current[source] ? 'stale' : 'error', updatedAt: this.current[source]?.fetchedAt || '', error: error instanceof SchoolDataError || error instanceof SchoolAuthError ? error.message : '同步没有完成，请重新登录后重试' };
      throw error;
    }).finally(() => { if (this.pending.get(key) === pending) this.pending.delete(key); });
    this.pending.set(key, pending);
    return pending;
  }
}
module.exports = { SchoolCache, TTL };

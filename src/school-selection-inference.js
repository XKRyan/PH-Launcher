(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.schoolSelectionInference = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  'use strict';

  function subjectKey(value) {
    return String(value || '').normalize('NFKC').toLocaleLowerCase()
      .replace(/\b(?:hl|sl)\s*\d*/g, ' ')
      .replace(/\b(?:ib|dp|higher|standard|level|class|course)\b/g, ' ')
      .replace(/[0-9]+/g, ' ').replace(/[^a-z\u4e00-\u9fff]+/g, ' ').trim().replace(/\s+/g, ' ');
  }

  function inferTeachingGroups({ options = [], enrolledCourses = [], authoritativeKeys = [], authoritativeSource = '' } = {}) {
    const safeOptions = Array.isArray(options) ? options.filter((item) => item && typeof item.key === 'string' && item.key) : [];
    const keys = new Map();
    for (const option of safeOptions) {
      if (!keys.has(option.key)) keys.set(option.key, []);
      keys.get(option.key).push(option);
    }
    if (authoritativeSource === 'verified-personal-id' && Array.isArray(authoritativeKeys) && authoritativeKeys.length) {
      const unique = [...new Set(authoritativeKeys)];
      const unresolved = unique.filter((key) => keys.get(key)?.length !== 1);
      return unresolved.length
        ? { status: 'ambiguous', keys: [], ambiguous: unresolved, unmatched: [] }
        : { status: 'automatic', keys: unique, ambiguous: [], unmatched: [] };
    }
    const bySubject = new Map();
    for (const option of safeOptions) {
      const key = subjectKey(option.course || String(option.label || '').split(' · ')[0]);
      if (!key) continue;
      if (!bySubject.has(key)) bySubject.set(key, []);
      bySubject.get(key).push(option.key);
    }
    const suggested = []; const ambiguous = []; const unmatched = [];
    const courses = [...new Set((Array.isArray(enrolledCourses) ? enrolledCourses : []).map((item) => subjectKey(item?.name || item)).filter(Boolean))];
    for (const course of courses) {
      const matches = [...new Set(bySubject.get(course) || [])];
      if (matches.length === 1) suggested.push(matches[0]);
      else if (matches.length > 1) ambiguous.push(course);
      else unmatched.push(course);
    }
    return { status: suggested.length ? 'suggestion' : ambiguous.length ? 'ambiguous' : 'none', keys: [...new Set(suggested)], ambiguous, unmatched };
  }

  return Object.freeze({ inferTeachingGroups, subjectKey });
});

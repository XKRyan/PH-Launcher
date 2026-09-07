(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.schoolSelectionInference = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  'use strict';

  function subjectKey(value) {
    return String(value || '').slice(0, 240).normalize('NFKC').toLowerCase()
      .replace(/\banalysis\s+(?:and|&)\s+approaches\b/g, 'aa')
      .replace(/\bapplications\s+(?:and|&)\s+interpretation\b/g, 'ai')
      .replace(/\bmaths?\b/g, 'mathematics')
      .replace(/&/g, ' and ')
      .replace(/\b(?:hl|sl)\s*\d*/g, ' ')
      .replace(/\b(?:ib|dp|higher|standard|level|class|course)\b/g, ' ')
      .replace(/[0-9]+/g, ' ').replace(/[^a-z\u4e00-\u9fff]+/g, ' ').trim().replace(/\s+/g, ' ');
  }

  function levels(value) {
    const name = String(value || '').normalize('NFKC').toLowerCase();
    const result = new Set([...name.matchAll(/\b(hl|sl)(?=\b|\d)/g)].map(match => match[1]));
    if (/\bhigher\s+level\b/.test(name)) result.add('hl');
    if (/\bstandard\s+level\b/.test(name)) result.add('sl');
    return result;
  }
  function teachers(value) {
    const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[、;/]/) : [];
    return list.slice(0, 8).filter(item => typeof item === 'string').map(item => item.normalize('NFKC').toLowerCase().replace(/[.,]/g, ' ').trim().split(/\s+/).sort().join(' ')).filter(Boolean);
  }
  function compatible(course, option) {
    const sourceLevels = levels(course.name); const targetLevels = levels(option.course);
    if (sourceLevels.size && targetLevels.size && ![...sourceLevels].some(level => targetLevels.has(level))) return false;
    // Explicit group numbers are meaningful; never collapse (G3) into (G4).
    const sourceGroup = String(course.name || '').match(/\(\s*(g\d+)\s*\)/i)?.[1]?.toLowerCase();
    const targetGroup = String(option.course || '').match(/\(\s*(g\d+)\s*\)/i)?.[1]?.toLowerCase();
    if (sourceGroup && targetGroup && sourceGroup !== targetGroup) return false;
    const sourceTeachers = teachers(course.teachers || course.teacher);
    const targetTeachers = teachers(option.teachers || option.teacher);
    return !sourceTeachers.length || !targetTeachers.length || sourceTeachers.some(teacher => targetTeachers.includes(teacher));
  }

  function inferTeachingGroups({ options = [], enrolledCourses = [], authoritativeKeys = [], authoritativeSource = '' } = {}) {
    const safeOptions = Array.isArray(options) ? options.slice(0, 2000).filter((item) => item && typeof item.key === 'string' && item.key) : [];
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
      bySubject.get(key).push(option);
    }
    const suggested = []; const ambiguous = []; const unmatched = [];
    const courses = (Array.isArray(enrolledCourses) ? enrolledCourses : []).slice(0, 300).map(item => typeof item === 'string' ? { name: item } : item).filter(item => item && typeof item.name === 'string');
    for (const record of courses) {
      const course = subjectKey(record.name); if (!course) continue;
      const candidates = (bySubject.get(course) || []).filter(option => compatible(record, option));
      const matches = [...new Set(candidates.map(option => option.key))];
      if (matches.some(key => keys.get(key)?.length !== 1)) { ambiguous.push(course); continue; }
      if (matches.length === 1) suggested.push(matches[0]);
      else if (matches.length > 1) ambiguous.push(course);
      else unmatched.push(course);
    }
    return { status: suggested.length ? 'suggestion' : ambiguous.length ? 'ambiguous' : 'none', keys: [...new Set(suggested)], ambiguous: [...new Set(ambiguous)], unmatched: [...new Set(unmatched)] };
  }

  return Object.freeze({ inferTeachingGroups, subjectKey });
});

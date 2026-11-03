(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.schoolTasks = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  function submitted(task) {
    const status = String(task?.status || '').trim().toLowerCase();
    if (/\b(?:not(?:\s+\w+){0,2}\s+(?:submitted|completed|complete|done)|unsubmitted|incomplete|missing|resubmit|resubmission)\b|未提交|未完成|未交|待提交|待完成|重新提交|尚未/.test(status)) return false;
    if (/\bsubmitted\b|已提交|已交/.test(status)) return true;
    if (/\b(?:not(?:\s+\w+){0,2}\s+(?:graded|assessed)|pending|overdue|awaiting|ungraded|unassessed)\b|未批|待批/.test(status)) return false;
    return /\b(?:completed|complete|done|graded|assessed)\b|已完成|已批/.test(status);
  }
  function dueTime(task) {
    // Only normalized dates with an explicit timezone are eligible for alerts.
    const value = String(task?.dueAt || '');
    return /T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? Date.parse(value) : NaN;
  }
  function status(task, now = Date.now()) {
    return submitted(task) ? 'completed' : task.pastDue || dueTime(task) < now ? 'overdue' : 'pending';
  }
  function summary(tasks, now = Date.now()) {
    const result = { pending: 0, soon: 0, overdue: 0, completed: 0 };
    for (const task of tasks || []) {
      if (submitted(task)) { result.completed++; continue; }
      result.pending++;
      if (status(task, now) === 'overdue') result.overdue++;
      else if (dueTime(task) - now <= 86400000) result.soon++;
    }
    return result;
  }
  return { submitted, dueTime, status, summary };
});

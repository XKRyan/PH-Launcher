'use strict';
const { createHash } = require('node:crypto');
const { active, dueTime } = require('../src/school-tasks.js');
const MINUTE = 60000;
const OPTIONS = [60, 180, 1440, 2880];
const key = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
function preferences(input = {}) {
  return {
    newTasks: input.newTasks !== false,
    deadlines: input.deadlines !== false,
    minutes: Array.isArray(input.minutes) ? [...new Set(input.minutes.filter(n => OPTIONS.includes(n)))].sort((a, b) => a - b) : [60, 1440],
  };
}
// Pure transition: persist the returned state before displaying grouped alerts.
// Entries contain hashed task ids, timestamps and delivery stages, never credentials.
function evaluate({ state, snapshot, accountKey, settings, hiddenTasks = [], now = Date.now() }) {
  if (!snapshot || !accountKey || snapshot.accountKey !== accountKey || !Array.isArray(snapshot.tasks)) return { state, alerts: [], changed: false };
  const prefs = preferences(settings);
  const previous = state?.accountKey === accountKey ? state : null;
  const next = { version: 1, accountKey, courses: [...(previous?.courses || [])], entries: { ...(previous?.entries || {}) }, inbox: { ...(previous?.inbox || {}) } };
  const initialized = new Set(next.courses);
  const hidden = new Set(hiddenTasks);
  const alerts = [];
  // A partial course read must not turn a later first successful read into a flood.
  const successful = snapshot.taskSyncedCourses || (snapshot.warnings?.length ? [] : (snapshot.courses || []).map(c => String(c.id)));
  const fresh = Number.isFinite(Date.parse(snapshot.fetchedAt)) && now - Date.parse(snapshot.fetchedAt) <= 30 * MINUTE;
  for (const task of snapshot.tasks.slice(0, 2000)) {
    if (!task?.id || !task.courseId) continue;
    const id = key(String(task.id));
    if (task.stale) { delete next.inbox[id]; continue; }
    const old = next.entries[id];
    const due = dueTime(task);
    const deadline = Number.isFinite(due) ? due : null;
    const entry = { seen: now, deadline, stages: old?.deadline === deadline ? [...(old.stages || [])] : [] };
    // Retain first-seen ids across temporarily missing/partial lists and restarts.
    const isNew = !old && initialized.has(String(task.courseId));
    const eligible = active(task, now) && !hidden.has(task.id);
    let type = '';
    if (fresh && eligible && isNew && prefs.newTasks && (deadline === null || due > now)) type = 'new';
    if (fresh && eligible && prefs.deadlines && due > now) {
      const stages = prefs.minutes.filter(minutes => due - now <= minutes * MINUTE);
      // If the app was asleep, deliver only the closest stage, not all missed ones.
      const closest = stages[0];
      if (closest !== undefined && !entry.stages.includes(closest)) type = type ? 'new-due' : 'due';
      if (type) entry.stages = [...new Set([...entry.stages, ...stages])];
    }
    if (!eligible || (old && old.deadline !== deadline) || (!prefs.newTasks && !prefs.deadlines)) delete next.inbox[id];
    if (type) next.inbox[id] = type;
    if (type) alerts.push({ type, taskId: String(task.id), courseId: String(task.courseId), title: String(task.title || 'ManageBac'), course: String(task.course || ''), dueAt: task.dueAt || '', dueText: task.dueText || '', kind: task.kind });
    // Avoid rewriting storage every timer tick for unchanged data.
    if (old && old.deadline === entry.deadline && JSON.stringify(old.stages) === JSON.stringify(entry.stages)) entry.seen = old.seen;
    next.entries[id] = entry;
  }
  const present = new Set(snapshot.tasks.filter(t => t?.id).map(t => key(String(t.id))));
  for (const id of Object.keys(next.inbox)) if (!present.has(id)) delete next.inbox[id];
  next.courses = [...new Set([...next.courses, ...successful.map(String)])].slice(-300);
  const entries = Object.entries(next.entries).sort((a, b) => b[1].seen - a[1].seen);
  next.entries = Object.fromEntries(entries.slice(0, 10000));
  return { state: next, alerts, changed: JSON.stringify(previous) !== JSON.stringify(next) };
}
function pendingAlerts(state, snapshot, now = Date.now()) {
  if (!state || state.accountKey !== snapshot?.accountKey) return [];
  const unique = new Map();
  for (const task of snapshot.tasks || []) {
    const type = state.inbox?.[key(String(task.id))];
    if (type && !task.stale && active(task, now)) unique.set(String(task.id), { ...task, type });
  }
  return [...unique.values()];
}
module.exports = { evaluate, pendingAlerts, preferences, TASK_REMINDER_OPTIONS: OPTIONS };

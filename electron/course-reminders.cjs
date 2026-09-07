'use strict';
const { createHash } = require('node:crypto');
const OPTIONS = [0, 5, 10, 15, 30, 60];
const dateKey = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const validTime = value => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value || '');
const identity = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);

function courseReminders({ schedule = [], preferences = {}, schoolWeeks = [], defaultMinutes = 10, now = new Date() } = {}) {
  const output = new Map();
  const configured = Object.hasOwn(preferences, 'courseReminderMinutes');
  function add(lesson, date, minutes, school = false) {
    if (!validTime(lesson.start) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(minutes) || minutes < 0 || minutes > 120) return;
    const start = new Date(`${date}T${lesson.start}:00${school ? '+08:00' : ''}`);
    if (!Number.isFinite(start.getTime())) return;
    const id = `course:${identity([school ? preferences.accountKey : 'manual', lesson.id, date, lesson.start, minutes])}`;
    output.set(id, { id, dueAt: start.getTime() - minutes * 60_000,
      title: minutes === 0 ? '上课时间到了' : `${minutes} 分钟后上课`,
      body: `${String(lesson.course || '课程').slice(0,160)}\n${date} ${lesson.start}${lesson.room ? ` · ${String(lesson.room).slice(0,80)}` : ''}${lesson.teacher ? `\n${String(lesson.teacher).slice(0,120)}` : ''}` });
  }
  for (const lesson of schedule.slice(0, 500)) {
    if (!lesson.enabled || lesson.cancelled || !validTime(lesson.start)) continue;
    if (lesson.source === 'edupage-dated' && lesson.schoolAccount && lesson.schoolAccount !== preferences.accountKey) continue;
    // Once the new school-specific preference is chosen it owns imported
    // EduPage reminders too, so turning it off cannot leave duplicate alerts.
    if (configured && lesson.source === 'edupage-dated') continue;
    const minutes = Number(lesson.remindMinutes ?? defaultMinutes);
    if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 120) continue; // old manual 0 means disabled
    if (lesson.date) { add(lesson, lesson.date, minutes); continue; }
    for (let offset = 0; offset < 8; offset++) {
      const date = new Date(now); date.setDate(date.getDate() + offset);
      if (date.getDay() === Number(lesson.dayOfWeek)) add(lesson, dateKey(date), minutes);
    }
  }
  const minutes = preferences.courseReminderMinutes;
  if (configured && minutes !== null && OPTIONS.includes(minutes) && preferences.accountKey && preferences.groups?.length) {
    const groups = new Set(preferences.groups);
    for (const week of schoolWeeks) {
      if (week?.source !== 'edupage' || week.accountKey !== preferences.accountKey) continue;
      for (const lesson of (week.lessons || []).slice(0,1000)) {
        if (!lesson.cancelled && groups.has(lesson.groupKey)) add(lesson, lesson.date, minutes, true);
      }
    }
  }
  return [...output.values()].slice(0, 900);
}
module.exports = { courseReminders, COURSE_REMINDER_OPTIONS: OPTIONS };

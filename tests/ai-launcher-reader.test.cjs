'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AI_LAUNCHER_READ_TOOLS, createAiLauncherReader, MAX_OUTPUT } = require('../electron/ai-launcher-reader.cjs');

function fixture() {
  return {
    notes: Array.from({ length: 25 }, (_, index) => ({ id: `note-${index}`, title: `Note ${index}`, subject: 'History', body: `Full local note ${index} `.repeat(300), updatedAt: '2026-09-06T00:00:00Z' })),
    tasks: [{ id: 'task-1', title: 'Essay', subject: 'English', dueAt: '2026-09-08T10:00:00Z', notes: 'Draft first section', done: false }],
    schedule: [{ course: 'Math', dayOfWeek: 1, start: '08:00', end: '08:45', room: 'A101' }],
    calendarEvents: [{ id: 'event-1', title: 'Club', date: '2026-09-07', start: '09:00', end: '10:00', color: '#4488cc', notes: 'Bring materials' }],
    focusSessions: [{ id: 'focus-1', startedAt: '2026-09-06T08:00:00Z', endedAt: '2026-09-06T08:25:00Z', minutes: 25, goal: 'Read' }],
    ib: { milestones: [{ id: 'ib-1', title: 'EE outline', subject: 'History', dueAt: '2026-09-10T00:00:00Z', notes: 'Choose sources' }], gradeComponents: [{ id: 'grade-1', name: 'IA', weight: 0.2, score: 6 }] },
    vocabulary: { cards: [{ id: 'card-1', word: 'evidence', meaning: '证据', context: 'The evidence is clear.', ownExample: 'I need evidence.', subject: '阅读', source: 'ECDICT', schedule: { due: '2026-09-07T00:00:00Z', reps: 2, lapses: 0 } }], readings: [{ id: 'read-1', title: 'Article', body: 'A local reading text. '.repeat(900), wordCount: 3600, readCount: 1 }] },
    settings: { apiKey: 'must-not-leak', ai: { apiKey: 'must-not-leak', localEndpoint: 'http://secret' }, appearance: { preset: 'midnight', primary: '#123456', paper: '#ffffff', fontSize: 16 }, shortcuts: { focus: 'Ctrl+P', timer: { label: 'Timer', accelerator: 'Ctrl+T', enabled: true } }, customSites: [{ id: 'site-1', name: 'Study site', url: 'https://example.test/path?token=hidden' }] },
  };
}
function schoolFixture() {
  return {
    managebac: { fetchedAt: '2026-09-06T00:00:00Z', courses: [{ id: '11', name: 'Biology', grade: '6' }], tasks: [{ id: 'managebac:11:22', courseId: '11', course: 'Biology', title: 'Lab', dueAt: '2026-09-08T00:00:00Z' }], warnings: [] },
    edupage: { accountKey: 'private-account-key', fetchedAt: '2026-09-06T00:00:00Z', weekStart: '2026-09-07', className: 'Class A', lessons: [{ id: 'lesson-1', course: 'Physics', teacher: 'Ms. Lin', date: '2026-09-07', start: '08:00', end: '08:45', room: 'R1', groupKey: 'group-me' }, { id: 'lesson-2', course: 'Art', date: '2026-09-07', start: '09:00', end: '09:45', room: 'R2', groupKey: 'group-other' }], options: [] },
    preferences: { accountKey: 'private-account-key', groups: ['group-me'] },
  };
}

test('declares a small, read-only launcher tool surface', () => {
  assert.deepEqual(AI_LAUNCHER_READ_TOOLS.map((tool) => tool.function.name), ['read_launcher_data', 'read_school_cache', 'read_school_detail']);
  assert.ok(AI_LAUNCHER_READ_TOOLS.every((tool) => tool.function.parameters.additionalProperties === false));
});

test('projects actual local fields, bytesafe body chunks, and never exposes secrets', async () => {
  let revision = 1; let allowed = 0;
  const data = fixture(); data.notes[0].body = `${data.notes[0].body}${'续写内容 '.repeat(2_000)}`;
  const reader = createAiLauncherReader({ getData: () => data, getSchoolSnapshot: schoolFixture, readSchoolDetail: async () => ({}), getRevision: () => revision, assertAllowed: () => { allowed += 1; } });
  const notes = await reader.execute('read_launcher_data', { domain: 'notes', limit: 99 });
  assert.equal(notes.items.length, 20); assert.equal(notes.nextCursor, 20); assert.ok(notes.items.every((note) => note.body.length <= 1500));
  const detail = await reader.execute('read_launcher_data', { domain: 'notes', id: 'note-0' });
  assert.ok(detail.note.body.text.length > 700);
  assert.equal(detail.note.body.offset, 0);
  assert.ok(detail.note.body.nextOffset > 0);
  const continuation = await reader.execute('read_launcher_data', { domain: 'notes', id: 'note-0', offset: detail.note.body.nextOffset });
  assert.equal(continuation.note.body.offset, detail.note.body.nextOffset);
  assert.ok(continuation.note.body.text.length > 0);
  const calendar = await reader.execute('read_launcher_data', { domain: 'calendar', id: 'event-1' });
  assert.equal(calendar.event.date, '2026-09-07'); assert.equal(calendar.event.start, '09:00');
  const appearance = await reader.execute('read_launcher_data', { domain: 'appearance' });
  assert.equal(appearance.appearance.preset, 'midnight');
  assert.equal(appearance.shortcuts[0].accelerator, 'Ctrl+P');
  assert.equal(appearance.customSites[0].url, 'https://example.test/path');
  assert.doesNotMatch(JSON.stringify({ notes, detail, appearance }), /must-not-leak|secret|token=hidden/);
  assert.ok(allowed >= 10);
});

test('reads only current cached school data and validates ids before injected details', async () => {
  const calls = [];
  const reader = createAiLauncherReader({ getData: fixture, getSchoolSnapshot: schoolFixture, getRevision: () => 1, assertAllowed: () => {}, readSchoolDetail: async (request) => {
    calls.push(request);
    if (request.kind === 'discussions') return { discussions: [{ id: '33', title: 'Question', preview: 'Please help' }] };
    if (request.kind === 'discussion') return { discussionId: '33', title: 'Question', main: { author: 'Teacher', body: 'Read chapter' }, comments: [] };
    if (request.kind === 'course') return { id: '11', name: 'Biology', units: 'Unit 1', tasks: Array.from({ length: 23 }, (_, index) => ({ id: String(index), title: `Task ${index}` })), files: [], events: [] };
    return {};
  } });
  const personal = await reader.execute('read_school_cache', { source: 'edupage', section: 'timetable' });
  assert.equal(personal.items.length, 1); assert.equal(personal.items[0].course, 'Physics');
  assert.equal(personal.items[0].id, 'lesson-1'); assert.equal(personal.items[0].teacher, 'Ms. Lin');
  assert.doesNotMatch(JSON.stringify(personal), /private-account-key/);
  await assert.rejects(reader.execute('read_school_detail', { kind: 'course', courseId: '999' }), /当前账号已同步/);
  await assert.rejects(reader.execute('read_school_detail', { kind: 'discussion', courseId: '11', discussionId: '33' }), /讨论 id 必须先/);
  await reader.execute('read_school_detail', { kind: 'discussions', courseId: '11' });
  const discussion = await reader.execute('read_school_detail', { kind: 'discussion', courseId: '11', discussionId: '33' });
  assert.equal(discussion.discussion.main.body, 'Read chapter');
  const course = await reader.execute('read_school_detail', { kind: 'course', courseId: '11' });
  assert.equal(course.fetchedAt, '2026-09-06T00:00:00Z');
  assert.equal(course.course.tasks.length, 8); assert.equal(course.course.tasksTotal, 23); assert.equal(course.course.truncated, true);
  assert.deepEqual(calls.map((item) => item.kind), ['discussions', 'discussion', 'course']);
});

test('checks authorization and revision before and after each read', async () => {
  let revision = 1;
  const reader = createAiLauncherReader({ getData: fixture, getSchoolSnapshot: schoolFixture, assertAllowed: () => {}, getRevision: () => revision, readSchoolDetail: async () => { revision += 1; return { id: '11', name: 'Biology', units: '', tasks: [], files: [], events: [] }; } });
  await assert.rejects(reader.execute('read_school_detail', { kind: 'course', courseId: '11' }), /资料或账号已变更/);
  const reader2 = createAiLauncherReader({ getData: fixture, getSchoolSnapshot: () => ({ managebac: null }), assertAllowed: () => {}, getRevision: () => 1, readSchoolDetail: async () => ({}) });
  const unavailable = await reader2.execute('read_school_cache', { source: 'managebac', section: 'overview' });
  assert.equal(unavailable.available, false);
  assert.ok(Buffer.byteLength(JSON.stringify(unavailable)) <= MAX_OUTPUT);
});

test('never splits UTF-8 or replaces a long result with a preview', async () => {
  const data = fixture();
  data.notes[0].body = '词'.repeat(30_000);
  const reader = createAiLauncherReader({ getData: () => data, getSchoolSnapshot: schoolFixture, assertAllowed: () => {}, getRevision: () => 1, readSchoolDetail: async () => ({}) });
  const first = await reader.execute('read_launcher_data', { domain: 'notes', id: 'note-0' });
  assert.ok(Buffer.byteLength(JSON.stringify(first), 'utf8') <= MAX_OUTPUT);
  assert.equal(first.preview, undefined);
  assert.equal(first.note.body.text, '词'.repeat(Buffer.byteLength(first.note.body.text, 'utf8') / Buffer.byteLength('词', 'utf8')));
  const second = await reader.execute('read_launcher_data', { domain: 'notes', id: 'note-0', offset: first.note.body.nextOffset });
  assert.equal(second.note.body.offset, first.note.body.nextOffset);
});

test('keeps an oversized school detail structured and bounded', async () => {
  const reader = createAiLauncherReader({ getData: fixture, getSchoolSnapshot: schoolFixture, assertAllowed: () => {}, getRevision: () => 1, readSchoolDetail: async () => ({
    id: '11', name: '生物', units: '词'.repeat(10_000),
    tasks: Array.from({ length: 30 }, (_, index) => ({ id: String(index), title: '作业'.repeat(300), dueText: '下周'.repeat(100) })),
    files: Array.from({ length: 20 }, () => ({ name: '资料'.repeat(200), url: 'https://shph.managebac.cn/file?token=hidden' })),
    events: Array.from({ length: 20 }, (_, index) => ({ id: String(index), title: '活动'.repeat(300) })), warnings: Array.from({ length: 20 }, () => '提示'.repeat(200)),
  }) });
  const result = await reader.execute('read_school_detail', { kind: 'course', courseId: '11' });
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_OUTPUT);
  assert.equal(result.preview, undefined); assert.equal(result.course.tasksTotal, 30); assert.equal(result.course.tasks.length, 8);
  assert.equal(result.course.files[0].url, 'https://shph.managebac.cn/file');
});

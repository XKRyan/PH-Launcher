const test = require('node:test');
const assert = require('node:assert/strict');
const { SchoolDataClient, parseTaskDetail, parseCourseFiles } = require('../electron/school-data.cjs');

// Synthetic fixtures only; never authenticate or submit to a school account.
const taskHtml = `<div class="core-task-show"><div class="fusion-card-item"><h4 class="title">Essay</h4><span class="badge-label">Pending</span><div class="fr-view"><p>Read the chapter.</p><p>Explain your answer.<br>Include evidence.</p></div></div><a href="/attachments/7/brief.pdf">brief.pdf</a><a href="/attachments/7/brief.pdf">brief.pdf</a><a href="/attachments/8/download?token=private-token">rubric.pdf</a><a href="https://evil.test/attachments/9/download">evil.pdf</a><div data-ec3-info='{"name":"worksheet.docx","download_url":"https://storage.test/file?secret=private-token"}'></div><form><textarea>private draft</textarea><input value="private-token"></form><script>throw Error('executed')</script></div>`;

test('task detail preserves instructions inside cards and paragraph boundaries', () => {
  const task = parseTaskDetail(taskHtml, '21', '31');
  assert.equal(task.title, 'Essay');
  assert.match(task.description, /Read the chapter\.\nExplain your answer\.\nInclude evidence\./);
  assert.doesNotMatch(task.description, /private draft|private-token|Pending/);
});

test('task attachments expose bounded authenticated links and original-page fallback without credentials', () => {
  const task = parseTaskDetail(taskHtml, '21', '31');
  assert.deepEqual(task.attachments, [
    { name: 'brief.pdf', url: 'https://shph.managebac.cn/attachments/7/brief.pdf' },
    { name: 'rubric.pdf', url: 'https://shph.managebac.cn/student/classes/21/core_tasks/31', originalPage: true },
    { name: 'worksheet.docx', url: 'https://shph.managebac.cn/student/classes/21/core_tasks/31', originalPage: true },
  ]);
  assert.doesNotMatch(JSON.stringify(task), /private-token|storage\.test/);
  const many = `<div class="core-task-show">${Array.from({ length: 40 }, (_, i) => `<a href="/attachments/${i}/download">file-${i}.pdf</a>`).join('')}</div>`;
  assert.equal(parseTaskDetail(many, '21', '31').attachments.length, 30);
});

test('task detail client supplies exact task context for attachment fallback', async () => {
  const client = new SchoolDataClient({ fetch: async () => new Response(taskHtml) });
  const task = await client.getTaskDetail('21', '31');
  assert.equal(task.attachments[1].url, task.url);
  assert.equal(task.taskId, '31');
});

test('course files open explicit supported attachments directly and keep signed URLs on the website', () => {
  const html = '<div class="row file"><a href="/attachments/7/download">lesson.pdf</a></div><div class="row file"><a href="/attachments/8/download?token=secret">exercise.pdf</a></div>';
  assert.deepEqual(parseCourseFiles(html, '21'), [
    { name: 'lesson.pdf', url: 'https://shph.managebac.cn/attachments/7/download' },
    { name: 'exercise.pdf', url: 'https://shph.managebac.cn/student/classes/21/files' },
  ]);
});

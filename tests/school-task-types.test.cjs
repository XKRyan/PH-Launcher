const test = require('node:test');
const assert = require('node:assert/strict');
const { SchoolDataClient, parseManageBacTasks, parseTaskDetail } = require('../electron/school-data.cjs');
const { status, active } = require('../src/school-tasks.js');
const { evaluate, pendingAlerts } = require('../electron/task-reminders.cjs');
const now = Date.parse('2026-11-03T02:00:00Z');

test('private task images follow the ManageBac China storage redirect', async () => {
  const original = 'https://shph.managebac.cn/privacy_attachments/example';
  const storage = 'https://managebac-cn-prod.s3.cn-north-1.amazonaws.com.cn/example?signature=fixture';
  const requests = [];
  const client = new SchoolDataClient({ fetch: async (site, url, options) => {
    requests.push([site, url, options.credentials, options.redirect]);
    return url === original
      ? new Response(null, { status: 302, headers: { location: storage } })
      : new Response(Buffer.from([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
  } });
  assert.equal(await client.getTaskImage(original), 'data:image/png;base64,iVBORw==');
  assert.deepEqual(requests, [
    ['managebac', original, 'include', 'manual'],
    ['managebac', storage, 'omit', 'manual'],
  ]);
});

test('private task images reject redirects before requesting an untrusted host', async () => {
  let requests = 0;
  const client = new SchoolDataClient({ fetch: async () => {
    requests++;
    return new Response(null, { status: 302, headers: { location: 'https://untrusted.example/image.png' } });
  } });
  await assert.rejects(client.getTaskImage('https://shph.managebac.cn/privacy_attachments/example'), /Unsupported school image address/);
  assert.equal(requests, 1);
});
const card = (id, category, required) => `<article data-task-type="${category}"${required === null ? '' : ` data-submission-required="${required}"`}><a href="/student/classes/21/core_tasks/${id}">Synthetic ${id}</a></article>`;
const events = [
  { id: 'calendar-31', title: 'Exam copy', start: '2026-11-04T09:00:00+08:00', url: '/student/classes/21/core_tasks/31' },
  { id: 'assembly', title: 'Assembly', start: '2026-11-04', end: '2026-11-05', description: '<p>Hall</p><script>unsafe()</script>', url: '/student/classes/21/events/7' },
];
const client = (calendar = JSON.stringify(events)) => new SchoolDataClient({ now: () => new Date(now), pause: async () => {}, fetch: async (_, url) => new Response(
  url.includes('my?page=1') ? '<div id="classes"><a href="/student/classes/21">Synthetic class</a></div>' : url.includes('my?page=') ? '<div id="classes">No classes found</div>' :
  url.endsWith('/units') ? '<h1>Synthetic class</h1>' : url.endsWith('/core_tasks') ? card(31, 'Assessment', true) + card(32, 'Coursework', false) : url.endsWith('/events.json') ? calendar : ''
) });

test('type and submission requirements are independent and unknown stays unknown', () => {
  const tasks = parseManageBacTasks(card(1, 'Assessment', true) + card(2, 'Coursework', false) + card(3, 'Exam', null)).tasks;
  assert.deepEqual(tasks.map(t => [t.category, t.submissionRequired]), [['Assessment', true], ['Coursework', false], ['Exam', null]]);
  const detail = parseTaskDetail('<div class="core-task-show" data-submission-required="false"><h1 class="title">Reading</h1><p>No upload here</p></div>', '21', '2');
  assert.equal(detail.submissionRequired, false); assert.equal(detail.uploadAvailable, false);
});
test('course and global task lists include events, deduplicate linked assessments and preserve their date', async () => {
  const detail = await client().getCourseDetail('21');
  assert.equal(detail.tasks.length, 3); assert.equal(detail.tasksStatus, 'ready');
  const exam = detail.tasks.find(t => t.id === 'managebac:21:31');
  assert.equal(exam.category, 'Assessment'); assert.equal(exam.submissionRequired, true);
  assert.equal(exam.dueAt, '2026-11-04T09:00:00+08:00');
  const event = detail.tasks.find(t => t.kind === 'event');
  assert.equal(event.submissionRequired, false); assert.equal(event.description, 'Hall');
  assert.match(event.url, /\/events\/7$/); assert.equal(event.dueAt, '2026-11-04T00:00:00+08:00');
  const global = await client().syncManageBac({ refreshGrades: false });
  assert.equal(global.tasks.length, 3); assert.deepEqual(global.taskSyncedCourses, ['21']);
});
test('calendar failure retains task results and reports partial sync instead of confirmed empty', async () => {
  const result = await client('<main>Unknown calendar</main>').syncManageBac({ refreshGrades: false });
  assert.equal(result.tasks.length, 2); assert.deepEqual(result.taskFailedCourses, ['21']);
  assert.deepEqual(result.taskSyncedCourses, []);
});
test('no-submission work is not completed or overdue just because the date passed', () => {
  const past = { dueAt: '2026-11-02T01:00:00Z', status: '' };
  assert.equal(status({ ...past, submissionRequired: false }, now), 'review');
  assert.equal(status({ ...past, submissionRequired: null }, now), 'review');
  assert.equal(status({ ...past, submissionRequired: true, category: 'Assessment' }, now), 'overdue');
  assert.equal(status({ ...past, status: 'Submitted' }, now), 'completed');
  const event = { kind: 'event', start: '2026-11-03', dueAt: '2026-11-03T00:00:00+08:00', submissionRequired: false };
  assert.equal(status(event, now), 'started'); assert.equal(active(event, now), true);
  assert.equal(status(event, Date.parse('2026-11-03T16:00:00Z')), 'ended');
});
test('event reminders appear before the event and disappear when it ends without claiming submission', () => {
  const task = { id: 'event-1', courseId: '21', kind: 'event', title: 'Exam', start: '2026-11-03T03:00:00Z', end: '2026-11-03T04:00:00Z', dueAt: '2026-11-03T03:00:00Z', submissionRequired: false };
  const snapshot = { accountKey: 'a', tasks: [task], fetchedAt: new Date(now).toISOString(), taskSyncedCourses: ['21'] };
  const initial = evaluate({ snapshot, accountKey: 'a', now });
  assert.equal(initial.alerts.length, 1);
  assert.equal(pendingAlerts(initial.state, snapshot, now).length, 1);
  const ended = now + 3 * 3600000;
  assert.equal(pendingAlerts(initial.state, snapshot, ended).length, 0);
  assert.equal(Object.keys(evaluate({ state: initial.state, snapshot, accountKey: 'a', now: ended }).state.inbox).length, 0);
});

test('a published grade including zero completes an old quiz despite a stale submission label',()=>{
 for(const score of ['7 30 / 35 pts','0 / 10 pts','6'])assert.equal(status({score,status:'Not submitted',pastDue:true,submissionRequired:true},now),'completed');
 assert.equal(status({score:'—',status:'Not submitted',pastDue:true},now),'overdue');
 assert.equal(status({score:'7',status:'Resubmit',pastDue:true,submissionRequired:true},now),'overdue');
});
test('event requirements retain line breaks and images as inert content',async()=>{
 const data=JSON.stringify([{id:'img',title:'Image homework',start:'2026-11-03',allDay:true,description:'<p>Exercise 15F</p><p>9; 15; 16; 20</p><img src="/attachments/99/page.png" onerror="alert(1)"><script>bad()</script><a href="/attachments/100/download">Worksheet.pdf</a>'}]);
 const result=await client(data).getCourseDetail('21');const event=result.tasks.find(t=>t.kind==='event');
 assert.match(event.description,/15F\n9;/);assert.ok(event.content.some(b=>b.type==='image'&&b.url.endsWith('/page.png')));
 assert.ok(!JSON.stringify(event.content).includes('onerror'));assert.equal(event.attachments[0].name,'Worksheet.pdf');
});

test('task requirements preserve ordered lists, images within items and nested lists', () => {
 const task=parseTaskDetail(`<div class="core-task-show"><div class="description"><ol><li><p>Read the class notes</p></li><li>Use both methods<img src="/attachments/99/formula.png" onerror="unsafe()"></li><li><p>Solve for x:</p><ul><li>Check the domain</li><li>Verify solutions</li></ul><img src="/attachments/100/formula.png"></li></ol></div></div>`,'21','31');
 const list=task.content[0];assert.equal(list.type,'list');assert.equal(list.ordered,true);assert.equal(list.items.length,3);
 assert.deepEqual(list.items[1].content.map(b=>b.type),['text','image']);
 assert.deepEqual(list.items[2].content.map(b=>b.type),['text','list','image']);
 assert.equal(list.items[2].content[1].ordered,false);
 assert.equal(list.items[2].content[1].items[1].content[0].text,'Verify solutions');
 assert.ok(!JSON.stringify(task.content).includes('onerror'));
});

test('calendar requirements keep custom numbering and reversed alphabetic lists', async () => {
 const data=JSON.stringify([{id:'numbered',title:'Numbered event',start:'2026-11-06',description:'<ol start="5" reversed type="A"><li>First</li><li value="2">Second</li></ol><p>After list</p>'}]);
 const result=await client(data).getCourseDetail('21');const content=result.tasks.find(t=>t.kind==='event').content;
 assert.equal(content[0].start,5);assert.equal(content[0].reversed,true);assert.equal(content[0].marker,'A');assert.equal(content[0].items[1].value,2);
 assert.equal(content[1].text,'After list');
});

test('ManageBac timetable uses each session response and supplies course ids and 24-hour slots',async()=>{
 const c=new SchoolDataClient({fetch:async(_site,url)=>{assert.match(url,/datepicker%5Bstart_date%5D=2026-11-02/);return new Response('<table class="f-timetable"><a class="f-timetable-item" data-bs-content-url="/student/timetables/popup?date=2026-11-03&amp;ib_class_id=21"><small>1:00 PM - 1:40 PM</small></a></table>');}});
 const result=await c.getTimetable('2026-11-02');assert.deepEqual(result.slots,[{courseId:'21',date:'2026-11-03',start:'13:00',end:'13:40'}]);
});

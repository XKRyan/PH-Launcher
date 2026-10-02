'use strict';
// ManageBac 通知 / 待办解析（与网页端 `webapp_mb_stream.py` 的
// `fetch_notifications` / `parse_deadline_rows` / `_parse_due_text` 同一口径）。
//
// 为什么要有这一份：真实 ManageBac 的「通知」正文由独立服务（mnn-hub）+ JWT 下发，
// `/student` 页面上只有一个带 `data-count` 的触发器；待办则在
// `/student/tasks_and_deadlines` 上用 `.f-task-tile` 渲染。选择器写错的代价是
// 「永远 0 条」，而 0 条看起来就像「没有待办」——所以这里照着真实片段钉住。
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseNotificationMeta, parseDeadlineTiles, parseDueText, readUrl } = require('../electron/school-data.cjs');

const STUDENT_PAGE = `<!doctype html><html><body>
  <div class="js-messages-and-notifications-trigger"
       data-mnn-hub-endpoint="https://mnn-hub.prod.faria.cn"
       data-token="eyJhbGciOiJIUzI1NiJ9.fake"
       data-namespace="student" data-count="3">
    <div id="mnn-sidebar-content"></div>
  </div>
  <a href="/student/notifications">Notifications</a>
</body></html>`;

const DEADLINES_PAGE = `<!doctype html><html><body>
  <div class="f-tile f-task-tile">
    <div class="f-tile__body">
      <p class="f-tile__title h5">
        <a class="f-tile__title-link" href="/student/classes/11516640/core_tasks/27588216"><span>behavior time</span></a>
      </p>
      <div class="f-tile__description">
        <span><svg class="fi-clock"></svg> Sep 20, 11:55 PM</span>
        <span class="vr"></span>
        <a href="/student/classes/11516640">IB DP 2028届 ESS SL by Yan (Grade 11)</a>
        <span class="badge"><span class="badge-label">Summative</span></span>
        <span class="badge"><span class="badge-label">Coursework</span></span>
        <span class="badge" data-bs-title="Waiting"><span class="badge-label">Pending</span></span>
      </div>
    </div>
  </div>
  <div class="f-tile f-task-tile">
    <div class="f-tile__body">
      <p class="f-tile__title h5">
        <a class="f-tile__title-link" href="/student/classes/11520028/core_tasks/27524700"><span>暑假作业</span></a>
      </p>
      <div class="f-tile__description">
        <span>Sep 3, 12:00 PM</span>
        <a href="/student/classes/11520028">IB DP G11 9 LL SL (Grade 11)</a>
        <span class="badge" data-bs-title="Submitted"><span class="badge-label">Submitted</span></span>
      </div>
    </div>
  </div>
  <section class="js-tasks"><div class="f-tile">
    <p class="f-tile__title"><a class="f-tile__title-link" href="/student/classes/1/core_tasks/2"><span>备用选择器里的作业</span></a></p>
  </div></section>
</body></html>`;

test('未读数从触发器的 data-count 如实读（读不到就是 null，不编）', () => {
  const meta = parseNotificationMeta(STUDENT_PAGE);
  assert.equal(meta.unreadCount, 3);
  assert.equal(meta.hub, 'https://mnn-hub.prod.faria.cn');
  assert.equal(meta.namespace, 'student');
  assert.match(meta.url, /\/student\/notifications$/);
});

test('页面上没有触发器时 unreadCount 是 null（不是 0）', () => {
  const meta = parseNotificationMeta('<html><body><p>nothing here</p></body></html>');
  assert.equal(meta.unreadCount, null);
  assert.match(meta.url, /\/student\/notifications$/);
});

test('待办条目按 .f-task-tile 解析：标题 / 课程 / 截止原文 / 状态 / 链接', () => {
  const rows = parseDeadlineTiles(DEADLINES_PAGE, { reference: new Date('2026-09-19T10:00:00+08:00') });
  // 页面上有 `.f-task-tile` 时**只认它**（`.js-tasks .f-tile` 只是没有真实类名时的兜底），
  // 与网页端 `parse_deadline_rows` 的选择器顺序一致。
  assert.equal(rows.length, 2, '两个 .f-task-tile');
  const [first] = rows;
  assert.equal(first.title, 'behavior time');
  assert.equal(first.course, 'IB DP 2028届 ESS SL by Yan (Grade 11)');
  assert.equal(first.classId, '11516640');
  assert.equal(first.dueText, 'Sep 20, 11:55 PM');
  assert.equal(first.due, '2026-09-20 23:55', '`Sep 20, 11:55 PM` 要能解析成 24 小时制');
  assert.equal(first.status, 'Pending');
  assert.equal(first.content, 'Summative · Coursework · Pending', '徽标文字原样拼起来（含状态徽标）');
  assert.match(first.link, /\/student\/classes\/11516640\/core_tasks\/27588216$/);
  assert.ok(first.id && first.id.length >= 16, '要有稳定的 id');
  assert.equal(rows[1].status, 'Submitted', '已提交要在 status 里如实带出来');
});

test('没有 .f-task-tile 的页面退回 .js-tasks .f-tile（兜底选择器）', () => {
  const rows = parseDeadlineTiles('<section class="js-tasks"><div class="f-tile">'
    + '<p class="f-tile__title"><a class="f-tile__title-link" href="/student/classes/1/core_tasks/2"><span>备用选择器里的作业</span></a></p>'
    + '</div></section>', { reference: new Date('2026-09-19T10:00:00+08:00') });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, '备用选择器里的作业');
});

test('日期解析：页面不给年份时，过去超过 180 天算明年', () => {
  const reference = new Date('2026-09-19T10:00:00+08:00');
  assert.equal(parseDueText('Sep 20, 11:55 PM', reference), '2026-09-20 23:55');
  assert.equal(parseDueText('Sep 3, 12:00 PM', reference), '2026-09-03 12:00');
  assert.equal(parseDueText('Jan 5, 9:00 AM', reference), '2027-01-05 09:00', '过去半年以上 → 明年');
  assert.equal(parseDueText('', reference), '', '解析不出来回空串（界面显示原文）');
  assert.equal(parseDueText('下周见', reference), '');
  // **已知限制**：ManageBac 真实页面给的是 `Sep 20, 11:55 PM`（月在前）。
  // 「日在前」的写法（`20 Sep 2026`）不认，解析不出来就回空串、界面显示原文，
  // 不会瞎猜一个日期。哪天真实页面改成日在前，这里要一起加。
  assert.equal(parseDueText('20 Sep 2026, 11:55 PM', reference), '');
});

test('注入的脚本不会进到解析结果里', () => {
  const html = '<div class="f-task-tile"><p class="f-tile__title"><a class="f-tile__title-link" href="/student/classes/1/core_tasks/2">'
    + '<span>作业<script>alert(1)</script></span></a></p></div>';
  const rows = parseDeadlineTiles(html, { reference: new Date('2026-09-19T10:00:00+08:00') });
  assert.equal(rows.length, 1);
  assert.doesNotMatch(rows[0].title, /alert/, 'script 标签要先被摘掉');
});

// 这条是真实事故的回归钉子：只读白名单原来**只**放行带 `?view=upcoming|past|overdue`
// 的待办页，于是通知卡片请求不带参数的 `/student/tasks_and_deadlines` 时被
// `URL_NOT_ALLOWED` 拦下，被 catch 吞成一句「未读到待办与截止日期」→ 界面永远 0 条。
// 网页端（`webapp_mb_stream.py` 的 `fetch_notifications`）读的正是这个不带参数的地址。
test('通知卡片读的待办地址必须在只读白名单里（不带参数也要放行）', () => {
  assert.match(readUrl('managebac', '/student/tasks_and_deadlines'), /^https:\/\/shph\.managebac\.cn\/student\/tasks_and_deadlines$/);
  for (const view of ['upcoming', 'past', 'overdue']) {
    assert.match(readUrl('managebac', `/student/tasks_and_deadlines?view=${view}`), new RegExp(`view=${view}$`));
  }
  assert.throws(() => readUrl('managebac', '/student/tasks_and_deadlines?view=whatever'),
    (error) => error.code === 'URL_NOT_ALLOWED', '没见过的 view 一律不放行');
  assert.throws(() => readUrl('managebac', '/student/tasks_and_deadlines?view=upcoming&x=1'),
    (error) => error.code === 'URL_NOT_ALLOWED', '多带参数也不放行');
});

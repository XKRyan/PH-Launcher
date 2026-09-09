(() => {
  'use strict';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  // Short lessons still need room for their course, room and teacher at the
  // largest supported display size. Keep the timeline and cards on one scale.
  const SCHOOL_MINUTE_HEIGHT = 4.8;
  // PHL period schedule: each period maps to its start/end in minutes.
  const PHL_PERIODS = [
    { label: 'P1', start: 8 * 60, end: 8 * 60 + 45 },
    { label: 'P2', start: 8 * 60 + 55, end: 9 * 60 + 40 },
    { label: 'P3', start: 9 * 60 + 50, end: 10 * 60 + 35 },
    { label: 'P4', start: 10 * 60 + 45, end: 11 * 60 + 30 },
    { label: '午餐', start: 11 * 60 + 45, end: 12 * 60 + 45 },
    { label: 'P5', start: 12 * 60 + 55, end: 13 * 60 + 40 },
    { label: 'P6', start: 13 * 60 + 50, end: 14 * 60 + 35 },
    { label: 'P7', start: 14 * 60 + 45, end: 15 * 60 + 30 },
    { label: 'P8', start: 15 * 60 + 45, end: 16 * 60 + 30 },
    { label: '晚自习', start: 18 * 60, end: 20 * 60 + 30 },
  ];
  const PHL_FLOOR = PHL_PERIODS[0].start; // 08:00
  const PHL_CEILING = PHL_PERIODS[PHL_PERIODS.length - 1].end; // 20:30
  const localDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const shift = (date, amount) => new Date(Date.parse(`${date}T12:00:00Z`) + amount * 86400000).toISOString().slice(0, 10);
  const monday = () => { const date = localDate(); return shift(date, -(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7); };
  const minutes = (time) => { const [h, m] = String(time).split(':').map(Number); return h * 60 + m; };
  const timeLabel = (value) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  const stamp = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const color = (key) => [...String(key)].reduce((total, char) => (total * 31 + char.charCodeAt(0)) >>> 0, 0) % 6;
  const userError = (error, fallback) => {
    let message = String(error?.message || error || fallback).trim();
    // Electron may wrap a typed, user-safe IPC failure more than once.
    // Do not expose implementation error class names in the workspace or dialogs.
    const prefix = /^(?:Error invoking remote method ['"][^'"]+['"]:\s*|Error:\s*|School(?:Auth|Data)Error\s*:\s*)/i;
    while (prefix.test(message)) message = message.replace(prefix, '').trim();
    message = message.replace(/请先在内置网页登录[^；。]*/g, '请在启动器中登录学校账号');
    return message || fallback;
  };
  const TTL = { edupage: 120000, managebac: 180000 };
  const state = { snapshot: { edupage: null, managebac: null, preferences: {}, status: {} }, weeks: new Map(), epochs: {}, route: 'timetable', courseTab: 'courses', week: monday(), showWeekend: false, busy: new Set(), error: '', notice: '', query: '', courseSort: 'manual', taskSort: 'due', showHidden: false, consent: new Set(), refreshId: 0, syncIds: { edupage: 0, managebac: 0 }, autoTimer: null };
  let root;
  let modal;
  const authBlocked = new Set();
  const api = () => window.ph.school;
  const prefs = () => state.snapshot.preferences || {};
  const currentWeek = () => state.weeks.get(state.week) || null;
  const statusFor = (source) => state.snapshot.status?.[source] || {};
  const checkedAt = (source) => (source === 'edupage' ? currentWeek()?.fetchedAt : state.snapshot.managebac?.fetchedAt) || statusFor(source).updatedAt || '';
  const isStale = (source) => (source === 'edupage' && !currentWeek()) || !checkedAt(source) || Date.now() - Date.parse(checkedAt(source)) >= TTL[source];
  const autoApproved = (source) => state.consent.has(source) || prefs().autoSync === true;
  const visible = () => Boolean(root && document.visibilityState !== 'hidden' && root.classList.contains('active'));
  const isTimetableRoute = () => state.route === 'timetable' || state.route === 'class-timetable';
  const isClassTimetable = () => state.route === 'class-timetable';
  const activeSource = () => isTimetableRoute() ? 'edupage' : 'managebac';
  function mergeSnapshot(snapshot, expectedWeek = '') {
    if (!snapshot || typeof snapshot !== 'object') return;
    const nextEpoch = snapshot.epochs?.edupage;
    if (nextEpoch !== undefined && state.epochs.edupage !== undefined && nextEpoch !== state.epochs.edupage) state.weeks.clear();
    if (snapshot.epochs) state.epochs = { ...state.epochs, ...snapshot.epochs };
    const incoming = snapshot.edupage;
    // Never replace the selected week with a response for a different week.
    if (incoming === null && expectedWeek) state.weeks.delete(expectedWeek);
    if (incoming?.weekStart && (!expectedWeek || incoming.weekStart === expectedWeek)) {
      const cachedAccount = [...state.weeks.values()].find((week) => week?.accountKey && incoming.accountKey && week.accountKey !== incoming.accountKey);
      if (cachedAccount) state.weeks.clear();
      state.weeks.set(incoming.weekStart, incoming);
    }
    state.snapshot = { ...state.snapshot, ...snapshot, preferences: snapshot.preferences || state.snapshot.preferences || {}, status: snapshot.status || state.snapshot.status || {} };
  }
  function syncSummary(source) {
    const remote = statusFor(source); const data = source === 'edupage' ? currentWeek() : state.snapshot.managebac;
    const last = checkedAt(source) || data?.fetchedAt;
    if (!last && !remote.error) return '';
    const stale = remote.state === 'stale' || Boolean(remote.error) || isStale(source);
    const detail = remote.error ? ` · ${remote.error}` : stale ? ' · 显示最近已验证内容，等待更新' : '';
    return `<div class="school-cache-status ${stale ? 'is-stale' : ''}" role="status"><span>${stale ? '内容可能不是最新' : '内容已更新'}</span><span>上次读取 ${esc(stamp(last) || '尚未完成')}</span>${detail ? `<span>${esc(detail.trim())}</span>` : ''}</div>`;
  }
  const selections = () => { const data = currentWeek(); return data && prefs().accountKey === data.accountKey && Array.isArray(prefs().groups) ? prefs().groups : null; };
  // A missing choice is not evidence of enrolment. Personal timetable stays empty
  // until the student explicitly chooses teaching groups.
  const selectedLessons = () => { const data = currentWeek(); const selected = selections(); return selected === null ? [] : (data?.lessons || []).filter((lesson) => selected.includes(lesson.groupKey)); };
  const displayedLessons = () => isClassTimetable() ? currentWeek()?.lessons || [] : selectedLessons();
  const btn = (label, action, extra = '', primary = false) => `<button type="button" class="${primary ? 'primary-button' : 'secondary-button'}" data-school-action="${action}" ${extra}>${esc(label)}</button>`;
  const courseReminderLabel = () => prefs().courseReminderMinutes === null || prefs().courseReminderMinutes === undefined ? '上课提醒：未开启' : prefs().courseReminderMinutes === 0 ? '上课提醒：准时' : `上课提醒：提前 ${prefs().courseReminderMinutes} 分钟`;
  const noData = (title, description, site) => `<div class="school-empty"><span class="school-empty-symbol" aria-hidden="true">${site === 'edupage' ? '▦' : '▤'}</span><h3>${esc(title)}</h3><p>${esc(description)}</p><div class="school-actions">${btn(state.snapshot.accounts?.[site]?.saved ? '修改账号' : '输入账号密码', 'account', `data-site="${site}"`, !state.snapshot.accounts?.[site]?.saved)}${state.snapshot.accounts?.[site]?.saved ? btn('登录并同步', 'connect', `data-source="${site}" ${state.busy.has(site) ? 'disabled' : ''}`, true) : ''}</div><small>账号密码只提交给对应学校网站；学校内容不会自动发送给 AI。</small></div>`;
  const warnings = (data) => data?.warnings?.length ? `<details class="school-warnings"><summary>${data.warnings.length} 条核对提示</summary><ul>${data.warnings.map((warning) => `<li>${esc(warning)}</li>`).join('')}</ul></details>` : '';

  function groupLessons(lessons) {
    const merged = [];
    for (const lesson of [...lessons].sort((a, b) => `${a.date}|${a.groupKey}|${a.start}`.localeCompare(`${b.date}|${b.groupKey}|${b.start}`))) {
      const previous = merged.at(-1);
      if (previous && previous.date === lesson.date && previous.groupKey === lesson.groupKey && previous.end === lesson.start && previous.room === lesson.room && previous.teacher === lesson.teacher && previous.cancelled === lesson.cancelled) {
        previous.end = lesson.end; previous.count += 1;
      } else merged.push({ ...lesson, count: 1 });
    }
    return merged;
  }
  function positionLessons(lessons) {
    const sorted = [...lessons].sort((a, b) => a.start.localeCompare(b.start) || b.end.localeCompare(a.end));
    let cluster = []; let end = -1;
    const result = [];
    const finish = () => {
      const laneEnds = [];
      for (const lesson of cluster) {
        let lane = laneEnds.findIndex((value) => value <= minutes(lesson.start));
        if (lane === -1) lane = laneEnds.length;
        laneEnds[lane] = minutes(lesson.end); lesson.lane = lane;
      }
      for (const lesson of cluster) result.push({ ...lesson, lanes: laneEnds.length });
      cluster = [];
    };
    for (const lesson of sorted) {
      if (minutes(lesson.start) >= end && cluster.length) finish();
      cluster.push({ ...lesson }); end = Math.max(end, minutes(lesson.end));
    }
    if (cluster.length) finish();
    return result;
  }
  function layoutDayLessons(lessons) {
    const sorted = [...lessons].sort((a, b) => a.start.localeCompare(b.start) || b.end.localeCompare(a.end));
    const result = []; let cluster = []; let clusterEnd = -1;
    const finish = () => {
      let activeEnds = []; let peak = 0;
      for (const item of cluster) { activeEnds = activeEnds.filter((end) => end > item.start); activeEnds.push(item.end); peak = Math.max(peak, activeEnds.length); }
      if (peak > 2) {
        result.push({ aggregate: true, items: cluster, start: cluster[0].start, end: cluster.reduce((latest, item) => item.end > latest ? item.end : latest, cluster[0].end), lane: 0, lanes: 1 });
      } else result.push(...positionLessons(cluster));
      cluster = []; clusterEnd = -1;
    };
    for (const lesson of sorted) {
      if (cluster.length && minutes(lesson.start) >= clusterEnd) finish();
      cluster.push(lesson); clusterEnd = Math.max(clusterEnd, minutes(lesson.end));
    }
    if (cluster.length) finish();
    return result;
  }
  function lessonButton(lesson, floor) {
    const top = (minutes(lesson.start) - floor) * SCHOOL_MINUTE_HEIGHT + 3;
    const height = Math.max(48, (minutes(lesson.end) - minutes(lesson.start)) * SCHOOL_MINUTE_HEIGHT - 6);
    if (lesson.aggregate) {
      const highlighted = lesson.items.some((item) => (prefs().highlights || []).includes(item.groupKey));
      const cancelled = lesson.items.every((item) => item.cancelled);
      return `<button type="button" class="school-lesson school-lesson-cluster ${highlighted ? 'is-highlighted' : ''} ${cancelled ? 'is-cancelled' : ''}" data-school-action="lesson-cluster" data-date="${esc(lesson.items[0].date)}" data-start="${esc(lesson.start)}" data-end="${esc(lesson.end)}" style="top:${top}px;height:${height}px;left:3px;width:calc(100% - 6px)" title="${esc(lesson.items.map((item) => item.course).join(' · '))}"><span class="school-lesson-time">${lesson.start}–${lesson.end}</span><strong>${lesson.items.length} 门课程</strong><span>点击查看完整列表</span></button>`;
    }
    const detail = [lesson.course, `${lesson.start}–${lesson.end}`, lesson.room || '教室未提供', lesson.teacher || '老师未提供', lesson.groups.join(' / ')].filter(Boolean).join(' · ');
    return `<button type="button" class="school-lesson school-color-${color(lesson.groupKey)} ${lesson.cancelled ? 'is-cancelled' : ''} ${(prefs().highlights || []).includes(lesson.groupKey) ? 'is-highlighted' : ''}" data-school-action="lesson" data-id="${esc(lesson.id)}" style="top:${top}px;height:${height}px;left:calc(${lesson.lane * 100 / lesson.lanes}% + 3px);width:calc(${100 / lesson.lanes}% - 6px)" title="${esc(`${detail} · 点击查看完整详情`)}" aria-label="${esc(`${detail}，点击查看完整详情`)}"><span class="school-lesson-time">${lesson.start}–${lesson.end}${lesson.count > 1 ? ` · ${lesson.count} 节连堂` : ''}</span><strong>${esc(lesson.course)}</strong><span class="school-lesson-room">${esc(lesson.room || '教室未提供')}</span><span class="school-lesson-teacher">${esc(lesson.teacher || '老师未提供')}</span>${lesson.cancelled ? '<b class="school-cancel-label">已取消</b>' : ''}</button>`;
  }
  function timetable() {
    const data = currentWeek();
    const start = state.week;
    const classRoute = isClassTimetable();
    const toolbar = `<div class="school-weekbar"><strong>${esc(start)} — ${esc(shift(start, state.showWeekend ? 6 : 4))}</strong><div class="school-actions">${btn('上一周', 'week', 'data-delta="-7" aria-label="上一周"')}${btn('本周', 'week', 'data-delta="0"')}${btn('下一周', 'week', 'data-delta="7" aria-label="下一周"')}${btn(state.showWeekend ? '隐藏周末' : '显示周末', 'toggle-weekend', `aria-pressed="${state.showWeekend}"`)}${btn(state.busy.has('edupage') ? '正在同步…' : '刷新课表', 'sync', `data-source="edupage" ${state.busy.has('edupage') ? 'disabled' : ''}`, true)}</div></div>${data && !classRoute ? `<div class="school-actions">${btn('选择教学组', 'groups')}${btn('自动识别选课', 'auto-groups')}${btn(courseReminderLabel(), 'course-reminder', `${selections()?.length && selectedLessons().some((lesson) => !lesson.cancelled) ? '' : 'disabled'}`)}</div>` : ''}`;
    if (!data) return toolbar + syncSummary('edupage') + noData(classRoute ? '查看班级这一周的课程' : '把一周安排放在眼前', state.weeks.size ? '这一周尚未读取。你可以先查看已缓存的周，或手动刷新本周课表。' : classRoute ? '先登录 EduPage，再读取当前账号所属班级的课表。这里展示全部可见教学组。' : '先登录 EduPage，再读取本周课表。首次同步后，选择你自己的教学组。', 'edupage');
    const selected = selections();
    const lessons = groupLessons(displayedLessons());
    const selectionNotice = classRoute
      ? `<div class="school-callout school-readonly-scope">当前账号所属班级：${esc(data.className || '班级名称未提供')} · 显示全部可见教学组，不受个人选课筛选影响。<br>本版暂不支持切换到其他班级；添加自己的课程提醒，请前往“我的课表”。</div><div class="school-meta">${esc(data.className || '当前班级')} · 同步于 ${esc(stamp(data.fetchedAt))}</div>`
      : selected === null ? '' : `<div class="school-meta">已选择 ${selected.length} 个教学组 · ${selectedLessons().filter((lesson) => !lesson.cancelled).length} 节有效课程 · 同步于 ${esc(stamp(data.fetchedAt))}</div>`;
    if (!classRoute && (!selected || selected.length === 0)) {
      const configured = Array.isArray(selected);
      return toolbar + syncSummary('edupage') + `<div class="school-selection-empty"><span class="school-empty-symbol" aria-hidden="true">✓</span><h3>${configured ? '当前没有选择教学组' : '先选择你的教学组'}</h3><p>${configured ? '个人课表保持为空，不会用班级课程代替。' : '班级课表包含所有可选课程。请按科目搜索并勾选你实际参加的教学组，系统不会替你猜测。'}</p>${btn(configured ? '重新选择教学组' : '开始选择教学组', 'groups', '', true)}</div>` + warnings(data);
    }
    const minTime = Math.min(PHL_FLOOR, ...lessons.map((lesson) => minutes(lesson.start)));
    const maxTime = Math.max(PHL_CEILING, ...lessons.map((lesson) => minutes(lesson.end)));
    const floor = Math.floor(minTime / 60) * 60;
    const height = (maxTime - floor + 15) * SCHOOL_MINUTE_HEIGHT;
    const labels = [];
    for (const period of PHL_PERIODS) {
      if (period.end <= maxTime + 60) labels.push(`<span class="school-axis-time" style="top:${(period.start - floor) * SCHOOL_MINUTE_HEIGHT}px">${esc(period.label)}<small>${timeLabel(period.start)}–${timeLabel(period.end)}</small></span>`);
    }
    const today = localDate();
    const visibleDays = state.showWeekend ? days : days.slice(0, 5);
    const columnClass = state.showWeekend ? 'school-days-7' : 'school-days-5';
    const header = `<div class="school-grid-header ${columnClass}"><span class="school-zone">上海时间</span>${visibleDays.map((day, index) => `<div class="${shift(start, index) === today ? 'is-today' : ''}"><strong>${day}</strong><span>${shift(start, index).slice(5)}</span></div>`).join('')}</div>`;
    const grid = `<div class="school-timetable-scroll"><div class="school-timetable ${columnClass}">${header}<div class="school-grid-body ${columnClass}" style="height:${height}px"><div class="school-time-axis">${labels.join('')}</div><div class="school-now-line" hidden aria-label="当前时间"></div>${visibleDays.map((day, index) => {
      const date = shift(start, index);
      const dayLessons = layoutDayLessons(lessons.filter((lesson) => lesson.date === date));
      const missing = data.missingDates?.includes(date);
      return `<div class="school-day-column ${date === today ? 'is-today' : ''}" data-date="${date}" data-floor="${floor}" data-ceiling="${maxTime}">${labels.map((_, i) => `<div class="school-hour-line" style="top:${i * 60 * SCHOOL_MINUTE_HEIGHT}px"></div>`).join('')}${PHL_PERIODS.map((p) => { const top = (p.start - floor) * SCHOOL_MINUTE_HEIGHT; const bot = (p.end - floor) * SCHOOL_MINUTE_HEIGHT; return `<div class="school-period-zone school-period-${p.label === '午餐' ? 'lunch' : p.label === '晚自习' ? 'evening' : 'class'}" style="top:${top}px;height:${bot - top}px"></div>`; }).join('')}${missing ? '<p class="school-day-empty">未能同步<br>请查原网页</p>' : !dayLessons.length ? '<p class="school-day-empty">未识别到课程</p>' : ''}${dayLessons.map((lesson) => lessonButton(lesson, floor)).join('')}</div>`;
    }).join('')}</div></div></div>`;
    return toolbar + syncSummary('edupage') + selectionNotice + grid + warnings(data) + '<p class="school-footnote">点击课程可查看详情、标记重点。不同教学组使用固定颜色；临时调课与停课请以 EduPage 原网页为准。</p>';
  }

  function courses() {
    const data = state.snapshot.managebac;
    if (!data) return syncSummary('managebac') + noData('课程、成绩和作业，一处查看', '登录 ManageBac 后同步课程。成绩保留网站原始表述，不推算 GPA。', 'managebac');
    const order = Array.isArray(prefs().courseOrder) ? prefs().courseOrder : [];
    const items = window.courseOrder
      ? window.courseOrder.apply(data.courses, order, state.courseSort)
      : [...data.courses].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return `${syncSummary('managebac')}<div class="school-section-head"><div><span class="section-kicker">MY COURSES</span><h2>${items.length} 门课程</h2></div><label class="school-inline-label">排序<select data-school-field="course-sort"><option value="manual" ${state.courseSort === 'manual' ? 'selected' : ''}>自定义（拖拽）</option><option value="name" ${state.courseSort === 'name' ? 'selected' : ''}>课程名称</option><option value="grade" ${state.courseSort === 'grade' ? 'selected' : ''}>总评原文</option></select></label></div><p class="school-drag-hint">拖动课程卡片可调整顺序，顺序会保存在本机。</p><div class="school-course-grid">${items.map((course) => `<button class="school-course-card school-color-${color(course.id)}" type="button" draggable="true" data-school-drag data-school-action="course" data-id="${esc(course.id)}"><span class="school-course-grip" aria-hidden="true">⠿</span><span class="school-course-mark" aria-hidden="true">${esc(course.name.slice(0, 1))}</span><h3>${esc(course.name)}</h3><div><span>总评</span><strong>${course.grade ? esc(course.grade) : '暂未读取到'}</strong></div><small>单元 · 作业 · 文件 · 日历 →</small></button>`).join('')}</div>${items.length ? '' : '<div class="school-empty"><h3>没有识别到课程</h3><p>请在 ManageBac 原网页核对课程列表。</p></div>'}${warnings(data)}`;
  }
  function taskRows(items, compact = false) {
    return items.map((task) => {
      const hidden = (prefs().hiddenTasks || []).includes(task.id);
      return `<article class="school-task-row ${hidden ? 'is-hidden-task' : ''}"><button type="button" class="school-task-main" data-school-action="task" data-course="${esc(task.courseId)}" data-id="${esc(task.id.split(':').at(-1))}"><span class="school-task-course">${esc(task.course || '课程作业')}</span><strong>${esc(task.title)}</strong><span class="school-task-due ${task.pastDue ? 'is-overdue' : ''}">${esc(task.dueAt ? stamp(task.dueAt) : task.dueText || '截止日期请查原网页')}${task.status ? ` · ${esc(task.status)}` : ''}</span></button>${task.score ? `<span class="school-score">${esc(task.score)}</span>` : ''}${compact ? '' : `<button type="button" class="school-text-button" data-school-action="hide-task" data-id="${esc(task.id)}" title="仅更改本地列表，不修改 ManageBac">${hidden ? '恢复' : '隐藏'}</button>`}</article>`;
    }).join('');
  }
  function tasks() {
    const data = state.snapshot.managebac;
    if (!data) return syncSummary('managebac') + noData('不错过下一项作业', '从 ManageBac 同步作业、截止时间与提交状态。隐藏作业仅影响本地列表。', 'managebac');
    const hidden = new Set(prefs().hiddenTasks || []);
    const query = state.query.toLocaleLowerCase();
    // Rendering-side guard: even if a cached snapshot still carries old
    // entries, only tasks due within the last 14 days (or ahead) are shown.
    const dueCutoff = Date.now() - 14 * 86400000;
    const dueFutureLimit = Date.now() + 365 * 86400000;
    const items = data.tasks.filter((task) => (state.showHidden ? hidden.has(task.id) : !hidden.has(task.id)) && `${task.title} ${task.course}`.toLocaleLowerCase().includes(query)).filter((task) => {
      if (!task.dueAt) return true;
      const ts = Date.parse(task.dueAt);
      return Number.isFinite(ts) ? ts >= dueCutoff && ts <= dueFutureLimit : true;
    });
    items.sort((a, b) => {
      if (state.taskSort === 'name') return a.title.localeCompare(b.title, 'zh-CN');
      const now = Date.now();
      const tsA = a.dueAt ? Date.parse(a.dueAt) : Infinity;
      const tsB = b.dueAt ? Date.parse(b.dueAt) : Infinity;
      const overdueA = tsA < now ? 1 : 0;
      const overdueB = tsB < now ? 1 : 0;
      if (overdueA !== overdueB) return overdueA - overdueB;
      return tsA - tsB || a.title.localeCompare(b.title, 'zh-CN');
    });
    return `${syncSummary('managebac')}<div class="school-section-head"><div><span class="section-kicker">TASKS & DEADLINES</span><h2>${state.showHidden ? '已隐藏' : '课程作业'} <small>${items.length}</small></h2></div><button type="button" class="school-text-button" data-school-action="toggle-hidden">${state.showHidden ? '返回作业列表' : `查看已隐藏 (${data.tasks.filter((task) => hidden.has(task.id)).length})`}</button></div><div class="school-task-filters"><input type="search" value="${esc(state.query)}" data-school-field="query" placeholder="搜索作业或课程" aria-label="搜索作业或课程"/><select data-school-field="task-sort" aria-label="作业排序"><option value="due" ${state.taskSort === 'due' ? 'selected' : ''}>明确截止时间优先</option><option value="name" ${state.taskSort === 'name' ? 'selected' : ''}>作业名称</option></select></div><div class="school-task-list">${taskRows(items) || '<div class="school-empty"><h3>这里暂时没有作业</h3><p>试试其他关键词，或在原网页核对最新安排。</p></div>'}</div>`;
  }
  function core() {
    return `<div class="school-section-head"><div><span class="section-kicker">IB CORE</span><h2>把长期项目放在心上</h2></div></div><div class="school-core-grid"><article><span class="section-kicker">EXPERIENCES & REFLECTIONS</span><h3>CAS</h3><p>查看活动目标与进度，回到原网页整理证据、完成反思。</p>${btn('读取 CAS 概览', 'core', 'data-kind="cas"', true)}</article><article><span class="section-kicker">EXTENDED ESSAY</span><h3>EE</h3><p>查看论文工作表与项目摘要，让下一步有据可查。</p>${btn('读取 EE 概览', 'core', 'data-kind="ee"', true)}</article></div><div class="school-callout">这些内容不会自动交给 AI，也不会代你提交任何表单。</div>${btn('登录 ManageBac 账号', 'account', 'data-site="managebac"')}`;
  }
  function courseWorkspace() {
    const tabs = [['courses', '课程'], ['tasks', '作业与截止'], ['core', 'CAS / EE']];
    return `<nav class="school-course-tabs" aria-label="课程内容">${tabs.map(([key, label]) => `<button type="button" data-school-action="course-tab" data-course-tab="${key}" class="${state.courseTab === key ? 'active' : ''}" aria-current="${state.courseTab === key ? 'page' : 'false'}">${label}</button>`).join('')}</nav>${state.courseTab === 'courses' ? courses() : state.courseTab === 'tasks' ? tasks() : core()}`;
  }
  function render() {
    if (!root) return;
    const source = activeSource();
    const data = state.snapshot[source];
    const page = isClassTimetable() ? { title: '班级课表', description: '查看当前账号所属班级的课程与教室安排。' } : state.route === 'courses' ? { title: '我的课程', description: '查看课程、作业截止时间与 CAS / EE 项目。' } : { title: '我的课表', description: '从 EduPage 同步课程，选择自己的教学组。' };
    const automatic = `<label class="school-auto-sync"><input type="checkbox" data-school-action="auto-sync" ${prefs().autoSync ? 'checked' : ''}/><span><strong>自动更新课表与课程</strong><small>${prefs().autoSync ? '已开启：仅在当前页面打开且窗口可见时检查更新。' : '默认关闭。开启前会请你确认读取范围。'}</small></span></label>`;
    root.innerHTML = `<div class="school-top"><div><span class="section-kicker">PH LAUNCHER × HELLO PINGHE!</span><h1>${page.title}</h1><p>${page.description}</p></div></div><div class="school-refresh-preference">${automatic}<span>手动刷新始终可用；学校账号可在“设置 → 网站”中选择保存登录。</span></div>${state.error ? `<div class="school-error" role="alert">${esc(state.error)}</div>` : ''}${state.notice ? `<div class="school-success" role="status">${esc(state.notice)}</div>` : ''}${state.busy.size ? '<div class="school-loading" role="status"><span></span>正在读取学校数据，请稍候。你可以继续使用其他本地工具。</div>' : ''}${state.route === 'courses' && data ? `<div class="school-sync-line"><span>最近同步 ${esc(stamp(data.fetchedAt))} · 内容仅在本次打开期间保留</span>${btn(state.busy.has('managebac') ? '正在同步…' : '刷新课程与作业', 'sync', `data-source="managebac" ${state.busy.has('managebac') ? 'disabled' : ''}`)}</div>` : ''}${isTimetableRoute() ? timetable() : courseWorkspace()}<footer class="school-credit">合作整合：PH Launcher · Hello Pinghe! Launcher <span>非学校官方应用</span></footer>`;
    if (state.error) {
      const challenge = /验证码|双重验证|额外验证/.test(state.error);
      root.querySelector('[role="alert"]')?.insertAdjacentHTML('afterend', `<div class="school-actions">${btn('修改登录账号', 'account', `data-site="${source}"`)}${challenge ? btn('完成学校验证', 'login', `data-site="${source}"`, true) : ''}</div>`);
    }
    updateTimeLine();
  }
  function updateTimeLine() {
    if (!root) return;
    const now = new Date();
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((part) => [part.type, part.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`; const time = Number(parts.hour) * 60 + Number(parts.minute);
    const gridBody = root.querySelector('.school-grid-body');
    if (!gridBody) return;
    const line = gridBody.querySelector('.school-now-line');
    if (!line) return;
    const floor = Math.floor(PHL_FLOOR / 60) * 60;
    const visible = time >= PHL_FLOOR && time <= PHL_CEILING;
    line.hidden = !visible;
    if (visible) { line.style.top = `${(time - floor) * SCHOOL_MINUTE_HEIGHT}px`; line.setAttribute('aria-label', `当前时间 ${parts.hour}:${parts.minute}`); }
  }
  function showDialog(title, body, footer = '') {
    if (!modal) { modal = document.createElement('dialog'); modal.className = 'modal school-dialog'; document.body.append(modal); modal.addEventListener('click', onClick); modal.addEventListener('input', onModalField); modal.addEventListener('change', onModalField); modal.addEventListener('close', () => { if (!modal.open) modal.replaceChildren(); }); }
    if (modal.open) modal.close();
    modal.schoolLoadToken = null;
    modal.setAttribute('aria-labelledby', 'schoolDialogTitle');
    modal.innerHTML = `<div class="modal-head"><h3 id="schoolDialogTitle">${esc(title)}</h3><button type="button" data-school-action="close" aria-label="关闭" autofocus>×</button></div><div class="school-dialog-content">${body}</div><div class="school-dialog-footer">${footer || btn('关闭', 'close')}</div>`;
    modal.showModal();
  }
  function consent(source, callback) {
    if (autoApproved(source)) { callback(); return; }
    showDialog('连接学校账号', `<p>将连接你的 ${source === 'edupage' ? 'EduPage' : 'ManageBac'} 账号，读取${source === 'edupage' ? '所属班级的课程、教学组、任课老师和教室' : '课程、成绩、作业、讨论与项目摘要'}。选择“登录并同步”时会使用本机保存的账号密码完成此次登录。</p><div class="school-callout">内容仅保留在本次打开期间；不会自动发送给 AI，也不会提交作业、回复讨论、发送邮件或修改学校信息。共享电脑上请先确认这是你自己的账号。</div><p>数据可能识别不完整，请与学校记录核对。只有你主动确认加入计划的课程会保存为本地提醒。</p>`, `${btn('暂不连接', 'close')}${btn('同意并继续', 'consent', `data-source="${source}"`, true)}`);
    modal.schoolConsentAction = callback;
  }
  async function sync(source, { force = true, weekStart = state.week } = {}) {
    if (state.busy.has(source)) return;
    if (force) authBlocked.delete(source);
    const request = ++state.syncIds[source];
    state.busy.add(source); state.error = ''; if (force) state.notice = ''; render();
    try {
      const snapshot = await api().sync(source, { weekStart, force });
      if (request !== state.syncIds[source]) return;
      mergeSnapshot(snapshot, source === 'edupage' ? weekStart : '');
      if (force) state.notice = source === 'edupage' ? '课表已同步。请核对教学组、日期与教室。' : '课程与作业已同步。';
      authBlocked.delete(source);
    } catch (error) {
      if (request !== state.syncIds[source]) return;
      state.error = userError(error, '同步失败，请重新登录后重试');
      if (/登录|账号|密码|验证码|验证/.test(state.error)) authBlocked.add(source);
      // The main process retains same-account verified data on transient failures.
      // Read it back so stale content remains visible rather than being replaced by an empty state.
      try {
        const retained = await api().get({ source, weekStart });
        if (request !== state.syncIds[source]) return;
        mergeSnapshot(retained, source === 'edupage' ? weekStart : '');
      } catch {}
    } finally {
      if (request === state.syncIds[source]) { state.busy.delete(source); render(); }
    }
  }
  async function loadWeek(weekStart, { allowRefresh = true } = {}) {
    const request = ++state.refreshId;
    try {
      const snapshot = await api().get({ source: 'edupage', weekStart });
      if (request !== state.refreshId) return;
      mergeSnapshot(snapshot, weekStart);
      render();
      if (allowRefresh && prefs().autoSync && autoApproved('edupage') && visible() && isStale('edupage')) sync('edupage', { force: false, weekStart });
    } catch (error) {
      if (request !== state.refreshId) return;
      state.error = userError(error, '无法读取这一周的课表'); render();
    }
  }
  function autoRefresh(source = activeSource()) {
    if (authBlocked.has(source) || !prefs().autoSync || !visible() || !autoApproved(source) || state.busy.has(source) || !isStale(source)) return;
    sync(source, { force: false, weekStart: state.week });
  }
  function autoConsentDialog() {
    showDialog('开启自动更新课表与课程', '<p>开启后，PH Launcher 会在你正在查看“课表与课程”且窗口可见时，按需读取已登录的 EduPage 与 ManageBac 内容；课表最短 2 分钟、课程与作业最短 3 分钟才会再次检查，并每 5 分钟进行一次可见性检查。</p><div class="school-callout">数据仅保留在本次打开期间，不会发送给 AI，也不会提交作业、发送邮件或修改学校信息。你可随时关闭此选项。</div><p>若希望网站在下次打开时保留登录状态，可在“设置 → 网站”中单独选择保存，自动更新不会替你保存密码。</p>', `${btn('暂不开启', 'close')}${btn('同意并开启', 'auto-sync-consent', '', true)}`);
  }
  function teachingGroupInference(data) {
    const infer = window.schoolSelectionInference?.inferTeachingGroups;
    if (typeof infer !== 'function') return { status: 'none', keys: [], ambiguous: [], unmatched: [] };
    return infer({
      options: (data.options || []).map(option => ({ ...option, course: option.course || option.label?.split(' · ')[0], teacher: option.teacher || data.lessons?.find(lesson => lesson.groupKey === option.key)?.teacher || '' })),
      enrolledCourses: state.snapshot.managebac?.courses || [],
      authoritativeKeys: data.personalGroupKeys || [],
      authoritativeSource: data.personalGroupSource || '',
    });
  }
  function groupsDialog(autoRecognize = false) {
    const data = currentWeek(); if (!data) return;
    if (autoRecognize && !state.snapshot.managebac?.courses?.length) {
      showDialog('自动识别选课', '<p>请先同步 ManageBac 的已选课程，再识别对应的教学组。</p>', `${btn('取消', 'close')}${btn('同步我的课程', 'auto-sync-courses', '', true)}`);
      return;
    }
    const selected = selections() || [];
    const inference = teachingGroupInference(data);
    const automatic = inference.status === 'automatic';
    const family = window.schoolSelectionInference?.subjectKey || (value => value);
    const chosenSubjects = new Set(data.options.filter(option => selected.includes(option.key)).map(option => family(option.course || option.label.split(' · ')[0])));
    const inferred = automatic ? inference.keys : autoRecognize ? inference.keys.filter(key => {
      const option = data.options.find(item => item.key === key);
      return option && !chosenSubjects.has(family(option.course || option.label.split(' · ')[0]));
    }) : [];
    const autoNote = `<div class="school-callout"><p>已自动勾选能够唯一匹配的教学组，保留你原有的选择。请核对两个网站登录的是同一位学生，确认后保存。</p>${inference.ambiguous.length ? `<p>以下课程有多个可能的教学组，请确认老师或组号：</p><ul>${inference.ambiguous.map(name => `<li>${esc(name)}</li>`).join('')}</ul>` : ''}${inference.unmatched.length ? `<p>以下课程暂未匹配，请手动补充：</p><ul>${inference.unmatched.map(name => `<li>${esc(name)}</li>`).join('')}</ul>` : ''}</div>`;
    const inferenceNote = autoRecognize ? autoNote : automatic
      ? '<div class="school-success">已从当前账号明确的个人选课记录中识别教学组，请保存前核对。</div>'
      : inference.status === 'suggestion'
        ? `<div class="school-callout">ManageBac 课程名称唯一匹配到 ${inference.keys.length} 个教学组，但课程名称不是个人选课证明。${btn('勾选这些建议', 'apply-group-suggestions')}</div>`
        : '<div class="school-callout">当前授权数据没有明确的个人教学组名单。请按老师、教学组和上课时间人工确认。</div>';
    const subjects = [...new Set(data.options.map((option) => option.course || option.label.split(' · ')[0]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    showDialog('选择自己的教学组', `<p>只勾选你实际参加的课程组。相似课名可能对应不同老师或不同时间。</p>${inferenceNote}<div class="school-group-filters"><input type="search" data-school-field="group-query" placeholder="搜索课程、教学组或老师" aria-label="搜索教学组"><select data-school-field="group-subject" aria-label="按科目筛选"><option value="">全部科目</option>${subjects.map((subject) => `<option value="${esc(subject)}">${esc(subject)}</option>`).join('')}</select></div><div class="school-group-tools"><span class="school-group-count" role="status"></span><button type="button" class="school-text-button" data-school-action="groups-all">勾选当前结果</button><button type="button" class="school-text-button" data-school-action="groups-none">清空当前结果</button></div><div class="school-group-list">${data.options.map((option) => { const subject = option.course || option.label.split(' · ')[0]; const roomLine = (option.rooms || []).filter(Boolean).join('、'); const timeLine = (option.times || []).filter(Boolean).join('、'); const meta = [roomLine && `教室：${roomLine}`, timeLine && `时间：${timeLine}`].filter(Boolean); return `<label data-school-group-option data-subject="${esc(subject)}" data-search="${esc([option.label,roomLine,timeLine].filter(Boolean).join(" ").toLocaleLowerCase())}"><input type="checkbox" name="school-group" value="${esc(option.key)}" ${selected.includes(option.key) || inferred.includes(option.key) ? 'checked' : ''}/><span>${esc(option.label)}${meta.length ? `<small class="school-group-meta">${esc(meta.join(' · '))}</small>` : ''}</span></label>`; }).join('')}</div><p class="school-group-no-results" hidden>没有符合条件的教学组。</p>`, `${btn('取消', 'close')}${btn('保存选择', 'save-groups', '', true)}`);
    modal.schoolGroupAccount = data.accountKey;
    modal.schoolGroupEpochs = JSON.stringify(state.epochs);
    filterGroupOptions();
  }
  function filterGroupOptions() {
    if (!modal?.open) return;
    const query = (modal.querySelector('[data-school-field="group-query"]')?.value || '').trim().toLocaleLowerCase();
    const subject = modal.querySelector('[data-school-field="group-subject"]')?.value || '';
    let visibleCount = 0;
    for (const option of modal.querySelectorAll('[data-school-group-option]')) {
      option.hidden = Boolean((query && !option.dataset.search.includes(query)) || (subject && option.dataset.subject !== subject));
      if (!option.hidden) visibleCount += 1;
    }
    const chosen = modal.querySelectorAll('[name="school-group"]:checked').length;
    const status = modal.querySelector('.school-group-count');
    if (status) status.textContent = `显示 ${visibleCount} 项 · 已选 ${chosen} 项`;
    const empty = modal.querySelector('.school-group-no-results'); if (empty) empty.hidden = visibleCount !== 0;
  }
  function onModalField(event) {
    if (['group-query', 'group-subject'].includes(event.target.dataset.schoolField) || event.target.name === 'school-group') filterGroupOptions();
  }
  async function savePreferences(change) { mergeSnapshot(await api().preferences(change)); render(); }
  async function original(url) {
    if (!/^https:\/\/(?:shph\.managebac\.cn|pingheschool\.edupage\.org)(?:\/|$)/.test(url)) throw new Error('原网页地址无效');
    modal?.close();
    if (window.ph.school.openUrl) {
      const site = new URL(url).hostname === 'shph.managebac.cn' ? 'managebac' : 'edupage';
      await window.openSite(site);
      await window.ph.school.openUrl(url);
    } else await window.ph.system.openUrl(url);
  }
  async function loadDetail(title, action, source = 'managebac') {
    showDialog(title, '<p role="status">正在读取，请稍候…</p>');
    const token = Symbol('detail'); modal.schoolLoadToken = token;
    try { const body = await action(); if (!modal.open || modal.schoolLoadToken !== token) return; showDialog(title, body); }
    catch (error) { if (modal.open && modal.schoolLoadToken === token) showDialog(title, `<div class="school-error" role="alert">${esc(userError(error, '读取失败'))}</div>${btn('登录学校账号', 'account', `data-site="${source}"`)}`); }
  }
  function originalButton(url) { return url ? btn('在原网页查看', 'original', `data-url="${esc(url)}"`) : ''; }
  function attachmentRows(items) {
    return (items || []).map((item) => `<div class="school-file-row"><span>${esc(item.name)}</span>${item.url ? btn('打开附件', 'original', `data-url="${esc(item.url)}"`) : ''}</div>`).join('');
  }
  function discussionList(data) {
    return `<div class="school-discussion-list">${data.discussions.map((item) => `<button type="button" class="school-discussion-row" data-school-action="discussion" data-course="${esc(data.courseId)}" data-id="${esc(item.id)}"><strong>${esc(item.title)}</strong><span>${esc([item.author, item.category].filter(Boolean).join(' · ') || '作者未提供')}</span>${item.preview ? `<p>${esc(item.preview)}</p>` : ''}${item.attachments?.length ? `<small>${item.attachments.length} 个附件</small>` : ''}</button>`).join('') || '<p>这门课程暂时没有讨论。</p>'}</div><div class="school-dialog-actions">${originalButton(data.url)}</div><p class="school-footnote">这里只读展示讨论；回复请在 ManageBac 原网页完成，附件仅在你点击后打开。</p>`;
  }
  function discussionDetail(data) {
    const post = (item, label) => item ? `<article class="school-discussion-post"><div class="school-detail-meta"><strong>${esc(label)}</strong><span>${esc([item.author, item.category, item.date].filter(Boolean).join(' · ') || '发布信息未提供')}</span></div><p class="school-prewrap">${esc(item.body || '正文为空')}</p>${attachmentRows(item.attachments)}</article>` : '';
    return `<h2>${esc(data.title)}</h2>${post(data.main, '主题帖')}<h4>回复 ${data.comments.length}</h4>${data.comments.map((item, index) => post(item, item.private ? `私密回复 ${index + 1}` : `回复 ${index + 1}`)).join('') || '<p>暂时没有回复。</p>'}<div class="school-dialog-actions">${originalButton(data.url)}</div><p class="school-footnote">只读展示，不会提交回复；附件仅在你点击后打开。</p>`;
  }
  async function onClick(event) {
    const button = event.target.closest('[data-school-action]'); if (!button || button.disabled) return;
    const action = button.dataset.schoolAction;
    try {
      if (action === 'close') modal?.close();
      if (action === 'account') { modal?.close(); window.openSchoolAccount(button.dataset.site); }
      if (action === 'connect') consent(button.dataset.source, () => connect(button.dataset.source, { approved: true }));
      if (action === 'course-tab') { state.courseTab = button.dataset.courseTab; state.error = ''; state.notice = ''; render(); autoRefresh(); }
      if (action === 'login') { modal?.close(); await window.openSite(button.dataset.site); }
      if (action === 'sync') consent(button.dataset.source, () => sync(button.dataset.source));
      if (action === 'consent') { const callback = modal.schoolConsentAction; state.consent.add(button.dataset.source); modal.close(); if (callback) callback(); }
      if (action === 'auto-sync') { if (prefs().autoSync) await savePreferences({ autoSync: false }); else { autoConsentDialog(); render(); } }
      if (action === 'auto-sync-consent') { modal?.close(); state.consent.add('edupage'); state.consent.add('managebac'); await savePreferences({ autoSync: true }); autoRefresh(); }
      if (action === 'week') { if (state.busy.has('edupage')) return; const delta = Number(button.dataset.delta); state.week = delta ? shift(state.week, delta) : monday(); state.notice = ''; render(); loadWeek(state.week); }
      if (action === 'toggle-weekend') { state.showWeekend = !state.showWeekend; render(); }
      if (action === 'groups') groupsDialog();
      if (action === 'auto-groups') groupsDialog(true);
      if (action === 'auto-sync-courses') consent('managebac', async () => {
        modal?.close(); await sync('managebac');
        if (!state.error && state.snapshot.managebac?.courses?.length) groupsDialog(true);
      });
      if (action === 'apply-group-suggestions') { const inference = teachingGroupInference(currentWeek()); modal.querySelectorAll('[name="school-group"]').forEach((input) => { if (inference.keys.includes(input.value)) { input.checked = true; input.setAttribute('checked', ''); } }); filterGroupOptions(); }
      if (action === 'groups-all' || action === 'groups-none') { modal.querySelectorAll('[data-school-group-option]').forEach((option) => { if (!option.hasAttribute('hidden')) { const input = option.querySelector('[name="school-group"]'); input.checked = action === 'groups-all'; input.toggleAttribute('checked', action === 'groups-all'); } }); filterGroupOptions(); }
      if (action === 'save-groups') {
        if (currentWeek()?.accountKey !== modal.schoolGroupAccount || JSON.stringify(state.epochs) !== modal.schoolGroupEpochs) {
          modal.close(); state.error = '学校账号已变化，请重新识别选课。'; render(); return;
        }
        button.disabled = true; await savePreferences({ groups: [...modal.querySelectorAll('[name="school-group"]:checked')].map((input) => input.value) }); modal.close();
      }
      if (action === 'course-reminder') {
        const value = prefs().courseReminderMinutes;
        showDialog('上课提醒', `<p>只提醒当前账号、你已选择的教学组中的课程；班级课表和未选择的教学组不会触发提醒。</p><div class="school-actions">${[[null, '不提醒'], [0, '准时提醒'], [5, '提前 5 分钟'], [10, '提前 10 分钟'], [15, '提前 15 分钟'], [30, '提前 30 分钟'], [60, '提前 60 分钟']].map(([minutes, label]) => btn(label, 'save-course-reminder', `data-minutes="${minutes === null ? '' : minutes}" ${value === minutes ? 'aria-pressed="true"' : ''}`, value === minutes)).join('')}</div><p class="school-footnote">此设置只影响学校个人课表，不会更改日程提醒或手动计划中的已有提醒。</p>`);
      }
      if (action === 'save-course-reminder') { button.disabled = true; const raw = button.dataset.minutes; await savePreferences({ courseReminderMinutes: raw === '' ? null : Number(raw) }); modal.close(); state.notice = '上课提醒设置已保存。'; render(); }
      if (action === 'import-plan') {
        const lessons = selectedLessons().filter((lesson) => !lesson.cancelled);
        showDialog('确认加入课程提醒', `<p>将 ${state.week} 至 ${shift(state.week, 6)} 的 <strong>${lessons.length} 节课程</strong>加入本地计划。仅对具体日期生效，不会变成每周重复课程。</p><p>本次同步会更新同一账号在这些日期的已导入课程；手工创建的课程会保留。</p><div class="school-import-preview">${lessons.map((lesson) => `<div><time>${lesson.date} ${lesson.start}–${lesson.end}</time><strong>${esc(lesson.course)}</strong><span>${esc(lesson.room)}</span></div>`).join('')}</div>${warnings(currentWeek())}`, `${btn('取消', 'close')}${btn('核对无误，加入计划', 'confirm-import', '', true)}`);
      }
      if (action === 'confirm-import') { button.disabled = true; const result = await api().importPlan(); modal.close(); state.notice = `已将 ${result.added} 节具体日期的课程加入计划。`; render(); }
      if (action === 'lesson') {
        const lesson = groupLessons(displayedLessons()).find((item) => item.id === button.dataset.id); if (!lesson) return;
        showDialog(lesson.course, `<div class="school-lesson-detail school-color-${color(lesson.groupKey)}"><strong>${lesson.date} · ${lesson.start}–${lesson.end}</strong><p>${esc(lesson.room || '教室未提供')} · ${esc(lesson.teacher || '老师未提供')}</p><p>${esc(lesson.groups.join(' / ') || '教学组未提供')}</p>${lesson.cancelled ? '<p>这节课程已取消，不会导入提醒。</p>' : ''}</div>`, `${btn((prefs().highlights || []).includes(lesson.groupKey) ? '取消重点标记' : '标记这个教学组', 'highlight', `data-key="${esc(lesson.groupKey)}"`)}${btn('打开 EduPage', 'login', 'data-site="edupage"')}`);
      }
      if (action === 'lesson-cluster') {
        const items = groupLessons(displayedLessons()).filter((item) => item.date === button.dataset.date && item.start < button.dataset.end && item.end > button.dataset.start);
        if (items.length < 3) return;
        showDialog(`${items.length} 门冲突课程`, `<p>这些课程时间重叠。请逐项核对教学组、教室与老师。</p><div class="school-conflict-list">${items.map((item) => `<button type="button" class="school-conflict-row school-color-${color(item.groupKey)} ${(prefs().highlights || []).includes(item.groupKey) ? 'is-highlighted' : ''} ${item.cancelled ? 'is-cancelled' : ''}" data-school-action="lesson" data-id="${esc(item.id)}"><strong>${esc(item.course)}</strong><span>${esc(`${item.start}–${item.end} · ${item.room || '教室未提供'}`)}</span><span>${esc([item.teacher, item.groups.join(' / ')].filter(Boolean).join(' · ') || '教学组未提供')}</span>${item.count > 1 ? `<small>${item.count} 节连堂</small>` : ''}</button>`).join('')}</div>`);
      }
      if (action === 'highlight') { const keys = new Set(prefs().highlights || []); keys.has(button.dataset.key) ? keys.delete(button.dataset.key) : keys.add(button.dataset.key); await savePreferences({ highlights: [...keys] }); modal.close(); }
      if (action === 'toggle-hidden') { state.showHidden = !state.showHidden; render(); }
      if (action === 'hide-task') { const ids = new Set(prefs().hiddenTasks || []); ids.has(button.dataset.id) ? ids.delete(button.dataset.id) : ids.add(button.dataset.id); await savePreferences({ hiddenTasks: [...ids] }); }
      if (action === 'original') await original(button.dataset.url);
      if (action === 'course') consent('managebac', () => loadDetail('课程详情', async () => {
        const data = await api().course(button.dataset.id);
        return `<h2>${esc(data.name || state.snapshot.managebac?.courses.find((course) => course.id === data.id)?.name || '课程')}</h2><div class="school-detail-meta"><span>总评：${esc(data.grade || '暂未读取到')}</span>${originalButton(data.url)}</div><div class="school-discussion-entry"><div><strong>课程讨论</strong><span>查看主题帖、回复与附件</span></div>${btn('查看讨论', 'course-discussions', `data-course="${esc(data.id)}"`, true)}</div>${data.units ? `<h4>单元与计划</h4><p class="school-prewrap">${esc(data.units)}</p>` : ''}<h4>课程作业</h4>${taskRows(data.tasks, true) || '<p>暂未识别到作业。</p>'}<h4>课程文件</h4>${data.files.map((file) => `<div class="school-file-row"><span>${esc(file.name)}</span>${originalButton(file.url)}</div>`).join('') || '<p>暂未识别到文件。</p>'}<h4>课程日历</h4>${data.events.map((item) => `<p>${esc(item.start)} · ${esc(item.title)}</p>`).join('') || '<p>暂未识别到日历事项。</p>'}${warnings(data)}`;
      }));
      if (action === 'course-discussions') consent('managebac', () => loadDetail('课程讨论', async () => discussionList(await api().discussions(button.dataset.course))));
      if (action === 'discussion') consent('managebac', () => loadDetail('讨论详情', async () => discussionDetail(await api().discussion(button.dataset.course, button.dataset.id))));
      if (action === 'task') consent('managebac', () => loadDetail('作业详情', async () => {
        const data = await api().task(button.dataset.course, button.dataset.id);
        return `<h2>${esc(data.title)}</h2><div class="school-detail-meta"><span>${esc(data.dueAt ? stamp(data.dueAt) : data.dueText || '截止时间未提供')}</span><span>${esc(data.status)}</span>${data.score ? `<span>${esc(data.score)}</span>` : ''}</div><p class="school-prewrap">${esc(data.description || '请在原网页查看作业要求。')}</p>${originalButton(data.url)}<p class="school-footnote">提交与附件操作请在原网页完成。</p>`;
      }));
      if (action === 'core') consent('managebac', () => loadDetail(button.dataset.kind.toUpperCase(), async () => {
        const data = await api().ibOverview(button.dataset.kind);
        return `<h2>${esc(data.title)}</h2>${data.sections.map((section) => `<p class="school-prewrap">${esc(section)}</p>`).join('')}${originalButton(data.url)}`;
      }));
    } catch (error) {
      const message = userError(error, '操作没有完成，请重试');
      if (modal?.open) { const alert = document.createElement('p'); alert.className = 'school-error'; alert.setAttribute('role', 'alert'); alert.textContent = message; modal.querySelector('.school-dialog-content').append(alert); button.disabled = false; }
      else { state.error = message; render(); }
    }
  }
  async function refresh() {
    if (!root) return;
    const id = ++state.refreshId;
    const requestedWeek = state.week;
    try { const snapshot = await api().get({ weekStart: requestedWeek }); if (id !== state.refreshId) return; mergeSnapshot(snapshot, requestedWeek); render(); autoRefresh(); }
    catch (error) { state.error = userError(error, '无法读取学校工作台'); render(); }
  }
  function normalizeRoute(route) {
    return ['timetable', 'class-timetable', 'courses'].includes(route) ? route : 'timetable';
  }
  // Drag-to-reorder for the course list. The order is stored locally in the
  // school preferences so it survives re-syncs, and the animation is pure CSS.
  function bindCourseDrag() {
    let draggingId = '';
    const clearMarkers = () => root.querySelectorAll('.is-drop-before, .is-drop-after').forEach((node) => node.classList.remove('is-drop-before', 'is-drop-after'));
    root.addEventListener('dragstart', (event) => {
      const card = event.target.closest?.('[data-school-drag]');
      if (!card) return;
      draggingId = card.dataset.id || '';
      card.classList.add('is-dragging');
      if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; try { event.dataTransfer.setData('text/plain', draggingId); } catch {} }
    });
    root.addEventListener('dragover', (event) => {
      const card = event.target.closest?.('[data-school-drag]');
      if (!card || !draggingId) return;
      event.preventDefault();
      clearMarkers();
      if (card.dataset.id === draggingId) return;
      const rect = card.getBoundingClientRect();
      card.classList.add(event.clientY > rect.top + rect.height / 2 ? 'is-drop-after' : 'is-drop-before');
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    });
    root.addEventListener('drop', (event) => {
      const card = event.target.closest?.('[data-school-drag]');
      if (!card || !draggingId || card.dataset.id === draggingId) { clearMarkers(); return; }
      event.preventDefault();
      const rect = card.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      const current = [...root.querySelectorAll('[data-school-drag]')].map((node) => node.dataset.id);
      const next = window.courseOrder?.move(current, draggingId, card.dataset.id, after) || current;
      clearMarkers();
      draggingId = '';
      state.courseSort = 'manual';
      // Paint the new order immediately, then persist it in the background.
      const grid = root.querySelector('.school-course-grid');
      if (grid) {
        const cards = [...grid.querySelectorAll('[data-school-drag]')];
        for (const id of next) { const node = cards.find((card) => card.dataset.id === id); if (node) grid.append(node); }
      }
      savePreferences({ courseOrder: next }).catch(() => { state.error = '课程顺序未能保存，下次打开会恢复默认顺序'; render(); });
    });
    root.addEventListener('dragend', () => { draggingId = ''; clearMarkers(); root.querySelectorAll('.is-dragging').forEach((node) => node.classList.remove('is-dragging')); });
  }

  function mount() {
    if (root) return;
    root = document.getElementById('schoolPage'); if (!root) return;
    root.addEventListener('click', onClick);
    root.addEventListener('change', (event) => {
      const field = event.target.dataset.schoolField;
      if (field === 'course-sort') state.courseSort = event.target.value;
      if (field === 'task-sort') state.taskSort = event.target.value;
      if (field) render();
    });
    root.addEventListener('input', (event) => {
      if (event.target.dataset.schoolField !== 'query') return;
      const position = event.target.selectionStart; state.query = event.target.value; render();
      const input = root.querySelector('[data-school-field="query"]'); input?.focus(); if (input && typeof position === 'number') try { input.setSelectionRange(position, position); } catch {}
    });
    bindCourseDrag();
    setInterval(updateTimeLine, 30000);
    state.autoTimer = setInterval(() => autoRefresh(), 300000);
    document.addEventListener('visibilitychange', () => autoRefresh());
    render(); refresh();
  }
  function open(route = 'timetable') {
    const next = normalizeRoute(route);
    const changed = state.route !== next;
    state.route = next;
    const alreadyMounted = Boolean(root);
    mount();
    if (alreadyMounted) {
      if (changed) { state.error = ''; state.notice = ''; }
      // Returning from a website or settings may have changed accounts, even
      // when the route is unchanged. Reconcile authoritative local epochs
      // before rendering or starting any optional network refresh.
      root.textContent = '正在读取本地记录…';
      return refresh();
    }
  }
  async function connect(source, { approved = false } = {}) {
    if (!['edupage', 'managebac'].includes(source) || !approved || state.busy.has(source)) return false;
    state.consent.add(source);
    state.busy.add(source); state.error = ''; state.notice = ''; authBlocked.delete(source);
    const requestedWeek = state.week;
    const request = ++state.syncIds[source];
    state.route = source === 'edupage' ? 'timetable' : 'courses';
    window.navigate?.(state.route);
    mount(); render();
    try {
      const result = await api().login(source, { weekStart: requestedWeek });
      if (request !== state.syncIds[source]) return false;
      mergeSnapshot(result.snapshot, source === 'edupage' ? requestedWeek : '');
      if (!result.ok) {
        state.error = userError(result.error, '登录未完成，请检查账号设置');
        authBlocked.add(source);
        return false;
      }
      state.notice = source === 'edupage' ? '已登录并同步课表，请选择自己的教学组。' : '已登录并同步课程与作业。';
      return true;
    } catch (error) {
      state.error = userError(error, '登录未完成，请稍后重试'); authBlocked.add(source); return false;
    } finally { if (request === state.syncIds[source]) { state.busy.delete(source); render(); } }
  }
  window.schoolUI = { mount, open, refresh, connect };
})();

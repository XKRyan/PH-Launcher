(() => {
  'use strict';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const localDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const shift = (date, amount) => new Date(Date.parse(`${date}T12:00:00Z`) + amount * 86400000).toISOString().slice(0, 10);
  const monday = () => { const date = localDate(); return shift(date, -(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7); };
  const minutes = (time) => { const [h, m] = String(time).split(':').map(Number); return h * 60 + m; };
  const timeLabel = (value) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  const stamp = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const color = (key) => [...String(key)].reduce((total, char) => (total * 31 + char.charCodeAt(0)) >>> 0, 0) % 6;
  const state = { snapshot: { edupage: null, managebac: null, preferences: {} }, tab: 'timetable', week: monday(), classView: false, busy: new Set(), error: '', notice: '', query: '', courseSort: 'name', taskSort: 'due', showHidden: false, consent: new Set(), refreshId: 0 };
  let root;
  let modal;
  const api = () => window.ph.school;
  const prefs = () => state.snapshot.preferences || {};
  const currentWeek = () => state.snapshot.edupage?.weekStart === state.week ? state.snapshot.edupage : null;
  const selections = () => { const data = currentWeek(); return data && prefs().accountKey === data.accountKey && Array.isArray(prefs().groups) ? prefs().groups : null; };
  const selectedLessons = () => { const data = currentWeek(); const selected = selections(); return (data?.lessons || []).filter((lesson) => selected === null || selected.includes(lesson.groupKey)); };
  const displayedLessons = () => state.classView ? currentWeek()?.lessons || [] : selectedLessons();
  const btn = (label, action, extra = '', primary = false) => `<button type="button" class="${primary ? 'primary-button' : 'secondary-button'}" data-school-action="${action}" ${extra}>${esc(label)}</button>`;
  const noData = (title, description, site) => `<div class="school-empty"><span class="school-empty-symbol" aria-hidden="true">${site === 'edupage' ? '▦' : '▤'}</span><h3>${esc(title)}</h3><p>${esc(description)}</p><div class="school-actions">${btn('打开原网页登录', 'login', `data-site="${site}"`)}${btn('我已登录，开始同步', 'sync', `data-source="${site}" ${state.busy.has(site) ? 'disabled' : ''}`, true)}</div><small>只读取你有权查看的内容，不会向学校提交任何更改。</small></div>`;
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
  function timetable() {
    const data = currentWeek();
    const start = state.week;
    const toolbar = `<div class="school-section-head"><div><span class="section-kicker">YOUR WEEK</span><h2>${data?.className ? esc(data.className) : '我的课表'}</h2></div><div class="school-actions">${btn('上一周', 'week', 'data-delta="-7" aria-label="上一周"')}${btn('本周', 'week', 'data-delta="0"')}${btn('下一周', 'week', 'data-delta="7" aria-label="下一周"')}</div></div><div class="school-weekbar"><strong>${esc(start)} — ${esc(shift(start, 6))}</strong><div class="school-actions">${data ? btn('选择教学组', 'groups') : ''}${data ? btn('加入课程提醒', 'import-plan', `${selections()?.length && selectedLessons().some((lesson) => !lesson.cancelled) ? '' : 'disabled'}`) : ''}${btn(state.busy.has('edupage') ? '正在同步…' : '刷新课表', 'sync', `data-source="edupage" ${state.busy.has('edupage') ? 'disabled' : ''}`, true)}</div></div>`;
    if (!data) return toolbar + noData('把一周安排放在眼前', state.snapshot.edupage ? '当前周尚未同步。刷新后可查看具体日期的课程、教室与调课情况。' : '先登录 EduPage，再读取本周课表。首次同步后，选择你自己的教学组。', 'edupage');
    const selected = selections();
    const lessons = groupLessons(displayedLessons());
    const selectionNotice = `<div class="school-view-switch">${btn(state.classView ? '切回我的课表' : '查看本班全部教学组', 'class-view')}<span>${state.classView ? '班级课表：展示当前账号所属班级的全部可见教学组' : '个人课表：只显示你选择的教学组'}</span></div>` + (state.classView ? `<div class="school-meta">当前是班级视图 · 课程提醒仍只使用你的教学组选择 · 同步于 ${esc(stamp(data.fetchedAt))}</div>` : selected === null ? '<div class="school-callout">当前展示班级可选课程，尚不是你的个人课表。请先选择自己的教学组。</div>' : `<div class="school-meta">已选择 ${selected.length} 个教学组 · ${selectedLessons().filter((lesson) => !lesson.cancelled).length} 节有效课程 · 同步于 ${esc(stamp(data.fetchedAt))}</div>`);
    const minTime = Math.min(8 * 60, ...lessons.map((lesson) => minutes(lesson.start)));
    const maxTime = Math.max(17 * 60, ...lessons.map((lesson) => minutes(lesson.end)));
    const floor = Math.floor(minTime / 60) * 60;
    const height = (maxTime - floor + 15) * 1.8;
    const labels = [];
    for (let value = floor; value <= maxTime; value += 60) labels.push(`<span class="school-axis-time" style="top:${(value - floor) * 1.8}px">${timeLabel(value)}</span>`);
    const today = localDate();
    const header = `<div class="school-grid-header"><span class="school-zone">上海时间</span>${days.map((day, index) => `<div class="${shift(start, index) === today ? 'is-today' : ''}"><strong>${day}</strong><span>${shift(start, index).slice(5)}</span></div>`).join('')}</div>`;
    const grid = `<div class="school-timetable-scroll"><div class="school-timetable">${header}<div class="school-grid-body" style="height:${height}px"><div class="school-time-axis">${labels.join('')}</div>${days.map((day, index) => {
      const date = shift(start, index);
      const dayLessons = positionLessons(lessons.filter((lesson) => lesson.date === date));
      const missing = data.missingDates?.includes(date);
      return `<div class="school-day-column ${date === today ? 'is-today' : ''}" data-date="${date}" data-floor="${floor}" data-ceiling="${maxTime}">${labels.map((_, i) => `<div class="school-hour-line" style="top:${i * 108}px"></div>`).join('')}${missing ? '<p class="school-day-empty">未能同步<br>请查原网页</p>' : !dayLessons.length ? `<p class="school-day-empty">${selected?.length === 0 ? '未选择教学组' : '未识别到课程'}</p>` : ''}${dayLessons.map((lesson) => `<button type="button" class="school-lesson school-color-${color(lesson.groupKey)} ${lesson.cancelled ? 'is-cancelled' : ''} ${(prefs().highlights || []).includes(lesson.groupKey) ? 'is-highlighted' : ''}" data-school-action="lesson" data-id="${esc(lesson.id)}" style="top:${(minutes(lesson.start) - floor) * 1.8 + 3}px;height:${Math.max(44, (minutes(lesson.end) - minutes(lesson.start)) * 1.8 - 6)}px;left:calc(${lesson.lane * 100 / lesson.lanes}% + 3px);width:calc(${100 / lesson.lanes}% - 6px)" title="${esc([lesson.course, `${lesson.start}–${lesson.end}`, lesson.room, lesson.teacher, lesson.groups.join(' / ')].filter(Boolean).join(' · '))}"><span class="school-lesson-time">${lesson.start}–${lesson.end}${lesson.count > 1 ? ` · ${lesson.count} 节连堂` : ''}</span><strong>${esc(lesson.course)}</strong><span>${esc(lesson.room)}${lesson.teacher ? ` · ${esc(lesson.teacher)}` : ''}</span>${lesson.cancelled ? '<b class="school-cancel-label">已取消</b>' : ''}</button>`).join('')}<div class="school-now-line" hidden aria-label="当前时间"></div></div>`;
    }).join('')}</div></div></div>`;
    return toolbar + selectionNotice + grid + warnings(data) + '<p class="school-footnote">点击课程可查看详情、标记重点。不同教学组使用固定颜色；临时调课与停课请以 EduPage 原网页为准。</p>';
  }

  function courses() {
    const data = state.snapshot.managebac;
    if (!data) return noData('课程、成绩和作业，一处查看', '登录 ManageBac 后同步课程。成绩保留网站原始表述，不推算 GPA。', 'managebac');
    let items = [...data.courses];
    items.sort((a, b) => state.courseSort === 'grade' ? String(b.grade || '').localeCompare(String(a.grade || ''), 'zh-CN', { numeric: true }) || a.name.localeCompare(b.name) : a.name.localeCompare(b.name, 'zh-CN'));
    return `<div class="school-section-head"><div><span class="section-kicker">MY COURSES</span><h2>${items.length} 门课程</h2></div><label class="school-inline-label">排序<select data-school-field="course-sort"><option value="name" ${state.courseSort === 'name' ? 'selected' : ''}>课程名称</option><option value="grade" ${state.courseSort === 'grade' ? 'selected' : ''}>总评原文</option></select></label></div><div class="school-course-grid">${items.map((course) => `<button class="school-course-card school-color-${color(course.id)}" type="button" data-school-action="course" data-id="${esc(course.id)}"><span class="school-course-mark" aria-hidden="true">${esc(course.name.slice(0, 1))}</span><h3>${esc(course.name)}</h3><div><span>总评</span><strong>${course.grade ? esc(course.grade) : '暂未读取到'}</strong></div><small>单元 · 作业 · 文件 · 日历 →</small></button>`).join('')}</div>${items.length ? '' : '<div class="school-empty"><h3>没有识别到课程</h3><p>请在 ManageBac 原网页核对课程列表。</p></div>'}${warnings(data)}`;
  }
  function taskRows(items, compact = false) {
    return items.map((task) => {
      const hidden = (prefs().hiddenTasks || []).includes(task.id);
      return `<article class="school-task-row ${hidden ? 'is-hidden-task' : ''}"><button type="button" class="school-task-main" data-school-action="task" data-course="${esc(task.courseId)}" data-id="${esc(task.id.split(':').at(-1))}"><span class="school-task-course">${esc(task.course || '课程作业')}</span><strong>${esc(task.title)}</strong><span class="school-task-due ${task.pastDue ? 'is-overdue' : ''}">${esc(task.dueAt ? stamp(task.dueAt) : task.dueText || '截止日期请查原网页')}${task.status ? ` · ${esc(task.status)}` : ''}</span></button>${task.score ? `<span class="school-score">${esc(task.score)}</span>` : ''}${compact ? '' : `<button type="button" class="school-text-button" data-school-action="hide-task" data-id="${esc(task.id)}" title="仅更改本地列表，不修改 ManageBac">${hidden ? '恢复' : '隐藏'}</button>`}</article>`;
    }).join('');
  }
  function tasks() {
    const data = state.snapshot.managebac;
    if (!data) return noData('不错过下一项作业', '从 ManageBac 同步作业、截止时间与提交状态。隐藏作业仅影响本地列表。', 'managebac');
    const hidden = new Set(prefs().hiddenTasks || []);
    const query = state.query.toLocaleLowerCase();
    const items = data.tasks.filter((task) => (state.showHidden ? hidden.has(task.id) : !hidden.has(task.id)) && `${task.title} ${task.course}`.toLocaleLowerCase().includes(query));
    items.sort((a, b) => state.taskSort === 'name' ? a.title.localeCompare(b.title, 'zh-CN') : (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity) || a.title.localeCompare(b.title, 'zh-CN'));
    return `<div class="school-section-head"><div><span class="section-kicker">TASKS & DEADLINES</span><h2>${state.showHidden ? '已隐藏' : '课程作业'} <small>${items.length}</small></h2></div><button type="button" class="school-text-button" data-school-action="toggle-hidden">${state.showHidden ? '返回作业列表' : `查看已隐藏 (${data.tasks.filter((task) => hidden.has(task.id)).length})`}</button></div><div class="school-task-filters"><input type="search" value="${esc(state.query)}" data-school-field="query" placeholder="搜索作业或课程" aria-label="搜索作业或课程"/><select data-school-field="task-sort" aria-label="作业排序"><option value="due" ${state.taskSort === 'due' ? 'selected' : ''}>明确截止时间优先</option><option value="name" ${state.taskSort === 'name' ? 'selected' : ''}>作业名称</option></select></div><div class="school-task-list">${taskRows(items) || '<div class="school-empty"><h3>这里暂时没有作业</h3><p>试试其他关键词，或在原网页核对最新安排。</p></div>'}</div><p class="school-footnote">没有完整日期的作业保留原文，不擅自推断年份。点击作业查看详情。隐藏或恢复不会修改学校网站。</p>`;
  }
  function core() {
    return `<div class="school-section-head"><div><span class="section-kicker">IB CORE</span><h2>把长期项目放在心上</h2></div></div><div class="school-core-grid"><article><span class="section-kicker">EXPERIENCES & REFLECTIONS</span><h3>CAS</h3><p>查看活动目标与进度，回到原网页整理证据、完成反思。</p>${btn('读取 CAS 概览', 'core', 'data-kind="cas"', true)}</article><article><span class="section-kicker">EXTENDED ESSAY</span><h3>EE</h3><p>查看论文工作表与项目摘要，让下一步有据可查。</p>${btn('读取 EE 概览', 'core', 'data-kind="ee"', true)}</article></div><div class="school-callout">这些内容不会自动交给 AI，也不会代你提交任何表单。首次使用请先登录 ManageBac。</div>${btn('打开 ManageBac', 'login', 'data-site="managebac"')}`;
  }
  function render() {
    if (!root) return;
    const source = state.tab === 'timetable' ? 'edupage' : 'managebac';
    const data = state.snapshot[source];
    root.innerHTML = `<div class="school-top"><div><span class="section-kicker">PH LAUNCHER × HELLO PINGHE!</span><h1>我的学校</h1><p>一周安排、课程与作业，都有自己的位置。</p></div><div class="school-actions">${btn('EduPage', 'login', 'data-site="edupage"')}${btn('ManageBac', 'login', 'data-site="managebac"')}</div></div><nav class="school-tabs" aria-label="学校工作台"><button type="button" data-school-action="tab" data-tab="timetable" class="${state.tab === 'timetable' ? 'active' : ''}" aria-current="${state.tab === 'timetable' ? 'page' : 'false'}">我的课表</button><button type="button" data-school-action="tab" data-tab="courses" class="${state.tab === 'courses' ? 'active' : ''}">我的课程</button><button type="button" data-school-action="tab" data-tab="tasks" class="${state.tab === 'tasks' ? 'active' : ''}">作业与截止</button><button type="button" data-school-action="tab" data-tab="core" class="${state.tab === 'core' ? 'active' : ''}">CAS / EE</button></nav>${state.error ? `<div class="school-error" role="alert">${esc(state.error)}</div>` : ''}${state.notice ? `<div class="school-success" role="status">${esc(state.notice)}</div>` : ''}${state.busy.size ? '<div class="school-loading" role="status"><span></span>正在读取学校数据，请稍候。你可以继续使用其他本地工具。</div>' : ''}${state.tab !== 'timetable' && data ? `<div class="school-sync-line"><span>最近同步 ${esc(stamp(data.fetchedAt))} · 内容仅在本次打开期间保留</span>${btn(state.busy.has('managebac') ? '正在同步…' : '刷新课程与作业', 'sync', `data-source="managebac" ${state.busy.has('managebac') ? 'disabled' : ''}`)}</div>` : ''}${state.tab === 'timetable' ? timetable() : state.tab === 'courses' ? courses() : state.tab === 'tasks' ? tasks() : core()}<footer class="school-credit">合作整合：PH Launcher · Hello Pinghe! Launcher <span>非学校官方应用</span></footer>`;
    updateTimeLine();
  }
  function updateTimeLine() {
    if (!root) return;
    const now = new Date();
    // All school times are Asia/Shanghai regardless of the device's time zone.
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((part) => [part.type, part.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`; const time = Number(parts.hour) * 60 + Number(parts.minute);
    for (const column of root.querySelectorAll('.school-day-column')) {
      const line = column.querySelector('.school-now-line'); const floor = Number(column.dataset.floor); const ceiling = Number(column.dataset.ceiling);
      line.hidden = column.dataset.date !== date || time < floor || time > ceiling;
      if (!line.hidden) { line.style.top = `${(time - floor) * 1.8}px`; line.setAttribute('aria-label', `当前时间 ${parts.hour}:${parts.minute}`); }
    }
  }
  function showDialog(title, body, footer = '') {
    if (!modal) { modal = document.createElement('dialog'); modal.className = 'modal school-dialog'; document.body.append(modal); modal.addEventListener('click', onClick); modal.addEventListener('close', () => { if (!modal.open) modal.replaceChildren(); }); }
    if (modal.open) modal.close();
    modal.schoolLoadToken = null;
    modal.innerHTML = `<div class="modal-head"><h3>${esc(title)}</h3><button type="button" data-school-action="close" aria-label="关闭">×</button></div><div class="school-dialog-content">${body}</div><div class="school-dialog-footer">${footer || btn('关闭', 'close')}</div>`;
    modal.showModal();
  }
  function consent(source, callback) {
    if (state.consent.has(source)) { callback(); return; }
    showDialog('读取学校数据', `<p>将使用你在内置 ${source === 'edupage' ? 'EduPage' : 'ManageBac'} 中的登录状态，读取${source === 'edupage' ? '所属班级的课程、教学组、任课老师和教室' : '课程、成绩、作业与项目摘要'}。</p><div class="school-callout">内容仅保留在本次打开期间；不会自动发送给 AI，也不会提交作业、发送邮件或修改学校信息。共享电脑上请先确认这是你自己的账号。</div><p>数据可能识别不完整，请与原网页核对。只有你主动确认加入计划的课程会保存为本地提醒。</p>`, `${btn('暂不读取', 'close')}${btn('同意并读取', 'consent', `data-source="${source}"`, true)}`);
    modal.schoolConsentAction = callback;
  }
  async function sync(source) {
    if (state.busy.has(source)) return;
    state.busy.add(source); state.error = ''; state.notice = ''; render();
    const week = state.week;
    try { state.snapshot = await api().sync(source, { weekStart: week }); state.notice = source === 'edupage' ? '课表已同步。请核对教学组、日期与教室。' : '课程与作业已同步。'; }
    catch (error) { state.error = error.message || '同步失败，请重新登录后重试'; try { state.snapshot = await api().get(); } catch {} }
    finally { state.busy.delete(source); render(); }
  }
  function groupsDialog() {
    const data = currentWeek(); if (!data) return;
    const selected = selections() || [];
    showDialog('选择自己的教学组', `<p>勾选你实际参加的课程组。相似课名可能对应不同老师或不同时间；请逐项核对。</p><div class="school-group-tools"><button type="button" class="school-text-button" data-school-action="groups-all">全选</button><button type="button" class="school-text-button" data-school-action="groups-none">清空选择</button></div><div class="school-group-list">${data.options.map((option) => `<label><input type="checkbox" name="school-group" value="${esc(option.key)}" ${selected.includes(option.key) ? 'checked' : ''}/><span>${esc(option.label)}</span></label>`).join('')}</div>`, `${btn('取消', 'close')}${btn('保存选择', 'save-groups', '', true)}`);
  }
  async function savePreferences(change) { state.snapshot = await api().preferences(change); render(); }
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
    catch (error) { if (modal.open && modal.schoolLoadToken === token) showDialog(title, `<div class="school-error" role="alert">${esc(error.message || '读取失败')}</div>${btn('打开原网页登录', 'login', `data-site="${source}"`)}`); }
  }
  function originalButton(url) { return url ? btn('在原网页查看', 'original', `data-url="${esc(url)}"`) : ''; }
  async function onClick(event) {
    const button = event.target.closest('[data-school-action]'); if (!button || button.disabled) return;
    const action = button.dataset.schoolAction;
    try {
      if (action === 'close') modal?.close();
      if (action === 'tab') { state.tab = button.dataset.tab; state.error = ''; state.notice = ''; render(); }
      if (action === 'login') { modal?.close(); await window.openSite(button.dataset.site); }
      if (action === 'sync') consent(button.dataset.source, () => sync(button.dataset.source));
      if (action === 'consent') { const callback = modal.schoolConsentAction; state.consent.add(button.dataset.source); modal.close(); if (callback) callback(); }
      if (action === 'week') { if (state.busy.has('edupage')) return; const delta = Number(button.dataset.delta); state.week = delta ? shift(state.week, delta) : monday(); state.notice = ''; render(); if (state.consent.has('edupage')) sync('edupage'); }
      if (action === 'groups') groupsDialog();
      if (action === 'class-view') { state.classView = !state.classView; render(); }
      if (action === 'groups-all' || action === 'groups-none') modal.querySelectorAll('[name="school-group"]').forEach((input) => { input.checked = action === 'groups-all'; });
      if (action === 'save-groups') { button.disabled = true; await savePreferences({ groups: [...modal.querySelectorAll('[name="school-group"]:checked')].map((input) => input.value) }); modal.close(); }
      if (action === 'import-plan') {
        const lessons = selectedLessons().filter((lesson) => !lesson.cancelled);
        showDialog('确认加入课程提醒', `<p>将 ${state.week} 至 ${shift(state.week, 6)} 的 <strong>${lessons.length} 节课程</strong>加入本地计划。仅对具体日期生效，不会变成每周重复课程。</p><p>本次同步会更新同一账号在这些日期的已导入课程；手工创建的课程会保留。</p><div class="school-import-preview">${lessons.map((lesson) => `<div><time>${lesson.date} ${lesson.start}–${lesson.end}</time><strong>${esc(lesson.course)}</strong><span>${esc(lesson.room)}</span></div>`).join('')}</div>${warnings(currentWeek())}`, `${btn('取消', 'close')}${btn('核对无误，加入计划', 'confirm-import', '', true)}`);
      }
      if (action === 'confirm-import') { button.disabled = true; const result = await api().importPlan(); modal.close(); state.notice = `已将 ${result.added} 节具体日期的课程加入计划。`; render(); }
      if (action === 'lesson') {
        const lesson = groupLessons(displayedLessons()).find((item) => item.id === button.dataset.id); if (!lesson) return;
        showDialog(lesson.course, `<div class="school-lesson-detail school-color-${color(lesson.groupKey)}"><strong>${lesson.date} · ${lesson.start}–${lesson.end}</strong><p>${esc(lesson.room || '教室未提供')} · ${esc(lesson.teacher || '老师未提供')}</p><p>${esc(lesson.groups.join(' / ') || '教学组未提供')}</p>${lesson.cancelled ? '<p>这节课程已取消，不会导入提醒。</p>' : ''}</div>`, `${btn((prefs().highlights || []).includes(lesson.groupKey) ? '取消重点标记' : '标记这个教学组', 'highlight', `data-key="${esc(lesson.groupKey)}"`)}${btn('打开 EduPage', 'login', 'data-site="edupage"')}`);
      }
      if (action === 'highlight') { const keys = new Set(prefs().highlights || []); keys.has(button.dataset.key) ? keys.delete(button.dataset.key) : keys.add(button.dataset.key); await savePreferences({ highlights: [...keys] }); modal.close(); }
      if (action === 'toggle-hidden') { state.showHidden = !state.showHidden; render(); }
      if (action === 'hide-task') { const ids = new Set(prefs().hiddenTasks || []); ids.has(button.dataset.id) ? ids.delete(button.dataset.id) : ids.add(button.dataset.id); await savePreferences({ hiddenTasks: [...ids] }); }
      if (action === 'original') await original(button.dataset.url);
      if (action === 'course') consent('managebac', () => loadDetail('课程详情', async () => {
        const data = await api().course(button.dataset.id);
        return `<h2>${esc(data.name || state.snapshot.managebac?.courses.find((course) => course.id === data.id)?.name || '课程')}</h2><div class="school-detail-meta"><span>总评：${esc(data.grade || '暂未读取到')}</span>${originalButton(data.url)}</div>${data.units ? `<h4>单元与计划</h4><p class="school-prewrap">${esc(data.units)}</p>` : ''}<h4>课程作业</h4>${taskRows(data.tasks, true) || '<p>暂未识别到作业。</p>'}<h4>课程文件</h4>${data.files.map((file) => `<div class="school-file-row"><span>${esc(file.name)}</span>${originalButton(file.url)}</div>`).join('') || '<p>暂未识别到文件。</p>'}<h4>课程日历</h4>${data.events.map((item) => `<p>${esc(item.start)} · ${esc(item.title)}</p>`).join('') || '<p>暂未识别到日历事项。</p>'}${warnings(data)}`;
      }));
      if (action === 'task') consent('managebac', () => loadDetail('作业详情', async () => {
        const data = await api().task(button.dataset.course, button.dataset.id);
        return `<h2>${esc(data.title)}</h2><div class="school-detail-meta"><span>${esc(data.dueAt ? stamp(data.dueAt) : data.dueText || '截止时间未提供')}</span><span>${esc(data.status)}</span>${data.score ? `<span>${esc(data.score)}</span>` : ''}</div><p class="school-prewrap">${esc(data.description || '请在原网页查看作业要求。')}</p>${originalButton(data.url)}<p class="school-footnote">提交与附件操作请在原网页完成。</p>`;
      }));
      if (action === 'core') consent('managebac', () => loadDetail(button.dataset.kind.toUpperCase(), async () => {
        const data = await api().ibOverview(button.dataset.kind);
        return `<h2>${esc(data.title)}</h2>${data.sections.map((section) => `<p class="school-prewrap">${esc(section)}</p>`).join('')}${originalButton(data.url)}`;
      }));
    } catch (error) {
      const message = error.message || '操作没有完成，请重试';
      if (modal?.open) { const alert = document.createElement('p'); alert.className = 'school-error'; alert.setAttribute('role', 'alert'); alert.textContent = message; modal.querySelector('.school-dialog-content').append(alert); button.disabled = false; }
      else { state.error = message; render(); }
    }
  }
  async function refresh() {
    if (!root) return;
    const id = ++state.refreshId;
    try { const snapshot = await api().get(); if (id !== state.refreshId) return; state.snapshot = snapshot; render(); }
    catch (error) { state.error = error.message || '无法读取学校工作台'; render(); }
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
    setInterval(updateTimeLine, 30000);
    render(); refresh();
  }
  window.schoolUI = { mount, refresh };
})();

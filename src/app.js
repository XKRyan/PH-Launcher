const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const SITE_META = {
  mail: { name: '学校邮箱', icon: 'i-mail', url: 'https://mail.shphschool.com/' },
  managebac: { name: 'ManageBac', icon: 'i-grid', url: 'https://shph.managebac.cn/login' },
  edupage: { name: 'EduPage', icon: 'i-calendar', url: 'https://pingheschool.edupage.org/' },
};
const ROUTE_META = {
  today: { title: '今天', eyebrow: 'PH LAUNCHER' },
  plan: { title: '计划', eyebrow: 'PLAN & FOCUS' },
  notes: { title: '笔记', eyebrow: 'LOCAL NOTES' },
  dictionary: { title: '离线词典', eyebrow: 'OFFLINE DICTIONARY' },
  ib: { title: 'IB 工具', eyebrow: 'IB TOOLKIT' },
  ai: { title: 'AI 学习助手', eyebrow: 'OPTIONAL AI' },
  settings: { title: '设置', eyebrow: 'PREFERENCES' },
};
const SUBJECTS = ['通用', 'English', 'Chinese', 'Math', 'Physics', 'Chemistry', 'Biology', 'Economics', 'Humanities', 'EE', 'TOK', 'CAS'];
const LOCAL_MODEL_SIZES = {
  'qwen3.5:0.8b': 1.0,
  'qwen3.5:2b': 2.7,
  'qwen3.5:4b': 3.4,
  'qwen3.5:9b': 6.6,
};
const WEEK_DAYS = [
  { value: 1, label: '周一', short: 'MON' },
  { value: 2, label: '周二', short: 'TUE' },
  { value: 3, label: '周三', short: 'WED' },
  { value: 4, label: '周四', short: 'THU' },
  { value: 5, label: '周五', short: 'FRI' },
  { value: 6, label: '周六', short: 'SAT' },
  { value: 0, label: '周日', short: 'SUN' },
];
const COMMAND_TERMS = [
  ['Analyze', '分析', '拆解要素或结构，说明它们之间的关系，并据此得出结论。'],
  ['Compare', '比较', '持续指出两个或多个对象之间的相似之处。'],
  ['Compare and contrast', '比较与对比', '同时说明相似点与不同点，并保持两者之间的对应。'],
  ['Contrast', '对比', '持续指出两个或多个对象之间的不同之处。'],
  ['Define', '定义', '给出一个词语或概念准确、简洁的含义。'],
  ['Describe', '描述', '提供某个情境、事件、模式或过程的详细特征。'],
  ['Discuss', '讨论', '呈现经过权衡的论述，包含一系列论据、因素或假设。'],
  ['Evaluate', '评价', '通过权衡优势、局限与证据，对价值或有效性作出判断。'],
  ['Examine', '审视', '细致考虑某个论点或概念，揭示其假设与相互关系。'],
  ['Explain', '解释', '详细说明原因、机制或过程，让“为什么”和“如何”清楚。'],
  ['Identify', '识别', '从若干可能中给出正确答案、名称或简短事实。'],
  ['Justify', '论证', '提供有效理由或证据，支持一个答案、判断或结论。'],
  ['Outline', '概述', '给出主要特征或总体结构，不展开所有细节。'],
  ['State', '陈述', '给出一个具体名称、数值或简短答案，不要求解释。'],
  ['Suggest', '提出', '给出一种可行方案、假设或答案。'],
  ['To what extent', '在多大程度上', '权衡证据与反例，判断一个主张成立的范围和条件。'],
];
const MILESTONE_TEMPLATES = {
  EE: ['明确兴趣领域与初步选题', '形成可研究的问题', '建立资料与引用清单', '完成结构与主要论证', '提交初稿并根据反馈修订', '完成终稿与反思'],
  TOK: ['拆解题目中的核心概念', '选择并检验真实情境', '形成主张与反主张', '搭建论证结构', '核对例证与知识问题的联系', '完成修订与引用检查'],
  IA: ['确定研究问题与范围', '确认方法和数据需求', '收集并整理数据', '完成分析与不确定性讨论', '评价方法与局限', '根据反馈完成终稿'],
};

const state = {
  data: null,
  route: 'today',
  activeSite: null,
  siteStates: {},
  taskFilter: 'open',
  taskSearch: '',
  planTab: 'tasks',
  noteFilter: 'all',
  noteSearch: '',
  selectedNoteId: null,
  dictionaryInfo: null,
  dictionaryResult: null,
  dictionaryLoading: false,
  dictionaryRequestId: 0,
  hardware: null,
  hardwareLoading: false,
  aiDeployment: null,
  aiEditing: false,
  aiMessages: [],
  aiBusy: false,
  aiControlInfo: null,
  shortcutResults: {},
  commandItems: [],
  commandIndex: 0,
  timerFinishing: false,
};

let persistTimer = null;
let dictionarySearchTimer = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function uid() {
  return crypto.randomUUID();
}

function icon(id) {
  return `<svg aria-hidden="true"><use href="#${id}"/></svg>`;
}

function toast(message, type = 'normal') {
  const node = document.createElement('div');
  node.className = `toast${type === 'error' ? ' error' : ''}`;
  node.textContent = message;
  $('#toastHost').append(node);
  setTimeout(() => node.remove(), 3_100);
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toDateTimeInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function formatDateTime(value, compact = false) {
  if (!value) return '未设截止时间';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未设截止时间';
  const today = localDateKey();
  const tomorrow = localDateKey(new Date(Date.now() + 86_400_000));
  const key = localDateKey(date);
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (key === today) return `今天 ${time}`;
  if (key === tomorrow) return `明天 ${time}`;
  return date.toLocaleString('zh-CN', compact
    ? { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

function relativeTime(value) {
  if (!value) return '';
  const delta = Date.now() - new Date(value).getTime();
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function isToday(value) {
  return value && localDateKey(new Date(value)) === localDateKey();
}

function isOverdue(task) {
  return !task.done && task.dueAt && new Date(task.dueAt).getTime() < Date.now();
}

async function persistData(immediate = false) {
  if (!state.data) return;
  const saveState = $('#saveState');
  saveState?.classList.add('saving');
  if (saveState) saveState.lastChild.textContent = '保存中';
  clearTimeout(persistTimer);
  const commit = async () => {
    try {
      const saved = await window.ph.data.save(state.data);
      state.data = saved;
      saveState?.classList.remove('saving');
      if (saveState) saveState.lastChild.textContent = '已保存';
    } catch (error) {
      saveState?.classList.remove('saving');
      if (saveState) saveState.lastChild.textContent = '保存失败';
      toast(`保存失败：${error.message}`, 'error');
    }
  };
  if (immediate) await commit();
  else persistTimer = setTimeout(commit, 420);
}

function updateClock() {
  const now = new Date();
  const weekday = now.toLocaleDateString('zh-CN', { weekday: 'short' });
  $('#headerWeekday').textContent = weekday;
  $('#headerDate').textContent = `${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;
  const hour = now.getHours();
  const greeting = hour < 5 ? '夜深了' : hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  const name = state.data?.settings?.studentName?.trim();
  $('#greeting').textContent = `${greeting}${name ? `，${name}` : ''}，今天先做哪件事？`;
  $('#greetingKicker').textContent = hour < 12 ? 'A CALM START' : hour < 18 ? 'KEEP THE RHYTHM' : 'A CLEAR FINISH';
}

function setTopbar(title, eyebrow) {
  $('#topTitle').textContent = title;
  $('#topEyebrow').textContent = eyebrow;
}

function navigate(route) {
  if (!ROUTE_META[route]) return;
  state.route = route;
  state.activeSite = null;
  window.ph.sites.hide();
  $$('.page').forEach((page) => page.classList.toggle('active', page.dataset.page === route));
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.route === route));
  $('#siteToolbar').classList.add('hidden');
  $('#internalTopActions').classList.remove('hidden');
  setTopbar(ROUTE_META[route].title, ROUTE_META[route].eyebrow);
  $('#sitePopover').classList.add('hidden');
  if (route === 'today') renderDashboard();
  if (route === 'plan') {
    renderTasks();
    renderSchedule();
    renderFocusStats();
  }
  if (route === 'notes') renderNotes();
  if (route === 'dictionary') {
    renderDictionary();
    loadDictionaryInfo();
    setTimeout(() => $('#dictionarySearch')?.focus(), 30);
  }
  if (route === 'ib') renderIbTools();
  if (route === 'ai') renderAi();
  if (route === 'settings') renderSettings();
  $('#content').scrollTop = 0;
}

async function openSite(siteId) {
  if (!SITE_META[siteId]) return;
  state.activeSite = siteId;
  state.route = null;
  $$('.page').forEach((page) => page.classList.remove('active'));
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.site === siteId));
  $('#siteToolbar').classList.remove('hidden');
  $('#internalTopActions').classList.add('hidden');
  setTopbar(SITE_META[siteId].name, 'SCHOOL APP');
  const siteState = state.siteStates[siteId];
  $('#siteLocation').textContent = siteState?.url || SITE_META[siteId].url;
  $('#siteCleanToggle').checked = Boolean(state.data.settings.siteCleanMode[siteId]);
  await window.ph.sites.open(siteId);
}

function handleSiteState(siteState) {
  const previous = state.siteStates[siteState.id];
  state.siteStates[siteState.id] = siteState;
  const nav = $(`.site-nav[data-site="${siteState.id}"]`);
  nav?.classList.toggle('connected', !siteState.error && Boolean(siteState.url));
  if (state.activeSite !== siteState.id) return;
  $('#siteLocation').textContent = siteState.url || SITE_META[siteState.id].url;
  $('#siteCleanToggle').checked = Boolean(siteState.cleanMode && !siteState.cleanUnavailable);
  $('#siteCleanToggle').closest('.clean-toggle')?.classList.toggle('applied', Boolean(siteState.cleanApplied));
  const back = $('[data-site-action="back"]');
  const forward = $('[data-site-action="forward"]');
  back.disabled = !siteState.canGoBack;
  forward.disabled = !siteState.canGoForward;
  if (siteState.error) toast(`${SITE_META[siteState.id].name}：${siteState.error}`, 'error');
  if (siteState.cleanUnavailable && !previous?.cleanUnavailable) toast('当前页面不支持简洁显示，已保留原网页');
}

function nextLesson() {
  const now = new Date();
  let best = null;
  for (const lesson of state.data.schedule || []) {
    if (!lesson.enabled || !/^\d{2}:\d{2}$/.test(lesson.start || '')) continue;
    for (let offset = 0; offset <= 7; offset += 1) {
      const day = new Date(now);
      day.setDate(now.getDate() + offset);
      if (day.getDay() !== Number(lesson.dayOfWeek)) continue;
      const [hour, minute] = lesson.start.split(':').map(Number);
      day.setHours(hour, minute, 0, 0);
      if (day <= now) continue;
      if (!best || day < best.date) best = { lesson, date: day };
      break;
    }
  }
  return best;
}

function formatCountdown(target) {
  const delta = target.getTime() - Date.now();
  if (delta < 60 * 60_000) return `${Math.max(1, Math.round(delta / 60_000))} 分钟后`;
  if (delta < 24 * 60 * 60_000) return `${Math.round(delta / 3_600_000)} 小时后`;
  return `${Math.round(delta / 86_400_000)} 天后`;
}

function renderDashboard() {
  if (!state.data) return;
  updateClock();
  const openTasks = state.data.tasks.filter((task) => !task.done);
  const todayTasks = openTasks.filter((task) => isToday(task.dueAt));
  const overdue = openTasks.filter(isOverdue);
  $('#todayTaskMetric').textContent = `${todayTasks.length} 项任务`;
  $('#overdueMetric').textContent = overdue.length ? `${overdue.length} 项已逾期` : '没有逾期任务';
  $('#overdueMetric').style.color = overdue.length ? 'var(--wine-700)' : '';

  const upcoming = nextLesson();
  $('#nextClassName').textContent = upcoming?.lesson.course || '尚未添加课程';
  $('#nextClassMeta').textContent = upcoming
    ? `${formatCountdown(upcoming.date)} · ${upcoming.lesson.start}${upcoming.lesson.room ? ` · ${upcoming.lesson.room}` : ''}`
    : '在“计划”中建立课程表';

  const weekSessions = getWeekSessions();
  const weekMinutes = weekSessions.reduce((sum, item) => sum + Number(item.minutes || 0), 0);
  $('#weekFocusMetric').textContent = `${weekMinutes} 分钟`;
  $('#weekSessionMetric').textContent = weekSessions.length ? `完成 ${weekSessions.length} 次专注` : '从一次 25 分钟开始';

  const dashboardTasks = [...openTasks]
    .sort((a, b) => (a.dueAt ? new Date(a.dueAt) : Infinity) - (b.dueAt ? new Date(b.dueAt) : Infinity))
    .slice(0, 4);
  $('#todayTaskList').innerHTML = dashboardTasks.length
    ? dashboardTasks.map((task) => `
      <div class="compact-task" data-task-row="${escapeHtml(task.id)}">
        <button class="task-check" data-toggle-task="${escapeHtml(task.id)}" aria-label="完成任务">${icon('i-check')}</button>
        <div><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(task.subject || '通用')}${task.dueAt ? ` · ${escapeHtml(formatDateTime(task.dueAt, true))}` : ''}</span></div>
      </div>`).join('')
    : '<div class="empty-row">今天没有待处理任务。<br/>给自己留一点从容。</div>';
  const count = openTasks.length;
  $('#navTaskCount').textContent = String(count);
  $('#navTaskCount').dataset.count = String(count);
}

function openTaskDialog(task = null) {
  const existing = Boolean(task?.id);
  $('#taskDialogTitle').textContent = existing ? '编辑任务' : '新建任务';
  $('#taskId').value = task?.id || '';
  $('#taskTitle').value = task?.title || '';
  $('#taskSubject').value = task?.subject || '';
  $('#taskDue').value = toDateTimeInput(task?.dueAt);
  $('#taskEstimate').value = String(task?.estimateMinutes || 30);
  $('#taskPriority').value = task?.priority || 'normal';
  $('#taskNotes').value = task?.notes || '';
  $('#deleteTask').classList.toggle('hidden', !existing);
  $('#taskDialog').showModal();
  setTimeout(() => $('#taskTitle').focus(), 30);
}

async function saveTaskFromDialog(event) {
  event.preventDefault();
  const title = $('#taskTitle').value.trim();
  if (!title) return;
  const id = $('#taskId').value || uid();
  const current = state.data.tasks.find((task) => task.id === id);
  const dueInput = $('#taskDue').value;
  const next = {
    id,
    title,
    subject: $('#taskSubject').value.trim(),
    dueAt: dueInput ? new Date(dueInput).toISOString() : '',
    estimateMinutes: Number($('#taskEstimate').value || 30),
    priority: $('#taskPriority').value,
    notes: $('#taskNotes').value.trim(),
    done: current?.done || false,
    createdAt: current?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (current) Object.assign(current, next);
  else state.data.tasks.unshift(next);
  $('#taskDialog').close();
  await persistData(true);
  renderDashboard();
  renderTasks();
  toast(current ? '任务已更新' : '任务已添加');
}

function toggleTask(taskId) {
  const task = state.data.tasks.find((item) => item.id === taskId);
  if (!task) return;
  task.done = !task.done;
  task.completedAt = task.done ? new Date().toISOString() : '';
  task.updatedAt = new Date().toISOString();
  persistData();
  renderDashboard();
  renderTasks();
}

function deleteTask(taskId) {
  const task = state.data.tasks.find((item) => item.id === taskId);
  if (!task || !confirm(`删除任务“${task.title}”？`)) return;
  state.data.tasks = state.data.tasks.filter((item) => item.id !== taskId);
  $('#taskDialog').close();
  persistData();
  renderDashboard();
  renderTasks();
  toast('任务已删除');
}

function taskMatchesFilter(task) {
  const now = Date.now();
  if (state.taskFilter === 'done') return task.done;
  if (task.done) return false;
  if (state.taskFilter === 'today') return isToday(task.dueAt) || isOverdue(task);
  if (state.taskFilter === 'upcoming') {
    if (!task.dueAt) return false;
    const due = new Date(task.dueAt).getTime();
    return due >= now && due <= now + 7 * 86_400_000;
  }
  return true;
}

function renderTasks() {
  if (!state.data) return;
  const query = state.taskSearch.trim().toLowerCase();
  const tasks = state.data.tasks
    .filter(taskMatchesFilter)
    .filter((task) => !query || `${task.title} ${task.subject} ${task.notes}`.toLowerCase().includes(query))
    .sort((a, b) => {
      if (a.done !== b.done) return Number(a.done) - Number(b.done);
      if (a.priority !== b.priority) return a.priority === 'high' ? -1 : b.priority === 'high' ? 1 : 0;
      return (a.dueAt ? new Date(a.dueAt).getTime() : Infinity) - (b.dueAt ? new Date(b.dueAt).getTime() : Infinity);
    });
  $('#taskBoard').innerHTML = tasks.length
    ? tasks.map((task) => `
      <article class="task-row${task.done ? ' done' : ''}" data-task-row="${escapeHtml(task.id)}">
        <button class="task-check${task.done ? ' checked' : ''}" data-toggle-task="${escapeHtml(task.id)}" aria-label="${task.done ? '恢复任务' : '完成任务'}">${icon('i-check')}</button>
        <div class="task-main"><strong>${escapeHtml(task.title)}</strong><div class="task-meta"><i class="task-priority ${escapeHtml(task.priority || 'normal')}"></i>${task.subject ? `<span class="task-subject">${escapeHtml(task.subject)}</span>` : ''}<span>${Number(task.estimateMinutes || 0)} 分钟</span>${task.notes ? '<span>有备注</span>' : ''}</div></div>
        <span class="due-pill${isOverdue(task) ? ' overdue' : ''}">${escapeHtml(formatDateTime(task.dueAt, true))}</span>
        <button class="icon-menu-button" data-edit-task="${escapeHtml(task.id)}" aria-label="编辑任务">${icon('i-more')}</button>
      </article>`).join('')
    : '<div class="empty-state" style="min-height:360px"><div class="empty-icon">' + icon('i-check') + '</div><h3>这里已经清空</h3><p>没有符合当前筛选条件的任务。</p></div>';
  $$('#taskFilters button').forEach((button) => button.classList.toggle('active', button.dataset.filter === state.taskFilter));
}

function openLessonDialog(lesson = null) {
  $('#lessonId').value = lesson?.id || '';
  $('#lessonCourse').value = lesson?.course || '';
  $('#lessonDay').value = String(lesson?.dayOfWeek ?? 1);
  $('#lessonStart').value = lesson?.start || '08:00';
  $('#lessonEnd').value = lesson?.end || '08:45';
  $('#lessonRoom').value = lesson?.room || '';
  $('#lessonReminder').value = String(lesson?.remindMinutes ?? state.data.settings.defaultReminderMinutes ?? 10);
  $('#deleteLesson').classList.toggle('hidden', !lesson);
  $('#lessonDialog').showModal();
  setTimeout(() => $('#lessonCourse').focus(), 30);
}

async function saveLessonFromDialog(event) {
  event.preventDefault();
  const course = $('#lessonCourse').value.trim();
  if (!course) return;
  const id = $('#lessonId').value || uid();
  const current = state.data.schedule.find((lesson) => lesson.id === id);
  const next = {
    id,
    course,
    dayOfWeek: Number($('#lessonDay').value),
    start: $('#lessonStart').value,
    end: $('#lessonEnd').value,
    room: $('#lessonRoom').value.trim(),
    remindMinutes: Number($('#lessonReminder').value),
    enabled: true,
    createdAt: current?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (current) Object.assign(current, next);
  else state.data.schedule.push(next);
  $('#lessonDialog').close();
  await persistData(true);
  renderSchedule();
  renderDashboard();
  toast(current ? '课程已更新' : '课程已添加');
}

function deleteLesson(lessonId) {
  const lesson = state.data.schedule.find((item) => item.id === lessonId);
  if (!lesson || !confirm(`删除课程“${lesson.course}”？`)) return;
  state.data.schedule = state.data.schedule.filter((item) => item.id !== lessonId);
  $('#lessonDialog').close();
  persistData();
  renderSchedule();
  renderDashboard();
  toast('课程已删除');
}

function renderSchedule() {
  if (!state.data) return;
  const today = new Date().getDay();
  $('#weekGrid').innerHTML = WEEK_DAYS.map((day) => {
    const lessons = state.data.schedule
      .filter((lesson) => Number(lesson.dayOfWeek) === day.value)
      .sort((a, b) => String(a.start).localeCompare(String(b.start)));
    return `<section class="week-day${today === day.value ? ' today' : ''}">
      <div class="week-day-head"><strong>${day.label}</strong><span>${day.short}</span></div>
      ${lessons.length
        ? lessons.map((lesson) => `<button class="lesson-card" data-lesson-id="${escapeHtml(lesson.id)}"><strong>${escapeHtml(lesson.course)}</strong><span>${escapeHtml(lesson.start)}${lesson.end ? `–${escapeHtml(lesson.end)}` : ''}${lesson.room ? ` · ${escapeHtml(lesson.room)}` : ''}</span></button>`).join('')
        : '<div class="empty-row" style="min-height:80px">—</div>'}
    </section>`;
  }).join('');
}

function noteSort(a, b) {
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return Number(b.pinned) - Number(a.pinned);
  return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
}

function createNote({ title = '', body = '', subject = '通用' } = {}) {
  const now = new Date().toISOString();
  const note = { id: uid(), title, body, subject, pinned: false, createdAt: now, updatedAt: now };
  state.data.notes.unshift(note);
  state.selectedNoteId = note.id;
  persistData();
  renderNotes();
  setTimeout(() => $('#noteTitleEdit')?.focus(), 20);
  return note;
}

function filteredNotes() {
  const query = state.noteSearch.trim().toLowerCase();
  return [...state.data.notes]
    .filter((note) => state.noteFilter !== 'pinned' || note.pinned)
    .filter((note) => !query || `${note.title} ${note.body} ${note.subject}`.toLowerCase().includes(query))
    .sort(noteSort);
}

function renderNotes() {
  if (!state.data) return;
  const notes = filteredNotes();
  $('#noteList').innerHTML = notes.length
    ? notes.map((note) => `
      <button class="note-list-item${state.selectedNoteId === note.id ? ' active' : ''}" data-note-id="${escapeHtml(note.id)}">
        <strong>${escapeHtml(note.title || '无标题笔记')}</strong>
        <p>${escapeHtml(note.body || '尚未写入内容')}</p>
        <span>${escapeHtml(note.subject || '通用')} · ${escapeHtml(relativeTime(note.updatedAt))}</span>
        ${note.pinned ? icon('i-pin') : ''}
      </button>`).join('')
    : '<div class="empty-row">没有找到笔记</div>';
  $$('.note-filter-row button').forEach((button) => button.classList.toggle('active', button.dataset.noteFilter === state.noteFilter));
  renderNoteEditor();
}

function renderNoteEditor() {
  const note = state.data.notes.find((item) => item.id === state.selectedNoteId);
  if (!note) {
    $('#noteEditor').innerHTML = `<div class="empty-state"><div class="empty-icon">${icon('i-note')}</div><h3>选择一条笔记</h3><p>或新建笔记，开始记录。</p></div>`;
    return;
  }
  const subjects = [...new Set([...SUBJECTS, note.subject].filter(Boolean))];
  const words = countWords(note.body);
  $('#noteEditor').innerHTML = `
    <div class="note-editor-form" data-current-note="${escapeHtml(note.id)}">
      <div class="note-editor-tools">
        <select id="noteSubjectEdit" aria-label="学科标签">${subjects.map((subject) => `<option value="${escapeHtml(subject)}"${subject === note.subject ? ' selected' : ''}>${escapeHtml(subject)}</option>`).join('')}</select>
        <div class="note-tool-buttons">
          <button id="noteToTask" title="转为任务">${icon('i-check')}</button>
          <button id="pinNote" class="${note.pinned ? 'active' : ''}" title="${note.pinned ? '取消置顶' : '置顶'}">${icon('i-pin')}</button>
          <button id="deleteNote" class="danger" title="删除">${icon('i-trash')}</button>
        </div>
      </div>
      <input class="note-title-input" id="noteTitleEdit" maxlength="160" value="${escapeHtml(note.title)}" placeholder="无标题笔记"/>
      <textarea class="note-body-input" id="noteBodyEdit" placeholder="开始记录…">${escapeHtml(note.body)}</textarea>
      <div class="note-editor-foot"><span id="noteWordStatus">${words} 词 · ${String(note.body || '').length} 字符</span><span>自动保存 · ${escapeHtml(relativeTime(note.updatedAt))}</span></div>
    </div>`;
}

function updateCurrentNote(field, value) {
  const note = state.data.notes.find((item) => item.id === state.selectedNoteId);
  if (!note) return;
  note[field] = value;
  note.updatedAt = new Date().toISOString();
  persistData();
  if (field === 'body') $('#noteWordStatus').textContent = `${countWords(value)} 词 · ${value.length} 字符`;
  const listItem = $(`.note-list-item[data-note-id="${note.id}"]`);
  if (listItem) {
    const strong = $('strong', listItem);
    const paragraph = $('p', listItem);
    if (strong && field === 'title') strong.textContent = value || '无标题笔记';
    if (paragraph && field === 'body') paragraph.textContent = value || '尚未写入内容';
  }
}

function deleteCurrentNote() {
  const note = state.data.notes.find((item) => item.id === state.selectedNoteId);
  if (!note || !confirm(`删除笔记“${note.title || '无标题笔记'}”？`)) return;
  state.data.notes = state.data.notes.filter((item) => item.id !== note.id);
  state.selectedNoteId = filteredNotes()[0]?.id || null;
  persistData();
  renderNotes();
  toast('笔记已删除');
}

function noteToTask() {
  const note = state.data.notes.find((item) => item.id === state.selectedNoteId);
  if (!note) return;
  openTaskDialog({ title: note.title || '处理这条笔记', subject: note.subject, notes: note.body.slice(0, 500), estimateMinutes: 30, priority: 'normal' });
  $('#taskId').value = '';
}

function dictionaryText(value) {
  return escapeHtml(String(value || '').replaceAll('\\n', '\n')).replaceAll('\n', '<br>');
}

function dictionaryPreview(value) {
  return String(value || '').replaceAll('\\n', ' · ').replaceAll('\n', ' · ').replace(/\s+/g, ' ').trim();
}

function dictionaryTagLabel(tag) {
  const labels = {
    zk: '中考', gk: '高考', cet4: 'CET-4', cet6: 'CET-6', ky: '考研',
    toefl: 'TOEFL', ielts: 'IELTS', gre: 'GRE', oxford: 'Oxford 3000',
  };
  return labels[String(tag || '').toLowerCase()] || String(tag || '').toUpperCase();
}

async function loadDictionaryInfo() {
  if (state.dictionaryInfo) return;
  try {
    state.dictionaryInfo = await window.ph.dictionary.info();
    renderDictionary();
  } catch (error) {
    state.dictionaryInfo = { error: error.message };
    renderDictionary();
  }
}

async function lookupDictionary(rawQuery) {
  const query = String(rawQuery || '').trim();
  const input = $('#dictionarySearch');
  if (input && input.value !== query) input.value = query;
  if (!query) {
    state.dictionaryResult = null;
    state.dictionaryLoading = false;
    renderDictionary();
    return;
  }
  const requestId = ++state.dictionaryRequestId;
  state.dictionaryLoading = true;
  renderDictionary();
  try {
    const result = await window.ph.dictionary.lookup(query);
    if (requestId !== state.dictionaryRequestId) return;
    state.dictionaryResult = result;
  } catch (error) {
    if (requestId !== state.dictionaryRequestId) return;
    state.dictionaryResult = { query, exact: null, suggestions: [], error: error.message };
  } finally {
    if (requestId === state.dictionaryRequestId) {
      state.dictionaryLoading = false;
      renderDictionary();
    }
  }
}

function renderDictionary() {
  const status = $('#dictionaryStatus');
  if (!status) return;
  if (state.dictionaryInfo?.error) status.textContent = '离线词库不可用';
  else if (state.dictionaryInfo?.entryCount) status.textContent = `${Number(state.dictionaryInfo.entryCount).toLocaleString('zh-CN')} 个本地词条`;
  else status.textContent = '正在准备离线词库…';

  const suggestions = $('#dictionarySuggestions');
  const resultPanel = $('#dictionaryResult');
  const result = state.dictionaryResult;
  if (state.dictionaryLoading) {
    suggestions.innerHTML = '<div class="empty-row">正在本机词库中查找…</div>';
  } else if (result?.suggestions?.length) {
    suggestions.innerHTML = result.suggestions.map((item) => `
      <button class="dictionary-suggestion${result.exact?.word?.toLowerCase() === item.word.toLowerCase() ? ' active' : ''}" data-dict-word="${escapeHtml(item.word)}">
        <div><strong>${escapeHtml(item.word)}</strong>${item.phonetic ? `<span>[${escapeHtml(item.phonetic)}]</span>` : ''}</div>
        <p>${escapeHtml(dictionaryPreview(item.translation) || '查看英文释义')}</p>
      </button>`).join('');
  } else if (result?.query) {
    suggestions.innerHTML = '<div class="empty-row">没有找到相近词条</div>';
  } else {
    suggestions.innerHTML = '<div class="empty-row">输入单词开始查询</div>';
  }

  if (state.dictionaryLoading && !result?.exact) {
    resultPanel.innerHTML = '<div class="empty-state"><div class="empty-icon">' + icon('i-search') + '</div><h3>正在查找</h3><p>查询只访问本机词库。</p></div>';
    return;
  }
  if (result?.error) {
    resultPanel.innerHTML = `<div class="empty-state"><div class="empty-icon">${icon('i-book')}</div><h3>词库暂时不可用</h3><p>${escapeHtml(result.error)}</p></div>`;
    return;
  }
  const entry = result?.exact;
  if (!entry) {
    resultPanel.innerHTML = result?.suggestions?.length
      ? '<div class="empty-state"><div class="empty-icon">' + icon('i-arrow') + '</div><h3>选择一个候选词</h3><p>左侧已列出相近词条。</p></div>'
      : '<div class="empty-state"><div class="empty-icon">' + icon('i-book') + '</div><h3>随时查一个词</h3><p>支持英汉释义、英文定义、词形变化和系统语音朗读。</p></div>';
    return;
  }

  const tags = [
    ...(entry.collins ? [`${'★'.repeat(Math.min(5, Number(entry.collins)))} Collins`] : []),
    ...(entry.oxford ? ['Oxford 3000'] : []),
    ...(entry.tags || []).map(dictionaryTagLabel),
  ];
  const uniqueTags = [...new Set(tags)].slice(0, 9);
  const frequency = [
    entry.frq ? `当代词频 #${Number(entry.frq).toLocaleString('zh-CN')}` : '',
    entry.bnc ? `BNC #${Number(entry.bnc).toLocaleString('zh-CN')}` : '',
  ].filter(Boolean);
  resultPanel.innerHTML = `
    <div class="dictionary-entry-head">
      <div><span class="section-kicker">HEADWORD</span><h3>${escapeHtml(entry.word)}</h3>${entry.phonetic ? `<p>[${escapeHtml(entry.phonetic)}]</p>` : ''}</div>
      <button class="dictionary-speak" id="dictionarySpeak" aria-label="朗读 ${escapeHtml(entry.word)}">${icon('i-play')}<span>朗读</span></button>
    </div>
    ${uniqueTags.length ? `<div class="dictionary-tags">${uniqueTags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
    ${entry.translation ? `<section class="dictionary-definition primary"><span>中文释义</span><p>${dictionaryText(entry.translation)}</p></section>` : ''}
    ${entry.definition ? `<section class="dictionary-definition"><span>英文释义</span><p lang="en">${dictionaryText(entry.definition)}</p></section>` : ''}
    ${entry.exchange?.length ? `<section class="dictionary-forms"><span>词形变化</span><div>${entry.exchange.map((item) => `<button data-dict-word="${escapeHtml(item.word)}"><small>${escapeHtml(item.label)}</small><strong>${escapeHtml(item.word)}</strong></button>`).join('')}</div></section>` : ''}
    ${frequency.length ? `<div class="dictionary-frequency">${frequency.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : ''}
    <div class="dictionary-actions"><button class="secondary-button" id="dictionaryToNote">${icon('i-note')}保存到笔记</button><span>离线查询 · 不会发送搜索内容</span></div>`;
}

function speakDictionaryEntry() {
  const word = state.dictionaryResult?.exact?.word;
  if (!word || !('speechSynthesis' in window)) return toast('这台电脑没有可用的系统语音', 'error');
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = 'en-US';
  utterance.rate = 0.88;
  window.speechSynthesis.speak(utterance);
}

function saveDictionaryEntryToNote() {
  const entry = state.dictionaryResult?.exact;
  if (!entry) return;
  const forms = (entry.exchange || []).map((item) => `${item.label}：${item.word}`).join('；');
  const body = [
    entry.phonetic ? `[${entry.phonetic}]` : '',
    String(entry.translation || '').replaceAll('\\n', '\n'),
    entry.definition ? `英文释义\n${String(entry.definition).replaceAll('\\n', '\n')}` : '',
    forms ? `词形变化\n${forms}` : '',
  ].filter(Boolean).join('\n\n');
  createNote({ title: `词典 · ${entry.word}`, body, subject: 'English' });
  navigate('notes');
  toast('词条已保存为本地笔记');
}

function countWords(text) {
  const source = String(text || '').trim();
  if (!source) return 0;
  const latin = source.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || [];
  const cjk = source.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || [];
  const latinWithoutCjk = latin.filter((token) => !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(token));
  return latinWithoutCjk.length + cjk.length;
}

function renderCommandTerms() {
  const query = $('#commandSearch')?.value.trim().toLowerCase() || '';
  const terms = COMMAND_TERMS.filter((term) => !query || term.join(' ').toLowerCase().includes(query));
  $('#commandResults').innerHTML = terms.length
    ? terms.map(([english, chinese, description]) => `<div class="command-item"><strong>${escapeHtml(english)}</strong><span>${escapeHtml(chinese)}</span><p>${escapeHtml(description)}</p></div>`).join('')
    : '<div class="empty-row">没有匹配的指令词</div>';
}

function updateWordStats() {
  const text = $('#wordCounterInput').value;
  const words = countWords(text);
  $('#wordCount').textContent = String(words);
  $('#charCount').textContent = String(text.length);
  $('#readTime').textContent = words ? String(Math.max(1, Math.ceil(words / 220))) : '0';
}

function ensureGradeRows() {
  if (!Array.isArray(state.data.ib.gradeComponents)) state.data.ib.gradeComponents = [];
  if (!state.data.ib.gradeComponents.length) {
    state.data.ib.gradeComponents = [
      { id: uid(), name: '分项 1', score: '', max: '100', weight: '50' },
      { id: uid(), name: '分项 2', score: '', max: '100', weight: '50' },
    ];
  }
}

function renderGradeRows() {
  ensureGradeRows();
  $('#gradeRows').innerHTML = state.data.ib.gradeComponents.map((row) => `
    <div class="grade-row" data-grade-id="${escapeHtml(row.id)}">
      <input data-grade-field="name" value="${escapeHtml(row.name)}" placeholder="分项" aria-label="分项名称"/>
      <input data-grade-field="score" value="${escapeHtml(row.score)}" inputmode="decimal" placeholder="得分" aria-label="得分"/>
      <span>/</span>
      <input data-grade-field="max" value="${escapeHtml(row.max)}" inputmode="decimal" placeholder="满分" aria-label="满分"/>
      <input data-grade-field="weight" value="${escapeHtml(row.weight)}" inputmode="decimal" placeholder="权重%" aria-label="权重百分比"/>
      <button data-remove-grade="${escapeHtml(row.id)}" aria-label="删除分项">${icon('i-trash')}</button>
    </div>`).join('');
  calculateGrade();
}

function calculateGrade() {
  let weighted = 0;
  let totalWeight = 0;
  for (const row of state.data.ib.gradeComponents) {
    const score = Number(row.score);
    const max = Number(row.max);
    const weight = Number(row.weight);
    if (!Number.isFinite(score) || !Number.isFinite(max) || max <= 0 || !Number.isFinite(weight) || weight <= 0) continue;
    weighted += (score / max) * weight;
    totalWeight += weight;
  }
  $('#gradeTotal').textContent = totalWeight ? `${weighted.toFixed(1)}% · Σ${totalWeight.toFixed(0)}%` : '—';
}

function addMilestoneTemplate(type) {
  const steps = MILESTONE_TEMPLATES[type];
  if (!steps) return;
  const now = new Date().toISOString();
  const tasks = steps.map((step, index) => ({
    id: uid(), title: `${type} · ${step}`, subject: type, dueAt: '', estimateMinutes: 45,
    priority: index === 0 ? 'high' : 'normal', notes: `${type} 通用里程碑，可按老师要求修改。`,
    done: false, createdAt: now, updatedAt: now,
  }));
  state.data.tasks.unshift(...tasks);
  persistData();
  renderDashboard();
  toast(`已添加 ${steps.length} 个 ${type} 里程碑`);
}

function renderIbTools() {
  if (!state.data) return;
  renderCommandTerms();
  renderGradeRows();
  updateWordStats();
}

function ensureTimer() {
  if (!state.data.settings.timer || typeof state.data.settings.timer !== 'object') {
    state.data.settings.timer = {
      mode: 'countdown',
      phase: 'focus',
      focusMinutes: 25,
      breakMinutes: 5,
      durationMs: 25 * 60_000,
      remainingMs: 25 * 60_000,
      elapsedMs: 0,
      running: false,
      endAt: 0,
      startedAt: 0,
    };
  }
  return state.data.settings.timer;
}

function timerDisplayMs(timer = ensureTimer()) {
  if (timer.mode === 'stopwatch') {
    return Math.max(0, Number(timer.elapsedMs || 0) + (timer.running ? Date.now() - Number(timer.startedAt || Date.now()) : 0));
  }
  return timer.running ? Math.max(0, Number(timer.endAt || 0) - Date.now()) : Math.max(0, Number(timer.remainingMs || 0));
}

function formatTimer(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function timerProgress(timer, displayMs) {
  if (timer.mode === 'stopwatch') return ((displayMs % 3_600_000) / 3_600_000) * 100;
  const duration = Math.max(1, Number(timer.durationMs || 1));
  return Math.min(100, Math.max(0, ((duration - displayMs) / duration) * 100));
}

function updateTimerUi() {
  if (!state.data) return;
  const timer = ensureTimer();
  const displayMs = timerDisplayMs(timer);
  const formatted = formatTimer(displayMs);
  const progress = timerProgress(timer, displayMs);
  $('#miniFocusTime').textContent = formatted;
  $('#focusTime').textContent = formatted;
  $('#miniFocusProgress').style.width = `${progress}%`;
  $('#focusRing').style.setProperty('--progress', `${progress * 3.6}deg`);
  const isBreak = timer.phase === 'break';
  $('#miniFocusPhase').textContent = isBreak ? '休息' : timer.mode === 'stopwatch' ? '正计时' : '专注';
  $('#focusModeLabel').textContent = isBreak ? '休息时间' : timer.mode === 'stopwatch' ? '正计时' : '专注时间';
  $('#focusPhaseLabel').textContent = isBreak ? 'SHORT BREAK' : timer.mode === 'stopwatch' ? 'STOPWATCH' : 'FOCUS SESSION';
  const playIcon = timer.running ? 'i-pause' : 'i-play';
  $('#miniFocusPlay').innerHTML = icon(playIcon);
  $('#focusPlay').innerHTML = icon(playIcon);
  $$('#focusPresets button').forEach((button) => {
    const active = timer.mode === 'stopwatch'
      ? Number(button.dataset.focus) === 0
      : Number(button.dataset.focus) === Number(timer.focusMinutes) && Number(button.dataset.break) === Number(timer.breakMinutes);
    button.classList.toggle('active', active);
  });
  if (timer.mode === 'countdown' && timer.running && displayMs <= 0 && !state.timerFinishing) finishTimerPhase();
}

function toggleTimer() {
  const timer = ensureTimer();
  if (timer.running) {
    if (timer.mode === 'stopwatch') timer.elapsedMs = timerDisplayMs(timer);
    else timer.remainingMs = timerDisplayMs(timer);
    timer.running = false;
    timer.startedAt = 0;
    timer.endAt = 0;
  } else {
    timer.running = true;
    if (timer.mode === 'stopwatch') timer.startedAt = Date.now();
    else timer.endAt = Date.now() + Math.max(1_000, Number(timer.remainingMs || timer.durationMs));
  }
  persistData();
  updateTimerUi();
}

function resetTimer() {
  const timer = ensureTimer();
  timer.running = false;
  timer.endAt = 0;
  timer.startedAt = 0;
  timer.elapsedMs = 0;
  if (timer.mode === 'countdown') {
    timer.durationMs = (timer.phase === 'break' ? timer.breakMinutes : timer.focusMinutes) * 60_000;
    timer.remainingMs = timer.durationMs;
  }
  persistData();
  updateTimerUi();
}

function setTimerPreset(focusMinutes, breakMinutes) {
  const timer = ensureTimer();
  timer.running = false;
  timer.phase = 'focus';
  timer.focusMinutes = focusMinutes || 25;
  timer.breakMinutes = breakMinutes || 5;
  timer.endAt = 0;
  timer.startedAt = 0;
  timer.elapsedMs = 0;
  if (focusMinutes === 0) {
    timer.mode = 'stopwatch';
    timer.durationMs = 0;
    timer.remainingMs = 0;
  } else {
    timer.mode = 'countdown';
    timer.durationMs = focusMinutes * 60_000;
    timer.remainingMs = timer.durationMs;
  }
  persistData();
  updateTimerUi();
}

function recordFocusSession(minutes, completed = true) {
  if (!Number.isFinite(minutes) || minutes < 1) return;
  state.data.focusSessions.unshift({
    id: uid(),
    startedAt: new Date(Date.now() - minutes * 60_000).toISOString(),
    endedAt: new Date().toISOString(),
    minutes: Math.round(minutes),
    completed,
  });
  state.data.focusSessions = state.data.focusSessions.slice(0, 500);
}

async function finishTimerPhase() {
  state.timerFinishing = true;
  const timer = ensureTimer();
  timer.running = false;
  timer.endAt = 0;
  if (timer.phase === 'focus') {
    recordFocusSession(Number(timer.focusMinutes || 25), true);
    timer.phase = 'break';
    timer.durationMs = Number(timer.breakMinutes || 5) * 60_000;
    timer.remainingMs = timer.durationMs;
    await window.ph.system.notify({ title: '专注完成', body: `完成 ${timer.focusMinutes} 分钟专注，休息一下吧。` });
    toast('专注完成，进入休息阶段');
  } else {
    timer.phase = 'focus';
    timer.durationMs = Number(timer.focusMinutes || 25) * 60_000;
    timer.remainingMs = timer.durationMs;
    await window.ph.system.notify({ title: '休息结束', body: '准备好后，开始下一轮专注。' });
    toast('休息结束');
  }
  await persistData(true);
  renderDashboard();
  renderFocusStats();
  updateTimerUi();
  state.timerFinishing = false;
}

function skipTimerPhase() {
  const timer = ensureTimer();
  if (timer.mode === 'stopwatch') {
    const elapsed = timerDisplayMs(timer);
    if (elapsed >= 60_000) {
      recordFocusSession(elapsed / 60_000, false);
      toast('本次正计时已记录');
    }
    timer.running = false;
    timer.elapsedMs = 0;
    timer.startedAt = 0;
  } else {
    timer.running = false;
    timer.endAt = 0;
    timer.phase = timer.phase === 'focus' ? 'break' : 'focus';
    timer.durationMs = (timer.phase === 'break' ? timer.breakMinutes : timer.focusMinutes) * 60_000;
    timer.remainingMs = timer.durationMs;
  }
  persistData();
  renderDashboard();
  renderFocusStats();
  updateTimerUi();
}

function getWeekSessions() {
  const start = new Date();
  const day = start.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + mondayOffset);
  start.setHours(0, 0, 0, 0);
  return (state.data.focusSessions || []).filter((item) => new Date(item.endedAt).getTime() >= start.getTime());
}

function renderFocusStats() {
  if (!state.data) return;
  const sessions = getWeekSessions();
  const minutes = sessions.reduce((sum, item) => sum + Number(item.minutes || 0), 0);
  const days = new Set(sessions.map((item) => localDateKey(new Date(item.endedAt))));
  $('#focusStatMinutes').textContent = String(minutes);
  $('#focusStatSessions').textContent = String(sessions.length);
  $('#focusStatDays').textContent = String(days.size);
  $('#focusHistory').innerHTML = sessions.length
    ? sessions.slice(0, 5).map((item) => `<div class="focus-history-row"><span>${escapeHtml(new Date(item.endedAt).toLocaleDateString('zh-CN', { weekday: 'short', month: 'numeric', day: 'numeric' }))}</span><b>${Number(item.minutes)} 分钟</b></div>`).join('')
    : '<div class="empty-row" style="min-height:90px">本周还没有记录</div>';
}

async function loadHardwareProfile() {
  if (state.hardware || state.hardwareLoading) return;
  state.hardwareLoading = true;
  try {
    state.hardware = await window.ph.system.hardware();
  } catch (error) {
    state.hardware = { error: error.message };
  } finally {
    state.hardwareLoading = false;
    if (state.route === 'ai') renderAiConfig();
  }
}

function renderAi() {
  if (!state.data) return;
  const ai = state.data.settings.ai;
  const enabled = Boolean(ai.enabled && ai.provider !== 'off');
  const showSetup = !enabled || state.aiEditing;
  $('#aiSetup').classList.toggle('hidden', !showSetup);
  $('#aiChat').classList.toggle('hidden', showSetup);
  $('#aiEditConfig').classList.toggle('hidden', !enabled || showSetup);
  $$('.ai-choice-list > button').forEach((button) => button.classList.toggle('active', button.dataset.aiProvider === ai.provider));
  if (showSetup) {
    renderAiConfig();
    if (state.route === 'ai') loadHardwareProfile();
  } else {
    if (!state.aiMessages.length) {
      state.aiMessages.push({ role: 'assistant', content: '你好。我可以陪你学习；如果你另外开启“AI 操作启动器”，我也能读取你授权的任务、笔记摘要与课程表，并把建议更改交给你确认。' });
    }
    renderAiControl();
    renderChat();
  }
  $('#aiNavBadge').textContent = enabled ? (ai.provider === 'local' ? '本地' : 'API') : '可选';
}

function renderAiControl() {
  const ai = state.data?.settings?.ai || {};
  const enabled = Boolean(ai.launcherControlEnabled && ai.controlConsentVersion);
  $('#aiControlToggle').checked = enabled;
  $('#aiControlStatus').textContent = enabled
    ? ai.provider === 'local'
      ? '已授权 · 本地模型 · 写入前确认'
      : '已授权 · API 模式会发送被读取的内容 · 写入前确认'
    : '关闭时只进行普通对话';
}

function hardwareMarkup() {
  if (state.hardwareLoading) return '<div class="empty-row" style="min-height:120px">正在检测这台电脑…</div>';
  if (!state.hardware || state.hardware.error) return '<div class="recommendation-card">' + icon('i-clock') + '<div><strong>暂时无法读取硬件信息</strong><span>可以继续手动选择模型；建议先从较小模型开始。</span></div></div>';
  const profile = state.hardware;
  const recommendation = profile.recommendation || {};
  return `<div class="hardware-card">
      <div><span>处理器</span><strong title="${escapeHtml(profile.cpu)}">${escapeHtml(profile.cpu)}</strong></div>
      <div><span>内存</span><strong>${escapeHtml(profile.ramGb)} GB</strong></div>
      <div><span>显卡</span><strong title="${escapeHtml(profile.gpuName || '未检测到独显')}">${escapeHtml(profile.gpuName || '未检测到独显')}</strong></div>
      <div><span>显存</span><strong>${profile.vramGb ? `${escapeHtml(profile.vramGb)} GB` : '—'}</strong></div>
      <div><span>系统盘</span><strong>${profile.diskFreeGb ? `${escapeHtml(profile.diskRoot)} · ${escapeHtml(profile.diskFreeGb)} GB 可用` : '未读取'}</strong></div>
      <div><span>检测方式</span><strong>此电脑实时检测</strong></div>
    </div>
    <div class="recommendation-card">${icon(recommendation.recommended ? 'i-check' : 'i-clock')}<div><strong>${escapeHtml(recommendation.label || '等待推荐')}</strong><span>${escapeHtml(recommendation.reason || '')}</span></div></div>`;
}

function localDeploymentMarkup(recommendation) {
  const deployment = state.aiDeployment || {
    running: false,
    stage: 'idle',
    progress: 0,
    title: '一键部署推荐模型',
    detail: '自动安装或连接 Ollama，下载模型并完成验证。',
  };
  const model = recommendation?.recommended ? recommendation.model : '';
  const modelSize = LOCAL_MODEL_SIZES[model];
  const running = Boolean(deployment.running);
  const failed = deployment.stage === 'error';
  const canceled = deployment.stage === 'canceled';
  const complete = deployment.stage === 'complete';
  const statusClass = running ? 'running' : failed ? 'error' : complete ? 'complete' : canceled ? 'canceled' : 'idle';
  const progress = Math.max(0, Math.min(100, Number(deployment.progress || 0)));
  const canDeploy = Boolean(model && !state.hardwareLoading && !running);
  const title = running || failed || canceled || complete ? deployment.title : '一键部署推荐模型';
  const detail = running || failed || canceled || complete
    ? deployment.detail
    : model
      ? `自动安装或连接 Ollama，下载 ${model}（约 ${modelSize || '—'} GB），验证后直接启用。首次使用还会下载 Ollama，大小以进度显示为准。`
      : '检测完成且适合本地运行时，才会开放自动部署。';
  return `<section class="local-deployment-card ${statusClass}">
      <div class="deployment-heading">
        <div class="deployment-icon">${icon(complete ? 'i-check' : failed ? 'i-clock' : 'i-spark')}</div>
        <div><span>ONE-CLICK LOCAL AI</span><h4>${escapeHtml(title)}</h4><p>${escapeHtml(detail)}</p></div>
      </div>
      ${running ? `<div class="deployment-progress"><div style="width:${progress}%"></div></div><div class="deployment-progress-meta"><span>${escapeHtml(deployment.model || model)}</span><b>${progress}%</b></div>` : ''}
      <div class="deployment-actions">
        ${running
          ? `<button class="secondary-button" id="cancelLocalDeployment" ${deployment.canCancel === false ? 'disabled' : ''}>${deployment.canCancel === false ? '正在停止…' : '取消部署'}</button>`
          : `<button class="primary-button" id="deployLocalAi" ${canDeploy ? '' : 'disabled'}>${failed || canceled ? '继续部署' : complete ? '重新验证并部署' : model ? `一键部署 ${escapeHtml(model)}` : '等待硬件检测'}</button>`}
        <button class="secondary-button" id="refreshHardware" ${running ? 'disabled' : ''}>重新检测电脑</button>
        ${!running && deployment.hasDiagnostics ? '<button class="text-button" id="showDeploymentLog">查看部署日志</button>' : ''}
        ${failed ? '<button class="text-button" id="openOllamaDownload">打开 Ollama 官方下载页</button>' : ''}
      </div>
      <small class="deployment-note">${state.hardware?.platform === 'darwin' ? '安装包来自 Ollama 官方来源；安装前会核对 Apple Developer ID、应用标识与 Gatekeeper 公证。首次打开若出现 macOS 确认，请核对名称为 Ollama，不要关闭系统安全保护。' : '安装包来自 Ollama 官方网站并验证 Windows 数字签名；网络中断后再次点击会从断点继续。'} 不会读取学校网站、笔记或账号信息。</small>
    </section>`;
}

function renderAiConfig() {
  if (!state.data) return;
  const ai = state.data.settings.ai;
  const panel = $('#aiConfigPanel');
  if (ai.provider === 'off') {
    panel.innerHTML = `<div class="ai-off-illustration"><div class="empty-icon">${icon('i-spark')}</div><h3>AI 保持关闭</h3><p>三所学校入口、笔记、任务、课程提醒、计时器和 IB 工具仍可完整使用。不会下载模型，也不会连接任何 AI 服务。</p></div><div class="config-actions"><button class="primary-button" id="saveAiOff">保持关闭</button></div>`;
    return;
  }
  if (ai.provider === 'local') {
    const recommendation = state.hardware?.recommendation;
    const recommendedModel = recommendation?.recommended ? recommendation.model : '';
    const modelValue = ai.localModel || recommendedModel;
    const modelHint = state.hardwareLoading
      ? '正在读取这台电脑的配置，检测完成后会自动填入建议模型。'
      : recommendedModel
      ? `本机推荐：${recommendedModel}。应用限制为 8K 上下文，避免显存被长上下文占满。`
      : '当前检测结果不建议安装本地模型；如你了解风险，仍可手动填写已安装的模型名称。';
    panel.innerHTML = `<h3>本地 AI</h3><p>PH Launcher 会按每台电脑的内存、显卡与磁盘空间推荐模型；同学安装时会得到各自的结果。</p>
      ${hardwareMarkup()}
      ${localDeploymentMarkup(recommendation)}
      <details class="manual-ai-settings">
        <summary>手动连接已有 Ollama（高级）</summary>
        <div class="config-fields">
          <label><span>本地服务地址</span><input id="localEndpointInput" value="${escapeHtml(ai.localEndpoint || 'http://127.0.0.1:11434')}"/></label>
          <label><span>模型</span><input id="localModelInput" value="${escapeHtml(modelValue)}" placeholder="例如 qwen3.5:2b"/><small>${escapeHtml(modelHint)}</small></label>
        </div>
        <div class="config-actions compact"><button class="primary-button" id="saveLocalAi">连接已有模型</button><button class="secondary-button" id="openOllamaDownload">打开 Ollama 官网</button><button class="text-button" id="copyModelCommand">复制模型命令 ${icon('i-arrow')}</button></div>
      </details>`;
    return;
  }
  panel.innerHTML = `<h3>API AI</h3><p>普通对话只发送你主动提交的内容。若另外开启“AI 操作启动器”，经授权的任务、课表和少量笔记摘要也会按需发送；账号密码与完整网页不会提供给 AI。</p>
    <div class="recommendation-card">${icon('i-external')}<div><strong>云端数据提示</strong><span>提交的文字会发送给你配置的服务商；请不要粘贴账号密码、验证码或敏感个人信息。</span></div></div>
    <div class="config-fields">
      <label><span>API Endpoint</span><input id="apiEndpointInput" value="${escapeHtml(ai.apiEndpoint || 'https://api.openai.com/v1')}" placeholder="https://…/v1"/><small>非本机 API 必须使用 HTTPS，并支持 OpenAI-compatible Chat Completions。</small></label>
      <label><span>模型名称</span><input id="apiModelInput" value="${escapeHtml(ai.apiModel || '')}" placeholder="由服务商提供"/></label>
      <label><span>API Key</span><input id="apiKeyInput" type="password" value="" placeholder="${ai.apiKeySaved ? '已安全保存；留空则不修改' : '输入 API Key'}" autocomplete="new-password"/></label>
    </div>
    <div class="config-actions"><button class="primary-button" id="saveApiAi">启用 API AI</button>${ai.apiKeySaved ? '<button class="secondary-button" id="clearApiKey">删除已保存的 Key</button>' : ''}</div>`;
}

async function startLocalAiDeployment() {
  if (state.aiDeployment?.running) return;
  try {
    state.aiDeployment = await window.ph.ai.deployLocal();
    renderAiConfig();
    toast('本地 AI 一键部署已开始');
  } catch (error) {
    toast(`无法开始部署：${error.message}`, 'error');
  }
}

async function cancelLocalAiDeployment() {
  if (!state.aiDeployment?.running) return;
  try {
    state.aiDeployment = await window.ph.ai.cancelDeployment();
    renderAiConfig();
  } catch (error) {
    toast(`无法取消部署：${error.message}`, 'error');
  }
}

async function configureAi(provider) {
  try {
    let config;
    if (provider === 'off') {
      config = { enabled: false, provider: 'off' };
    } else if (provider === 'local') {
      config = {
        enabled: true,
        provider: 'local',
        localEndpoint: $('#localEndpointInput').value.trim(),
        localModel: $('#localModelInput').value.trim(),
      };
      if (!config.localModel) throw new Error('请填写模型名称');
    } else {
      config = {
        enabled: true,
        provider: 'api',
        apiEndpoint: $('#apiEndpointInput').value.trim(),
        apiModel: $('#apiModelInput').value.trim(),
        apiKey: $('#apiKeyInput').value.trim(),
      };
      if (!config.apiModel) throw new Error('请填写模型名称');
    }
    const saved = await window.ph.ai.configure(config);
    state.data.settings.ai = saved;
    state.aiEditing = false;
    state.aiMessages = [];
    renderAi();
    toast(provider === 'off' ? 'AI 已保持关闭' : 'AI 连接设置已保存');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function openAiControlDialog() {
  try {
    state.aiControlInfo = await window.ph.ai.controlInfo();
  } catch {
    state.aiControlInfo = { consentVersion: 1 };
  }
  $('#aiRiskAccepted').checked = false;
  $('#acceptAiControl').disabled = true;
  $('#aiApiRisk').classList.toggle('hidden', state.data.settings.ai.provider !== 'api');
  $('#aiControlDialog').showModal();
}

async function disableAiControl() {
  try {
    const saved = await window.ph.ai.configure({ launcherControlEnabled: false });
    state.data.settings.ai = saved;
    renderAiControl();
    toast('AI 启动器操作已关闭');
  } catch (error) {
    $('#aiControlToggle').checked = true;
    toast(error.message, 'error');
  }
}

async function acceptAiControl(event) {
  event.preventDefault();
  if (!$('#aiRiskAccepted').checked) return;
  try {
    const saved = await window.ph.ai.configure({
      launcherControlEnabled: true,
      controlConsentVersion: Number(state.aiControlInfo?.consentVersion || 1),
      controlConsentAcceptedAt: new Date().toISOString(),
    });
    state.data.settings.ai = saved;
    $('#aiControlDialog').close();
    renderAiControl();
    toast('AI 启动器操作已开启；写入仍需逐次确认');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function proposalMarkup(proposal) {
  if (!proposal?.id || !Array.isArray(proposal.groups)) return '';
  const resolved = ['committed', 'canceled'].includes(proposal.status);
  const status = proposal.status === 'committed' ? '已写入' : proposal.status === 'canceled' ? '已取消' : proposal.status === 'working' ? '处理中' : '等待确认';
  const groups = proposal.groups.map((group) => `<section class="proposal-group"><b>${escapeHtml(group.title)}</b>${(group.items || []).map((item) => `<div class="proposal-item"><strong>${escapeHtml(item.primary)}</strong><span>${escapeHtml(item.secondary)}</span></div>`).join('')}</section>`).join('');
  return `<section class="ai-proposal-card${resolved ? ' resolved' : ''}" data-proposal-id="${escapeHtml(proposal.id)}">
    <div class="proposal-head"><div><strong>${escapeHtml(proposal.title || 'AI 建议的更改')}</strong><span>只有确认后才会保存到 PH Launcher</span></div><em>${escapeHtml(status)}</em></div>
    <div class="proposal-groups">${groups}</div>
    ${proposal.warning ? `<p class="proposal-warning">${escapeHtml(proposal.warning)}</p>` : ''}
    <div class="proposal-actions"><button class="ghost-button" data-cancel-proposal="${escapeHtml(proposal.id)}" ${proposal.status === 'working' ? 'disabled' : ''}>不采用</button><button class="primary-button" data-confirm-proposal="${escapeHtml(proposal.id)}" ${proposal.status === 'working' ? 'disabled' : ''}>核对无误，确认写入</button></div>
  </section>`;
}

function renderChat() {
  const messages = state.aiMessages.filter((message) => message.role !== 'system');
  $('#chatMessages').innerHTML = messages.map((message) => {
    const content = `<div class="chat-bubble">${escapeHtml(message.content)}</div>`;
    if (message.role === 'assistant' && message.proposal) {
      return `<div class="chat-message assistant"><div class="chat-response">${content}${proposalMarkup(message.proposal)}</div></div>`;
    }
    return `<div class="chat-message ${escapeHtml(message.role)}">${content}</div>`;
  }).join('') + (state.aiBusy ? '<div class="chat-message assistant"><div class="chat-bubble">正在处理…</div></div>' : '');
  $('#chatMessages').scrollTop = $('#chatMessages').scrollHeight;
  $('#aiSend').disabled = state.aiBusy;
}

function proposalMessage(proposalId) {
  return state.aiMessages.find((message) => message.proposal?.id === proposalId);
}

function committedSummary(counts = {}) {
  const parts = [];
  if (counts.tasksAdded) parts.push(`${counts.tasksAdded} 个任务`);
  if (counts.notesAdded) parts.push(`${counts.notesAdded} 条笔记`);
  if (counts.lessonsAdded) parts.push(`${counts.lessonsAdded} 节课程`);
  if (counts.lessonsUpdated) parts.push(`更新 ${counts.lessonsUpdated} 节课程`);
  if (counts.tasksChanged) parts.push(`${counts.tasksChanged} 个任务状态`);
  if (counts.unchanged) parts.push(`${counts.unchanged} 项已存在`);
  return parts.length ? parts.join('、') : '没有需要重复写入的内容';
}

async function confirmAiProposal(proposalId) {
  const message = proposalMessage(proposalId);
  if (!message || message.proposal.status === 'working') return;
  message.proposal.status = 'working';
  renderChat();
  try {
    const result = await window.ph.ai.confirmAction(proposalId);
    message.proposal.status = 'committed';
    if (result.data) state.data = result.data;
    renderAll();
    toast(`已写入：${committedSummary(result.counts)}`);
  } catch (error) {
    message.proposal.status = '';
    toast(`未写入：${error.message}`, 'error');
    renderChat();
  }
}

async function cancelAiProposal(proposalId) {
  const message = proposalMessage(proposalId);
  if (!message || message.proposal.status === 'working') return;
  await window.ph.ai.cancelAction(proposalId);
  message.proposal.status = 'canceled';
  renderChat();
  toast('已取消，未写入任何内容');
}

async function previewEduPageTimetable() {
  const ai = state.data.settings.ai;
  if (!ai.launcherControlEnabled) {
    openAiControlDialog();
    return;
  }
  if (state.aiBusy) return;
  state.aiMessages.push({ role: 'user', content: '请从我当前打开的 EduPage 常规课表生成导入预览。' });
  state.aiBusy = true;
  renderChat();
  try {
    const response = await window.ph.ai.previewEduPage();
    state.aiMessages.push({ role: 'assistant', content: response.content, proposal: response.proposal });
  } catch (error) {
    state.aiMessages.push({ role: 'assistant', content: `还不能读取课表：${error.message}\n\n请先打开 EduPage，登录并进入“常规课表”，然后回到这里重试。` });
  } finally {
    state.aiBusy = false;
    renderChat();
  }
}

async function sendAiMessage() {
  const input = $('#aiInput');
  const content = input.value.trim();
  if (!content || state.aiBusy) return;
  state.aiMessages.push({ role: 'user', content });
  input.value = '';
  state.aiBusy = true;
  renderChat();
  const system = {
    role: 'system',
    content: '你是 PH Launcher 的 IB 学习助手。优先用提问、拆解、例子和自测帮助学生真正理解；不要替学生完成需要本人思考或提交的作业。回答简洁、准确，明确不确定性；涉及课程评分标准时提醒核对教师要求和最新 IB 指南。用户要求你整理启动器内容时，使用提供的工具；任何写入都只是待确认方案，不能声称已经保存。',
  };
  try {
    const history = state.aiMessages.slice(-16).map(({ role, content: messageContent }) => ({ role, content: messageContent }));
    const response = await window.ph.ai.chat([system, ...history]);
    if (typeof response === 'string') state.aiMessages.push({ role: 'assistant', content: response || '没有收到有效回复。' });
    else state.aiMessages.push({ role: 'assistant', content: response?.content || '没有收到有效回复。', proposal: response?.proposal || null });
  } catch (error) {
    state.aiMessages.push({ role: 'assistant', content: `连接失败：${error.message}\n\n请检查模型服务或 API 设置。` });
  } finally {
    state.aiBusy = false;
    renderChat();
  }
}

function renderWebsiteSettings() {
  const descriptions = {
    mail: '登录页使用轻量显示；进入网易邮箱后只保留字体与滚动条优化。',
    managebac: '默认原网页，避免第三方页面更新影响课程与作业操作。',
    edupage: '轻量调整字体、圆角与留白，可随时恢复原网页。',
  };
  $('#websiteSettings').innerHTML = Object.entries(SITE_META).map(([id, site]) => `<div class="website-setting">
    <div class="site-card-icon ${id === 'mail' ? 'green' : id === 'managebac' ? 'wine' : 'gold'}">${icon(site.icon)}</div>
    <div><strong>${escapeHtml(site.name)}</strong><small>${escapeHtml(descriptions[id])}</small></div>
    <div class="website-setting-actions"><button class="clear-site-button" data-clear-site="${id}">清除登录数据</button><label class="switch"><input type="checkbox" data-clean-site="${id}" ${state.data.settings.siteCleanMode[id] ? 'checked' : ''}/><span></span></label></div>
  </div>`).join('');
}

function renderShortcutSettings() {
  const shortcuts = state.data.settings.shortcuts || {};
  $('#shortcutSettings').innerHTML = Object.entries(shortcuts).map(([action, shortcut]) => {
    const result = state.shortcutResults[action];
    return `<div class="shortcut-row" data-shortcut-row="${escapeHtml(action)}"><div><strong>${escapeHtml(shortcut.label || action)}</strong><small class="${result && !result.ok ? 'shortcut-error' : ''}">${result && !result.ok ? escapeHtml(result.error) : shortcut.enabled ? '已启用为全局快捷键' : '未启用'}</small></div><input type="text" data-shortcut-key="${escapeHtml(action)}" value="${escapeHtml(shortcut.accelerator || '')}"/><label class="switch"><input type="checkbox" data-shortcut-enabled="${escapeHtml(action)}" ${shortcut.enabled ? 'checked' : ''}/><span></span></label></div>`;
  }).join('');
}

function renderSettings() {
  if (!state.data) return;
  const settings = state.data.settings;
  $('#studentNameSetting').value = settings.studentName || '';
  $('#openAtLoginSetting').checked = Boolean(settings.openAtLogin);
  $('#minimizeTraySetting').checked = Boolean(settings.minimizeToTray);
  $('#reminderSetting').value = String(settings.defaultReminderMinutes ?? 10);
  $('#encryptionStatus').textContent = state.data.meta?.encrypted
    ? state.data.meta?.platform === 'darwin' ? '本地数据已使用 macOS 钥匙串保护' : '本地数据已使用当前系统用户密钥加密'
    : '当前系统无法提供加密，数据仅保存在本机';
  $('#dataPathLabel').textContent = state.data.meta?.dataPath || '';
  renderWebsiteSettings();
  renderShortcutSettings();
}

async function updateShortcut(action, patch) {
  const shortcut = state.data.settings.shortcuts[action];
  if (!shortcut) return;
  Object.assign(shortcut, patch);
  await persistData(true);
  state.shortcutResults = await window.ph.shortcuts.register();
  renderShortcutSettings();
}

function commandCatalog() {
  return [
    { id: 'today', label: '打开“今天”', description: '回到首页仪表盘', icon: 'i-home', shortcut: '' },
    { id: 'mail', label: '打开学校邮箱', description: '校园邮件与通知', icon: 'i-mail', shortcut: 'Ctrl 1' },
    { id: 'managebac', label: '打开 ManageBac', description: '课程、作业与 IB 进度', icon: 'i-grid', shortcut: 'Ctrl 2' },
    { id: 'edupage', label: '打开 EduPage', description: '课表与校园安排', icon: 'i-calendar', shortcut: 'Ctrl 3' },
    { id: 'new-task', label: '新建任务', description: '快速添加待办', icon: 'i-check', shortcut: 'Ctrl Shift A' },
    { id: 'new-note', label: '新建笔记', description: '创建一条本地笔记', icon: 'i-note', shortcut: 'Ctrl Shift N' },
    { id: 'dictionary', label: '打开离线词典', description: '本机英汉释义、音标与词形', icon: 'i-book', shortcut: 'Ctrl D' },
    { id: 'focus', label: '开始或暂停专注', description: '控制当前计时器', icon: 'i-clock', shortcut: 'Ctrl Shift P' },
    { id: 'plan', label: '打开计划', description: '任务、课程表与专注记录', icon: 'i-calendar', shortcut: '' },
    { id: 'ib', label: '打开 IB 工具', description: '指令词、字数与成绩试算', icon: 'i-flask', shortcut: '' },
    { id: 'ai', label: '打开 AI 学习助手', description: '可选的本地或 API AI', icon: 'i-spark', shortcut: '' },
    { id: 'settings', label: '打开设置', description: '快捷键、网站与数据', icon: 'i-settings', shortcut: 'Ctrl ,' },
  ];
}

function openCommandPalette() {
  $('#commandInput').value = '';
  state.commandIndex = 0;
  renderCommandPalette();
  $('#commandDialog').showModal();
  setTimeout(() => $('#commandInput').focus(), 20);
}

function renderCommandPalette() {
  const query = $('#commandInput').value.trim().toLowerCase();
  state.commandItems = commandCatalog().filter((item) => !query || `${item.label} ${item.description}`.toLowerCase().includes(query));
  if (state.commandIndex >= state.commandItems.length) state.commandIndex = Math.max(0, state.commandItems.length - 1);
  $('#commandList').innerHTML = state.commandItems.length
    ? state.commandItems.map((item, index) => `<button data-command-id="${escapeHtml(item.id)}" class="${index === state.commandIndex ? 'selected' : ''}">${icon(item.icon)}<div><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.description)}</span></div>${item.shortcut ? `<kbd>${escapeHtml(item.shortcut)}</kbd>` : ''}</button>`).join('')
    : '<div class="empty-row">没有匹配的操作</div>';
}

function executeCommand(commandId) {
  $('#commandDialog').close();
  if (SITE_META[commandId]) return openSite(commandId);
  if (ROUTE_META[commandId]) return navigate(commandId);
  if (commandId === 'new-task') openTaskDialog();
  if (commandId === 'new-note') { navigate('notes'); createNote(); }
  if (commandId === 'focus') toggleTimer();
}

function setPlanTab(tab) {
  state.planTab = tab;
  $$('[data-tab-group="plan"] button').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
  $$('[data-tab-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.tabPanel === tab));
  if (tab === 'tasks') renderTasks();
  if (tab === 'schedule') renderSchedule();
  if (tab === 'focus') { renderFocusStats(); updateTimerUi(); }
}

function renderAll() {
  updateClock();
  renderDashboard();
  renderTasks();
  renderSchedule();
  renderNotes();
  if (state.route === 'dictionary') renderDictionary();
  renderIbTools();
  renderAi();
  renderSettings();
  renderFocusStats();
  updateTimerUi();
}

function handleBodyClick(event) {
  const routeTarget = event.target.closest('[data-route]');
  if (routeTarget) {
    navigate(routeTarget.dataset.route);
    return;
  }
  const siteTarget = event.target.closest('[data-site]');
  if (siteTarget) {
    openSite(siteTarget.dataset.site);
    return;
  }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'quick-task') openTaskDialog();
  if (action === 'new-note') createNote();
  if (action === 'add-lesson') openLessonDialog();
  if (action === 'open-focus') { navigate('plan'); setPlanTab('focus'); }

  const siteAction = event.target.closest('[data-site-action]')?.dataset.siteAction;
  if (siteAction && state.activeSite) window.ph.sites.action(state.activeSite, siteAction);

  const tabButton = event.target.closest('[data-tab-group] button');
  if (tabButton) setPlanTab(tabButton.dataset.tab);
  const filterButton = event.target.closest('[data-filter]');
  if (filterButton) { state.taskFilter = filterButton.dataset.filter; renderTasks(); }
  const noteFilter = event.target.closest('[data-note-filter]');
  if (noteFilter) { state.noteFilter = noteFilter.dataset.noteFilter; renderNotes(); }

  const toggleTaskButton = event.target.closest('[data-toggle-task]');
  if (toggleTaskButton) { toggleTask(toggleTaskButton.dataset.toggleTask); return; }
  const editTaskButton = event.target.closest('[data-edit-task]');
  if (editTaskButton) {
    const task = state.data.tasks.find((item) => item.id === editTaskButton.dataset.editTask);
    if (task) openTaskDialog(task);
    return;
  }
  const lessonButton = event.target.closest('[data-lesson-id]');
  if (lessonButton) {
    const lesson = state.data.schedule.find((item) => item.id === lessonButton.dataset.lessonId);
    if (lesson) openLessonDialog(lesson);
    return;
  }
  const noteButton = event.target.closest('[data-note-id]');
  if (noteButton) { state.selectedNoteId = noteButton.dataset.noteId; renderNotes(); return; }
  const dictionaryWord = event.target.closest('[data-dict-word]')?.dataset.dictWord;
  if (dictionaryWord) { lookupDictionary(dictionaryWord); return; }
  const dictionaryExample = event.target.closest('[data-dict-example]')?.dataset.dictExample;
  if (dictionaryExample) { lookupDictionary(dictionaryExample); return; }
  if (event.target.closest('#dictionarySpeak')) speakDictionaryEntry();
  if (event.target.closest('#dictionaryToNote')) saveDictionaryEntryToNote();

  const settingsButton = event.target.closest('[data-settings-section]');
  if (settingsButton) {
    const section = settingsButton.dataset.settingsSection;
    $$('.settings-sections-nav button').forEach((button) => button.classList.toggle('active', button.dataset.settingsSection === section));
    $$('.settings-section').forEach((panel) => panel.classList.toggle('active', panel.dataset.settingsPanel === section));
  }

  const aiProvider = event.target.closest('[data-ai-provider]');
  if (aiProvider) {
    if (state.aiDeployment?.running && aiProvider.dataset.aiProvider !== 'local') {
      toast('请先取消正在进行的本地 AI 部署', 'error');
      return;
    }
    state.data.settings.ai.provider = aiProvider.dataset.aiProvider;
    state.data.settings.ai.enabled = false;
    $$('.ai-choice-list > button').forEach((button) => button.classList.toggle('active', button === aiProvider));
    renderAiConfig();
  }

  const template = event.target.closest('[data-template]');
  if (template) addMilestoneTemplate(template.dataset.template);
  const removeGrade = event.target.closest('[data-remove-grade]');
  if (removeGrade) {
    state.data.ib.gradeComponents = state.data.ib.gradeComponents.filter((row) => row.id !== removeGrade.dataset.removeGrade);
    renderGradeRows();
    persistData();
  }
  const closeDialog = event.target.closest('[data-close-dialog]');
  if (closeDialog) document.getElementById(closeDialog.dataset.closeDialog)?.close();
  const command = event.target.closest('[data-command-id]');
  if (command) executeCommand(command.dataset.commandId);
}

function bindEvents() {
  document.body.addEventListener('click', handleBodyClick);
  $('#taskForm').addEventListener('submit', saveTaskFromDialog);
  $('#lessonForm').addEventListener('submit', saveLessonFromDialog);
  $('#deleteTask').addEventListener('click', () => deleteTask($('#taskId').value));
  $('#deleteLesson').addEventListener('click', () => deleteLesson($('#lessonId').value));
  $('#taskSearch').addEventListener('input', (event) => { state.taskSearch = event.target.value; renderTasks(); });
  $('#noteSearch').addEventListener('input', (event) => { state.noteSearch = event.target.value; renderNotes(); });
  $('#dictionarySearch').addEventListener('input', (event) => {
    clearTimeout(dictionarySearchTimer);
    const query = event.target.value.trim();
    if (!query) return lookupDictionary('');
    dictionarySearchTimer = setTimeout(() => lookupDictionary(query), 180);
  });
  $('#dictionarySearch').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      clearTimeout(dictionarySearchTimer);
      lookupDictionary(event.target.value);
    }
  });
  $('#dictionaryClear').addEventListener('click', () => {
    clearTimeout(dictionarySearchTimer);
    $('#dictionarySearch').value = '';
    lookupDictionary('');
    $('#dictionarySearch').focus();
  });
  $('#commandSearch').addEventListener('input', renderCommandTerms);
  $('#wordCounterInput').addEventListener('input', updateWordStats);
  $('#wordToNote').addEventListener('click', () => {
    const body = $('#wordCounterInput').value.trim();
    if (!body) return toast('请先输入文本');
    createNote({ title: 'IB 文本草稿', body, subject: '通用' });
    navigate('notes');
    toast('已存为本地笔记');
  });
  $('#addGradeRow').addEventListener('click', () => {
    state.data.ib.gradeComponents.push({ id: uid(), name: `分项 ${state.data.ib.gradeComponents.length + 1}`, score: '', max: '100', weight: '' });
    renderGradeRows();
    persistData();
  });
  $('#gradeRows').addEventListener('input', (event) => {
    const field = event.target.dataset.gradeField;
    const rowId = event.target.closest('[data-grade-id]')?.dataset.gradeId;
    const row = state.data.ib.gradeComponents.find((item) => item.id === rowId);
    if (!field || !row) return;
    row[field] = event.target.value;
    calculateGrade();
    persistData();
  });

  $('#noteEditor').addEventListener('input', (event) => {
    if (event.target.id === 'noteTitleEdit') updateCurrentNote('title', event.target.value);
    if (event.target.id === 'noteBodyEdit') updateCurrentNote('body', event.target.value);
  });
  $('#noteEditor').addEventListener('change', (event) => {
    if (event.target.id === 'noteSubjectEdit') updateCurrentNote('subject', event.target.value);
  });
  $('#noteEditor').addEventListener('click', (event) => {
    if (event.target.closest('#pinNote')) {
      const note = state.data.notes.find((item) => item.id === state.selectedNoteId);
      if (note) { note.pinned = !note.pinned; note.updatedAt = new Date().toISOString(); persistData(); renderNotes(); }
    }
    if (event.target.closest('#deleteNote')) deleteCurrentNote();
    if (event.target.closest('#noteToTask')) noteToTask();
  });

  $('#saveQuickNote').addEventListener('click', () => {
    const body = $('#quickNoteInput').value.trim();
    if (!body) return toast('先写下一点内容');
    createNote({ title: body.split(/\r?\n/)[0].slice(0, 42), body, subject: '通用' });
    $('#quickNoteInput').value = '';
    toast('已保存到笔记');
  });

  $('#miniFocusPlay').addEventListener('click', toggleTimer);
  $('#focusPlay').addEventListener('click', toggleTimer);
  $('#focusReset').addEventListener('click', resetTimer);
  $('#focusSkip').addEventListener('click', skipTimerPhase);
  $('#focusPresets').addEventListener('click', (event) => {
    const button = event.target.closest('[data-focus]');
    if (button) setTimerPreset(Number(button.dataset.focus), Number(button.dataset.break));
  });

  $('#siteCleanToggle').addEventListener('change', async (event) => {
    if (!state.activeSite) return;
    state.data.settings.siteCleanMode[state.activeSite] = event.target.checked;
    await window.ph.sites.setClean(state.activeSite, event.target.checked);
    persistData();
  });
  $('#siteMenuButton').addEventListener('click', (event) => {
    event.stopPropagation();
    $('#sitePopover').classList.toggle('hidden');
  });
  $('#siteHomeAction').addEventListener('click', () => {
    if (state.activeSite) window.ph.sites.action(state.activeSite, 'home');
    $('#sitePopover').classList.add('hidden');
  });
  $('#siteClearAction').addEventListener('click', async () => {
    if (!state.activeSite) return;
    const name = SITE_META[state.activeSite].name;
    if (!confirm(`清除 ${name} 的登录状态、Cookie 与缓存？`)) return;
    await window.ph.sites.clearData(state.activeSite);
    $('#sitePopover').classList.add('hidden');
    toast(`${name} 的登录数据已清除`);
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#sitePopover') && !event.target.closest('#siteMenuButton')) $('#sitePopover').classList.add('hidden');
  });

  $('#commandButton').addEventListener('click', openCommandPalette);
  $('#commandInput').addEventListener('input', () => { state.commandIndex = 0; renderCommandPalette(); });
  $('#commandInput').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); state.commandIndex = Math.min(state.commandItems.length - 1, state.commandIndex + 1); renderCommandPalette(); }
    if (event.key === 'ArrowUp') { event.preventDefault(); state.commandIndex = Math.max(0, state.commandIndex - 1); renderCommandPalette(); }
    if (event.key === 'Enter') { event.preventDefault(); const item = state.commandItems[state.commandIndex]; if (item) executeCommand(item.id); }
  });

  $('#aiSend').addEventListener('click', sendAiMessage);
  $('#aiInput').addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) sendAiMessage(); });
  $$('.prompt-chips button[data-prompt]').forEach((button) => button.addEventListener('click', () => { $('#aiInput').value = button.dataset.prompt || ''; $('#aiInput').focus(); }));
  $('[data-ai-action="edupage"]').addEventListener('click', previewEduPageTimetable);
  $('#aiControlToggle').addEventListener('change', (event) => {
    if (event.target.checked) {
      event.target.checked = false;
      openAiControlDialog();
    } else {
      disableAiControl();
    }
  });
  $('#aiRiskAccepted').addEventListener('change', (event) => { $('#acceptAiControl').disabled = !event.target.checked; });
  $('#aiControlForm').addEventListener('submit', acceptAiControl);
  $('#chatMessages').addEventListener('click', (event) => {
    const confirmId = event.target.closest('[data-confirm-proposal]')?.dataset.confirmProposal;
    const cancelId = event.target.closest('[data-cancel-proposal]')?.dataset.cancelProposal;
    if (confirmId) confirmAiProposal(confirmId);
    if (cancelId) cancelAiProposal(cancelId);
  });
  $('#aiEditConfig').addEventListener('click', () => { state.aiEditing = true; renderAi(); });
  $('#aiConfigPanel').addEventListener('click', async (event) => {
    if (event.target.closest('#saveAiOff')) configureAi('off');
    if (event.target.closest('#saveLocalAi')) configureAi('local');
    if (event.target.closest('#saveApiAi')) configureAi('api');
    if (event.target.closest('#deployLocalAi')) startLocalAiDeployment();
    if (event.target.closest('#cancelLocalDeployment')) cancelLocalAiDeployment();
    if (event.target.closest('#openOllamaDownload')) window.ph.system.openUrl(state.hardware?.platform === 'darwin' ? 'https://ollama.com/download/mac' : 'https://ollama.com/download/windows');
    if (event.target.closest('#showDeploymentLog')) {
      window.ph.ai.showDeploymentLog().catch((error) => toast(error.message, 'error'));
    }
    if (event.target.closest('#refreshHardware')) {
      state.hardware = null;
      state.hardwareLoading = false;
      renderAiConfig();
      loadHardwareProfile();
    }
    if (event.target.closest('#copyModelCommand')) {
      const model = $('#localModelInput')?.value.trim() || state.hardware?.recommendation?.model || '';
      if (!model) return toast('当前检测不建议安装本地模型；没有可复制的推荐命令', 'error');
      await navigator.clipboard.writeText(`ollama run ${model}`);
      toast('模型命令已复制');
    }
    if (event.target.closest('#clearApiKey')) {
      const saved = await window.ph.ai.configure({ clearApiKey: true, enabled: false });
      state.data.settings.ai = saved;
      renderAiConfig();
      toast('API Key 已删除');
    }
  });

  $('#studentNameSetting').addEventListener('input', (event) => { state.data.settings.studentName = event.target.value; updateClock(); persistData(); });
  $('#openAtLoginSetting').addEventListener('change', (event) => { state.data.settings.openAtLogin = event.target.checked; persistData(true); });
  $('#minimizeTraySetting').addEventListener('change', (event) => { state.data.settings.minimizeToTray = event.target.checked; persistData(true); });
  $('#reminderSetting').addEventListener('change', (event) => { state.data.settings.defaultReminderMinutes = Number(event.target.value); persistData(); });
  $('#websiteSettings').addEventListener('change', async (event) => {
    const siteId = event.target.dataset.cleanSite;
    if (!siteId) return;
    state.data.settings.siteCleanMode[siteId] = event.target.checked;
    await window.ph.sites.setClean(siteId, event.target.checked);
    persistData();
  });
  $('#websiteSettings').addEventListener('click', async (event) => {
    const siteId = event.target.closest('[data-clear-site]')?.dataset.clearSite;
    if (!siteId || !confirm(`清除 ${SITE_META[siteId].name} 的全部登录数据？`)) return;
    await window.ph.sites.clearData(siteId);
    toast(`${SITE_META[siteId].name} 的登录数据已清除`);
  });
  $('#shortcutSettings').addEventListener('change', (event) => {
    if (event.target.dataset.shortcutEnabled) updateShortcut(event.target.dataset.shortcutEnabled, { enabled: event.target.checked });
    if (event.target.dataset.shortcutKey) updateShortcut(event.target.dataset.shortcutKey, { accelerator: event.target.value.trim() });
  });
  $('#exportData').addEventListener('click', async () => {
    const result = await window.ph.data.export();
    if (result.ok) toast('备份已导出；API Key 未包含在备份中');
  });
  $('#importData').addEventListener('click', async () => {
    if (!confirm('恢复备份会替换当前笔记、任务、课程表和设置，继续吗？')) return;
    try {
      const result = await window.ph.data.import();
      if (result.ok) { state.data = result.data; state.selectedNoteId = null; renderAll(); toast('备份已恢复'); }
    } catch (error) { toast(`恢复失败：${error.message}`, 'error'); }
  });
  $('#showData').addEventListener('click', () => window.ph.system.showData());

  document.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'k') { event.preventDefault(); openCommandPalette(); }
    if (mod && !event.shiftKey && event.key === '1') { event.preventDefault(); openSite('mail'); }
    if (mod && !event.shiftKey && event.key === '2') { event.preventDefault(); openSite('managebac'); }
    if (mod && !event.shiftKey && event.key === '3') { event.preventDefault(); openSite('edupage'); }
    if (mod && !event.shiftKey && event.key.toLowerCase() === 'd') { event.preventDefault(); navigate('dictionary'); }
    if (mod && event.shiftKey && event.key.toLowerCase() === 'n') { event.preventDefault(); navigate('notes'); createNote(); }
    if (mod && event.shiftKey && event.key.toLowerCase() === 'a') { event.preventDefault(); openTaskDialog(); }
    if (mod && event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); toggleTimer(); }
    if (mod && event.key === ',') { event.preventDefault(); navigate('settings'); }
    if (event.key === 'F5' && state.activeSite) { event.preventDefault(); window.ph.sites.action(state.activeSite, 'reload'); }
    if (event.key === 'Escape') $('#sitePopover').classList.add('hidden');
  });
}

async function init() {
  bindEvents();
  try {
    const [appVersion, data, deployment] = await Promise.all([
      window.ph.system.version(),
      window.ph.data.get(),
      window.ph.ai.deploymentState(),
    ]);
    state.data = data;
    state.aiDeployment = deployment;
    $('#appVersion').textContent = `Version ${appVersion}`;
    const platform = state.data.meta?.platform || 'win32';
    document.body.classList.add(`platform-${platform}`);
    if (platform === 'darwin') {
      $('#commandButton kbd').textContent = '⌘ K';
      $('.settings-nav kbd').textContent = '⌘ ,';
    }
    if (!state.data.ib) state.data.ib = { milestones: [], commandSearches: [], gradeComponents: [] };
    if (!Array.isArray(state.data.notes)) state.data.notes = [];
    if (!Array.isArray(state.data.tasks)) state.data.tasks = [];
    if (!Array.isArray(state.data.schedule)) state.data.schedule = [];
    if (!Array.isArray(state.data.focusSessions)) state.data.focusSessions = [];
    ensureTimer();
    state.selectedNoteId = [...state.data.notes].sort(noteSort)[0]?.id || null;
    renderAll();
    navigate('today');
    setPlanTab('tasks');
    state.shortcutResults = await window.ph.shortcuts.register();
  } catch (error) {
    toast(`启动失败：${error.message}`, 'error');
  }
  window.ph.sites.onState(handleSiteState);
  window.ph.shortcuts.onAction((action) => {
    if (SITE_META[action]) openSite(action);
    else if (action === 'dictionary') navigate('dictionary');
    else if (action === 'quickNote') { navigate('notes'); createNote(); }
    else if (action === 'focus') toggleTimer();
  });
  window.ph.shortcuts.onResults((results) => {
    state.shortcutResults = results || {};
    if (state.route === 'settings') renderShortcutSettings();
  });
  window.ph.ai.onDeployment((deployment) => {
    const previousStage = state.aiDeployment?.stage;
    state.aiDeployment = deployment;
    if (state.route === 'ai') {
      if (deployment.stage === 'complete' && state.data?.settings?.ai?.enabled) {
        state.aiEditing = false;
        renderAi();
      } else if (!$('#aiSetup').classList.contains('hidden')) {
        renderAiConfig();
      }
    }
    if (deployment.stage !== previousStage) {
      if (deployment.stage === 'complete') toast('本地 AI 已部署并启用');
      if (deployment.stage === 'error') toast(`部署未完成：${deployment.detail || '请查看部署日志'}`, 'error');
      if (deployment.stage === 'canceled') toast('本地 AI 部署已取消');
    }
  });
  window.ph.ai.onCommand((command) => {
    if (command?.type === 'navigate') {
      if (SITE_META[command.target]) openSite(command.target);
      else if (ROUTE_META[command.target]) navigate(command.target);
    }
    if (command?.type === 'focus') {
      const timer = ensureTimer();
      if (command.action === 'start' && !timer.running) toggleTimer();
      if (command.action === 'pause' && timer.running) toggleTimer();
      if (command.action === 'reset') resetTimer();
    }
  });
  window.ph.data.onChanged((data) => { state.data = data; renderAll(); });
  setInterval(updateClock, 60_000);
  setInterval(updateTimerUi, 500);
  document.body.dataset.initialized = 'true';
}

document.addEventListener('DOMContentLoaded', init);

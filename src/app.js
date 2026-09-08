const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const BUILTIN_SITE_META = {
  mail: { name: '平和邮箱', icon: 'i-mail', url: 'https://mail.shphschool.com/' },
  managebac: { name: 'ManageBac', icon: 'i-grid', url: 'https://shph.managebac.cn/login' },
  edupage: { name: 'EduPage', icon: 'i-calendar', url: 'https://pingheschool.edupage.org/' },
};
const SITE_META = { ...BUILTIN_SITE_META };
const CUSTOM_SITE_COLORS = new Set(['green', 'wine', 'gold', 'blue', 'slate']);
const ROUTE_META = {
  today: { title: '今天', eyebrow: 'PH LAUNCHER' },
  plan: { title: '计划', eyebrow: 'PLAN & FOCUS' },
  notes: { title: '笔记', eyebrow: 'LOCAL NOTES' },
  dictionary: { title: '离线词典', eyebrow: 'OFFLINE DICTIONARY' },
  vocabulary: { title: '背单词', eyebrow: 'WORDS IN CONTEXT' },
  timetable: { title: '我的课表', eyebrow: 'MY TIMETABLE', page: 'school' },
  calendar: { title: '我的日程', eyebrow: 'MY CALENDAR' },
  mail: { title: '平和邮箱', eyebrow: 'SCHOOL MAIL' },
  'class-timetable': { title: '班级课表', eyebrow: 'CLASS TIMETABLE', page: 'school' },
  courses: { title: '我的课程', eyebrow: 'MY COURSES', page: 'school' },
  ib: { title: 'IB 工具', eyebrow: 'IB TOOLKIT' },
  ai: { title: 'AI 学习助手', eyebrow: 'OPTIONAL AI' },
  settings: { title: '设置', eyebrow: 'PREFERENCES' },
};
const ROUTE_ALIASES = { school: 'timetable' };
const SCHOOL_WORKSPACE_ROUTES = new Set(['timetable', 'class-timetable', 'courses']);
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
  aiEditConfig: null,
  aiMessages: [],
  aiBusy: false,
  aiRequestId: '',
  aiStreamStatus: '',
  aiLocalWarmup: { localWarmup: 'idle', detail: '' },
  aiUseMemories: undefined,
  aiMemoryProvider: '',
  aiControlInfo: null,
  aiPendingPermissionMode: '',
  shortcutResults: {},
  credentialStatus: null,
  ibCommandCatalog: null,
  commandSubject: 'common',
  commandItems: [],
  commandIndex: 0,
  timerFinishing: false,
};

let persistTimer = null;
let dictionarySearchTimer = null;
let vocabularyBadgeRequest = 0;
let credentialSubmitInFlight = false;

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

function customSites() {
  return Array.isArray(state.data?.settings?.customSites) ? state.data.settings.customSites : [];
}

function customSiteMonogram(name) {
  const characters = [...String(name || '').trim()];
  return characters.slice(0, 2).join('').toUpperCase() || 'WEB';
}

function refreshSiteMeta() {
  for (const id of Object.keys(SITE_META)) {
    if (!BUILTIN_SITE_META[id]) delete SITE_META[id];
  }
  for (const site of customSites()) {
    SITE_META[site.id] = {
      name: site.name,
      icon: 'i-external',
      url: site.url,
      color: CUSTOM_SITE_COLORS.has(site.color) ? site.color : 'green',
      shortcut: site.shortcut || '',
      shortcutEnabled: Boolean(site.shortcutEnabled),
      custom: true,
    };
  }
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
    persistTimer = null;
    const submitted = structuredClone(state.data);
    try {
      const saved = await window.ph.data.save(submitted);
      // Typing may continue while the save is in flight. Keep edits made since
      // submission instead of replacing them with the older server response.
      for (const key of Object.keys(saved)) {
        if (JSON.stringify(state.data[key]) === JSON.stringify(submitted[key])) state.data[key] = saved[key];
      }
      saveState?.classList.remove('saving');
      if (saveState) saveState.lastChild.textContent = '已保存';
      return true;
    } catch (error) {
      saveState?.classList.remove('saving');
      if (saveState) saveState.lastChild.textContent = '保存失败';
      toast(`保存失败：${error.message}`, 'error');
      return false;
    }
  };
  if (immediate) return await commit();
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
  route = ROUTE_ALIASES[route] || route;
  if (!ROUTE_META[route]) return;
  state.route = route;
  state.activeSite = null;
  window.ph.sites.hide();
  const pageRoute = ROUTE_META[route].page || route;
  const applyRoute = () => {
    $$('.page').forEach((page) => page.classList.toggle('active', page.dataset.page === pageRoute));
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
    if (route === 'vocabulary') {
      window.vocabularyUI?.refresh();
      refreshVocabularyBadge();
    }
    if (SCHOOL_WORKSPACE_ROUTES.has(route)) {
      if (typeof window.schoolUI?.open === 'function') window.schoolUI.open(route);
      else window.schoolUI?.refresh();
    }
    if (route === 'calendar') window.calendarUI?.refresh();
    if (route === 'mail') window.mailUI?.open();
    if (route === 'dictionary') {
      renderDictionary();
      loadDictionaryInfo();
      setTimeout(() => $('#dictionarySearch')?.focus(), 30);
    }
    if (route === 'ib') renderIbTools();
    if (route === 'ai') renderAi();
    if (route === 'settings') renderSettings();
    $('#content').scrollTop = 0;
  };
  applyRoute();
}

async function openSite(siteId) {
  if (siteId === 'mail') return navigate('mail');
  const site = SITE_META[siteId];
  if (!site) return;
  state.activeSite = siteId;
  state.route = null;
  $$('.page').forEach((page) => page.classList.remove('active'));
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.site === siteId));
  $('#siteToolbar').classList.remove('hidden');
  $('#internalTopActions').classList.add('hidden');
  setTopbar(site.name, site.custom ? 'MY WEBSITE' : 'SCHOOL APP');
  const siteState = state.siteStates[siteId];
  $('#siteLocation').textContent = siteState?.url || site.url;
  try {
    const opened = await window.ph.sites.open(siteId);
    if (!opened) {
      toast('网页已不存在或地址无效', 'error');
      navigate('today');
    }
  } catch (error) {
    toast(`${site.name} 暂时无法连接：${error.message}`, 'error');
  }
}

function handleSiteState(siteState) {
  const site = SITE_META[siteState.id];
  if (!site) return;
  const previous = state.siteStates[siteState.id];
  state.siteStates[siteState.id] = siteState;
  const nav = $(`.site-nav[data-site="${siteState.id}"]`);
  nav?.classList.toggle('connected', !siteState.error && Boolean(siteState.url));
  if (state.activeSite !== siteState.id) return;
  $('#siteLocation').textContent = siteState.url || site.url;
  const back = $('[data-site-action="back"]');
  const forward = $('[data-site-action="forward"]');
  back.disabled = !siteState.canGoBack;
  forward.disabled = !siteState.canGoForward;
  if (siteState.error && siteState.error !== previous?.error) toast(`${site.name}：${siteState.error}`, 'error');
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
      if (lesson.date && localDateKey(day) !== lesson.date) continue;
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

function setNavCountBadge(badgeSelector, navSelector, label, rawCount) {
  const badge = $(badgeSelector);
  const nav = $(navSelector);
  if (!badge || !nav) return;
  const count = Math.max(0, Math.floor(Number(rawCount) || 0));
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.dataset.count = String(count);
  badge.classList.toggle('hidden', count === 0);
  nav.setAttribute('aria-label', count ? `${label}，${count} 项待处理` : label);
}

function updateVocabularyBadge(payload) {
  const due = typeof payload === 'number' ? payload : payload?.due ?? payload?.stats?.due ?? payload?.snapshot?.stats?.due;
  if (!Number.isFinite(Number(due))) return;
  setNavCountBadge('#vocabularyDueCount', '#vocabularyNav', '背单词', due);
}

async function refreshVocabularyBadge() {
  const api = window.ph?.vocabulary;
  if (!api) return;
  const request = ++vocabularyBadgeRequest;
  try {
    const result = typeof api.dueCount === 'function' ? await api.dueCount() : await api.get('');
    if (request === vocabularyBadgeRequest) updateVocabularyBadge(result);
  } catch {
    // Keep the last known local count when the vocabulary store is temporarily unavailable.
  }
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
  setNavCountBadge('#navTaskCount', '#planNav', '计划', count);
  renderCustomSites();
}

function siteHostname(rawUrl) {
  try { return new URL(rawUrl).hostname; } catch { return rawUrl || ''; }
}

function renderCustomSiteNavigation() {
  const container = $('#customSiteNav');
  if (!container) return;
  container.innerHTML = customSites().map((site) => {
    const color = CUSTOM_SITE_COLORS.has(site.color) ? site.color : 'green';
    return `<button class="nav-item site-nav custom-site-nav-item" data-site="${escapeHtml(site.id)}"><i class="custom-nav-mark ${color}">${escapeHtml(customSiteMonogram(site.name))}</i><span>${escapeHtml(site.name)}</span><i class="status-dot"></i></button>`;
  }).join('');
}

function renderCustomSiteCards() {
  const container = $('#customSiteCards');
  if (!container) return;
  const sites = customSites();
  container.innerHTML = sites.length
    ? sites.map((site) => {
      const color = CUSTOM_SITE_COLORS.has(site.color) ? site.color : 'green';
      return `<article class="site-card custom-site-card color-${color}" data-site="${escapeHtml(site.id)}"><div class="site-card-icon custom-site-monogram">${escapeHtml(customSiteMonogram(site.name))}</div><div><span>我的网页</span><h4>${escapeHtml(site.name)}</h4><p>${escapeHtml(siteHostname(site.url))} · 独立登录空间</p></div><button>打开<svg><use href="#i-arrow"/></svg></button></article>`;
    }).join('')
    : '<button class="custom-site-empty" type="button" data-action="add-custom-site"><span>＋</span><strong>添加常用网页</strong><small>只需名称和 HTTPS 地址</small></button>';
}

function renderCustomSites() {
  refreshSiteMeta();
  renderCustomSiteNavigation();
  renderCustomSiteCards();
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
  let notice = $('#lessonDateNotice');
  if (!notice) {
    notice = document.createElement('p'); notice.id = 'lessonDateNotice';
    $('#lessonForm .modal-head').after(notice);
  }
  notice.textContent = lesson?.date ? `仅 ${lesson.date} 当天生效；重新同步可更新日期与教学组。` : '每周重复课程';
  $('#lessonDay').disabled = Boolean(lesson?.date);
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
      .filter((lesson) => Number(lesson.dayOfWeek) === day.value && (!lesson.date || (() => {
        const date = new Date(); date.setDate(date.getDate() - (date.getDay() + 6) % 7 + (day.value + 6) % 7);
        return localDateKey(date) === lesson.date;
      })()))
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
    <div class="dictionary-actions"><button class="primary-button" id="dictionaryToVocabulary">${icon('i-plus')}加入词本</button><button class="secondary-button" id="dictionaryToNote">${icon('i-note')}保存到笔记</button><span>离线查询 · 不会发送搜索内容</span></div>`;
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
  const catalog = state.ibCommandCatalog;
  if (!catalog) {
    $('#commandResults').innerHTML = '<div class="empty-row">正在准备科目词表…</div>';
    return;
  }
  const subjectSelect = $('#commandSubject');
  if (!subjectSelect.options.length) {
    const groups = new Map();
    for (const subject of catalog.subjects) {
      if (!groups.has(subject.group)) groups.set(subject.group, []);
      groups.get(subject.group).push(subject);
    }
    subjectSelect.innerHTML = [...groups.entries()].map(([group, subjects]) => `<optgroup label="${escapeHtml(group)}">${subjects.map((subject) => `<option value="${escapeHtml(subject.id)}">${escapeHtml(subject.label)}</option>`).join('')}</optgroup>`).join('');
  }
  if (!catalog.subjects.some((subject) => subject.id === state.commandSubject)) state.commandSubject = catalog.defaultSubjectId || 'common';
  subjectSelect.value = state.commandSubject;
  const query = $('#commandSearch')?.value.trim().toLowerCase() || '';
  const terms = catalog.terms.filter((term) => {
    const inSubject = state.commandSubject === 'all' || term.subjectIds.includes(state.commandSubject);
    const searchable = [term.term, term.chinese, term.action, ...(term.aliases || [])].join(' ').toLocaleLowerCase('zh-CN');
    return inSubject && (!query || searchable.includes(query));
  });
  const subject = catalog.subjects.find((item) => item.id === state.commandSubject);
  const edition = subject?.edition ? ` · ${subject.edition}` : '';
  $('#commandSourceNote').textContent = `${subject?.label || '所选科目'}${edition} · ${terms.length} 条。${catalog.note}`;
  const guideLink = $('#commandGuideLink');
  guideLink.classList.toggle('hidden', !subject?.sourceUrl);
  $('#commandResults').innerHTML = terms.length
    ? terms.map((term) => {
      const objectives = state.commandSubject === 'all' ? [] : (term.subjectObjectives?.[state.commandSubject] || []);
      const objectiveBadge = objectives.length
        ? `<span class="command-objective">${escapeHtml(objectives.join(' · '))}</span>`
        : '';
      return `<div class="command-item"><div class="command-item-head"><strong>${escapeHtml(term.term)}</strong><span class="command-chinese">${escapeHtml(term.chinese)}</span>${objectiveBadge}</div><p>${escapeHtml(term.action)}</p></div>`;
    }).join('')
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
      sessionStarted: false,
      target: '',
      goal: '',
    };
  }
  const timer = state.data.settings.timer;
  if (!Number.isInteger(Number(timer.focusMinutes)) || Number(timer.focusMinutes) < 1 || Number(timer.focusMinutes) > 180) timer.focusMinutes = 25;
  if (typeof timer.target !== 'string') timer.target = '';
  if (typeof timer.goal !== 'string') timer.goal = '';
  if (typeof timer.sessionStarted !== 'boolean') timer.sessionStarted = Boolean(timer.running);
  return timer;
}

const FOCUS_ROUTE_TARGETS = [
  ['vocabulary', '背单词'],
  ['notes', '笔记'],
  ['courses', '我的课程'],
  ['timetable', '我的课表'],
  ['calendar', '我的日程'],
  ['dictionary', '离线词典'],
  ['ib', 'IB 工具'],
];

function focusTargetInfo(value) {
  if (!value) return null;
  if (value.startsWith('route:')) {
    const route = value.slice(6);
    const target = FOCUS_ROUTE_TARGETS.find(([id]) => id === route);
    return target ? { type: 'route', id: target[0], label: target[1] } : null;
  }
  if (value.startsWith('site:')) {
    const id = value.slice(5);
    const site = customSites().find((item) => item.id === id);
    return site ? { type: 'site', id: site.id, label: site.name } : null;
  }
  return null;
}

function renderFocusSettings() {
  const timer = ensureTimer();
  const select = $('#focusTargetInput');
  if (!select) return;
  const routeOptions = FOCUS_ROUTE_TARGETS.map(([id, label]) => `<option value="route:${id}">${escapeHtml(label)}</option>`).join('');
  const siteOptions = customSites().map((site) => `<option value="site:${escapeHtml(site.id)}">${escapeHtml(site.name)}</option>`).join('');
  select.innerHTML = `<option value="">不指定目标</option><optgroup label="学习工具">${routeOptions}</optgroup>${siteOptions ? `<optgroup label="我的网页">${siteOptions}</optgroup>` : ''}`;
  select.value = focusTargetInfo(timer.target) ? timer.target : '';
  $('#focusGoalInput').value = timer.goal;
  $('#focusMinutesInput').value = String(timer.nextFocusMinutes || timer.focusMinutes || 25);
  $('#focusSettingsHint').textContent = timer.running || timer.sessionStarted
    ? '本轮计时保持不变；新时长会从下一轮开始使用。'
    : '本轮开始前可设置 1–180 分钟；目标可以留空。';
}

function openFocusSettings() {
  renderFocusSettings();
  $('#focusSettingsDialog').showModal();
  setTimeout(() => $('#focusMinutesInput').focus(), 30);
}

function saveFocusSettings(event) {
  event.preventDefault();
  const minutes = Number($('#focusMinutesInput').value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) return toast('专注时长须为 1–180 分钟', 'error');
  const target = $('#focusTargetInput').value;
  if (target && !focusTargetInfo(target)) return toast('请选择启动器内现有的学习入口', 'error');
  const goal = $('#focusGoalInput').value.trim();
  if (goal.length > 120) return toast('本轮目标最多 120 个字符', 'error');
  const timer = ensureTimer();
  timer.target = target;
  timer.goal = goal;
  if (timer.running || timer.sessionStarted) {
    timer.nextFocusMinutes = minutes;
    timer.nextBreakMinutes = timer.breakMinutes;
    timer.nextMode = 'countdown';
  } else {
    timer.mode = 'countdown';
    timer.phase = 'focus';
    timer.focusMinutes = minutes;
    timer.durationMs = minutes * 60_000;
    timer.remainingMs = timer.durationMs;
    timer.elapsedMs = 0;
  }
  $('#focusSettingsDialog').close();
  persistData();
  updateTimerUi();
  toast(timer.running || timer.sessionStarted ? '目标已更新；新时长将在下一轮生效' : '本轮专注设置已保存');
}

function openFocusTarget() {
  const target = focusTargetInfo(ensureTimer().target);
  if (!target) return;
  if (target.type === 'route') navigate(target.id);
  else openSite(target.id);
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
  $('#focusPlayIcon').innerHTML = icon(playIcon);
  const playLabel = timer.running ? '暂停' : timer.sessionStarted ? '继续' : '开始';
  $('#focusPlayLabel').textContent = playLabel;
  $('#focusPlay').setAttribute('aria-label', playLabel);
  $('#miniFocusPlay').setAttribute('aria-label', playLabel);
  $('#miniFocusPlay').classList.toggle('timer-pause-icon', timer.running);
  $('#focusPlay').classList.toggle('timer-pause-icon', timer.running);
  const active = Boolean(timer.running || timer.sessionStarted);
  $('#miniFocusStop')?.classList.toggle('hidden', !active);
  $('#focusResetLabel').textContent = active ? '结束并重置' : '重置';
  $('#focusReset').setAttribute('aria-label', active ? '结束本轮并重置，不计入完成记录' : '重置');
  const target = focusTargetInfo(timer.target);
  const focusLabel = timer.goal || target?.label || '';
  $('#focusTargetLabel').textContent = focusLabel ? `本轮目标：${focusLabel}` : '本轮未指定目标';
  $('#miniFocusTarget').textContent = focusLabel || '设置本轮';
  $('#focusOpenTarget').classList.toggle('hidden', !target || !timer.sessionStarted);
  $('#miniFocusTarget').classList.toggle('active', Boolean(target && timer.sessionStarted));
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
    timer.sessionStarted = true;
    if (timer.mode === 'stopwatch') timer.startedAt = Date.now();
    else timer.endAt = Date.now() + Math.max(1_000, Number(timer.remainingMs || timer.durationMs));
  }
  persistData();
  updateTimerUi();
}

function resetTimer() {
  const timer = ensureTimer();
  const wasActive = Boolean(timer.running || timer.sessionStarted);
  timer.running = false;
  timer.endAt = 0;
  timer.startedAt = 0;
  timer.elapsedMs = 0;
  timer.sessionStarted = false;
  applyPendingTimerSettings(timer);
  if (timer.mode === 'countdown') {
    timer.durationMs = (timer.phase === 'break' ? timer.breakMinutes : timer.focusMinutes) * 60_000;
    timer.remainingMs = timer.durationMs;
  }
  persistData();
  updateTimerUi();
  if (wasActive) toast('本轮已结束，未计入完成记录');
}

function applyPendingTimerSettings(timer) {
  if (!Number.isInteger(Number(timer.nextFocusMinutes))) return;
  timer.focusMinutes = Number(timer.nextFocusMinutes);
  timer.breakMinutes = Number(timer.nextBreakMinutes || timer.breakMinutes || 5);
  timer.mode = timer.nextMode === 'stopwatch' ? 'stopwatch' : 'countdown';
  delete timer.nextFocusMinutes;
  delete timer.nextBreakMinutes;
  delete timer.nextMode;
}

function setTimerPreset(focusMinutes, breakMinutes) {
  const timer = ensureTimer();
  if (timer.running || timer.sessionStarted) {
    timer.nextFocusMinutes = focusMinutes || 25;
    timer.nextBreakMinutes = breakMinutes || 5;
    timer.nextMode = focusMinutes === 0 ? 'stopwatch' : 'countdown';
    persistData();
    updateTimerUi();
    toast('预设将在下一轮开始时生效');
    return;
  }
  timer.running = false;
  timer.sessionStarted = false;
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
    target: ensureTimer().target || '',
    goal: ensureTimer().goal || '',
  });
  state.data.focusSessions = state.data.focusSessions.slice(0, 500);
}

async function finishTimerPhase() {
  state.timerFinishing = true;
  const timer = ensureTimer();
  timer.running = false;
  timer.sessionStarted = false;
  timer.endAt = 0;
  if (timer.phase === 'focus') {
    recordFocusSession(Number(timer.durationMs || 0) / 60_000 || Number(timer.focusMinutes || 25), true);
    timer.phase = 'break';
    timer.durationMs = Number(timer.breakMinutes || 5) * 60_000;
    timer.remainingMs = timer.durationMs;
    await window.ph.system.notify({ id: state.data.focusSessions[0]?.id, title: '专注完成', body: `${timer.goal ? `${timer.goal}\n` : ''}完成 ${timer.focusMinutes} 分钟专注，休息一下吧。` });
    toast('专注完成，进入休息阶段');
  } else {
    applyPendingTimerSettings(timer);
    timer.phase = 'focus';
    timer.durationMs = Number(timer.focusMinutes || 25) * 60_000;
    timer.remainingMs = timer.durationMs;
    await window.ph.system.notify({ id: `break-${Date.now()}`, title: '休息结束', body: '准备好后，开始下一轮专注。' });
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
    timer.running = false;
    timer.sessionStarted = false;
    timer.elapsedMs = 0;
    timer.startedAt = 0;
  } else {
    timer.running = false;
    timer.sessionStarted = false;
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
  return (state.data.focusSessions || []).filter((item) => item.completed !== false && new Date(item.endedAt).getTime() >= start.getTime());
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
  const enabled = isAiConfigured(ai);
  const showSetup = !enabled || state.aiEditing;
  if (showSetup && !state.aiEditConfig) state.aiEditConfig = { ...ai };
  if (!showSetup) state.aiEditConfig = null;
  const returnToChat = Boolean(state.aiEditing && isAiConfigured(state.aiEditConfig));
  const actionContainer = $('.ai-page-actions');
  let backButton = $('#aiBackNavigation');
  if (actionContainer && !backButton) {
    backButton = document.createElement('button');
    backButton.type = 'button';
    backButton.id = 'aiBackNavigation';
    backButton.className = 'secondary-button';
    backButton.addEventListener('click', leaveAiSetup);
    actionContainer.prepend(backButton);
  }
  if (backButton) {
    backButton.textContent = returnToChat ? '← 返回对话' : '← 返回首页';
    backButton.classList.toggle('hidden', !showSetup);
  }
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

function isAiConfigured(ai) {
  if (!ai?.enabled) return false;
  if (ai.provider === 'local') return Boolean(String(ai.localModel || '').trim());
  if (ai.provider === 'api') return Boolean(String(ai.apiModel || '').trim());
  return false;
}

function beginAiEditing() {
  cancelAiStream();
  state.aiEditConfig = { ...state.data.settings.ai };
  state.aiEditing = true;
  renderAi();
}

function leaveAiSetup() {
  const previousConfig = state.aiEditConfig;
  const returnToChat = isAiConfigured(previousConfig);
  if (previousConfig) state.data.settings.ai = { ...previousConfig };
  state.aiEditConfig = null;
  state.aiEditing = false;
  if (returnToChat) {
    renderAi();
    setTimeout(() => $('#aiInput')?.focus(), 30);
    return;
  }
  navigate('today');
  setTimeout(() => $('[data-route="today"]')?.focus(), 30);
}

function renderAiControl() {
  window.agentUI?.render();
  const ai = state.data?.settings?.ai || {};
  const enabled = Boolean(ai.launcherControlEnabled && ai.controlConsentVersion);
  const full = enabled && ai.permissionMode === 'full' && ai.mailReadEnabled === true && ai.mailConsentVersion === 2;
  $('#aiControlToggle').checked = enabled;
  $('#aiControlStatus').textContent = enabled
    ? full
      ? ai.provider === 'local' ? '已授权完整权限 · 可按请求读取启动器学习资料 · 写入前确认' : '已授权完整权限 · API 会发送你请求的启动器学习资料 · 写入前确认'
      : ai.provider === 'local' ? '已授权操作前确认 · 不读取收件箱' : '已授权操作前确认 · API 模式会发送被读取的内容'
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
      ? `本机推荐：${recommendedModel}。较小模型通常准备更快，也更节省内存。`
      : '当前检测结果不建议安装本地模型；如你了解风险，仍可手动填写已安装的模型名称。';
    panel.innerHTML = `<h3>本地 AI</h3><p>PH Launcher 会按每台电脑的内存、显卡与磁盘空间推荐模型；同学安装时会得到各自的结果。仅在选择本地 AI 时，启动器会随程序准备模型；选择 API AI 或暂不启用时不会启动本地模型。</p>
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
    cancelAiStream();
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
    state.aiEditConfig = null;
    await window.agentUI?.loadHistory?.();
    renderAi();
    toast(provider === 'off' ? 'AI 已保持关闭' : 'AI 连接设置已保存');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function pendingAiPermissionMode() {
  return state.aiPendingPermissionMode === 'full' ? 'full' : 'confirm';
}

function refreshAiControlAcceptance() {
  const full = pendingAiPermissionMode() === 'full';
  $('#acceptAiControl').disabled = !$('#aiRiskAccepted').checked || full && !$('#aiMailRiskAccepted').checked;
}

async function openAiControlDialog(mode = 'confirm') {
  state.aiPendingPermissionMode = mode === 'full' ? 'full' : 'confirm';
  try {
    state.aiControlInfo = await window.ph.ai.controlInfo();
  } catch {
    state.aiControlInfo = { consentVersion: 1, mailConsentVersion: 2 };
  }
  const full = pendingAiPermissionMode() === 'full';
  $('#aiRiskAccepted').checked = false;
  $('#aiMailRiskAccepted').checked = false;
  $('#aiMailRisk').classList.toggle('hidden', !full);
  $('#aiMailRiskCheck').classList.toggle('hidden', !full);
  $('#aiControlDialogTitle').textContent = full ? '允许 AI 使用完整权限' : '允许 AI 操作启动器';
  $('#aiControlRiskIntro').textContent = full
    ? state.data.settings.ai.provider === 'api'
      ? '完整权限会在你提出请求时允许 AI 读取启动器中的课程、成绩、作业、课表、邮件、日程、笔记和词汇等学习资料；相应内容会发送给你配置的第三方 API 服务商。不会开放密码、Cookie 或授权码，任何写入仍需你确认。'
      : '完整权限会在你提出请求时允许本地 AI 读取启动器中的课程、成绩、作业、课表、邮件、日程、笔记和词汇等学习资料；内容留在这台机器上。不会开放密码、Cookie 或授权码，任何写入仍需你确认。'
    : '开启后，AI 可以读取你授权的任务、笔记摘要、课程表与 EduPage 常规课表，并提出更改。';
  refreshAiControlAcceptance();
  $('#aiApiRisk').classList.toggle('hidden', state.data.settings.ai.provider !== 'api');
  $('#aiControlDialog').showModal();
}

async function disableAiControl() {
  try {
    const saved = await window.ph.ai.configure({ permissionMode: 'chat', launcherControlEnabled: false, mailReadEnabled: false });
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
  const mode = pendingAiPermissionMode();
  if (!$('#aiRiskAccepted').checked || mode === 'full' && !$('#aiMailRiskAccepted').checked) return;
  try {
    const acceptedAt = new Date().toISOString();
    const control = {
      permissionMode: mode,
      launcherControlEnabled: true,
      controlConsentVersion: Number(state.aiControlInfo?.consentVersion || 1),
      controlConsentAcceptedAt: acceptedAt,
      mailReadEnabled: mode === 'full',
    };
    const saved = await window.ph.ai.configure(mode === 'full' ? {
      ...control,
      mailConsentVersion: Number(state.aiControlInfo?.mailConsentVersion || 2),
      mailConsentAcceptedAt: acceptedAt,
    } : control);
    state.data.settings.ai = saved;
    $('#aiControlDialog').close();
    renderAiControl();
    toast(mode === 'full' ? '完整权限已开启；仅在你请求时读取启动器学习资料，写入仍需确认' : 'AI 启动器操作已开启；写入仍需逐次确认');
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
  window.agentUI?.render();
  const messages = state.aiMessages.filter((message) => message.role !== 'system');
  $('#chatMessages').innerHTML = messages.map((message) => {
    const visibleContent = message.streaming && !message.content ? (state.aiStreamStatus || '正在连接 AI…') : message.content;
    const content = `<div class="chat-bubble">${escapeHtml(visibleContent)}</div>`;
    if (message.role === 'assistant' && message.proposal) {
      return `<div class="chat-message assistant"><div class="chat-response">${content}${proposalMarkup(message.proposal)}</div></div>`;
    }
    return `<div class="chat-message ${escapeHtml(message.role)}">${content}</div>`;
  }).join('') + (state.aiBusy && !messages.some((message) => message.streaming) ? `<div class="chat-message assistant"><div class="chat-bubble">${escapeHtml(state.aiStreamStatus || '正在处理…')}</div></div>` : '');
  $('#chatMessages').scrollTop = $('#chatMessages').scrollHeight;
  const send = $('#aiSend');
  send.disabled = state.aiBusy && !state.aiRequestId;
  send.title = state.aiRequestId ? '停止生成' : '发送';
  send.setAttribute('aria-label', send.title);
  send.innerHTML = state.aiRequestId ? '停止' : '<svg><use href="#i-arrow"/></svg>';
}

function proposalMessage(proposalId) {
  return state.aiMessages.find((message) => message.proposal?.id === proposalId);
}

function committedSummary(counts = {}) {
  const parts = [];
  if (counts.tasksAdded) parts.push(`${counts.tasksAdded} 个任务`);
  if (counts.notesAdded) parts.push(`${counts.notesAdded} 条笔记`);
  if (counts.calendarEvents) parts.push(`${counts.calendarEvents} 条日程`);
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
    if (result.counts?.calendarEvents) await window.calendarUI?.refresh();
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
  window.agentUI?.prepareForSend?.();
  state.aiMessages.push({ role: 'user', content: '请从我当前打开的 EduPage 常规课表生成导入预览。' });
  state.aiBusy = true;
  window.agentUI?.scheduleSave();
  renderChat();
  try {
    const response = await window.ph.ai.previewEduPage();
    state.aiMessages.push({ role: 'assistant', content: response.content, proposal: response.proposal });
  } catch (error) {
    state.aiMessages.push({ role: 'assistant', content: `还不能读取课表：${error.message}\n\n请先打开 EduPage，登录并进入“常规课表”，然后回到这里重试。` });
  } finally {
    state.aiBusy = false;
    void window.agentUI?.saveNow?.();
    renderChat();
  }
}

function cancelAiStream() {
  const requestId = state.aiRequestId;
  if (!requestId) return;
  state.aiRequestId = '';
  state.aiStreamStatus = '';
  const partial = state.aiMessages.find((message) => message.streaming);
  if (partial) {
    partial.content = partial.content || '已停止生成。';
    delete partial.streaming;
  }
  state.aiBusy = false;
  void window.ph.ai.cancelStream(requestId);
  void window.agentUI?.saveNow?.();
  renderChat();
}

async function sendAiMessage() {
  const input = $('#aiInput');
  const content = input.value.trim();
  if (!content || state.aiBusy) return;
  const session = window.agentUI?.prepareForSend?.();
  state.aiMessages.push({ role: 'user', content });
  input.value = '';
  const conversation = state.aiMessages;
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const assistantMessage = { role: 'assistant', content: '', streaming: true };
  conversation.push(assistantMessage);
  state.aiBusy = true;
  state.aiRequestId = requestId;
  state.aiStreamStatus = state.aiLocalWarmup.localWarmup === 'warming' ? '正在准备本机模型…' : '正在连接 AI…';
  window.agentUI?.scheduleSave();
  renderChat();
  const system = {
    role: 'system',
    content: '你是 PH Launcher 的 IB 学习助手。优先用提问、拆解、例子和自测帮助学生真正理解；不要替学生完成需要本人思考或提交的作业。回答简洁、准确，明确不确定性；涉及课程评分标准时提醒核对教师要求和最新 IB 指南。用户要求你整理启动器内容时，使用提供的工具；任何写入都只是待确认方案，不能声称已经保存。',
  };
  try {
    const history = conversation.filter((message) => !message.streaming).slice(-16).map(({ role, content: messageContent }) => ({ role, content: messageContent }));
    const response = await window.ph.ai.chatStream(requestId, [system, ...history], {
      useMemories: Boolean(state.aiUseMemories),
      connectionKey: session?.connectionKey || '',
    });
    if (state.aiMessages === conversation && state.aiRequestId === requestId) {
      assistantMessage.content = typeof response === 'string' ? (response || assistantMessage.content || '没有收到有效回复。') : (response?.content || assistantMessage.content || '没有收到有效回复。');
      assistantMessage.proposal = typeof response === 'string' ? null : (response?.proposal || null);
      delete assistantMessage.streaming;
    }
  } catch (error) {
    if (state.aiMessages === conversation && conversation.includes(assistantMessage)) {
      assistantMessage.content = /取消|替换|变更/.test(error.message || '')
        ? (assistantMessage.content || '已停止生成。')
        : `连接失败：${error.message}\n\n请检查模型服务或 API 设置。`;
      delete assistantMessage.streaming;
    }
  } finally {
    if (state.aiRequestId === requestId) {
      state.aiBusy = false;
      state.aiRequestId = '';
      state.aiStreamStatus = '';
      void window.agentUI?.saveNow?.();
      renderChat();
    }
  }
}

function renderWebsiteSettings() {
  const descriptions = {
    mail: '使用本地收件箱阅读、保存附件与写信；账号仅用于连接邮箱。',
    managebac: '需要保持登录时，可在登录页勾选“Remember me for 30 days”，也可选择账号记忆。',
    edupage: 'EduPage 可能在真正退出浏览器后删除登录 Cookie；账号记忆可在下次登录页填入信息。',
  };
  $('#websiteSettings').innerHTML = Object.entries(BUILTIN_SITE_META).map(([id, site]) => `<div class="website-setting">
    <div class="site-card-icon ${id === 'mail' ? 'green' : id === 'managebac' ? 'wine' : 'gold'}">${icon(site.icon)}</div>
    <div><strong>${escapeHtml(site.name)}</strong><small>${escapeHtml(descriptions[id])}</small></div>
    <div class="website-setting-actions"><button class="clear-site-button" data-clear-site="${id}">清除登录数据</button></div>
  </div>`).join('');
  renderCredentialSettings();
  renderCustomWebsiteSettings();
}

function credentialEntry(siteId) {
  return state.credentialStatus?.sites?.[siteId] || {
    saved: false,
    username: '',
    displayUsername: '',
    autoFill: false,
    updatedAt: '',
  };
}

function renderCredentialSettings() {
  const container = $('#credentialSettings');
  if (!container) return;
  const status = state.credentialStatus;
  if (!status) {
    container.innerHTML = '<div class="empty-row credential-loading">正在检查系统安全存储…</div>';
    return;
  }
  if (!status.supported || status.issue) {
    const reason = status.issue || status.reason || '当前系统无法安全保存密码';
    container.innerHTML = `<div class="credential-unavailable"><strong>账号记忆暂不可用</strong><span>${escapeHtml(reason)}</span><small>仍可使用每个网站自己的“保持登录”选项。</small></div>`;
    return;
  }
  container.innerHTML = Object.entries(BUILTIN_SITE_META).map(([siteId, site]) => {
    const credential = credentialEntry(siteId);
    const statusText = credential.saved
      ? siteId === 'mail'
        ? `已加密保存 ${credential.displayUsername || '账号'} · 用于本地收件箱`
        : `已加密保存 ${credential.displayUsername || '账号'} · ${credential.autoLogin ? '允许自动重新登录' : credential.autoFill ? '登录页自动填入' : '仅手动填入'}`
      : siteId === 'mail' ? '尚未登录；添加账号后可使用本地收件箱' : '未保存密码；仍可使用网站自己的保持登录';
    const actions = credential.saved
      ? siteId === 'mail'
        ? `<button type="button" data-connect-credential="${siteId}">登录</button><button type="button" data-edit-credential="${siteId}">修改账号</button><button type="button" class="danger" data-remove-credential="${siteId}">删除</button>`
        : `<button type="button" data-connect-credential="${siteId}">登录</button><button type="button" data-edit-credential="${siteId}">修改账号</button><button type="button" class="danger" data-remove-credential="${siteId}">删除</button>`
      : `<button type="button" data-edit-credential="${siteId}">添加账号</button>`;
    return `<div class="credential-setting"><div class="site-card-icon ${siteId === 'mail' ? 'green' : siteId === 'managebac' ? 'wine' : 'gold'}">${icon(site.icon)}</div><div><strong>${escapeHtml(site.name)}</strong><small>${escapeHtml(statusText)}</small></div><div class="credential-actions">${actions}</div></div>`;
  }).join('');
}

function openCredentialDialog(siteId) {
  const site = BUILTIN_SITE_META[siteId];
  const status = state.credentialStatus;
  if (!site || !status?.supported || status.issue) {
    return toast(status?.issue || status?.reason || '账号记忆暂不可用', 'error');
  }
  const credential = credentialEntry(siteId);
  $('#credentialForm').reset();
  $('#credentialSiteId').value = siteId;
  $('#credentialUsername').value = credential.username || '';
  $('#credentialPassword').required = !credential.saved;
  $('#credentialPasswordNote').textContent = credential.saved
    ? '如需保留原密码，请留空；保存后不会显示密码。'
    : '保存后不会显示密码；如需更新，请重新输入。';
  const isMail = siteId === 'mail';
  $('#credentialAutoFill').checked = isMail ? false : credential.saved ? Boolean(credential.autoFill) : true;
  $('#credentialAutoFillRow').hidden = isMail;
  $('#credentialAutoLoginRow').hidden = isMail;
  $('#credentialAutoLogin').checked = siteId !== 'mail' && credential.autoLogin === true;
  $('#credentialDialogTitle').textContent = '账号登录';
  if ($('#credentialAuthcodeRow')) $('#credentialAuthcodeRow').hidden = !isMail;
  if ($('#credentialAuthcode')) $('#credentialAuthcode').value = '';
  $('#credentialPasswordLabel').textContent = isMail ? '网页密码（可选回退）' : '密码';
  $('#credentialPassword').required = !credential.saved && !isMail;
  if ($('#credentialAuthcode')) $('#credentialAuthcode').required = isMail && !credential.saved;
  $('#credentialPasswordNote').textContent = isMail
    ? 'IMAP/SMTP 收发信必须使用客户端授权码（网页邮箱 → 设置 → 客户端设置 生成）；网页密码仅在邮箱仍允许普通登录时作为回退。授权码必填，密码可选。'
    : credential.saved
      ? '如需保留原密码，请留空；保存后不会显示密码。'
      : '保存后不会显示密码；如需更新，请重新输入。';
  $('#credentialIntro').textContent = siteId === 'mail'
    ? '网易企业邮的 IMAP/SMTP 服务需要客户端授权码（网页邮箱 → 设置 → 客户端设置 生成）。授权码与密码都只用于连接网易固定邮件服务器，使用当前系统用户密钥加密保存；邮件内容不会交给 AI。'
    : `密码会使用当前系统用户密钥单独加密，只会发送到 ${site.name} 以登录并读取${siteId === 'edupage' ? '课表' : '课程'}；不会交给 AI 或写入学校数据。更换账号会清除该网站旧会话。`;
  $('#credentialRiskAccepted').checked = false;
  $('#saveCredentialButton').disabled = true;
  $('#saveCredentialButton').textContent = '保存并登录';
  $('#credentialDialog').showModal();
  setTimeout(() => $('#credentialUsername').focus(), 30);
}

async function saveCredentialFromDialog(event) {
  event.preventDefault();
  if (credentialSubmitInFlight) return;
  if (!$('#credentialRiskAccepted').checked) return toast('请先阅读并确认风险提示', 'error');
  const saveButton = $('#saveCredentialButton');
  const isMailSubmit = $('#credentialSiteId')?.value === 'mail';
  const credential = {
    siteId: $('#credentialSiteId').value,
    username: $('#credentialUsername').value,
    password: $('#credentialPassword').value,
    authcode: isMailSubmit ? ($('#credentialAuthcode')?.value || '') : '',
    autoFill: $('#credentialAutoFill').checked,
    autoLogin: $('#credentialSiteId').value !== 'mail' && $('#credentialAutoLogin').checked,
  };
  if (isMailSubmit && !credential.authcode) {
    return toast('客户端授权码必填（网页邮箱 → 设置 → 客户端设置 生成）', 'error');
  }
  // Clear the editable password field before waiting for IPC. The main process
  // receives the value through the isolated bridge and never returns it.
  $('#credentialPassword').value = '';
  if ($('#credentialAuthcode')) $('#credentialAuthcode').value = '';
  saveButton.disabled = true;
  credentialSubmitInFlight = true;
  try {
    state.credentialStatus = await window.ph.credentials.save(credential);
    $('#credentialDialog').close();
    renderCredentialSettings();
  } catch (error) {
    toast(`无法保存账号：${error.message}`, 'error');
    return;
  } finally {
    credentialSubmitInFlight = false;
    if ($('#credentialDialog').open) saveButton.disabled = !$('#credentialRiskAccepted').checked;
  }
  if (credential.siteId === 'mail') {
    const statusEl = $('#credentialConnectStatus');
    if (statusEl) { statusEl.hidden = false; statusEl.className = 'credential-connect-status testing'; statusEl.textContent = '正在测试 IMAP 连接…'; }
    try {
      if (typeof window.mailUI?.connect !== 'function') throw new Error('邮箱服务尚未准备好');
      const connected = await window.mailUI.connect();
      if (statusEl) { statusEl.className = 'credential-connect-status ok'; statusEl.textContent = connected ? 'IMAP 连接成功，收件箱同步完成' : '连接已建立'; }
      if (connected) toast('已登录并同步最近邮件');
      if (typeof setTimeout === 'function') setTimeout(() => { if (statusEl) statusEl.hidden = true; $('#credentialDialog')?.close(); renderCredentialSettings(); }, 1500);
      else { if (statusEl) statusEl.hidden = true; $('#credentialDialog')?.close(); renderCredentialSettings(); }
    } catch (error) {
      if (statusEl) { statusEl.className = 'credential-connect-status error'; statusEl.textContent = `连接失败：${error.message}`; }
      toast(`账号已保存，但无法连接邮箱：${error.message}`, 'error');
    }
    return;
  }
  try {
    if (typeof window.schoolUI?.connect !== 'function') throw new Error('学校登录服务尚未准备好');
    const connected = await window.schoolUI.connect(credential.siteId, { approved: true });
    if (connected) toast(`${BUILTIN_SITE_META[credential.siteId].name} 已登录并同步`);
  } catch (error) {
    toast(`账号已保存，但无法连接 ${BUILTIN_SITE_META[credential.siteId].name}：${error.message}`, 'error');
  }
}

async function connectWithSavedCredential(siteId) {
  const site = BUILTIN_SITE_META[siteId];
  if (!site) return;
  try {
    if (siteId === 'mail') {
      if (typeof window.mailUI?.connect !== 'function') throw new Error('邮箱服务尚未准备好');
      const connected = await window.mailUI.connect();
      if (connected) toast('已登录并同步最近邮件');
      return;
    }
    if (typeof window.schoolUI?.connect !== 'function') throw new Error('学校登录服务尚未准备好');
    const connected = await window.schoolUI.connect(siteId, { approved: true });
    if (connected) toast(`${site.name} 已登录并同步`);
  } catch (error) {
    toast(`无法连接 ${site.name}：${error.message}`, 'error');
  }
}

window.openSchoolAccount = openCredentialDialog;

async function removeCredential(siteId) {
  const site = BUILTIN_SITE_META[siteId];
  if (!site || !confirm(`删除 ${site.name} 保存的账号和密码？网站登录状态不会受影响。`)) return;
  try {
    const result = await window.ph.credentials.remove(siteId);
    state.credentialStatus = result.status;
    renderCredentialSettings();
    toast(`${site.name} 保存的登录信息已删除`);
  } catch (error) {
    toast(`无法删除登录信息：${error.message}`, 'error');
  }
}

async function fillCredentialOnce(siteId) {
  const site = BUILTIN_SITE_META[siteId];
  if (!site) return;
  await openSite(siteId);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (state.activeSite !== siteId) return;
    try {
      const result = await window.ph.credentials.fill(siteId);
      if (result.filled) {
        toast('已填入登录信息；请自行确认并登录');
        return;
      }
      if (result.reason === 'fields-not-empty') return toast('登录栏已有内容，未覆盖；请检查后自行登录');
      if (['untrusted-page', 'untrusted-form-action', 'not-login-form', 'ambiguous-form'].includes(result.reason)) break;
    } catch (error) {
      toast(`无法填入登录信息：${error.message}`, 'error');
      return;
    }
  }
  toast('当前页面没有可填写的登录栏；请前往对应网站的登录页后重试', 'error');
}

function renderCustomWebsiteSettings() {
  const container = $('#customWebsiteSettings');
  if (!container) return;
  const sites = customSites();
  container.innerHTML = sites.length ? sites.map((site, index) => {
    const color = CUSTOM_SITE_COLORS.has(site.color) ? site.color : 'green';
    const shortcutResult = state.shortcutResults[`site:${site.id}`];
    const shortcutStatus = shortcutResult && !shortcutResult.ok
      ? shortcutResult.error
      : site.shortcutEnabled && site.shortcut ? `快捷键：${site.shortcut}` : '未启用快捷键';
    return `<div class="website-setting custom-website-setting" data-custom-site-row="${escapeHtml(site.id)}"><div class="site-card-icon custom-site-monogram ${color}">${escapeHtml(customSiteMonogram(site.name))}</div><div><strong>${escapeHtml(site.name)}</strong><small>${escapeHtml(siteHostname(site.url))} · ${escapeHtml(shortcutStatus)}</small></div><div class="custom-site-actions"><button type="button" data-custom-move="up" data-custom-id="${escapeHtml(site.id)}" ${index === 0 ? 'disabled' : ''} aria-label="上移 ${escapeHtml(site.name)}">↑</button><button type="button" data-custom-move="down" data-custom-id="${escapeHtml(site.id)}" ${index === sites.length - 1 ? 'disabled' : ''} aria-label="下移 ${escapeHtml(site.name)}">↓</button><button type="button" data-edit-custom-site="${escapeHtml(site.id)}">编辑</button><button type="button" data-clear-custom-site="${escapeHtml(site.id)}">清除登录</button><button type="button" class="danger" data-remove-custom-site="${escapeHtml(site.id)}">删除</button></div></div>`;
  }).join('') : '<div class="empty-row custom-site-settings-empty">尚未添加网页。添加后会出现在首页和侧栏。</div>';
}

function selectSettingsSection(section) {
  $$('.settings-sections-nav button').forEach((button) => button.classList.toggle('active', button.dataset.settingsSection === section));
  $$('.settings-section').forEach((panel) => panel.classList.toggle('active', panel.dataset.settingsPanel === section));
}

async function openCustomSiteDialog(site = null) {
  const wasViewingSite = Boolean(state.activeSite);
  if (wasViewingSite) {
    navigate('settings');
    try { await window.ph.sites.hide(); } catch {}
    selectSettingsSection('websites');
  }
  $('#customSiteForm').reset();
  $('#customSiteId').value = site?.id || '';
  $('#customSiteName').value = site?.name || '';
  $('#customSiteUrl').value = site?.url || '';
  $('#customSiteColor').value = CUSTOM_SITE_COLORS.has(site?.color) ? site.color : 'green';
  $('#customSiteShortcut').value = site?.shortcut || '';
  $('#customSiteShortcutEnabled').checked = Boolean(site?.shortcutEnabled);
  $('#customSiteDialogTitle').textContent = site ? '编辑网页' : '添加网页';
  $('#customSiteDialog').showModal();
  setTimeout(() => $('#customSiteName').focus(), 30);
}

async function saveCustomSiteFromDialog(event) {
  event.preventDefault();
  const saveButton = $('#saveCustomSiteButton');
  const shortcut = $('#customSiteShortcut').value.trim();
  if ($('#customSiteShortcutEnabled').checked && !shortcut) return toast('请先填写快捷键，或关闭快捷键开关', 'error');
  saveButton.disabled = true;
  try {
    const result = await window.ph.sites.saveCustom({
      id: $('#customSiteId').value || undefined,
      name: $('#customSiteName').value,
      url: $('#customSiteUrl').value,
      color: $('#customSiteColor').value,
      shortcut,
      shortcutEnabled: $('#customSiteShortcutEnabled').checked,
    });
    state.data = result.data;
    refreshSiteMeta();
    $('#customSiteDialog').close();
    renderAll();
    toast(result.created ? '网页已添加' : '网页已更新');
  } catch (error) {
    toast(`无法保存网页：${error.message}`, 'error');
  } finally {
    saveButton.disabled = false;
  }
}

async function removeCustomSite(siteId) {
  const site = customSites().find((item) => item.id === siteId);
  if (!site || !confirm(`删除“${site.name}”并清除它的全部登录数据？`)) return;
  try {
    const result = await window.ph.sites.removeCustom(siteId);
    const wasActive = state.activeSite === siteId;
    state.data = result.data;
    refreshSiteMeta();
    if (wasActive) navigate('today');
    else renderAll();
    toast(`${site.name} 已删除，登录数据已清除`);
  } catch (error) {
    toast(`无法删除网页：${error.message}`, 'error');
  }
}

async function moveCustomSite(siteId, direction) {
  const sites = customSites();
  const index = sites.findIndex((site) => site.id === siteId);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= sites.length) return;
  const ids = sites.map((site) => site.id);
  [ids[index], ids[target]] = [ids[target], ids[index]];
  try {
    const result = await window.ph.sites.reorderCustom(ids);
    state.data = result.data;
    renderAll();
  } catch (error) {
    toast(`无法调整顺序：${error.message}`, 'error');
  }
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
  $('#startupSyncSetting').checked = settings.schoolStartupSync !== false;
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
    { id: 'mail', label: '打开平和邮箱', description: '校园邮件与通知', icon: 'i-mail', shortcut: 'Ctrl 1' },
    { id: 'managebac', label: '打开 ManageBac', description: '课程、作业与 IB 进度', icon: 'i-grid', shortcut: 'Ctrl 2' },
    { id: 'edupage', label: '打开 EduPage', description: '课表与校园安排', icon: 'i-calendar', shortcut: 'Ctrl 3' },
    ...customSites().map((site) => ({
      id: site.id,
      label: `打开 ${site.name}`,
      description: `${siteHostname(site.url)} · 我的网页`,
      icon: 'i-external',
      shortcut: site.shortcutEnabled ? site.shortcut : '',
    })),
    { id: 'new-task', label: '新建任务', description: '快速添加待办', icon: 'i-check', shortcut: 'Ctrl Shift A' },
    { id: 'new-note', label: '新建笔记', description: '创建一条本地笔记', icon: 'i-note', shortcut: 'Ctrl Shift N' },
    { id: 'dictionary', label: '打开离线词典', description: '本机英汉释义、音标与词形', icon: 'i-book', shortcut: 'Ctrl D' },
    { id: 'focus', label: '开始或暂停专注', description: '控制当前计时器', icon: 'i-clock', shortcut: 'Ctrl Shift P' },
    { id: 'timetable', label: '打开我的课表', description: '查看自己的教学组课表', icon: 'i-calendar', shortcut: '' },
    { id: 'calendar', label: '打开我的日程', description: '管理个人日程', icon: 'i-calendar', shortcut: '' },
    { id: 'class-timetable', label: '打开班级课表', description: '查看班级全部可见教学组', icon: 'i-grid', shortcut: '' },
    { id: 'courses', label: '打开我的课程', description: '查看课程、作业与截止信息', icon: 'i-book', shortcut: '' },
    { id: 'plan', label: '打开计划', description: '任务、课程表与专注记录', icon: 'i-calendar', shortcut: '' },
    { id: 'ib', label: '打开 IB 工具', description: '指令词、字数与成绩试算', icon: 'i-flask', shortcut: '' },
    { id: 'ibdocs', label: '打开 IB Docs', description: '非官方资料导航，在系统浏览器中打开', icon: 'i-external', shortcut: '' },
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
  if (ROUTE_META[commandId] || ROUTE_ALIASES[commandId]) return navigate(commandId);
  if (commandId === 'new-task') openTaskDialog();
  if (commandId === 'new-note') { navigate('notes'); createNote(); }
  if (commandId === 'focus') toggleTimer();
  if (commandId === 'ibdocs') openIbDocsResource();
}

function openOfficialIbResources() {
  return window.ph.system.openUrl('https://www.ibo.org/programmes/diploma-programme/curriculum/')
    .catch((error) => toast(`无法打开资源：${error.message}`, 'error'));
}

function openOfficialIbSamples() {
  return window.ph.system.openUrl('https://www.ibo.org/programmes/diploma-programme/assessment-and-exams/sample-exam-papers/')
    .catch((error) => toast(`无法打开资源：${error.message}`, 'error'));
}

function openIbDocsResource() {
  if (!confirm('IB Docs 是第三方网站，与 IBO 无隶属或背书关系，可能包含受版权保护的资料。仅在学校或权利人明确授权的情况下访问和使用。继续在浏览器中打开吗？')) return;
  return window.ph.system.openUrl('https://ibdocs.re/')
    .catch((error) => toast(`无法打开资源：${error.message}`, 'error'));
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
  window.i18n?.apply(state.data?.settings?.language);
  window.appearanceUI?.apply(state.data?.settings?.appearance);
  refreshSiteMeta();
  updateClock();
  renderDashboard();
  renderTasks();
  renderSchedule();
  renderNotes();
  if (state.route === 'dictionary') renderDictionary();
  renderIbTools();
  renderAi();
  renderSettings();
  window.appearanceUI?.render();
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
  if (action === 'add-custom-site') openCustomSiteDialog();

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
    selectSettingsSection(settingsButton.dataset.settingsSection);
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
  $('#commandSubject').addEventListener('change', (event) => {
    state.commandSubject = event.target.value;
    renderCommandTerms();
  });
  $('#commandSearch').addEventListener('input', renderCommandTerms);
  $('#commandGuideLink').addEventListener('click', () => {
    const subject = state.ibCommandCatalog?.subjects.find((item) => item.id === state.commandSubject);
    if (!subject?.sourceUrl) return;
    window.ph.system.openUrl(subject.sourceUrl).catch(() => toast('暂时无法打开官方依据'));
  });
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
  $('#openOfficialIbResources').addEventListener('click', openOfficialIbResources);
  $('#openOfficialIbSamples').addEventListener('click', openOfficialIbSamples);
  $('#openIbDocs').addEventListener('click', openIbDocsResource);
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
  $('#miniFocusManage').addEventListener('click', openFocusSettings);
  $('#miniFocusStop').addEventListener('click', resetTimer);
  $('#focusPlay').addEventListener('click', toggleTimer);
  $('#focusReset').addEventListener('click', resetTimer);
  $('#focusConfigure').addEventListener('click', openFocusSettings);
  $('#focusSettingsForm').addEventListener('submit', saveFocusSettings);
  $('#focusOpenTarget').addEventListener('click', openFocusTarget);
  $('#miniFocusTarget').addEventListener('click', () => {
    const timer = ensureTimer();
    if (timer.sessionStarted && focusTargetInfo(timer.target)) openFocusTarget();
    else openFocusSettings();
  });
  $('#focusPresets').addEventListener('click', (event) => {
    const button = event.target.closest('[data-focus]');
    if (button) setTimerPreset(Number(button.dataset.focus), Number(button.dataset.break));
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
    const name = SITE_META[state.activeSite]?.name;
    if (!name) return;
    const includesSavedPassword = Boolean(BUILTIN_SITE_META[state.activeSite]);
    if (!confirm(`清除 ${name} 的登录状态、Cookie、缓存${includesSavedPassword ? '与已保存密码' : ''}？`)) return;
    try {
      const result = await window.ph.sites.clearData(state.activeSite);
      $('#sitePopover').classList.add('hidden');
      if (result?.credentialError) return toast('网页登录状态已清除，但保存密码删除失败。请在账号记忆设置中检查，暂未重新打开网站。', 'error');
      toast(result?.credentialRemoved ? `${name} 的登录数据和保存密码已清除` : `${name} 的登录数据已清除`);
    } catch (error) {
      toast(`无法清除登录数据：${error.message}`, 'error');
    }
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

  $('#aiSend').addEventListener('click', () => {
    if (state.aiRequestId) cancelAiStream();
    else sendAiMessage();
  });
  $('#aiInput').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendAiMessage(); } });
  $$('.prompt-chips button[data-prompt]').forEach((button) => button.addEventListener('click', () => {
    $('#aiInput').value = button.dataset.prompt || ''; $('#aiInput').focus();
    const ai = state.data?.settings?.ai || {};
    const mailReadEnabled = ai.permissionMode === 'full' && ai.mailReadEnabled === true && ai.mailConsentVersion === 2 && ai.launcherControlEnabled;
    if (button.dataset.requiresMailRead === 'true' && !mailReadEnabled) toast('请先选择“完整权限”并同意收件箱读取，再发送这个请求。');
  }));
  $('[data-ai-action="edupage"]')?.addEventListener('click', previewEduPageTimetable);
  $('#aiControlToggle').addEventListener('change', (event) => {
    const mode = event.target.dataset.agentMode || 'confirm';
    delete event.target.dataset.agentMode;
    if (event.target.checked) {
      event.target.checked = false;
      openAiControlDialog(mode);
    } else {
      disableAiControl();
    }
  });
  $('#aiRiskAccepted').addEventListener('change', refreshAiControlAcceptance);
  $('#aiMailRiskAccepted').addEventListener('change', refreshAiControlAcceptance);
  $('#aiControlForm').addEventListener('submit', acceptAiControl);
  $('#aiControlDialog').addEventListener('close', () => { state.aiPendingPermissionMode = ''; renderAiControl(); });
  $('#chatMessages').addEventListener('click', (event) => {
    const confirmId = event.target.closest('[data-confirm-proposal]')?.dataset.confirmProposal;
    const cancelId = event.target.closest('[data-cancel-proposal]')?.dataset.cancelProposal;
    if (confirmId) confirmAiProposal(confirmId);
    if (cancelId) cancelAiProposal(cancelId);
  });
  $('#aiEditConfig').addEventListener('click', beginAiEditing);
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
      cancelAiStream();
      const saved = await window.ph.ai.configure({ clearApiKey: true, enabled: false });
      state.data.settings.ai = saved;
      await window.agentUI?.loadHistory?.();
      renderAiConfig();
      toast('API Key 已删除');
    }
  });

  $('#studentNameSetting').addEventListener('input', (event) => { state.data.settings.studentName = event.target.value; updateClock(); persistData(); });
  $('#startupSyncSetting').addEventListener('change', (event) => { state.data.settings.schoolStartupSync = event.target.checked; persistData(true); });
  $('#openAtLoginSetting').addEventListener('change', (event) => { state.data.settings.openAtLogin = event.target.checked; persistData(true); });
  $('#minimizeTraySetting').addEventListener('change', (event) => { state.data.settings.minimizeToTray = event.target.checked; persistData(true); });
  $('#reminderSetting').addEventListener('change', (event) => { state.data.settings.defaultReminderMinutes = Number(event.target.value); persistData(); });
  $('#websiteSettings').addEventListener('click', async (event) => {
    const siteId = event.target.closest('[data-clear-site]')?.dataset.clearSite;
    if (!siteId || !confirm(`清除 ${SITE_META[siteId].name} 的登录状态、Cookie、缓存与已保存密码？`)) return;
    const result = await window.ph.sites.clearData(siteId);
    if (result?.credentialError) return toast('网页登录状态已清除，但保存密码删除失败。请在账号记忆设置中检查。', 'error');
    toast(result?.credentialRemoved ? `${SITE_META[siteId].name} 的登录数据和保存密码已清除` : `${SITE_META[siteId].name} 的登录数据已清除`);
  });
  $('#credentialSettings').addEventListener('click', (event) => {
    const editId = event.target.closest('[data-edit-credential]')?.dataset.editCredential;
    const removeId = event.target.closest('[data-remove-credential]')?.dataset.removeCredential;
    const fillId = event.target.closest('[data-fill-credential]')?.dataset.fillCredential;
    const connectId = event.target.closest('[data-connect-credential]')?.dataset.connectCredential;
    if (editId) return openCredentialDialog(editId);
    if (removeId) return removeCredential(removeId);
    if (fillId) return fillCredentialOnce(fillId);
    if (connectId) return connectWithSavedCredential(connectId);
  });
  $('#credentialRiskAccepted').addEventListener('change', (event) => {
    $('#saveCredentialButton').disabled = !event.target.checked;
  });
  $('#credentialForm').addEventListener('submit', saveCredentialFromDialog);
  $('#credentialDialog').addEventListener('close', () => {
    $('#credentialPassword').value = '';
    $('#credentialRiskAccepted').checked = false;
    $('#saveCredentialButton').disabled = true;
  });
  $('#customSiteForm').addEventListener('submit', saveCustomSiteFromDialog);
  $('#customWebsiteSettings').addEventListener('click', async (event) => {
    const editId = event.target.closest('[data-edit-custom-site]')?.dataset.editCustomSite;
    const removeId = event.target.closest('[data-remove-custom-site]')?.dataset.removeCustomSite;
    const clearId = event.target.closest('[data-clear-custom-site]')?.dataset.clearCustomSite;
    const moveButton = event.target.closest('[data-custom-move]');
    if (editId) {
      const site = customSites().find((item) => item.id === editId);
      if (site) openCustomSiteDialog(site);
      return;
    }
    if (removeId) return removeCustomSite(removeId);
    if (clearId) {
      const site = customSites().find((item) => item.id === clearId);
      if (!site || !confirm(`清除“${site.name}”的登录状态、Cookie 与缓存？`)) return;
      try {
        await window.ph.sites.clearData(clearId);
        toast(`${site.name} 的登录数据已清除`);
      } catch (error) {
        toast(`无法清除登录数据：${error.message}`, 'error');
      }
      return;
    }
    if (moveButton) moveCustomSite(moveButton.dataset.customId, moveButton.dataset.customMove);
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
    if (mod && !event.shiftKey && event.key === '1') { event.preventDefault(); navigate('mail'); }
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
  window.agentUI?.mount();
  const appearanceHost = document.createElement('div');
  appearanceHost.id = 'appearanceSettings';
  $('[data-settings-panel="general"]').append(appearanceHost);
  const collaborationCredit = document.createElement('p');
  collaborationCredit.className = 'disclaimer';
  collaborationCredit.textContent = '合作整合：PH Launcher（XKRyan）× Hello Pinghe! Launcher（huaziqian40-bot）。学校学习面板结合两个学生项目的设计与接口经验。';
  $('[data-settings-panel="about"]').append(collaborationCredit);
  window.vocabularyUI?.mount();
  window.schoolUI?.mount();
  window.calendarUI?.mount();
  window.mailUI?.mount();
  $('#dictionaryResult').addEventListener('click', (event) => {
    if (event.target.closest('#dictionaryToVocabulary') && state.dictionaryResult?.exact) window.vocabularyUI?.addDictionaryEntry(state.dictionaryResult.exact);
  });
  try {
    const [appVersion, data, deployment, ibCommandCatalog, credentialStatus] = await Promise.all([
      window.ph.system.version(),
      window.ph.data.get(),
      window.ph.ai.deploymentState(),
      window.ph.ib.commandCatalog(),
      window.ph.credentials.status(),
    ]);
    state.data = data;
    window.i18n?.mount(data.settings.language);
    window.i18n?.settings();
    state.aiDeployment = deployment;
    state.ibCommandCatalog = ibCommandCatalog;
    state.credentialStatus = credentialStatus;
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
    if (!Array.isArray(state.data.settings.customSites)) state.data.settings.customSites = [];
    refreshSiteMeta();
    ensureTimer();
    void refreshVocabularyBadge();
    state.selectedNoteId = [...state.data.notes].sort(noteSort)[0]?.id || null;
    renderAll();
    void window.agentUI?.loadHistory?.();
    navigate('today');
    setPlanTab('tasks');
    state.shortcutResults = await window.ph.shortcuts.register();
  } catch (error) {
    toast(`启动失败：${error.message}`, 'error');
  }
  window.ph.sites.onState(handleSiteState);
  window.ph.credentials.onChanged((credentialStatus) => {
    state.credentialStatus = credentialStatus;
    if (state.route === 'settings') renderCredentialSettings();
  });
  window.ph.mail?.onCleared?.(() => window.mailUI?.clear());
  window.ph.shortcuts.onAction((action) => {
    if (typeof action === 'string' && action.startsWith('site:') && SITE_META[action.slice(5)]) openSite(action.slice(5));
    else if (SITE_META[action]) openSite(action);
    else if (action === 'dictionary') navigate('dictionary');
    else if (action === 'quickNote') { navigate('notes'); createNote(); }
    else if (action === 'focus') toggleTimer();
  });
  window.ph.shortcuts.onResults((results) => {
    state.shortcutResults = results || {};
    if (state.route === 'settings') {
      renderShortcutSettings();
      renderCustomWebsiteSettings();
    }
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
  window.ph.ai.onStatus((status) => {
    state.aiLocalWarmup = status || { localWarmup: 'idle', detail: '' };
    if (state.route === 'ai' && !state.aiEditing) renderChat();
  });
  window.ph.ai.status().then((status) => { state.aiLocalWarmup = status || state.aiLocalWarmup; }).catch(() => {});
  window.ph.ai.onStream((event) => {
    const requestId = event?.requestId;
    if (!requestId || requestId !== state.aiRequestId) return;
    const message = state.aiMessages.find((item) => item.streaming);
    if (!message) return;
    if (event.type === 'status') state.aiStreamStatus = String(event.status || '正在生成…');
    if (event.type === 'delta') message.content += String(event.delta || '');
    renderChat();
  });
  window.ph.ai.onCommand((command) => {
    if (command?.type === 'navigate') {
      if (SITE_META[command.target]) openSite(command.target);
      else if (ROUTE_META[command.target] || ROUTE_ALIASES[command.target]) navigate(command.target);
      else if (command.target === 'ibdocs') openIbDocsResource();
    }
    if (command?.type === 'focus') {
      const timer = ensureTimer();
      if (command.action === 'start' && !timer.running) toggleTimer();
      if (command.action === 'pause' && timer.running) toggleTimer();
      if (command.action === 'reset') resetTimer();
    }
  });
  window.ph.data.onChanged((data) => {
    state.data = data;
    refreshSiteMeta();
    if (state.activeSite && !SITE_META[state.activeSite]) navigate('today');
    else renderAll();
  });
  window.ph.vocabulary?.onChanged?.((payload) => updateVocabularyBadge(payload));
  window.ph.school.onPlanImported((schedule) => {
    state.data.schedule = schedule;
    renderSchedule(); renderDashboard();
  });
  setInterval(() => { updateClock(); refreshVocabularyBadge(); }, 60_000);
  setInterval(updateTimerUi, 500);
  document.body.dataset.initialized = 'true';
  document.body.classList.add('loaded');
  if (state.data) void window.startupSyncUI?.run({ enabled: state.data.settings.schoolStartupSync !== false, accounts: state.credentialStatus?.sites || {} });
  // Splash progress bars are pure CSS animations; the skip button forces
  // the splash away immediately when a platform connection times out.
  const skipButton = $('#splashSkip');
  if (skipButton) skipButton.addEventListener('click', () => document.body.classList.add('loaded'));
}

document.addEventListener('DOMContentLoaded', init);

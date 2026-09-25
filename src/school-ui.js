(() => {
  'use strict';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  // 学校作息（课表按节次对齐：行 = 节次，列 = 星期）。
  // 这一份与 Pinghe Launcher Lite 的 `ui/app.js` PERIODS **同一套**（用户 2026-09-19：
  // 「课表界面的大小布局等参考 phl lite」），也和 EduPage 上的真实节次一致。
  const PHL_PERIODS = [
    { label: 'P1', start: 8 * 60, end: 8 * 60 + 40 },
    { label: 'P2', start: 8 * 60 + 45, end: 9 * 60 + 25 },
    { label: 'P3', start: 9 * 60 + 35, end: 10 * 60 + 15 },
    { label: 'P4', start: 10 * 60 + 20, end: 11 * 60 },
    { label: 'P5', start: 11 * 60 + 5, end: 11 * 60 + 55 },
    { label: '午餐', start: 12 * 60, end: 12 * 60 + 40, rest: true },
    { label: 'P6', start: 12 * 60 + 45, end: 13 * 60 + 25 },
    { label: 'P7', start: 13 * 60 + 30, end: 14 * 60 + 10 },
    { label: 'P8', start: 14 * 60 + 15, end: 14 * 60 + 55 },
    { label: 'P9', start: 15 * 60, end: 15 * 60 + 40 },
    { label: 'P10', start: 15 * 60 + 45, end: 16 * 60 + 25 },
    { label: '晚自习', start: 18 * 60, end: 20 * 60 + 30, rest: true },
  ];
  const PHL_FLOOR = PHL_PERIODS[0].start; // 08:00
  const PHL_CEILING = PHL_PERIODS[PHL_PERIODS.length - 1].end; // 20:30
  /** 这节课落在哪个节次；不在任何节次里返回 -1（归到「课外」那一行）。 */
  const periodOf = (start) => PHL_PERIODS.findIndex((period) => minutes(start) >= period.start && minutes(start) < period.end);
  /** 这节课（可能连着上两节）最后一节所在的节次下标。 */
  const periodEndOf = (end) => {
    let last = -1;
    for (let index = 0; index < PHL_PERIODS.length; index += 1) if (minutes(end) > PHL_PERIODS[index].start) last = index;
    return last;
  };
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
  const state = { snapshot: { edupage: null, managebac: null, preferences: {}, status: {} }, notifications: null, notificationsBusy: false, discussions: null, discussionsBusy: false, exportMenu: false, exportBusy: false, weeks: new Map(), epochs: {}, route: 'timetable', courseTab: 'courses', week: monday(), showWeekend: false, busy: new Set(), error: '', notice: '', query: '', courseSort: 'manual', taskSort: 'due', showHidden: false, consent: new Set(), refreshId: 0, syncIds: { edupage: 0, managebac: 0 }, autoTimer: null };
  let root;
  let modal;
  let timeLineObserver;
  const authBlocked = new Set();
  const api = () => window.ph.school;
  const prefs = () => state.snapshot.preferences || {};
  const currentWeek = () => state.weeks.get(state.week) || null;
  const statusFor = (source) => state.snapshot.status?.[source] || {};
  const checkedAt = (source) => (source === 'edupage' ? currentWeek()?.fetchedAt : state.snapshot.managebac?.fetchedAt) || statusFor(source).updatedAt || '';
  const isStale = (source) => (source === 'edupage' && !currentWeek()) || !checkedAt(source) || Date.now() - Date.parse(checkedAt(source)) >= TTL[source];
  /**
   * 同步一律自动（用户 2026-09-19：「所有同步、刷新全都自动，不要让用户察觉，
   * 最多来一行不起眼的小字在角落」）。所以这里不再看「自动更新」开关 ——
   * 只要求这个平台确实已经登录过（本机存了账号），否则根本不碰学校网站。
   */
  const autoApproved = (source) => state.consent.has(source) || Boolean(state.snapshot.accounts?.[source]?.saved);
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
    // 退回共用快照兜底时，课里可能没有 `groups`（共用那份用的是单数 `group`）——
    // 界面里到处 `lesson.groups.join(' / ')`，缺了就是一句
    // 「Cannot read properties of undefined (reading 'join')」，所以进门先补齐。
    for (const week of state.weeks.values()) normalizeLessons(week);
  }
  function normalizeLessons(week) {
    if (!week || !Array.isArray(week.lessons)) return week;
    for (const lesson of week.lessons) {
      if (!Array.isArray(lesson.groups)) lesson.groups = lesson.group ? [lesson.group] : [];
      if (lesson.teacher === undefined) lesson.teacher = '';
      if (lesson.room === undefined) lesson.room = '';
      if (lesson.cancelled === undefined) lesson.cancelled = false;
    }
    return week;
  }
  /**
   * 角落那行不起眼的小字：`当前数据：9/19 13:20`。
   * 同步是自动的，所以这里不摆按钮，只在数据过期或出错时补一句很轻的说明。
   */
  function syncSummary(source) {
    const remote = statusFor(source); const data = source === 'edupage' ? currentWeek() : state.snapshot.managebac;
    const last = checkedAt(source) || data?.fetchedAt;
    if (!last && !remote.error) return '';
    const stale = remote.state === 'stale' || Boolean(remote.error) || isStale(source);
    const note = remote.error ? ' · 稍后自动重试' : stale ? ' · 正在自动更新' : '';
    return `<div class="school-data-stamp" role="status">当前数据：${esc(stamp(last) || '读取中…')}${note}</div>`;
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
  /* 一张课卡（参考 PHL Lite 的 `.tt-lesson`：标题一行、教室·老师一行，卡片才十几像素高）。
     `place` 给连堂合并块定位；`withTime` 只在「课外」那一行用 —— 正课行的开始时间
     左边轴上已经写了，卡片里再写一遍是浪费一行高度（Lite 也是这么做的）。 */
  function lessonCard(lesson, place = '', withTime = false) {
    const detail = [lesson.course, `${lesson.start}–${lesson.end}`, lesson.room || '教室未提供', lesson.teacher || '老师未提供', (lesson.groups || []).join(' / ')].filter(Boolean).join(' · ');
    const highlighted = (prefs().highlights || []).includes(lesson.groupKey);
    return `<button type="button" class="school-lesson school-color-${color(lesson.groupKey)} ${lesson.cancelled ? 'is-cancelled' : ''} ${highlighted ? 'is-highlighted' : ''}" data-school-action="lesson" data-id="${esc(lesson.id)}"${place ? ` style="${place}"` : ''} title="${esc(`${detail} · 点击查看完整详情`)}" aria-label="${esc(`${detail}，点击查看完整详情`)}"><b class="school-lesson-course">${esc(lesson.course)}</b>${withTime ? `<span class="school-lesson-time">${esc(lesson.start)}–${esc(lesson.end)}${lesson.count > 1 ? ` · ${lesson.count} 节连堂` : ''}</span>` : ''}<span class="school-lesson-meta"><span class="school-lesson-room">${esc(lesson.room || '教室未提供')}</span><span class="school-lesson-teacher">${esc(lesson.teacher || '老师未提供')}</span></span>${lesson.cancelled ? '<b class="school-cancel-label">已取消</b>' : ''}</button>`;
  }
  /** 一个格子里挤了三门以上并行课：合成一张卡，点开看完整冲突列表。 */
  function clusterCard(items) {
    const highlighted = items.some((item) => (prefs().highlights || []).includes(item.groupKey));
    const cancelled = items.every((item) => item.cancelled);
    return `<button type="button" class="school-lesson school-lesson-cluster ${highlighted ? 'is-highlighted' : ''} ${cancelled ? 'is-cancelled' : ''}" data-school-action="lesson-cluster" data-date="${esc(items[0].date)}" data-start="${esc(items[0].start)}" data-end="${esc(items[items.length - 1].end)}" title="${esc(items.map((item) => item.course).join(' · '))}"><b>${items.length} 门课程</b><span>点击查看完整列表</span></button>`;
  }
  function timetable() {
    const data = currentWeek();
    const start = state.week;
    const classRoute = isClassTimetable();
    // 刷新按钮全部去掉：课表按需自动更新，角落里只留一行数据时间。
    // 「⬇ 导出课表」照网页端：点开是站内小下拉（PNG / CSV 两个条目），不用系统菜单。
    const exportBox = `<span class="school-export" id="schoolExportBox"><button type="button" class="secondary-button" data-school-action="export-menu" aria-haspopup="menu" aria-controls="schoolExportMenu" aria-expanded="${state.exportMenu ? 'true' : 'false'}" ${data ? '' : 'disabled'}>⬇ 导出课表</button><span class="school-export-menu" id="schoolExportMenu" role="menu" ${state.exportMenu ? '' : 'hidden'}><button type="button" role="menuitem" data-school-action="export-png">导出图片 PNG</button><button type="button" role="menuitem" data-school-action="export-csv">导出表格 CSV</button></span></span>`;
    // 「选择教学组」入口只在**个人课表**出现：班级课表是只读视图（看全班安排），
    // 从那里打开个人选课弹窗会把两个路由的语义混起来 —— 已有用例明确要求
    // 班级视图里不存在该按钮。个人视图没选课时有专门的空态大按钮兜底（见下）。
    const selectionActions = (data && !classRoute) ? `<div class="school-actions">${btn('选择教学组', 'groups')}${btn('自动识别选课', 'auto-groups')}${btn(courseReminderLabel(), 'course-reminder', `${selections()?.length && selectedLessons().some((lesson) => !lesson.cancelled) ? '' : 'disabled'}`)}</div>` : '';
    const toolbar = `<div class="school-weekbar"><strong>${esc(start)} — ${esc(shift(start, state.showWeekend ? 6 : 4))}</strong><div class="school-actions">${btn('上一周', 'week', 'data-delta="-7" aria-label="上一周"')}${btn('本周', 'week', 'data-delta="0"')}${btn('下一周', 'week', 'data-delta="7" aria-label="下一周"')}${btn(state.showWeekend ? '隐藏周末' : '显示周末', 'toggle-weekend', `aria-pressed="${state.showWeekend}"`)}${exportBox}</div></div>${selectionActions}`;
    if (!data) return toolbar + syncSummary('edupage') + noData(classRoute ? '查看班级这一周的课程' : '把一周安排放在眼前', state.weeks.size ? '这一周尚未读取，程序会自动补上。' : classRoute ? '先登录 EduPage，再读取当前账号所属班级的课表。这里展示全部可见教学组。' : '先登录 EduPage，再读取本周课表。首次同步后，选择你自己的教学组。', 'edupage');
    const selected = selections();
    const lessons = groupLessons(displayedLessons());
    const selectionNotice = classRoute
      ? `<div class="school-callout school-readonly-scope">当前账号所属班级：${esc(data.className || '班级名称未提供')} · 显示全部可见教学组，不受个人选课筛选影响。<br>本版暂不支持切换到其他班级；添加自己的课程提醒，请前往“我的课表”。</div><div class="school-meta">${esc(data.className || '当前班级')}</div>`
      : selected === null ? '' : `<div class="school-meta">已选择 ${selected.length} 个教学组 · ${selectedLessons().filter((lesson) => !lesson.cancelled).length} 节有效课程</div>`;
    if (!classRoute && (!selected || selected.length === 0)) {
      const configured = Array.isArray(selected);
      return toolbar + syncSummary('edupage') + `<div class="school-selection-empty"><span class="school-empty-symbol" aria-hidden="true">✓</span><h3>${configured ? '当前没有选择教学组' : '先选择你的教学组'}</h3><p>${configured ? '个人课表保持为空，不会用班级课程代替。' : '班级课表包含所有可选课程。请按科目搜索并勾选你实际参加的教学组，系统不会替你猜测。'}</p>${btn(configured ? '重新选择教学组' : '开始选择教学组', 'groups', '', true)}</div>` + warnings(data);
    }

    // ---- 按节次对齐：行 = 节次，列 = 星期（版式照抄 Pinghe Launcher Lite）----
    const today = localDate();
    const visibleDays = state.showWeekend ? 7 : 5;
    const columnClass = visibleDays === 7 ? 'school-days-7' : 'school-days-5';
    const byDay = [];
    for (let index = 0; index < visibleDays; index += 1) {
      const date = shift(start, index);
      const cells = PHL_PERIODS.map(() => []);
      const other = [];
      for (const lesson of lessons.filter((item) => item.date === date)) {
        const at = periodOf(lesson.start);
        if (at >= 0 && cells[at].every((item) => !item.taken)) cells[at].push(lesson); else other.push(lesson);
      }
      byDay.push({ date, cells, other, missing: data.missingDates?.includes(date) });
    }
    // 连着两节同一门课：合一跨两行（和 Lite 的连堂合并一个效果）。
    const spans = [];
    byDay.forEach((day, dayIndex) => {
      day.cells.forEach((cell, row) => {
        if (cell.length !== 1) return;
        const lesson = cell[0];
        const first = periodOf(lesson.start);
        const last = periodEndOf(lesson.end);
        if (last > first) {
          const blocked = [];
          for (let cursor = first + 1; cursor <= last; cursor += 1) blocked.push(...day.cells[cursor]);
          if (blocked.length) return;
          for (let cursor = first + 1; cursor <= last; cursor += 1) day.cells[cursor] = [{ taken: true }];
          spans.push(lessonCard(lesson, `grid-row:${first + 2} / span ${last - first + 1};grid-column:${dayIndex + 2}`));
        }
      });
    });

    const head = `<div class="school-tt-head school-tt-corner" style="grid-row:1;grid-column:1"><span>上海时间</span></div>${byDay.map((day, index) => `<div class="school-tt-head ${day.date === today ? 'is-today' : ''}" style="grid-row:1;grid-column:${index + 2}"><strong>${days[index]}</strong><span>${day.date.slice(5)}</span></div>`).join('')}`;
    const rows = [];
    const lessonRows = [];
    let row = 2;
    PHL_PERIODS.forEach((period, index) => {
      const busy = byDay.some((day) => day.cells[index].some((item) => !item.taken));
      const time = `<div class="school-tt-time ${period.rest ? 'is-rest' : ''}" style="grid-row:${row};grid-column:1"><b>${esc(period.label)}</b><span>${timeLabel(period.start)}</span></div>`;
      // 午餐 / 晚自习整周没课 → 一条横幅横跨所有列，不白占七格。
      if (period.rest && !busy) {
        rows.push(`${time}<div class="school-tt-rest" style="grid-row:${row};grid-column:2/-1">${esc(period.label)} ${timeLabel(period.start)} – ${timeLabel(period.end)}</div>`);
        row += 1;
        return;
      }
      if (!period.rest) lessonRows.push(row);
      rows.push(time);
      byDay.forEach((day, dayIndex) => {
        const cell = day.cells[index];
        const inner = cell.some((item) => item.taken) ? ''
          : cell.length > 2 ? clusterCard(cell)
            : cell.map((lesson) => lessonCard(lesson)).join('');
        const missing = index === 0 && day.missing ? '<p class="school-day-empty">未能同步<br>请查原网页</p>' : '';
        rows.push(`<div class="school-tt-cell ${period.rest ? 'is-rest' : ''}" style="grid-row:${row};grid-column:${dayIndex + 2}">${missing}${inner}</div>`);
      });
      row += 1;
    });
    // 不在任何节次里的课（临时调课、提前放学等）单独一行
    if (byDay.some((day) => day.other.length)) {
      rows.push(`<div class="school-tt-time" style="grid-row:${row};grid-column:1"><b>课外</b></div>`);
      byDay.forEach((day, dayIndex) => {
        const inner = day.other.map((lesson) => lessonCard(lesson, '', true)).join('');
        rows.push(`<div class="school-tt-cell" style="grid-row:${row};grid-column:${dayIndex + 2}">${inner || (dayIndex === 0 ? '' : '')}</div>`);
      });
      row += 1;
    }
    const grid = `<div class="school-timetable-scroll"><div class="school-timetable ${columnClass}" id="schoolTimetableGrid">${head}${rows.join('')}${spans.join('')}</div></div>`;
    return toolbar + syncSummary('edupage') + selectionNotice + grid + warnings(data) + '<p class="school-footnote">点击课程可查看详情、标记重点。不同教学组使用固定颜色；临时调课与停课请以 EduPage 原网页为准。</p>';
  }
  /**
   * 把所有正课行拉成同一个高度（照 Lite 的 `ttFitRows`）：三节课并行的行很高、
   * 只有一节课的行很矮的话，一整片看着很乱。量完自然高度再统一写死。
   * 2026-09-19 用户要求：「可以高一点点，到现在的 150% 左右」→ 在自然高度上 ×1.5，
   * 一行能看清课程名 + 教室·老师，两节并行的格子也不至于挤成一条。
   * 页面不可见时量到 0，那就什么都不做（下次 render 会再量）。
   */
  const ROW_HEIGHT_SCALE = 1.5;
  function fitTimetableRows() {
    const grid = root?.querySelector('#schoolTimetableGrid');
    if (!grid) return;
    grid.style.gridTemplateRows = '';
    const byRow = new Map();
    for (const cell of grid.querySelectorAll('.school-tt-cell')) {
      const at = parseInt(String(cell.style.gridRow), 10);
      if (!at) continue;
      byRow.set(at, Math.max(byRow.get(at) || 0, cell.offsetHeight));
    }
    const lessonRows = [...grid.querySelectorAll('.school-tt-time')]
      .filter((node) => !node.classList.contains('is-rest'))
      .map((node) => parseInt(String(node.style.gridRow), 10))
      .filter(Boolean);
    const natural = Math.max(0, ...lessonRows.map((at) => byRow.get(at) || 0));
    if (!natural) return;
    const maxHeight = Math.round(natural * ROW_HEIGHT_SCALE);
    const total = Math.max(...[...grid.querySelectorAll('[style*="grid-row"]')].map((node) => parseInt(String(node.style.gridRow), 10) || 0));
    const template = [`auto`];
    for (let at = 2; at <= total; at += 1) template.push(lessonRows.includes(at) ? `${maxHeight}px` : 'auto');
    grid.style.gridTemplateRows = template.join(' ');
  }

  /**
   * 导出课表（2026-09-19 用户要求「加上和网页端一样的导出课表功能」）。
   *
   * 与网页端 `ttExportMatrix()` 同一套口径：**方向与页面相反** ——
   * 页面是「行 = 节次、列 = 星期」，导出是「**行 = 星期（周一…周日）+ 日期**、
   * **列 = 节次（P1…Pn，表头带起止时间）**」。数据就是屏幕上这一周的课，不重新抓取。
   */
  function exportMatrix() {
    const week = currentWeek();
    if (!week) return null;
    const lessons = groupLessons(displayedLessons());
    const classRoute = isClassTimetable();
    const days7 = [];
    for (let index = 0; index < 7; index += 1) {
      const date = shift(state.week, index);
      const cells = PHL_PERIODS.map(() => []);
      const other = [];
      for (const lesson of lessons.filter((item) => item.date === date)) {
        const at = periodOf(lesson.start);
        if (at >= 0) cells[at].push(lesson); else other.push(lesson);
      }
      days7.push({ date, label: days[index], cells, other, spanStart: {}, consumed: new Set() });
    }
    // 整周都没课的午餐 / 晚自习不单列一栏；有课才占一列。
    const columns = [];
    PHL_PERIODS.forEach((period, index) => {
      const busy = days7.some((day) => day.cells[index].length);
      if (period.rest && !busy) return;
      columns.push({ label: period.label, start: timeLabel(period.start), end: timeLabel(period.end), rest: Boolean(period.rest), index });
    });
    if (days7.some((day) => day.other.length)) columns.push({ label: '课外', kind: 'other' });
    const header = ['星期', '日期', ...columns.map((column) => column.kind === 'other' ? '课外' : `${column.label} ${column.start}-${column.end}`)];
    const rows = days7.map((day) => ({
      label: day.label,
      date: day.date,
      cells: columns.map((column) => {
        if (column.kind === 'other') return day.other.map(exportLessonText).join('\n');
        return day.cells[column.index].map(exportLessonText).join('\n');
      }),
    }));
    return { title: `${classRoute ? '班级课表' : '我的课表'} · ${days7[0].date} ~ ${days7[6].date}`, weekStart: days7[0].date, header, rows, columns: columns.length, days: days7.length };
  }
  /** 一节课在导出表里的文字：课程 · 教室 · 老师（和网页端一个格式）。 */
  function exportLessonText(lesson) {
    const parts = [lesson.course || '（未命名课程）', lesson.room || '—', lesson.teacher || '—'];
    const groups = Array.isArray(lesson.groups) ? lesson.groups.filter(Boolean) : [];
    if (groups.length) parts.push(groups.join(' / '));
    return `${lesson.cancelled ? '（已取消）' : ''}${parts.join(' · ')}`;
  }
  /** CSV 字段转义：含逗号 / 引号 / 换行时用双引号包住，内部引号翻倍。 */
  const csvField = (value) => {
    const text = value == null ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  /** 导出 CSV：UTF-8 **带 BOM**（不带 BOM 时 Excel 会把中文显示成乱码），\r\n 换行。 */
  function exportCsvText(matrix) {
    const data = matrix || exportMatrix();
    if (!data) return '\ufeff';
    const lines = [data.header.map(csvField).join(',')];
    for (const row of data.rows) lines.push([row.label, row.date, ...row.cells].map(csvField).join(','));
    return `\ufeff${lines.join('\r\n')}\r\n`;
  }
  const EXPORT_FONT = '"PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  /** 量文字宽度用的小画布（整张表共用一份，不每量一段就建一个）。 */
  let exportMeasure = null;
  function exportMeasureCtx() {
    if (exportMeasure) return exportMeasure;
    try { const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1; exportMeasure = canvas.getContext?.('2d') || null; } catch { exportMeasure = null; }
    return exportMeasure;
  }
  /** 中文没有空格，按宽度逐字折行。 */
  function exportWrap(text, maxWidth) {
    const ctx = exportMeasureCtx();
    if (!ctx) return [text];
    const out = [];
    for (const paragraph of String(text).split('\n')) {
      let line = '';
      for (const char of paragraph) {
        if (line && ctx.measureText(line + char).width > maxWidth) { out.push(line); line = char; } else line += char;
      }
      if (line) out.push(line);
    }
    return out.length ? out : [''];
  }
  /** 一格里一行字用多大字号、要不要折行（放不下就先缩字号，最小 9.5px）。 */
  function exportFit(text, maxWidth, startPx = 12) {
    const ctx = exportMeasureCtx();
    let size = startPx;
    if (!ctx) return { size, lines: [text] };
    ctx.font = `${size}px ${EXPORT_FONT}`;
    if (ctx.measureText(text).width <= maxWidth) return { size, lines: [text] };
    while (size > 9.5) {
      size -= 0.5;
      ctx.font = `${size}px ${EXPORT_FONT}`;
      if (ctx.measureText(text).width <= maxWidth) return { size, lines: [text] };
    }
    return { size, lines: exportWrap(text, maxWidth) };
  }
  /** 导出颜色：和页面课卡同一套调色板（按课程名取色，同一门课颜色一致）。 */
  function exportPalette(name) {
    const palette = [['#e8f3ec', '#1f5a46'], ['#fdf1e3', '#8a5a1c'], ['#eaf0fb', '#2f4b8f'], ['#f6ecf7', '#6b3b7a'], ['#fdecec', '#8b3445'], ['#eef7f8', '#22606b'], ['#f3f1e6', '#5c5a2e']];
    let hash = 0;
    for (let index = 0; index < name.length; index += 1) hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
    return palette[hash % palette.length];
  }
  /** 把整张表画成 PNG（canvas 2D，零依赖）：行 = 星期，列 = 节次。 */
  function drawExportPng(matrix) {
    if (!matrix) return '';
    const ctx0 = exportMeasureCtx();
    if (!ctx0) return '';
    const padding = 22; const headHeight = 52; const weekHeight = 34;
    const widths = [104, 104, ...matrix.columns ? matrix.header.slice(2).map(() => 168) : []];
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    // 第一遍：量每格文字（字号 / 折行），据此定行高
    const fits = [];
    const rowHeights = [];
    for (const row of matrix.rows) {
      let need = 50;
      row.cells.forEach((cell, index) => {
        if (!cell) return;
        for (const one of String(cell).split('\n')) {
          const fit = exportFit(one, widths[index + 2] - 20, 12.5);
          fits.push(fit);
          need = Math.max(need, fit.lines.length * (fit.size + 5.5) + 16);
        }
      });
      rowHeights.push(Math.max(50, Math.min(260, Math.round(need))));
    }
    const tableWidth = widths.reduce((sum, value) => sum + value, 0);
    const headHeightAll = headHeight + weekHeight;
    const bodyHeight = rowHeights.reduce((sum, value) => sum + value, 0);
    const width = padding * 2 + tableWidth;
    const height = padding + headHeightAll + bodyHeight + padding + 20;
    const ratio = Math.min(2, Math.max(1, Number(window.devicePixelRatio) || 1));
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const columnsX = [padding];
    widths.forEach((value) => columnsX.push(columnsX.at(-1) + value));
    const right = padding + tableWidth;
    ctx.fillStyle = '#f1efe7'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(padding, padding, tableWidth, headHeightAll + bodyHeight);
    ctx.fillStyle = '#1d2b24'; ctx.font = `bold 22px ${EXPORT_FONT}`;
    ctx.fillText(matrix.title, padding, padding + 15);
    ctx.fillStyle = '#f6f4ec'; ctx.fillRect(padding, padding, tableWidth, headHeightAll);
    // 表头
    ctx.textAlign = 'center';
    matrix.header.forEach((label, index) => {
      const x = columnsX[index] + widths[index] / 2;
      if (index === 0) {
        ctx.fillStyle = '#3d4a44'; ctx.font = `bold 13px ${EXPORT_FONT}`;
        ctx.fillText('星期', x, padding + headHeightAll / 2 - 7);
        ctx.fillStyle = '#7b8480'; ctx.font = `11.5px ${EXPORT_FONT}`;
        ctx.fillText('日期', x, padding + headHeightAll / 2 + 8);
        return;
      }
      const [name, ...rest] = String(label).split(' ');
      ctx.fillStyle = '#2f3b35'; ctx.font = `bold 13px ${EXPORT_FONT}`;
      ctx.fillText(name, x, padding + 20);
      ctx.fillStyle = '#7b8480'; ctx.font = `11.5px ${EXPORT_FONT}`;
      ctx.fillText(rest.join(' '), x, padding + 40);
    });
    ctx.strokeStyle = '#c9c3b2'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(padding, padding + headHeightAll + 0.5); ctx.lineTo(right, padding + headHeightAll + 0.5); ctx.stroke();
    // 数据行：一行 = 一天
    let y = padding + headHeightAll;
    matrix.rows.forEach((row, rowIndex) => {
      const rowHeight = rowHeights[rowIndex];
      if (rowIndex % 2 === 1) { ctx.fillStyle = '#fbfaf5'; ctx.fillRect(padding, y, tableWidth, rowHeight); }
      if (row.date === localDate()) { ctx.fillStyle = '#fff8e2'; ctx.fillRect(padding, y, tableWidth, rowHeight); }
      row.cells.forEach((cell, index) => {
        const x = columnsX[index + 2];
        const cellWidth = widths[index + 2];
        if (!cell) return;
        const palette = exportPalette(String(cell.split('\n')[0] || ''));
        ctx.fillStyle = palette[0]; ctx.fillRect(x + 2, y + 3, cellWidth - 4, rowHeight - 6);
        ctx.fillStyle = palette[1]; ctx.fillRect(x + 2, y + 3, 3, rowHeight - 6);
        const lines = [];
        for (const one of String(cell).split('\n')) {
          const fit = exportFit(one, cellWidth - 20, 12.5);
          for (const line of fit.lines) lines.push({ line, size: fit.size });
        }
        const total = lines.reduce((sum, item) => sum + item.size + 5.5, 0);
        let cursor = y + rowHeight / 2 - total / 2 + (lines.length ? (lines[0].size + 5.5) / 2 : 0);
        ctx.textAlign = 'left';
        for (const item of lines) {
          ctx.fillStyle = palette[1]; ctx.font = `${item.size}px ${EXPORT_FONT}`;
          ctx.fillText(item.line, x + 9, cursor);
          cursor += item.size + 5.5;
        }
      });
      // 星期 + 日期两列
      ctx.textAlign = 'left';
      ctx.fillStyle = row.date === localDate() ? '#8a6d00' : '#2f3b35';
      ctx.font = `bold 13px ${EXPORT_FONT}`;
      ctx.fillText(row.label, columnsX[0] + 10, y + rowHeight / 2 - 9);
      ctx.fillStyle = '#7b8480'; ctx.font = `11.5px ${EXPORT_FONT}`;
      ctx.fillText(row.date, columnsX[1] + 10, y + rowHeight / 2 + 8);
      ctx.strokeStyle = '#e6e1d3'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padding, y + rowHeight + 0.5); ctx.lineTo(right, y + rowHeight + 0.5); ctx.stroke();
      y += rowHeight;
    });
    ctx.strokeStyle = '#d8d3c4'; ctx.lineWidth = 1;
    for (const x of columnsX) { ctx.beginPath(); ctx.moveTo(x + 0.5, padding); ctx.lineTo(x + 0.5, padding + headHeightAll + bodyHeight); ctx.stroke(); }
    return canvas.toDataURL('image/png');
  }
  /** 导出入口：渲染成文本 / 图片，交给主进程弹保存对话框落盘。 */
  async function exportTimetable(format) {
    state.exportMenu = false;
    const matrix = exportMatrix();
    if (!matrix) { state.error = '这一周还没有课表数据，稍等一下再导出。'; render(); return; }
    if (!api()?.exportTimetable) { state.error = '当前版本不支持导出课表。'; render(); return; }
    state.exportBusy = true;
    try {
      const name = `课表-${matrix.weekStart}.${format}`;
      const payload = format === 'png'
        ? { format, name, dataUrl: drawExportPng(matrix) }
        : { format, name, text: exportCsvText(matrix) };
      if (format === 'png' && !payload.dataUrl) throw new Error('课表图片生成失败，请重试');
      const result = await api().exportTimetable(payload);
      if (result?.canceled) { render(); return; }
      state.notice = `已导出${format === 'png' ? '图片 PNG' : '表格 CSV'}：${name}`;
    } catch (error) {
      state.error = userError(error, '导出课表失败，请稍后重试');
    } finally {
      state.exportBusy = false;
      render();
    }
  }

  /**
   * 导出内容的「预览」：和真正导出走**同一条**生成链路，只是不落盘。
   * 给自检用（系统保存对话框没法自动点），排障时也能一眼看出发出去的到底是什么。
   */
  function exportPreview(format) {
    const matrix = exportMatrix();
    if (!matrix) return null;
    const name = `课表-${matrix.weekStart}.${format === 'png' ? 'png' : 'csv'}`;
    return format === 'png' ? { name, dataUrl: drawExportPng(matrix) } : { name, text: exportCsvText(matrix), header: matrix.header, rows: matrix.rows.length };
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
      return `<article class="school-task-row ${hidden ? 'is-hidden-task' : ''}${compact ? ' is-compact' : ''}"><button type="button" class="school-task-main" data-school-action="task" data-course="${esc(task.courseId)}" data-id="${esc(task.id.split(':').at(-1))}"><span class="school-task-course">${esc(task.course || '课程作业')}</span><strong>${esc(task.title)}</strong><span class="school-task-due ${task.pastDue ? 'is-overdue' : ''}">${esc(task.dueAt ? stamp(task.dueAt) : task.dueText || '截止日期请查原网页')}${task.status ? ` · ${esc(task.status)}` : ''}</span></button>${task.score ? `<span class="school-score">${esc(task.score)}</span>` : ''}${compact ? '' : `<button type="button" class="school-text-button" data-school-action="hide-task" data-id="${esc(task.id)}" title="仅更改本地列表，不修改 ManageBac">${hidden ? '恢复' : '隐藏'}</button>`}</article>`;
    }).join('');
  }
  /** 已提交 / 已完成（ManageBac 的 status 原文 + 常见中文说法）。 */
  const submitted = (task) => /submit|complet|done|graded|assessed|已提交|已完成|已交|已批/.test(String(task?.status || '').toLowerCase());

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
    // 未提交的在上、已提交的在下，中间一条分割线；已提交那一组灰显（和网页端一样）。
    const pending = items.filter((task) => !submitted(task));
    const done = items.filter((task) => submitted(task));
    const list = `${taskRows(pending)}${pending.length ? '' : '<div class="school-empty school-empty--tight"><p>没有未提交的作业。</p></div>'}`;
    const doneBlock = done.length
      ? `<div class="school-list-sep"><span>已提交 · ${done.length} 项</span></div><div class="school-task-list is-done">${taskRows(done)}</div>`
      : '';
    return `${syncSummary('managebac')}<div class="school-section-head"><div><span class="section-kicker">TASKS & DEADLINES</span><h2>${state.showHidden ? '已隐藏' : '课程作业'} <small>${items.length}</small></h2></div><button type="button" class="school-text-button" data-school-action="toggle-hidden">${state.showHidden ? '返回作业列表' : `查看已隐藏 (${data.tasks.filter((task) => hidden.has(task.id)).length})`}</button></div><div class="school-task-filters"><input type="search" value="${esc(state.query)}" data-school-field="query" placeholder="搜索作业或课程" aria-label="搜索作业或课程"/><select data-school-field="task-sort" aria-label="作业排序"><option value="due" ${state.taskSort === 'due' ? 'selected' : ''}>明确截止时间优先</option><option value="name" ${state.taskSort === 'name' ? 'selected' : ''}>作业名称</option></select></div><div class="school-task-list">${items.length ? list : '<div class="school-empty"><h3>这里暂时没有作业</h3><p>试试其他关键词，或在原网页核对最新安排。</p></div>'}</div>${doneBlock}`;
  }
  function core() {
    return `<div class="school-section-head"><div><span class="section-kicker">IB CORE</span><h2>把长期项目放在心上</h2></div></div><div class="school-core-grid"><article><span class="section-kicker">EXPERIENCES & REFLECTIONS</span><h3>CAS</h3><p>查看活动目标与进度，回到原网页整理证据、完成反思。</p>${btn('读取 CAS 概览', 'core', 'data-kind="cas"', true)}</article><article><span class="section-kicker">EXTENDED ESSAY</span><h3>EE</h3><p>查看论文工作表与项目摘要，让下一步有据可查。</p>${btn('读取 EE 概览', 'core', 'data-kind="ee"', true)}</article></div><div class="school-callout">这些内容不会自动交给 AI，也不会代你提交任何表单。</div>${btn('登录 ManageBac 账号', 'account', 'data-site="managebac"')}`;
  }

  /**
   * 讨论：把每门课程的讨论区汇总到一栏里（用户 2026-09-19：「我的课程界面加一个
   * discussion 界面」）。ManageBac 只有「按课程」的讨论列表接口，所以这里逐门课读、
   * 并发 3 路、读到的缓存住；再进这一栏不会重复请求，换了账号/快照会重读。
   */
  async function loadDiscussions({ force = false } = {}) {
    const courses = state.snapshot.managebac?.courses || [];
    const key = courses.map((course) => course.id).join(',');
    if (state.discussionsBusy) return;
    if (!api()?.discussions) return;
    if (!force && state.discussions && state.discussions.key === key) return;
    state.discussionsBusy = true;
    state.discussions = { key, items: [], failed: [], progress: 0, total: courses.length };
    render();
    const items = [];
    const failed = [];
    const queue = [...courses];
    const worker = async () => {
      while (queue.length) {
        const course = queue.shift();
        // 换了账号/快照就把这一轮的结果丢掉，别把上一个账号的讨论画出来。
        if (state.discussions?.key !== key) return;
        try {
          const result = await api().discussions(course.id);
          for (const item of result?.discussions || []) items.push({ ...item, course: course.name, courseId: course.id });
        } catch (error) {
          if (!/LOGIN_REQUIRED|登录/.test(String(error?.message || error))) failed.push(course.name || course.id);
        }
        if (state.discussions?.key === key) { state.discussions.progress += 1; render(); }
      }
    };
    await Promise.all([worker(), worker(), worker()].slice(0, Math.max(1, Math.min(3, courses.length))));
    if (state.discussions?.key !== key) return;
    // ManageBac 的讨论列表里没有可靠的时间字段，所以按「课程 → 标题」排，
    // 顺序稳定、看得出是哪门课的哪个帖子（不假装有时间顺序）。
    items.sort((a, b) => String(a.course).localeCompare(String(b.course), 'zh-CN') || String(a.title).localeCompare(String(b.title), 'zh-CN'));
    state.discussions = { key, items, failed, progress: courses.length, total: courses.length };
    state.discussionsBusy = false;
    render();
  }

  function discussions() {
    const data = state.discussions;
    const loading = state.discussionsBusy && data;
    const head = (count) => `<div class="school-section-head"><div><span class="section-kicker">DISCUSSIONS</span><h2>课程讨论${count == null ? '' : ` <small>${count}</small>`}</h2></div>${loading ? `<span class="school-footnote">正在读取 ${data.progress}/${data.total} 门课程…</span>` : ''}</div>`;
    if (!data) return `${head(null)}<div class="school-empty"><p>正在读取各门课程的讨论…</p></div>`;
    const query = state.query.toLocaleLowerCase();
    const items = data.items.filter((item) => !query || `${item.title} ${item.course} ${item.author} ${item.preview}`.toLocaleLowerCase().includes(query));
    const list = items.length
      ? `<div class="school-discussion-list">${items.map((item) => `<button type="button" class="school-discussion-row" data-school-action="discussion" data-course="${esc(item.courseId)}" data-id="${esc(item.id)}"><span class="school-discussion-course">${esc(item.course || '课程')}</span><strong>${esc(item.title || '（无标题）')}</strong><small>${esc([item.author, item.category].filter(Boolean).join(' · ') || '作者未提供')}</small>${item.preview ? `<p>${esc(item.preview)}</p>` : ''}</button>`).join('')}</div>`
      : `<div class="school-empty${data.items.length ? ' school-empty--tight' : ''}"><h3>${data.items.length ? '没有匹配的讨论' : '暂时没有讨论'}</h3><p>${data.items.length ? '换个关键词试试。' : 'ManageBac 上还没有开放讨论区。'}</p></div>`;
    const warn = data.failed.length ? `<div class="school-callout">有 ${data.failed.length} 门课程的讨论没读到（${esc(data.failed.slice(0, 3).join('、'))}${data.failed.length > 3 ? ' 等' : ''}），下次打开会重试。</div>` : '';
    return `${head(items.length)}<div class="school-task-filters"><input type="search" value="${esc(state.query)}" data-school-field="query" placeholder="搜索讨论标题、课程或作者" aria-label="搜索讨论"/></div>${list}${warn}`;
  }
  /** 通知 / 待办（读一次、缓存住；进这个标签页或点刷新时才会再读）。 */
  async function loadNotifications({ force = false } = {}) {
    if (state.notificationsBusy) return;
    if (!force && state.notifications) return;
    if (!api()?.notifications) return;
    state.notificationsBusy = true;
    render();
    try {
      state.notifications = await api().notifications();
    } catch (error) {
      state.notifications = { items: [], unreadCount: null, warnings: [userError(error, '通知读取失败，请稍后重试')] };
    } finally {
      state.notificationsBusy = false;
      render();
    }
  }

  function notifications() {
    const data = state.notifications;
    const head = (count) => `<div class="school-section-head"><div><span class="section-kicker">NOTIFICATIONS</span><h2>通知与待办${count == null ? '' : ` <small>${count}</small>`}</h2></div></div>`;
    if (!data) {
      return `${head(null)}<div class="school-empty"><p>正在读取通知与待办…</p></div>`;
    }
    const rows = Array.isArray(data.items) ? data.items : [];
    const unread = Number.isInteger(data.unreadCount) ? data.unreadCount : null;
    const isPast = (row) => { const ts = Date.parse(row.due || row.dueText || ''); return Number.isFinite(ts) && ts < Date.now(); };
    const pastCount = rows.filter(isPast).length;
    // 通知正文由 ManageBac 自己的通知中心（mnn-hub）下发，页面里只有未读数，
    // 所以这里如实分开说：未读数照读，列表是待办/即将截止，正文点链接去原网页。
    const foot = `<div class="school-notif-foot"><span>ManageBac 通知中心：${
      unread == null ? '未读数没读到' : `${unread} 条未读`} · 下面是 ${rows.length} 条待办与截止${
      pastCount ? `（其中 ${pastCount} 条已过期）` : ''}</span>${
      data.notificationsUrl ? btn('去通知中心', 'original', `data-url="${esc(data.notificationsUrl)}"`) : ''}</div>`;
    const list = rows.length
      ? `<div class="school-notif-list">${rows.map((row) => {
        const due = row.due || row.dueText || '';
        const overdue = due && Number.isFinite(Date.parse(due)) && Date.parse(due) < Date.now();
        return `<article class="school-notif-item"><div class="school-notif-item__main"><strong>${esc(row.title || '（无标题）')}</strong><small>${esc([row.course, row.dueText || row.due, row.status].filter(Boolean).join(' · ') || '—')}</small></div>${overdue ? '<span class="school-notif-overdue">已过期</span>' : ''}${row.link ? btn('在原网页查看', 'original', `data-url="${esc(row.link)}"`) : ''}</article>`;
      }).join('')}</div>`
      : '<div class="school-empty school-empty--tight"><p>暂时没有待办或即将截止的作业。</p></div>';
    const warn = (data.warnings || []).length ? `<div class="school-callout">${esc(data.warnings.join('；'))}</div>` : '';
    return `${head(rows.length)}${list}${warn}${foot}`;
  }
  function courseWorkspace() {
    const tabs = [['courses', '课程'], ['notifications', '通知'], ['tasks', '作业与截止'], ['discussions', '讨论'], ['core', 'CAS / EE']];
    return `<nav class="school-course-tabs" aria-label="课程内容">${tabs.map(([key, label]) => `<button type="button" data-school-action="course-tab" data-course-tab="${key}" class="${state.courseTab === key ? 'active' : ''}" aria-current="${state.courseTab === key ? 'page' : 'false'}">${label}</button>`).join('')}</nav>${state.courseTab === 'courses' ? courses() : state.courseTab === 'notifications' ? notifications() : state.courseTab === 'discussions' ? discussions() : state.courseTab === 'tasks' ? tasks() : core()}`;
  }
  function render() {
    if (!root) return;
    timeLineObserver?.disconnect();
    const source = activeSource();
    const data = state.snapshot[source];
    const page = isClassTimetable() ? { title: '班级课表', description: '查看当前账号所属班级的课程与教室安排。' } : state.route === 'courses' ? { title: '我的课程', description: '查看课程、作业截止时间与 CAS / EE 项目。' } : { title: '我的课表', description: '从 EduPage 同步课程，选择自己的教学组。' };
    // 用户 2026-09-19：「所有同步、刷新全都自动，不要让用户察觉，最多来一行不起眼的小字
    // 在角落」—— 所以这里没有「自动更新」开关、也没有刷新按钮，只有右下角那行数据时间。
    root.innerHTML = `<div class="school-top"><div><span class="section-kicker">PH LAUNCHER × HELLO PINGHE!</span><h1>${page.title}</h1><p>${page.description}</p></div></div>${state.error ? `<div class="school-error" role="alert">${esc(state.error)}</div>` : ''}${state.notice ? `<div class="school-success" role="status">${esc(state.notice)}</div>` : ''}${state.busy.size && !data ? '<div class="school-loading" role="status"><span></span>正在读取学校数据，请稍候。你可以继续使用其他本地工具。</div>' : ''}${isTimetableRoute() ? timetable() : courseWorkspace()}<footer class="school-credit">合作整合：PH Launcher · Hello Pinghe! Launcher <span>非学校官方应用</span></footer>`;
    if (state.error) {
      const challenge = /验证码|双重验证|额外验证/.test(state.error);
      root.querySelector('[role="alert"]')?.insertAdjacentHTML('afterend', `<div class="school-actions">${btn('修改登录账号', 'account', `data-site="${source}"`)}${challenge ? btn('完成学校验证', 'login', `data-site="${source}"`, true) : ''}</div>`);
    }
    fitTimetableRows();
    updateTimeLine();
    const grid = root.querySelector('#schoolTimetableGrid');
    if (grid && window.ResizeObserver) {
      timeLineObserver ||= new window.ResizeObserver(updateTimeLine);
      timeLineObserver.observe(grid);
      // Rest rows and lesson rows can change independently, even when the
      // total grid height stays the same (fonts, wrapping, hidden pages).
      grid.querySelectorAll('.school-tt-time').forEach((cell) => timeLineObserver.observe(cell));
    }
  }
  /**
   * 当前时间指示线（照 Lite 的 `updateNowLine`）：一根横线贯穿整张课表，落在「现在」
   * 对应的那一节里，按时间比例插值。只在看本周、且时间落在校内时段时显示。
   */
  function updateTimeLine() {
    if (!root) return;
    const grid = root.querySelector('#schoolTimetableGrid');
    const old = grid?.querySelector('.school-now-line');
    if (old) old.remove();
    if (!grid) return;
    if (state.week !== monday()) return; // 只看本周时才画
    const now = new Date();
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((part) => [part.type, part.value]));
    const time = Number(parts.hour) * 60 + Number(parts.minute) + Number(parts.second) / 60;
    if (time < PHL_FLOOR || time > PHL_CEILING) return;
    const index = PHL_PERIODS.findIndex((period) => time <= period.end);
    if (index < 0) return;
    const period = PHL_PERIODS[index];
    const rows = [...grid.querySelectorAll('.school-tt-time')];
    const cell = rows.find((node) => parseInt(node.style.gridRow, 10) === index + 2);
    const firstDay = grid.querySelector('.school-tt-head:not(.school-tt-corner)');
    if (!cell?.offsetHeight || !firstDay) return;
    let top;
    if (time < period.start) {
      // A break belongs in the actual gap between rows, not in the next
      // lesson. Long afternoon breaks use the same compressed grid gap.
      const previous = rows.find((node) => parseInt(node.style.gridRow, 10) === index + 1);
      if (!previous?.offsetHeight) return;
      const bottom = previous.offsetTop + previous.offsetHeight;
      const ratio = (time - PHL_PERIODS[index - 1].end) / (period.start - PHL_PERIODS[index - 1].end);
      top = bottom + (cell.offsetTop - bottom) * ratio;
    } else {
      top = cell.offsetTop + cell.offsetHeight * (time - period.start) / (period.end - period.start);
    }
    // Both anchors share the positioned grid's layout coordinates. Keeping
    // the overlay inside that grid makes scrolling and page zoom automatic.
    const line = document.createElement('div');
    line.className = 'school-now-line';
    line.setAttribute('aria-label', `当前时间 ${parts.hour}:${parts.minute}`);
    line.style.top = `${top}px`;
    line.style.left = `${firstDay.offsetLeft}px`;
    grid.append(line);
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
    showDialog('连接学校账号', `<p>将连接你的 ${source === 'edupage' ? 'EduPage' : 'ManageBac'} 账号，读取${source === 'edupage' ? '所属班级的课程、教学组、任课老师和教室' : '课程、成绩、作业、讨论与项目摘要'}。选择“登录并同步”时会使用本机保存的账号密码完成此次登录。</p><div class="school-callout">内容仅保留在本次打开期间；不会自动发送给 AI，同步本身只读取内容，不会提交作业、回复讨论或修改学校信息。共享电脑上请先确认这是你自己的账号。</div><p>数据可能识别不完整，请与学校记录核对。只有你主动确认加入计划的课程会保存为本地提醒。</p>`, `${btn('暂不连接', 'close')}${btn('同意并继续', 'consent', `data-source="${source}"`, true)}`);
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
      if (allowRefresh && autoApproved('edupage') && visible() && isStale('edupage')) sync('edupage', { force: false, weekStart });
    } catch (error) {
      if (request !== state.refreshId) return;
      state.error = userError(error, '无法读取这一周的课表'); render();
    }
  }
  /** 自动同步：页面可见 + 已登录 + 数据过期时才悄悄对一次，界面上没有任何按钮。 */
  function autoRefresh(source = activeSource()) {
    if (authBlocked.has(source) || !visible() || !autoApproved(source) || state.busy.has(source) || !isStale(source)) return;
    sync(source, { force: false, weekStart: state.week });
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
    const savedSelection = selections();
    const selected = savedSelection || [];
    const inference = teachingGroupInference(data);
    const automatic = inference.status === 'automatic' && (autoRecognize || savedSelection === null);
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
    // Group the options by subject so a long timetable stays readable. Native
    // language courses and homeroom (班会) are checked by default on a fresh
    // profile; saved selections always win.
    const bySubject = new Map();
    for (const option of data.options) {
      const subject = option.course || option.label.split(' · ')[0] || '未命名课程';
      if (!bySubject.has(subject)) bySubject.set(subject, []);
      bySubject.get(subject).push(option);
    }
    const subjectEntries = [...bySubject.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'));
    const isDefaultOn = (option) => /(?:^|[^a-z])native|班会|homeroom|class\s*meeting/i.test(`${option.course || ''} ${(option.groups || []).join(' ')} ${option.label || ''}`);
    const hasSavedSelection = savedSelection !== null || inferred.length > 0;
    const checkedFor = (option) => selected.includes(option.key) || inferred.includes(option.key) || (!hasSavedSelection && isDefaultOn(option));
    const groupBody = subjectEntries.map(([subject, options]) => `<details class="school-subject-group" data-school-subject-group data-subject="${esc(subject)}"><summary><strong>${esc(subject)}</strong><span class="school-subject-count" data-school-subject-count="${esc(subject)}"></span></summary><div class="school-subject-options">${options.map((option) => {
      const roomLine = (option.rooms || []).filter(Boolean).join('、');
      const timeLine = (option.times || []).filter(Boolean).join('、');
      const title = (option.groups || []).filter(Boolean).join(' / ') || option.teacher || '教学组';
      const meta = [option.teacher, roomLine && `教室 ${roomLine}`, timeLine && `时间 ${timeLine}`].filter(Boolean);
      const searchText = [subject, option.label, option.teacher, roomLine, timeLine].filter(Boolean).join(' ').toLocaleLowerCase();
      return `<label data-school-group-option data-subject="${esc(subject)}" data-search="${esc(searchText)}"><input type="checkbox" name="school-group" value="${esc(option.key)}" ${checkedFor(option) ? 'checked' : ''}/><span><strong>${esc(title)}</strong>${meta.length ? `<small class="school-group-meta">${esc(meta.join(' · '))}</small>` : ''}</span></label>`;
    }).join('')}</div></details>`).join('');
    showDialog('选择自己的教学组', `<p>按学科展开，勾选你实际参加的教学组。相似课名可能对应不同老师或不同时间。</p>${inferenceNote}<div class="school-group-filters"><input type="search" data-school-field="group-query" placeholder="搜索学科、教学组或老师" aria-label="搜索教学组"><button type="button" class="school-text-button" data-school-action="groups-expand">展开全部</button><button type="button" class="school-text-button" data-school-action="groups-collapse">收起全部</button></div><div class="school-group-tools"><span class="school-group-count" role="status"></span><button type="button" class="school-text-button" data-school-action="groups-all">勾选当前结果</button><button type="button" class="school-text-button" data-school-action="groups-none">清空当前结果</button></div><div class="school-group-list">${groupBody}</div><p class="school-group-no-results" hidden>没有符合条件的教学组。</p>`, `${btn('取消', 'close')}${btn('保存选择', 'save-groups', '', true)}`);
    modal.schoolGroupAccount = data.accountKey;
    modal.schoolGroupEpochs = JSON.stringify(state.epochs);
    filterGroupOptions();
  }
  function filterGroupOptions() {
    if (!modal?.open) return;
    const query = (modal.querySelector('[data-school-field="group-query"]')?.value || '').trim().toLocaleLowerCase();
    let visibleCount = 0;
    for (const option of modal.querySelectorAll('[data-school-group-option]')) {
      option.hidden = Boolean(query && !option.dataset.search.includes(query));
      if (!option.hidden) visibleCount += 1;
    }
    // Search opens matching subjects and hides empty ones, so the user never
    // stares at a collapsed section that actually has results.
    for (const group of modal.querySelectorAll('[data-school-subject-group]')) {
      const visible = [...group.querySelectorAll('[data-school-group-option]')].filter((option) => !option.hidden);
      if (query) group.open = visible.length > 0;
      const checked = visible.filter((option) => option.querySelector('input')?.checked).length;
      const counter = group.querySelector('[data-school-subject-count]');
      if (counter) counter.textContent = visible.length ? `${visible.length} 个教学组${checked ? ` · 已选 ${checked}` : ''}` : '无匹配';
      group.hidden = visible.length === 0;
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
      if (action === 'course-tab') { state.courseTab = button.dataset.courseTab; state.error = ''; state.notice = ''; render(); autoRefresh(); if (state.courseTab === 'notifications') void loadNotifications(); if (state.courseTab === 'discussions') void loadDiscussions(); }
      if (action === 'login') { modal?.close(); await window.openSite(button.dataset.site); }
      if (action === 'consent') { const callback = modal.schoolConsentAction; state.consent.add(button.dataset.source); modal.close(); if (callback) callback(); }
      if (action === 'week') { if (state.busy.has('edupage')) return; const delta = Number(button.dataset.delta); state.week = delta ? shift(state.week, delta) : monday(); state.notice = ''; render(); loadWeek(state.week); }
      if (action === 'toggle-weekend') { state.showWeekend = !state.showWeekend; render(); }
      if (action === 'groups') groupsDialog();
      if (action === 'export-menu') { state.exportMenu = !state.exportMenu; render(); }
      if (action === 'export-csv') await exportTimetable('csv');
      if (action === 'export-png') await exportTimetable('png');
      if (action === 'auto-groups') groupsDialog(true);
      if (action === 'auto-sync-courses') consent('managebac', async () => {
        modal?.close(); await sync('managebac');
        if (!state.error && state.snapshot.managebac?.courses?.length) groupsDialog(true);
      });
      if (action === 'apply-group-suggestions') { const inference = teachingGroupInference(currentWeek()); modal.querySelectorAll('[name="school-group"]').forEach((input) => { if (inference.keys.includes(input.value)) { input.checked = true; input.setAttribute('checked', ''); } }); filterGroupOptions(); }
      if (action === 'groups-all' || action === 'groups-none') { modal.querySelectorAll('[data-school-group-option]').forEach((option) => { if (!option.hasAttribute('hidden')) { const input = option.querySelector('[name="school-group"]'); input.checked = action === 'groups-all'; input.toggleAttribute('checked', action === 'groups-all'); } }); filterGroupOptions(); }
      if (action === 'groups-expand' || action === 'groups-collapse') {
        modal.querySelectorAll('[data-school-subject-group]').forEach((group) => { group.open = action === 'groups-expand'; });
      }
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
        showDialog(lesson.course, `<div class="school-lesson-detail school-color-${color(lesson.groupKey)}"><strong>${lesson.date} · ${lesson.start}–${lesson.end}</strong><p>${esc(lesson.room || '教室未提供')} · ${esc(lesson.teacher || '老师未提供')}</p><p>${esc((lesson.groups || []).join(' / ') || '教学组未提供')}</p>${lesson.cancelled ? '<p>这节课程已取消，不会导入提醒。</p>' : ''}</div>`, `${btn((prefs().highlights || []).includes(lesson.groupKey) ? '取消重点标记' : '标记这个教学组', 'highlight', `data-key="${esc(lesson.groupKey)}"`)}${btn('打开 EduPage', 'login', 'data-site="edupage"')}`);
      }
      if (action === 'lesson-cluster') {
        const items = groupLessons(displayedLessons()).filter((item) => item.date === button.dataset.date && item.start < button.dataset.end && item.end > button.dataset.start);
        if (items.length < 3) return;
        showDialog(`${items.length} 门冲突课程`, `<p>这些课程时间重叠。请逐项核对教学组、教室与老师。</p><div class="school-conflict-list">${items.map((item) => `<button type="button" class="school-conflict-row school-color-${color(item.groupKey)} ${(prefs().highlights || []).includes(item.groupKey) ? 'is-highlighted' : ''} ${item.cancelled ? 'is-cancelled' : ''}" data-school-action="lesson" data-id="${esc(item.id)}"><strong>${esc(item.course)}</strong><span>${esc(`${item.start}–${item.end} · ${item.room || '教室未提供'}`)}</span><span>${esc([item.teacher, (item.groups || []).join(' / ')].filter(Boolean).join(' · ') || '教学组未提供')}</span>${item.count > 1 ? `<small>${item.count} 节连堂</small>` : ''}</button>`).join('')}</div>`);
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
      // before rendering or starting any optional network refresh. Cached data
      // stays on screen; only an empty workspace shows the placeholder text.
      if (!state.snapshot[activeSource()]) root.textContent = '正在读取本地记录…';
      if (next === 'courses') { render(); void loadNotifications(); return refresh(); }
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
  window.schoolUI = { mount, open, refresh, connect, snapshot: () => state.snapshot, reloadNotifications: () => loadNotifications({ force: true }), reloadDiscussions: () => loadDiscussions({ force: true }), exportPreview };
})();

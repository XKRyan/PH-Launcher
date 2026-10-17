(() => {
  'use strict';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  function project(snapshot, now = Date.now()) {
    const edu = snapshot?.edupage;
    const prefs = snapshot?.preferences || {};
    const selected = edu && prefs.accountKey === edu.accountKey && Array.isArray(prefs.groups) ? prefs.groups : null;
    const lessons = selected === null ? [] : (edu.lessons || [])
      .filter((lesson) => !lesson.cancelled && selected.includes(lesson.groupKey))
      .map((lesson) => ({...lesson, begins: Date.parse(`${lesson.date}T${lesson.start}:00+08:00`), ends: Date.parse(`${lesson.date}T${lesson.end}:00+08:00`)}))
      .sort((a, b) => a.begins - b.begins);
    const tasks = (snapshot?.managebac?.tasks || []).filter((task) => {
      const due = Date.parse(task.dueAt);
      return Number.isFinite(due) && due >= now && due <= now + 14 * 86400000;
    }).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
    return {
      current: lessons.find((lesson) => lesson.begins <= now && lesson.ends > now),
      next: lessons.find((lesson) => lesson.begins > now),
      tasks,
      schoolReady: !!edu,
      selectionReady: selected !== null,
      tasksReady: !!snapshot?.managebac,
      todayLessons: (() => {
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(now));
        return lessons.filter((lesson) => lesson.date === today).slice(0, 5);
      })(),
    };
  }
  let request = 0;
  const set = (id, value) => {
    const node = document.getElementById(id);
    if (node && node.textContent !== value) node.textContent = value;
  };
  // The main process only returns the week it last selected, so ask for this
  // week explicitly; otherwise the home cards stay empty until the timetable
  // page has been opened once.
  function currentWeekStart(now = Date.now()) {
    const key = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(now));
    const date = new Date(`${key}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    return date.toISOString().slice(0, 10);
  }
  async function refresh() {
    if (!window.ph?.school?.get) return;
    const id = ++request;
    try {
      const now = Date.now();
      const snapshot = await window.ph.school.get({ weekStart: currentWeekStart(now) });
      if (id !== request) return;
      const view = project(snapshot, now);
      set('nextClassName', view.current ? `正在上课：${view.current.course}` : '当前没有课程');
      set('nextClassMeta', view.next
        ? `下一节：${view.next.course} · ${view.next.date} ${view.next.start}–${view.next.end} · ${view.next.room || '教室未提供'}`
        : !view.schoolReady ? '尚未同步 EduPage 课表' : !view.selectionReady ? '请先在我的课表选择教学组' : '已同步课表中暂无后续课程');
      set('todayTaskMetric', view.tasksReady ? `未来14天 · ${view.tasks.length} 项截止` : '尚未同步 ManageBac');
      set('overdueMetric', view.tasksReady ? '来自已同步的 ManageBac 作业' : '登录并同步后显示作业');
      const host = document.getElementById('dashboardDeadlines');
      if (host) {
        const html = view.tasks.slice(0, 5).map((task) => `<div class="dashboard-deadline"><strong>${esc(task.title)}</strong><small>${esc(task.courseName || task.course || '')} · ${esc(new Date(task.dueAt).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'}))}</small></div>`).join('') || '<p>未来14天暂无已知截止任务</p>';
        if (host.innerHTML !== html) host.innerHTML = html;
      }
      const timetableHost = document.getElementById('dashboardTimetable');
      if (timetableHost) {
        const html = view.todayLessons.length
          ? view.todayLessons.map((lesson) => `<div class="dashboard-lesson-line${view.current && lesson.id === view.current.id ? ' is-now' : ''}"><strong>${esc(lesson.start)}–${esc(lesson.end)}</strong><span>${esc(lesson.course)}${lesson.room ? ` · ${esc(lesson.room)}` : ''}</span></div>`).join('')
          : view.schoolReady && view.selectionReady ? '<p>今天没有课程。</p>' : '<p>同步 EduPage 并选择教学组后，这里会显示今天的课程。</p>';
        if (timetableHost.innerHTML !== html) timetableHost.innerHTML = html;
      }
      const count = window.mailUI?.unreadCount?.();
      set('unreadMailCount', count == null ? '邮箱尚未同步' : `${count} 封未读`);
    } catch {
      set('nextClassMeta', '暂时无法读取已同步数据，请稍后重试');
    }
  }
  window.dashboardData = {project, refresh, currentWeekStart};
})();

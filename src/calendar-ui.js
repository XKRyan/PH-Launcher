(() => {
  'use strict';
  const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
  const colors = { green: '松绿', wine: '莓红', gold: '暖金', blue: '湖蓝', purple: '紫藤', slate: '石灰' };
  const calendar = { host: null, dialog: null, events: [], view: 'month', anchor: noon(new Date()), selected: dateKey(new Date()), request: 0, busy: false, notice: '', error: '' };
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const safeColor = (value) => Object.hasOwn(colors, value) ? value : 'green';

  function noon(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12); }
  function dateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
  function fromKey(key) { const [year, month, day] = key.split('-').map(Number); return new Date(year, month - 1, day, 12); }
  function supported(date) { return date.getFullYear() >= 1900 && date.getFullYear() <= 2199; }
  function shifted(date, days) { const result = noon(date); result.setDate(result.getDate() + days); return result; }
  function monday(date) { return shifted(date, -((date.getDay() + 6) % 7)); }
  function dayLabel(key) { return fromKey(key).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }); }
  function eventsFor(key) { return calendar.events.filter((event) => event.date === key); }
  function timeLabel(event) { return event.start ? `${event.start}–${event.end}` : '全天'; }

  function nextAnchor(direction) {
    if (calendar.view === 'week') return shifted(calendar.anchor, direction * 7);
    if (calendar.view === 'month') return new Date(calendar.anchor.getFullYear(), calendar.anchor.getMonth() + direction, 1, 12);
    return new Date(calendar.anchor.getFullYear() + direction, calendar.anchor.getMonth(), 1, 12);
  }

  function heading() {
    if (calendar.view === 'year') return `${calendar.anchor.getFullYear()} 年`;
    if (calendar.view === 'month') return `${calendar.anchor.getFullYear()} 年 ${calendar.anchor.getMonth() + 1} 月`;
    const start = monday(calendar.anchor);
    const end = shifted(start, 6);
    return `${start.getFullYear()} 年 ${start.getMonth() + 1} 月 ${start.getDate()} 日 — ${end.getFullYear() !== start.getFullYear() ? `${end.getFullYear()} 年 ` : ''}${end.getMonth() + 1} 月 ${end.getDate()} 日`;
  }

  function eventButton(event, compact = false) {
    return `<button type="button" class="cal-event cal-color-${safeColor(event.color)}${compact ? ' compact' : ''}" data-cal-edit="${escape(event.id)}" title="${escape(`${timeLabel(event)} ${event.title}`)}"><span>${escape(event.start || '全天')}</span><strong>${escape(event.title)}</strong></button>`;
  }

  function monthGrid(month, mini = false) {
    const first = new Date(calendar.anchor.getFullYear(), month, 1, 12);
    const start = monday(first);
    const today = dateKey(new Date());
    const cells = Array.from({ length: 42 }, (_, index) => {
      const day = shifted(start, index);
      const key = dateKey(day);
      const items = eventsFor(key);
      const otherMonth = day.getMonth() !== month;
      if (mini && otherMonth) return '<span class="cal-mini-blank" aria-hidden="true"></span>';
      if (mini) return `<button type="button" class="cal-mini-day${key === today ? ' today' : ''}${items.length ? ' has-events' : ''}" data-cal-day="${key}" aria-label="${escape(`${dayLabel(key)}，${items.length} 项日程`)}"${!supported(day) ? ' disabled' : ''}><span>${day.getDate()}</span>${items.length ? '<i aria-hidden="true"></i>' : ''}</button>`;
      return `<div class="cal-month-cell${otherMonth ? ' other-month' : ''}${key === today ? ' today' : ''}${key === calendar.selected ? ' selected' : ''}"${supported(day) ? ` data-cal-day="${key}"` : ''}><button type="button" class="cal-day-number" data-cal-day="${key}" aria-label="${escape(`${dayLabel(key)}，${items.length} 项日程，点击查看或添加`)}"${key === today ? ' aria-current="date"' : ''}${!supported(day) ? ' disabled' : ''}>${day.getDate()}${key === today ? '<small>今天</small>' : ''}</button><div class="cal-cell-events">${items.slice(0, 3).map((event) => eventButton(event, true)).join('')}</div>${items.length > 3 ? `<button class="cal-more" data-cal-day="${key}">还有 ${items.length - 3} 项</button>` : ''}</div>`;
    }).join('');
    return `<div class="${mini ? 'cal-mini-grid' : 'cal-month-grid'}">${weekdays.map((label) => `<span class="cal-weekday">${mini ? label : `周${label}`}</span>`).join('')}${cells}</div>`;
  }

  function weekGrid() {
    const start = monday(calendar.anchor);
    const today = dateKey(new Date());
    return `<div class="cal-week-grid">${Array.from({ length: 7 }, (_, index) => {
      const day = shifted(start, index);
      const key = dateKey(day);
      const items = eventsFor(key);
      return `<section class="cal-week-day${key === today ? ' today' : ''}"><button type="button" class="cal-week-heading" data-cal-day="${key}"${!supported(day) ? ' disabled' : ''}><span>周${weekdays[index]}</span><strong>${day.getDate()}</strong><small>${day.getMonth() + 1} 月${key === today ? ' · 今天' : ''}</small></button><div class="cal-week-events">${items.map((event) => eventButton(event)).join('')}${!items.length ? '<span class="cal-free">留一点空白</span>' : ''}</div><button type="button" class="cal-add-in-day" data-cal-day="${key}"${!supported(day) ? ' disabled' : ''} aria-label="${escape(`为${dayLabel(key)}添加日程`)}">＋ 添加</button></section>`;
    }).join('')}</div>`;
  }

  function yearGrid() {
    return `<div class="cal-year-grid">${Array.from({ length: 12 }, (_, month) => `<section class="cal-mini-month"><button class="cal-month-title" data-cal-month="${month}">${month + 1} 月 <span>↗</span></button>${monthGrid(month, true)}</section>`).join('')}</div>`;
  }

  function render() {
    if (!calendar.host) return;
    calendar.host.innerHTML = `<header class="cal-page-head"><div><span class="section-kicker">MY CALENDAR</span><h2>把重要的日子，留在眼前。</h2><p>考试、社团、约定，还有属于自己的时间。</p></div><button type="button" class="primary-button" data-cal-new>＋ 添加日程</button></header><div class="cal-toolbar"><div class="cal-date-controls"><button class="cal-arrow" data-cal-step="-1" aria-label="上一${calendar.view === 'week' ? '周' : calendar.view === 'month' ? '月' : '年'}"${!supported(nextAnchor(-1)) ? ' disabled' : ''}>‹</button><button class="cal-today" data-cal-today>今天</button><button class="cal-arrow" data-cal-step="1" aria-label="下一${calendar.view === 'week' ? '周' : calendar.view === 'month' ? '月' : '年'}"${!supported(nextAnchor(1)) ? ' disabled' : ''}>›</button><h3>${heading()}</h3></div><div class="cal-view-switch" role="group" aria-label="日历视图">${[['week', '周'], ['month', '月'], ['year', '年']].map(([value, label]) => `<button type="button" data-cal-view="${value}" class="${calendar.view === value ? 'active' : ''}" aria-pressed="${calendar.view === value}">${label}</button>`).join('')}</div></div><p class="cal-status${calendar.error ? ' error' : ''}" role="status">${escape(calendar.error || calendar.notice)}</p><div class="cal-board">${calendar.view === 'week' ? weekGrid() : calendar.view === 'year' ? yearGrid() : monthGrid(calendar.anchor.getMonth())}</div><footer class="cal-foot"><span>点选日期即可查看、添加或编辑日程。</span><span>保存在这台电脑 · 不会修改学校网站</span></footer>`;
  }

  function syncAllDay() {
    const form = calendar.dialog?.querySelector('form');
    if (!form) return;
    const allDay = form.elements.allDay.checked;
    const times = form.querySelector('.cal-time-fields');
    times.classList.toggle('hidden', allDay);
    for (const name of ['start', 'end']) {
      form.elements[name].disabled = calendar.busy || allDay;
      form.elements[name].required = !allDay;
    }
  }

  function openDay(key, eventId = '') {
    if (calendar.busy || !/^\d{4}-\d{2}-\d{2}$/.test(key) || !supported(fromKey(key))) return;
    calendar.selected = key;
    const existing = calendar.events.find((event) => event.id === eventId);
    const value = existing || { title: '', date: key, start: '', end: '', notes: '', color: 'green', reminderMinutes: null };
    const items = eventsFor(key);
    const dialog = calendar.dialog;
    dialog.innerHTML = `<div class="cal-dialog-head"><div><span class="section-kicker">${fromKey(key).getFullYear()} 年</span><h3 id="calendarDialogTitle">${escape(dayLabel(key))}</h3></div><button type="button" data-cal-close aria-label="关闭日程">×</button></div><div class="cal-dialog-layout"><section class="cal-day-agenda"><div class="cal-agenda-heading"><strong>当天日程</strong><span>${items.length} 项</span></div>${items.length ? items.map((event) => `<button type="button" class="cal-agenda-event cal-color-${safeColor(event.color)}${existing?.id === event.id ? ' active' : ''}" data-cal-edit="${escape(event.id)}"><span>${escape(timeLabel(event))}</span><strong>${escape(event.title)}</strong>${event.notes ? `<small>${escape(event.notes)}</small>` : ''}</button>`).join('') : '<div class="cal-agenda-empty">今天还没有安排。<br>给想做的事留一个位置吧。</div>'}<button type="button" class="cal-agenda-new" data-cal-day="${key}">＋ 新建一项</button></section><form class="cal-event-form" data-cal-form><h4>${existing ? '编辑日程' : '添加日程'}</h4><input type="hidden" name="id" value="${escape(existing?.id || '')}"><label><span>标题</span><input name="title" required maxlength="120" placeholder="例如：English Paper 1 练习" value="${escape(value.title)}"></label><label><span>日期</span><input name="date" type="date" required min="1900-01-01" max="2199-12-31" value="${escape(value.date)}"></label><label class="cal-all-day"><input name="allDay" type="checkbox"${!value.start ? ' checked' : ''}><span>全天日程</span></label><div class="cal-time-fields"><label><span>开始</span><input name="start" type="time" value="${escape(value.start || '09:00')}"></label><label><span>结束</span><input name="end" type="time" value="${escape(value.end || '10:00')}"></label></div><label><span>提前提醒</span><select name="reminderMinutes">${[[null, '不提醒'], [0, '准时提醒'], [5, '提前 5 分钟'], [10, '提前 10 分钟'], [15, '提前 15 分钟'], [30, '提前 30 分钟'], [60, '提前 60 分钟']].map(([minutes, label]) => `<option value="${minutes ?? ''}"${value.reminderMinutes === minutes ? ' selected' : ''}>${label}</option>`).join('')}</select></label><label><span>备注（可选）</span><textarea name="notes" rows="3" maxlength="4000" placeholder="地点、要带的东西，或一句提醒自己的话。">${escape(value.notes)}</textarea></label><label><span>颜色</span><div class="color-swatches">${Object.entries(colors).map(([color, label]) => `<label class="color-swatch" title="${label}"><input type="radio" name="color" value="${color}"${color === value.color ? ' checked' : ''}><span class="swatch swatch-${color}"></span></label>`).join('')}</div></label><p class="cal-form-error" role="alert"></p><div class="cal-form-actions">${existing ? '<button type="button" class="cal-delete" data-cal-delete>删除日程</button>' : '<span></span>'}<button type="submit" class="primary-button">${existing ? '保存更改' : '添加日程'}</button></div></form></div>`;
    syncAllDay();
    render();
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('[name=title]')?.focus();
  }

  function setBusy(value) {
    calendar.busy = value;
    calendar.dialog.querySelectorAll('button, input, textarea, select').forEach((element) => { element.disabled = value; });
    syncAllDay();
  }

  async function save(event) {
    event.preventDefault();
    if (calendar.busy) return;
    const form = event.target;
    if (!form.reportValidity()) return;
    const fields = form.elements;
    const value = { title: fields.title.value, date: fields.date.value, start: fields.allDay.checked ? '' : fields.start.value, end: fields.allDay.checked ? '' : fields.end.value, notes: fields.notes.value, color: fields.color.value, reminderMinutes: fields.reminderMinutes.value === '' ? null : Number(fields.reminderMinutes.value) };
    if (fields.id.value) value.id = fields.id.value;
    setBusy(true);
    try {
      const events = await window.ph.calendar.save(value);
      if (!Array.isArray(events)) throw new Error('日程未能保存，请重试');
      calendar.events = events;
      calendar.request += 1;
      calendar.selected = value.date;
      calendar.anchor = fromKey(value.date);
      calendar.notice = '日程已保存';
      calendar.error = '';
      calendar.dialog.close();
      render();
    } catch (error) {
      form.querySelector('.cal-form-error').textContent = error?.message || '日程未能保存，请重试';
    } finally { setBusy(false); }
  }

  async function remove() {
    if (calendar.busy) return;
    const form = calendar.dialog.querySelector('form');
    const id = form.elements.id.value;
    if (!id || !window.confirm('删除这条日程？此操作不会影响学校网站。')) return;
    setBusy(true);
    try {
      const events = await window.ph.calendar.remove(id);
      if (!Array.isArray(events)) throw new Error('日程未能删除，请重试');
      calendar.events = events;
      calendar.request += 1;
      calendar.notice = '日程已删除';
      calendar.error = '';
      calendar.dialog.close();
      render();
    } catch (error) {
      form.querySelector('.cal-form-error').textContent = error?.message || '日程未能删除，请重试';
    } finally { setBusy(false); }
  }

  function clicked(event) {
    if (calendar.busy) return;
    const target = event.target.closest('button, [data-cal-day]');
    if (!target || target.disabled) return;
    if (target.hasAttribute('data-cal-edit')) {
      const entry = calendar.events.find((item) => item.id === target.dataset.calEdit);
      if (entry) openDay(entry.date, entry.id);
    } else if (target.hasAttribute('data-cal-day')) openDay(target.dataset.calDay);
    else if (target.hasAttribute('data-cal-new')) openDay(calendar.selected);
    else if (target.hasAttribute('data-cal-close')) calendar.dialog.close();
    else if (target.hasAttribute('data-cal-delete')) remove();
    else if (target.hasAttribute('data-cal-view')) { calendar.view = target.dataset.calView; render(); }
    else if (target.hasAttribute('data-cal-step')) { const next = nextAnchor(Number(target.dataset.calStep)); if (supported(next)) calendar.anchor = next; render(); }
    else if (target.hasAttribute('data-cal-today')) { calendar.anchor = noon(new Date()); calendar.selected = dateKey(new Date()); render(); }
    else if (target.hasAttribute('data-cal-month')) { calendar.anchor = new Date(calendar.anchor.getFullYear(), Number(target.dataset.calMonth), 1, 12); calendar.view = 'month'; render(); }
  }

  async function refresh() {
    if (!calendar.host) return mount();
    const request = ++calendar.request;
    try {
      if (!window.ph?.calendar?.get) throw new Error('日历暂时不可用，请重新打开 PH Launcher');
      const events = await window.ph.calendar.get();
      if (request !== calendar.request) return;
      if (!Array.isArray(events)) throw new Error('未能读取日程，请重试');
      calendar.events = events;
      calendar.error = '';
    } catch (error) {
      if (request !== calendar.request) return;
      calendar.error = error?.message || '未能读取日程，请重试';
    }
    render();
  }

  async function mount() {
    const host = document.getElementById('calendarPage');
    if (!host) return;
    if (calendar.host !== host) {
      calendar.host = host;
      host.addEventListener('click', clicked);
    }
    if (!calendar.dialog) {
      const dialog = document.createElement('dialog');
      dialog.id = 'calendarEventDialog';
      dialog.className = 'cal-dialog';
      dialog.setAttribute('aria-labelledby', 'calendarDialogTitle');
      dialog.addEventListener('click', clicked);
      dialog.addEventListener('submit', save);
      dialog.addEventListener('change', (event) => { if (event.target.name === 'allDay') syncAllDay(); });
      dialog.addEventListener('cancel', (event) => { if (calendar.busy) event.preventDefault(); });
      document.body.append(dialog);
      calendar.dialog = dialog;
    }
    render();
    return refresh();
  }

  window.calendarUI = Object.freeze({ mount, refresh });
})();

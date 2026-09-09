(() => {
  'use strict';
  const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
  const colors = { green: '松绿', wine: '莓红', gold: '暖金', blue: '湖蓝', purple: '紫藤', slate: '石灰' };
  const englishColors = { green: 'Pine green', wine: 'Berry red', gold: 'Warm gold', blue: 'Lake blue', purple: 'Wisteria', slate: 'Slate' };
  const calendar = { host: null, dialog: null, events: [], dialogAttachments: [], view: 'week', anchor: noon(new Date()), selected: dateKey(new Date()), request: 0, busy: false, notice: '', error: '', languageListener: false };
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const safeColor = (value) => Object.hasOwn(colors, value) ? value : 'green';
  const english = () => window.i18n?.locale() === 'en';
  const weekdayLabel = (index, mini = false) => english() ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][index] : mini ? weekdays[index] : `周${weekdays[index]}`;
  const dayAria = (key, count, action = false) => english() ? `${dayLabel(key)}, ${count} events${action ? ', view or add an event' : ''}` : `${dayLabel(key)}，${count} 项日程${action ? '，点击查看或添加' : ''}`;
  const text = (zh, en) => english() ? en : zh;

  function noon(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12); }
  function dateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
  function fromKey(key) { const [year, month, day] = key.split('-').map(Number); return new Date(year, month - 1, day, 12); }
  function supported(date) { return date.getFullYear() >= 1900 && date.getFullYear() <= 2199; }
  function shifted(date, days) { const result = noon(date); result.setDate(result.getDate() + days); return result; }
  function monday(date) { return shifted(date, -((date.getDay() + 6) % 7)); }
  function dayLabel(key) { return fromKey(key).toLocaleDateString(english() ? 'en' : 'zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }); }
  function eventsFor(key) { const date = fromKey(key); const weekday = date.getDay() || 7; return calendar.events.filter((event) => event.repeatWeekdays?.length ? key >= event.date && event.repeatWeekdays.includes(weekday) : event.date === key); }
  function timeLabel(event) { return event.start ? `${event.start}–${event.end}` : text('全天', 'All day'); }

  function nextAnchor(direction) {
    if (calendar.view === 'week') return shifted(calendar.anchor, direction * 7);
    if (calendar.view === 'month') return new Date(calendar.anchor.getFullYear(), calendar.anchor.getMonth() + direction, 1, 12);
    return new Date(calendar.anchor.getFullYear() + direction, calendar.anchor.getMonth(), 1, 12);
  }

  function heading() {
    if (english()) {
      if (calendar.view === 'year') return String(calendar.anchor.getFullYear());
      if (calendar.view === 'month') return calendar.anchor.toLocaleDateString('en', { year: 'numeric', month: 'long' });
      const start = monday(calendar.anchor), end = shifted(start, 6);
      const sameYear = start.getFullYear() === end.getFullYear();
      return `${start.toLocaleDateString('en', { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' })} — ${end.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    }
    if (calendar.view === 'year') return `${calendar.anchor.getFullYear()} 年`;
    if (calendar.view === 'month') return `${calendar.anchor.getFullYear()} 年 ${calendar.anchor.getMonth() + 1} 月`;
    const start = monday(calendar.anchor);
    const end = shifted(start, 6);
    return `${start.getFullYear()} 年 ${start.getMonth() + 1} 月 ${start.getDate()} 日 — ${end.getFullYear() !== start.getFullYear() ? `${end.getFullYear()} 年 ` : ''}${end.getMonth() + 1} 月 ${end.getDate()} 日`;
  }

  function eventButton(event, compact = false, occurrenceDate = event.date) {
    return `<button type="button" class="cal-event cal-color-${safeColor(event.color)}${compact ? ' compact' : ''}" data-cal-edit="${escape(event.id)}" data-cal-date="${occurrenceDate}" title="${escape(`${timeLabel(event)} ${event.title}`)}"><span>${escape(event.start || text('全天', 'All day'))}</span><strong>${escape(event.title)}</strong></button>`;
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
      if (mini) return `<button type="button" class="cal-mini-day${key === today ? ' today' : ''}${items.length ? ' has-events' : ''}" data-cal-day="${key}" aria-label="${escape(dayAria(key, items.length))}"${!supported(day) ? ' disabled' : ''}><span>${day.getDate()}</span>${items.length ? '<i aria-hidden="true"></i>' : ''}</button>`;
      return `<div class="cal-month-cell${otherMonth ? ' other-month' : ''}${key === today ? ' today' : ''}${key === calendar.selected ? ' selected' : ''}"${supported(day) ? ` data-cal-day="${key}"` : ''}><button type="button" class="cal-day-number" data-cal-day="${key}" aria-label="${escape(dayAria(key, items.length, true))}"${key === today ? ' aria-current="date"' : ''}${!supported(day) ? ' disabled' : ''}>${day.getDate()}${key === today ? `<small>${text('今天', 'Today')}</small>` : ''}</button><div class="cal-cell-events">${items.slice(0, 3).map((event) => eventButton(event, true, key)).join('')}</div>${items.length > 3 ? `<button class="cal-more" data-cal-day="${key}" aria-label="${escape(english() ? `View ${items.length - 3} more events on ${dayLabel(key)}` : `查看${dayLabel(key)}另外 ${items.length - 3} 项日程`)}">${text(`还有 ${items.length - 3} 项`, `${items.length - 3} more`)}</button>` : ''}</div>`;
    }).join('');
    return `<div class="${mini ? 'cal-mini-grid' : 'cal-month-grid'}">${weekdays.map((label, index) => `<span class="cal-weekday">${weekdayLabel(index, mini)}</span>`).join('')}${cells}</div>`;
  }

  function weekGrid() {
    const start = monday(calendar.anchor);
    const today = dateKey(new Date());
    return `<div class="cal-week-grid">${Array.from({ length: 7 }, (_, index) => {
      const day = shifted(start, index);
      const key = dateKey(day);
      const items = eventsFor(key);
      return `<section class="cal-week-day${key === today ? ' today' : ''}"><button type="button" class="cal-week-heading" data-cal-day="${key}" aria-label="${escape(dayAria(key, items.length, true))}"${key === today ? ' aria-current="date"' : ''}${!supported(day) ? ' disabled' : ''}><span>${weekdayLabel(index)}</span><strong>${day.getDate()}</strong><small>${english() ? day.toLocaleDateString('en', { month: 'short' }) : `${day.getMonth() + 1} 月`}${key === today ? text(' · 今天', ' · Today') : ''}</small></button><div class="cal-week-events">${items.map((event) => eventButton(event, false, key)).join('')}${!items.length ? `<span class="cal-free">${text('留一点空白', 'Nothing scheduled')}</span>` : ''}</div><button type="button" class="cal-add-in-day" data-cal-day="${key}"${!supported(day) ? ' disabled' : ''} aria-label="${escape(english() ? `Add an event on ${dayLabel(key)}` : `为${dayLabel(key)}添加日程`)}">${text('＋ 添加', '＋ Add')}</button></section>`;
    }).join('')}</div>`;
  }

  function yearGrid() {
    return `<div class="cal-year-grid">${Array.from({ length: 12 }, (_, month) => { const label = english() ? new Date(2000, month, 1).toLocaleDateString('en', { month: 'long' }) : `${month + 1} 月`; return `<section class="cal-mini-month"><button class="cal-month-title" data-cal-month="${month}" aria-label="${escape(english() ? `Open ${label}` : `打开${label}`)}">${label} <span>↗</span></button>${monthGrid(month, true)}</section>`; }).join('')}</div>`;
  }

  function render() {
    if (!calendar.host) return;
    const period = calendar.view === 'week' ? text('周', 'week') : calendar.view === 'month' ? text('月', 'month') : text('年', 'year');
    calendar.host.innerHTML = `<header class="cal-page-head"><div><span class="section-kicker">MY CALENDAR</span><h2>${text('把重要的日子，留在眼前。', 'Keep important dates in view.')}</h2><p>${text('考试、社团、约定，还有属于自己的时间。', 'Exams, clubs, commitments, and time for yourself.')}</p></div><button type="button" class="primary-button" data-cal-new>${text('＋ 添加日程', '＋ Add event')}</button></header><div class="cal-toolbar"><div class="cal-date-controls"><button class="cal-arrow" data-cal-step="-1" aria-label="${text(`上一${period}`, `Previous ${period}`)}"${!supported(nextAnchor(-1)) ? ' disabled' : ''}>‹</button><button class="cal-today" data-cal-today>${text('今天', 'Today')}</button><button class="cal-arrow" data-cal-step="1" aria-label="${text(`下一${period}`, `Next ${period}`)}"${!supported(nextAnchor(1)) ? ' disabled' : ''}>›</button><h3>${heading()}</h3></div><div class="cal-view-switch" role="group" aria-label="${text('日历视图', 'Calendar view')}">${[['week', text('周', 'Week')], ['month', text('月', 'Month')], ['year', text('年', 'Year')]].map(([value, label]) => `<button type="button" data-cal-view="${value}" class="${calendar.view === value ? 'active' : ''}" aria-pressed="${calendar.view === value}">${label}</button>`).join('')}</div></div><p class="cal-status${calendar.error ? ' error' : ''}" role="status">${escape(calendar.error || calendar.notice)}</p><div class="cal-board">${calendar.view === 'week' ? weekGrid() : calendar.view === 'year' ? yearGrid() : monthGrid(calendar.anchor.getMonth())}</div><footer class="cal-foot"><span>${text('点选日期即可查看、添加或编辑日程。', 'Select a date to view, add, or edit events.')}</span><span>${text('保存在这台电脑 · 不会修改学校网站', 'Saved on this computer · does not change school websites')}</span></footer>`;
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

  function dialogDraft() {
    const form = calendar.dialog?.querySelector('form');
    if (!form) return null;
    const fields = form.elements;
    return { id: fields.id.value, title: fields.title.value, date: fields.date.value, allDay: fields.allDay.checked, start: fields.start.value, end: fields.end.value, repeatWeekdays: [...form.querySelectorAll('[name="repeatWeekdays"]:checked')].map(input => Number(input.value)), reminderMinutes: fields.reminderMinutes.value, notes: fields.notes.value, color: fields.color.value, attachments: calendar.dialogAttachments.map(item => ({ ...item })) };
  }

  function attachmentRows() {
    const host = calendar.dialog?.querySelector('[data-cal-attachments]');
    if (!host) return;
    host.innerHTML = calendar.dialogAttachments.length ? calendar.dialogAttachments.map((item, index) => `<div class="cal-attachment"><button type="button" data-cal-attachment-open="${index}" title="${escape(item.path)}" data-i18n-ignore>${escape(item.name)}</button><button type="button" data-cal-attachment-remove="${index}" aria-label="${escape(text(`移除 ${item.name}`, `Remove ${item.name}`))}">×</button></div>`).join('') : `<span>${text('尚未关联文件', 'No related files')}</span>`;
  }

  function openDay(key, eventId = '', draft = null, focusName = 'title') {
    if (calendar.busy || !/^\d{4}-\d{2}-\d{2}$/.test(key) || !supported(fromKey(key))) return;
    calendar.selected = key;
    const existing = calendar.events.find((event) => event.id === eventId);
    const defaultStart = (() => { const now = new Date(); const hour = now.getHours() + (now.getMinutes() >= 30 ? 1 : 0); return `${String((hour + 1) % 24).padStart(2, '0')}:00`; })();
    const defaultEnd = (() => { const hour = (Number(defaultStart.slice(0, 2)) + 1) % 24; return `${String(hour).padStart(2, '0')}:00`; })();
    const value = draft || existing || { title: '', date: key, start: defaultStart, end: defaultEnd, notes: '', color: 'green', reminderMinutes: null, repeatWeekdays: [] };
    const editing = Boolean(eventId);
    // New events default to a timed slot; all-day stays an explicit choice.
    const allDay = draft ? draft.allDay : Boolean(existing) && !value.start;
    const reminder = draft ? String(draft.reminderMinutes) : String(value.reminderMinutes ?? '');
    const items = eventsFor(key);
    const dialog = calendar.dialog;
    const reminders = [['', text('不提醒', 'No reminder')], ['0', text('准时提醒', 'At start time')], ['5', text('提前 5 分钟', '5 minutes before')], ['10', text('提前 10 分钟', '10 minutes before')], ['15', text('提前 15 分钟', '15 minutes before')], ['30', text('提前 30 分钟', '30 minutes before')], ['60', text('提前 60 分钟', '60 minutes before')]];
    const repeatDays = Array.isArray(value.repeatWeekdays) ? value.repeatWeekdays : [];
    calendar.dialogAttachments = Array.isArray(value.attachments) ? value.attachments.map(item => ({ path: item.path, name: item.name })) : [];
    const colorLabels = english() ? englishColors : colors;
    dialog.dataset.calKey = key;
    dialog.dataset.calEventId = eventId;
    dialog.innerHTML = `<div class="cal-dialog-head"><div><span class="section-kicker">${english() ? fromKey(key).getFullYear() : `${fromKey(key).getFullYear()} 年`}</span><h3 id="calendarDialogTitle">${escape(dayLabel(key))}</h3></div><button type="button" data-cal-close aria-label="${text('关闭日程', 'Close event dialog')}">×</button></div><div class="cal-dialog-layout"><section class="cal-day-agenda"><div class="cal-agenda-heading"><strong>${text('当天日程', 'Schedule for this day')}</strong><span>${text(`${items.length} 项`, `${items.length} events`)}</span></div>${items.length ? items.map((event) => `<button type="button" class="cal-agenda-event cal-color-${safeColor(event.color)}${eventId === event.id ? ' active' : ''}" data-cal-edit="${escape(event.id)}" data-cal-date="${key}"><span>${escape(timeLabel(event))}</span><strong>${escape(event.title)}</strong>${event.notes ? `<small>${escape(event.notes)}</small>` : ''}</button>`).join('') : `<div class="cal-agenda-empty">${text('今天还没有安排。<br>给想做的事留一个位置吧。', 'Nothing is scheduled today.<br>Make room for something you want to do.')}</div>`}<button type="button" class="cal-agenda-new" data-cal-day="${key}">${text('＋ 新建一项', '＋ Create an item')}</button></section><form class="cal-event-form" data-cal-form><h4>${editing ? text('编辑日程', 'Edit event') : text('添加日程', 'Add event')}</h4><input type="hidden" name="id" value="${escape(draft?.id ?? existing?.id ?? '')}"><label><span>${text('标题', 'Title')}</span><input name="title" required maxlength="120" placeholder="${text('例如：English Paper 1 练习', 'For example: English Paper 1 practice')}" value="${escape(value.title)}"></label><label><span>${text('日期', 'Date')}</span><input name="date" type="date" required min="1900-01-01" max="2199-12-31" value="${escape(value.date)}"></label><label class="cal-all-day"><input name="allDay" type="checkbox"${allDay ? ' checked' : ''}><span>${text('全天日程', 'All-day event')}</span></label><div class="cal-time-fields"><label><span>${text('开始', 'Start')}</span><input name="start" type="time" value="${escape(value.start || '09:00')}"></label><label><span>${text('结束', 'End')}</span><input name="end" type="time" value="${escape(value.end || '10:00')}"></label></div><fieldset class="cal-repeat-week"><legend>${text('每周重复（可选）', 'Repeat weekly (optional)')}</legend>${weekdays.map((day, index) => `<label><input type="checkbox" name="repeatWeekdays" value="${index + 1}"${repeatDays.includes(index + 1) ? ' checked' : ''}><span>${weekdayLabel(index, true)}</span></label>`).join('')}</fieldset><label><span>${text('提前提醒', 'Reminder')}</span><select name="reminderMinutes">${reminders.map(([minutes, label]) => `<option value="${minutes}"${reminder === minutes ? ' selected' : ''}>${label}</option>`).join('')}</select></label><section class="cal-related-files"><div><strong>${text('相关文件', 'Related files')}</strong><button type="button" data-cal-attachment-select>${text('＋ 选择文件', '＋ Choose files')}</button></div><div data-cal-attachments></div><small>${text('仅保存文件位置，不读取内容或自动上传。', 'Only file locations are saved; contents are not read or uploaded.')}</small></section><label><span>${text('备注（可选）', 'Notes (optional)')}</span><textarea name="notes" rows="3" maxlength="4000" placeholder="${text('地点、要带的东西，或一句提醒自己的话。', 'Location, things to bring, or a note to yourself.')}">${escape(value.notes)}</textarea></label><label><span>${text('颜色', 'Color')}</span><div class="color-swatches">${Object.entries(colorLabels).map(([color, label]) => `<label class="color-swatch" title="${label}"><input type="radio" name="color" value="${color}"${color === value.color ? ' checked' : ''}><span class="swatch swatch-${color}"></span></label>`).join('')}</div></label></label><p class="cal-form-error" role="alert"></p><div class="cal-form-actions">${editing ? `<button type="button" class="cal-delete" data-cal-delete>${text('删除日程', 'Delete event')}</button>` : '<span></span>'}<button type="submit" class="primary-button">${editing ? text('保存更改', 'Save changes') : text('添加日程', 'Add event')}</button></div></form></div>`;
    attachmentRows();
    syncAllDay();
    render();
    if (!dialog.open) dialog.showModal();
    dialog.querySelector(`[name="${focusName}"]`)?.focus();
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
    const value = { title: fields.title.value, date: fields.date.value, start: fields.allDay.checked ? '' : fields.start.value, end: fields.allDay.checked ? '' : fields.end.value, repeatWeekdays: [...form.querySelectorAll('[name="repeatWeekdays"]:checked')].map(input => Number(input.value)), attachments: calendar.dialogAttachments.map(item => ({ ...item })), notes: fields.notes.value, color: fields.color.value, reminderMinutes: fields.reminderMinutes.value === '' ? null : Number(fields.reminderMinutes.value) };
    if (fields.id.value) value.id = fields.id.value;
    setBusy(true);
    try {
      const events = await window.ph.calendar.save(value);
      if (!Array.isArray(events)) throw new Error(text('日程未能保存，请重试', 'The event could not be saved. Try again.'));
      calendar.events = events;
      calendar.request += 1;
      calendar.selected = value.date;
      calendar.anchor = fromKey(value.date);
      calendar.notice = text('日程已保存', 'Event saved');
      calendar.error = '';
      calendar.dialog.close();
      render();
    } catch (error) {
      form.querySelector('.cal-form-error').textContent = error?.message || text('日程未能保存，请重试', 'The event could not be saved. Try again.');
    } finally { setBusy(false); }
  }

  async function remove() {
    if (calendar.busy) return;
    const form = calendar.dialog.querySelector('form');
    const id = form.elements.id.value;
    if (!id || !await window.confirmAction('删除这条日程？此操作不会影响学校网站。')) return;
    setBusy(true);
    try {
      const events = await window.ph.calendar.remove(id);
      if (!Array.isArray(events)) throw new Error(text('日程未能删除，请重试', 'The event could not be deleted. Try again.'));
      calendar.events = events;
      calendar.request += 1;
      calendar.notice = text('日程已删除', 'Event deleted');
      calendar.error = '';
      calendar.dialog.close();
      render();
    } catch (error) {
      form.querySelector('.cal-form-error').textContent = error?.message || text('日程未能删除，请重试', 'The event could not be deleted. Try again.');
    } finally { setBusy(false); }
  }

  async function chooseAttachments() {
    if (calendar.busy || !window.ph?.calendar?.chooseFiles) return;
    let selected;
    try { selected = await window.ph.calendar.chooseFiles(); }
    catch (error) { calendar.dialog.querySelector('.cal-form-error').textContent = error?.message || text('无法选择文件', 'Files could not be selected'); return; }
    if (!Array.isArray(selected)) return;
    const known = new Set(calendar.dialogAttachments.map(item => item.path));
    for (const item of selected) if (typeof item?.path === 'string' && typeof item?.name === 'string' && !known.has(item.path) && calendar.dialogAttachments.length < 20) {
      calendar.dialogAttachments.push({ path: item.path, name: item.name }); known.add(item.path);
    }
    attachmentRows();
  }

  async function openAttachment(index) {
    const item = calendar.dialogAttachments[index];
    if (!item || !window.ph?.calendar?.openFile) return;
    try { await window.ph.calendar.openFile(item.path); }
    catch (error) { calendar.dialog.querySelector('.cal-form-error').textContent = error?.message || text('无法打开这个文件', 'This file could not be opened'); }
  }

  function clicked(event) {
    if (calendar.busy) return;
    const target = event.target.closest('button, [data-cal-day]');
    if (!target || target.disabled) return;
    if (target.hasAttribute('data-cal-attachment-select')) chooseAttachments();
    else if (target.hasAttribute('data-cal-attachment-open')) openAttachment(Number(target.dataset.calAttachmentOpen));
    else if (target.hasAttribute('data-cal-attachment-remove')) { calendar.dialogAttachments.splice(Number(target.dataset.calAttachmentRemove), 1); attachmentRows(); }
    else if (target.hasAttribute('data-cal-edit')) {
      const entry = calendar.events.find((item) => item.id === target.dataset.calEdit);
      if (entry) openDay(target.dataset.calDate || entry.date, entry.id);
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
      if (!window.ph?.calendar?.get) throw new Error(text('日历暂时不可用，请重新打开 PH Launcher', 'Calendar is unavailable. Reopen PH Launcher.'));
      const events = await window.ph.calendar.get();
      if (request !== calendar.request) return;
      if (!Array.isArray(events)) throw new Error(text('未能读取日程，请重试', 'Events could not be loaded. Try again.'));
      calendar.events = events;
      calendar.error = '';
    } catch (error) {
      if (request !== calendar.request) return;
      calendar.error = error?.message || text('未能读取日程，请重试', 'Events could not be loaded. Try again.');
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
    if (!calendar.languageListener) {
      window.addEventListener('ph:language-changed', () => {
        if (!calendar.host) return;
        if (!calendar.dialog?.open) { render(); return; }
        const draft = dialogDraft();
        const focusName = calendar.dialog.contains(document.activeElement) ? document.activeElement?.name : '';
        openDay(calendar.dialog.dataset.calKey || calendar.selected, calendar.dialog.dataset.calEventId || '', draft, focusName || 'title');
      });
      calendar.languageListener = true;
    }
    render();
    return refresh();
  }

  window.calendarUI = Object.freeze({ mount, refresh });
})();

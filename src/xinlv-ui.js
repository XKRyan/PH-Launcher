(() => {
  'use strict';

  // Xinlv (心履) native module. The launcher talks to the documented REST API
  // through the main-process bridge (window.ph.xinlv) and renders everything
  // itself in PH Launcher's own style — no embedded webpage, no remote UI.
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const safeError = (error, fallback) => String(error?.message || error || fallback)
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^(?:Error|XinlvServiceError|XinlvError):\s*/i, '')
    .trim() || fallback;

  const MOODS = [
    { key: 'happy', label: '开心' },
    { key: 'calm', label: '平静' },
    { key: 'excited', label: '兴奋' },
    { key: 'grateful', label: '感恩' },
    { key: 'tired', label: '疲惫' },
    { key: 'anxious', label: '焦虑' },
    { key: 'sad', label: '难过' },
    { key: 'angry', label: '愤怒' },
    { key: 'lonely', label: '孤独' },
    { key: 'numb', label: '麻木' },
  ];
  const MOOD_LABEL = Object.fromEntries(MOODS.map((mood) => [mood.key, mood.label]));
  const MOOD_KEYS = new Set(MOODS.map((mood) => mood.key));
  // The API only accepts intensity_level 1-4 (1=略微 … 4=十分); percent is a
  // 0-100 display value, so the four steps map onto a readable scale.
  const INTENSITY = [
    { level: 1, label: '略微', percent: 25 },
    { level: 2, label: '有点', percent: 50 },
    { level: 3, label: '相当', percent: 75 },
    { level: 4, label: '十分', percent: 100 },
  ];
  const DISCLAIMER_URL = 'https://xin-lv.com/disclaimer/';
  const TABS = [
    { key: 'record', label: '记录', hint: '记录与回顾心情' },
    { key: 'recommend', label: '推荐', hint: '按心情获取建议' },
    { key: 'chat', label: '对话', hint: '与心履聊一聊' },
    { key: 'profile', label: '我的', hint: '账号与坚持记录' },
  ];

  const dateKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  // Named form access is not guaranteed by every DOM implementation; read the
  // control explicitly so the module behaves the same in tests and in Chromium.
  const field = (form, name) => String(form?.elements?.namedItem?.(name)?.value ?? form?.querySelector?.(`[name="${name}"]`)?.value ?? '');
  const isSafeUrl = (value) => /^https?:\/\//i.test(String(value || ''));
  const moodLabel = (key) => MOOD_LABEL[key] || '未选择';

  const state = {
    root: null,
    mounted: false,
    tab: 'record',
    status: null,
    entries: [],
    loading: false,
    syncing: false,
    busy: false,
    error: '',
    notice: '',
    lastSyncAt: 0,
    form: { date: dateKey(), mood: '', intensityLevel: 2, note: '' },
    editingUuid: '',
    recommend: { mood: '', loading: false, data: null, error: '', local: false },
    chat: { messages: [], loading: false, sending: false, error: '', draft: '', crisis: null, lastProactive: '', timer: 0 },
    profile: { loading: false, data: null, error: '' },
    login: { username: '', password: '', agree: false, busy: false, error: '', mode: 'login' },
    catalog: null,
    catalogAt: 0,
    syncTimer: 0,
  };

  const api = () => window.ph?.xinlv;
  const configured = () => Boolean(state.status?.configured);

  // ---------------------------------------------------------------- helpers

  function statusLine() {
    if (state.error) return `<p class="xinlv-status error" role="alert">${esc(state.error)}</p>`;
    if (state.notice) return `<p class="xinlv-status" role="status">${esc(state.notice)}</p>`;
    return '';
  }

  function moodChip(key, extraClass = '') {
    const label = moodLabel(key);
    return `<span class="xinlv-mood-chip ${MOOD_KEYS.has(key) ? `xinlv-mood-${key}` : 'xinlv-mood-unknown'} ${extraClass}"><i></i>${esc(label)}</span>`;
  }

  function intensityLabel(level) {
    const match = INTENSITY.find((item) => item.level === Number(level));
    return match ? match.label : '中等';
  }

  function formatDate(value) {
    const text = String(value || '');
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) return text;
    return `${Number(match[2])} 月 ${Number(match[3])} 日`;
  }

  function formatTime(value) {
    const date = new Date(value || '');
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function weekdayLabel(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return '';
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];
  }

  // ------------------------------------------------------------ login panel

  function renderLogin() {
    const login = state.login;
    const isRegister = login.mode === 'register';
    return `<section class="xinlv-login">
      <div class="xinlv-login-copy">
        <span class="section-kicker">XINLV ACCOUNT</span>
        <h3>${isRegister ? '注册心履账号' : '登录心履'}</h3>
        <p>心履账号与学校账号相互独立。账号、密码与登录令牌只保存在本机（当前未加密），仅用于连接 <code translate="no">xin.lv.com</code> 的心履服务；PH Launcher 不会把心情记录发给 AI 或学校。</p>
      </div>
      <form class="xinlv-login-form" data-xinlv-login-form>
        <label><span>账号</span><input name="username" maxlength="200" autocomplete="username" value="${esc(login.username)}" placeholder="心履账号" required></label>
        <label><span>密码</span><input name="password" type="password" maxlength="512" autocomplete="${isRegister ? 'new-password' : 'current-password'}" placeholder="登录后密码不会再次显示" required></label>
        ${isRegister ? `<label class="xinlv-agree"><input type="checkbox" name="agree"${login.agree ? ' checked' : ''}><span>我已阅读并同意心履的免责声明，了解心履不能替代专业医疗与心理治疗。</span></label>
        <button type="button" class="secondary-button xinlv-disclaimer" data-xinlv-open-url="${DISCLAIMER_URL}">在浏览器打开免责声明 ↗</button>` : ''}
        ${login.error ? `<p class="xinlv-status error" role="alert">${esc(login.error)}</p>` : ''}
        <div class="xinlv-login-actions">
          <button type="submit" class="primary-button"${login.busy ? ' disabled' : ''}>${login.busy ? '正在连接…' : isRegister ? '注册并登录' : '登录心履'}</button>
          <button type="button" class="secondary-button" data-xinlv-login-mode="${isRegister ? 'login' : 'register'}">${isRegister ? '已有账号，去登录' : '没有账号？注册'}</button>
        </div>
        <p class="xinlv-login-note">登录失败不会自动重试，避免账号被锁定；请确认账号密码后手动重试。</p>
      </form>
    </section>`;
  }

  // ----------------------------------------------------------- record panel

  function renderRecord() {
    const form = state.form;
    const editing = state.editingUuid;
    const grouped = new Map();
    for (const entry of state.entries) {
      if (!grouped.has(entry.date)) grouped.set(entry.date, []);
      grouped.get(entry.date).push(entry);
    }
    const dates = [...grouped.keys()].sort((a, b) => b.localeCompare(a)).slice(0, 60);
    const weekCount = state.entries.filter((entry) => {
      const limit = new Date();
      limit.setDate(limit.getDate() - 6);
      return entry.date >= dateKey(limit);
    }).length;
    const counts = MOODS.map((mood) => ({ ...mood, count: state.entries.filter((entry) => entry.mood === mood.key).length }));
    const topMood = counts.slice().sort((a, b) => b.count - a.count)[0];

    return `<div class="xinlv-record">
      <section class="xinlv-card xinlv-compose">
        <header class="xinlv-card-head">
          <div><span class="section-kicker">${editing ? 'EDIT ENTRY' : 'NEW ENTRY'}</span><h3>${editing ? '修改这条记录' : '今天的心情'}</h3></div>
          ${editing ? '<button type="button" class="secondary-button" data-xinlv-cancel-edit>取消修改</button>' : ''}
        </header>
        <form data-xinlv-entry-form>
          <div class="xinlv-field-row">
            <label class="xinlv-date"><span>日期</span><input type="date" name="date" value="${esc(form.date)}" max="2100-12-31" required></label>
            <div class="xinlv-intensity">
              <span>强度</span>
              <div class="xinlv-intensity-options">
                ${INTENSITY.map((item) => `<button type="button" class="xinlv-intensity-option${Number(form.intensityLevel) === item.level ? ' active' : ''}" data-xinlv-intensity="${item.level}" aria-pressed="${Number(form.intensityLevel) === item.level}"><i style="--fill:${item.percent}%"></i>${esc(item.label)}</button>`).join('')}
              </div>
            </div>
          </div>
          <div class="xinlv-mood-grid" role="radiogroup" aria-label="心情">
            ${MOODS.map((mood) => `<button type="button" role="radio" aria-checked="${form.mood === mood.key}" class="xinlv-mood-option xinlv-mood-${mood.key}${form.mood === mood.key ? ' active' : ''}" data-xinlv-mood="${mood.key}"><i></i><span>${esc(mood.label)}</span></button>`).join('')}
          </div>
          <label class="xinlv-note"><span>想说的话（可选）</span><textarea name="note" maxlength="2000" rows="3" placeholder="今天发生了什么？">${esc(form.note)}</textarea></label>
          <div class="xinlv-compose-actions">
            <button type="submit" class="primary-button"${state.busy || !form.mood ? ' disabled' : ''}>${state.busy ? '保存中…' : editing ? '保存修改' : '保存记录'}</button>
            <small>${form.mood ? `将记录为「${esc(moodLabel(form.mood))} · ${esc(intensityLabel(form.intensityLevel))}」` : '请先选择一种心情'}</small>
          </div>
        </form>
      </section>

      <section class="xinlv-card xinlv-timeline">
        <header class="xinlv-card-head"><div><span class="section-kicker">TIMELINE</span><h3>心情时间线</h3></div><small>${state.entries.length ? '按日期从近到远' : ''}</small></header>
        ${state.loading ? '<div class="empty-row">正在读取记录…</div>' : dates.length ? dates.map((date) => `<div class="xinlv-day">
          <div class="xinlv-day-head"><strong>${esc(formatDate(date))}</strong><small>${esc(weekdayLabel(date))}</small></div>
          <div class="xinlv-day-list">${grouped.get(date).map((entry) => `<article class="xinlv-entry">
            <div class="xinlv-entry-main">
              ${moodChip(entry.mood)}
              <span class="xinlv-entry-intensity">强度 ${esc(intensityLabel(entry.intensityLevel))}</span>
              ${formatTime(entry.createdAt || entry.updatedAt) ? `<span class="xinlv-entry-time">${esc(formatTime(entry.createdAt || entry.updatedAt))}</span>` : ''}
            </div>
            ${entry.note ? `<p class="xinlv-entry-note">${esc(entry.note)}</p>` : ''}
            <div class="xinlv-entry-actions">
              <button type="button" data-xinlv-edit="${esc(entry.uuid)}">修改</button>
              <button type="button" class="danger" data-xinlv-delete="${esc(entry.uuid)}">删除</button>
            </div>
          </article>`).join('')}</div>
        </div>`).join('') : '<div class="empty-row">还没有记录。选一种心情，写下今天。</div>'}
      </section>
    </div>`;
  }

  // -------------------------------------------------------- recommend panel

  function renderRecommend() {
    const view = state.recommend;
    const mood = view.mood || state.form.mood || (state.entries.at(-1)?.mood ?? '');
    const data = view.data;
    return `<div class="xinlv-recommend">
      <section class="xinlv-card">
        <header class="xinlv-card-head"><div><span class="section-kicker">RECOMMENDATION</span><h3>选一种心情获取建议</h3></div></header>
        <div class="xinlv-mood-grid compact" role="radiogroup" aria-label="选择心情">
          ${MOODS.map((item) => `<button type="button" role="radio" aria-checked="${mood === item.key}" class="xinlv-mood-option xinlv-mood-${item.key}${mood === item.key ? ' active' : ''}" data-xinlv-recommend="${item.key}"><i></i><span>${esc(item.label)}</span></button>`).join('')}
        </div>
        ${view.loading ? '<div class="empty-row">正在获取建议…</div>' : ''}
        ${view.error ? `<p class="xinlv-status error" role="alert">${esc(view.error)}</p>` : ''}
        ${view.local ? '<p class="xinlv-status">当前无法连接心履，正在显示本机缓存的内容目录。</p>' : ''}
      </section>
      ${data ? `<section class="xinlv-card">
        <header class="xinlv-card-head"><div><span class="section-kicker">FOR ${esc(String(data.mood || mood).toUpperCase())}</span><h3>${esc(moodLabel(data.mood || mood))}的时候</h3></div></header>
        ${data.info?.title || data.info?.text ? `<div class="xinlv-info"><strong>${esc(data.info.title || '')}</strong><p>${esc(data.info.text || data.info.description || '')}</p></div>` : ''}
        ${Array.isArray(data.tips) && data.tips.length ? `<section class="xinlv-block"><h4>可以试试</h4><div class="xinlv-tip-list">${data.tips.map((tip) => {
          if (typeof tip === 'string') return `<article class="xinlv-tip"><p>${esc(tip)}</p></article>`;
          const title = esc(tip?.title || tip?.text || '');
          const content = esc(tip?.content || tip?.description || '');
          const source = esc(tip?.source || '');
          if (!title && !content) return '';
          return `<article class="xinlv-tip">${title ? `<strong>${title}</strong>` : ''}${content ? `<p>${content}</p>` : ''}${source ? `<small>出处：${source}</small>` : ''}</article>`;
        }).join('')}</div></section>` : ''}
        ${Array.isArray(data.activities) && data.activities.length ? `<section class="xinlv-block"><h4>活动建议</h4><div class="xinlv-chip-list">${data.activities.map((item) => `<span class="xinlv-suggest-chip">${esc(typeof item === 'string' ? item : item?.title || item?.name || '')}</span>`).join('')}</div></section>` : ''}
        ${data.practice ? `<section class="xinlv-block"><h4>练习</h4><p class="xinlv-practice">${esc(data.practice)}</p></section>` : ''}
        ${Array.isArray(data.songs) && data.songs.length ? `<section class="xinlv-block"><h4>音乐</h4><div class="xinlv-song-list">${data.songs.map((song) => {
          const name = esc(song?.title || song?.name || '未命名');
          const artist = esc(song?.artist || song?.singer || '');
          const url = isSafeUrl(song?.url) ? song.url : '';
          const inner = `<span><strong>${name}</strong>${artist ? `<small>${artist}</small>` : ''}</span><em>${url ? '在浏览器打开 ↗' : ''}</em>`;
          return url ? `<button type="button" data-xinlv-open-url="${esc(url)}">${inner}</button>` : `<div class="xinlv-song-static">${inner}</div>`;
        }).join('')}</div></section>` : ''}
        ${data.video && isSafeUrl(data.video.url || data.video) ? `<section class="xinlv-block"><h4>视频</h4><button type="button" class="secondary-button" data-xinlv-open-url="${esc(data.video.url || data.video)}">在浏览器打开视频 ↗</button></section>` : ''}
      </section>` : ''}
    </div>`;
  }

  // ------------------------------------------------------------- chat panel

  function renderChat() {
    const chat = state.chat;
    const messages = chat.messages;
    return `<div class="xinlv-chat">
      ${chat.crisis ? `<section class="xinlv-crisis" role="alert">
        <strong>心履检测到你可能正处于危机中</strong>
        <p>${esc(chat.crisis.reply || '请立刻联系身边可信任的人，或拨打下面的热线。你并不孤单。')}</p>
        <p class="xinlv-crisis-hotline">${esc(chat.crisis.hotline || '全国心理援助热线 12356 · 北京 010-82951332 · 紧急情况请拨打 120 / 110')}</p>
        <button type="button" class="secondary-button" data-xinlv-dismiss-crisis>我知道了</button>
      </section>` : ''}
      <section class="xinlv-card xinlv-chat-card">
        <header class="xinlv-card-head">
          <div><span class="section-kicker">CONVERSATION</span><h3>和心履说说话</h3></div>
          <button type="button" class="secondary-button" data-xinlv-clear-chat${chat.messages.length ? '' : ' disabled'}>清空对话</button>
        </header>
        <div class="xinlv-chat-log" id="xinlvChatLog">
          ${chat.loading ? '<div class="empty-row">正在读取对话…</div>' : messages.length ? messages.map((message) => `<article class="xinlv-bubble ${message.role === 'user' ? 'user' : 'assistant'}" translate="no"><p>${esc(message.content)}</p>${message.createdAt ? `<small>${esc(formatTime(message.createdAt))}</small>` : ''}</article>`).join('') : '<div class="empty-row">还没有对话。说说今天发生了什么，心履会认真听。</div>'}
          ${chat.sending ? '<article class="xinlv-bubble assistant pending"><p>心履正在回复…</p></article>' : ''}
        </div>
        ${chat.error ? `<p class="xinlv-status error" role="alert">${esc(chat.error)}</p>` : ''}
        <form class="xinlv-chat-form" data-xinlv-chat-form>
          <textarea name="message" rows="3" maxlength="4000" placeholder="写下你想说的话…" ${chat.sending ? 'disabled' : ''}>${esc(chat.draft)}</textarea>
          <div class="xinlv-chat-actions">
            <small>回复由心履服务生成，不能替代专业医疗或心理治疗；紧急情况请立即联系专业机构。</small>
            <button type="submit" class="primary-button"${chat.sending ? ' disabled' : ''}>${chat.sending ? '发送中…' : '发送'}</button>
          </div>
        </form>
      </section>
    </div>`;
  }

  // ---------------------------------------------------------- profile panel

  function renderProfile() {
    const view = state.profile;
    const data = view.data;
    const status = state.status || {};
    return `<div class="xinlv-profile">
      <section class="xinlv-card">
        <header class="xinlv-card-head"><div><span class="section-kicker">PROFILE</span><h3>我的心履</h3></div>
          <div class="xinlv-profile-actions">
            <button type="button" class="secondary-button" data-xinlv-sync${state.syncing ? ' disabled' : ''}>${state.syncing ? '同步中…' : '立即同步'}</button>
            <button type="button" class="secondary-button danger" data-xinlv-logout>退出登录</button>
          </div>
        </header>
        <div class="xinlv-profile-grid">
          <div class="xinlv-metric"><strong>${esc(status.username || '—')}</strong><span>账号</span></div>
          <div class="xinlv-metric"><strong>${data ? Number(data.streak || 0) : '—'}</strong><span>连续记录天数</span></div>
          <div class="xinlv-metric"><strong>${data ? Number(data.totalEntries || 0) : state.entries.length}</strong><span>累计记录</span></div>
          <div class="xinlv-metric"><strong>${status.pendingSync || 0}</strong><span>待同步</span></div>
        </div>
        ${view.loading ? '<div class="empty-row">正在读取账号资料…</div>' : ''}
        ${view.error ? `<p class="xinlv-status error" role="alert">${esc(view.error)}</p>` : ''}
        ${data ? `<div class="xinlv-profile-detail">
          ${data.bio ? `<p>${esc(data.bio)}</p>` : ''}
          ${data.dateJoined ? `<p class="xinlv-muted">注册于 ${esc(String(data.dateJoined).slice(0, 10))}</p>` : ''}
          ${Array.isArray(data.badges) && data.badges.length ? `<section class="xinlv-block"><h4>徽章</h4><div class="xinlv-badge-list">${data.badges.map((badge) => {
            const days = typeof badge === 'object' ? (badge.days || badge.streak || badge.threshold) : null;
            const name = typeof badge === 'string' ? badge : (badge.name || badge.title || badge.label || '');
            const desc = typeof badge === 'object' ? (badge.desc || badge.description || '') : '';
            const imgSrc = days ? `assets/xinlv/badges/badge_${days}.png` : '';
            return `<article class="xinlv-badge-item">${imgSrc ? `<img src="${esc(imgSrc)}" alt="${esc(name)}" class="xinlv-badge-img" width="64" height="64" loading="lazy"/>` : `<span class="xinlv-badge-placeholder">${esc(name || '徽章')}</span>`}<div class="xinlv-badge-text"><strong>${esc(name)}</strong><p>${esc(desc)}</p></div></article>`;
          }).join('')}</div></section>` : ''}
        </div>` : ''}
      </section>
      <section class="xinlv-card xinlv-about">
        <header class="xinlv-card-head"><div><span class="section-kicker">ABOUT</span><h3>关于心履</h3></div></header>
        <p>心履是一个情绪记录与陪伴工具。它通过官方 API 同步你的心情记录，所有记录保存在本机，只有你主动同步时才会发到心履服务器。</p>
        <p class="xinlv-muted">同步采用“时间戳较新者胜出”的规则，删除的记录会以墓碑形式同步，不会在另一台设备上复活。</p>
        <div class="xinlv-profile-actions"><button type="button" class="secondary-button" data-xinlv-open-url="https://xin-lv.com/">在浏览器打开心履官网 ↗</button></div>
      </section>
    </div>`;
  }

  // ------------------------------------------------------------- main render

  function render() {
    const root = state.root;
    if (!root) return;
    if (!configured()) {
      root.innerHTML = `<header class="xinlv-hero">
        <div class="xinlv-hero-copy"><span class="section-kicker">WELLBEING</span><h2>心履</h2><p>记录心情、获得建议、随时聊一聊。登录后记录会加密保存在本机，并按需同步到心履。</p></div>
      </header>${renderLogin()}`;
      return;
    }
    const status = state.status || {};
    root.innerHTML = `<header class="xinlv-hero">
      <div class="xinlv-hero-copy">
        <span class="section-kicker">WELLBEING</span>
        <h2>心履</h2>
        <p>${status.username ? `已登录 ${esc(status.username)} · ` : ''}${state.entries.length} 条记录${status.pendingSync ? ` · ${status.pendingSync} 条待同步` : ' · 已同步'}</p>
      </div>
      <div class="xinlv-hero-side">
        <button type="button" class="secondary-button" data-xinlv-sync${state.syncing ? ' disabled' : ''}>${state.syncing ? '同步中…' : '同步'}</button>
      </div>
    </header>
    <nav class="xinlv-tabs" aria-label="心履模块">
      ${TABS.map((tab) => `<button type="button" class="xinlv-tab${state.tab === tab.key ? ' active' : ''}" data-xinlv-tab="${tab.key}" aria-current="${state.tab === tab.key}"><strong>${esc(tab.label)}</strong><small>${esc(tab.hint)}</small></button>`).join('')}
    </nav>
    ${statusLine()}
    ${state.tab === 'record' ? renderRecord() : state.tab === 'recommend' ? renderRecommend() : state.tab === 'chat' ? renderChat() : renderProfile()}`;
    const log = root.querySelector('#xinlvChatLog');
    if (log) log.scrollTop = log.scrollHeight;
  }

  // ------------------------------------------------------------------ data

  async function loadStatus() {
    try {
      state.status = await api().status();
    } catch (error) {
      state.status = { configured: false };
      state.error = safeError(error, '无法读取心履登录状态');
    }
  }

  async function loadEntries() {
    if (!configured()) return;
    state.loading = true;
    render();
    try {
      const entries = await api().list({});
      state.entries = Array.isArray(entries) ? entries : [];
      state.error = '';
    } catch (error) {
      state.error = safeError(error, '无法读取心情记录');
    } finally {
      state.loading = false;
    }
  }

  async function loadChat() {
    if (!configured()) return;
    state.chat.loading = true;
    render();
    try {
      const messages = await api().history();
      state.chat.messages = (Array.isArray(messages) ? messages : []).map(normalizeMessage).filter(Boolean);
      state.chat.error = '';
    } catch (error) {
      state.chat.error = safeError(error, '无法读取对话记录');
    } finally {
      state.chat.loading = false;
    }
  }

  async function loadProactive() {
    if (!configured() || state.chat.loading) return;
    try {
      const result = await api().proactive(state.chat.lastProactive || undefined);
      const incoming = (Array.isArray(result?.messages) ? result.messages : []).map(normalizeMessage).filter(Boolean);
      const known = new Set(state.chat.messages.map((message) => `${message.role}|${message.content}|${message.createdAt}`));
      for (const message of incoming) {
        const key = `${message.role}|${message.content}|${message.createdAt}`;
        if (!known.has(key)) state.chat.messages.push(message);
      }
      state.chat.messages.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
      if (result?.serverTime) state.chat.lastProactive = result.serverTime;
    } catch { /* proactive messages are optional */ }
  }

  function normalizeMessage(message) {
    if (!message || typeof message !== 'object') return null;
    const content = String(message.content ?? message.text ?? message.message ?? '').trim();
    if (!content) return null;
    const role = String(message.role || message.sender || 'assistant').toLowerCase();
    return { role: role === 'user' || role === 'human' ? 'user' : 'assistant', content, createdAt: message.created_at || message.createdAt || '' };
  }

  async function loadProfile() {
    if (!configured()) return;
    state.profile.loading = true;
    render();
    try {
      state.profile.data = await api().profile();
      state.profile.error = '';
    } catch (error) {
      state.profile.error = safeError(error, '无法读取账号资料');
    } finally {
      state.profile.loading = false;
    }
  }

  async function sync({ silent = true } = {}) {
    if (!configured() || state.syncing) return;
    state.syncing = true;
    if (!silent) render();
    try {
      const result = await api().sync({});
      state.lastSyncAt = Date.now();
      const parts = [];
      if (result?.pushed) parts.push(`上传 ${result.pushed} 条`);
      if (result?.pulled) parts.push(`下载 ${result.pulled} 条`);
      state.notice = parts.length ? `同步完成：${parts.join('，')}` : '同步完成，已是最新';
      if (Array.isArray(result?.errors) && result.errors.length) state.error = String(result.errors[0]);
      await loadStatus();
      await loadEntries();
    } catch (error) {
      state.error = safeError(error, '同步失败，稍后可重试');
    } finally {
      state.syncing = false;
      render();
      if (state.notice) setTimeout(() => { if (state.notice) { state.notice = ''; render(); } }, 4000);
    }
  }

  // Local saves are pushed on a short debounce so a burst of edits makes one request.
  function scheduleSync() {
    if (state.syncTimer) clearTimeout(state.syncTimer);
    state.syncTimer = setTimeout(() => { state.syncTimer = 0; sync({ silent: true }); }, 4000);
  }

  async function refreshAfterLogin() {
    await loadStatus();
    state.error = '';
    state.notice = '已登录心履';
    render();
    await sync({ silent: true });
    await loadChat();
    render();
  }

  // ---------------------------------------------------------------- actions

  async function submitEntry(form) {
    const note = String(form.note || '').trim();
    const mood = state.form.mood;
    const date = String(form.date || state.form.date);
    const intensity = INTENSITY.find((item) => item.level === Number(state.form.intensityLevel)) || INTENSITY[1];
    if (!mood) return;
    const isEditing = Boolean(state.editingUuid);
    state.busy = true;
    state.error = '';
    render();
    try {
      if (state.editingUuid) {
        await api().edit({ uuid: state.editingUuid, patch: { date, mood, note, intensity_level: intensity.level, intensity_percent: intensity.percent } });
        state.notice = '记录已更新';
      } else {
        await api().add({ date, mood, note, intensity_level: intensity.level, intensity_percent: intensity.percent });
        state.notice = '已记录今天的心情';
      }
      state.editingUuid = '';
      state.form = { date: dateKey(), mood: '', intensityLevel: 2, note: '' };
      await loadStatus();
      await loadEntries();
      scheduleSync();
      if (!isEditing && mood) { state.tab = 'recommend'; state.recommend.data = null; await loadRecommend(mood); }
    } catch (error) {
      state.error = safeError(error, '保存记录失败');
    } finally {
      state.busy = false;
      render();
    }
  }

  async function removeEntry(uuid) {
    const confirmed = typeof window.confirmAction === 'function' ? await window.confirmAction('删除这条心情记录？删除后会同步到其他设备。') : true;
    if (!confirmed) return;
    try {
      await api().remove(uuid);
      state.notice = '记录已删除';
      await loadStatus();
      await loadEntries();
      scheduleSync();
    } catch (error) {
      state.error = safeError(error, '删除失败');
    }
    render();
  }

  function startEdit(uuid) {
    const entry = state.entries.find((item) => item.uuid === uuid);
    if (!entry) return;
    state.editingUuid = uuid;
    state.form = { date: entry.date, mood: entry.mood, intensityLevel: Number(entry.intensityLevel) || 2, note: entry.note || '' };
    state.tab = 'record';
    render();
    state.root?.querySelector('.xinlv-compose')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // The content catalog is small and the API documents caching it locally so
  // recommendations still work offline. It is stored inside the encrypted
  // launcher store through the main process.
  async function loadCatalog({ force = false } = {}) {
    if (!configured()) return null;
    try {
      const result = await api().catalog(force ? { force: true } : {});
      if (result?.catalog && typeof result.catalog === 'object') {
        state.catalog = result.catalog;
        state.catalogAt = Date.now();
        return state.catalog;
      }
    } catch { /* the online recommend endpoint stays the primary path */ }
    return state.catalog;
  }

  function localRecommendation(mood) {
    const catalog = state.catalog;
    if (!catalog || typeof catalog !== 'object') return null;
    const match = (item) => Array.isArray(item?.moods) ? item.moods.includes(mood) : false;
    const songs = (Array.isArray(catalog.songs) ? catalog.songs : []).filter(match).slice(0, 6);
    const activities = (Array.isArray(catalog.activities) ? catalog.activities : []).filter(match).map((item) => item?.text || item?.title || '').filter(Boolean).slice(0, 8);
    const tips = (Array.isArray(catalog.tips) ? catalog.tips : []).filter(match).slice(0, 6);
    const video = (Array.isArray(catalog.videos) ? catalog.videos : []).find(match) || null;
    const info = (Array.isArray(catalog.moods) ? catalog.moods : []).find((item) => item?.key === mood) || null;
    if (!songs.length && !activities.length && !tips.length && !video) return null;
    return { mood, info, valence: info?.valence, songs, activities, tips, practice: '', video };
  }

  async function loadRecommend(mood) {
    if (!MOOD_KEYS.has(mood)) return;
    state.recommend.mood = mood;
    state.recommend.loading = true;
    state.recommend.error = '';
    state.recommend.local = false;
    render();
    try {
      state.recommend.data = await api().recommend(mood);
    } catch (error) {
      const fallback = localRecommendation(mood);
      if (fallback) {
        state.recommend.data = fallback;
        state.recommend.local = true;
        state.recommend.error = safeError(error, '无法获取推荐');
      } else {
        state.recommend.error = safeError(error, '无法获取推荐');
        state.recommend.data = null;
      }
    } finally {
      state.recommend.loading = false;
      render();
    }
  }

  async function sendChat(form) {
    const message = String(form.message || '').trim();
    if (!message || state.chat.sending) return;
    state.chat.draft = '';
    state.chat.error = '';
    state.chat.messages.push({ role: 'user', content: message, createdAt: new Date().toISOString() });
    state.chat.sending = true;
    render();
    try {
      const result = await api().chat(message);
      if (result?.crisis) {
        state.chat.crisis = { reply: result.reply, hotline: result.hotline };
      }
      if (result?.reply) state.chat.messages.push({ role: 'assistant', content: result.reply, createdAt: new Date().toISOString() });
      else if (!result?.crisis) state.chat.error = '心履这次没有返回内容，可以再试一次。';
    } catch (error) {
      state.chat.error = safeError(error, '发送失败，请稍后重试');
    } finally {
      state.chat.sending = false;
      render();
    }
  }

  async function clearChat() {
    const confirmed = typeof window.confirmAction === 'function' ? await window.confirmAction('清空与心履的对话记录？该操作会同步到服务器。') : true;
    if (!confirmed) return;
    try {
      await api().clearChat();
      state.chat.messages = [];
      state.chat.crisis = null;
      state.notice = '对话已清空';
    } catch (error) {
      state.chat.error = safeError(error, '清空对话失败');
    }
    render();
  }

  async function submitLogin(form) {
    const login = state.login;
    login.username = String(form.username || '').trim();
    login.password = String(form.password || '');
    login.agree = Boolean(form.agree);
    login.error = '';
    if (!login.username || !login.password) { login.error = '请填写账号和密码'; render(); return; }
    if (login.mode === 'register') {
      if (!login.agree) { login.error = '注册前需要先阅读并同意免责声明'; render(); return; }
      if (login.password.length < 6) { login.error = '密码至少 6 位'; render(); return; }
      if (!/^[\w.@+\-\u4e00-\u9fa5]{1,150}$/.test(login.username)) { login.error = '账号只能包含字母、数字、下划线、. @ + - 或中文'; render(); return; }
    }
    login.busy = true;
    render();
    try {
      if (login.mode === 'register') await api().register({ username: login.username, password: login.password });
      else await api().login({ username: login.username, password: login.password });
      login.password = '';
      login.busy = false;
      login.mode = 'login';
      await refreshAfterLogin();
      if (typeof window.refreshAccountSettings === 'function') window.refreshAccountSettings();
    } catch (error) {
      login.busy = false;
      login.password = '';
      // Never retry automatically: repeated failures can lock the account.
      login.error = safeError(error, '登录失败，请检查账号密码');
      render();
    }
  }

  async function logout() {
    const confirmed = typeof window.confirmAction === 'function' ? await window.confirmAction('退出心履登录？本机记录会保留，但不再自动同步。') : true;
    if (!confirmed) return;
    stopProactivePolling();
    try {
      await api().logout();
      state.status = { configured: false };
      state.entries = [];
      state.chat = { messages: [], loading: false, sending: false, error: '', draft: '', crisis: null, lastProactive: '', timer: 0 };
      state.profile = { loading: false, data: null, error: '' };
      state.notice = '已退出心履登录';
    } catch (error) {
      state.error = safeError(error, '退出登录失败');
    }
    render();
    if (typeof window.refreshAccountSettings === 'function') window.refreshAccountSettings();
  }

  // The API documents polling for AI check-in messages about once a minute
  // while the chat is open; leaving the tab stops it immediately.
  function stopProactivePolling() {
    if (state.chat.timer) { clearInterval(state.chat.timer); state.chat.timer = 0; }
  }

  function startProactivePolling() {
    stopProactivePolling();
    state.chat.timer = setInterval(() => {
      if (state.tab !== 'chat' || !configured()) { stopProactivePolling(); return; }
      loadProactive().then(() => { if (state.tab === 'chat') render(); }).catch(() => {});
    }, 60000);
  }

  function openUrl(url) {
    if (!isSafeUrl(url)) return;
    window.ph.system.openUrl(url).catch(() => {});
  }

  // ----------------------------------------------------------------- events

  function onSubmit(event) {
    const form = event.target;
    if (form.matches('[data-xinlv-entry-form]')) {
      event.preventDefault();
      submitEntry({ date: field(form, 'date'), note: field(form, 'note') });
      return;
    }
    if (form.matches('[data-xinlv-login-form]')) {
      event.preventDefault();
      submitLogin({ username: field(form, 'username'), password: field(form, 'password'), agree: Boolean(form.querySelector('[name="agree"]')?.checked) });
      return;
    }
    if (form.matches('[data-xinlv-chat-form]')) {
      event.preventDefault();
      sendChat({ message: field(form, 'message') });
    }
  }

  function onChange(event) {
    const target = event.target;
    if (target.matches('[data-xinlv-entry-form] [name="date"]')) state.form.date = target.value;
    if (target.matches('[data-xinlv-login-form] [name="agree"]')) state.login.agree = target.checked;
  }

  function onInput(event) {
    const target = event.target;
    if (target.matches('[data-xinlv-entry-form] [name="note"]')) state.form.note = target.value;
    if (target.matches('[data-xinlv-chat-form] [name="message"]')) state.chat.draft = target.value;
  }

  async function onClick(event) {
    const tab = event.target.closest('[data-xinlv-tab]');
    if (tab) {
      state.tab = tab.dataset.xinlvTab;
      state.error = '';
      state.notice = '';
      if (state.tab !== 'chat') stopProactivePolling();
      render();
      if (state.tab === 'chat' && configured()) {
        if (!state.chat.messages.length) await loadChat();
        await loadProactive();
        render();
        startProactivePolling();
      }
      if (state.tab === 'recommend' && configured()) {
        if (!state.catalog) await loadCatalog();
        if (!state.recommend.data && !state.recommend.loading) await loadRecommend('happy');
        render();
      }
      if (state.tab === 'profile' && configured()) { await loadProfile(); render(); }
      return;
    }
    const moodButton = event.target.closest('[data-xinlv-mood]');
    if (moodButton) {
      state.form.mood = moodButton.dataset.xinlvMood;
      render();
      return;
    }
    const intensityButton = event.target.closest('[data-xinlv-intensity]');
    if (intensityButton) {
      state.form.intensityLevel = Number(intensityButton.dataset.xinlvIntensity);
      render();
      return;
    }
    if (event.target.closest('[data-xinlv-cancel-edit]')) {
      state.editingUuid = '';
      state.form = { date: dateKey(), mood: '', intensityLevel: 2, note: '' };
      render();
      return;
    }
    const editButton = event.target.closest('[data-xinlv-edit]');
    if (editButton) { startEdit(editButton.dataset.xinlvEdit); return; }
    const deleteButton = event.target.closest('[data-xinlv-delete]');
    if (deleteButton) { await removeEntry(deleteButton.dataset.xinlvDelete); return; }
    const recommendButton = event.target.closest('[data-xinlv-recommend]');
    if (recommendButton) { await loadRecommend(recommendButton.dataset.xinlvRecommend); return; }
    if (event.target.closest('[data-xinlv-sync]')) { await sync({ silent: false }); return; }
    if (event.target.closest('[data-xinlv-logout]')) { await logout(); return; }
    if (event.target.closest('[data-xinlv-clear-chat]')) { await clearChat(); return; }
    if (event.target.closest('[data-xinlv-dismiss-crisis]')) { state.chat.crisis = null; render(); return; }
    const loginMode = event.target.closest('[data-xinlv-login-mode]');
    if (loginMode) {
      state.login.mode = loginMode.dataset.xinlvLoginMode === 'register' ? 'register' : 'login';
      state.login.error = '';
      render();
      return;
    }
    const link = event.target.closest('[data-xinlv-open-url]');
    if (link) { openUrl(link.dataset.xinlvOpenUrl); return; }
  }

  // ------------------------------------------------------------------- mount

  function mount() {
    if (state.mounted) return;
    const root = document.getElementById('xinlvPage');
    if (!root) return;
    state.root = root;
    state.mounted = true;
    root.addEventListener('click', (event) => { onClick(event).catch(() => {}); });
    root.addEventListener('submit', onSubmit);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    render();
  }

  async function open() {
    mount();
    if (!state.root) return false;
    if (!state.status) await loadStatus();
    if (configured()) {
      render();
      await loadEntries();
      await loadCatalog();
      const stale = !state.lastSyncAt || Date.now() - state.lastSyncAt > 300000;
      if (stale) await sync({ silent: true });
      else render();
    } else {
      stopProactivePolling();
      render();
    }
    return true;
  }

  async function connect(input = {}) {
    // Used by the settings login card: reuse the dialog values.
    state.login.username = String(input.username || '');
    state.login.mode = 'login';
    mount();
    if (!input.username || !input.password) {
      if (typeof window.navigate === 'function') window.navigate('psychology');
      render();
      return false;
    }
    await submitLogin({ username: input.username, password: input.password, agree: false });
    if (!configured()) throw new Error(state.login.error || '心履登录失败');
    return true;
  }

  function clear() {
    stopProactivePolling();
    state.status = null;
    state.entries = [];
    state.chat = { messages: [], loading: false, sending: false, error: '', draft: '', crisis: null, lastProactive: '', timer: 0 };
    state.profile = { loading: false, data: null, error: '' };
    state.error = '';
    state.notice = '';
    render();
  }

  window.xinlvUI = { mount, open, connect, clear, refresh: open, render, state };
})();

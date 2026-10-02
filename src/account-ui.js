/* ============================================================================
 * phix 账号界面（PHL 与 PHL Lite **共用同一份文件**）
 * ----------------------------------------------------------------------------
 * 用户 2026-09-28 要求：整体模仿微软的首次开机流程。
 *
 *   设置页里的账号卡片
 *     · 已登录 → 个人资料卡片（头像 / 昵称 / 各平台账号名与登录情况）+ 退出登录
 *     · 未登录 → 占位头像 + 「账号未登录」 + 登录按钮
 *   点登录 → 占满整个窗口的登录界面
 *     · 账号 + 密码
 *     · 下面一行小字「没有账号？去注册」
 *     · 右上角小字「暂时跳过」
 *   注册完 → 跳回登录页
 *   登录完 → 问「本地覆盖云端 / 云端覆盖本地」
 *   选完 **不马上进软件** → 「我们正在为你准备你的软件」+ 逐项进度（微软那种）
 *   首次打开软件也走同一套流程
 *
 * 这一份文件在 PHL（src/account-ui.js）与 PHL Lite（ui/account-ui.js）各有一个
 * **字节完全相同**的副本；改一处必须同步另一处，`scripts/test_account_ui.py`
 * 会断言两份一致。
 *
 * 宿主程序只需要提供一个 bridge（见下方 CONTRACT），界面本身不含任何平台代码。
 *
 * CONTRACT（宿主实现这些方法，返回 Promise）：
 *   status()                          → { loggedIn, username, displayName, avatar, accounts:[…], server }
 *   login(username, password)         → { ok, error? }
 *   register(username, password)      → { ok, error? }
 *   logout()                          → { ok }
 *   probe()                           → { remote: {objects,updatedAt}, local: {objects}, objects:[{id,label,remote,local}] }
 *   sync(direction)                   → { ok, error?, summary? }          direction: 'local' | 'cloud'
 *   preparePlan()                     → [{ id, label }]                   要显示成进度条的步骤
 *   prepareStep(id)                   → { ok, detail? }                  跑一步
 *   saveProfile(patch)                → { ok }
 *   openRegister()                    → 打开注册页面（没有就宿主自己决定）
 * ========================================================================== */
(function () {
  'use strict';

  const ACCENT_FALLBACK = '#0f6cbd';

  const CSS = `
  .paui-root, .paui-root * { box-sizing: border-box; }
  .paui-root {
    position: fixed; inset: 0; z-index: 400;
    display: flex; flex-direction: column;
    background: #f3f3f3; color: #1b1b1b;
    font: 14px/1.5 "Segoe UI", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .paui-root.hidden { display: none; }
  .paui-top { display: flex; justify-content: flex-end; padding: 14px 20px; }
  .paui-skip {
    border: 0; background: transparent; color: #5c5c5c; cursor: pointer;
    font-size: 13px; padding: 6px 10px; border-radius: 6px;
  }
  .paui-skip:hover { background: rgba(0,0,0,.06); color: #1b1b1b; }
  .paui-body { flex: 1; display: flex; align-items: center; justify-content: center; padding: 0 24px 60px; }
  .paui-card {
    width: min(460px, 100%); background: #fff; border-radius: 10px;
    box-shadow: 0 2px 14px rgba(0,0,0,.10); padding: 34px 34px 28px;
  }
  .paui-logo { display: flex; align-items: center; justify-content: center; margin-bottom: 18px; }
  .paui-logo-mark {
    width: 46px; height: 46px; border-radius: 10px; display: flex; align-items: center;
    justify-content: center; color: #fff; font-weight: 700; font-size: 19px; letter-spacing: .5px;
  }
  .paui-title { font-size: 24px; font-weight: 600; text-align: center; margin: 0 0 6px; }
  .paui-sub { text-align: center; color: #5c5c5c; font-size: 13px; margin: 0 0 22px; }
  .paui-field { margin-bottom: 12px; }
  .paui-field label { display: block; font-size: 13px; color: #3b3b3b; margin-bottom: 5px; }
  .paui-input {
    width: 100%; padding: 9px 11px; font-size: 14px; color: #1b1b1b;
    border: 1px solid #d1d1d1; border-bottom: 2px solid #8a8a8a; border-radius: 5px;
    background: #fbfbfb; outline: none;
  }
  .paui-input:focus { border-color: #8a8a8a; border-bottom-color: var(--paui-accent); background: #fff; }
  .paui-primary {
    width: 100%; margin-top: 10px; padding: 10px 16px; font-size: 14px; font-weight: 600;
    color: #fff; background: var(--paui-accent); border: 0; border-radius: 5px; cursor: pointer;
  }
  .paui-primary:hover { filter: brightness(1.08); }
  .paui-primary:disabled { opacity: .5; cursor: default; }
  .paui-link-row { text-align: center; margin-top: 18px; font-size: 13px; color: #5c5c5c; }
  .paui-link {
    border: 0; background: transparent; color: var(--paui-accent); cursor: pointer;
    font-size: 13px; padding: 2px 4px; text-decoration: none;
  }
  .paui-link:hover { text-decoration: underline; }
  .paui-msg { min-height: 18px; margin-top: 10px; font-size: 13px; color: #b10e1c; text-align: center; }
  .paui-msg.ok { color: #0f7b0f; }

  /* ---- 方向选择 ---- */
  .paui-choices { display: flex; flex-direction: column; gap: 10px; margin-top: 6px; }
  .paui-choice {
    text-align: left; padding: 14px 16px; border: 1px solid #d1d1d1; border-radius: 8px;
    background: #fff; cursor: pointer; font: inherit; color: inherit;
  }
  .paui-choice:hover { border-color: var(--paui-accent); background: #f7fbff; }
  .paui-choice b { display: block; font-size: 14px; margin-bottom: 3px; }
  .paui-choice span { color: #5c5c5c; font-size: 12.5px; }
  .paui-choice .paui-count { color: #0f7b0f; font-weight: 600; }

  /* ---- 准备进度（微软那种） ---- */
  .paui-prep { width: min(560px, 100%); }
  .paui-prep h2 { font-size: 26px; font-weight: 600; margin: 0 0 8px; }
  .paui-prep .paui-prep-sub { color: #5c5c5c; font-size: 13.5px; margin: 0 0 22px; }
  .paui-bar { height: 4px; border-radius: 999px; background: #e2e2e2; overflow: hidden; margin-bottom: 20px; }
  .paui-bar > i { display: block; height: 100%; width: 0; background: var(--paui-accent); transition: width .25s ease; }
  .paui-steps { list-style: none; margin: 0; padding: 0; }
  .paui-step { display: flex; align-items: center; gap: 10px; padding: 7px 0; font-size: 14px; color: #5c5c5c; }
  .paui-step .paui-dot {
    width: 18px; height: 18px; flex: none; border-radius: 50%; border: 1.5px solid #c8c8c8;
    display: flex; align-items: center; justify-content: center; font-size: 11px; color: #fff;
  }
  .paui-step.active { color: #1b1b1b; font-weight: 600; }
  .paui-step.active .paui-dot { border-color: var(--paui-accent); border-style: dashed; animation: paui-spin 1.1s linear infinite; }
  .paui-step.done .paui-dot { background: #0f7b0f; border-color: #0f7b0f; }
  .paui-step.done .paui-dot::after { content: "✓"; }
  .paui-step.fail .paui-dot { background: #b10e1c; border-color: #b10e1c; }
  .paui-step.fail .paui-dot::after { content: "!"; }
  .paui-step .paui-detail { margin-left: auto; font-size: 12px; color: #8a8a8a; font-weight: 400; }
  @keyframes paui-spin { to { transform: rotate(360deg); } }
  .paui-done-row { margin-top: 22px; display: flex; justify-content: flex-end; }
  .paui-done-row .paui-primary { width: auto; min-width: 120px; margin: 0; }

  /* ---- 设置页里的账号卡片 ---- */
  .paui-account-card { display: flex; align-items: center; gap: 14px; padding: 16px; border-radius: 12px;
    border: 1px solid var(--paui-card-border, #e6e0d4); background: var(--paui-card-bg, #fffdf8); }
  .paui-avatar { width: 58px; height: 58px; flex: none; border-radius: 50%; overflow: hidden;
    display: flex; align-items: center; justify-content: center; background: var(--paui-accent);
    color: #fff; font-size: 22px; font-weight: 700; }
  .paui-avatar.placeholder { background: #d6d2c8; color: #8f8a7e; font-size: 26px; }
  .paui-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .paui-acc-main { flex: 1; min-width: 0; }
  .paui-acc-name { font-size: 16px; font-weight: 700; margin-bottom: 2px; }
  .paui-acc-sub { font-size: 12.5px; color: #8a857a; }
  .paui-acc-platforms { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .paui-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 3px 9px;
    border-radius: 999px; border: 1px solid var(--paui-card-border, #e6e0d4); color: #6f6a60; background: transparent; }
  .paui-chip.on { color: #0f7b0f; border-color: rgba(15,123,15,.35); background: rgba(15,123,15,.07); }
  .paui-chip .paui-chip-dot { width: 6px; height: 6px; border-radius: 50%; background: #c0bbb0; }
  .paui-chip.on .paui-chip-dot { background: #0f7b0f; }
  .paui-acc-actions { display: flex; flex-direction: column; gap: 8px; align-items: stretch; flex: none; }
  .paui-btn-sm { padding: 7px 14px; font-size: 13px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; }
  .paui-btn-sm.primary { background: var(--paui-accent); color: #fff; border: 0; }
  .paui-btn-sm.ghost { background: transparent; border-color: var(--paui-card-border, #e6e0d4); color: #6f6a60; }
  .paui-btn-sm.ghost:hover { border-color: #b10e1c; color: #b10e1c; }
  `;

  /** 运行时状态 */
  const state = {
    bridge: null,
    opts: {},
    screen: 'hidden',       // hidden | login | register | direction | prepare
    status: null,
    message: '',
    messageOk: false,
    busy: false,
    probe: null,
    plan: [],
    stepStates: {},         // id -> 'pending' | 'active' | 'done' | 'fail'
    stepDetail: {},
    stepIndex: 0,
    container: null,
    onFinish: null,
    firstRun: false,
  };

  function accent() {
    return (state.opts && state.opts.accent) || ACCENT_FALLBACK;
  }

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function mountPoint() {
    if (state.container && document.body.contains(state.container)) return state.container;
    const c = el('div', 'paui-root hidden');
    c.setAttribute('data-paui-root', '');
    c.style.setProperty('--paui-accent', accent());
    document.body.appendChild(c);
    state.container = c;
    return c;
  }

  function ensureStyle() {
    if (document.getElementById('paui-style')) return;
    const s = el('style');
    s.id = 'paui-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function setMessage(text, ok) {
    state.message = text || '';
    state.messageOk = Boolean(ok);
  }

  function esc(v) {
    return String(v === undefined || v === null ? '' : v);
  }

  function initial(name) {
    const t = esc(name).trim();
    return t ? t.slice(0, 1).toUpperCase() : '?';
  }

  // ---------------------------------------------------------------- 卡片（设置页里用）
  const PLATFORM_LABELS = {
    edupage: 'EduPage', managebac: 'ManageBac', mail: '平和邮箱', xinlv: '心履', phix: 'phix',
  };

  function platformChips(status) {
    const wrap = el('div', 'paui-acc-platforms');
    const accounts = (status && status.accounts) || [];
    if (!accounts.length) return wrap;
    for (const acc of accounts) {
      const on = Boolean(acc && acc.loggedIn);
      const chip = el('span', 'paui-chip' + (on ? ' on' : ''));
      chip.appendChild(el('span', 'paui-chip-dot'));
      const label = acc.label || PLATFORM_LABELS[acc.id] || acc.id || '账号';
      const who = acc.account ? ` ${acc.account}` : '';
      chip.appendChild(el('span', null, on ? `${label}${who}` : `${label} 未登录`));
      if (acc.detail) chip.title = String(acc.detail);
      wrap.appendChild(chip);
    }
    return wrap;
  }

  /** 渲染「设置页里的账号卡片」，塞进 host 给的容器。不占满窗口。 */
  function renderCard(container) {
    if (!container) return;
    ensureStyle();
    container.textContent = '';
    const status = state.status || {};
    const loggedIn = Boolean(status.loggedIn);

    const card = el('div', 'paui-account-card');
    const av = el('div', 'paui-avatar' + (loggedIn ? '' : ' placeholder'));
    if (loggedIn && status.avatar) {
      const img = el('img');
      img.src = String(status.avatar);
      img.alt = '';
      av.appendChild(img);
    } else if (loggedIn) {
      av.textContent = initial(status.displayName || status.username);
    } else {
      av.textContent = '?';
    }
    card.appendChild(av);

    const main = el('div', 'paui-acc-main');
    main.appendChild(el('div', 'paui-acc-name',
      loggedIn ? (status.displayName || status.username || 'phix 账号') : '账号未登录'));
    main.appendChild(el('div', 'paui-acc-sub',
      loggedIn
        ? (status.username ? `phix 账号 ${status.username}` : '已登录 phix 账号')
          + (status.syncedAt ? ` · 上次同步 ${status.syncedAt}` : '')
        : '登录后课表、日程、账号会跟着你走'));
    main.appendChild(platformChips(status));
    card.appendChild(main);

    const actions = el('div', 'paui-acc-actions');
    if (loggedIn) {
      const out = el('button', 'paui-btn-sm ghost', '退出登录');
      out.type = 'button';
      out.addEventListener('click', async () => {
        out.disabled = true;
        try {
          await state.bridge.logout();
        } catch (err) { /* 退出失败也刷新一次状态 */ }
        await refreshCard(container);
      });
      actions.appendChild(out);
    } else {
      const login = el('button', 'paui-btn-sm primary', '登录');
      login.type = 'button';
      login.addEventListener('click', () => open('login', { onFinish: () => refreshCard(container) }));
      actions.appendChild(login);
    }
    card.appendChild(actions);

    container.appendChild(card);
  }

  async function refreshCard(container) {
    try {
      state.status = await state.bridge.status();
    } catch (err) {
      state.status = { loggedIn: false };
    }
    renderCard(container);
  }

  // ---------------------------------------------------------------- 占满窗口的各屏
  function open(screen, options) {
    ensureStyle();
    state.screen = screen;
    setMessage('', false);
    state.busy = false;
    if (options && options.onFinish) state.onFinish = options.onFinish;
    if (options && options.firstRun !== undefined) state.firstRun = Boolean(options.firstRun);
    renderFull();
  }

  function close() {
    state.screen = 'hidden';
    const c = mountPoint();
    c.classList.add('hidden');
    const cb = state.onFinish;
    state.onFinish = null;
    if (typeof cb === 'function') cb();
  }

  function renderFull() {
    const c = mountPoint();
    c.classList.remove('hidden');
    c.textContent = '';
    c.style.setProperty('--paui-accent', accent());

    const top = el('div', 'paui-top');
    if (state.screen === 'login' || state.screen === 'register') {
      const skip = el('button', 'paui-skip', '暂时跳过');
      skip.type = 'button';
      skip.addEventListener('click', () => close());
      top.appendChild(skip);
    }
    c.appendChild(top);

    const body = el('div', 'paui-body');
    if (state.screen === 'login') body.appendChild(viewLogin());
    else if (state.screen === 'register') body.appendChild(viewRegister());
    else if (state.screen === 'direction') body.appendChild(viewDirection());
    else if (state.screen === 'prepare') body.appendChild(viewPrepare());
    c.appendChild(body);
  }

  function logoCard(titleText, subText) {
    const card = el('div', 'paui-card');
    const logo = el('div', 'paui-logo');
    const mark = el('div', 'paui-logo-mark', 'phix');
    mark.style.background = accent();
    logo.appendChild(mark);
    card.appendChild(logo);
    card.appendChild(el('h1', 'paui-title', titleText));
    if (subText) card.appendChild(el('p', 'paui-sub', subText));
    return card;
  }

  function field(labelText, input) {
    const wrap = el('div', 'paui-field');
    const id = 'paui-' + Math.random().toString(36).slice(2, 8);
    input.id = id;
    const lab = el('label', null, labelText);
    lab.setAttribute('for', id);
    wrap.appendChild(lab);
    wrap.appendChild(input);
    return wrap;
  }

  function messageNode() {
    const m = el('div', 'paui-msg' + (state.messageOk ? ' ok' : ''), state.message);
    m.setAttribute('data-paui-msg', '');
    return m;
  }

  function viewLogin() {
    const card = logoCard('登录 phix 账号', '登录后课表、日程和账号会跟着你走');
    const form = el('form');
    const user = el('input', 'paui-input');
    user.type = 'text';
    user.autocomplete = 'username';
    user.placeholder = '账号';
    const pass = el('input', 'paui-input');
    pass.type = 'password';
    pass.autocomplete = 'current-password';
    pass.placeholder = '密码';
    form.appendChild(field('账号', user));
    form.appendChild(field('密码', pass));

    const submit = el('button', 'paui-primary', state.busy ? '正在登录…' : '登 录');
    submit.type = 'submit';
    submit.disabled = state.busy;
    form.appendChild(submit);
    form.appendChild(messageNode());
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (state.busy) return;
      const u = user.value.trim();
      const p = pass.value;
      if (!u || !p) { setMessage('请填写账号和密码'); renderFull(); return; }
      state.busy = true;
      setMessage('正在登录…', true);
      renderFull();
      try {
        const r = await state.bridge.login(u, p);
        if (r && r.ok === false) throw new Error(r.error || '账号或密码不正确');
        state.busy = false;
        await afterLogin();
      } catch (err) {
        state.busy = false;
        setMessage((err && err.message) || '登录失败，请稍后再试');
        renderFull();
      }
    });
    card.appendChild(form);

    const row = el('div', 'paui-link-row');
    row.appendChild(el('span', null, '没有账号？'));
    const reg = el('button', 'paui-link', '去注册');
    reg.type = 'button';
    reg.addEventListener('click', () => open('register'));
    row.appendChild(reg);
    card.appendChild(row);
    return card;
  }

  function viewRegister() {
    const card = logoCard('注册 phix 账号', '注册完会回到登录页');
    const form = el('form');
    const user = el('input', 'paui-input');
    user.type = 'text';
    user.autocomplete = 'username';
    user.placeholder = '账号';
    const pass = el('input', 'paui-input');
    pass.type = 'password';
    pass.autocomplete = 'new-password';
    pass.placeholder = '密码';
    const pass2 = el('input', 'paui-input');
    pass2.type = 'password';
    pass2.autocomplete = 'new-password';
    pass2.placeholder = '再输一遍密码';
    form.appendChild(field('账号', user));
    form.appendChild(field('密码', pass));
    form.appendChild(field('确认密码', pass2));

    const submit = el('button', 'paui-primary', state.busy ? '正在注册…' : '注 册');
    submit.type = 'submit';
    submit.disabled = state.busy;
    form.appendChild(submit);
    form.appendChild(messageNode());
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (state.busy) return;
      const u = user.value.trim();
      const p = pass.value;
      if (!u || !p) { setMessage('请填写账号和密码'); renderFull(); return; }
      if (p !== pass2.value) { setMessage('两次输入的密码不一样'); renderFull(); return; }
      state.busy = true;
      setMessage('正在注册…', true);
      renderFull();
      try {
        const r = await state.bridge.register(u, p);
        if (r && r.ok === false) throw new Error(r.error || '注册失败');
        state.busy = false;
        // 注册完跳回登录页（并把刚填的账号带过去）
        open('login');
        const box = mountPoint().querySelector('input[autocomplete="username"]');
        if (box) box.value = u;
        setMessage('注册成功，请登录', true);
        renderFull();
        const box2 = mountPoint().querySelector('input[autocomplete="username"]');
        if (box2) box2.value = u;
      } catch (err) {
        state.busy = false;
        setMessage((err && err.message) || '注册失败，请稍后再试');
        renderFull();
      }
    });
    card.appendChild(form);

    const row = el('div', 'paui-link-row');
    row.appendChild(el('span', null, '已经有账号了？'));
    const back = el('button', 'paui-link', '去登录');
    back.type = 'button';
    back.addEventListener('click', () => open('login'));
    row.appendChild(back);
    card.appendChild(row);
    return card;
  }

  async function afterLogin() {
    try {
      state.status = await state.bridge.status();
    } catch (err) { state.status = { loggedIn: true }; }
    let probe = null;
    try {
      probe = await state.bridge.probe();
    } catch (err) { probe = null; }
    state.probe = probe;
    // 用户要求：登录之后**总是**问一次方向（本地覆盖云端 / 云端覆盖本地）
    open('direction');
  }

  function viewDirection() {
    const card = logoCard('这份数据怎么处理？', '云端和你这台电脑上都有内容，先选一个方向');
    const box = el('div', 'paui-choices');

    const mk = (direction, title, desc) => {
      const b = el('button', 'paui-choice');
      b.type = 'button';
      b.appendChild(el('b', null, title));
      b.appendChild(el('span', null, desc));
      b.addEventListener('click', () => startPrepare(direction));
      return b;
    };
    const p = state.probe || {};
    const remoteCount = (p.remote && p.remote.count) || 0;
    const localCount = (p.local && p.local.count) || 0;
    const when = (p.remote && p.remote.updatedAt) ? `（${p.remote.updatedAt}）` : '';

    box.appendChild(mk('cloud',
      '云端覆盖本地',
      `用云端的 ${remoteCount} 项替换这台电脑上的内容 ${when}`.trim()));
    box.appendChild(mk('local',
      '本地覆盖云端',
      `把这台电脑上的 ${localCount} 项上传到云端`));
    card.appendChild(box);

    const list = el('div', 'paui-sub');
    list.style.marginTop = '18px';
    list.style.textAlign = 'left';
    const objects = (p.objects || []).filter((o) => (o.remote || 0) + (o.local || 0) > 0);
    if (objects.length) {
      list.textContent = '涉及：' + objects.map((o) => o.label || o.id).join('、');
      card.appendChild(list);
    }
    return card;
  }

  async function startPrepare(direction) {
    open('prepare');
    let plan = [];
    try {
      plan = await state.bridge.preparePlan();
    } catch (err) { plan = []; }
    if (!Array.isArray(plan) || !plan.length) plan = [{ id: 'sync', label: '同步你的数据' }];
    state.plan = plan;
    state.stepStates = {};
    state.stepDetail = {};
    state.stepIndex = 0;
    for (const step of plan) state.stepStates[step.id] = 'pending';
    renderFull();

    // 方向本身也算一步，先让它显示成"已完成"
    try {
      await state.bridge.sync(direction);
    } catch (err) { /* 同步失败也让后续步骤继续，最后统一报 */ }

    for (let i = 0; i < plan.length; i += 1) {
      const step = plan[i];
      state.stepIndex = i;
      state.stepStates[step.id] = 'active';
      renderFull();
      try {
        const r = await state.bridge.prepareStep(step.id);
        if (r && r.ok === false) {
          state.stepStates[step.id] = 'fail';
          state.stepDetail[step.id] = (r && r.detail) || '失败';
        } else {
          state.stepStates[step.id] = 'done';
          if (r && r.detail) state.stepDetail[step.id] = r.detail;
        }
      } catch (err) {
        state.stepStates[step.id] = 'fail';
        state.stepDetail[step.id] = (err && err.message) || '失败';
      }
      renderFull();
    }
    // 全部跑完：状态刷新一次，卡片才会显示新头像/新账号
    try { state.status = await state.bridge.status(); } catch (err) { /* ignore */ }
    state.stepIndex = plan.length;
    renderFull();
  }

  function viewPrepare() {
    const wrap = el('div', 'paui-prep');
    wrap.appendChild(el('h2', null, '我们正在为你准备你的软件'));
    const total = state.plan.length || 1;
    const doneCount = state.plan.filter((s) => state.stepStates[s.id] === 'done').length;
    const activeId = (state.plan[state.stepIndex] || {}).id;
    const activeLabel = (state.plan.find((s) => s.id === activeId) || {}).label;
    const finished = state.stepIndex >= state.plan.length;
    wrap.appendChild(el('p', 'paui-prep-sub',
      finished ? '准备完成，马上就可以开始用了。' : (activeLabel ? `正在${activeLabel}…` : '正在准备…')));

    const bar = el('div', 'paui-bar');
    const fill = el('i');
    fill.style.width = `${Math.round(((finished ? total : doneCount) / total) * 100)}%`;
    bar.appendChild(fill);
    wrap.appendChild(bar);

    const ul = el('ul', 'paui-steps');
    for (const step of state.plan) {
      const st = state.stepStates[step.id] || 'pending';
      const li = el('li', 'paui-step ' + (st === 'active' ? 'active' : st === 'done' ? 'done' : st === 'fail' ? 'fail' : ''));
      li.appendChild(el('span', 'paui-dot'));
      li.appendChild(el('span', null, step.label));
      if (state.stepDetail[step.id]) li.appendChild(el('span', 'paui-detail', state.stepDetail[step.id]));
      ul.appendChild(li);
    }
    wrap.appendChild(ul);

    if (finished) {
      const row = el('div', 'paui-done-row');
      const go = el('button', 'paui-primary', '开始使用');
      go.type = 'button';
      go.addEventListener('click', () => close());
      row.appendChild(go);
      wrap.appendChild(row);
    }
    return wrap;
  }

  // ---------------------------------------------------------------- 对外接口
  window.AccountUI = {
    /** 初始化。opts: { bridge, accent, onReady } */
    init(opts) {
      state.bridge = opts && opts.bridge;
      state.opts = opts || {};
      ensureStyle();
      if (!state.bridge) throw new Error('AccountUI 需要 bridge');
      return window.AccountUI;
    },
    /** 在容器里画账号卡片（设置页用） */
    card(container) {
      refreshCard(container);
      return window.AccountUI;
    },
    /** 打开占满窗口的登录（首次启动或用户点登录） */
    login(options) {
      open('login', options || {});
      return window.AccountUI;
    },
    /** 首次启动那一套：没登录就直接进登录页 */
    async firstRun(options) {
      if (!state.bridge) throw new Error('AccountUI 需要 bridge');
      try { state.status = await state.bridge.status(); } catch (err) { state.status = { loggedIn: false }; }
      const loggedIn = Boolean(state.status && state.status.loggedIn);
      if (loggedIn) {
        open('prepare', options || {});
        await startPrepare('merge');
      } else {
        open('login', options || {});
      }
      return window.AccountUI;
    },
    close,
    _state: state,
  };
})();

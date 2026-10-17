(() => {
  'use strict';
  // Owns the startup overlay（2026-09-20 用户要求：三端统一成"开机画面"——
  // 墨绿底、中间 logo、下面**一根**细进度条，没有任何文字）。
  // 那一根条 = 主进程报的三件真实工作（学校数据 / 邮件服务 / 界面预载）的平均值，
  // 三件都到 100% 才让界面露出来，所以用户不会在界面里看见转圈。
  const MIN_VISIBLE_MS = 900;
  const MAX_WAIT_MS = 25000;
  // 用户 2026-09-21：「进度条走完以后等个半秒，然后再渐渐消失，不要一下子没掉，
  // 让用户能看到进度条走完」。进度条自己也有 .35s 的宽度过渡，所以这半秒是
  // 从"进度数字到 100%"开始算的 —— 半秒后开始淡出（淡出本身见 styles.css 的 .45s）。
  const HOLD_AFTER_DONE_MS = 500;
  const BARS = ['school', 'mail', 'preload'];
  const startedAt = Number(window.__phSplashStartedAt) || Date.now();
  const state = { bars: {}, finished: false, revealed: false, timer: 0, doneAt: 0 };
  let onReveal = null;

  const fill = () => document.getElementById('splashProgress');

  /** 三件事的平均进度 → 那一根条。 */
  function paintAll(bars) {
    for (const [bar, value] of Object.entries(bars || {})) state.bars[bar] = value;
    const total = BARS.reduce((sum, bar) => sum + Math.max(0, Math.min(100, state.bars[bar]?.percent ?? 0)), 0) / BARS.length;
    const node = fill();
    if (node) node.style.width = `${total}%`;
    return total;
  }

  const allDone = () => BARS.every((bar) => (state.bars[bar]?.percent ?? 0) >= 100);

  function reveal() {
    if (state.revealed) return;
    state.revealed = true;
    clearTimeout(state.timer);
    clearTimeout(state.capTimer);
    document.body.classList.add('loaded');
    if (typeof onReveal === 'function') { try { onReveal(); } catch { /* reveal callbacks must not throw */ } }
  }

  function scheduleReveal() {
    if (state.revealed) return;
    if (!state.doneAt) state.doneAt = Date.now();
    const elapsed = Date.now() - startedAt;
    const wait = Math.max(
      0,
      MIN_VISIBLE_MS - elapsed,             // 画面别一闪而过
      state.doneAt + HOLD_AFTER_DONE_MS - Date.now()); // 走完了也要停半秒再淡出
    clearTimeout(state.timer);
    state.timer = setTimeout(reveal, wait);
  }

  // The main process may have finished before this script ran, so ask once.
  async function syncInitialState() {
    try {
      const current = await window.ph?.system?.splashState?.();
      if (!current) return;
      paintAll(current.bars);
      state.finished = Boolean(current.finished);
      if (state.finished) scheduleReveal();
    } catch { /* a missing bridge must not block the splash */ }
  }

  function mount() {
    if (state.mounted) return;
    state.mounted = true;
    window.ph?.system?.onSplashProgress?.((payload) => {
      if (!payload?.bar) return;
      paintAll({ [payload.bar]: { percent: payload.percent } });
    });
    window.ph?.system?.onSplashDone?.((payload) => {
      paintAll(payload?.bars);
      state.finished = true;
      scheduleReveal();
    });
    // 点一下画面就进去（原来那个「跳过」按钮上的文字被去掉了，点击区域留着）。
    document.getElementById('splashScreen')?.addEventListener('click', reveal);
    // Never trap the user on the splash: reveal after a hard cap regardless.
    state.capTimer = setTimeout(reveal, MAX_WAIT_MS);
    void syncInitialState();
  }

  // Called by app.js once local data is ready; the splash still waits for the
  // preload bars so the app is only shown when it is actually usable.
  function ready(callback) {
    onReveal = typeof callback === 'function' ? callback : null;
    mount();
    if (state.finished || allDone()) scheduleReveal();
  }

  window.splashUI = { mount, ready, reveal, paint: (bar, percent) => paintAll({ [bar]: { percent } }), state };
})();

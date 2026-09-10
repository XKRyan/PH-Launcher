(() => {
  'use strict';
  // Owns the startup overlay: the three bars reflect real work reported by the
  // main process (school data, mail service, page preloading). The app is only
  // revealed once they finish, so users never watch spinners inside the UI.
  const MIN_VISIBLE_MS = 900;
  const MAX_WAIT_MS = 25000;
  const startedAt = Number(window.__phSplashStartedAt) || Date.now();
  const state = { bars: {}, finished: false, revealed: false, timer: 0 };
  let onReveal = null;

  const fill = (bar) => document.querySelector(`.splash-bar-fill[data-bar="${bar}"]`);
  const label = (bar) => document.querySelector(`.splash-bar-row[data-bar="${bar}"] .splash-bar-label`);
  const hint = () => document.getElementById('splashHint');

  function paint(bar, percent, text) {
    const node = fill(bar);
    if (node) {
      node.style.width = `${Math.max(0, Math.min(100, percent))}%`;
      node.classList.toggle('is-done', percent >= 100);
    }
    if (text) {
      const nodeLabel = label(bar);
      if (nodeLabel) nodeLabel.textContent = text;
    }
  }

  function paintAll(bars) {
    for (const [bar, value] of Object.entries(bars || {})) {
      state.bars[bar] = value;
      paint(bar, value.percent, value.label);
    }
  }

  function allDone() {
    const bars = ['school', 'mail', 'preload'];
    return bars.every((bar) => (state.bars[bar]?.percent ?? 0) >= 100);
  }

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
    const elapsed = Date.now() - startedAt;
    const wait = Math.max(0, MIN_VISIBLE_MS - elapsed);
    clearTimeout(state.timer);
    state.timer = setTimeout(reveal, wait);
  }

  function noteHint() {
    const node = hint();
    if (!node) return;
    const pending = ['school', 'mail', 'preload'].filter((bar) => (state.bars[bar]?.percent ?? 0) < 100);
    const labels = { school: '学校数据', mail: '邮件服务', preload: '界面预载' };
    node.textContent = pending.length ? `正在${pending.map((bar) => labels[bar]).join('、')}…` : '准备就绪';
  }

  // The main process may have finished before this script ran, so ask once.
  async function syncInitialState() {
    try {
      const current = await window.ph?.system?.splashState?.();
      if (!current) return;
      paintAll(current.bars);
      state.finished = Boolean(current.finished);
      noteHint();
      if (state.finished) scheduleReveal();
    } catch { /* a missing bridge must not block the splash */ }
  }

  function mount() {
    if (state.mounted) return;
    state.mounted = true;
    window.ph?.system?.onSplashProgress?.((payload) => {
      if (!payload?.bar) return;
      state.bars[payload.bar] = { percent: payload.percent, label: payload.label };
      paint(payload.bar, payload.percent, payload.label);
      noteHint();
    });
    window.ph?.system?.onSplashDone?.((payload) => {
      paintAll(payload?.bars);
      state.finished = true;
      noteHint();
      scheduleReveal();
    });
    document.getElementById('splashSkip')?.addEventListener('click', reveal);
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
    else noteHint();
  }

  window.splashUI = { mount, ready, reveal, paint, state };
})();

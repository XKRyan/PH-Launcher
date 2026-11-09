/* ============================================================================
 * PH Launcher 账号界面的「外观 + 动效 + 跳过入口」增强层
 * ----------------------------------------------------------------------------
 * `src/account-ui.js` 是 PHL 与 PHL Lite **字节完全相同**的共享界面，不能为了
 * PHL 的视觉去改它（改了另一端就漂移，`scripts/test_account_ui.py` 会失败）。
 * 所以这个文件只做三件事，且全部在 PHL 侧：
 *
 *   1. 注入 PHL 的主题 CSS：象牙纸底 + 墨绿主色 + 金色点缀（跟随「外观」设置里的
 *      主色/纸张色变量），不再用共享界面的微软灰蓝；
 *   2. 补动画：卡片入场、屏幕切换、进度条生长/流光、当前步骤呼吸、完成打勾弹跳、
 *      按钮悬停；全部尊重 `prefers-reduced-motion`；
 *   3. 补「跳过」入口：登录/注册页加一个明显的「暂不登录，先使用」按钮，方向页加
 *      「先不同步，直接使用」——共享界面只在右上角有一个很小的「暂时跳过」，
 *      用户 2026-11-09 反馈"首次打开只能登录或注册"。
 *
 * 增强用 MutationObserver 跟着共享界面的重绘走：界面每次 renderFull 都会重建 DOM，
 * 这里等它重建完再补节点；共享文件一个字节都不改。
 * ========================================================================== */
(function () {
  'use strict';

  const STYLE_ID = 'phl-account-theme';
  const isEnglish = () => String(window.i18n?.locale?.() || '').toLowerCase().startsWith('en');

  const CSS = `
  /* ---------- 主题：跟 PHL 的象牙/墨绿一致 ---------- */
  .paui-root.paui-root {
    --paui-accent: var(--green-800) !important;
    --paui-card-bg: var(--ivory-50);
    --paui-card-border: var(--border);
    background:
      radial-gradient(1100px 620px at 12% -10%, rgba(181, 141, 69, .20), transparent 62%),
      radial-gradient(900px 600px at 100% 0%, rgba(31, 90, 70, .12), transparent 55%),
      linear-gradient(165deg, var(--ivory-100) 0%, var(--ivory-50) 48%, var(--green-50) 100%);
    color: var(--ink);
    font-family: inherit;
    -webkit-font-smoothing: antialiased;
  }
  .paui-root.paui-root .paui-top { padding: 18px 22px; align-items: center; }
  .paui-root.paui-root .paui-skip {
    border: 1px solid var(--border); border-radius: 999px; padding: 7px 15px;
    background: rgba(251, 250, 246, .72); color: var(--ink-3); font-size: 13px;
    backdrop-filter: blur(6px); transition: background .18s ease, color .18s ease, border-color .18s ease;
  }
  .paui-root.paui-root .paui-skip:hover { background: var(--ivory-50); color: var(--ink); border-color: rgba(31, 90, 70, .28); }
  .paui-root.paui-root .paui-body { padding-bottom: 72px; }
  .paui-root.paui-root .paui-body > * { animation: phl-screen-in .45s cubic-bezier(.22, .61, .36, 1) both; }

  .paui-root.paui-root .paui-card {
    width: min(470px, 100%);
    padding: 40px 40px 30px;
    border-radius: var(--radius-lg);
    background: rgba(255, 253, 248, .92);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-lg);
    backdrop-filter: blur(10px);
    position: relative;
    overflow: hidden;
    animation: phl-card-in .5s cubic-bezier(.22, .61, .36, 1) both;
  }
  .paui-root.paui-root .paui-card::before {
    content: ""; position: absolute; inset: 0 0 auto; height: 4px;
    background: linear-gradient(90deg, var(--green-800), var(--green-700) 45%, var(--gold-500));
    opacity: .92;
  }
  .paui-root.paui-root .paui-logo { margin-bottom: 20px; }
  .paui-root.paui-root .paui-logo-mark {
    width: 52px; height: 52px; border-radius: 16px;
    background: linear-gradient(140deg, var(--green-800), var(--green-950)) !important;
    color: var(--ivory-50); font-size: 18px; letter-spacing: .06em;
    box-shadow: 0 10px 26px rgba(16, 45, 37, .24), inset 0 1px 0 rgba(255, 255, 255, .18);
    animation: phl-logo-in .6s cubic-bezier(.22, .61, .36, 1) both;
  }
  .paui-root.paui-root .paui-title { font-size: 25px; font-weight: 700; letter-spacing: -.01em; color: var(--ink); margin-bottom: 6px; }
  .paui-root.paui-root .paui-sub { color: var(--ink-3); font-size: 13px; margin-bottom: 24px; }
  .paui-root.paui-root .paui-field { margin-bottom: 14px; }
  .paui-root.paui-root .paui-field label { color: var(--ink-2); font-size: 13px; margin-bottom: 6px; }
  .paui-root.paui-root .paui-input {
    height: 46px; padding: 0 14px; border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--ivory-50); color: var(--ink);
    transition: border-color .18s ease, box-shadow .18s ease, background .18s ease;
  }
  .paui-root.paui-root .paui-input:focus {
    border-color: var(--green-700);
    background: #fff; box-shadow: 0 0 0 4px rgba(31, 90, 70, .10);
  }
  .paui-root.paui-root .paui-primary {
    height: 46px; margin-top: 12px; border-radius: 12px;
    background: linear-gradient(180deg, var(--green-800), var(--green-900));
    box-shadow: 0 8px 20px rgba(23, 63, 51, .22);
    transition: transform .16s ease, box-shadow .16s ease, filter .16s ease;
  }
  .paui-root.paui-root .paui-primary:hover { transform: translateY(-1px); box-shadow: 0 12px 26px rgba(23, 63, 51, .28); filter: none; }
  .paui-root.paui-root .paui-primary:active { transform: translateY(0) scale(.995); }
  .paui-root.paui-root .paui-link-row { color: var(--ink-3); margin-top: 20px; }
  .paui-root.paui-root .paui-link { color: var(--green-700); font-weight: 600; }
  .paui-root.paui-root .paui-link:hover { color: var(--green-800); }

  /* ---------- 方向选择 ---------- */
  .paui-root.paui-root .paui-choices { gap: 12px; }
  .paui-root.paui-root .paui-choice {
    padding: 16px 18px; border-radius: 16px;
    border: 1px solid var(--border); background: var(--ivory-50);
    transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease, background .16s ease;
  }
  .paui-root.paui-root .paui-choice:hover {
    transform: translateY(-2px); border-color: rgba(31, 90, 70, .35);
    background: var(--green-50); box-shadow: var(--shadow-sm);
  }
  .paui-root.paui-root .paui-choice:active { transform: translateY(0); }
  .paui-root.paui-root .paui-choice b { font-size: 15px; color: var(--ink); }
  .paui-root.paui-root .paui-choice span { color: var(--ink-3); font-size: 13px; }
  .paui-root.paui-root .paui-choice .paui-count { color: var(--green-700); }

  /* ---------- 准备进度 ---------- */
  .paui-root.paui-root .paui-prep { width: min(600px, 100%); }
  .paui-root.paui-root .paui-prep h2 { font-size: 28px; font-weight: 700; letter-spacing: -.01em; margin-bottom: 10px; }
  .paui-root.paui-root .paui-prep .paui-prep-sub { color: var(--ink-2); font-size: 14px; margin-bottom: 24px; }
  .paui-root.paui-root .paui-bar {
    height: 7px; margin-bottom: 24px; border-radius: 999px;
    background: var(--ivory-200); position: relative; overflow: hidden;
    box-shadow: inset 0 1px 2px rgba(24, 35, 30, .06);
  }
  .paui-root.paui-root .paui-bar > i {
    position: relative; display: block; height: 100%; width: 0;
    background: linear-gradient(90deg, var(--green-800), var(--green-700) 55%, var(--gold-500));
    border-radius: inherit; transform-origin: left center;
    animation: phl-bar-grow .5s cubic-bezier(.22, .61, .36, 1) both;
    transition: width .4s cubic-bezier(.22, .61, .36, 1);
  }
  .paui-root.paui-root .paui-bar > i::after {
    content: ""; position: absolute; inset: 0;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, .55), transparent);
    animation: phl-bar-shimmer 1.8s ease-in-out infinite;
  }
  .paui-root.paui-root .paui-step {
    gap: 12px; padding: 9px 0; font-size: 14px; color: var(--ink-3);
    transition: color .2s ease;
  }
  .paui-root.paui-root .paui-step .paui-dot {
    width: 20px; height: 20px; border-width: 1.5px; border-color: var(--ivory-200);
    background: var(--ivory-50); color: #fff;
    transition: background .2s ease, border-color .2s ease, transform .2s ease;
  }
  .paui-root.paui-root .paui-step.active { color: var(--ink); font-weight: 600; }
  .paui-root.paui-root .paui-step.active .paui-dot {
    border-style: solid; border-color: var(--green-700); background: transparent;
    animation: paui-spin 1s linear infinite, phl-dot-pulse 1.6s ease-out infinite;
  }
  .paui-root.paui-root .paui-step.done { color: var(--ink-2); }
  .paui-root.paui-root .paui-step.done .paui-dot {
    background: var(--green-800); border-color: var(--green-800);
    animation: phl-dot-pop .32s cubic-bezier(.22, .61, .36, 1) both;
  }
  .paui-root.paui-root .paui-step.fail .paui-dot { background: var(--wine-700); border-color: var(--wine-700); }
  .paui-root.paui-root .paui-step .paui-detail { color: var(--ink-3); font-size: 12px; }
  .paui-root.paui-root .paui-done-row { margin-top: 26px; }
  .paui-root.paui-root .paui-done-row .paui-primary {
    height: 44px; min-width: 140px; margin: 0; animation: phl-screen-in .4s ease both;
  }
  .paui-root.paui-root .paui-msg { font-size: 13px; margin-top: 12px; }

  /* ---------- 明显的跳过入口（登录/注册 + 方向页） ---------- */
  .paui-root.paui-root .paui-skip-cta {
    display: block; width: 100%; margin: 14px 0 0; padding: 11px 16px;
    border: 1px solid var(--border); border-radius: 12px;
    background: rgba(251, 250, 246, .8); color: var(--ink-2);
    font: inherit; font-size: 13.5px; font-weight: 600; cursor: pointer;
    transition: background .18s ease, border-color .18s ease, color .18s ease, transform .16s ease;
  }
  .paui-root.paui-root .paui-skip-cta:hover {
    background: var(--ivory-50); border-color: rgba(31, 90, 70, .3); color: var(--ink);
    transform: translateY(-1px);
  }
  .paui-root.paui-root .paui-skip-direction {
    display: block; margin: 18px auto 0; padding: 6px 10px;
    border: 0; background: transparent; color: var(--ink-3);
    font: inherit; font-size: 13px; cursor: pointer; border-radius: 8px;
    transition: color .16s ease, background .16s ease;
  }
  .paui-root.paui-root .paui-skip-direction:hover { color: var(--green-700); background: var(--green-50); }

  /* ---------- 设置页里的账号卡片（同 PHL 卡片语言） ---------- */
  #accountCard .paui-account-card {
    --paui-accent: var(--green-800);
    padding: 18px; border-radius: var(--radius);
    border: 1px solid var(--border); background: var(--ivory-100);
    box-shadow: var(--shadow-sm);
    transition: box-shadow .18s ease, transform .18s ease;
  }
  #accountCard .paui-account-card:hover { box-shadow: var(--shadow-md); }
  #accountCard .paui-avatar {
    width: 58px; height: 58px; background: linear-gradient(140deg, var(--green-800), var(--green-950));
    box-shadow: 0 8px 18px rgba(16, 45, 37, .2);
  }
  #accountCard .paui-avatar.placeholder { background: var(--ivory-200); color: var(--ink-3); }
  #accountCard .paui-acc-name { font-size: 16px; color: var(--ink); }
  #accountCard .paui-acc-sub { color: var(--ink-3); }
  #accountCard .paui-chip {
    border: 1px solid var(--border); background: var(--ivory-50); color: var(--ink-2);
  }
  #accountCard .paui-chip.on { border-color: rgba(31, 90, 70, .25); background: var(--green-50); color: var(--green-800); }
  #accountCard .paui-btn-sm { border-radius: 10px; }
  #accountCard .paui-btn-sm.primary {
    background: linear-gradient(180deg, var(--green-800), var(--green-900));
    border-color: transparent; color: #fff;
  }
  #accountCard .paui-btn-sm.ghost { border: 1px solid var(--border); color: var(--ink-2); background: transparent; }

  /* ---------- 动效 ---------- */
  @keyframes phl-screen-in { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes phl-card-in { from { opacity: 0; transform: translateY(18px) scale(.985); } to { opacity: 1; transform: translateY(0) scale(1); } }
  @keyframes phl-logo-in { from { opacity: 0; transform: scale(.82) rotate(-6deg); } to { opacity: 1; transform: scale(1) rotate(0); } }
  @keyframes phl-bar-grow { from { transform: scaleX(.06); } to { transform: scaleX(1); } }
  @keyframes phl-bar-shimmer { 0% { transform: translateX(-110%); } 60%, 100% { transform: translateX(110%); } }
  @keyframes phl-dot-pulse { 0% { box-shadow: 0 0 0 0 rgba(31, 90, 70, .32); } 70% { box-shadow: 0 0 0 7px rgba(31, 90, 70, 0); } 100% { box-shadow: 0 0 0 0 rgba(31, 90, 70, 0); } }
  @keyframes phl-dot-pop { 0% { transform: scale(.35); } 65% { transform: scale(1.15); } 100% { transform: scale(1); } }

  @media (prefers-reduced-motion: reduce) {
    .paui-root.paui-root .paui-body > *,
    .paui-root.paui-root .paui-card,
    .paui-root.paui-root .paui-logo-mark,
    .paui-root.paui-root .paui-bar > i,
    .paui-root.paui-root .paui-step .paui-dot { animation: none !important; }
    .paui-root.paui-root .paui-bar > i::after { display: none; }
    .paui-root.paui-root .paui-choice,
    .paui-root.paui-root .paui-primary,
    .paui-root.paui-root .paui-skip-cta { transition: none !important; }
  }
  `;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  const english = () => (isEnglish() ? {
    skipCta: 'Not now — continue without signing in',
    skipDirection: 'Continue without syncing',
  } : {
    skipCta: '暂不登录，先使用',
    skipDirection: '先不同步，直接使用',
  });

  /** 给共享界面补节点；重复调用安全（已经补过就跳过）。 */
  function enhance() {
    const root = document.querySelector('.paui-root');
    if (!root || root.classList.contains('hidden')) return;
    root.classList.add('paui-phl');
    const screen = window.AccountUI?._state?.screen;
    const labels = english();
    if (screen === 'login' || screen === 'register') {
      const card = root.querySelector('.paui-card');
      if (card && !root.querySelector('.paui-skip-cta')) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'paui-skip-cta';
        button.textContent = labels.skipCta;
        button.addEventListener('click', () => {
          const skip = root.querySelector('.paui-skip');
          if (skip) skip.click();
          else window.AccountUI?.close?.();
        });
        const linkRow = root.querySelector('.paui-link-row');
        if (linkRow && linkRow.parentNode) linkRow.parentNode.insertBefore(button, linkRow);
        else card.appendChild(button);
      }
    } else if (screen === 'direction') {
      const card = root.querySelector('.paui-card');
      if (card && !root.querySelector('.paui-skip-direction')) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'paui-skip-direction';
        button.textContent = labels.skipDirection;
        button.addEventListener('click', () => window.AccountUI?.close?.());
        card.appendChild(button);
      }
    }
  }

  let scheduled = false;
  function scheduleEnhance() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      try { enhance(); } catch { /* 增强失败不能影响登录本身 */ }
    });
  }

  ensureStyle();
  document.addEventListener('DOMContentLoaded', () => {
    ensureStyle();
    scheduleEnhance();
  });
  if (document.body) {
    new MutationObserver(scheduleEnhance).observe(document.body, { childList: true, subtree: true });
    scheduleEnhance();
  }
})();

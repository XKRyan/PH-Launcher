const BASE = `
  :root {
    --ph-clean-mode: 1;
    --ph-green: #1f5a46;
    --ph-green-soft: #e8f0ec;
    --ph-gold: #c5a05a;
    --ph-ivory: #f6f3ea;
    --ph-paper: #fffdf8;
    --ph-ink: #18231e;
    --ph-muted: #66736d;
    --ph-border: rgba(31,90,70,.14);
    --ph-shadow: 0 10px 34px rgba(20,55,44,.09);
  }
  html, body, button, input, textarea, select {
    font-family: "Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", sans-serif !important;
  }
  html { background: var(--ph-ivory) !important; }
  body {
    color: var(--ph-ink) !important;
    background-color: var(--ph-ivory) !important;
    text-rendering: optimizeLegibility !important;
  }
  a { text-underline-offset: 2px !important; }
  input:not([type="checkbox"]):not([type="radio"]), textarea, select {
    border-radius: 10px !important;
    border-color: var(--ph-border) !important;
    box-shadow: none !important;
  }
  button, [role="button"], .btn, .button { border-radius: 10px !important; }
  table { border-collapse: separate !important; border-spacing: 0 !important; }
  [role="dialog"], .modal, [class*="modal-content" i], [class*="popover" i], [class*="dropdown-menu" i] {
    border-radius: 14px !important;
    border-color: var(--ph-border) !important;
    box-shadow: var(--ph-shadow) !important;
  }
  * { scrollbar-width: thin; scrollbar-color: rgba(31,90,70,.38) transparent; }
  *::-webkit-scrollbar { width: 10px; height: 10px; }
  *::-webkit-scrollbar-thumb { background: rgba(31,90,70,.3); border: 3px solid transparent; background-clip: padding-box; border-radius: 999px; }
  *::-webkit-scrollbar-thumb:hover { background: rgba(31,90,70,.5); border: 3px solid transparent; background-clip: padding-box; }
  input:focus-visible, textarea:focus-visible, select:focus-visible, button:focus-visible, a:focus-visible, [tabindex]:focus-visible {
    outline: 3px solid rgba(197,160,90,.5) !important;
    outline-offset: 2px !important;
  }
`;

const MAIL = `
  body { min-height: 100vh !important; background: radial-gradient(circle at 18% 12%, #edf3ef 0, transparent 36%), var(--ph-ivory) !important; }
  .toplinks, .goto, .gotoLink, [class*="download" i]:not(a), [class*="advert" i], [class*="promotion" i] { opacity: .72 !important; }
  .login-mod, .login-mod-form, .mod, [class*="loginbox" i], [class*="mail-card" i], [class*="panel" i] { border-radius: 18px !important; }
  .login-mod-form, [class*="loginbox" i], [class*="mail-card" i], [class*="panel" i] {
    background-color: rgba(255,253,248,.97) !important;
    box-shadow: var(--ph-shadow) !important;
    border: 1px solid var(--ph-border) !important;
  }
  .m-ipt, .ipt-t, input[type="text"], input[type="password"], input[type="email"] { border-radius: 10px !important; background: #fff !important; }
  .form-btn button, .form-btn a, button[type="submit"], input[type="submit"] { border-radius: 10px !important; }
  [class*="sidebar" i], [class*="leftbar" i], [class*="folder" i] { background-color: #edf2ee !important; }
  [class*="mail-list" i] > *, [class*="message-list" i] > *, [class*="list-item" i] { border-color: rgba(31,90,70,.09) !important; }
  [class*="toolbar" i], [class*="header" i] { box-shadow: none !important; border-color: var(--ph-border) !important; }
`;

const MAIL_LANDING = `
  .sec-part, .footer { display: none !important; }
`;

const MANAGEBAC = `
  body, .login-page { background: linear-gradient(145deg, #edf3ef 0%, var(--ph-ivory) 46%, #f7f0df 100%) !important; }
  .login-wrapper, .content-wrapper, .login-page form, [class*="login-card" i] { border-radius: 18px !important; }
  .login-wrapper, .login-page form, [class*="login-card" i] {
    background: rgba(255,253,248,.97) !important;
    border: 1px solid var(--ph-border) !important;
    box-shadow: var(--ph-shadow) !important;
  }
  .form-control,
  input:not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]),
  select,
  textarea { min-height: 39px !important; background-color: #fff !important; }
  .btn-primary, button[type="submit"], input[type="submit"] {
    min-height: 39px !important;
    color: #fff !important;
    background: var(--ph-green) !important;
    border-color: var(--ph-green) !important;
  }
  .card, [class*="card" i]:not([class*="discard" i]), [class*="panel" i], [class*="widget" i] {
    border-radius: 14px !important;
    border-color: var(--ph-border) !important;
    box-shadow: 0 5px 20px rgba(20,55,44,.055) !important;
  }
  [class*="sidebar" i], [class*="side-nav" i], [class*="sidenav" i] { background-color: #173f33 !important; }
  [class*="topbar" i], [class*="navbar" i], header { border-color: var(--ph-border) !important; box-shadow: 0 2px 14px rgba(20,55,44,.05) !important; }
  .table, table { background-color: rgba(255,255,255,.72) !important; }
  .table > :not(caption) > * > *, table td, table th { border-color: rgba(31,90,70,.1) !important; }
  .accordion-item { overflow: hidden !important; border-color: var(--ph-border) !important; }
`;

const EDUPAGE = `
  body { background: var(--ph-ivory) !important; }
  .erte-main, [class*="pageContent" i], [class*="content-wrapper" i] { max-width: 1240px !important; margin-inline: auto !important; }
  .erte-section-inner, .erte-cell, .erte-content, .gadget, [class*="gadget" i], [class*="widget" i] { border-radius: 15px !important; }
  .erte-section-inner, .gadget, [class*="gadget" i], [class*="widget" i] {
    border-color: var(--ph-border) !important;
    box-shadow: 0 7px 26px rgba(20,55,44,.07) !important;
  }
  .gadgetTitle, [class*="gadgetTitle" i], [class*="section-title" i] { color: var(--ph-green) !important; letter-spacing: .01em !important; }
  .erte-photos, [class*="gallery" i]:not([role="dialog"]), [class*="photo-slider" i] {
    border-radius: 15px !important;
    overflow: hidden !important;
    filter: saturate(.8) contrast(.96) !important;
  }
  [class*="edubar" i], [class*="topbar" i], header { border-color: var(--ph-border) !important; box-shadow: 0 2px 16px rgba(20,55,44,.06) !important; }
  [class*="skgd" i], [class*="timetable" i], [class*="schedule" i] { border-color: var(--ph-border) !important; }
  [class*="skgdCard" i], [class*="lesson-card" i], [class*="timetable-card" i], [data-subject] {
    border-radius: 10px !important;
    border-color: rgba(31,90,70,.18) !important;
    box-shadow: 0 3px 12px rgba(20,55,44,.08) !important;
  }
  button, input, select, textarea, .button, .asc-button { border-radius: 9px !important; }
  footer, .footer { opacity: .68 !important; }
`;

function getSiteCss(siteId, rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:') return '';
  const host = url.hostname.toLowerCase();
  if (siteId === 'mail') {
    if (host === 'mail.shphschool.com') return `${BASE}\n${MAIL}\n${MAIL_LANDING}`;
    if (host === 'qiye.163.com' || host.endsWith('.qiye.163.com') || host.endsWith('.mail.163.com')) return `${BASE}\n${MAIL}`;
    return '';
  }
  if (siteId === 'managebac') {
    if (host === 'managebac.cn' || host.endsWith('.managebac.cn')) return `${BASE}\n${MANAGEBAC}`;
    return '';
  }
  if (siteId === 'edupage') {
    if (host === 'edupage.org' || host.endsWith('.edupage.org')) return `${BASE}\n${EDUPAGE}`;
    return '';
  }
  return '';
}

module.exports = { getSiteCss };

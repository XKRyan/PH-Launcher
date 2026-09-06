(() => {
  'use strict';
  let language = 'zh-CN';
  let observer;
  let scheduled = false;
  const pending = new Set();
  const textSources = new WeakMap();
  const attributeSources = new WeakMap();
  const attributes = ['placeholder', 'title', 'aria-label', 'alt'];
  // Interface translation must never rewrite course data, messages or study content.
  const protectedContent = [
    'script', 'style', 'textarea', 'pre', 'code', '[contenteditable]', '[data-i18n-ignore]', '[translate="no"]',
    '.chat-bubble', '.mail-text', '.mail-sender', '.mail-row strong', '.mail-message h3', '.mail-message dd', '.mail-attachments button',
    '.note-list-item strong', '.note-list-item p', '.task-main > strong', '.task-subject', '.agenda-item strong',
    '.cal-event strong', '.cal-agenda-event strong', '.cal-agenda-event small',
    '.school-lesson:not(.school-lesson-cluster)', '.school-conflict-row', '.school-course-card h3', '.school-course-mark',
    '.school-lesson-detail', '.school-task-card h3', '.school-detail-body',
    '.vocab-meaning', '.vocab-question', '.vocab-own-example p', '.vocab-reading-text', '.vocab-context-hint',
    '.vocab-new-preview h3', '.vocab-study-card h3', '.vocab-library-row strong', '.vocab-library-row p',
    '.vocab-source', 'blockquote', '.dictionary-definition p', '.dictionary-word', '.dictionary-forms',
    '.vocab-word-main', '.vocab-expression-suggestion p', '.vocab-expression-suggestion small', '.agent-session-list button',
    '.command-item',
  ].join(',');
  function blocked(element) { return Boolean(element?.closest?.(protectedContent)); }
  function t(value) {
    const raw = String(value ?? '');
    if (language !== 'en') return raw;
    const key = raw.trim();
    if (!key || !/[\u3400-\u9fff]/.test(key)) return raw;
    let translated = window.PH_EN?.exact?.[key];
    if (translated === undefined) {
      for (const [pattern, replacement] of window.PH_EN?.patterns || []) {
        // Patterns only match complete interface phrases, never arbitrary substrings.
        if (!pattern.startsWith('^') || !pattern.endsWith('$')) continue;
        const re = new RegExp(pattern);
        if (re.test(key)) { translated = key.replace(re, replacement); break; }
      }
    }
    return translated === undefined ? raw : raw.slice(0, raw.indexOf(key)) + translated + raw.slice(raw.indexOf(key) + key.length);
  }
  function translateText(node) {
    if (blocked(node.parentElement)) return;
    const value = node.nodeValue;
    let entry = textSources.get(node);
    if (!entry || value !== entry.output) entry = { source: value, output: value };
    const output = t(entry.source);
    if (value !== output) node.nodeValue = output;
    entry.output = output;
    textSources.set(node, entry);
  }
  function translateElement(element) {
    if (blocked(element)) return;
    // Options without a value use their text as the submitted value. Keep it stable.
    if (element.tagName === 'OPTION' && !element.hasAttribute('value')) element.setAttribute('value', element.textContent);
    const entries = attributeSources.get(element) || {};
    for (const name of attributes) {
      if (!element.hasAttribute(name)) continue;
      const value = element.getAttribute(name);
      let entry = entries[name];
      if (!entry || value !== entry.output) entry = { source: value, output: value };
      const output = t(entry.source);
      if (output !== value) element.setAttribute(name, output);
      entry.output = output;
      entries[name] = entry;
    }
    attributeSources.set(element, entries);
  }
  function visit(node) {
    if (node.nodeType === 3) { translateText(node); return; }
    if (node.nodeType !== 1 && node.nodeType !== 9) return;
    if (node.nodeType === 1) {
      if (blocked(node)) return;
      translateElement(node);
    }
    for (const child of [...node.childNodes]) visit(child);
  }
  function observe() {
    observer?.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: attributes });
  }
  function flush() {
    scheduled = false;
    observer?.disconnect();
    for (const node of pending) if (node.isConnected) visit(node);
    pending.clear();
    observe();
  }
  function apply(value) {
    language = value === 'en' ? 'en' : 'zh-CN';
    document.documentElement.lang = language;
    observer?.disconnect();
    visit(document.body);
    observe();
    const select = document.getElementById('interfaceLanguage');
    if (select) select.value = language;
  }
  function mount(value) {
    if (!observer && window.MutationObserver) observer = new window.MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'childList') for (const node of record.addedNodes) pending.add(node);
        else pending.add(record.target);
      }
      if (!scheduled && pending.size) { scheduled = true; queueMicrotask(flush); }
    });
    apply(value);
  }
  function settings() {
    const host = document.querySelector('[data-settings-panel="general"]');
    if (!host || document.getElementById('interfaceLanguage')) return;
    const row = document.createElement('div');
    row.className = 'setting-row language-setting';
    row.innerHTML = '<div><strong>界面语言</strong><small>只切换界面，学习材料和个人内容保持原文。</small></div><select id="interfaceLanguage" aria-label="界面语言" translate="no"><option value="zh-CN">简体中文</option><option value="en">English</option></select>';
    host.prepend(row);
    const select = row.querySelector('select');
    select.value = language;
    select.addEventListener('change', async () => {
      const previous = language;
      select.disabled = true;
      try {
        const saved = await window.ph.settings.setLanguage(select.value);
        if (typeof state !== 'undefined' && state.data) state.data.settings.language = saved.language;
        apply(saved.language);
        if (typeof updateClock === 'function') updateClock();
        window.toast?.(t('界面语言已保存'));
      } catch { select.value = previous; window.toast?.(t('语言设置未保存，请重试'), 'error'); }
      finally { select.disabled = false; }
    });
  }
  window.i18n = { t, apply, mount, settings, locale: () => language };
})();

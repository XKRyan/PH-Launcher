(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const en = () => window.i18n?.locale() === 'en';
  const t = (zh, english) => en() ? english : zh;
  const api = () => window.ph?.vocabulary;
  const examples = new Map(), translations = new Map();
  let host, options, active, serial = 0, selectionVersion = 0, changing = false;
  const selected = () => options?.getSnapshot()?.settings?.advisorProvider || 'local';
  const label = provider => ({ local: t('本地 AI', 'Local AI'), api: 'API AI', off: 'Offline', offline: 'Offline' }[provider] || 'Offline');
  function indicator(source) {
    const advisor = options?.getSnapshot()?.advisor || {};
    const provider = selected();
    const actual = source || (advisor.lastAttempt?.ok && advisor.lastAttempt.provider === provider ? provider : 'offline');
    return `<span class="vocab-ai-status" translate="no"><span class="vocab-status-dot ${actual === 'offline' ? 'offline' : 'ready'}"></span>${esc(label(actual))}${actual !== provider && provider !== 'off' ? ` · ${esc(t('已选', 'Selected'))} ${esc(label(provider))}` : ''}</span>`;
  }
  function controls() {
    const provider = selected(), advisor = options?.getSnapshot()?.advisor || {};
    return `<div class="vocab-coach-controls" translate="no"><label>${t('背单词 AI', 'Vocabulary AI')} <select data-coach-provider aria-label="${t('背单词 AI 方式', 'Vocabulary AI provider')}">${[['local', label('local')], ['api', 'API AI'], ['off', 'Offline']].map(([value, name]) => `<option value="${value}"${value === provider ? ' selected' : ''}>${name}</option>`).join('')}</select></label><span class="vocab-coach-provider-status">${indicator()}</span>${provider === 'api' && !advisor.apiConsented ? `<div class="vocab-coach-consent"><p>${t('使用 API 会发送本次单词、例句和你填写的答案或造句，以及推荐所需的候选词和近期学习信号；可能产生费用。不发送整篇文章或学校数据。重启后需再次同意。', 'API requests send the current word, example and your answer or sentence, plus candidate words and recent learning signals for recommendations. Charges may apply. Full articles and school data are excluded. Consent is required again after restart.')}</p><p>${t('新加入且缺少例句的词会在后台请求造句；每次最多 40 词，每批 5 词，可能收费。', 'New words without examples request sentences in the background: up to 40 words, five per request. Charges may apply.')}</p><label><input type="checkbox" data-coach-consent> ${t('同意以上范围和可能的费用', 'I agree to this scope and possible charges')}</label><button type="button" class="secondary-button" data-coach-action="consent">${t('启用 API', 'Enable API')}</button></div>` : ''}</div>`;
  }
  function example(card, context) {
    if (!context) return '';
    const id = `example-${++serial}`;
    examples.set(id, { cardId: card.id, context });
    if (examples.size > 80) examples.delete(examples.keys().next().value);
    return `<div class="vocab-example" data-example-id="${id}"><blockquote class="vocab-example-text" lang="en" data-i18n-ignore>${esc(context)}</blockquote><small translate="no">${t('划选不认识的词，可查义并收入生词本。', 'Select an unfamiliar word to look it up and save it.')}</small><details data-coach-translation translate="no"><summary>${t('中文翻译', 'Chinese translation')}</summary><div data-coach-output role="status">${t('展开时使用所选 AI 翻译；可在上方切换。', 'Uses your selected AI when expanded; change it above.')}</div></details></div>`;
  }
  function answer(card, answerText, context) {
    const id = `answer-${++serial}`;
    examples.set(id, { cardId: card.id, context, answer: answerText });
    return `<div class="vocab-answer-coach" data-example-id="${id}" translate="no"><button type="button" class="secondary-button" data-coach-action="answer">${t('AI 分析我的答案', 'Explain my answer with AI')}</button><p>${t('分析拼写、词形和近义词；不会自动修改本次复习评分。', 'Checks spelling, word forms and synonyms without changing your review rating.')}</p><div data-coach-output role="status"></div></div>`;
  }
  function cancel() {
    if (active) {
      const task = active; active = null;
      if (task.panel?.isConnected) task.panel.textContent = t('已取消，可重新检查。', 'Canceled. You can try again.');
      api()?.cancelCoach?.({ requestId: task.id }).catch(() => {});
    }
  }
  function errorText(error) {
    const message = String(error?.message || '').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    if (/401|403/.test(message)) return t('API 验证失败，请检查 Key 和服务地址。', 'API authentication failed. Check your key and endpoint.');
    if (/429/.test(message)) return t('API 暂时限流或额度不足，请稍后再试。', 'The API is rate-limited or out of credit. Try again later.');
    if (/超时/.test(message)) return t('等待超时；可以继续离线学习，稍后再试。', 'Timed out. Continue offline and try again later.');
    if (/启用|配置|授权|选择|确认|地址|填写|同意/.test(message)) return t('所选 AI 尚未就绪：请检查 AI 设置，并在选择 API 后确认使用范围。', 'Your selected AI is not ready. Check AI settings and confirm the API consent scope.');
    return t('这次未能完成，请检查所选服务或稍后重试。你的内容仍保留。', 'Could not complete this request. Check the selected service or retry later. Your text is preserved.');
  }
  async function run(input, panel, valid = () => true) {
    cancel();
    if (selected() === 'off') { panel.textContent = t('当前为 Offline。请在上方选择本地 AI 或 API。', 'You are offline. Choose Local AI or API above.'); return; }
    const advisor = options.getSnapshot()?.advisor || {};
    if (selected() === 'api' && !advisor.apiConsented) { panel.textContent = t('请先勾选并确认 API 使用范围。', 'Please confirm the API consent scope first.'); return; }
    const task = { id: `coach-${Date.now()}-${++serial}`, panel, provider: selected() }; active = task;
    panel.textContent = task.provider === 'local' ? t('本地 AI 检查中；如未运行，将启动已安装的服务…', 'Checking with local AI; starting the installed service if needed…') : t('API 检查中…', 'Checking with API…');
    try {
      const result = await api().coach({ ...input, provider: task.provider, requestId: task.id });
      if (active !== task || !panel.isConnected || !valid() || result.canceled) return;
      return result;
    } catch (error) { if (active === task && panel.isConnected && valid()) panel.textContent = errorText(error); }
    finally { if (active === task) active = null; }
  }
  async function translate(details) {
    if (!details.open) { if (active?.panel === details.querySelector('[data-coach-output]')) cancel(); return; }
    const entry = examples.get(details.closest('[data-example-id]')?.dataset.exampleId);
    const panel = details.querySelector('[data-coach-output]');
    if (!entry || !panel) return;
    const key = JSON.stringify([selected(), entry.cardId, entry.context]);
    if (translations.has(key)) { panel.textContent = translations.get(key); return; }
    const result = await run({ kind: 'translation', cardId: entry.cardId, context: entry.context }, panel, () => details.open);
    if (result) {
      const text = `${result.translation}\n${label(result.source)} · ${t('AI 译文，请核对', 'AI translation; please verify')}`;
      translations.set(key, text); if (translations.size > 40) translations.delete(translations.keys().next().value);
      panel.textContent = text;
    }
  }
  async function checkExpression(card, button) {
    const form = host.querySelector('#vocabExpressionForm'), input = form?.querySelector('[name="ownExample"]');
    const panel = host.querySelector('#vocabExpressionAdvice'), sentence = input?.value || '';
    if (!sentence.trim()) { panel.textContent = t('先写下你的表达，再请求纠错。', 'Write your sentence first.'); return; }
    button.disabled = true;
    const result = await run({ kind: 'expression', cardId: card.id, expression: sentence }, panel, () => input.isConnected && input.value === sentence);
    if (result) {
      panel.innerHTML = `<section translate="no"><strong>${label(result.source)} · ${t('建议，请核对', 'Suggestion; please verify')}</strong><p lang="en" data-i18n-ignore>${esc(result.corrected)}</p><p data-i18n-ignore>${esc(result.notes)}</p><button type="button" class="secondary-button" data-coach-apply>${t('采用建议', 'Use suggestion')}</button></section>`;
      panel.querySelector('[data-coach-apply]').onclick = () => { if (input.value !== sentence) return; input.value = result.corrected; input.dispatchEvent(new Event('input', { bubbles: true })); panel.textContent = t('已采用建议；请点击“保存表达”完成保存。', 'Suggestion applied. Click Save expression to keep it.'); };
    }
    if (button.isConnected) button.disabled = false;
  }
  async function configure(provider, apiConsent = false) {
    cancel(); if (changing) return;
    changing = true;
    try {
      const result = await api().configureAdvisor({ provider, apiConsent });
      if (result?.snapshot) options.updateSnapshot(result.snapshot);
    } catch (error) { window.toast?.(errorText(error), 'error'); }
    finally { changing = false; updateControls(); }
  }
  function updateControls() {
    host?.querySelectorAll('.vocab-coach-controls').forEach(node => { node.outerHTML = controls(); });
    host?.querySelectorAll('[data-coach-translation] > summary').forEach(node => { node.textContent = t('中文翻译', 'Chinese translation'); });
    host?.querySelectorAll('.vocab-example > small').forEach(node => { node.textContent = t('划选不认识的词，可查义并收入生词本。', 'Select an unfamiliar word to look it up and save it.'); });
  }
  async function collectSelection(event) {
    const textHost = event.target.closest?.('.vocab-example-text');
    const selection = window.getSelection?.();
    if (!textHost || host.querySelector('dialog[open]') || !selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!textHost.contains(range.startContainer) || !textHost.contains(range.endContainer)) return;
    const word = String(selection.toString()).trim().replace(/\s+/g, ' ');
    if (!/^[A-Za-z]+(?:['’-][A-Za-z]+)*(?: [A-Za-z]+(?:['’-][A-Za-z]+)*){0,5}$/.test(word) || word.length > 100) return;
    const entry = examples.get(textHost.closest('[data-example-id]')?.dataset.exampleId); if (!entry) return;
    const request = ++selectionVersion;
    selection.removeAllRanges();
    options.openDialog(word, `<p data-selection-result translate="no">${t('正在查询离线词典…', 'Looking up the offline dictionary…')}</p>`, 'example-word');
    const panel = host.querySelector('[data-selection-result]');
    try {
      const found = (await window.ph.dictionary.lookup(word))?.exact;
      if (request !== selectionVersion || !panel?.isConnected) return;
      const meaning = found?.translation || found?.definition;
      const data = { word: found?.word || word, meaning: meaning || '', context: entry.context, subject: '例句生词', source: '背单词例句' };
      if (meaning) {
        const result = await api().add([data]);
        if (result?.snapshot) options.updateSnapshot(result.snapshot);
        if (!panel.isConnected) return;
        panel.innerHTML = `<span data-i18n-ignore>${esc(meaning)}</span><br>${t('已收入生词本，并保留原句。', 'Saved to your word book with the original sentence.')}`;
      } else {
        panel.innerHTML = `${t('离线词典没有完整匹配，可手动添加释义。', 'No exact offline entry. You can add the meaning yourself.')} <button class="secondary-button" type="button">${t('手动添加', 'Add manually')}</button>`;
        panel.querySelector('button').onclick = () => options.addDialog(data);
      }
    } catch { if (panel?.isConnected) panel.textContent = t('暂时无法查词，请稍后重试。', 'Lookup failed. Please try again.'); }
  }
  function init(config) {
    options = config; host = config.root;
    host.addEventListener('change', event => { if (event.target.matches('[data-coach-provider]')) configure(event.target.value); });
    host.addEventListener('input', event => { if (event.target.id === 'vocabOwnExample') cancel(); });
    host.addEventListener('toggle', event => { if (event.target.matches?.('[data-coach-translation]')) translate(event.target); }, true);
    host.addEventListener('mouseup', collectSelection);
    host.addEventListener('click', async event => {
      const button = event.target.closest?.('[data-coach-action]'); if (!button) return;
      if (button.dataset.coachAction === 'consent') { if (button.closest('.vocab-coach-controls').querySelector('[data-coach-consent]').checked) await configure('api', true); return; }
      if (button.dataset.coachAction === 'answer') {
        const wrap = button.closest('[data-example-id]'), entry = examples.get(wrap.dataset.exampleId); if (!entry) return;
        button.disabled = true;
        const result = await run({ ...entry, kind: 'answer' }, wrap.querySelector('[data-coach-output]'));
        if (result) wrap.querySelector('[data-coach-output]').textContent = `${label(result.source)} · ${t('AI 建议，请核对', 'AI suggestion; please verify')}\n${result.explanation}\n${result.suggestion}`;
        if (button.isConnected) button.disabled = false;
      }
    });
    host.querySelector('#vocabDialog')?.addEventListener('close', () => { selectionVersion++; cancel(); });
    window.addEventListener('ph:language-changed', () => { cancel(); updateControls(); });
  }
  window.PHVocabularyCoach = { init, controls, indicator, example, answer, checkExpression, cancel };
})();

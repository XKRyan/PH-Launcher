(() => {
  'use strict';

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const normal = (value) => String(value || '').normalize('NFKC').toLowerCase().replaceAll('’', "'").trim().replace(/\s+/g, ' ');
  const cloze = (sentence, word) => {
    const text = String(sentence || '');
    if (!word) return text;
    const pattern = new RegExp(`(?<![a-zA-Z])${String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-zA-Z])`, 'gi');
    return [...text.matchAll(pattern)].length === 1 ? text.replace(pattern, '_____') : text;
  };
  const modes = { mixed: '交替练习', context: '语境填空', meaning: '看词回忆', spelling: '释义拼写' };
  const ratings = { 1: '没记住', 2: '费力想起', 3: '记住了', 4: '很轻松' };
  const state = { root: null, snapshot: null, view: 'today', subject: '', search: '', filter: '', page: 0, busy: false,
    cardId: '', revealed: false, answer: '', completed: 0, feedback: '', candidates: [], dialogKind: '', request: 0,
    readingId: '', readingShowList: true, readingUnknown: new Set(), readingSeconds: 0, readingStart: 0, readingExpectedCount: 0, focused: true, readingWord: null,
    batchIds: [], batchPreviewIndex: 0, batchPhase: '', batchPreparing: false, batchRequestId: '', batchRequest: 0, batchNotice: '',
    placementAnswers: {}, expressionRequest: 0, expressionSuggestion: null, readerSelectionKey: '' };
  const api = () => window.ph?.vocabulary;
  const q = (selector) => state.root?.querySelector(selector);
  const card = () => state.snapshot?.cards.find((c) => c.id === state.snapshot.queueIds[0]);
  const number = (value) => Number(value || 0).toLocaleString('zh-CN');
  const icon = (name) => name === 'volume' ? '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4zM17 8a6 6 0 0 1 0 8M20 5a10 10 0 0 1 0 14"/></svg>' : `<svg width="18" height="18" aria-hidden="true"><use href="#i-${name === 'arrow-right' ? 'arrow' : name}"></use></svg>`;
  const option = (value, label, selected) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
  const notify = (message, error = false) => {
    if (typeof window.toast === 'function') window.toast(String(message), error ? 'error' : 'normal');
    const live = q('#vocabLive');
    if (live) { live.textContent = ''; requestAnimationFrame(() => { live.textContent = String(message); }); }
  };
  const dueText = (value) => {
    const delta = Date.parse(value) - Date.now();
    if (!Number.isFinite(delta)) return '待安排';
    if (delta < 60000) return '不到 1 分钟';
    if (delta < 3600000) return `${Math.round(delta / 60000)} 分钟`;
    if (delta < 86400000) return `${Math.round(delta / 3600000)} 小时`;
    return `${Math.round(delta / 86400000)} 天`;
  };
  const dateText = (value) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '未安排';
  const subjects = () => [...new Set((state.snapshot?.cards || []).map((c) => c.subject))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const subjectSelect = (id, label = '全部词本') => `<select id="${id}" aria-label="选择词本">${option('', label, state.subject)}${subjects().map((s) => option(s, s, state.subject)).join('')}</select>`;

  async function mount() {
    const root = document.getElementById('vocabularyPage');
    if (!root) return;
    if (state.root === root) return;
    state.root = root;
    root.classList.add('vocab-page');
    root.innerHTML = `<div class="vocab-shell"></div><div id="vocabLive" class="vocab-live" role="status" aria-live="polite"></div>
      <dialog id="vocabDialog" class="vocab-dialog" aria-labelledby="vocabDialogTitle"></dialog>`;
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    root.addEventListener('submit', onSubmit);
    root.addEventListener('mouseup', onReaderMouseUp);
    document.addEventListener('selectionchange', () => {
      const selection = window.getSelection?.();
      if (!selection || selection.isCollapsed) state.readerSelectionKey = '';
    });
    q('#vocabDialog').addEventListener('cancel', (event) => { if (state.busy) event.preventDefault(); });
    q('#vocabDialog').addEventListener('close', () => { state.dialogKind = ''; state.candidates = []; state.expressionRequest++; state.expressionSuggestion = null; });
    document.addEventListener('keydown', onKeydown, true);
    new MutationObserver(() => {
      if (!root.classList.contains('active')) {
        pauseReadingClock();
        q('#vocabDialog')?.close();
        window.speechSynthesis?.cancel();
      } else resumeReadingClock();
    }).observe(root, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('blur', () => { state.focused = false; pauseReadingClock(); });
    window.addEventListener('focus', () => { state.focused = true; resumeReadingClock(); });
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' ? pauseReadingClock() : resumeReadingClock());
    setInterval(() => { const timer = q('#vocabReadingTimer'); if (timer) timer.textContent = readingTime(); }, 1000);
    q('.vocab-shell').innerHTML = '<div class="vocab-empty"><h3>正在打开你的词本…</h3><p>单词和学习记录保存在这台电脑上。</p></div>';
  }

  async function refresh() {
    await mount();
    if (!state.root) return;
    const request = ++state.request;
    try {
      if (!api()) throw new Error('词汇功能暂时不可用，请重启 PH Launcher 后重试');
      const snapshot = await api().get(state.subject);
      if (request !== state.request) return;
      state.snapshot = snapshot;
      if (state.cardId !== snapshot.queueIds[0]) resetCard({ preserveBatch: state.batchPhase === 'preview' || state.batchIds.includes(snapshot.queueIds[0]) });
      render();
    } catch (error) {
      if (request !== state.request) return;
      if (!state.snapshot) q('.vocab-shell').innerHTML = `<div class="vocab-empty"><h3>词本暂时没能打开</h3><p>${esc(error.message)}</p><button class="primary-button" data-vocab-action="refresh">重试</button></div>`;
      else notify(error.message, true);
    }
  }

  function resetCard({ preserveBatch = false } = {}) {
    state.cardId = state.snapshot?.queueIds[0] || ''; state.revealed = false; state.answer = '';
    if (!preserveBatch) { state.batchIds = []; state.batchPreviewIndex = 0; state.batchPhase = ''; state.batchNotice = ''; }
  }
  const isNew = (current) => current?.schedule?.state === 0 && current.schedule.reps === 0;
  const queuedCard = (id) => state.snapshot?.cards.find((item) => item.id === id && state.snapshot.queueIds.includes(id));
  function beginNewBatch() {
    state.batchIds = state.snapshot.queueIds.map(queuedCard).filter(isNew).slice(0, 5).map((item) => item.id);
    state.batchPreviewIndex = 0;
    state.batchPhase = state.batchIds.length ? 'preview' : '';
  }
  function batchPreviewCard() {
    const current = card();
    if (!isNew(current)) return null;
    const valid = state.batchIds.filter((id) => isNew(queuedCard(id)));
    if (!valid.length || !valid.includes(current.id)) beginNewBatch();
    else {
      state.batchIds = valid;
      state.batchPreviewIndex = Math.min(state.batchPreviewIndex, valid.length - 1);
    }
    return state.snapshot.cards.find((item) => item.id === state.batchIds[state.batchPreviewIndex]) || null;
  }
  const previewContext = (current) => current?.context || current?.contexts?.[0] || current?.encounters?.[0]?.context || '';
  function practiceContext(current) {
    if (!current) return '';
    const contexts = [...new Set([current.context, ...(current.contexts || []), ...(current.encounters || []).map((entry) => entry.context)].filter((sentence) => sentence && cloze(sentence, current.word) !== sentence))];
    return contexts[(current.schedule.reps || 0) % Math.max(1, contexts.length)] || current.context || '';
  }
  function effectiveMode(current = card()) {
    const selected = state.snapshot?.settings.mode || 'mixed';
    const picked = selected === 'mixed' ? ['context', 'meaning', 'spelling'][(current?.schedule.reps || 0) % 3] : selected;
    const context = practiceContext(current);
    return picked === 'context' && (!context || cloze(context, current.word) === context) ? 'meaning' : picked;
  }

  function hasUsableContext(current = card()) {
    const context = practiceContext(current);
    return Boolean(context && cloze(context, current?.word) !== context);
  }

  function startOfflineBatch() {
    beginNewBatch();
    state.batchPreparing = false;
    state.batchRequestId = '';
  }

  async function prepareNewBatch() {
    const current = card();
    if (!isNew(current) || state.batchIds.length || state.batchPreparing) return false;
    if (typeof api()?.prepareBatch !== 'function') { startOfflineBatch(); render(); return true; }
    const request = ++state.batchRequest;
    const requestId = `vocab-batch-${Date.now()}-${request}`;
    state.batchPreparing = true;
    state.batchRequestId = requestId;
    state.batchNotice = '';
    render();
    try {
      const offline = state.snapshot?.settings?.advisorProvider === 'off';
      const response = await api().prepareBatch({ subject: state.subject, requestId, ...(offline ? { offline: true } : {}) });
      if (request !== state.batchRequest || state.batchRequestId !== requestId || state.view !== 'study') return false;
      if (response?.snapshot) state.snapshot = response.snapshot;
      const ids = Array.isArray(response?.batchIds) ? response.batchIds.filter((id) => isNew(queuedCard(id))).slice(0, 5) : [];
      if (ids.length) { state.batchIds = ids; state.batchPreviewIndex = 0; state.batchPhase = 'preview'; }
      else startOfflineBatch();
      state.batchNotice = response?.notice || (response?.source === 'offline' ? '本组按离线顺序开始。' : '');
      return true;
    } catch (error) {
      if (request !== state.batchRequest || state.batchRequestId !== requestId || state.view !== 'study') return false;
      startOfflineBatch();
      state.batchNotice = '推荐暂时不可用，本组按离线顺序开始。';
      return true;
    } finally {
      if (request === state.batchRequest) {
        state.batchPreparing = false;
        state.batchRequestId = '';
        render();
      }
    }
  }

  async function cancelBatchPreparation({ returnToToday = false, offline = false } = {}) {
    const requestId = state.batchRequestId;
    state.batchRequest++;
    state.batchPreparing = false;
    state.batchRequestId = '';
    if (offline) startOfflineBatch();
    if (returnToToday) { state.view = 'today'; resetCard(); }
    render();
    if (requestId && typeof api()?.cancelPrepareBatch === 'function') {
      try { await api().cancelPrepareBatch({ requestId }); } catch { /* a late result is ignored locally */ }
    }
  }

  async function mutate(operation, message, { renderResult = true } = {}) {
    if (state.busy) return null;
    state.busy = true;
    state.root.setAttribute('aria-busy', 'true');
    state.root.querySelectorAll('button:not([data-vocab-action="close"])').forEach((button) => { if (!button.disabled) { button.disabled = true; button.dataset.vocabBusy = 'true'; } });
    let response;
    try {
      response = await operation();
      if (response?.snapshot) {
        state.snapshot = response.snapshot;
        if (state.subject) state.snapshot = await api().get(state.subject);
        if (state.cardId !== state.snapshot.queueIds[0]) resetCard({ preserveBatch: state.batchPhase === 'preview' || state.batchIds.includes(state.snapshot.queueIds[0]) });
      }
      if (response?.canceled || response?.cancelled || response?.result?.canceled || response?.result?.cancelled) return response;
      if (message) notify(typeof message === 'function' ? message(response?.result ?? response) : message);
      return response || { result: {} };
    } catch (error) { notify(error.message || '操作没有完成，请重试', true); return null; }
    finally {
      state.busy = false;
      state.root.removeAttribute('aria-busy');
      state.root.querySelectorAll('[data-vocab-busy]').forEach((button) => { button.disabled = false; delete button.dataset.vocabBusy; });
      if (renderResult) render();
    }
  }

  function render() {
    if (!state.snapshot) return;
    q('.vocab-shell').innerHTML = `<header class="vocab-header vocab-simple-header">
      <div><span class="section-kicker">WORDS, ONE DAY AT A TIME</span><h2>背单词</h2><p>先完成今天该复习的，再慢慢积累新词。</p></div>
    </header>
    <div class="vocab-toolbar"><nav class="vocab-tabs" aria-label="词汇页面"><button data-vocab-action="today" class="${['today', 'study'].includes(state.view) ? 'selected' : ''}" aria-pressed="${['today', 'study'].includes(state.view)}">今日学习</button><button data-vocab-action="library" class="${state.view === 'library' ? 'selected' : ''}" aria-pressed="${state.view === 'library'}">我的词书 <span>${number(state.snapshot.stats.total)}</span></button><button data-vocab-action="tools" class="${state.view === 'tools' ? 'selected' : ''}" aria-pressed="${state.view === 'tools'}">更多工具</button></nav>
      <div class="vocab-actions"><span class="vocab-offline"><i></i> 离线可用</span><button class="ghost-button" data-vocab-action="settings">学习设置</button></div></div>
    <div class="vocab-content">${state.view === 'study' ? renderStudy() : state.view === 'library' ? renderLibrary() : state.view === 'reading' ? renderReading() : state.view === 'tools' ? renderTools() : renderToday()}</div>
    <footer class="vocab-footer">语境理解 · 主动回忆 · 间隔复习 <button data-vocab-action="method">怎么学更有效？</button></footer>`;
  }

  function renderToday() {
    const s = state.snapshot.stats;
    const study = state.snapshot.study || {};
    const settings = state.snapshot.settings || {};
    const level = settings.level || study.level || 'intermediate';
    const advisor = state.snapshot.advisor || {};
    const advisorProvider = settings.advisorProvider || advisor.provider || 'local';
    const showAdvisorIntro = !state.snapshot.cards.length && settings.advisorIntroSeen !== true && !advisor.localAvailable;
    const advisorIntro = showAdvisorIntro ? `<section class="vocab-advisor-intro"><div><span class="vocab-chip">可选功能</span><h3>先离线背词，也可以查看本地 AI 推荐</h3><p>本地 AI 可按难度推荐下一组、帮助补充例句，不按次收 API 调用费。它需要下载模型、占用磁盘和运行内存，首次使用会等待准备完成；电脑是否适合会先检测。API 服务商可能按量收费，以服务商说明为准。</p></div><div class="vocab-actions"><button class="primary-button" data-vocab-action="advisor-intro-ai">检测电脑并查看本地 AI 推荐</button><button class="secondary-button" data-vocab-action="advisor-intro-offline">先离线使用</button></div></section>` : '';
    const max = Math.max(1, ...(s.days || []).map((d) => d.count));
    const available = state.snapshot.queueIds.map((id) => state.snapshot.cards.find((item) => item.id === id)).filter(Boolean);
    const dueCount = available.filter((item) => !isNew(item)).length;
    const newCount = available.filter(isNew).length;
    const metrics = [['到期复习', dueCount, '按到期顺序优先完成'], ['可学新词', newCount, '受今日新词额度限制'], ['今日回忆', s.todayReviews, `${number(s.todayWords)} 个不同单词`]];
    const hasReviews = dueCount > 0;
    const hasNew = newCount > 0;
    const taskTitle = hasReviews ? '先完成今天到期的复习。' : hasNew ? '先认识今天这一小组新词。' : s.total ? '今天暂时没有待学词。' : '你的第一本生词本，从这里开始。';
    const taskText = hasReviews ? `有 ${number(dueCount)} 个到期词会先出现；新词会在复习后按小组预览。` : hasNew ? `这次会先看完最多 5 个新词的释义和例句，再统一做回忆。` : s.total ? (s.nextDue ? `下次复习 ${dateText(s.nextDue)}。` : '可到“我的词书”添加新词。') : '到“我的词书”添加词书，或把阅读中遇到的生词收进来。';
    const taskButton = hasReviews ? '开始复习' : hasNew ? '开始学新词' : '去我的词书';
    return `${advisorIntro}<div class="vocab-metrics">${metrics.map(([label, value, note]) => `<div><span>${label}</span><strong>${typeof value === 'number' ? number(value) : value}</strong><small>${note}</small></div>`).join('')}</div>
    <div class="vocab-today-grid"><section class="vocab-start-card"><span class="vocab-chip">今日主任务</span><h3>${taskTitle}</h3>
      <p>${taskText}</p>
      <label class="vocab-start-select"><span>这次想学</span>${subjectSelect('vocabStudySubject')}</label>
      <div class="vocab-study-options"><label><span>新词难度</span><select id="vocabLevel">${[['foundation', '基础'], ['intermediate', '中阶'], ['advanced', '进阶']].map(([value, label]) => option(value, label, level)).join('')}</select></label><button class="text-button" data-vocab-action="harder-level"${level === 'advanced' ? ' disabled' : ''}>太简单，换更难一组</button><small>${study.newAtLevel === 0 ? '当前难度没有新词，可找一本更高阶词书。' : `当前难度可学 ${number(study.newAtLevel || newCount)} 个新词`}</small></div>
      <div class="vocab-study-options vocab-advisor-options"><label><span>下一组推荐</span><select id="vocabAdvisorProvider">${[['local', '本地 AI'], ['api', 'API AI'], ['off', '关闭推荐']].map(([value, label]) => option(value, label, advisorProvider)).join('')}</select></label><button class="text-button" data-vocab-action="context-mode">用语境填空学</button><small>${esc(advisor.notice || (advisorProvider === 'off' ? '下一组按离线顺序开始。' : '只在开始一组新词时准备，不影响到期复习。'))}</small></div>
      <div class="vocab-start-bottom"><button class="primary-button" data-vocab-action="${state.snapshot.queueIds.length ? 'start' : 'library'}">${taskButton} <span aria-hidden="true">→</span></button><button class="secondary-button" data-vocab-action="library">找词书</button><span>${hasReviews && hasNew ? `复习后还有 ${number(newCount)} 个新词可学` : state.snapshot.queueIds.length ? `当前可学 ${number(state.snapshot.queueIds.length)} 个` : '词书、导入和阅读收词都在“我的词书”与“更多工具”中'}</span></div>
    </section><section class="vocab-week"><div class="vocab-section-heading"><h3>每一次回忆，都算数。</h3><small>最近 7 天 · 复习次数</small></div>
      <div class="vocab-bars" role="img" aria-label="${esc((s.days || []).map((d) => `${d.day}：${d.count} 次`).join('；'))}">${(s.days || []).map((d, i) => `<div class="${i === 6 ? 'today' : ''}"><span>${d.count}</span><div><i style="height:${Math.max(3, Math.round(d.count / max * 100))}%"></i></div><small>${i === 6 ? '今天' : d.day.slice(5).replace('-', '/')}</small></div>`).join('')}</div><p>一天没学也没关系，回来继续。</p></section></div>
    `;
  }

  function renderCatalog(starters) {
    const catalog = Array.isArray(state.snapshot.catalog) ? state.snapshot.catalog : [];
    const items = catalog.length ? catalog : starters.map((pack) => ({ id: `starter:${pack.subject || pack.name}`, name: pack.subject || pack.name, description: 'PH Launcher 原创例句词包。', count: pack.count, source: 'PH Launcher', license: '', levels: [] }));
    const placement = state.snapshot.placement || {};
    const ranked = [...items].sort((a, b) => Number(Boolean(b.levels?.includes(placement.level))) - Number(Boolean(a.levels?.includes(placement.level))));
    return `<section class="vocab-packs"><div class="vocab-section-heading"><div><span class="section-kicker">RECOMMENDED WORD BOOKS</span><h3>推荐词书</h3></div><button class="text-button" data-vocab-action="placement">${placement.level ? '调整起点' : '不知道从哪本开始？'}</button></div><p class="vocab-catalog-note">${placement.level ? `当前起点：${esc(levelLabel(placement.level))}。带“建议起点”的词书已排在前面；你随时可以换。` : '可先自己选，也可用 8 道小题获得起点建议。它不是词汇量测试。'}</p><div class="vocab-pack-grid">${ranked.map((pack, i) => { const suggested = placement.level && pack.levels?.includes(placement.level); const knownCount = Number.isFinite(Number(pack.count)) && Number(pack.count) > 0; const contextual = pack.id === 'ph-contexts'; return `<button class="vocab-pack pack-${i % 3}${contextual ? ' vocab-pack-context' : ''}" data-vocab-action="catalog-add" data-catalog-id="${esc(pack.id)}" data-subject="${esc(pack.subject || pack.name)}"><span>${contextual ? '语境填空' : suggested ? '建议起点' : String(i + 1).padStart(2, '0')}</span><strong>${esc(pack.name || pack.subject)}</strong><small>${knownCount ? `${number(pack.count)} 个词 · ` : ''}${esc(pack.description || '释义由本机 ECDICT 补全')}</small><b>加入词书 ＋</b></button>`; }).join('')}</div><p class="vocab-catalog-source">这些是内置离线参考词单，不是官方或版权方发布的词书；加入已有离线内容，无需下载。导入只合并新词，不会覆盖已有 FSRS 进度。</p></section>`;
  }
  const levelLabel = (level) => ({ foundation: '基础', intermediate: '中阶', advanced: '进阶' }[level] || '自定义');

  function renderTools() {
    return `<section class="vocab-tools"><h3>更多工具</h3><p>需要时再打开：阅读积累、手动收词、导入与导出都不会影响已有复习进度。</p><div class="vocab-tool-grid"><button class="vocab-tool" data-vocab-action="reading"><strong>阅读积累</strong><span>在完整文章里查词、保留语境。</span></button><button class="vocab-tool" data-vocab-action="add"><strong>添加单词</strong><span>把课堂、对话或兴趣内容收进词书。</span></button><button class="vocab-tool" data-vocab-action="import"><strong>导入与备份</strong><span>导入已有词表，或保存当前学习记录。</span></button></div></section>`;
  }

  function studyTopbar() {
    return `<div class="vocab-session-top"><button class="ghost-button" data-vocab-action="return-study">← 返回背单词</button><span>本轮 ${state.completed} 次回忆 · 当前还有 ${state.snapshot.queueIds.length} 个</span><label><span class="vocab-sr-only">练习方式</span><select id="vocabMode">${Object.entries(modes).map(([value, label]) => option(value, label, state.snapshot.settings.mode)).join('')}</select></label></div>`;
  }

  function renderStudy() {
    const current = card();
    const topbar = studyTopbar();
    if (state.batchPreparing) return `${topbar}<section class="vocab-session-empty vocab-batch-preparing"><span class="vocab-done-mark">…</span><h3>正在准备下一组新词</h3><p>最多等待 15 秒。你可以立刻按离线顺序开始，已到期复习不会被改变。</p><div class="vocab-actions"><button class="primary-button" data-vocab-action="start-offline-batch">先离线开始</button><button class="secondary-button" data-vocab-action="return-study">取消并返回</button></div></section>`;
    if (!current) return `${topbar}<section class="vocab-session-empty"><span class="vocab-done-mark">✓</span><h3>这一轮先到这里。</h3><p>${state.completed ? `本轮已完成 ${state.completed} 次回忆。` : '当前词本暂无可学词条。'}${state.snapshot.stats.nextDue ? ` 下次复习：${dateText(state.snapshot.stats.nextDue)}。` : '你可以继续阅读，遇到好词再收进来。'}</p><div class="vocab-actions"><button class="primary-button" data-vocab-action="today">回到今日学习</button><button class="secondary-button" data-vocab-action="refresh">检查到期词</button>${state.snapshot.undoAvailable ? '<button class="ghost-button" data-vocab-action="undo">撤销上一张</button>' : ''}</div></section>`;
    if (isNew(current) && state.batchPhase !== 'recall') {
      const preview = batchPreviewCard();
      if (!preview) return '';
      const position = state.batchPreviewIndex + 1;
      const isLast = position === state.batchIds.length;
      const context = previewContext(preview);
      return `${topbar}<article class="vocab-new-preview vocab-new-batch"><span class="vocab-chip">新词预览 · 第 ${position} / ${state.batchIds.length} 个</span><h3 lang="en">${esc(preview.word)}</h3>${preview.phonetic ? `<p class="vocab-phonetic">${esc(preview.phonetic)}</p>` : ''}<div class="vocab-meaning">${esc(preview.meaning)}</div>${context ? `<blockquote lang="en">${esc(context)}</blockquote>` : '<p class="vocab-hint">这词还没有完整例句；这次会用看词回忆练习。</p>'}<p class="vocab-hint">预览不记录掌握程度。小组只是练习节奏，不保证已经掌握。${state.batchNotice ? ` ${esc(state.batchNotice)}` : ''}</p><div class="vocab-actions"><button class="ghost-button" data-vocab-action="known-new" data-id="${esc(preview.id)}">我会这个词</button><button class="primary-button" data-vocab-action="${isLast ? 'start-batch-recall' : 'batch-next'}">${isLast ? '开始这一组回忆' : '下一个词 →'}</button></div></article>`;
    }
    const mode = effectiveMode(current);
    const context = practiceContext(current);
    const requestedMode = state.snapshot.settings.mode === 'mixed' ? ['context', 'meaning', 'spelling'][(current.schedule.reps || 0) % 3] : state.snapshot.settings.mode;
    const missingContext = requestedMode === 'context' && mode !== 'context';
    const typed = mode !== 'meaning';
    const correct = normal(state.answer) === normal(current.word);
    const prompt = mode === 'context' ? cloze(context, current.word) : mode === 'spelling' ? cloze(current.meaning, current.word) : current.word;
    return `${topbar}
      ${state.feedback ? `<p class="vocab-last-feedback" role="status">${esc(state.feedback)}</p>` : ''}
      <article class="vocab-study-card"><div class="vocab-study-meta"><span>${esc(current.subject)}</span><span>${current.schedule.state === 0 ? '新词' : '复习'} · ${missingContext ? '语境填空暂不可用' : modes[mode]}</span></div>
        <p class="vocab-prompt-instruction">${mode === 'context' ? '结合这句话，想起缺少的单词。' : mode === 'spelling' ? '看到释义，试着拼出英文。' : '先想想它的意思，以及你会怎样使用它。'}</p>
        <div class="vocab-question ${mode === 'meaning' ? 'word' : ''}" lang="${mode === 'spelling' ? 'zh-CN' : 'en'}">${esc(prompt)}</div>
        ${mode === 'meaning' && current.phonetic ? `<p class="vocab-phonetic">${esc(current.phonetic)}</p>` : ''}
        ${mode === 'meaning' && context ? `<p class="vocab-context-hint" lang="en">${esc(context)}</p>` : ''}
        ${missingContext ? '<p class="vocab-hint vocab-context-unavailable">这张卡没有可填空的完整例句；这次会用看词回忆练习。</p>' : ''}
        ${!state.revealed ? `${typed ? `<label class="vocab-answer-input"><span>你的答案</span><input id="vocabAnswer" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="100" value="${esc(state.answer)}" placeholder="输入单词，按 Enter 查看答案"></label>` : '<p class="vocab-hint">可以在心里回答，也可以先说出来。</p>'}<button class="primary-button vocab-reveal" data-vocab-action="reveal">查看答案 ${typed ? '' : '<kbd>空格</kbd>'}</button>` : `
          <section class="vocab-revealed" aria-label="答案与反馈"><div class="vocab-solution-top"><div><h3 lang="en">${esc(current.word)}</h3><span>${esc(current.phonetic)}</span></div><button class="secondary-button" data-vocab-action="speak" data-id="${esc(current.id)}">${icon('volume')} 离线发音</button></div>
          ${typed ? `<p class="vocab-check ${correct ? 'correct' : 'incorrect'}">${correct ? '✓ 拼写一致' : state.answer.trim() ? `这次还没拼对。你的答案：${esc(state.answer)}` : '这次没有填写答案，先看一遍，再回来回忆。'}</p>` : ''}
          <div class="vocab-meaning">${esc(current.meaning)}</div>${current.definition ? `<details><summary>英文释义</summary><p>${esc(current.definition)}</p></details>` : ''}
          ${context ? `<blockquote lang="en">${esc(context)}</blockquote>` : '<p class="vocab-hint">给它补一句你读过的原句，下次记得更具体。</p>'}
          ${current.source ? `<p class="vocab-source">来源：${esc(current.source)}</p>` : ''}
          ${current.ownExample ? `<div class="vocab-own-example"><span>我的表达 · 自行核对</span><p lang="en">${esc(current.ownExample)}</p></div>` : ''}
          ${(current.encounters || []).length ? `<p class="vocab-hint">已在 ${current.encounters.length} 篇不同阅读材料中再次遇见 · 不等于已掌握</p>` : ''}<button class="text-button" data-vocab-action="expression" data-id="${esc(current.id)}">${current.ownExample ? '编辑我的表达' : '写一句自己的表达'}</button></section>
          <div class="vocab-rating-heading"><span>${typed && !correct ? '拼写还没记住，选择一次短间隔重学。' : '按你这次真正的回忆情况选择。'}</span><small>预计下次出现</small></div>
          <div class="vocab-ratings">${[1, 2, 3, 4].map((rating) => `<button class="rating-${rating}" data-vocab-action="rate" data-rating="${rating}"${typed && !correct && rating > 1 ? ' disabled' : ''}><span><kbd>${rating}</kbd>${ratings[rating]}</span><small>${esc(dueText(state.snapshot.intervals[rating]))}</small></button>`).join('')}</div>`}
      </article><div class="vocab-session-foot"><span>先回忆，再揭晓；先理解，再练习。</span><button class="ghost-button" data-vocab-action="undo"${!state.snapshot.undoAvailable ? ' disabled' : ''}>↶ 撤销上一张</button></div>`;
  }

  function filteredCards() {
    const search = normal(state.search);
    return state.snapshot.cards.filter((c) => (!state.subject || c.subject === state.subject)
      && (!search || normal(`${c.word} ${c.meaning} ${c.context}`).includes(search))
      && (!state.filter || state.filter === 'difficult' && c.schedule.lapses >= 3 && !c.suspended
        || state.filter === 'suspended' && c.suspended || state.filter === 'new' && c.schedule.state === 0 && !c.suspended
        || state.filter === 'due' && !c.suspended && c.schedule.state !== 0 && Date.parse(c.schedule.due) <= Date.now()));
  }

  const readingTokens = (text) => String(text || '').match(/[a-zA-Z]+(?:['’-][a-zA-Z]+)*/g) || [];
  const readingSegments = (text) => String(text || '').match(/[^.!?\n]+[.!?]?|\n|[.!?]/g) || [];
  const readingEntry = () => state.snapshot?.readings?.find((reading) => reading.id === state.readingId);
  function pauseReadingClock() {
    if (state.readingStart) state.readingSeconds += Math.max(0, (Date.now() - state.readingStart) / 1000);
    state.readingStart = 0;
  }
  function resumeReadingClock() {
    if (!state.readingStart && state.readingId && !state.readingShowList && state.view === 'reading' && state.focused && state.root?.classList.contains('active') && document.visibilityState !== 'hidden') state.readingStart = Date.now();
  }
  function elapsedReading() { return Math.floor(state.readingSeconds + (state.readingStart ? Math.max(0, (Date.now() - state.readingStart) / 1000) : 0)); }
  function readingTime() { const seconds = elapsedReading(); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; }
  function openReading(id) {
    const reading = state.snapshot.readings?.find((item) => item.id === id);
    if (!reading) return;
    if (state.readingId === id) { state.view = 'reading'; state.readingShowList = false; resumeReadingClock(); render(); return; }
    pauseReadingClock(); state.view = 'reading'; state.readingId = id; state.readingShowList = false;
    state.readingExpectedCount = reading.readCount; state.readingUnknown = new Set(); state.readingSeconds = 0;
    resumeReadingClock(); render();
  }
  function readingWordMarkup(sentence, index) {
    return sentence.split(/([a-zA-Z]+(?:['’-][a-zA-Z]+)*)/g).map((token) => /^[a-zA-Z]+(?:['’-][a-zA-Z]+)*$/.test(token)
      ? `<button type="button" class="vocab-reader-word${state.readingUnknown.has(normal(token)) ? ' unfamiliar' : ''}" data-vocab-action="reading-word" data-word="${esc(token)}" data-sentence="${index}" aria-label="查询 ${esc(token)}">${esc(token)}</button>` : esc(token)).join('');
  }
  function renderReading() {
    const reading = state.readingShowList ? null : readingEntry();
    if (reading) {
      const tokens = readingTokens(reading.text);
      const markedCount = tokens.filter((token) => state.readingUnknown.has(normal(token))).length;
      const markedPercent = tokens.length ? Math.round(markedCount / tokens.length * 1000) / 10 : 0;
      return `<div class="vocab-reader-toolbar"><button class="ghost-button" data-vocab-action="reading-list">← 阅读书架</button><span><b id="vocabReadingTimer">${readingTime()}</b> 阅读用时</span><button class="primary-button" data-vocab-action="finish-reading">我已读完这篇</button></div>
      <div class="vocab-reader-layout"><article class="vocab-reader-paper"><span class="section-kicker">READ FOR THE MEANING</span><h3>${esc(reading.title)}</h3><div class="vocab-reader-meta">${number(reading.wordCount)} 个英文词次 · 已完整阅读 ${number(reading.readCount)} 次</div><div class="vocab-reader-text" lang="en">${readingSegments(reading.text).map((sentence, i) => readingWordMarkup(sentence, i)).join('')}</div></article>
      <aside class="vocab-reading-side"><span class="vocab-chip">不用急着记住每一个词</span><h4>先把故事读下去。</h4><p>遇到影响理解的词，点击它查意思、标为生词，或把原句收进词本。</p><div class="vocab-reading-marked"><strong>${state.readingUnknown.size}</strong><span>种单词被你标为不熟悉</span><small>在全文出现 ${number(markedCount)} 次 · 占 ${markedPercent}%</small></div><p class="vocab-hint">这个比例只统计你的标记，不自动判断你懂不懂，也不是词汇量或理解力测评。</p><p class="vocab-hint">如果经常被生词打断，换一篇更容易、也更有趣的材料。</p><button class="secondary-button" data-vocab-action="reading-collect">批量挑词收藏</button><small class="vocab-reader-clock-note">切换页面或离开窗口时暂停计时；阅读记录由你主动确认。</small></aside></div>`;
    }
    const stats = state.snapshot.readingStats || { todayWords: 0, todaySeconds: 0, totalWords: 0, days: [] };
    const readings = state.snapshot.readings || [];
    const max = Math.max(1, ...stats.days.map((day) => day.words));
    return `<div class="vocab-reading-intro"><div><span class="section-kicker">HALF A PAGE IS A START</span><h3>每天半页，也是一条长路。</h3><p>读自己感兴趣、能大致看懂的内容。收词和复习，为阅读服务。</p></div><button class="primary-button" data-vocab-action="add-reading">＋ 添加阅读</button></div>
      <div class="vocab-reading-overview"><div class="vocab-reading-numbers"><div><strong>${number(stats.todayWords)}</strong><span>今天确认读过的英文词次</span></div><div><strong>${Math.floor(stats.todaySeconds / 60)}<small> 分钟</small></strong><span>今天记录的阅读用时</span></div><div><strong>${number(stats.totalWords)}</strong><span>累计阅读词次，包含重读</span></div></div><div class="vocab-reading-week"><span>近 7 天阅读词次</span><div class="vocab-bars" role="img" aria-label="${esc(stats.days.map((day) => `${day.day}：${day.words} 词次`).join('；'))}">${stats.days.map((day, i) => `<div class="${i === 6 ? 'today' : ''}"><span>${number(day.words)}</span><div><i style="height:${Math.max(3, Math.round(day.words / max * 100))}%"></i></div><small>${i === 6 ? '今天' : day.day.slice(5).replace('-', '/')}</small></div>`).join('')}</div></div></div>
      <div class="vocab-section-heading"><h3>我的阅读书架</h3><small>只保存你有权使用的文章或片段</small></div>
      ${readings.length ? `<div class="vocab-reading-shelf">${readings.map((item) => `<article><div><span>${number(item.wordCount)} 词次 · ${item.readCount ? `已读 ${item.readCount} 次` : '还没读完过'}</span><h4>${esc(item.title)}</h4><p lang="en">${esc(item.text.slice(0, 145))}${item.text.length > 145 ? '…' : ''}</p></div><footer><button class="secondary-button" data-vocab-action="open-reading" data-id="${esc(item.id)}">${state.readingId === item.id ? '继续阅读' : '打开阅读'} →</button><button class="text-button vocab-danger" data-vocab-action="delete-reading" data-id="${esc(item.id)}" aria-label="删除阅读 ${esc(item.title)}">删除</button></footer></article>`).join('')}</div>` : '<div class="vocab-empty"><h3>先读一段你真正想读的内容。</h3><p>小说、科普、课堂材料都可以。无需上传文件或登录，粘贴一段就能开始。</p><button class="secondary-button" data-vocab-action="add-reading">添加第一篇阅读</button></div>'}
      <p class="vocab-reading-source-note">参考视频中的半页阅读、多次语境接触建议。“98% 已知词”和“12 次以上遇见”可作选材与坚持的参考，不是每个人的固定门槛，也不是掌握判定线。</p>`;
  }

  function addReadingDialog() {
    openDialog('保存一段想读的内容', `<form id="vocabReadingForm">${field('title', '标题', '', { required: true, max: 120, placeholder: '给这篇阅读起个名字' })}${field('text', '英文文章或片段', '', { required: true, area: true, max: 20000, rows: 10, placeholder: '粘贴你有权使用的英文材料，每篇最多 20000 字符。' })}<p class="vocab-hint">文章只保存在本机，不发送给 AI。读完后，你可以选择把阅读次数和遇见的单词记录下来。</p><div class="vocab-dialog-actions"><button type="button" class="ghost-button" data-vocab-action="close">取消</button><button class="primary-button" type="submit">保存并阅读</button></div></form>`, 'save-reading');
  }

  function selectedReaderPhrase(event) {
    const host = event.target.closest?.('.vocab-reader-text');
    const reading = readingEntry();
    const selection = window.getSelection?.();
    if (!host || !reading || !selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const within = (node) => host.contains(node?.nodeType === 1 ? node : node?.parentNode);
    if (!within(range.startContainer) || !within(range.endContainer)) return null;
    const phrase = String(selection.toString() || '').replace(/\s+/g, ' ').trim();
    const words = phrase.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || [];
    const phrasePattern = /^[A-Za-z]+(?:['’-][A-Za-z]+)*(?:\s+[A-Za-z]+(?:['’-][A-Za-z]+)*)*$/;
    if (!phrase || phrase.length > 100 || words.length < 1 || words.length > 6 || !phrasePattern.test(phrase)) return null;
    const context = readingSegments(reading.text).find((sentence) => normal(sentence).includes(normal(phrase))) || '';
    if (!context) return null;
    return { phrase, context };
  }

  function onReaderMouseUp(event) {
    if (state.dialogKind || state.busy || state.view !== 'reading' || state.readingShowList) return;
    const selected = selectedReaderPhrase(event);
    if (!selected) return;
    const key = `${state.readingId}|${normal(selected.phrase)}|${normal(selected.context)}`;
    if (key === state.readerSelectionKey) return;
    state.readerSelectionKey = key;
    window.getSelection?.()?.removeAllRanges?.();
    const segments = readingSegments(readingEntry()?.text || '');
    readingWordDialog(selected.phrase, segments.indexOf(selected.context), { autoSave: true, context: selected.context });
  }

  async function readingWordDialog(word, sentenceIndex, { autoSave = false, context: selectedContext = '' } = {}) {
    const reading = readingEntry(); if (!reading) return;
    const context = (selectedContext || readingSegments(reading.text)[sentenceIndex] || '').trim();
    state.readingWord = { word, context, subject: '阅读生词', source: reading.title };
    openDialog(word, '<p class="vocab-hint">正在查询本机词典…</p>', 'reading-word');
    try {
      const lookup = await window.ph.dictionary.lookup(word);
      if (state.dialogKind !== 'reading-word' || state.readingWord?.word !== word || state.readingId !== reading.id) return;
      const entry = lookup.exact;
      const meaning = entry?.translation || entry?.definition || '';
      state.readingWord = { ...state.readingWord, ...(entry ? { word: entry.word, meaning, phonetic: entry.phonetic, definition: entry.definition } : {}), markedWord: normal(word) };
      if (autoSave && entry?.word && meaning && typeof api()?.add === 'function') {
        const response = await api().add([{ word: entry.word, meaning, context, subject: '阅读生词', source: reading.title }]);
        if (state.dialogKind !== 'reading-word' || state.readingId !== reading.id) return;
        if (response?.snapshot) state.snapshot = response.snapshot;
        const result = response?.result || response || {};
        const added = Number(result.added || 0);
        const contextsAdded = Number(result.contextsAdded || 0);
        const saved = contextsAdded ? '已有词已补充原句。' : added ? '已加入词本。' : '已加入词本。';
        openDialog(entry.word, `<p class="vocab-phonetic">${esc(entry.phonetic)}</p><div class="vocab-meaning">${esc(meaning)}</div><p class="vocab-hint">${saved}</p><blockquote class="vocab-reader-quote" lang="en">${esc(context)}</blockquote><div class="vocab-dialog-actions"><button class="primary-button" data-vocab-action="close">继续阅读</button></div>`, 'reading-word');
        return;
      }
      openDialog(word, `${entry ? `<p class="vocab-phonetic">${esc(entry.phonetic)}</p><div class="vocab-meaning">${esc(meaning)}</div>` : '<p class="vocab-hint">离线词典没有匹配的完整词条。可以标记，或手动填写它的意思。</p>'}<blockquote class="vocab-reader-quote" lang="en">${esc(context)}</blockquote><div class="vocab-dialog-actions"><button class="secondary-button" data-vocab-action="mark-reading-word">${state.readingUnknown.has(normal(word)) ? '取消不熟悉标记' : '标为不熟悉'}</button><button class="primary-button" data-vocab-action="add-reading-word">保留原句并加入词本</button></div>`, 'reading-word');
    } catch (error) { if (state.dialogKind === 'reading-word') q('#vocabDialog').querySelector('.vocab-hint').textContent = `暂时无法查词：${error.message}`; }
  }

  function renderLibrary() {
    const packs = state.snapshot.packs || [];
    return `<section class="vocab-library-section"><div class="vocab-section-heading"><div><span class="section-kicker">MY WORD BOOKS</span><h3>我的词书</h3></div><button class="ghost-button" data-vocab-action="add">添加单词</button></div><div class="vocab-library-tools"><label class="vocab-search"><span class="vocab-sr-only">搜索单词、释义或原句</span><input id="vocabSearch" type="search" value="${esc(state.search)}" placeholder="搜索单词、释义或原句"></label>${subjectSelect('vocabLibrarySubject')}<select id="vocabFilter" aria-label="筛选词条">${[['', '全部状态'], ['due', '到期复习'], ['new', '还没学过'], ['difficult', '易忘词 · 失误 3 次以上'], ['suspended', '已暂停']].map(([value, label]) => option(value, label, state.filter)).join('')}</select><button class="ghost-button" data-vocab-action="export">导出词本</button></div><div id="vocabLibraryResults">${renderLibraryRows()}</div></section>${renderCatalog(Array.isArray(packs) ? packs : [])}`;
  }

  function renderLibraryRows() {
    const filtered = filteredCards();
    const totalPages = Math.max(1, Math.ceil(filtered.length / 30));
    state.page = Math.min(state.page, totalPages - 1);
    return `<p class="vocab-library-count">${number(filtered.length)} 个词条${state.filter === 'difficult' ? ' · 困难词适合先补充一条清楚的语境' : ''}</p>${!filtered.length ? '<div class="vocab-empty"><h3>这里还没有单词。</h3><p>换个筛选条件，或收进一个你想学会的词。</p><button class="secondary-button" data-vocab-action="add">添加单词</button></div>' : `<div class="vocab-word-list">${filtered.slice(state.page * 30, state.page * 30 + 30).map((c) => `<article class="vocab-word-row${c.suspended ? ' suspended' : ''}"><div class="vocab-word-main"><div><strong lang="en">${esc(c.word)}</strong><span>${esc(c.subject)}</span>${c.suspended ? '<em>已暂停</em>' : ''}</div><p>${esc(c.meaning)}</p>${c.context ? `<small lang="en">${esc(c.context)}</small>` : ''}</div><div class="vocab-word-status"><span>${c.suspended ? '暂不安排复习' : c.schedule.state === 0 ? '还没学过' : `下次 ${dateText(c.schedule.due)}`}</span><small>${number(c.schedule.reps)} 次回忆 · ${number(c.schedule.lapses)} 次遗忘</small></div><div class="vocab-word-actions"><button class="text-button" data-vocab-action="edit" data-id="${esc(c.id)}" aria-label="编辑 ${esc(c.word)}">编辑</button><button class="text-button" data-vocab-action="suspend" data-id="${esc(c.id)}">${c.suspended ? '恢复' : '暂停'}</button><button class="text-button vocab-danger" data-vocab-action="delete" data-id="${esc(c.id)}" aria-label="删除 ${esc(c.word)}">删除</button></div></article>`).join('')}</div>`}<div class="vocab-pagination"><span>第 ${state.page + 1} / ${totalPages} 页</span><button class="ghost-button" data-vocab-action="previous"${state.page === 0 ? ' disabled' : ''}>上一页</button><button class="ghost-button" data-vocab-action="next"${state.page + 1 >= totalPages ? ' disabled' : ''}>下一页</button></div>`;
  }

  function openDialog(title, content, kind) {
    const dialog = q('#vocabDialog');
    if (!dialog) return;
    state.dialogKind = kind;
    dialog.innerHTML = `<div class="vocab-dialog-head"><h3 id="vocabDialogTitle">${esc(title)}</h3><button type="button" data-vocab-action="close" aria-label="关闭">×</button></div>${content}`;
    if (!dialog.open) dialog.showModal();
  }

  function field(name, label, value = '', config = {}) {
    return `<label class="vocab-field"><span>${esc(label)}</span>${config.area ? `<textarea name="${name}" rows="${config.rows || 3}" maxlength="${config.max || 1600}"${config.required ? ' required' : ''} placeholder="${esc(config.placeholder || '')}">${esc(value)}</textarea>` : `<input name="${name}" value="${esc(value)}" maxlength="${config.max || 100}"${config.required ? ' required' : ''}${config.readonly ? ' readonly' : ''} placeholder="${esc(config.placeholder || '')}" autocomplete="off">`}</label>`;
  }

  function addDialog(entry = {}) {
    openDialog('收进一个值得记住的词', `<form id="vocabAddForm"><div class="vocab-lookup-row">${field('word', '单词或短语', entry.word, { required: true, placeholder: '例如 perspective' })}<button type="button" class="secondary-button" data-vocab-action="lookup">离线查词</button></div><p id="vocabLookupStatus" class="vocab-hint">可先查词，再把释义改成适合这条原句的意思。</p>
      ${field('meaning', '释义', entry.meaning || entry.translation || entry.definition, { area: true, required: true, max: 4000, rows: 2 })}
      ${field('context', '遇见它的那句话', entry.context, { area: true, placeholder: '保留完整英文原句，复习时可以用来填空。' })}
      <div class="vocab-field-grid">${field('subject', '放进哪个词本', entry.subject || state.subject || '我的生词', { required: true, max: 60 })}${field('source', '出处（选填）', entry.source, { max: 500, placeholder: '书名、文章标题或课堂笔记' })}</div>
      <input type="hidden" name="phonetic" value="${esc(entry.phonetic)}"><input type="hidden" name="definition" value="${esc(entry.definition)}">
      <div class="vocab-dialog-actions"><span>仅保存在这台电脑上</span><button type="button" class="ghost-button" data-vocab-action="close">取消</button><button class="primary-button" type="submit">加入词本</button></div></form>`, 'add');
  }

  function editDialog(current) {
    if (!current) return;
    openDialog(`让 ${current.word} 更贴近你`, `<form id="vocabEditForm"><input type="hidden" name="id" value="${esc(current.id)}">
      ${field('meaning', '这条原句中的意思', current.meaning, { area: true, required: true, max: 4000, rows: 2 })}
      ${field('context', '原句', current.context, { area: true })}<p class="vocab-hint">自己的表达单独保存，避免修改词条资料时误覆盖草稿。</p><button type="button" class="secondary-button" data-vocab-action="expression" data-id="${esc(current.id)}">编辑我的表达</button>
      ${field('subject', '词本', current.subject, { required: true, max: 60 })}<div class="vocab-dialog-actions"><button type="button" class="ghost-button" data-vocab-action="close">取消</button><button class="primary-button" type="submit">保存</button></div></form>`, 'edit');
  }

  function expressionDialog(current) {
    if (!current) return;
    state.expressionRequest++;
    state.expressionSuggestion = null;
    openDialog(`${current.word} · 我的表达`, `<form id="vocabExpressionForm"><input type="hidden" name="id" value="${esc(current.id)}">
      <label class="vocab-field"><span>我的表达</span><textarea id="vocabOwnExample" name="ownExample" rows="5" maxlength="1600" placeholder="用 ${esc(current.word)} 说一件与你有关的事。">${esc(current.ownExample)}</textarea></label>
      <div class="vocab-expression-ai"><div><strong>本地 AI 纠错</strong><p>仅在你点击时使用已配置的本地模型；表达不会上传。AI 建议可能出错，请自己核对。</p></div><button type="button" class="secondary-button" data-vocab-action="check-expression" data-id="${esc(current.id)}">本地 AI 纠错</button></div>
      <div id="vocabExpressionAdvice" class="vocab-expression-advice" role="status" aria-live="polite"></div>
      <div class="vocab-dialog-actions"><button type="button" class="ghost-button" data-vocab-action="close">取消</button><button class="primary-button" type="submit">保存表达</button></div></form>`, 'expression');
  }

  function expressionAdvice(message, error = false, suggestion = null) {
    const panel = q('#vocabExpressionAdvice');
    if (!panel) return;
    if (!suggestion) { panel.innerHTML = `<p class="vocab-hint${error ? ' vocab-expression-error' : ''}">${esc(message)}</p>`; return; }
    panel.innerHTML = `<section class="vocab-expression-suggestion"><span>本地 AI 建议 · 可能有误，请核对</span><p lang="en">${esc(suggestion.corrected)}</p><small>${esc(suggestion.notes)}</small><button type="button" class="secondary-button" data-vocab-action="apply-expression-advice">采用建议</button></section>`;
  }

  async function checkExpression(current, button) {
    const form = q('#vocabExpressionForm');
    const expressionInput = form?.querySelector('[name="ownExample"]');
    const sentence = expressionInput?.value || '';
    if (!sentence.trim()) { expressionAdvice('先写下你的表达，再请求纠错。', true); expressionInput?.focus(); return; }
    if (typeof api().checkExpression !== 'function') { expressionAdvice('本地 AI 纠错暂不可用。请重启 PH Launcher 后在 AI 学习助手中配置本地模型。', true); return; }
    const request = ++state.expressionRequest;
    button.disabled = true;
    expressionAdvice('正在请求你已配置的本地 AI…');
    try {
      const response = await api().checkExpression({ word: current.word, sentence });
      if (request !== state.expressionRequest || state.dialogKind !== 'expression' || q('#vocabExpressionForm') !== form) return;
      const suggestion = response?.result || response;
      if (!suggestion || typeof suggestion.corrected !== 'string' || typeof suggestion.notes !== 'string') throw new Error('本地 AI 返回格式无效');
      state.expressionSuggestion = { cardId: current.id, corrected: suggestion.corrected };
      expressionAdvice('', false, suggestion);
    } catch (error) {
      if (request !== state.expressionRequest || state.dialogKind !== 'expression' || q('#vocabExpressionForm') !== form) return;
      const message = error?.message === '请先启用本地 AI'
        ? '尚未配置本地 AI；可前往 AI 学习助手完成本地模型设置。'
        : error?.message || '本地 AI 纠错暂时不可用；你的表达仍保留在这里。';
      const panel = q('#vocabExpressionAdvice');
      if (error?.message === '请先启用本地 AI' && panel) panel.innerHTML = `<p class="vocab-hint vocab-expression-error">${esc(message)} <button type="button" class="text-button" data-vocab-action="ai-settings">前往 AI 设置</button></p>`;
      else expressionAdvice(message, true);
    } finally {
      if (request === state.expressionRequest && q('#vocabExpressionForm') === form) button.disabled = false;
    }
  }

  function importDialog(kind = 'text') {
    state.candidates = [];
    openDialog('把你的词和阅读带进来', `<div class="vocab-import-tabs"><button class="${kind === 'text' ? 'selected' : ''}" data-vocab-action="import-text-tab">已有词表</button><button class="${kind === 'paragraph' ? 'selected' : ''}" data-vocab-action="paragraph">英文阅读</button><button data-vocab-action="import-json">导入备份 JSON</button></div>
      ${kind === 'text' ? `<form id="vocabImportForm">${field('text', '每行一个词，缺少释义时会查询离线词典', '', { area: true, rows: 9, max: 500000, required: true, placeholder: 'perspective\nevidence\n\n也可从表格粘贴，以 Tab 分隔：\n单词 → 释义 → 原句 → 词本' })}<p class="vocab-hint">每次最多 1000 行。重复单词会跳过，不覆盖已有记录；请只导入你有权使用的内容。</p><div class="vocab-dialog-actions"><button type="button" class="ghost-button" data-vocab-action="close">取消</button><button class="primary-button" type="submit">导入词表</button></div></form>` : `<form id="vocabExtractForm">${field('text', '粘贴一段你正在读的英文', '', { area: true, rows: 7, max: 20000, required: true, placeholder: '从感兴趣的内容开始。你挑选的词会保留所在原句。' })}<div class="vocab-dialog-actions"><span>本机处理，不发送给 AI</span><button class="primary-button" type="submit">找出可以收藏的词</button></div></form><div id="vocabCandidates"></div>`}`, kind === 'text' ? 'import' : 'paragraph');
  }

  function settingsDialog() {
    const settings = state.snapshot.settings;
    openDialog('找到适合自己的学习节奏', `<form id="vocabSettingsForm"><label class="vocab-field"><span>每天最多学几个新词？</span><input name="dailyNewLimit" type="number" min="0" max="100" step="1" value="${settings.dailyNewLimit}" required></label><p class="vocab-hint">0 表示只复习，不引入新词；已到期的词始终优先。</p>
      <label class="vocab-field"><span>希望保持的记忆程度</span><select name="retention">${[[0.8, '80% · 较轻的复习量'], [0.85, '85% · 适度复习'], [0.9, '90% · 推荐'], [0.95, '95% · 更多复习']].map(([value, label]) => option(value, label, settings.retention)).join('')}</select></label><p class="vocab-hint">这是排期目标，不是实际成绩承诺。目标越高，通常需要越频繁地复习。</p>
      <label class="vocab-field"><span>默认练习方式</span><select name="mode">${Object.entries(modes).map(([value, label]) => option(value, label, settings.mode)).join('')}</select></label><div class="vocab-dialog-actions"><button type="button" class="ghost-button" data-vocab-action="close">取消</button><button class="primary-button" type="submit">保存设置</button></div></form>`, 'settings');
  }

  async function setAdvisor(provider, apiConsent = false) {
    if (typeof api()?.configureAdvisor === 'function') return mutate(() => api().configureAdvisor(apiConsent ? { provider, apiConsent: true } : { provider }), '下一组推荐设置已保存');
    return mutate(() => api().configure({ advisorProvider: provider }), '下一组推荐设置已保存');
  }

  function advisorApiConsentDialog() {
    openDialog('允许 API 推荐下一组？', `<div class="vocab-advisor-consent"><p>只有开始一组新词时，才会发送允许使用的学习记录给你配置的 API 服务商，以推荐下一组。服务商可能按量收费，收费方式以服务商说明为准。</p><label class="risk-check"><input id="vocabAdvisorApiConsent" type="checkbox"><span>我理解学习记录会发送给 API 服务商，并同意仅用于推荐下一组新词。</span></label><div class="vocab-dialog-actions"><button class="ghost-button" data-vocab-action="close">取消</button><button class="primary-button" data-vocab-action="confirm-advisor-api">同意并使用 API</button></div></div>`, 'advisor-api-consent');
  }

  async function markAdvisorIntroSeen() {
    if (state.snapshot?.settings?.advisorIntroSeen === true || typeof api()?.configure !== 'function') return;
    try {
      const response = await api().configure({ advisorIntroSeen: true });
      if (response?.snapshot) state.snapshot = response.snapshot;
      else if (state.snapshot?.settings) state.snapshot.settings.advisorIntroSeen = true;
    } catch { /* the introduction remains available if saving fails */ }
  }

  function placementDialog() {
    const current = state.snapshot.placement || {};
    openDialog('选一个背词起点', `<div class="vocab-placement"><p class="vocab-dialog-description">这是为了帮你挑第一本词书的粗略建议，不是标准化英语成绩，也不会估算你的词汇量。</p><form id="vocabPlacementSelfForm"><label class="vocab-field"><span>我想从这里开始</span><select name="level"><option value="">让我按成绩或默认建议</option>${[['foundation', '基础：先建立常用词与阅读信心'], ['intermediate', '中阶：巩固高中与学术阅读词'], ['advanced', '进阶：扩展高频阅读与表达词']].map(([value, label]) => `<option value="${value}"${current.level === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label><div class="vocab-field-grid"><label class="vocab-field"><span>已有考试成绩（选填）</span><select name="exam"><option value="">不提供</option><option value="toefl-legacy">TOEFL iBT 旧版总分（0–120）</option><option value="toefl-current">TOEFL iBT 2026 总分（1–6，0.5 分档）</option><option value="ielts">IELTS 总分（0–9，0.5 分档）</option></select></label><label class="vocab-field"><span>分数（选填）</span><input name="score" type="number" min="0" max="120" step="0.5" placeholder="只用于起点建议"></label></div><div class="vocab-dialog-actions"><button type="button" class="ghost-button" data-vocab-action="placement-quiz">做 8 道小题再选</button><button class="primary-button" type="submit">使用这个起点</button></div></form></div>`, 'placement');
  }

  function placementQuizDialog() {
    const questions = state.snapshot.placement?.questions || [];
    if (!questions.length) return notify('起点小题暂时不可用，请直接选择适合自己的难度', true);
    state.placementAnswers = {};
    openDialog('8 道起点小题', `<form id="vocabPlacementQuizForm"><p class="vocab-dialog-description">请凭第一反应作答；可以随时退出，结果只用于建议第一本词书。</p><div class="vocab-placement-questions">${questions.map((question, index) => `<fieldset><legend>${index + 1}. <span lang="en">${esc(question.prompt)}</span></legend>${question.choices.map((choice, choiceIndex) => `<label><input type="radio" name="${esc(question.id)}" value="${choiceIndex}" required> ${esc(choice)}</label>`).join('')}</fieldset>`).join('')}</div><div class="vocab-dialog-actions"><button type="button" class="ghost-button" data-vocab-action="placement">返回自己选择</button><button class="primary-button" type="submit">查看建议</button></div></form>`, 'placement-quiz');
  }

  function placementResultDialog(result = {}) {
    const score = Number.isInteger(result.score) && Number.isInteger(result.total) ? `<span class="vocab-chip">${number(result.score)} / ${number(result.total)} 题答对</span>` : '';
    openDialog('你的起点建议', `<div class="vocab-placement-result">${score}<h4>建议先从「${esc(levelLabel(result.recommendedLevel))}」开始。</h4><p>${esc(result.note || '这只是起点建议，不是标准化英语成绩或词汇量测量。')}</p><div class="vocab-dialog-actions"><button class="ghost-button" data-vocab-action="placement">改成其他难度</button><button class="primary-button" data-vocab-action="close">查看词书</button></div></div>`, 'placement-result');
  }

  async function submitPlacement(input) {
    if (typeof api()?.placementSubmit !== 'function') return notify('起点建议暂时不可用，请先直接选择一本词书', true);
    const response = await mutate(() => api().placementSubmit(input));
    if (response) placementResultDialog(response.result || {});
  }

  function methodDialog() {
    openDialog('理解它，也试着把它想起来', `<div class="vocab-method"><ol><li><strong>先读懂一句话。</strong><p>保留遇到单词的原句，理解它在这里的意思。材料太难时，换一段更容易的。</p></li><li><strong>遮住答案，自己回忆。</strong><p>觉得眼熟不一定能用。尝试解释词义、填写空缺，或根据意思拼出它。</p></li><li><strong>核对，然后诚实评分。</strong><p>没有想起来就选“没记住”。先看清答案，下次会早一点再遇见。</p></li><li><strong>隔一段时间，再见一面。</strong><p>按到期提醒复习，同时继续阅读。新语境和自己的表达让这个词越来越具体。</p></li></ol><p>练习并不保证永久记忆；自评也不是标准化词汇测试。记住多少，应通过之后真正的回忆和使用来判断。</p><details><summary>方法与来源</summary><p>主动回忆：Karpicke 与 Roediger，Science，2008；间隔复习：Cepeda 等，Psychological Science，2008；变化语境中的回忆：Butowska-Buczyńska 等，PNAS，2024。</p><p>视频推荐：罗肖尼Shawney《如何永远学会一个单词？》。可进一步了解语境学习；完整视频观点不等同于本应用的全部设计。</p></details><div class="vocab-dialog-actions"><button class="primary-button" data-vocab-action="close">开始实践</button></div></div>`, 'method');
  }

  async function speak(current) {
    if (!current || !window.speechSynthesis) return notify('这台电脑暂时没有可用的离线朗读功能', true);
    const localEnglish = () => window.speechSynthesis.getVoices().find((v) => v.localService === true && /^en(?:[-_]|$)/i.test(v.lang));
    let voice = localEnglish();
    if (!voice && !window.speechSynthesis.getVoices().length) {
      await new Promise((resolve) => {
        const ready = () => { clearTimeout(timeout); window.speechSynthesis.removeEventListener('voiceschanged', ready); resolve(); };
        const timeout = setTimeout(ready, 800);
        window.speechSynthesis.addEventListener('voiceschanged', ready);
      });
      voice = localEnglish();
    }
    if (!voice) return notify('没有找到本机英语声音，请先在系统设置中安装离线英语语音包', true);
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(current.word);
    utterance.voice = voice; utterance.lang = voice.lang; utterance.rate = 0.88;
    utterance.onerror = () => notify('离线发音未能播放，可检查系统语音设置', true);
    window.speechSynthesis.speak(utterance);
  }

  async function onClick(event) {
    const button = event.target.closest('[data-vocab-action]');
    if (!button || !state.root.contains(button) || button.disabled) return;
    const action = button.dataset.vocabAction;
    if (state.busy && action !== 'close') return;
    const current = state.snapshot?.cards.find((c) => c.id === button.dataset.id);
    if (action === 'close') { if (!state.busy) q('#vocabDialog').close(); return; }
    if (action === 'ai-settings') { q('#vocabDialog').close(); if (typeof window.navigate === 'function') window.navigate('ai'); else notify('请在 AI 学习助手中配置本地模型', true); return; }
    if (action === 'expression' && current) return expressionDialog(current);
    if (action === 'check-expression' && current) return checkExpression(current, button);
    if (action === 'apply-expression-advice') {
      const form = q('#vocabExpressionForm');
      const suggestion = state.expressionSuggestion;
      const expressionInput = form?.querySelector('[name="ownExample"]');
      const id = form?.querySelector('[name="id"]')?.value;
      if (!form || !expressionInput || !suggestion || suggestion.cardId !== id) return;
      expressionInput.value = suggestion.corrected;
      state.expressionRequest++;
      state.expressionSuggestion = null;
      expressionAdvice('已采用建议；点击“保存表达”后才会写入词条。');
      expressionInput.focus();
      return;
    }
    if (action === 'refresh') return refresh();
    if (action === 'advisor-intro-ai') {
      await markAdvisorIntroSeen();
      if (typeof window.navigate === 'function') window.navigate('ai');
      setTimeout(() => {
        if (typeof window.beginAiEditing === 'function') window.beginAiEditing();
        else document.getElementById('aiEditConfig')?.click();
      }, 0);
      return;
    }
    if (action === 'advisor-intro-offline') { await markAdvisorIntroSeen(); render(); return; }
    if (action === 'confirm-advisor-api') {
      if (!q('#vocabAdvisorApiConsent')?.checked) return notify('请先确认 API 上传学习记录的范围', true);
      const result = await setAdvisor('api', true);
      if (result) q('#vocabDialog').close();
      return;
    }
    if (action === 'harder-level') {
      const currentLevel = state.snapshot.settings?.level || state.snapshot.study?.level || 'intermediate';
      const next = { foundation: 'intermediate', intermediate: 'advanced' }[currentLevel];
      if (!next) return notify('已经是进阶难度；可到“找词书”加入更高阶词书。');
      return mutate(() => api().configure({ level: next }), '下一组新词已换为更高难度；已预览的词不会变化');
    }
    if (action === 'context-mode') {
      const result = await mutate(() => api().configure({ mode: 'context' }), '已选择语境填空；请加入“原创语境词书”开始。');
      if (result) { state.view = 'library'; render(); }
      return;
    }
    if (action === 'return-study') return cancelBatchPreparation({ returnToToday: true });
    if (action === 'start-offline-batch') return cancelBatchPreparation({ offline: true });
    if (action === 'today' || action === 'library' || action === 'reading' || action === 'tools') { if (action !== 'today') await markAdvisorIntroSeen(); pauseReadingClock(); state.view = action; resumeReadingClock(); render(); return; }
    if (action === 'add-reading') return addReadingDialog();
    if (action === 'open-reading') return openReading(button.dataset.id);
    if (action === 'reading-list') { pauseReadingClock(); state.readingShowList = true; render(); return; }
    if (action === 'reading-word') return readingWordDialog(button.dataset.word, Number(button.dataset.sentence));
    if (action === 'mark-reading-word' && state.readingWord) {
      const key = state.readingWord.markedWord || normal(state.readingWord.word);
      if (state.readingUnknown.has(key)) state.readingUnknown.delete(key); else state.readingUnknown.add(key);
      q('#vocabDialog').close(); render(); return;
    }
    if (action === 'add-reading-word' && state.readingWord) {
      state.readingUnknown.add(state.readingWord.markedWord || normal(state.readingWord.word));
      render(); addDialog(state.readingWord); return;
    }
    if (action === 'reading-collect') {
      const reading = readingEntry(); if (!reading) return;
      importDialog('paragraph'); const form = q('#vocabExtractForm'); form.elements.text.value = reading.text; form.requestSubmit(); return;
    }
    if (action === 'finish-reading') {
      const reading = readingEntry(); if (!reading) return;
      openDialog('把这次阅读记下来？', `<p class="vocab-dialog-description">确认你已读完《${esc(reading.title)}》的这段内容。将记录 ${number(reading.wordCount)} 个英文词次和当前用时，并为词本中再次遇见的单词保留语境。</p><p class="vocab-hint">记录读过，不代表全部掌握。如果只读了一部分，可以继续阅读，暂不记录。</p><div class="vocab-dialog-actions"><button class="ghost-button" data-vocab-action="close">继续阅读</button><button class="primary-button" data-vocab-action="confirm-finish-reading">确认已完整读过</button></div>`, 'finish-reading'); return;
    }
    if (action === 'confirm-finish-reading') {
      const reading = readingEntry(); if (!reading) return;
      pauseReadingClock();
      const result = await mutate(() => api().finishReading({ id: reading.id, unknownWords: [...state.readingUnknown], seconds: elapsedReading(), expectedReadCount: state.readingExpectedCount }), (r) => `已记录 ${number(r.words)} 词次阅读，${number(r.encounters)} 个词获得新的阅读语境`);
      if (result) { state.readingId = ''; state.readingShowList = true; q('#vocabDialog').close(); render(); } else resumeReadingClock();
      return;
    }
    if (action === 'delete-reading') {
      const reading = state.snapshot.readings?.find((item) => item.id === button.dataset.id); if (!reading) return;
      openDialog(`删除阅读《${reading.title}》？`, `<p class="vocab-dialog-description">这篇文章和对应的阅读记录会被删除。已经收藏的词条不会删除。此操作不能撤销，想保留副本可先导出词本备份。</p><div class="vocab-dialog-actions"><button class="ghost-button" data-vocab-action="close">保留</button><button class="primary-button vocab-danger-button" data-vocab-action="confirm-delete-reading" data-id="${esc(reading.id)}">删除文章与记录</button></div>`, 'delete-reading'); return;
    }
    if (action === 'confirm-delete-reading') {
      const id = button.dataset.id;
      const result = await mutate(() => api().removeReading(id), '已删除文章和对应阅读记录，已收藏词条仍然保留');
      if (result) { if (state.readingId === id) { pauseReadingClock(); state.readingId = ''; state.readingShowList = true; } q('#vocabDialog').close(); render(); }
      return;
    }
    if (action === 'start') {
      await markAdvisorIntroSeen();
      state.view = 'study'; state.completed = 0; state.feedback = ''; resetCard();
      if (isNew(card())) { await prepareNewBatch(); q('#vocabAnswer')?.focus(); return; }
      render(); q('#vocabAnswer')?.focus(); return;
    }
    if (action === 'batch-next') { state.batchPreviewIndex = Math.min(state.batchPreviewIndex + 1, state.batchIds.length - 1); render(); return; }
    if (action === 'start-batch-recall') { state.batchPhase = 'recall'; state.revealed = false; state.answer = ''; render(); q('#vocabAnswer')?.focus(); return; }
    if (action === 'known-new') {
      const id = button.dataset.id;
      state.batchIds = state.batchIds.filter((item) => item !== id);
      state.batchPreviewIndex = Math.min(state.batchPreviewIndex, Math.max(0, state.batchIds.length - 1));
      const result = await mutate(() => api().update({ id, suspended: true, known: true }), '已跳过这个词；它仍保留在“我的词书”的“已暂停”中，可随时恢复', { renderResult: false });
      if (!result || !state.batchIds.length) {
        resetCard();
        if (isNew(card())) await prepareNewBatch(); else render();
      } else render();
      return;
    }
    if (action === 'add') return addDialog();
    if (action === 'edit') return editDialog(current);
    if (action === 'settings') return settingsDialog();
    if (action === 'method') return methodDialog();
    if (action === 'import' || action === 'import-text-tab') return importDialog('text');
    if (action === 'paragraph') return importDialog('paragraph');
    if (action === 'previous' || action === 'next') { state.page += action === 'next' ? 1 : -1; q('#vocabLibraryResults').innerHTML = renderLibraryRows(); return; }
    if (action === 'reveal') {
      if (!card() || state.revealed) return;
      state.answer = q('#vocabAnswer')?.value || state.answer;
      state.revealed = true; render(); q('[data-vocab-action="rate"][data-rating="1"]')?.focus(); return;
    }
    if (action === 'rate') {
      const learningCard = card(); const rating = Number(button.dataset.rating); const mode = effectiveMode(learningCard);
      if (!learningCard || !state.revealed || mode !== 'meaning' && normal(state.answer) !== normal(learningCard.word) && rating !== 1) return;
      const result = await mutate(() => api().review({ id: learningCard.id, rating, expectedReps: learningCard.schedule.reps, mode, subject: state.subject }), null, { renderResult: false });
      if (result) {
        state.completed++; state.feedback = `${learningCard.word} · ${ratings[rating]} · 下次 ${dateText(result.result.nextDue)}`;
        resetCard({ preserveBatch: state.batchPhase === 'recall' && state.batchIds.includes(state.snapshot.queueIds[0]) });
        if (isNew(card()) && !state.batchIds.length) await prepareNewBatch(); else render();
        q('#vocabAnswer')?.focus();
      } else render();
      return;
    }
    if (action === 'undo') { const result = await mutate(() => api().undo(), (r) => `已撤销 ${r.word || ''} 的上次复习`); if (result) { state.completed = Math.max(0, state.completed - 1); state.feedback = ''; resetCard(); render(); } return; }
    if (action === 'pack') return mutate(() => api().addStarter(button.dataset.subject), addedMessage);
    if (action === 'placement') return placementDialog();
    if (action === 'placement-quiz') return placementQuizDialog();
    if (action === 'catalog-add') {
      const item = (state.snapshot.catalog || []).find((entry) => entry.id === button.dataset.catalogId) || { id: button.dataset.catalogId, name: button.dataset.subject, count: 36, source: 'PH Launcher', license: '' };
      openDialog(`加入「${item.name}」？`, `<p class="vocab-dialog-description">将最多导入 ${number(Math.min(500, Number(item.count) || 500))} 个词。${item.source ? `来源：${esc(item.source)}。` : ''}${item.license ? `许可：${esc(item.license)}。` : ''}</p><p class="vocab-hint">只添加尚未在词书中的词；已有词条及 FSRS 复习进度不会被覆盖。</p><div class="vocab-dialog-actions"><button class="ghost-button" data-vocab-action="close">取消</button><button class="primary-button" data-vocab-action="confirm-catalog-add" data-catalog-id="${esc(item.id)}" data-subject="${esc(button.dataset.subject)}">加入词书</button></div>`, 'catalog'); return;
    }
    if (action === 'confirm-catalog-add') {
      const id = button.dataset.catalogId;
      const result = id.startsWith('starter:') ? await mutate(() => api().addStarter(button.dataset.subject), addedMessage) : await mutate(() => api().catalogWords(id, 500), addedMessage);
      if (result) {
        if (id === 'ph-contexts') await mutate(() => api().configure({ mode: 'context' }), '已选择语境填空练习');
        q('#vocabDialog').close();
      }
      return;
    }
    if (action === 'suspend' && current) return mutate(() => api().update({ id: current.id, suspended: !current.suspended }), current.suspended ? '已恢复复习' : '已暂停，词条和记录仍然保留');
    if (action === 'delete' && current) {
      openDialog(`删除 ${current.word}？`, `<p class="vocab-dialog-description">这个词和它的复习记录都会从当前词本移除，不能撤销。只想暂时不学，可以选择“暂停”。</p><div class="vocab-dialog-actions"><button class="ghost-button" data-vocab-action="close">保留</button><button class="primary-button vocab-danger-button" data-vocab-action="confirm-delete" data-id="${esc(current.id)}">删除词条与记录</button></div>`, 'delete'); return;
    }
    if (action === 'confirm-delete' && current) { const result = await mutate(() => api().remove(current.id), '已删除词条和对应复习记录'); if (result) q('#vocabDialog').close(); return; }
    if (action === 'speak') return speak(current);
    if (action === 'export') return mutate(() => api().exportFile(), '词本导出已完成，请妥善保存包含原句与学习记录的文件');
    if (action === 'import-json') { const result = await mutate(() => api().importFile(), addedMessage); if (result && !(result.canceled || result.cancelled || result.result?.canceled || result.result?.cancelled)) q('#vocabDialog').close(); return; }
    if (action === 'lookup') {
      const form = q('#vocabAddForm'); const word = form.elements.word.value.trim();
      if (!word) { form.elements.word.focus(); return; }
      button.disabled = true;
      try {
        const result = await window.ph.dictionary.lookup(word);
        if (q('#vocabAddForm') !== form || normal(form.elements.word.value) !== normal(word)) return;
        if (!result.exact) { q('#vocabLookupStatus').textContent = '没有查到完整词条，你仍可以手动填写释义。'; return; }
        const entry = result.exact;
        form.elements.word.value = entry.word;
        form.elements.meaning.value = entry.translation || entry.definition || '';
        form.elements.phonetic.value = entry.phonetic || '';
        form.elements.definition.value = entry.definition || '';
        q('#vocabLookupStatus').textContent = '已查到。可以精简成当前语境的意思，再保存。';
      } catch (error) { notify(error.message, true); } finally { button.disabled = false; }
      return;
    }
    if (action === 'save-candidates') {
      const selected = [...q('#vocabCandidates').querySelectorAll('input:checked')].map((input) => state.candidates[Number(input.value)]).filter(Boolean);
      if (!selected.length) return notify('先勾选你想留下的单词');
      const result = await mutate(() => api().add(selected), addedMessage);
      if (result) q('#vocabDialog').close();
    }
  }

  function addedMessage(result) {
    const summary = result || {};
    return `已加入 ${number(summary.added)} 个词${summary.duplicates ? `，跳过 ${number(summary.duplicates)} 个重复词` : ''}${summary.invalid ? `，${number(summary.invalid)} 条缺少有效单词或释义` : ''}`;
  }

  function onInput(event) {
    if (event.target.id === 'vocabAnswer') state.answer = event.target.value;
    if (event.target.id === 'vocabOwnExample') {
      state.expressionRequest++;
      state.expressionSuggestion = null;
      const advice = q('#vocabExpressionAdvice');
      if (advice?.textContent.trim()) expressionAdvice('草稿已改动；如需要可再次请求本地 AI 纠错。');
    }
    if (event.target.id === 'vocabSearch') { state.search = event.target.value; state.page = 0; q('#vocabLibraryResults').innerHTML = renderLibraryRows(); }
  }

  async function onChange(event) {
    if (['vocabStudySubject', 'vocabLibrarySubject'].includes(event.target.id)) { state.subject = event.target.value; state.page = 0; await refresh(); }
    if (event.target.id === 'vocabFilter') { state.filter = event.target.value; state.page = 0; q('#vocabLibraryResults').innerHTML = renderLibraryRows(); }
    if (event.target.id === 'vocabMode') { await mutate(() => api().configure({ mode: event.target.value })); resetCard(); render(); }
    if (event.target.id === 'vocabLevel') { await mutate(() => api().configure({ level: event.target.value }), '下一组新词难度已保存；已预览的词不会变化'); }
    if (event.target.id === 'vocabAdvisorProvider') {
      if (event.target.value === 'api') { advisorApiConsentDialog(); render(); }
      else await setAdvisor(event.target.value);
    }
  }

  async function onSubmit(event) {
    const form = event.target;
    if (!form.id.startsWith('vocab')) return;
    event.preventDefault();
    if (state.busy || !form.reportValidity()) return;
    const values = Object.fromEntries(new FormData(form));
    let result;
    if (form.id === 'vocabAddForm') result = await mutate(() => api().add([values]), addedMessage);
    if (form.id === 'vocabEditForm') result = await mutate(() => api().update(values), '已保存原句与自己的表达');
    if (form.id === 'vocabExpressionForm') result = await mutate(() => api().update({ id: values.id, ownExample: values.ownExample }), '已保存我的表达');
    if (form.id === 'vocabSettingsForm') result = await mutate(() => api().configure({ dailyNewLimit: Number(values.dailyNewLimit), retention: Number(values.retention), mode: values.mode }), '学习设置已保存');
    if (form.id === 'vocabImportForm') result = await mutate(() => api().importText(values.text), addedMessage);
    if (form.id === 'vocabPlacementSelfForm') { await submitPlacement({ level: values.level, exam: values.exam, score: values.score }); return; }
    if (form.id === 'vocabPlacementQuizForm') {
      const answers = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Number(value)]));
      await submitPlacement({ answers }); return;
    }
    if (form.id === 'vocabReadingForm') {
      result = await mutate(() => api().saveReading({ title: values.title, text: values.text }), (r) => r.duplicate ? '书架中已有这篇文章，已为你打开' : '已保存到阅读书架');
      if (result) { q('#vocabDialog').close(); openReading(result.result.id); }
      return;
    }
    if (form.id === 'vocabExtractForm') {
      const response = await mutate(() => api().extract(values.text));
      if (!response || state.dialogKind !== 'paragraph') return;
      state.candidates = Array.isArray(response) ? response : response.candidates || response.result?.candidates || (Array.isArray(response.result) ? response.result : []);
      q('#vocabCandidates').innerHTML = `<h4>挑选你真正想学的词</h4><p class="vocab-hint">只展示离线词典能匹配的部分词条，不是对你词汇量的测评。</p>${state.candidates.length ? `<div class="vocab-candidate-list">${state.candidates.map((c, i) => `<label><input type="checkbox" value="${i}"${c.saved ? ' disabled' : ''}><span><strong lang="en">${esc(c.word)}</strong>${c.saved ? '<em>已在词本</em>' : ''}<small>${esc(c.meaning)}</small><p lang="en">${esc(c.context)}</p></span></label>`).join('')}</div><div class="vocab-dialog-actions"><button class="primary-button" data-vocab-action="save-candidates">收藏选中的单词</button></div>` : '<p class="vocab-hint">没有找到可用词条，可改用“添加单词”手动收词。</p>'}`;
      return;
    }
    if (result) q('#vocabDialog').close();
  }

  function onKeydown(event) {
    if (!state.root?.classList.contains('active') || state.busy || document.querySelector('dialog[open]') || state.view !== 'study' || event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.isComposing) return;
    const editing = event.target.closest('input, textarea, select, [contenteditable="true"]');
    if (editing) {
      if (event.target.id === 'vocabAnswer' && event.key === 'Enter' && !state.revealed) { event.preventDefault(); event.stopImmediatePropagation(); q('[data-vocab-action="reveal"]')?.click(); }
      return;
    }
    if (event.key === ' ' && !state.revealed) { event.preventDefault(); event.stopImmediatePropagation(); q('[data-vocab-action="reveal"]')?.click(); }
    if (state.revealed && /^[1-4]$/.test(event.key)) { event.preventDefault(); event.stopImmediatePropagation(); q(`[data-vocab-action="rate"][data-rating="${event.key}"]`)?.click(); }
  }

  async function addDictionaryEntry(entry) {
    if (!entry?.word) return;
    if (typeof window.navigate === 'function') window.navigate('vocabulary');
    await mount();
    if (!state.snapshot) await refresh();
    addDialog(entry);
  }

  function selfTest() {
    const checks = {
      escapesHtml: esc('<img src=x onerror="bad">') === '&lt;img src=x onerror=&quot;bad&quot;&gt;',
      clozeAllOccurrences: cloze('Evidence supports evidence, not evidenced.', 'evidence') === '_____ supports _____, not evidenced.',
      clozePhrases: cloze('We act on behalf of students.', 'on behalf of') === 'We act _____ students.',
      strictSpelling: normal('Evidence') === normal(' evidence ') && normal('evidences') !== normal('evidence'),
      noFutureClaims: dueText('invalid') === '待安排',
    };
    return { ok: Object.values(checks).every(Boolean), checks };
  }
  window.vocabularyUI = Object.freeze({ mount, refresh, addDictionaryEntry, selfTest });
})();

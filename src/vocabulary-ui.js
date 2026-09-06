(() => {
  'use strict';

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const normal = (value) => String(value || '').normalize('NFKC').toLowerCase().replaceAll('’', "'").trim().replace(/\s+/g, ' ');
  const cloze = (sentence, word) => String(sentence || '').replace(new RegExp(`(?<![a-zA-Z])${String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-zA-Z])`, 'gi'), '_____');
  const modes = { mixed: '交替练习', context: '语境填空', meaning: '看词回忆', spelling: '释义拼写' };
  const ratings = { 1: '没记住', 2: '费力想起', 3: '记住了', 4: '很轻松' };
  const state = { root: null, snapshot: null, view: 'today', subject: '', search: '', filter: '', page: 0, busy: false,
    cardId: '', revealed: false, answer: '', completed: 0, feedback: '', candidates: [], dialogKind: '', request: 0,
    readingId: '', readingShowList: true, readingUnknown: new Set(), readingSeconds: 0, readingStart: 0, readingExpectedCount: 0, focused: true, readingWord: null };
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
    q('#vocabDialog').addEventListener('cancel', (event) => { if (state.busy) event.preventDefault(); });
    q('#vocabDialog').addEventListener('close', () => { state.dialogKind = ''; state.candidates = []; });
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
      if (state.cardId !== snapshot.queueIds[0]) resetCard();
      render();
    } catch (error) {
      if (request !== state.request) return;
      if (!state.snapshot) q('.vocab-shell').innerHTML = `<div class="vocab-empty"><h3>词本暂时没能打开</h3><p>${esc(error.message)}</p><button class="primary-button" data-vocab-action="refresh">重试</button></div>`;
      else notify(error.message, true);
    }
  }

  function resetCard() { state.cardId = state.snapshot?.queueIds[0] || ''; state.revealed = false; state.answer = ''; }
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

  async function mutate(operation, message) {
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
        if (state.cardId !== state.snapshot.queueIds[0]) resetCard();
      }
      if (response?.canceled || response?.cancelled || response?.result?.canceled || response?.result?.cancelled) return response;
      if (message) notify(typeof message === 'function' ? message(response?.result ?? response) : message);
      return response || { result: {} };
    } catch (error) { notify(error.message || '操作没有完成，请重试', true); return null; }
    finally {
      state.busy = false;
      state.root.removeAttribute('aria-busy');
      state.root.querySelectorAll('[data-vocab-busy]').forEach((button) => { button.disabled = false; delete button.dataset.vocabBusy; });
      render();
    }
  }

  function render() {
    if (!state.snapshot) return;
    q('.vocab-shell').innerHTML = `<header class="vocab-header">
      <div><span class="section-kicker">WORDS IN YOUR WORLD</span><h2>把单词，变成自己的表达。</h2><p>在语境里理解，在回忆中记牢。</p></div>
      <div class="vocab-actions"><button class="secondary-button" data-vocab-action="import">${icon('upload')} 导入</button><button class="primary-button" data-vocab-action="add">＋ 添加单词</button></div>
    </header>
    <div class="vocab-toolbar"><nav class="vocab-tabs" aria-label="词汇页面"><button data-vocab-action="today" class="${['today', 'study'].includes(state.view) ? 'selected' : ''}" aria-pressed="${['today', 'study'].includes(state.view)}">今日学习</button><button data-vocab-action="reading" class="${state.view === 'reading' ? 'selected' : ''}" aria-pressed="${state.view === 'reading'}">阅读积累</button><button data-vocab-action="library" class="${state.view === 'library' ? 'selected' : ''}" aria-pressed="${state.view === 'library'}">我的词本 <span>${number(state.snapshot.stats.total)}</span></button></nav>
      <div class="vocab-actions"><span class="vocab-offline"><i></i> 离线可用</span><button class="ghost-button" data-vocab-action="settings">学习设置</button></div></div>
    <div class="vocab-content">${state.view === 'study' ? renderStudy() : state.view === 'library' ? renderLibrary() : state.view === 'reading' ? renderReading() : renderToday()}</div>
    <footer class="vocab-footer">语境理解 · 主动回忆 · 间隔复习 <button data-vocab-action="method">怎么学更有效？</button></footer>`;
  }

  function renderToday() {
    const s = state.snapshot.stats;
    const packEntries = state.snapshot.packs || [];
    const packs = Array.isArray(packEntries) ? packEntries.map((p) => Array.isArray(p) ? { subject: p[0], count: p[1] } : p) : Object.entries(packEntries).map(([subject, count]) => ({ subject, count }));
    const max = Math.max(1, ...(s.days || []).map((d) => d.count));
    const metrics = [['到期复习', s.due, '先巩固，再学新词'], ['今日回忆', s.todayReviews, `${number(s.todayWords)} 个不同单词`], ['今日自评记住', s.recallRate == null ? '—' : `${s.recallRate}%`, '来自你的回忆评分'], ['学过的词', s.learned, '不等于词汇量测试']];
    return `<div class="vocab-metrics">${metrics.map(([label, value, note]) => `<div><span>${label}</span><strong>${typeof value === 'number' ? number(value) : value}</strong><small>${note}</small></div>`).join('')}</div>
    <div class="vocab-today-grid"><section class="vocab-start-card"><span class="vocab-chip">每天留一点时间给自己</span><h3>${s.total ? '从今天这一小组开始。' : '你的第一本生词本，从这里开始。'}</h3>
      <p>${s.total ? '先回忆，再揭晓。没记住也没关系，下次复习会早一点。' : '选择一个入门词包，或者把阅读中遇到的生词收进来。'}</p>
      <label class="vocab-start-select"><span>这次想学</span>${subjectSelect('vocabStudySubject')}</label>
      <div class="vocab-start-bottom"><button class="primary-button" data-vocab-action="start"${!state.snapshot.queueIds.length ? ' disabled' : ''}>开始学习 <span aria-hidden="true">→</span></button><span>${state.snapshot.queueIds.length ? `当前可学 ${number(state.snapshot.queueIds.length)} 个` : s.total ? s.nextDue ? `下次复习 ${dateText(s.nextDue)}` : '暂无到期词，可添加新词或调整新词额度' : '添加词包后就能开始'}</span></div>
    </section><section class="vocab-week"><div class="vocab-section-heading"><h3>每一次回忆，都算数。</h3><small>最近 7 天 · 复习次数</small></div>
      <div class="vocab-bars" role="img" aria-label="${esc((s.days || []).map((d) => `${d.day}：${d.count} 次`).join('；'))}">${(s.days || []).map((d, i) => `<div class="${i === 6 ? 'today' : ''}"><span>${d.count}</span><div><i style="height:${Math.max(3, Math.round(d.count / max * 100))}%"></i></div><small>${i === 6 ? '今天' : d.day.slice(5).replace('-', '/')}</small></div>`).join('')}</div><p>一天没学也没关系，回来继续。</p></section></div>
    ${packs.length ? `<section class="vocab-packs"><div class="vocab-section-heading"><div><span class="section-kicker">A GOOD PLACE TO START</span><h3>选一个方向，开始积累。</h3></div><small>原创入门词包 · 不代表完整考试词表</small></div><div class="vocab-pack-grid">${packs.map((pack, i) => `<button class="vocab-pack pack-${i % 3}" data-vocab-action="pack" data-subject="${esc(pack.subject || pack.name)}"><span>${String(i + 1).padStart(2, '0')}</span><strong>${esc(pack.subject || pack.name)}</strong><small>${number(pack.count)} 个词 · 释义与语境</small><b>加入词本 ＋</b></button>`).join('')}</div></section>` : ''}
    <div class="vocab-reading-banner"><div><strong>让下一篇阅读，成为你的词本。</strong><p>从喜欢的文章开始，每天半页也可以。读懂内容，单词才有位置。</p></div><button class="secondary-button" data-vocab-action="reading">开始阅读 ${icon('arrow-right')}</button></div>`;
  }

  function renderStudy() {
    const current = card();
    if (!current) return `<section class="vocab-session-empty"><span class="vocab-done-mark">✓</span><h3>这一轮先到这里。</h3><p>${state.completed ? `本轮已完成 ${state.completed} 次回忆。` : '当前词本暂无可学词条。'}${state.snapshot.stats.nextDue ? ` 下次复习：${dateText(state.snapshot.stats.nextDue)}。` : '你可以继续阅读，遇到好词再收进来。'}</p><div class="vocab-actions"><button class="primary-button" data-vocab-action="today">回到今日学习</button><button class="secondary-button" data-vocab-action="refresh">检查到期词</button>${state.snapshot.undoAvailable ? '<button class="ghost-button" data-vocab-action="undo">撤销上一张</button>' : ''}</div></section>`;
    const mode = effectiveMode(current);
    const context = practiceContext(current);
    const missingContext = state.snapshot.settings.mode === 'context' && mode !== 'context';
    const typed = mode !== 'meaning';
    const correct = normal(state.answer) === normal(current.word);
    const prompt = mode === 'context' ? cloze(context, current.word) : mode === 'spelling' ? cloze(current.meaning, current.word) : current.word;
    return `<div class="vocab-session-top"><button class="ghost-button" data-vocab-action="today">← 暂停学习</button><span>本轮 ${state.completed} 次回忆 · 当前还有 ${state.snapshot.queueIds.length} 个</span><label><span class="vocab-sr-only">练习方式</span><select id="vocabMode">${Object.entries(modes).map(([value, label]) => option(value, label, state.snapshot.settings.mode)).join('')}</select></label></div>
      ${state.feedback ? `<p class="vocab-last-feedback" role="status">${esc(state.feedback)}</p>` : ''}
      <article class="vocab-study-card"><div class="vocab-study-meta"><span>${esc(current.subject)}</span><span>${current.schedule.state === 0 ? '新词' : '复习'} · ${modes[mode]}</span></div>
        <p class="vocab-prompt-instruction">${mode === 'context' ? '结合这句话，想起缺少的单词。' : mode === 'spelling' ? '看到释义，试着拼出英文。' : '先想想它的意思，以及你会怎样使用它。'}</p>
        <div class="vocab-question ${mode === 'meaning' ? 'word' : ''}" lang="${mode === 'spelling' ? 'zh-CN' : 'en'}">${esc(prompt)}</div>
        ${mode === 'meaning' && current.phonetic ? `<p class="vocab-phonetic">${esc(current.phonetic)}</p>` : ''}
        ${mode === 'meaning' && context ? `<p class="vocab-context-hint" lang="en">${esc(context)}</p>` : ''}
        ${missingContext ? '<p class="vocab-hint">这张卡还没有可填空的原句，先用看词回忆练习。</p>' : ''}
        ${!state.revealed ? `${typed ? `<label class="vocab-answer-input"><span>你的答案</span><input id="vocabAnswer" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="100" value="${esc(state.answer)}" placeholder="输入单词，按 Enter 查看答案"></label>` : '<p class="vocab-hint">可以在心里回答，也可以先说出来。</p>'}<button class="primary-button vocab-reveal" data-vocab-action="reveal">查看答案 ${typed ? '' : '<kbd>空格</kbd>'}</button>` : `
          <section class="vocab-revealed" aria-label="答案与反馈"><div class="vocab-solution-top"><div><h3 lang="en">${esc(current.word)}</h3><span>${esc(current.phonetic)}</span></div><button class="secondary-button" data-vocab-action="speak" data-id="${esc(current.id)}">${icon('volume')} 离线发音</button></div>
          ${typed ? `<p class="vocab-check ${correct ? 'correct' : 'incorrect'}">${correct ? '✓ 拼写一致' : state.answer.trim() ? `这次还没拼对。你的答案：${esc(state.answer)}` : '这次没有填写答案，先看一遍，再回来回忆。'}</p>` : ''}
          <div class="vocab-meaning">${esc(current.meaning)}</div>${current.definition ? `<details><summary>英文释义</summary><p>${esc(current.definition)}</p></details>` : ''}
          ${context ? `<blockquote lang="en">${esc(context)}</blockquote>` : '<p class="vocab-hint">给它补一句你读过的原句，下次记得更具体。</p>'}
          ${current.source ? `<p class="vocab-source">来源：${esc(current.source)}</p>` : ''}
          ${current.ownExample ? `<div class="vocab-own-example"><span>我的表达 · 自行核对</span><p lang="en">${esc(current.ownExample)}</p></div>` : ''}
          ${(current.encounters || []).length ? `<p class="vocab-hint">已在 ${current.encounters.length} 篇不同阅读材料中再次遇见 · 不等于已掌握</p>` : ''}<button class="text-button" data-vocab-action="edit" data-id="${esc(current.id)}">${current.ownExample ? '编辑原句与我的表达' : '写一句自己的表达'}</button></section>
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

  async function readingWordDialog(word, sentenceIndex) {
    const reading = readingEntry(); if (!reading) return;
    const context = (readingSegments(reading.text)[sentenceIndex] || '').trim();
    state.readingWord = { word, context, subject: '阅读生词', source: reading.title };
    openDialog(word, '<p class="vocab-hint">正在查询本机词典…</p>', 'reading-word');
    try {
      const lookup = await window.ph.dictionary.lookup(word);
      if (state.dialogKind !== 'reading-word' || state.readingWord?.word !== word || state.readingId !== reading.id) return;
      const entry = lookup.exact;
      state.readingWord = { ...state.readingWord, ...(entry ? { word: entry.word, meaning: entry.translation || entry.definition, phonetic: entry.phonetic, definition: entry.definition } : {}), markedWord: normal(word) };
      openDialog(word, `${entry ? `<p class="vocab-phonetic">${esc(entry.phonetic)}</p><div class="vocab-meaning">${esc(entry.translation || entry.definition)}</div>` : '<p class="vocab-hint">离线词典没有匹配的完整词条。可以标记，或手动填写它的意思。</p>'}<blockquote class="vocab-reader-quote" lang="en">${esc(context)}</blockquote><div class="vocab-dialog-actions"><button class="secondary-button" data-vocab-action="mark-reading-word">${state.readingUnknown.has(normal(word)) ? '取消不熟悉标记' : '标为不熟悉'}</button><button class="primary-button" data-vocab-action="add-reading-word">保留原句并加入词本</button></div>`, 'reading-word');
    } catch (error) { if (state.dialogKind === 'reading-word') q('#vocabDialog').querySelector('.vocab-hint').textContent = `暂时无法查词：${error.message}`; }
  }

  function renderLibrary() {
    return `<div class="vocab-library-tools"><label class="vocab-search"><span class="vocab-sr-only">搜索单词、释义或原句</span><input id="vocabSearch" type="search" value="${esc(state.search)}" placeholder="搜索单词、释义或原句"></label>${subjectSelect('vocabLibrarySubject')}<select id="vocabFilter" aria-label="筛选词条">${[['', '全部状态'], ['due', '到期复习'], ['new', '还没学过'], ['difficult', '易忘词 · 失误 3 次以上'], ['suspended', '已暂停']].map(([value, label]) => option(value, label, state.filter)).join('')}</select><button class="ghost-button" data-vocab-action="export">导出词本</button></div><div id="vocabLibraryResults">${renderLibraryRows()}</div>`;
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
      ${field('context', '原句', current.context, { area: true })}${field('ownExample', '我自己的表达', current.ownExample, { area: true, placeholder: '用它说一件与你有关的事。' })}
      <p class="vocab-hint">这里保留你的表达，不会自动判断语法和用法是否正确。可结合词典或请老师核对。</p>
      ${field('subject', '词本', current.subject, { required: true, max: 60 })}<div class="vocab-dialog-actions"><button type="button" class="ghost-button" data-vocab-action="close">取消</button><button class="primary-button" type="submit">保存</button></div></form>`, 'edit');
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
    if (action === 'refresh') return refresh();
    if (action === 'today' || action === 'library' || action === 'reading') { pauseReadingClock(); state.view = action; resumeReadingClock(); render(); return; }
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
    if (action === 'start') { state.view = 'study'; state.completed = 0; state.feedback = ''; resetCard(); render(); q('#vocabAnswer')?.focus(); return; }
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
      const result = await mutate(() => api().review({ id: learningCard.id, rating, expectedReps: learningCard.schedule.reps, mode }));
      if (result) { state.completed++; state.feedback = `${learningCard.word} · ${ratings[rating]} · 下次 ${dateText(result.result.nextDue)}`; resetCard(); render(); q('#vocabAnswer')?.focus(); }
      return;
    }
    if (action === 'undo') { const result = await mutate(() => api().undo(), (r) => `已撤销 ${r.word || ''} 的上次复习`); if (result) { state.completed = Math.max(0, state.completed - 1); state.feedback = ''; resetCard(); render(); } return; }
    if (action === 'pack') return mutate(() => api().addStarter(button.dataset.subject), addedMessage);
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
    if (event.target.id === 'vocabSearch') { state.search = event.target.value; state.page = 0; q('#vocabLibraryResults').innerHTML = renderLibraryRows(); }
  }

  async function onChange(event) {
    if (['vocabStudySubject', 'vocabLibrarySubject'].includes(event.target.id)) { state.subject = event.target.value; state.page = 0; await refresh(); }
    if (event.target.id === 'vocabFilter') { state.filter = event.target.value; state.page = 0; q('#vocabLibraryResults').innerHTML = renderLibraryRows(); }
    if (event.target.id === 'vocabMode') { await mutate(() => api().configure({ mode: event.target.value })); resetCard(); render(); }
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
    if (form.id === 'vocabSettingsForm') result = await mutate(() => api().configure({ dailyNewLimit: Number(values.dailyNewLimit), retention: Number(values.retention), mode: values.mode }), '学习设置已保存');
    if (form.id === 'vocabImportForm') result = await mutate(() => api().importText(values.text), addedMessage);
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

(() => {
  'use strict';
  const sessions = [];
  let current = null;
  let connectionKey = '';
  let memories = [];
  let historyAvailable = false;
  let historyError = '';
  let saveFailed = false;
  const saveTimers = new Map();
  const saveGenerations = new Map();
  const failedSessions = new Map();
  const deletedSessionIds = new Set();
  let historyOperationGeneration = 0;
  const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const historyApi = () => window.ph?.ai?.history;
  const newId = () => globalThis.crypto?.randomUUID?.() || `temporary-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  function cleanMessages(value) {
    if (!Array.isArray(value)) return [];
    const messages = value.filter((message) => message && !message.streaming && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string');
    if (messages.length > 120) throw new Error('单个会话最多保存 120 条消息，请新建会话后继续');
    return messages.map((message) => {
      if (!message.content.trim() || message.content.length > 16_000) throw new Error('单条消息超过可保存范围，请缩短后重试');
      return { role: message.role, content: message.content };
    });
  }
  function titleFor(session) {
    const firstUser = session.messages.find((message) => message.role === 'user');
    if (!firstUser && (!session.title || ['新会话', 'New chat'].includes(session.title))) return window.i18n?.t('新会话') || '新会话';
    return session.title || firstUser?.content.slice(0, 32) || window.i18n?.t('新会话') || '新会话';
  }
  function ensureCurrent() {
    if (!current) { current = { id: newId(), messages: state.aiMessages, connectionKey }; sessions.push(current); }
    current.messages = state.aiMessages;
    return current;
  }
  function applySnapshot(snapshot, { preferSavedCurrent = false, updateSessions = true, updateMemories = true, updateStatus = true } = {}) {
    if (!snapshot || typeof snapshot !== 'object') return;
    if (updateStatus) {
      historyAvailable = snapshot.available === true;
      const snapshotError = snapshot.error ? String(snapshot.error).slice(0, 180) : '';
      if (snapshotError || !saveFailed) historyError = snapshotError;
      connectionKey = typeof snapshot.connectionKey === 'string' && snapshot.connectionKey.trim() ? snapshot.connectionKey.trim() : '';
    }
    if (updateMemories) memories = Array.isArray(snapshot.memories) ? snapshot.memories.flatMap((item) => {
      if (!item || typeof item.id !== 'string' || typeof item.text !== 'string' || !item.text.trim()) return [];
      return [{ id: item.id, text: item.text, updatedAt: item.updatedAt }];
    }) : [];
    if (!updateSessions) return;
    if (current) current.messages = state.aiMessages;
    const previous = current;
    const local = new Map(sessions.map((session) => [String(session.id), session]));
    const restored = Array.isArray(snapshot.sessions) ? snapshot.sessions.flatMap((item) => {
      if (!item || typeof item.id !== 'string' || !item.id || deletedSessionIds.has(String(item.id)) || !Array.isArray(item.messages)) return [];
      const existing = local.get(String(item.id));
      if (existing) {
        existing.title = typeof item.title === 'string' ? item.title : existing.title;
        existing.connectionKey = typeof item.connectionKey === 'string' ? item.connectionKey : existing.connectionKey;
        existing.updatedAt = item.updatedAt;
        return [existing];
      }
      return [{ id: item.id, title: typeof item.title === 'string' ? item.title : '', connectionKey: typeof item.connectionKey === 'string' ? item.connectionKey : '', messages: cleanMessages(item.messages), updatedAt: item.updatedAt }];
    }) : [];
    const restoredIds = new Set(restored.map((session) => String(session.id)));
    const localOnly = sessions.filter((session) => !deletedSessionIds.has(String(session.id)) && !restoredIds.has(String(session.id))
      && !(preferSavedCurrent && session === previous && !session.messages.some((message) => message.role === 'user')));
    sessions.splice(0, sessions.length, ...restored, ...localOnly);
    const previousStillExists = previous && sessions.includes(previous);
    const matching = sessions.find((session) => connectionKey && session.connectionKey === connectionKey);
    if (preferSavedCurrent && (!previous || !previous.messages.some((message) => message.role === 'user'))) current = matching || sessions[0] || previous;
    else current = previousStillExists ? previous : null;
    if (current && !current.connectionKey && connectionKey) current.connectionKey = connectionKey;
    if (current) state.aiMessages = current.messages;
  }
  function sessionCannotContinue(session = current) { return Boolean(session?.connectionKey && connectionKey && session.connectionKey !== connectionKey); }
  function setTemporaryNotice() { if (!historyAvailable && !historyError) historyError = '此设备当前无法保存聊天记录。'; }

  function renderHistory() {
    const list = document.getElementById('agentSessions');
    if (list) list.innerHTML = sessions.map((session) => `<div class="agent-session-row"><button type="button" data-agent-session="${esc(session.id)}" class="${session === current ? 'active' : ''}"${state.aiBusy ? ' disabled' : ''}${sessionCannotContinue(session) ? ' data-agent-foreign="true"' : ''}>${esc(titleFor(session))}</button><button type="button" class="agent-session-delete" data-agent-delete="${esc(session.id)}" aria-label="${esc(window.i18n?.t('删除会话') || '删除会话')}"${state.aiBusy ? ' disabled' : ''}>×</button></div>`).join('');
    const status = document.getElementById('agentHistoryStatus');
    if (status) {
      status.classList.toggle('error', Boolean(historyError));
      status.innerHTML = historyError ? `${esc(historyError)}${historyAvailable && current?.connectionKey ? ' <button type="button" data-agent-history-retry>重试</button>' : ''}` : historyAvailable ? '聊天记录已加密保存在此设备。' : '此设备的聊天仅在当前打开期间保留。';
    }
    const notice = document.getElementById('agentSessionNotice');
    if (notice) { notice.classList.toggle('hidden', !sessionCannotContinue()); notice.textContent = sessionCannotContinue() ? '这段记录来自另一项 AI 连接。可以查看；继续聊天会新建会话，旧内容不会发送到当前服务。' : ''; }
  }
  function renderMemories() {
    const list = document.getElementById('agentMemories');
    if (!list) return;
    list.innerHTML = memories.map((memory) => `<div class="agent-memory-item"><span>${esc(memory.text)}</span><button type="button" data-agent-memory-edit="${esc(memory.id)}">编辑</button><button type="button" data-agent-memory-delete="${esc(memory.id)}">删除</button></div>`).join('') || '<p>还没有保存的长期记忆。</p>';
    list.querySelectorAll('[data-agent-memory-edit]').forEach((button) => button.addEventListener('click', () => editMemory(button.getAttribute('data-agent-memory-edit'))));
    list.querySelectorAll('[data-agent-memory-delete]').forEach((button) => button.addEventListener('click', () => { void removeMemory(button.getAttribute('data-agent-memory-delete')); }));
  }
  // The AI file tools only ever touch this folder, so it is shown plainly.
  function renderWorkspace() {
    const path = document.getElementById('agentWorkspacePath');
    if (!path) return;
    const workspace = String(state.data?.settings?.ai?.workspace || '');
    path.textContent = workspace || '未设置';
    path.classList.toggle('is-set', Boolean(workspace));
    const clear = document.getElementById('agentWorkspaceClear');
    if (clear) clear.disabled = !workspace || state.aiBusy;
    for (const id of ['agentWorkspacePick', 'agentWorkspaceNew']) {
      const button = document.getElementById(id);
      if (button) button.disabled = state.aiBusy;
    }
  }
  async function applyWorkspace(result) {
    if (!result || result.canceled) return;
    if (state.data?.settings?.ai) {
      state.data.settings.ai.workspace = result.workspace || '';
      state.data.settings.ai.workspaces = result.workspaces || [];
    }
    renderWorkspace();
    if (result.workspace) window.toast?.('AI 工作区已设置为 ' + result.workspace);
  }
  async function pickWorkspace() {
    if (state.aiBusy) return;
    try { await applyWorkspace(await window.ph?.ai?.workspace?.pick?.()); }
    catch (error) { window.toast?.(`无法设置工作区：${String(error?.message || '请重试').slice(0, 140)}`, 'error'); }
  }
  async function createWorkspace() {
    if (state.aiBusy) return;
    // window.prompt is unavailable in Electron, so the name comes from a real
    // dialog; the folder itself is created by the main process.
    const dialog = document.getElementById('agentWorkspaceDialog');
    const input = document.getElementById('agentWorkspaceName');
    if (!dialog || !input) return;
    const name = await new Promise((resolve) => {
      const form = document.getElementById('agentWorkspaceForm');
      const finish = (value) => {
        form?.removeEventListener('submit', onSubmit);
        dialog.removeEventListener('close', onClose);
        resolve(value);
      };
      const onSubmit = (event) => { event.preventDefault(); const value = input.value.trim(); if (!value) return; dialog.close(); finish(value); };
      const onClose = () => finish('');
      form?.addEventListener('submit', onSubmit);
      dialog.addEventListener('close', onClose, { once: true });
      dialog.showModal();
      input.focus();
      input.select();
    });
    if (!name) return;
    try { await applyWorkspace(await window.ph?.ai?.workspace?.create?.(name)); }
    catch (error) { window.toast?.(`无法新建工作区：${String(error?.message || '请重试').slice(0, 140)}`, 'error'); }
  }
  async function clearWorkspace() {
    if (state.aiBusy) return;
    try { await applyWorkspace(await window.ph?.ai?.workspace?.clear?.()); }
    catch (error) { window.toast?.(`无法清除工作区：${String(error?.message || '请重试').slice(0, 140)}`, 'error'); }
  }

  function renderMemoryToggle() {    const input = document.getElementById('aiUseMemories');
    const risk = document.getElementById('aiMemoryRisk');
    const provider = state.data?.settings?.ai?.provider;
    if (!input) return;
    if (state.aiMemoryProvider !== provider) { state.aiMemoryProvider = provider; state.aiUseMemories = provider === 'local'; }
    input.checked = Boolean(state.aiUseMemories);
    input.disabled = !historyAvailable || !memories.length;
    if (risk) risk.textContent = provider === 'api' && input.checked ? '启用后会发送给已配置的服务商。' : '';
  }
  function render() {
    if (typeof state === 'undefined' || !state.data) return;
    ensureCurrent();
    const ai = state.data.settings.ai || {};
    const control = Boolean(ai.launcherControlEnabled && ai.controlConsentVersion);
    const mode = control && ai.permissionMode === 'full' && ai.mailReadEnabled && ai.mailConsentVersion === 2 ? 'full' : control ? 'confirm' : 'chat';
    document.querySelectorAll('[data-agent-mode]').forEach((button) => { button.classList.toggle('active', button.dataset.agentMode === mode); button.disabled = state.aiBusy; });
    renderHistory(); renderMemories(); renderMemoryToggle(); renderWorkspace();
    const model = document.getElementById('agentModel');
    const modelName = ai.provider === 'local' ? ai.localModel : ai.provider === 'api' ? ai.apiModel : '';
    const warmup = state.aiLocalWarmup?.localWarmup;
    const readiness = ai.provider === 'local' && ['checking', 'starting', 'warming'].includes(warmup) ? ' · 正在准备' : ai.provider === 'local' && warmup === 'ready' ? ' · 已准备' : '';
    if (model) model.textContent = `${ai.provider === 'local' ? '本地' : 'API'} · ${modelName || '已连接'}${readiness}`;
    const newButton = document.getElementById('agentNewChat'); if (newButton) newButton.disabled = state.aiBusy;
  }
  function newSession() { current = { id: newId(), messages: [], connectionKey }; sessions.unshift(current); state.aiMessages = current.messages; return current; }
  function prepareForSend() { ensureCurrent(); if (sessionCannotContinue()) newSession(); if (!current.connectionKey && connectionKey) current.connectionKey = connectionKey; return current; }
  async function saveSession(session) {
    const api = historyApi();
    if (!session || !api?.saveSession || !historyAvailable || !session.connectionKey || deletedSessionIds.has(String(session.id))) return false;
    const id = String(session.id);
    const generation = (saveGenerations.get(id) || 0) + 1;
    saveGenerations.set(id, generation);
    const operation = ++historyOperationGeneration;
    try {
      const snapshot = await api.saveSession({ id, title: titleFor(session), connectionKey: session.connectionKey, messages: cleanMessages(session.messages) });
      if (generation === saveGenerations.get(id)) { failedSessions.delete(id); saveFailed = failedSessions.size > 0; }
      if (generation === saveGenerations.get(id) && !deletedSessionIds.has(id)) applySnapshot(snapshot, { updateMemories: false, updateStatus: operation === historyOperationGeneration });
      render(); return true;
    } catch (error) { if (generation === saveGenerations.get(id) && !deletedSessionIds.has(id)) { failedSessions.set(id, session); saveFailed = true; historyError = `聊天记录未保存：${String(error?.message || '请重试').slice(0, 140)}`; } render(); return false; }
  }
  async function saveNow() {
    ensureCurrent();
    if (!current) return false;
    current.messages = state.aiMessages;
    const id = String(current.id);
    if (saveTimers.has(id)) clearTimeout(saveTimers.get(id));
    saveTimers.delete(id);
    return saveSession(current);
  }
  function scheduleSave() {
    ensureCurrent();
    if (!historyApi()?.saveSession || !historyAvailable || !current?.connectionKey) return;
    current.messages = state.aiMessages;
    const session = current; const id = String(session.id);
    if (saveTimers.has(id)) clearTimeout(saveTimers.get(id));
    saveTimers.set(id, setTimeout(() => { saveTimers.delete(id); void saveSession(session); }, 450));
  }
  function flushSession(session) {
    if (!session) return;
    const id = String(session.id);
    if (saveTimers.has(id)) clearTimeout(saveTimers.get(id)); saveTimers.delete(id);
    void saveSession(session);
  }
  function retryFailedSaves() { for (const session of failedSessions.values()) void saveSession(session); }
  async function loadHistory() {
    const api = historyApi();
    if (!api?.get) { setTemporaryNotice(); render(); return null; }
    try { const snapshot = await api.get(); applySnapshot(snapshot, { preferSavedCurrent: true }); render(); return snapshot; }
    catch (error) { historyAvailable = false; historyError = `无法读取聊天记录：${String(error?.message || '请稍后重试').slice(0, 140)}`; render(); return null; }
  }
  async function removeSession(id) {
    if (state.aiBusy) return;
    const session = sessions.find((item) => String(item.id) === String(id)); if (!session) return;
    const api = historyApi(); const key = String(session.id); const wasCurrent = current === session; const wasFailed = failedSessions.has(key);
    const operation = ++historyOperationGeneration;
    if (saveTimers.has(key)) clearTimeout(saveTimers.get(key)); saveTimers.delete(key); deletedSessionIds.add(key);
    failedSessions.delete(key); saveFailed = failedSessions.size > 0;
    sessions.splice(sessions.indexOf(session), 1);
    if (wasCurrent) current = null;
    if (historyAvailable && api?.removeSession && typeof session.id === 'string') {
      try { applySnapshot(await api.removeSession(session.id), { updateMemories: false, updateStatus: operation === historyOperationGeneration }); }
      catch (error) { deletedSessionIds.delete(key); sessions.unshift(session); if (wasFailed) { failedSessions.set(key, session); saveFailed = true; } if (wasCurrent) current = session; if (operation === historyOperationGeneration) historyError = `聊天记录未删除：${String(error?.message || '请重试').slice(0, 140)}`; }
    }
    if (wasCurrent) { current = current || sessions.find((item) => !sessionCannotContinue(item)) || sessions[0] || null; if (!current) newSession(); else state.aiMessages = current.messages; window.renderAi(); }
    render();
  }
  function clearMemoryEditor() { const id = document.getElementById('agentMemoryId'); const text = document.getElementById('agentMemoryText'); if (id) id.value = ''; if (text) text.value = ''; document.getElementById('agentMemoryCancel')?.classList.add('hidden'); }
  function editMemory(id) { const memory = memories.find((item) => item.id === id); if (!memory) return; document.getElementById('agentMemoryId').value = memory.id; document.getElementById('agentMemoryText').value = memory.text; document.getElementById('agentMemoryCancel')?.classList.remove('hidden'); }
  async function saveMemory() {
    const api = historyApi(); const id = document.getElementById('agentMemoryId')?.value || ''; const text = document.getElementById('agentMemoryText')?.value.trim() || '';
    if (!text) { historyError = '请先输入希望记住的内容。'; render(); return; }
    if (!historyAvailable || !api?.saveMemory) { setTemporaryNotice(); render(); return; }
    const operation = ++historyOperationGeneration;
    try { applySnapshot(await api.saveMemory({ ...(id ? { id } : {}), text }), { updateSessions: false, updateStatus: operation === historyOperationGeneration }); clearMemoryEditor(); } catch (error) { if (operation === historyOperationGeneration) historyError = `长期记忆未保存：${String(error?.message || '请重试').slice(0, 140)}`; }
    render();
  }
  async function removeMemory(id) { const api = historyApi(); if (!historyAvailable || !api?.removeMemory) return; const operation = ++historyOperationGeneration; try { applySnapshot(await api.removeMemory(id), { updateSessions: false, updateStatus: operation === historyOperationGeneration }); } catch (error) { if (operation === historyOperationGeneration) historyError = `长期记忆未删除：${String(error?.message || '请重试').slice(0, 140)}`; } render(); }

  function mount() {
    window.addEventListener('ph:language-changed', render);
    document.getElementById('agentNewChat')?.addEventListener('click', () => { if (state.aiBusy) return; ensureCurrent(); if (current && !current.messages.some((message) => message.role === 'user')) return; flushSession(current); newSession(); window.renderAi(); render(); });
    document.getElementById('agentSessions')?.addEventListener('click', (event) => { const remove = event.target.closest('[data-agent-delete]'); if (remove) { void removeSession(remove.dataset.agentDelete); return; } const id = event.target.closest('[data-agent-session]')?.dataset.agentSession; const item = sessions.find((session) => String(session.id) === String(id)); if (!item || state.aiBusy || item === current) return; flushSession(current); current = item; state.aiMessages = item.messages; window.renderAi(); render(); });
    document.getElementById('agentHistoryStatus')?.addEventListener('click', (event) => { if (event.target.closest('[data-agent-history-retry]')) { historyError = ''; if (saveFailed) retryFailedSaves(); else void loadHistory(); } });
    document.getElementById('agentMemoryForm')?.addEventListener('submit', (event) => { event.preventDefault(); void saveMemory(); });
    document.getElementById('agentMemorySave')?.addEventListener('click', (event) => { event.preventDefault(); void saveMemory(); });
    document.getElementById('agentMemoryCancel')?.addEventListener('click', clearMemoryEditor);
    document.getElementById('aiUseMemories')?.addEventListener('change', (event) => { state.aiUseMemories = Boolean(event.target.checked); renderMemoryToggle(); });
    document.querySelectorAll('[data-agent-mode]').forEach((button) => button.addEventListener('click', () => { if (state.aiBusy) return; const toggle = document.getElementById('aiControlToggle'); const ai = state.data.settings.ai || {}; const currentMode = Boolean(ai.launcherControlEnabled && ai.controlConsentVersion && ai.permissionMode === 'full' && ai.mailReadEnabled && ai.mailConsentVersion === 2) ? 'full' : Boolean(ai.launcherControlEnabled && ai.controlConsentVersion) ? 'confirm' : 'chat'; const mode = button.dataset.agentMode; if (mode === currentMode) return; toggle.dataset.agentMode = mode; toggle.checked = mode !== 'chat'; toggle.dispatchEvent(new Event('change')); render(); }));
    document.getElementById('agentConfigure')?.addEventListener('click', () => document.getElementById('aiEditConfig').click());
    document.getElementById('agentWorkspacePick')?.addEventListener('click', () => { void pickWorkspace(); });
    document.getElementById('agentWorkspaceNew')?.addEventListener('click', () => { void createWorkspace(); });
    document.getElementById('agentWorkspaceClear')?.addEventListener('click', () => { void clearWorkspace(); });
  }
  window.agentUI = { render, mount, loadHistory, scheduleSave, saveNow, saveMemory, prepareForSend, currentSession: () => current, connectionKey: () => connectionKey };
})();

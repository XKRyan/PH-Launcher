(() => {
  'use strict';

  // phix 统一账号 · 云同步面板（设置页的一块卡片）。
  //
  // 这一层只做三件事：把状态显示清楚、把用户的动作发给主进程、把结果说成人话。
  // 真正的加密与合并都在主进程里（electron/cloudsync.cjs、phix-crypto.cjs），
  // 渲染进程拿不到 DEK。
  //
  // 与 Pinghe Launcher Lite 的关系：**同一套账号、同一份 settings.yaml、
  // 同一份 data/.sync/**，所以在 PLL 里登录过之后，这里打开就是已配置状态。
  // 协议细节见 D:\phix\phix-协议规范.md。

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const safeError = (error, fallback) => String(error?.message || error || fallback)
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^(?:Error|PhixError|TypeError):\s*/i, '')
    .trim() || fallback;

  const OBJECT_LABELS = {
    'settings.accounts': '四平台账号（Edupage / ManageBac / 邮箱 / 心履）',
    'settings.lessons': '选课（教学组）',
    'settings.ui': '界面排序偏好',
    'settings.ai': 'AI 供应商与 Key',
    schedule: '日程',
    timetable: '课表',
    school: '学校数据快照（课表 / 作业 / 邮箱摘要）',
    profile: '个人资料（头像 / 显示名）',
    mood: '心情记录',
  };
  const DEFAULT_OBJECTS = ['settings.accounts', 'settings.lessons', 'settings.ui', 'schedule', 'timetable', 'school', 'profile'];

  const state = { root: null, mounted: false, status: null, busy: false, error: '', message: '', showAdvanced: false, recoveryHidden: false, devicesHtml: '', sessions: null, devices: null, needPassphrase: false };

  const api = () => window.ph?.phix;

  // ---------------------------------------------------------------- 渲染
  function messageLine() {
    if (state.error) return `<p class="phix-message error" role="alert">${esc(state.error)}</p>`;
    if (state.message) return `<p class="phix-message" role="status">${esc(state.message)}</p>`;
    return '';
  }

  function statusLine(st) {
    const when = st.last_sync_at ? String(st.last_sync_at).slice(0, 16).replace('T', ' ') : '还没有同步过';
    const mode = st.key_mode === 'syncphrase' ? '独立同步口令（连服务器都解不开）' : '登录密码';
    return `<p class="phix-status-line"><b>${esc(st.username)}</b>`
      + `<span class="phix-dim"> · ${esc(st.server)} · 本机「${esc(st.device)}」 · 加密方式：${esc(mode)} · 上次同步：${esc(when)}</span>`
      + (st.unlocked ? '' : ' <span class="phix-lock">🔒 未解锁</span>')
      + '</p>';
  }

  /** 登录框：**只要账号和密码**。
   *
   *  用户明确要求：「设置的登录页面首先不需要用户填服务器地址，也不需要强模式口令，
   *  用户只需要输入账号密码」。所以这里：
   *   * 服务器地址由界面自动探测（`resolveServer()` → 主进程 `/ping`），不露给用户；
   *   * 独立同步口令只在**确实需要**时才出现（登录后 `unlocked === false`，
   *     或登录报 `bad_passphrase`），并且是"在设置里解锁"，不是登录前置条件。
   */
  function loginBox(st) {
    const server = String(st.server || '');
    return `<div class="phix-box" id="phixLoginBox">
      <p class="phix-intro">一套账号打通心履与 PH Launcher。数据在本机加密后才上传，服务器只存密文；
        与 Pinghe Launcher Lite 共用同一账号与同一份数据文件。</p>
      <div class="phix-row">
        <input class="text-input phix-grow" id="phixUsername" type="text" autocomplete="username"
          placeholder="账号" value="${esc(st.username || '')}"/>
        <input class="text-input phix-grow" id="phixPassword" type="password" autocomplete="current-password" placeholder="密码"/>
      </div>
      <div class="phix-row">
        <button class="primary-button" type="button" id="phixLogin">登录</button>
        <button class="secondary-button" type="button" id="phixRegister">注册新账号</button>
      </div>
      <p class="phix-dim phix-server-line">服务器：${server ? esc(server) : '自动探测中…'}</p>
      <div class="phix-row" id="phixPassphraseRow" ${state.needPassphrase ? '' : 'hidden'}>
        <input class="text-input phix-grow" id="phixLoginPassphrase" type="password" autocomplete="off"
          placeholder="独立同步口令（只有强模式账号需要）"/>
        <button class="primary-button" type="button" id="phixUnlockNow">解锁</button>
      </div>
      ${messageLine()}
    </div>`;
  }

  /** 该连哪台服务器：界面**不让用户填**，这里按顺序问主进程。
   *  已在配置里的服务器优先，其次探测候选（内网自建 → 公网入口）。 */
  async function resolveServer() {
    const remembered = String(state.status?.server || '').trim();
    if (remembered) return remembered;
    try {
      const result = await api().ping('');
      if (result?.ok && result.data?.server) return result.data.server;
    } catch { /* 探测失败 → 让主进程用它的默认值 */ }
    return '';
  }

  const stamp = (value) => esc(String(value || '').slice(0, 16).replace('T', ' '));

  /** 设备/会话列表（点了"已登录设备"之后才有）。每一台都能单独注销。 */
  function deviceListHtml() {
    const sessions = state.sessions || [];
    const devices = state.devices || [];
    if (!sessions.length && !devices.length) return '<p class="phix-dim">没有其它已登录的设备。</p>';
    const rows = sessions.map((item) => `<div class="phix-device"><span>${esc(item.device || '未命名设备')}</span>`
      + `<span class="phix-dim">${stamp(item.last_seen_at || item.created_at)}`
      + `${item.current ? ' · 本机' : ''}${item.revoked ? ' · 已注销' : ''}</span>`
      + (item.current || item.revoked ? ''
        : ` <button class="ghost-button" type="button" data-phix-revoke="${esc(String(item.id))}">注销这一台</button>`)
      + '</div>').join('');
    const legacy = devices.map((item) => `<div class="phix-device"><span>${esc(item.device || '未命名设备')}</span>`
      + `<span class="phix-dim">旧式令牌 · ${stamp(item.last_used_at || item.created_at)}`
      + `${item.current ? ' · 本机' : ''}${item.revoked ? ' · 已注销' : ''}</span></div>`).join('');
    const others = sessions.filter((item) => !item.current && !item.revoked).length;
    return rows + legacy + (others > 1
      ? '<div class="phix-row"><button class="secondary-button" type="button" id="phixRevokeOthers">注销其它全部设备</button></div>'
      : '');
  }

  function mainBox(st) {
    const objects = Array.isArray(st.objects) && st.objects.length ? st.objects : DEFAULT_OBJECTS;
    const conflicts = ((st.state || {}).conflicts) || [];
    const recoveryVisible = Boolean(st.recovery_code) && !state.recoveryHidden;
    return `<div class="phix-box" id="phixMainBox">
      ${statusLine(st)}
      <div class="phix-row">
        <button class="primary-button" type="button" id="phixSync">立即同步</button>
        <button class="secondary-button" type="button" id="phixPreview">预览（不写入）</button>
        <button class="secondary-button" type="button" id="phixUploadAvatar">更换头像</button>
        <button class="ghost-button" type="button" id="phixLogout">退出登录</button>
      </div>
      ${messageLine()}
      <div class="phix-row phix-inline">
        <label class="switch"><input type="checkbox" id="phixAuto" ${st.auto_sync ? 'checked' : ''}/><span></span></label>
        <span class="phix-dim">自动同步（改动 1 秒内同步；最迟每</span>
        <input class="text-input phix-interval" id="phixInterval" type="number" min="2" max="240"
          value="${Number(st.sync_interval_minutes) || 10}"/>
        <span class="phix-dim">分钟兜底一次）</span>
        <button class="secondary-button" type="button" id="phixSaveOptions">保存</button>
      </div>
      <div class="phix-objects" id="phixObjects">
        <span class="phix-dim">同步内容：</span>
        ${Object.keys(OBJECT_LABELS).map((key) => `<label class="phix-check"><input type="checkbox" data-phix-object="${esc(key)}"
          ${objects.includes(key) ? 'checked' : ''}/> ${esc(OBJECT_LABELS[key])}</label>`).join('')}
      </div>
      <div class="phix-warning" id="phixLocked" ${st.unlocked ? 'hidden' : ''}>
        <b>数据是锁着的</b>：这个账号用的是独立同步口令，服务器解不开你的数据。
        <div class="phix-row">
          <input class="text-input phix-grow" id="phixUnlockPass" type="password" autocomplete="off" placeholder="同步口令"/>
          <button class="primary-button" type="button" id="phixUnlock">解锁</button>
        </div>
      </div>
      <div class="phix-recovery" id="phixRecovery" ${recoveryVisible ? '' : 'hidden'}>
        <b>请立刻抄下这串恢复码</b> —— 忘记密码时只有它能救回云端数据，它只显示这一次。
        <div class="phix-code" id="phixRecoveryCode">${esc(st.recovery_code || '')}</div>
        <button class="secondary-button" type="button" id="phixRecoveryDone">我已抄好</button>
      </div>
      <details class="phix-more" id="phixMore" ${state.showAdvanced ? 'open' : ''}>
        <summary>高级与安全设置</summary>
        <div class="phix-row">
          <input class="text-input phix-grow" id="phixOldPass" type="password" autocomplete="off" placeholder="当前登录密码"/>
          <input class="text-input phix-grow" id="phixNewPass" type="password" autocomplete="new-password" placeholder="新登录密码"/>
          <button class="secondary-button" type="button" id="phixChangePass">改登录密码</button>
        </div>
        <div class="phix-row">
          <input class="text-input phix-grow" id="phixSpLogin" type="password" autocomplete="off" placeholder="当前登录密码"/>
          <input class="text-input phix-grow" id="phixSpNew" type="password" autocomplete="off" placeholder="新的独立同步口令"/>
          <button class="secondary-button" type="button" id="phixSetSp">改用独立同步口令</button>
        </div>
        <p class="phix-dim">用独立同步口令之后，连服务器都拿不到你的数据（真正端到端）；代价是每次运行要输一次它。
          换密码与换同步口令都不会让云端密文作废 —— 云端数据只由一把钥匙（DEK）加密，口令只用来包裹这把钥匙。</p>
        <div class="phix-conflicts" id="phixConflicts">${conflicts.length
          ? `<p class="phix-subhead">需要你留意的冲突（数据都还在，没有被丢）</p>${conflicts.map((item) => `<div class="phix-conflict"><span>${esc(item.object || item.path || '')}</span><span class="phix-dim">${esc(item.note || '')}</span></div>`).join('')}`
          : ''}</div>
        <div class="phix-row">
          <button class="ghost-button" type="button" id="phixSessions">查看已登录设备</button>
          <button class="ghost-button" type="button" id="phixOpenDir">打开同步状态目录</button>
          <button class="ghost-button" type="button" id="phixTrustKey">重新信任服务器加密公钥</button>
        </div>
        <div class="phix-devices" id="phixDevicesList">${state.devicesHtml || deviceListHtml()}</div>
      </details>
    </div>`;
  }

  function render() {
    if (!state.root) return;
    const st = state.status;
    const focused = document.activeElement && state.root.contains(document.activeElement)
      ? document.activeElement.id : '';
    state.root.innerHTML = st
      ? (st.logged_in ? mainBox(st) : loginBox(st))
      : '<p class="phix-dim">正在读取 phix 账号状态…</p>';
    state.root.classList.toggle('phix-connected', Boolean(st && st.logged_in));
    if (focused) {
      const again = state.root.querySelector(`#${focused}`);
      if (again && typeof again.focus === 'function') again.focus();
    }
  }

  // ---------------------------------------------------------------- 数据
  async function loadStatus() {
    if (!api()) { state.error = '云同步模块尚未准备好'; return null; }
    const result = await api().status();
    if (!result?.ok) { state.error = safeError(result?.error, '读不到 phix 状态'); return null; }
    state.status = result.data;
    return result.data;
  }

  function setNotice(text, isError = false) {
    state.error = isError ? text : '';
    state.message = isError ? '' : text;
  }

  /** 一轮同步的结果说成人话（主进程也给了一份同样口径的摘要）。 */
  function summaryOf(payload) {
    const brief = payload?.summary || payload || {};
    if (brief.skipped) return brief.skipped;
    const parts = [];
    const pulled = (brief.pulled || []).length;
    const pushed = (brief.pushed || []).length;
    if (pulled) parts.push(`拉取 ${pulled} 项`);
    if (pushed) parts.push(`上传 ${pushed} 项`);
    if (!parts.length) parts.push('没有需要同步的变化');
    const conflicts = Array.isArray(brief.conflicts) ? brief.conflicts.length : Number(brief.conflicts) || 0;
    if (conflicts) parts.push(`${conflicts} 处冲突已记录（数据没丢）`);
    const errors = brief.errors || [];
    if (errors.length) parts.push(`${errors.length} 项出错：${errors[0]}`);
    return parts.join('，');
  }

  /** 同步会改写共用的日程 / 课表 / 学校文件：界面上的读盘缓存要作废。 */
  function dropCaches() {
    try { window.schoolUI?.refresh?.(); } catch { /* 没打开就无所谓 */ }
    try { window.dashboardData?.refresh?.(); } catch { /* 同上 */ }
    // 账号也是同步对象（`settings.accounts` → 共用 settings.yaml 的 accounts 段）。
    // 同步完必须**重新读一次账号状态**，否则账号页还写着"未保存密码"、
    // 课表页还写着"输入账号密码"——用户 2026-09-17 反馈的正是这个。
    try { window.credentialsUI?.refresh?.(); } catch { /* 同上 */ }
    window.dispatchEvent(new CustomEvent('phix:synced'));
  }

  const value = (id) => state.root?.querySelector(`#${id}`)?.value ?? '';
  /** 复选框是否勾上。DOM 实现不一定提供 `checked` 属性（linkedom 就没有），
   *  所以属性与特性都看一遍，真实浏览器与测试里行为一致。 */
  const isChecked = (node) => Boolean(node) && (node.checked === true || node.hasAttribute('checked'));
  const checked = (id) => isChecked(state.root?.querySelector(`#${id}`));

  async function withResult(handler) {
    const result = await handler();
    if (!result || !result.ok) throw new Error(result?.error || '操作没有完成');
    return result.data;
  }

  async function doSync(dryRun) {
    const data = await withResult(() => api().sync({ force: false, dry_run: Boolean(dryRun) }));
    await loadStatus();
    setNotice(dryRun ? `预览：${summaryOf(data)}（没有写入任何文件）` : summaryOf(data));
    if (!dryRun) dropCaches();
  }

  // ---------------------------------------------------------------- 动作
  async function handleAction(id) {
    switch (id) {
      case 'phixLogin': {
        const username = value('phixUsername').trim();
        const password = value('phixPassword');
        if (!username || !password) throw new Error('账号和密码都要填');
        const server = await resolveServer();
        const data = await withResult(() => api().login({ server, username, password }));
        await loadStatus();
        // 强模式账号：密码对了、但数据是用独立同步口令包的 → 主进程回
        // `unlocked:false`。这时才把「独立同步口令」那一行露出来，就地解锁；
        // 口令**不是**登录的前置条件（用户明确要求过别在登录页要模式口令）。
        if (data && data.unlocked === false) {
          // 记在 state 里：`onClick` 结束时会整块重绘，直接改 DOM 会被冲掉。
          state.needPassphrase = true;
          state.root?.querySelector('#phixPassphraseRow')?.removeAttribute('hidden');
          setNotice('登录成功，但你的数据用独立同步口令加密：填入口令后点「解锁」。');
          return;
        }
        setNotice('登录成功，正在同步…');
        await doSync(false);
        return;
      }
      case 'phixUnlockNow': {
        await withResult(() => api().unlock(value('phixLoginPassphrase')));
        state.needPassphrase = false;
        await loadStatus();
        setNotice('已解锁，正在同步…');
        await doSync(false);
        return;
      }
      case 'phixRegister': {
        const username = value('phixUsername').trim();
        const password = value('phixPassword');
        if (!username || password.length < 6) throw new Error('注册需要：账号、密码（至少 6 位）');
        const server = await resolveServer();
        if (!window.confirm(`确定要注册新账号「${username}」吗？\n\n注册后会出现一串恢复码，请立刻抄下来。`)) return;
        await withResult(() => api().register({ server, username, password, key_mode: 'password' }));
        await loadStatus();
        setNotice('注册成功！请把上面的恢复码抄到安全的地方。');
        return;
      }
      case 'phixSync':
        await doSync(false);
        return;
      case 'phixPreview':
        await doSync(true);
        return;
      case 'phixUploadAvatar':
        if (typeof window.uploadAvatar === 'function') window.uploadAvatar();
        else { toast('头像上传功能暂不可用'); }
        return;
      case 'phixLogout': {
        if (!window.confirm('退出登录？\n\n本机保存的令牌会被清掉（云端数据不受影响，下次用账号密码登录即可）。')) return;
        await withResult(() => api().logout());
        await loadStatus();
        setNotice('已退出登录');
        return;
      }
      case 'phixUnlock':
        await withResult(() => api().unlock(value('phixUnlockPass')));
        await loadStatus();
        setNotice('已解锁，可以同步了');
        return;
      case 'phixSaveOptions': {
        const objects = [...(state.root?.querySelectorAll('[data-phix-object]') || [])]
          .filter((node) => isChecked(node)).map((node) => node.dataset.phixObject);
        if (!objects.length) throw new Error('至少要选一项要同步的内容');
        await withResult(() => api().saveSettings({
          auto_sync: checked('phixAuto'),
          sync_interval_minutes: Number(value('phixInterval')) || 10,
          objects,
        }));
        await loadStatus();
        setNotice('同步设置已保存');
        return;
      }
      case 'phixChangePass': {
        const newPassword = value('phixNewPass');
        if (newPassword.length < 6) throw new Error('新密码至少 6 位');
        await withResult(() => api().changePassword({ old_password: value('phixOldPass'), new_password: newPassword }));
        await loadStatus();
        setNotice('密码已改。云端密文一个字节都没动，别的设备照常能同步。');
        return;
      }
      case 'phixSetSp': {
        const syncPassphrase = value('phixSpNew');
        if (syncPassphrase.length < 6) throw new Error('同步口令至少 6 位');
        if (!window.confirm('改用独立同步口令后：\n· 连服务器都拿不到你的数据（真正端到端）\n· 每次运行程序都要输一次这个口令\n\n确定吗？')) return;
        await withResult(() => api().setPassphrase({ login_password: value('phixSpLogin'), sync_passphrase: syncPassphrase }));
        await loadStatus();
        setNotice('已切换。以后同步时请在登录框的「独立同步口令」里输入它。');
        return;
      }
      case 'phixRecoveryDone':
        state.recoveryHidden = true;
        state.root?.querySelector('#phixRecovery')?.setAttribute('hidden', '');
        return;
      case 'phixDevices':
      case 'phixSessions': {
        // P3 起一次登录 = 一个**会话**；老的 `devices`（长期令牌）也一并列出来。
        // 优先问 sessions 接口，服务端版本老一点就退回 devices。
        let sessions = [];
        let devices = [];
        if (typeof api().sessions === 'function') {
          const data = await withResult(() => api().sessions());
          sessions = Array.isArray(data.sessions) ? data.sessions : [];
          devices = Array.isArray(data.devices) ? data.devices : [];
        } else {
          devices = (await withResult(() => api().devices())).devices || [];
        }
        state.sessions = sessions;
        state.devices = devices;
        // 记在 state 里（卡片会整块重绘，直接改 DOM 会被下一次 render 冲掉）。
        state.devicesHtml = deviceListHtml();
        const total = sessions.length + devices.length;
        setNotice(total ? `共有 ${total} 台已登录设备` : '没有其它已登录的设备');
        return;
      }
      case 'phixRevokeOthers': {
        if (!window.confirm('注销**除本机以外**的全部设备？\n\n'
          + '那些设备上的登录会立刻失效，需要重新输入账号密码才能再用。')) return;
        const data = await withResult(() => api().revokeSession({ all_except_current: true }));
        await handleAction('phixSessions');
        setNotice(`已注销其它设备（${data.revoked} 条）`);
        return;
      }
      case 'phixOpenDir': {
        const data = await withResult(() => api().openDataDir());
        setNotice(`已打开 ${data.path}`);
        return;
      }
      case 'phixTrustKey': {
        if (!window.confirm('把本机记住的服务器加密公钥换成现在这台服务器的？\n\n'
          + '只在确认服务器确实重装/换过钥匙时才点。如果之前那条"公钥对不上"的提醒来得莫名其妙，\n'
          + '先别点 —— 那可能意味着有人在中间冒充。')) return;
        await withResult(() => api().trustKey());
        await loadStatus();
        setNotice('已重新信任当前服务器的加密公钥');
        return;
      }
      default:
    }
  }

  async function onClick(event) {
    const button = event.target.closest('button');
    if (!button || !state.root.contains(button)) return;
    if (state.busy) return;
    // 不要在这里 render()：那会把用户刚填进输入框的密码清掉。
    // 输入框里的值由 handleAction 直接读，状态变化之后再重绘。
    state.error = '';
    state.message = '';
    state.busy = true;
    try {
      // 会话列表里每一台后面的"注销这一台"（按钮是列表渲染出来的，没有固定 id）
      const revokeId = button.dataset && button.dataset.phixRevoke;
      if (revokeId) {
        if (window.confirm('注销这台设备的登录？它手里的令牌会立刻失效，需要重新登录。')) {
          await withResult(() => api().revokeSession({ session_id: Number(revokeId) }));
          await handleAction('phixSessions');
          setNotice('已注销这一台设备');
        }
      } else {
        await handleAction(button.id);
      }
    } catch (error) {
      state.error = safeError(error, '操作没有完成');
    } finally {
      state.busy = false;
    }
    render();
  }

  // ---------------------------------------------------------------- 挂载
  async function refresh() {
    try {
      await loadStatus();
    } catch (error) {
      state.error = safeError(error, '读不到 phix 状态');
    }
    render();
  }

  function mount() {
    if (!state.mounted) {
      const host = document.getElementById('phixSettings');
      if (!host) return null;
      state.root = host;
      state.mounted = true;
      host.addEventListener('click', (event) => { void onClick(event); });
      host.addEventListener('toggle', (event) => {
        const details = event.target.closest('#phixMore');
        if (details) state.showAdvanced = details.open;
      }, true);
    }
    render();
    void refresh();
    return state.root;
  }

  window.phixUI = { mount, refresh, render, state };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mount());
  else mount();
})();

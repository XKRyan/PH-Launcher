/* ============================================================================
 * phix 账号界面 ↔ PH Launcher 的桥（宿主适配层）
 * ----------------------------------------------------------------------------
 * `src/account-ui.js` 是界面（与 PHL Lite 共用同一份），这一份只做翻译：
 * 把 AccountUI 要的 CONTRACT 映射到 PHL 已有的 `window.ph.*` 接口上。
 *
 * 界面里一句平台相关的话都没有 —— 换宿主只需要换这个文件。
 * ========================================================================== */
(function () {
  'use strict';

  const PLATFORMS = [
    { id: 'edupage', label: 'EduPage' },
    { id: 'managebac', label: 'ManageBac' },
    { id: 'mail', label: '平和邮箱' },
    { id: 'xinlv', label: '心履' },
  ];

  function ph() { return window.ph || {}; }

  /** 把 phix 的 status + 各平台登录情况拼成卡片要的形状。 */
  async function status() {
    const api = ph();
    let raw = {};
    try { raw = await api.phix.status() || {}; } catch { raw = {}; }
    let sites = {};
    try {
      const cs = await api.credentials?.status?.();
      sites = (cs && cs.sites) || {};
    } catch { sites = {}; }
    let profile = null;
    try { profile = await api.phix.profile(); } catch { profile = null; }

    const accounts = PLATFORMS.map((p) => {
      const site = sites[p.id] || {};
      return {
        id: p.id,
        label: p.label,
        loggedIn: Boolean(site.saved),
        account: String(site.username || ''),
        detail: site.saved ? '已保存登录信息' : '未登录',
      };
    });

    return {
      loggedIn: Boolean(raw.logged_in),
      username: String(raw.username || ''),
      displayName: String(profile?.display_name || raw.username || ''),
      avatar: String(profile?.avatar || ''),
      server: String(raw.server || ''),
      syncedAt: String(raw.last_sync_at || ''),
      accounts,
    };
  }

  /** 把同步预览的报告折成"云端 vs 本地各有几项"。 */
  async function probe() {
    const api = ph();
    let report = null;
    try {
      const r = await api.phix.syncPreview();
      report = (r && r.report) || null;
    } catch { report = null; }
    const objects = [];
    let remote = 0;
    let local = 0;
    const list = (report && (report.objects || report.plan || report.items)) || [];
    if (Array.isArray(list)) {
      for (const item of list) {
        const id = String(item.name || item.id || item.object || '');
        if (!id) continue;
        const pull = Number(item.pull || 0) + Number(item.remote_changes || 0);
        const push = Number(item.push || 0) + Number(item.local_changes || 0);
        if (pull) remote += 1;
        if (push) local += 1;
        objects.push({ id, label: item.label || id, remote: pull ? 1 : 0, local: push ? 1 : 0 });
      }
    }
    return {
      remote: { count: remote, updatedAt: '' },
      local: { count: local },
      objects,
    };
  }

  const bridge = {
    status,
    probe,
    async login(username, password) {
      try {
        await ph().phix.login({ username, password });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    },
    async register(username, password) {
      try {
        await ph().phix.register({ username, password });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    },
    async logout() {
      try { await ph().phix.logout(); } catch { /* 退出失败也让界面刷新 */ }
      return { ok: true };
    },
    /** direction: 'local' = 本地覆盖云端；'cloud' = 云端覆盖本地。 */
    async sync(direction) {
      try {
        // cloudsync 的 applyPreference 认的是 'local' / 'remote'
        const prefer = direction === 'cloud' ? 'remote' : 'local';
        await ph().phix.sync({ force: true, prefer });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    },
    async preparePlan() {
      try { return await ph().phix.preparePlan() || []; } catch { return []; }
    },
    async prepareStep(id) {
      try {
        return await ph().phix.prepareStep(id) || { ok: true };
      } catch (error) {
        return { ok: false, detail: String((error && error.message) || error).slice(0, 60) };
      }
    },
    async saveProfile(patch) {
      try { await ph().phix.saveProfile(patch); return { ok: true }; } catch { return { ok: false }; }
    },
    openRegister() {
      // phix 的注册就在登录页里（同一套界面），不需要跳外链
    },
  };

  window.AccountBridge = bridge;
  if (window.AccountUI) window.AccountUI.init({ bridge });
})();

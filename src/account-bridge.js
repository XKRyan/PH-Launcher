/* ============================================================================
 * phix 账号界面 ↔ PH Launcher 的桥（宿主适配层）
 * ----------------------------------------------------------------------------
 * `src/account-ui.js` 是界面（与 PHL Lite 共用同一份），这一份只做翻译：
 * 把 AccountUI 要的 CONTRACT 映射到 PHL 已有的 `window.ph.*` 接口上。
 *
 * 界面里一句平台相关的话都没有 —— 换宿主只需要换这个文件。
 *
 * ⚠️ 2026-11-09 修：主进程的 `phix:*` IPC 统一返回 `{ ok, data }` 包装
 * （见 main.cjs 的 phixCall），这个桥一开始直接把包装当数据用，于是：
 *   · status() 读 `raw.logged_in` 永远是 undefined → 设置页账号卡片一直"未登录"，
 *     而同页云同步面板（phix-ui.js 解了包装）却显示已登录；
 *   · probe() 读 `r.report` 拿到 undefined → 方向页永远显示"云端 0 项 / 本地 0 项"；
 *   · preparePlan() 把 `{ok,data:[…]}` 当成数组 → 退化成一条假的"同步你的数据"；
 *   · login() 根本不检查 `ok:false` → 密码错了也当成功往下走。
 * 这里统一用 `unwrap()` 解包装，失败就抛 `Error(message)` 给界面显示。
 * ========================================================================== */
(function () {
  'use strict';

  const PLATFORMS = [
    { id: 'edupage', label: 'EduPage' },
    { id: 'managebac', label: 'ManageBac' },
    { id: 'mail', label: '平和邮箱' },
    { id: 'xinlv', label: '心履' },
  ];

  const OBJECT_LABELS = {
    'settings.accounts': '四平台账号',
    'settings.lessons': '选课',
    'settings.ui': '界面排序',
    'settings.ai': 'AI 供应商与 Key',
    schedule: '日程',
    timetable: '课表',
    school: '学校数据',
    profile: '个人资料',
    mood: '心情记录',
  };

  function ph() { return window.ph || {}; }

  /**
   * 解开主进程 `{ ok, data }` 包装。
   * 旧接口/测试桩可能返回裸对象，也兼容（没有 `ok` 字段就原样返回）。
   */
  function unwrap(result, fallbackMessage = '操作没有完成') {
    if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'ok')) {
      if (!result.ok) throw new Error(String(result.error || fallbackMessage));
      return Object.prototype.hasOwnProperty.call(result, 'data') ? result.data : result;
    }
    return result;
  }

  /** ISO 时间 → 界面用的 "YYYY-MM-DD HH:MM"（本地时区）。 */
  function displayTime(value) {
    const text = String(value || '');
    if (!text) return '';
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return text.slice(0, 16).replace('T', ' ');
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
      + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  /** 把 phix 的 status + 各平台登录情况拼成卡片要的形状。 */
  async function status() {
    const api = ph();
    let raw = {};
    try { raw = unwrap(await api.phix.status(), '读不到账号状态') || {}; } catch { raw = {}; }
    let sites = {};
    try {
      const cs = await api.credentials?.status?.();
      sites = (cs && cs.sites) || {};
    } catch { sites = {}; }
    let profile = null;
    try { profile = unwrap(await api.phix.profile()) || null; } catch { profile = null; }

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
      syncedAt: displayTime(raw.last_sync_at),
      unlocked: raw.unlocked !== false,
      accounts,
    };
  }

  /** 把同步预览的报告折成"云端 vs 本地各有几项"。 */
  async function probe() {
    const api = ph();
    let data = null;
    try {
      data = unwrap(await api.phix.syncPreview()) || null;
    } catch { data = null; }
    const report = (data && data.report) || {};
    const pulled = Array.isArray(report.pulled) ? report.pulled : [];
    const pushed = Array.isArray(report.pushed) ? report.pushed : [];
    const objects = [];
    const seen = new Set();
    for (const name of pulled) {
      const id = String(name);
      if (seen.has(id)) continue;
      seen.add(id);
      objects.push({ id, label: OBJECT_LABELS[id] || id, remote: 1, local: 0 });
    }
    for (const name of pushed) {
      const id = String(name);
      const existing = objects.find((item) => item.id === id);
      if (existing) { existing.local = 1; continue; }
      seen.add(id);
      objects.push({ id, label: OBJECT_LABELS[id] || id, remote: 0, local: 1 });
    }
    return {
      remote: { count: pulled.length, updatedAt: '' },
      local: { count: pushed.length },
      objects,
    };
  }

  const bridge = {
    status,
    probe,
    async login(username, password) {
      try {
        const data = unwrap(await ph().phix.login({ username, password }), '登录失败');
        return { ok: true, status: data };
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    },
    async register(username, password) {
      try {
        const data = unwrap(await ph().phix.register({ username, password }), '注册失败');
        return { ok: true, status: data };
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    },
    async logout() {
      try { unwrap(await ph().phix.logout()); } catch { /* 退出失败也让界面刷新 */ }
      return { ok: true };
    },
    /**
     * 方向选择：**不在登录页立刻跑完整同步** —— 把方向记到主进程，真正的同步
     * 交给准备清单里的第一步（`sync`），这样进度条里能看到它、失败也有地方显示。
     * direction: 'local' = 本地覆盖云端；'cloud' = 云端覆盖本地；'merge' = 三方合并。
     */
    async sync(direction) {
      try {
        const prefer = direction === 'cloud' ? 'remote' : direction === 'local' ? 'local' : '';
        unwrap(await ph().phix.prepareDirection({ direction: prefer }), '记录同步方向失败');
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    },
    async preparePlan() {
      try {
        const plan = unwrap(await ph().phix.preparePlan());
        return Array.isArray(plan) ? plan : [];
      } catch { return []; }
    },
    async prepareStep(id) {
      try {
        const result = unwrap(await ph().phix.prepareStep(id), '这一步没有完成');
        return (result && typeof result === 'object') ? result : { ok: true };
      } catch (error) {
        return { ok: false, detail: String((error && error.message) || error).slice(0, 60) };
      }
    },
    async saveProfile(patch) {
      try { unwrap(await ph().phix.saveProfile(patch)); return { ok: true }; } catch { return { ok: false }; }
    },
    openRegister() {
      // phix 的注册就在登录页里（同一套界面），不需要跳外链
    },
  };

  window.AccountBridge = bridge;
  if (window.AccountUI) window.AccountUI.init({ bridge });
})();

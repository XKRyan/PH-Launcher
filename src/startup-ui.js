(() => {
  'use strict';
  let started = false;
  function schoolWeek() {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((part) => [part.type, part.value]));
    const date = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    return date.toISOString().slice(0, 10);
  }
  async function run({ enabled = true, accounts = {} } = {}) {
    if (started || !enabled) return [];
    started = true;
    const work = [];
    const labels = { edupage: '课表', managebac: '课程', mail: '邮箱' };
    const status = document.getElementById('startupSyncStatus');
    for (const source of ['edupage', 'managebac', 'mail']) {
      if (!accounts[source]?.saved) continue;
      work.push({ source, run: () => source === 'mail' ? window.mailUI.open() : window.ph.school.sync(source, { force: false, ...(source === 'edupage' ? { weekStart: schoolWeek() } : {}) }) });
    }
    if (!work.length) return [];
    if (status) status.textContent = '正在同步学校信息…';
    const results = await Promise.all(work.map(async (item) => {
      try { const result = await item.run(); return { source: item.source, ok: result !== false }; }
      catch { return { source: item.source, ok: false }; }
    }));
    const failed = results.filter((item) => !item.ok).map((item) => labels[item.source]);
    if (status) status.textContent = failed.length ? `${failed.join('、')}未更新，请在对应页面检查登录或刷新` : '学校信息已更新';
    // Refresh the visible projection, not another network request. Each source
    // keeps its own session and failure; startup never force-submits credentials.
    if (window.schoolUI?.refresh) await window.schoolUI.refresh().catch(() => {});
    return results;
  }
  window.startupSyncUI = { run };
})();

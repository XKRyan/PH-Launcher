(() => {
  let info = null;
  let loading = false;
  let opening = false;
  const card = () => document.getElementById('studyMateCard');
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function render(message = '') {
    const root = card();
    if (!root) return;
    const available = Boolean(info?.available);
    const running = Boolean(info?.running);
    const note = message || (loading
      ? '正在检测本机 StudyMate…'
      : available
        ? `已检测到 ${escape(info.path || '本地安装')}${running ? ' · 正在运行' : ' · 尚未运行'}`
        : '尚未检测到 StudyMate。把它放在 D:\\deepstudy，或稍后在这里设置路径。');
    root.innerHTML = `<div class="metric-icon green" aria-hidden="true"><svg><use href="#i-spark"/></svg></div><div class="study-tool-body">
      <span class="section-kicker">STUDY COMPANION</span>
      <h3>StudyMate</h3>
      <p>你的 AI 学习搭档：定计划、讲知识、做项目，学透一门科目。</p>
      <p class="study-tool-note" id="studyMateStatus" role="status">${note}</p>
      <div class="study-tool-actions">
        <button type="button" class="primary-button" data-study-action="open" ${available && !opening ? '' : 'disabled'}>${running ? '打开 StudyMate' : '启动 StudyMate'}</button>
        <button type="button" class="secondary-button" data-study-action="refresh" ${loading ? 'disabled' : ''}>重新检测</button>
      </div>
    </div>`;
  }

  async function refresh() {
    if (loading) return;
    loading = true;
    render();
    try {
      info = await window.ph.system.studyMateStatus();
    } catch {
      info = null;
    } finally {
      loading = false;
      render();
    }
  }

  async function open() {
    if (opening || !info?.available) return;
    opening = true;
    render();
    let message = '';
    try {
      const result = await window.ph.system.openStudyMate();
      info = await window.ph.system.studyMateStatus().catch(() => info);
      message = result.opened
        ? result.spawned ? 'StudyMate 已启动，窗口稍后出现。' : '已在浏览器打开 StudyMate。'
        : result.error || 'StudyMate 未能启动，请重试。';
    } catch (error) {
      message = `无法打开 StudyMate：${error.message}`;
    } finally {
      opening = false;
      render(message);
    }
  }

  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-study-action]');
    if (!button || !card()?.contains(button)) return;
    if (button.dataset.studyAction === 'open') open();
    if (button.dataset.studyAction === 'refresh') refresh();
  });

  window.studyMateUI = { refresh, open };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh);
  else refresh();
})();

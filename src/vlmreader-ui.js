(() => {
  let opening = null;
  let info = null;
  const page = () => document.getElementById('vlmReaderPage');
  const escape = value => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function render(loading = false) {
    const root = page(); if (!root) return;
    // 与其他页面一致：page-intro 标题区 + 一张卡片
    root.innerHTML = `<div class="page-intro"><div><span class="section-kicker">COMPANION APP</span><h2>VLMReader</h2><p>阅读、查词、批注与间隔复习，在独立应用中继续学习。</p></div></div><div class="vlm-reader-card"><div class="metric-icon green" aria-hidden="true"><svg><use href="#i-book"/></svg></div><div class="vlm-reader-body">${loading ? '<p role="status">正在检测本机安装…</p>' : info?.opened
      ? '<p role="status">已打开 VLMReader。</p><div class="vlm-reader-actions"><button type="button" class="primary-button" data-vlm-action="open">再次打开</button></div>'
      : `<p>尚未找到可用的 VLMReader 安装。下载安装后，点击“重新检测安装”即可打开。</p>${info ? `<small>Windows 64 位 · v${escape(info.version)}</small><label class="vlm-download-source"><span>下载来源</span><select aria-label="下载来源" id="vlmDownloadSource"><option value="accelerated">国内加速（默认）</option><option value="official">GitHub 官方</option></select></label><div class="vlm-reader-actions"><button type="button" class="primary-button" data-vlm-action="download">下载 VLMReader</button><button type="button" class="secondary-button" data-vlm-action="open">重新检测安装</button><button type="button" class="text-button" data-vlm-action="project">GitHub 主页<svg aria-hidden="true"><use href="#i-external"/></svg></button></div>` : '<div class="vlm-reader-actions"><button type="button" class="secondary-button" data-vlm-action="open">重新检测安装</button></div>'}` }<p id="vlmReaderStatus" role="status"></p></div></div>`;
  }
  async function open() {
    if (opening) return opening;
    render(true);
    opening = Promise.resolve().then(() => window.ph.system.openVlmReader()).then(result => { info = result; render(); }).catch(() => {
      info = null; render();
      const status = document.getElementById('vlmReaderStatus');
      if (status) status.textContent = '检测失败，请重新检测安装。';
    }).finally(() => { opening = null; });
    return opening;
  }
  document.addEventListener('click', async event => {
    const button = event.target.closest?.('[data-vlm-action]');
    if (!button || !page()?.contains(button)) return;
    const action = button.dataset.vlmAction;
    if (action === 'open') return open();
    if (!info) return;
    button.disabled = true;
    try {
      const url = action === 'project' ? info.projectUrl : document.getElementById('vlmDownloadSource')?.value === 'official' ? info.downloadUrl : info.acceleratedUrl;
      await window.ph.system.openUrl(url);
      if (action === 'download') document.getElementById('vlmReaderStatus').textContent = '已打开下载链接。安装完成后可重新检测。';
    } catch {
      document.getElementById('vlmReaderStatus').textContent = '链接未能打开，请重试或切换下载来源。';
    } finally { button.disabled = false; }
  });
  window.vlmReaderUI = { open };
})();

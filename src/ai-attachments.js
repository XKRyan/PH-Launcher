(() => {
  'use strict';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function mount({ root, pick, remove, onChange = () => {} }) {
    let items = [];
    let busy = false;
    const t = (zh, en) => window.i18n?.locale() === 'en' ? en : zh;
    root.setAttribute('translate', 'no');
    const render = () => {
      root.innerHTML = `<div class="ai-attachments-list">${items.map((item) => `<span class="ai-attachment" title="${esc(item.preview || item.name)}">${item.thumbnail ? `<img src="${esc(item.thumbnail)}" alt="${esc(item.name)}" width="52" height="52">` : ''}<b>${item.type === 'image' ? t('照片', 'Photo') : t('文档', 'File')}</b> ${esc(item.name)} ${item.contentAvailable === false ? `<b>${t('内容未解析：只发送文件名，不发送文件内容', 'Not parsed: filename only, no file contents')}</b>` : ''} <button type="button" data-ai-attachment-remove="${esc(item.id)}" aria-label="${t('移除', 'Remove')} ${esc(item.name)}">×</button></span>`).join('')}</div><button type="button" class="secondary-button ai-attachment-add"${busy ? ' disabled' : ''}>${busy ? t('读取附件中…', 'Reading files…') : t('＋ 添加文件或照片', '＋ Attach files or photos')}</button><details class="ai-attachment-help"><summary>${t('附件说明', 'Attachment info')}</summary><p>${t('可添加任意格式，每类最多 3 个，单个 10 MB、合计 20 MB。支持文本文档、PDF、DOCX 和图片；其他无法解析的格式仅发送文件名，不能分析内容。长文只发送节选，API 可能收费；图片需要视觉模型。', 'Any file type; up to 3 of each kind, 10 MB each and 20 MB total. Text, PDF, DOCX and images are supported. Unparsed formats send filenames only, not content. Long documents use excerpts; API charges may apply. Photos require a vision model.')}</p></details>`;
      root.querySelector('.ai-attachment-add').onclick = async () => { if (busy) return; busy = true; render(); try { const added = await pick(); if (Array.isArray(added)) { items = [...items, ...added]; onChange(items); } } catch { window.toast?.(t('附件未能读取，请检查格式、大小或文件是否已移动。', 'Could not read the attachment. Check its format, size and location.'), 'error'); } finally { busy = false; render(); } };
      root.querySelectorAll('[data-ai-attachment-remove]').forEach((button) => { button.onclick = async () => { await remove(button.dataset.aiAttachmentRemove); items = items.filter((item) => item.id !== button.dataset.aiAttachmentRemove); render(); onChange(items); }; });
    };
    window.addEventListener('ph:language-changed', render);
    render(); return { list: () => items.map(({ id, type, name, mime }) => ({ id, type, name, mime })), busy: () => busy, clear: () => { const previous = items; items = []; render(); onChange(items); for (const item of previous) Promise.resolve(remove(item.id)).catch(() => {}); } };
  }
  window.PHAiAttachments = { mount };
})();

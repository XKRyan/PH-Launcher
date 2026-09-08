(() => {
  'use strict';

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const mail = { root: null, items: [], contacts: [], selected: null, detail: null, filter: 'all', busy: false, harvesting: false, readBusy: false, sending: false, openingLink: false, pending: null, epoch: 0, readRequest: 0, error: '', detailError: '', notice: '', compose: false, composeError: '', draft: {}, needsLogin: false, fetchedAt: 0 };
  const api = () => window.ph?.mail;
  const safeError = (error, fallback) => String(error?.message || error || fallback).replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^(?:Error|MailClientError):\s*/i, '').trim() || fallback;
  const address = (person) => Array.isArray(person) ? person.map(address).filter(Boolean).join(', ') : typeof person === 'string' ? person : person ? [person.name, person.address].filter(Boolean).join(person.name && person.address ? ' <' : '') + (person.name && person.address ? '>' : '') : '';
  const dateLabel = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || '';
    return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  };
  const statusLine = () => mail.error || mail.notice;

  function linkPanel(detail) {
    const links = Array.isArray(detail?.links) ? detail.links.slice(0, 40) : [];
    if (!links.length) return '';
    return `<section class="mail-links"><h4>邮件中的链接</h4><p>确认发件人和实际域名后，在浏览器中打开。不会自动访问链接。</p>${links.map((link) => `<button type="button" data-mail-link="${esc(link.id)}" data-mail-uid="${esc(detail.uid)}"${mail.openingLink ? ' disabled' : ''}><span class="mail-link-copy" translate="no"><strong>${esc(link.label || link.host)}</strong><small>${esc(link.host)}</small></span><span class="mail-link-action">在浏览器打开 ↗</span></button>`).join('')}</section>`;
  }

  function render() {
    if (!mail.root) return;
    const visible = mail.filter === 'unread' ? mail.items.filter((item) => item.unread) : mail.items;
    const selected = mail.selected && mail.items.find((item) => item.uid === mail.selected);
    const list = visible.length
      ? visible.map((item) => `<button type="button" class="mail-row${item.uid === mail.selected ? ' active' : ''}${item.unread ? ' unread' : ''}" data-mail-open="${esc(item.uid)}"><span class="mail-dot" aria-hidden="true"></span><span class="mail-sender">${esc(address(item.from) || '未知发件人')}</span><strong>${item.hasAttachments ? '<span class="mail-attachment-indicator" title="含附件" aria-label="含附件">📎 </span>' : ''}${esc(item.subject || '(无主题)')}</strong><time>${esc(dateLabel(item.date))}</time></button>`).join('')
      : `<div class="mail-empty-list">${mail.filter === 'unread' ? '没有未读邮件。' : '收件箱暂时没有可显示的邮件。'}</div>`;
    const read = mail.detail && mail.detail.uid === mail.selected ? mail.detail : null;
    const detail = mail.detailError
      ? `<div class="mail-empty"><h3>暂时无法打开这封邮件</h3><p role="alert">${esc(mail.detailError)}</p></div>`
      : read
        ? (() => {
          const recipients = address(read.to || '') + (read.cc ? `, ${address(read.cc)}` : '');
          const recipientCount = (recipients.match(/@/g) || []).length;
          const collapseRecipients = recipientCount > 5;
          // HTML emails render automatically in a sandboxed iframe; plain
          // text is only used when no HTML part exists.
          const htmlAvail = Boolean(read.html && read.html.trim());
          const bodyHtml = htmlAvail
            ? `<iframe class="mail-preview-frame" sandbox="allow-same-origin" srcdoc="${esc(read.html)}"></iframe>`
            : `<pre class="mail-text">${esc(read.text || '（这封邮件没有可显示的纯文本内容。）')}</pre>`;
          return `<article class="mail-message"><header><h3>${esc(read.subject || '(无主题)')}</h3><dl><div><dt>发件人</dt><dd>${esc(address(read.from) || '未知发件人')}</dd></div><div class="mail-recipients-row${collapseRecipients ? ' mail-recipients-collapsed' : ''}"><dt>收件人</dt><dd>${esc(address(read.to) || '未提供')}</dd></div>${read.cc ? `<div class="mail-recipients-row${collapseRecipients ? ' mail-recipients-collapsed' : ''}"><dt>抄送</dt><dd>${esc(address(read.cc))}</dd></div>` : ''}<div><dt>时间</dt><dd>${esc(dateLabel(read.date))}</dd></div></dl>${collapseRecipients ? `<button type="button" class="mail-recipient-toggle" data-mail-recipient-toggle>展开 ${recipientCount} 个收件人</button>` : ''}</header>${read.attachments?.length ? `<section class="mail-attachments"><h4>附件（${read.attachments.length}）</h4>${read.attachments.map((file) => `<button type="button" data-mail-download="${esc(file.id)}" data-mail-uid="${esc(read.uid)}"><span>${esc(file.name || '未命名附件')}</span><small>${esc(formatBytes(file.size))} · 保存附件</small></button>`).join('')}</section>` : ''}${linkPanel(read)}${bodyHtml}</article>`;
        })()
        : selected && mail.readBusy
          ? '<div class="mail-empty"><p>正在打开邮件…</p></div>'
          : '<div class="mail-empty"><h3>选择一封邮件</h3><p>邮件将以纯文本显示，不加载外部图片。</p></div>';
    const compose = mail.compose ? `<section class="mail-compose"><div class="mail-compose-head"><div><span class="section-kicker">NEW MESSAGE</span><h3>写信</h3></div><button type="button" class="mail-close-compose" data-mail-compose-close aria-label="关闭写信">×</button></div><form data-mail-compose-form><label><span>收件人</span><input name="to" type="text" required maxlength="2000" list="mailContacts" autocomplete="off" placeholder="输入邮箱地址" value="${esc(mail.draft.to)}"/></label><label><span>抄送（可选）</span><input name="cc" type="text" maxlength="2000" list="mailContacts" autocomplete="off" placeholder="多个地址用逗号分隔" value="${esc(mail.draft.cc)}"/></label><label><span>主题</span><input name="subject" type="text" required maxlength="500" placeholder="邮件主题" value="${esc(mail.draft.subject)}"/></label><label><span>正文</span><textarea name="text" rows="10" required maxlength="200000" placeholder="写下想说的话…">${esc(mail.draft.text)}</textarea></label><p class="mail-form-error" role="alert">${esc(mail.composeError)}</p><div class="mail-compose-actions"><span>发送前会由系统再次确认。</span><button class="primary-button" type="submit"${mail.sending ? ' disabled' : ''}>${mail.sending ? '正在发送…' : '发送邮件'}</button></div></form></section>` : '';
    mail.root.innerHTML = `<header class="mail-page-head"><div><span class="section-kicker">SCHOOL MAIL</span><h2>平和邮箱</h2><p>最近 100 封邮件 · 只显示纯文本，不加载外部图片。</p></div><div class="mail-head-actions">${mail.needsLogin ? '<button type="button" class="primary-button" data-mail-login>账号登录</button>' : `<button type="button" class="secondary-button" data-mail-login>更换登录</button><button type="button" class="secondary-button" data-mail-refresh${mail.busy ? ' disabled' : ''}>${mail.busy ? '正在同步…' : '刷新'}</button><button type="button" class="secondary-button" data-mail-harvest${mail.harvesting ? ' disabled' : ''}>${mail.harvesting ? '正在收割…' : '收割联系人'}</button><button type="button" class="primary-button" data-mail-compose>写信</button>`}</div></header><p class="mail-status${mail.error ? ' error' : ''}" role="status">${esc(statusLine())}</p><div class="mail-layout"><aside class="mail-list-pane"><div class="mail-filter" role="group" aria-label="邮件筛选"><button type="button" data-mail-filter="all" class="${mail.filter === 'all' ? 'active' : ''}">全部 <span>${mail.items.length}</span></button><button type="button" data-mail-filter="unread" class="${mail.filter === 'unread' ? 'active' : ''}">未读 <span>${mail.items.filter((item) => item.unread).length}</span></button></div><p class="mail-contact-note">联系人来自已读取的邮件头与收割扫描（收件箱+已发送），不是全校通讯录。</p><div class="mail-list">${list}</div></aside><main class="mail-read-pane">${detail}</main></div>${compose}<datalist id="mailContacts">${mail.contacts.map((contact) => `<option value="${esc(contact.address)}">${esc(contact.name || contact.address)}</option>`).join('')}</datalist>`;
  }

  function formatBytes(value) {
    const size = Number(value);
    if (!Number.isFinite(size) || size < 0) return '大小未知';
    if (size < 1024) return `${size} B`;
    if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 ** 2).toFixed(1)} MB`;
  }

  async function refresh() {
    if (mail.pending?.epoch === mail.epoch) return mail.pending.promise;
    const epoch = mail.epoch;
    const task = (async () => {
      mail.busy = true; mail.error = ''; mail.notice = ''; render();
      try {
        if (!api()?.status || !api()?.list) throw new Error('邮箱服务尚未准备好');
        const status = await api().status();
        if (epoch !== mail.epoch) return false;
        if (!status?.saved) {
          mail.items = []; mail.contacts = []; mail.selected = null; mail.detail = null;
          mail.needsLogin = true;
          mail.error = '请先在“设置 → 网站 → 账号记忆”中登录平和邮箱。';
          return false;
        }
        mail.needsLogin = false;
        const listing = await api().list({ unread: false, limit: 100 });
        if (epoch !== mail.epoch) return false;
        const contacts = api().contacts ? await api().contacts() : [];
        if (epoch !== mail.epoch) return false;
        mail.items = Array.isArray(listing?.items) ? listing.items.slice(0, 100) : [];
        mail.contacts = Array.isArray(contacts) ? contacts : [];
        mail.fetchedAt = Date.now();
        mail.notice = `已显示最近 ${mail.items.length} 封邮件。`;
        return true;
      } catch (error) {
        if (epoch !== mail.epoch) return false;
        mail.error = safeError(error, '邮箱同步失败，请检查账号或网络后重试');
        return false;
      } finally {
        if (epoch === mail.epoch) {
          mail.busy = false;
          if (mail.pending?.epoch === epoch) mail.pending = null;
          render();
        }
      }
    })();
    mail.pending = { epoch, promise: task };
    return task;
  }

  // Proactive contact harvest: scans recent INBOX/sent headers (never bodies)
  // through the main-process client and refreshes the local contact list.
  async function harvestContacts() {
    if (mail.harvesting) return;
    const epoch = mail.epoch;
    mail.harvesting = true; mail.error = ''; render();
    try {
      if (!api()?.harvestContacts) throw new Error('邮箱服务尚未准备好');
      const result = await api().harvestContacts();
      if (epoch !== mail.epoch) return;
      const fresh = api().contacts ? await api().contacts() : [];
      if (epoch !== mail.epoch) return;
      mail.contacts = Array.isArray(fresh) ? fresh : [];
      const folders = Number(result?.folders) || 0;
      mail.notice = folders
        ? `联系人收割完成：扫描 ${folders} 个文件夹，现有 ${mail.contacts.length} 个联系人。`
        : '联系人收割完成。';
    } catch (error) {
      if (epoch !== mail.epoch) return;
      mail.error = safeError(error, '联系人收割失败，请稍后重试');
    } finally {
      if (epoch === mail.epoch) { mail.harvesting = false; render(); }
    }
  }

  async function openMessage(uid) {
    if (!uid || !api()?.read) return;
    const epoch = mail.epoch;
    const request = ++mail.readRequest;
    mail.selected = uid; mail.detail = null; mail.detailError = ''; mail.readBusy = true; render();
    try {
      const detail = await api().read(uid);
      if (epoch !== mail.epoch || request !== mail.readRequest || mail.selected !== uid) return;
      if (!detail || detail.uid !== uid) throw new Error('邮件内容不可用');
      mail.detail = detail;
      // Reading is a server-side PEEK. Keep unread flags consistent with the
      // mailbox instead of pretending the message was marked as read.
    } catch (error) {
      if (epoch !== mail.epoch || request !== mail.readRequest || mail.selected !== uid) return;
      mail.detailError = safeError(error, '无法读取这封邮件');
    } finally {
      if (epoch === mail.epoch && request === mail.readRequest && mail.selected === uid) { mail.readBusy = false; render(); }
    }
  }

  async function download(uid, attachmentId) {
    const epoch = mail.epoch;
    try {
      const result = await api()?.download?.({ uid, attachmentId });
      if (epoch !== mail.epoch) return;
      if (result?.ok) { mail.notice = '附件已保存。'; mail.error = ''; }
      else if (!result?.canceled) mail.error = result?.error || '附件没有保存，请重试。';
    } catch (error) { if (epoch === mail.epoch) mail.error = safeError(error, '附件没有保存，请重试'); }
    if (epoch !== mail.epoch) return;
    render();
  }

  async function openLink(uid, linkId) {
    if (mail.openingLink) return;
    const epoch = mail.epoch;
    mail.openingLink = true; render();
    try {
      if (!api()?.openLink) throw new Error('请更新并重新打开 PH Launcher 后使用邮件链接');
      const result = await api().openLink({ uid, linkId });
      if (epoch !== mail.epoch) return;
      if (result?.ok) { mail.notice = '已交给浏览器打开。'; mail.error = ''; }
      else if (!result?.canceled) mail.error = '链接未能打开，请在学校邮箱网页版查看。';
    } catch { if (epoch === mail.epoch) mail.error = '链接未能打开，请在学校邮箱网页版查看。'; }
    finally { if (epoch === mail.epoch) { mail.openingLink = false; render(); } }
  }

  async function send(form) {
    if (mail.sending || (typeof form.reportValidity === 'function' && !form.reportValidity())) return;
    const epoch = mail.epoch;
    mail.sending = true; mail.composeError = ''; render();
    const field = (name) => form.querySelector(`[name="${name}"]`);
    const payload = { to: field('to').value.trim(), cc: field('cc').value.trim(), subject: field('subject').value.trim(), text: field('text').value };
    mail.draft = { ...payload };
    try {
      const result = await api()?.send?.(payload);
      if (epoch !== mail.epoch) return;
      if (!result?.ok) {
        mail.composeError = result?.canceled ? '已取消发送。' : result?.error || '邮件没有发送，请检查后手动重试。';
        return;
      }
      mail.compose = false; mail.draft = {}; mail.notice = '邮件已发送。'; mail.error = '';
    } catch (error) {
      if (epoch === mail.epoch) mail.composeError = safeError(error, '邮件没有发送，请检查后手动重试');
    } finally {
      if (epoch === mail.epoch) { mail.sending = false; render(); }
    }
  }

  function onClick(event) {
    const link = event.target.closest('[data-mail-link]');
    if (link) return openLink(link.dataset.mailUid, link.dataset.mailLink);
    const open = event.target.closest('[data-mail-open]');
    if (open) return openMessage(open.dataset.mailOpen);
    const downloadButton = event.target.closest('[data-mail-download]');
    if (downloadButton) return download(downloadButton.dataset.mailUid, downloadButton.dataset.mailDownload);
    const filter = event.target.closest('[data-mail-filter]');
    if (filter) { mail.filter = filter.dataset.mailFilter; render(); return; }
    if (event.target.closest('[data-mail-refresh]')) return refresh();
    if (event.target.closest('[data-mail-harvest]')) return harvestContacts();
    const recipientToggle = event.target.closest('[data-mail-recipient-toggle]');
    if (recipientToggle) {
      const article = recipientToggle.closest('.mail-message');
      if (!article) return;
      const rows = article.querySelectorAll('.mail-recipients-row');
      const collapsed = article.classList.toggle('mail-recipients-collapsed');
      rows.forEach((row) => row.classList.toggle('mail-recipients-collapsed', collapsed));
      const match = recipientToggle.textContent.match(/\d+/);
      recipientToggle.textContent = collapsed ? `展开 ${match ? match[0] : ''} 个收件人` : '收起收件人';
      return;
    }
    if (event.target.closest('[data-mail-login]')) return window.openSchoolAccount?.('mail');
    if (event.target.closest('[data-mail-compose]')) { mail.compose = true; mail.draft = {}; mail.composeError = ''; render(); return; }
    if (event.target.closest('[data-mail-compose-close]')) { mail.compose = false; mail.draft = {}; mail.composeError = ''; render(); }
  }

  function mount() {
    if (mail.root) return;
    mail.root = document.getElementById('mailPage');
    if (!mail.root) return;
    mail.root.addEventListener('click', onClick);
    mail.root.addEventListener('submit', (event) => { if (event.target.matches('[data-mail-compose-form]')) { event.preventDefault(); send(event.target); } });
    mail.root.addEventListener('input', (event) => {
      const form = event.target.closest('[data-mail-compose-form]');
      if (form && ['to', 'cc', 'subject', 'text'].includes(event.target.name)) mail.draft[event.target.name] = event.target.value;
    });
    render();
  }
  function open() { mount(); return mail.fetchedAt && Date.now() - mail.fetchedAt < 120000 ? Promise.resolve(true) : refresh(); }
  function connect() { mount(); if (typeof window.navigate === 'function') window.navigate('mail'); return refresh(); }
  function clear() {
    mail.fetchedAt = 0;
    mail.epoch += 1;
    mail.pending = null;
    mail.readRequest += 1;
    mail.items = []; mail.contacts = []; mail.selected = null; mail.detail = null;
    mail.busy = false; mail.readBusy = false; mail.sending = false; mail.openingLink = false;
    mail.error = '邮箱账号已清除，请重新登录。'; mail.notice = ''; mail.compose = false; mail.composeError = ''; mail.draft = {}; mail.needsLogin = true;
    render();
  }
  window.mailUI = { mount, open, connect, clear };
})();

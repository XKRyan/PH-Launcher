(() => {
  'use strict';

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const mail = { root: null, items: [], contacts: [], selected: null, detail: null, filter: 'all', busy: false, harvesting: false, recipientsExpanded: false, metaExpanded: false, attachExpanded: false, readBusy: false, sending: false, openingLink: false, pending: null, epoch: 0, readRequest: 0, error: '', detailError: '', notice: '', compose: false, composeMode: 'new', composeError: '', draft: { attachFiles: [] }, needsLogin: false, fetchedAt: 0 };
  const api = () => window.ph?.mail;
  const safeError = (error, fallback) => String(error?.message || error || fallback).replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^(?:Error|MailClientError):\s*/i, '').trim() || fallback;
  // Defense in depth: the data layer already strips scripts, but the
  // renderer never trusts stored HTML either. The preview iframe is also
  // sandboxed without allow-scripts.
  const stripDangerousHtml = (html) => String(html || '')
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, '');

  /** 正文里的图片：**内嵌（cid）与外部（http/https）都取回来，统一转成 `data:` URL**。
   *
   *  为什么两种都要取（用户 2026-09-19 反馈"显示一个框框加一个图片小图标"）：
   *   * `cid:` 浏览器不认识，本来就是破图；
   *   * 正文渲染在 `sandbox="allow-same-origin"`（不带 allow-scripts）的 iframe 里，
   *     实测 `<img src="https://…">` 在这种沙箱下**加载不出来**（`complete=true` 但
   *     `naturalWidth=0`，也就是那个破图小图标）。所以外部图片也交给主进程去取。
   *
   *  取回来的字节转成 data: URL 后不经过 iframe 的网络栈，一定能显示。
   *  **取不到的图整段删掉**，不留破图占位（`onerror` 这类属性在渲染前就被清掉了，指望不上）。 */
  const MAX_INLINE_IMAGES = 12;
  async function loadInlineImages(read) {
    const files = Array.isArray(read?.attachments) ? read.attachments : [];
    const html = String(read?.html || '');
    if (!html) return html;
    const byCid = new Map(files
      .filter((file) => String(file?.contentId || '').trim())
      .map((file) => [String(file.contentId).replace(/^<|>$/g, '').trim().toLowerCase(), file]));
    const resolved = new Map();

    const toDataUrl = (raw, contentType) => {
      const byteArray = raw instanceof Uint8Array ? raw
        : raw instanceof ArrayBuffer ? new Uint8Array(raw)
          : Array.isArray(raw) ? new Uint8Array(raw) : null;
      if (!byteArray || !byteArray.length) return '';
      let binary = '';
      for (const byte of byteArray) binary += String.fromCharCode(byte);
      const base64 = typeof btoa === 'function' ? btoa(binary) : '';
      return base64 ? `data:${contentType || 'application/octet-stream'};base64,${base64}` : '';
    };

    const cidRefs = [...new Set((html.match(/cid:\s*([^"'\s)>]+)/gi) || [])
      .map((match) => match.replace(/^cid:\s*/i, '').replace(/^<|>$/g, '').trim().toLowerCase()))]
      .filter((ref) => byCid.has(ref));
    for (const ref of cidRefs.slice(0, MAX_INLINE_IMAGES)) {
      const file = byCid.get(ref);
      try {
        const bytes = await api().downloadBytes?.({ uid: read.uid, attachmentId: file.id });
        const url = toDataUrl(bytes?.data ?? bytes, file.contentType);
        if (url) resolved.set(`cid:${ref}`, url);
      } catch { /* 取不到 → 下一步整段删掉 */ }
    }

    const httpRefs = [...new Set((html.match(/\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']/gi) || [])
      .map((match) => (match.match(/https?:\/\/[^"']+/) || [''])[0]))].filter(Boolean);
    if (api()?.fetchImage) {
      const results = await Promise.all(httpRefs.slice(0, MAX_INLINE_IMAGES).map(async (url) => {
        try {
          const bytes = await api().fetchImage({ url });
          return [url, toDataUrl(bytes?.data ?? bytes, bytes?.contentType)];
        } catch { return [url, '']; }
      }));
      for (const [url, dataUrl] of results) if (dataUrl) resolved.set(`http:${url}`, dataUrl);
    }

    // 1) cid → data:（取不到的先留成协议地址，第 3 步会被删掉）
    let out = html.replace(/cid:\s*([^"'\s)>]+)/gi, (match, ref) => {
      const key = decodeURIComponent(ref).replace(/^<|>$/g, '').trim().toLowerCase();
      const file = byCid.get(key);
      if (!file) return match;
      return resolved.get(`cid:${key}`)
        || `phl-mail://asset/${encodeURIComponent(String(read.uid))}/${encodeURIComponent(file.id)}`;
    });
    // 2) 外部图片 → data:（只改 src，正文里的**链接**一个字都不动）
    out = out.replace(/(\bsrc\s*=\s*["'])(https?:\/\/[^"']+)(["'])/gi, (match, head, url, tail) => {
      const dataUrl = resolved.get(`http:${url}`);
      return dataUrl ? `${head}${dataUrl}${tail}` : match;
    });
    // 3) 那三类"加载不出来"的图片整段删掉，绝不留破图框
    out = out.replace(/<img\b[^>]*>/gi, (tag) => {
      const src = (tag.match(/\bsrc\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
      if (!src || /^data:/i.test(src)) return tag;
      if (/^cid:/i.test(src) || /^phl-mail:/i.test(src) || /^https?:/i.test(src)) return '';
      return tag;
    });
    return out;
  }
  const address = (person) => Array.isArray(person) ? person.map(address).filter(Boolean).join(', ') : typeof person === 'string' ? person : person ? [person.name, person.address].filter(Boolean).join(person.name && person.address ? ' <' : '') + (person.name && person.address ? '>' : '') : '';
  const dateLabel = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || '';
    return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  };
  const statusLine = () => mail.error || mail.notice;
  /** 角落那行小字用的时间戳：`9/19 13:20`。 */
  const stampLabel = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  };

  // 「邮件中的链接」那一块**已按用户要求去掉**（2026-09-19：链接没意义、占地方）。
  // 正文里的链接照旧原样显示（正文按原文渲染），只是不再单独列一张"在这里打开"的清单。

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
          // Recipients render as individual chips; when there are more than
          // five, the overflow collapses and a toggle reveals them.
          const toList = Array.isArray(read.to) ? read.to : [];
          const ccList = Array.isArray(read.cc) ? read.cc : [];
          const allRecipients = [
            ...toList.map((entry) => ({ ...entry, kind: '收件人' })),
            ...ccList.map((entry) => ({ ...entry, kind: '抄送' })),
          ];
          const recipientCount = allRecipients.length;
          const collapseRecipients = recipientCount > 5;
          const chips = allRecipients.map((entry, index) => {
            const hidden = collapseRecipients && index >= 5 && !mail.recipientsExpanded;
            const label = index === 0 ? '收件人' : (entry.kind === '抄送' && allRecipients[index - 1].kind !== '抄送' ? '抄送' : '');
            return `<div class="mail-recipient-row${hidden ? ' mail-recipient-extra' : ''}"><dt>${label}</dt><dd>${esc(address(entry) || '')}</dd></div>`;
          }).join('');
          const toggleButton = collapseRecipients
            ? `<button type="button" class="mail-recipient-toggle" data-mail-recipient-toggle>${mail.recipientsExpanded ? '收起收件人' : `展开全部 ${recipientCount} 个收件人`}</button>`
            : '';
          // 用户 2026-09-19 定的抬头版式：
          //   第二行 = 发件人 · 时间   + 两个小字「详细信息」「展开附件」 + 回复/转发并列，
          //   全部一个字号；展开后 发件人/收件人/时间 一个一行，附件也一个一行。
          const attachments = Array.isArray(read.attachments) ? read.attachments : [];
          const dot = '<span class="mail-meta-dot" aria-hidden="true">·</span>';
          const detailLink = `<button type="button" class="mail-meta-link" data-mail-meta-toggle aria-expanded="${mail.metaExpanded ? 'true' : 'false'}">${mail.metaExpanded ? '收起详细信息' : '详细信息'}</button>`;
          const attachLink = `<button type="button" class="mail-meta-link" data-mail-attach-toggle aria-expanded="${mail.attachExpanded ? 'true' : 'false'}">${mail.attachExpanded ? '收起附件' : `展开附件${attachments.length ? ` ${attachments.length}` : ''}`}</button>`;
          // 回复/转发和被收起来的两项并列在同一行（用户要求「做的再小一些」）。
          const actionBar = `<span class="mail-message-actions"><button type="button" class="primary-button" data-mail-reply>↩ 回复</button><button type="button" class="secondary-button" data-mail-forward>↪ 转发</button></span>`;
          const metaLine = `<div class="mail-meta-line"><span class="mail-meta-who"><strong>${esc(address(read.from) || '未知发件人')}</strong>${dot}<span>${esc(dateLabel(read.date))}</span></span>${detailLink}${attachLink}${actionBar}</div>`;
          const detailBlock = mail.metaExpanded
            ? `<div class="mail-meta-detail"><dl class="mail-meta-dl"><div><dt>发件人</dt><dd>${esc(address(read.from) || '未知发件人')}</dd></div>${chips}<div><dt>时间</dt><dd>${esc(dateLabel(read.date))}</dd></div></dl>${toggleButton}</div>`
            : '';
          const attachBlock = mail.attachExpanded
            ? `<div class="mail-attachments">${attachments.length
              ? attachments.map((file) => `<button type="button" data-mail-download="${esc(file.id)}" data-mail-uid="${esc(read.uid)}"><span>${esc(file.name || '未命名附件')}</span><small>${esc(formatBytes(file.size))}</small></button>`).join('')
              : '<p class="mail-attach-empty">这封邮件没有附件。</p>'}</div>`
            : '';
          // HTML emails render automatically in a sandboxed iframe; plain
          // text is only used when no HTML part exists.
          const htmlAvail = Boolean(read.html && read.html.trim());
          ensureInlineImages(read);
          // 先把原始 HTML 里的 cid 换成"取不到时的兜底地址"，再套上已解析的 data: URL。
          const rawHtml = stripDangerousHtml(read.html);
          const resolvedHtml = inlineCache.has(String(read.uid)) ? inlineCache.get(String(read.uid)) : rawHtml;
          const bodyHtml = htmlAvail
            ? `<iframe class="mail-preview-frame" sandbox="allow-same-origin" srcdoc="${esc(stripDangerousHtml(resolvedHtml))}"></iframe>`
            : `<pre class="mail-text">${esc(read.text || '（这封邮件没有可显示的纯文本内容。）')}</pre>`;
          return `<article class="mail-message"><header><h3>${esc(read.subject || '(无主题)')}</h3>${metaLine}${detailBlock}${attachBlock}</header>${bodyHtml}</article>`;
        })()
        : selected && mail.readBusy
          ? '<div class="mail-empty"><p>正在打开邮件…</p></div>'
          : '<div class="mail-empty"><h3>选择一封邮件</h3><p>HTML 邮件按原文渲染（脚本一律拦掉），图片会取回来显示。</p></div>';
    const compose = mail.compose ? `<div class="mail-compose-overlay" data-mail-compose-overlay><section class="mail-compose"><div class="mail-compose-head"><div><span class="section-kicker">${mail.composeMode === 'reply' ? 'REPLY' : mail.composeMode === 'forward' ? 'FORWARD' : 'NEW MESSAGE'}</span><h3>${composeTitle()}</h3></div><button type="button" class="mail-close-compose" data-mail-compose-close aria-label="关闭写信">×</button></div><form data-mail-compose-form><label><span>收件人</span><input name="to" type="text" required maxlength="2000" list="mailContacts" autocomplete="off" placeholder="输入邮箱地址" value="${esc(mail.draft.to)}"/></label><label><span>抄送（可选）</span><input name="cc" type="text" maxlength="2000" list="mailContacts" autocomplete="off" placeholder="多个地址用逗号分隔" value="${esc(mail.draft.cc)}"/></label><label><span>主题</span><input name="subject" type="text" required maxlength="500" placeholder="邮件主题" value="${esc(mail.draft.subject)}"/></label><label class="mail-compose-body"><span>正文</span><textarea name="text" rows="10" required maxlength="200000" placeholder="写下想说的话…">${esc(mail.draft.text)}</textarea></label><div class="mail-attach-row"><label class="mail-attach-button"><svg><use href="#i-upload"/></svg><span>添加附件</span><input type="file" name="attachments" multiple accept="*/*" data-mail-attach hidden/></label>${(mail.draft.attachFiles || []).length ? `<span class="mail-attach-count">${mail.draft.attachFiles.length} 个附件</span>` : ''}</div>${(mail.draft.attachFiles || []).length ? `<ul class="mail-attach-list">${mail.draft.attachFiles.map((file, index) => `<li><span>${esc(file.name)}</span><small>${esc(formatBytes(file.size))}</small><button type="button" data-mail-attach-remove="${index}" aria-label="移除附件">×</button></li>`).join('')}</ul>` : ''}<p class="mail-form-error" role="alert">${esc(mail.composeError)}</p><div class="mail-compose-actions"><span>发送前会由系统再次确认。</span><button class="primary-button" type="submit"${mail.sending ? ' disabled' : ''}>${mail.sending ? '正在发送…' : '发送邮件'}</button></div></form></section></div>` : '';
    // 2026-09-19 用户要求：「收割联系人这个按钮去掉，改成每次登录和收到邮件发送邮件的时候
    // 自动收割，不要让用户察觉」「所有同步、刷新全都自动」——所以页头只剩登录与写信，
    // 数据时间用右下角一行小字交代。
    const corner = `<span class="mail-data-stamp" role="status">当前数据：${esc(mail.fetchedAt ? stampLabel(mail.fetchedAt) : '读取中…')}</span>`;
    mail.root.innerHTML = `<header class="mail-page-head"><div><span class="section-kicker">SCHOOL MAIL</span><h2>平和邮箱</h2><p>最近 100 封邮件 · 自动保持最新 · HTML 正文按原文渲染，图片会取回来显示。</p></div><div class="mail-head-actions">${mail.needsLogin ? '<button type="button" class="primary-button" data-mail-login>账号登录</button>' : `<button type="button" class="secondary-button" data-mail-login>更换登录</button><button type="button" class="primary-button" data-mail-compose>写信</button>`}</div></header><p class="mail-status${mail.error ? ' error' : ''}" role="status">${esc(statusLine())}</p><div class="mail-layout"><aside class="mail-list-pane"><div class="mail-filter" role="group" aria-label="邮件筛选"><button type="button" data-mail-filter="all" class="${mail.filter === 'all' ? 'active' : ''}">全部 <span>${mail.items.length}</span></button><button type="button" data-mail-filter="unread" class="${mail.filter === 'unread' ? 'active' : ''}">未读 <span>${mail.items.filter((item) => item.unread).length}</span></button></div><p class="mail-contact-note">联系人来自已读取的邮件头（自动更新，不是全校通讯录）。</p><div class="mail-list">${list}</div></aside><main class="mail-read-pane">${detail}</main></div>${compose}${corner}<datalist id="mailContacts">${mail.contacts.map((contact) => `<option value="${esc(contact.address)}">${esc(contact.name || contact.address)}</option>`).join('')}</datalist>`;
    notifyUnread();
  }

  function formatBytes(value) {
    const size = Number(value);
    if (!Number.isFinite(size) || size < 0) return '大小未知';
    if (size < 1024) return `${size} B`;
    if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 ** 2).toFixed(1)} MB`;
  }

  // ------------------------------------------------------------------ 自动同步
  // 用户 2026-09-19：「所有同步、刷新全都自动，不要让用户察觉，最多来一行不起眼的小字」。
  // 所以邮箱没有刷新按钮：打开页面即取、可见时每 3 分钟对一次、发完信再取一次。
  const AUTO_SYNC_MS = 3 * 60 * 1000;
  let autoTimer = null;
  let autoPending = null;
  const visible = () => Boolean(mail.root && document.visibilityState !== 'hidden');
  /** 用户正在写信 / 正在打开某封邮件时不要插队（render 会重建 DOM，会打断输入）。 */
  function autoSync({ force = false } = {}) {
    if (!visible() || mail.needsLogin) return Promise.resolve(false);
    if (mail.compose || mail.sending) return Promise.resolve(false);
    if (mail.busy) return mail.pending?.promise || Promise.resolve(false);
    if (!force && mail.fetchedAt && Date.now() - mail.fetchedAt < 60000) return Promise.resolve(true);
    const task = (async () => {
      const ok = await refresh();
      // 收到邮件之后自动收割联系人（静默）。
      await harvestContacts({ silent: true });
      return ok;
    })();
    autoPending = task;
    return task.finally(() => { if (autoPending === task) autoPending = null; });
  }
  function scheduleAutoSync(delay = 800) {
    clearTimeout(scheduleAutoSync.timer);
    scheduleAutoSync.timer = setTimeout(() => { void autoSync({ force: true }); }, delay);
  }
  scheduleAutoSync.timer = null;

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
        mail.notice = ''; // 自动同步不打扰用户：数据时间在角落那行小字里
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
  // 2026-09-19 用户要求：「收割联系人这个按钮去掉，改成每次登录和收到邮件、发送邮件的时候
  // 自动收割，不要让用户察觉」——所以默认 `silent`：不报进度、不报错、不改提示行。
  async function harvestContacts({ silent = true } = {}) {
    if (mail.harvesting) return;
    const epoch = mail.epoch;
    mail.harvesting = true;
    if (!silent) { mail.error = ''; render(); }
    try {
      if (!api()?.harvestContacts) throw new Error('邮箱服务尚未准备好');
      const result = await api().harvestContacts();
      if (epoch !== mail.epoch) return;
      const fresh = api().contacts ? await api().contacts() : [];
      if (epoch !== mail.epoch) return;
      mail.contacts = Array.isArray(fresh) ? fresh : [];
      if (silent) return;
      const folders = Number(result?.folders) || 0;
      mail.notice = folders
        ? `联系人收割完成：扫描 ${folders} 个文件夹，现有 ${mail.contacts.length} 个联系人。`
        : '联系人收割完成。';
    } catch (error) {
      if (epoch !== mail.epoch) return;
      // 自动收割失败就当没发生过：常规刷新会把联系人一起带回来。
      if (!silent) mail.error = safeError(error, '联系人收割失败，请稍后重试');
    } finally {
      if (epoch === mail.epoch) { mail.harvesting = false; if (!silent) render(); }
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
      mail.recipientsExpanded = false;
      mail.metaExpanded = false; // 每封邮件默认只显示一行抬头（附件也是收起的）
      mail.attachExpanded = false;
      const listItem = mail.items.find((entry) => String(entry.uid) === String(uid));
      if (detail.markSeenError) {
        // The server refused the \Seen write: keep the mail visibly unread so
        // the list never disagrees with the web client.
        mail.notice = `这封邮件未能在服务器标记为已读：${detail.markSeenError}`;
        if (listItem && !listItem.unread) listItem.unread = true;
      } else if (listItem && listItem.unread) {
        // Marked read server-side; flip the local entry immediately.
        listItem.unread = false;
      }
      render();
    } catch (error) {
      if (epoch !== mail.epoch || request !== mail.readRequest || mail.selected !== uid) return;
      mail.detailError = safeError(error, '无法读取这封邮件');
    } finally {
      if (epoch === mail.epoch && request === mail.readRequest && mail.selected === uid) { mail.readBusy = false; render(); }
    }
  }

  /** 引用块：与网页端（和 CipherCore E-Mail Suite 参考实现）**逐字一致**的格式。 */
  function quoteBlock(read, bodyText) {
    const quoted = String(bodyText || '（这封邮件没有可显示的纯文本内容。）').split('\n').map((line) => `> ${line}`).join('\n');
    return `\n\n---------- 原始邮件 ----------\n发件人：${address(read.from) || '未知发件人'}\n日期：${dateLabel(read.date)}\n主题：${read.subject || '(无主题)'}\n\n${quoted}\n\n------------------\n`;
  }

  /** 回复/转发里的收件人：Reply-To 优先，退回 From；转发留空。 */
  function firstAddress(person) {
    const list = Array.isArray(person) ? person : person ? [person] : [];
    for (const entry of list) {
      const text = typeof entry === 'string' ? entry : String(entry?.address || '');
      const match = text.match(/<([^>]+)>/);
      const value = (match ? match[1] : text).trim();
      if (value.includes('@')) return value;
    }
    return '';
  }

  function subjectWithPrefix(subject, prefix) {
    const clean = String(subject || '').trim() || '(无主题)';
    return clean.toLowerCase().startsWith(prefix.toLowerCase()) ? clean : `${prefix} ${clean}`;
  }

  const composeTitle = () => (mail.composeMode === 'reply' ? '回复邮件' : mail.composeMode === 'forward' ? '转发邮件' : '写信');

  /** 写信 / 回复 / 转发共用同一个撰写窗：只把预填内容与标题换掉。
   *  转发会把原邮件的附件一并带上（参考实现在这里留了 TODO，我们做掉）。 */
  async function startCompose(mode) {
    const read = mail.detail;
    if (mode !== 'new' && !read) return;
    if (mode === 'new') { mail.compose = true; mail.composeMode = 'new'; mail.draft = { attachFiles: [] }; mail.composeError = ''; render(); return; }
    const bodyText = read.html ? htmlToText(read.html, read.text) : read.text;
    mail.compose = true;
    mail.composeMode = mode;
    mail.composeError = '';
    mail.draft = {
      to: mode === 'reply' ? firstAddress(read.replyTo) || firstAddress(read.from) : '',
      cc: '',
      subject: subjectWithPrefix(read.subject, mode === 'reply' ? 'Re:' : 'Fwd:'),
      text: quoteBlock(read, bodyText),
      attachFiles: [],
    };
    render();
    if (mode !== 'forward') return;
    const files = Array.isArray(read.attachments) ? read.attachments : [];
    if (!files.length || !api()?.downloadBytes) return;
    // 逐个把原附件读回来当 File：需要时由用户自己删掉，不会被悄悄发出去。
    const picked = [];
    for (const file of files.slice(0, 20)) {
      try {
        const bytes = await api().downloadBytes({ uid: read.uid, attachmentId: file.id });
        const buffer = bytes?.data ?? bytes;
        if (!buffer) continue;
        picked.push(new File([buffer], file.name || '附件', { type: file.contentType || 'application/octet-stream' }));
      } catch { /* 取不到的单个附件跳过 */ }
    }
    if (mail.compose && mail.composeMode === 'forward' && mail.selected === read.uid) {
      mail.draft.attachFiles = picked;
      if (picked.length !== files.length) mail.composeError = `原邮件的 ${files.length} 个附件里有 ${files.length - picked.length} 个读不到，已跳过。`;
      render();
    }
  }

  /** 把 HTML 正文说成人话：去掉标签、压掉多余空行，给引用块用。 */
  function htmlToText(html, fallback) {
    const text = String(html || '')
      .replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return text || String(fallback || '');
  }

  /** 内嵌图片（cid）的就地解析结果：uid → 已经换成 data: URL 的 HTML。
   *  放在 render 之外做，render 保持同步（和原来一样）。 */
  const inlineCache = new Map();
  const inlineBusy = new Set();
  function ensureInlineImages(read) {
    const uid = String(read?.uid ?? '');
    if (!uid || inlineCache.has(uid) || inlineBusy.has(uid)) return;
    if (!read?.html || !/<img/i.test(read.html)) { inlineCache.set(uid, read?.html || ''); return; }
    inlineBusy.add(uid);
    void loadInlineImages(read).then((htmlWithData) => {
      inlineCache.set(uid, htmlWithData);
    }).catch(() => {
      inlineCache.set(uid, read.html);
    }).finally(() => {
      inlineBusy.delete(uid);
      if (mail.detail && String(mail.detail.uid) === uid) render();
    });
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

  async function send(form) {
    if (mail.sending || (typeof form.reportValidity === 'function' && !form.reportValidity())) return;
    const epoch = mail.epoch;
    mail.sending = true; mail.composeError = ''; render();
    const field = (name) => form.querySelector(`[name="${name}"]`);
    const payload = {
      to: field('to').value.trim(),
      cc: field('cc').value.trim(),
      subject: field('subject').value.trim(),
      text: field('text').value,
    };
    // 附件：File 跨 IPC 会变成普通对象，这里显式转成 ArrayBuffer + 名字 + 类型，
    // 主进程再包回 Buffer（见 mail-controller.cjs）。
    const files = Array.isArray(mail.draft.attachFiles) ? mail.draft.attachFiles : [];
    if (files.length) {
      payload.attachments = [];
      for (const entry of files) {
        try {
          const buffer = await entry.file.arrayBuffer();
          payload.attachments.push({ name: entry.name, type: entry.file.type || 'application/octet-stream', bytes: buffer });
        } catch { /* 单个读不到就跳过 */ }
      }
      if (!payload.attachments.length) delete payload.attachments;
    }
    mail.draft = { ...mail.draft, ...payload };
    try {
      const result = await api()?.send?.(payload);
      if (epoch !== mail.epoch) return;
      if (!result?.ok) {
        mail.composeError = result?.canceled ? '已取消发送。' : result?.error || '邮件没有发送，请检查后手动重试。';
        return;
      }
      mail.compose = false; mail.composeMode = 'new'; mail.draft = {}; mail.notice = '邮件已发送。'; mail.error = '';
      // 发完信顺手把最新状态取回来（已发送文件夹 + 联系人），用户不用管。
      scheduleAutoSync(1500);
    } catch (error) {
      if (epoch === mail.epoch) mail.composeError = safeError(error, '邮件没有发送，请检查后手动重试');
    } finally {
      if (epoch === mail.epoch) { mail.sending = false; render(); }
    }
  }

  function onClick(event) {
    const open = event.target.closest('[data-mail-open]');
    if (open) return openMessage(open.dataset.mailOpen);
    const downloadButton = event.target.closest('[data-mail-download]');
    if (downloadButton) return download(downloadButton.dataset.mailUid, downloadButton.dataset.mailDownload);
    const filter = event.target.closest('[data-mail-filter]');
    if (filter) { mail.filter = filter.dataset.mailFilter; render(); return; }
    const recipientToggle = event.target.closest('[data-mail-recipient-toggle]');
    if (recipientToggle) { mail.recipientsExpanded = !mail.recipientsExpanded; render(); return; }
    // 抬头那一行的两个小字：「详细信息」管发件人/收件人/时间，「展开附件」只管附件。
    if (event.target.closest('[data-mail-meta-toggle]')) { mail.metaExpanded = !mail.metaExpanded; render(); return; }
    if (event.target.closest('[data-mail-attach-toggle]')) { mail.attachExpanded = !mail.attachExpanded; render(); return; }
    if (event.target.closest('[data-mail-login]')) return window.openSchoolAccount?.('mail');
    if (event.target.closest('[data-mail-compose]')) return startCompose('new');
    if (event.target.closest('[data-mail-reply]')) return startCompose('reply');
    if (event.target.closest('[data-mail-forward]')) return startCompose('forward');
    if (event.target.closest('[data-mail-compose-close]')) { mail.compose = false; mail.composeMode = 'new'; mail.draft = {}; mail.composeError = ''; render(); return; }
    if (event.target.closest('[data-mail-compose-overlay]') && !event.target.closest('.mail-compose')) { mail.compose = false; mail.composeMode = 'new'; mail.draft = {}; mail.composeError = ''; render(); return; }
  }

  function mount() {
    if (mail.root) return;
    mail.root = document.getElementById('mailPage');
    if (!mail.root) return;
    mail.root.addEventListener('click', onClick);
    // 自动同步：窗口重新可见时对一次，之后每 3 分钟一次（都在后台悄悄做）。
    if (!autoTimer) {
      autoTimer = setInterval(() => { void autoSync(); }, AUTO_SYNC_MS);
      document.addEventListener('visibilitychange', () => { if (visible()) void autoSync(); });
    }
    mail.root.addEventListener('submit', (event) => { if (event.target.matches('[data-mail-compose-form]')) { event.preventDefault(); send(event.target); } });
    mail.root.addEventListener('input', (event) => {
      const form = event.target.closest('[data-mail-compose-form]');
      if (form && ['to', 'cc', 'subject', 'text'].includes(event.target.name)) mail.draft[event.target.name] = event.target.value;
    });
    mail.root.addEventListener('change', (event) => {
      if (event.target.matches('[data-mail-attach]')) {
        const files = Array.from(event.target.files || []);
        if (files.length) {
          mail.draft.attachFiles = [...(mail.draft.attachFiles || []), ...files.map((f) => ({ name: f.name, size: f.size, file: f }))];
          render();
        }
      }
    });
    mail.root.addEventListener('click', (event) => {
      const removeBtn = event.target.closest('[data-mail-attach-remove]');
      if (removeBtn) {
        const idx = Number(removeBtn.dataset.mailAttachRemove);
        mail.draft.attachFiles = (mail.draft.attachFiles || []).filter((_, i) => i !== idx);
        render();
      }
    });
    render();
  }
  function open() {
    mount();
    // 每次进邮箱：该取的取回来，顺手把联系人静默收割一遍（用户不用管）。
    const task = mail.fetchedAt && Date.now() - mail.fetchedAt < 120000 ? Promise.resolve(true) : refresh();
    return task.then(async (ok) => { await harvestContacts({ silent: true }); return ok; });
  }
  function connect() { mount(); if (typeof window.navigate === 'function') window.navigate('mail'); return autoSync({ force: true }); }
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
  const unreadListeners = new Set();
  let lastUnread = null;
  function notifyUnread() {
    const count = mail.needsLogin ? null : mail.items.filter((item) => item.unread).length;
    if (count === lastUnread) return;
    lastUnread = count;
    for (const listener of unreadListeners) { try { listener(count); } catch { /* listener errors must not break mail */ } }
  }
  window.mailUI = {
    mount, open, connect, clear,
    unreadCount: () => (mail.needsLogin ? null : mail.items.filter((item) => item.unread).length),
    onUnreadChange: (listener) => { if (typeof listener === 'function') { unreadListeners.add(listener); return () => unreadListeners.delete(listener); } return () => {}; },
  };
})();

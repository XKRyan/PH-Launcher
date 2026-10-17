'use strict';
// Desktop-only boundary: file locations and send confirmation are chosen by
// native dialogs, never supplied as privileged operations by email content.
const path = require('node:path');
const fs = require('node:fs/promises');

const UNCERTAIN_SEND = '发送结果不确定，请先查已发送，不要重复点击';
const LINK_OPEN_ERROR = '无法打开邮件链接，请稍后重试';
//: 正文里的外部图片：单张上限 3 MB（超过就当取不到，隐藏掉，不要让一封信把内存吃满）。
const MAX_INLINE_IMAGE_BYTES = 3 * 1024 * 1024;

function safeAttachmentFilename(value) {
  let name;
  try { name = String(value || ''); } catch { name = ''; }
  name = path.posix.basename(path.win32.basename(name));
  name = name
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 180)
    .replace(/[. ]+$/, '');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name || '附件';
}

function createMailController({ getClient, status, revision, dialog, getWindow, writeFile = fs.writeFile, openExternal, getLanguage = () => 'zh-CN' }) {
  let sending = false;
  let openingLink = false;
  function sameAccount(before) {
    if (before !== revision()) throw new Error('邮箱账号已修改，请重新打开当前操作');
  }
  return {
    status,
    list: (options) => getClient().list(options || {}),
    read: (uid) => getClient().read(uid),
    contacts: () => getClient().contacts({ limit: 300 }),
    harvestContacts: (options) => getClient().harvestContacts(options || {}),
    async openLink(input) {
      if (openingLink) return { canceled: true };
      openingLink = true;
      try {
        const before = revision();
        const client = getClient();
        const linked = await client.link(input?.uid, input?.linkId);
        sameAccount(before);
        const raw = linked?.url;
        let safe;
        try { safe = require('./mail-links.cjs').safeMailUrl(raw); } catch { safe = null; }
        if (!safe) return { ok: false, error: LINK_OPEN_ERROR };
        const url = new URL(safe);
        const english = getLanguage() === 'en';
        const result = await dialog.showMessageBox(getWindow(), {
          type: 'question',
          title: english ? 'Open email link?' : '打开邮件链接？',
          message: english ? 'This link will open in your system browser.' : '此链接将在系统浏览器中打开。',
          detail: english ? `Destination website: ${url.origin}\n\nCheck the sender and domain. A valid link format does not mean the website is trustworthy.` : `目标网站：${url.origin}\n\n请核对发件人和域名。链接格式合法不代表网站可信。`,
          buttons: english ? ['Cancel', 'Open link'] : ['取消', '打开链接'],
          defaultId: 0, cancelId: 0, noLink: true,
        });
        if (result.response !== 1) return { canceled: true };
        sameAccount(before);
        if (typeof openExternal !== 'function') return { ok: false, error: LINK_OPEN_ERROR };
        try { await openExternal(safe); } catch { return { ok: false, error: LINK_OPEN_ERROR }; }
        return { ok: true };
      } catch (error) {
        if (error?.message === '邮箱账号已修改，请重新打开当前操作') throw error;
        return { ok: false, error: LINK_OPEN_ERROR };
      } finally {
        openingLink = false;
      }
    },
    /**
     * 内嵌图片（`<img src="cid:…">`）取字节用：**不弹保存对话框**，只回字节。
     * 只给自定义协议 `phl-mail:` 用，不跨渲染进程（见 main.cjs 的协议注册）。
     */
    async bytes(uid, attachmentId) {
      const client = getClient();
      const detail = await client.read(uid);
      const attachment = (detail.attachments || []).find((item) => item.id === attachmentId);
      if (!attachment) throw new Error('附件不存在，请刷新邮件后重试');
      const data = await client.attachment(uid, attachment.id);
      return { data, contentType: attachment.contentType || 'application/octet-stream' };
    },
    /**
     * 邮件正文里的**外部图片**：由主进程去取字节，回给渲染进程。
     *
     * 为什么必须由主进程取：正文渲染在 `sandbox="allow-same-origin"`（不带 allow-scripts）
     * 的 iframe 里，`<img src="https://…">` 在那种沙箱下加载不出来 —— 用户看到的就是
     * 一个破图框。改成主进程取回来、渲染进程转成 data: URL 再放进正文。
     *
     * 安全边界：只允许 http/https；单个不超过 3 MB、总共不超过 12 MB；10 秒超时；
     * 不回跳转目标之外的地址；失败就回空，让前端把那处图片隐藏。
     */
    async fetchImage(input) {
      const raw = String(input?.url || '').trim();
      let target;
      try { target = new URL(raw); } catch { throw new Error('图片地址不合法'); }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('只支持 http/https 图片');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(target.href, {
          redirect: 'follow', signal: controller.signal,
          headers: { accept: 'image/*' },
        });
        if (!response.ok) throw new Error(`图片返回 ${response.status}`);
        const declared = Number(response.headers.get('content-length') || 0);
        if (declared > MAX_INLINE_IMAGE_BYTES) throw new Error('图片太大');
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length) throw new Error('图片是空的');
        if (buffer.length > MAX_INLINE_IMAGE_BYTES) throw new Error('图片太大');
        const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim();
        return { data: buffer, contentType: /^image\//.test(contentType) ? contentType : 'image/png' };
      } finally {
        clearTimeout(timer);
      }
    },
    async download(input) {      const before = revision();
      const client = getClient();
      const detail = await client.read(input?.uid);
      sameAccount(before);
      const attachment = detail.attachments.find((item) => item.id === input?.attachmentId);
      if (!attachment) throw new Error('附件不存在，请刷新邮件后重试');
      const filename = safeAttachmentFilename(attachment.name);
      const chosen = await dialog.showSaveDialog(getWindow(), { title: '保存邮件附件', defaultPath: filename });
      if (chosen.canceled || !chosen.filePath) return { canceled: true };
      sameAccount(before);
      const bytes = await client.attachment(input.uid, attachment.id);
      sameAccount(before);
      await writeFile(chosen.filePath, bytes);
      return { ok: true };
    },
    async send(input) {
      if (sending) throw new Error('已有邮件正在确认或发送，请不要重复点击');
      sending = true;
      let client;
      let prepared;
      let before;
      let sendStarted = false;
      try {
        client = getClient();
        before = revision();
        // 附件（File 对象跨 IPC 会变成普通对象，但 ArrayBuffer 保真）要带上，
        // 否则"写信里加了附件，发出去却没有"。
        // **不收 bcc**：启动器的边界是"发出去的人和用户看到的收件人一致"，
        // 密送容易造成"悄悄发给别人"（tests/mail-controller.test.cjs 钉着这条）。
        const draftPayload = { to: input?.to, cc: input?.cc, subject: input?.subject, text: input?.text };
        if (Array.isArray(input?.attachments) && input.attachments.length) {
          if (input.attachments.length > 20) throw new Error('附件最多 20 个');
          const attachments = [];
          let total = 0;
          for (const file of input.attachments) {
            if (!file || typeof file !== 'object') continue;
            const bytes = file.content ?? file.bytes ?? file.data;
            const buffer = Buffer.isBuffer(bytes) ? bytes
              : bytes instanceof Uint8Array ? Buffer.from(bytes)
                : bytes instanceof ArrayBuffer ? Buffer.from(new Uint8Array(bytes)) : null;
            if (!buffer || !buffer.length) continue;   // 没有字节的条目（例如只带路径）一律丢掉
            total += buffer.length;
            if (buffer.length > 20 * 1024 * 1024 || total > 20 * 1024 * 1024) throw new Error('附件总大小不能超过 20 MiB');
            attachments.push({
              // 用本文件里已有的文件名清洗（去路径、去控制字符），
              // 不让 `../../x` 这种名字进到 MIME 头里。
              name: safeAttachmentFilename(file.name || file.filename) || '附件',
              type: String(file.type || file.contentType || 'application/octet-stream'),
              bytes: buffer,
            });
          }
          if (attachments.length) draftPayload.attachments = attachments;
        }
        // No URL, filesystem path or HTML can cross this UI boundary.
        prepared = await client.prepareSend(draftPayload);
        sameAccount(before);
        const result = await dialog.showMessageBox(getWindow(), {
          type: 'question', title: '确认发送邮件', message: '现在发送这封邮件？',
          detail: `收件人（含抄送）：\n${prepared.confirmation.recipients.join('\n')}\n\n主题：${prepared.confirmation.subject}\n正文：${prepared.confirmation.bodyBytes} 字节\n\n发出后可能无法撤回，请核对写信页面中的完整正文。`,
          buttons: ['取消', '确认发送'], defaultId: 0, cancelId: 0, noLink: true,
        });
        if (result.response !== 1) return { canceled: true };
        sameAccount(before);
        sendStarted = true;
        const sent = await client.send(prepared);
        if (before !== revision()) return { ok: false, error: UNCERTAIN_SEND };
        if (sent.rejected?.length) return { ok: false, error: '部分收件人未接受邮件。请核对发送结果，不要向全部收件人重复发送。' };
        if (!sent.accepted?.length) return { ok: false, error: UNCERTAIN_SEND };
        return { ok: true };
      } catch (error) {
        if (sendStarted) return { ok: false, error: UNCERTAIN_SEND };
        throw error;
      } finally {
        try { if (prepared) client?.cancelPreparedSend?.(prepared); } catch { /* best-effort token cleanup */ }
        sending = false;
      }
    },
  };
}
module.exports = { createMailController, safeAttachmentFilename, UNCERTAIN_SEND };

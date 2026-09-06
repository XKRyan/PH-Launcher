'use strict';
// Desktop-only boundary: file locations and send confirmation are chosen by
// native dialogs, never supplied as privileged operations by email content.
const path = require('node:path');
const fs = require('node:fs/promises');

const UNCERTAIN_SEND = '发送结果不确定，请先查已发送，不要重复点击';
const LINK_OPEN_ERROR = '无法打开邮件链接，请稍后重试';

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
    async download(input) {
      const before = revision();
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
        // No URL, filesystem path, HTML, BCC or attachments can cross this UI
        // boundary. Mail content is data and cannot invoke this handler.
        prepared = await client.prepareSend({ to: input?.to, cc: input?.cc, subject: input?.subject, text: input?.text });
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

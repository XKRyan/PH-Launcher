(() => {
  'use strict';
  let pending = false;
  window.confirmAction = (message) => {
    if (pending) return Promise.resolve(false);
    pending = true;
    const previousFocus = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'modal api-confirm-dialog';
    dialog.setAttribute('aria-labelledby', 'apiConfirmTitle');
    dialog.setAttribute('aria-describedby', 'apiConfirmDescription');
    dialog.setAttribute('translate', 'no');
    dialog.innerHTML = '<div class="modal-head"><h3 id="apiConfirmTitle"></h3><button type="button" data-dismiss>×</button></div><p id="apiConfirmDescription"></p><div class="modal-actions"><button type="button" class="secondary-button" data-cancel autofocus></button><button type="button" class="primary-button" data-accept></button></div>';
    const translate = () => {
      const en = window.i18n?.locale() === 'en';
      dialog.querySelector('h3').textContent = en ? 'Send attachments to your API provider?' : '将附件发送给 API 服务商？';
      dialog.querySelector('p').textContent = en ? 'The selected attachments will be provided to your configured API provider with this message. Long documents use excerpts; unparsed files provide names only. This may incur charges. Canceling sends nothing.' : '所选附件将随本条消息提供给你配置的 API 服务商。长文仅发送节选，无法解析的文件仅提供文件名。可能产生费用；取消不会发送任何内容。';
      dialog.querySelector('[data-dismiss]').setAttribute('aria-label', en ? 'Close' : '关闭');
      dialog.querySelector('[data-cancel]').textContent = en ? 'Cancel' : '取消';
      dialog.querySelector('[data-accept]').textContent = en ? 'Confirm and send' : '确认发送';
      if (message !== undefined) {
        dialog.querySelector('h3').textContent = en ? 'Confirm action' : '确认操作';
        dialog.querySelector('p').textContent = window.i18n?.t?.(message) || String(message);
        dialog.querySelector('[data-accept]').textContent = en ? 'Confirm' : '确认';
      }
    };
    translate();
    document.body.append(dialog);
    return new Promise(resolve => {
      let settled = false;
      const finish = accepted => {
        if (settled) return;
        settled = true; pending = false;
        window.removeEventListener('ph:language-changed', translate);
        if (dialog.open) dialog.close();
        dialog.remove();
        if (previousFocus?.isConnected) previousFocus.focus();
        resolve(accepted);
      };
      dialog.querySelector('[data-cancel]').onclick = () => finish(false);
      dialog.querySelector('[data-dismiss]').onclick = () => finish(false);
      dialog.querySelector('[data-accept]').onclick = () => finish(true);
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
      dialog.addEventListener('close', () => finish(false));
      window.addEventListener('ph:language-changed', translate);
      try { dialog.showModal(); dialog.querySelector('[data-cancel]').focus(); }
      catch { finish(false); }
    });
  };
  window.confirmApiDisclosure = () => window.confirmAction();
})();

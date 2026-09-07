'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
async function checkLanguage(window, appPath) {
  console.log('LANGUAGE_AUDIT_START');
  const output = path.join(appPath, 'dist', 'language-104'); fs.mkdirSync(output, { recursive: true });
  const report = [];
  await window.webContents.executeJavaScript("state.data.settings.language='en'; window.i18n.apply('en');");
  async function inspect(name) {
    console.log('LANGUAGE_AUDIT_SCREEN ' + name);
    await new Promise(resolve => setTimeout(resolve, 150));
    const result = await window.webContents.executeJavaScript(`(() => {
      const roots=[document.querySelector('.page.active'), document.querySelector('.sidebar'),document.querySelector('.topbar'),...document.querySelectorAll('dialog[open]')].filter(Boolean);
      const missing=new Set();
      for(const root of roots){ const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
        while(node=walker.nextNode()){const e=node.parentElement,v=node.nodeValue.trim();if(!v||!/[\u3400-\u9fff]/.test(v)||!e.getClientRects().length||window.i18n.isProtected(e)||e.tagName==='OPTION')continue;missing.add(v);}
        for(const e of root.querySelectorAll('[placeholder],[aria-label],[title],optgroup[label]')){if(!e.getClientRects().length||e.closest('[translate="no"],[data-i18n-ignore]'))continue;for(const key of ['placeholder','aria-label','title','label']){const v=e.getAttribute(key);if(v&&/[\u3400-\u9fff]/.test(v))missing.add(key+': '+v);}}
      }
      return {missing:[...missing],overflow:document.documentElement.scrollWidth>innerWidth+1};
    })()`);
    report.push({ name, ...result });
    fs.writeFileSync(path.join(output, name + '.png'), (await window.webContents.capturePage(undefined, { stayAwake: true, stayHidden: true })).toPNG());
  }
  for(const route of ['today','plan','notes','dictionary','vocabulary','timetable','calendar','courses','mail','ib','ai','settings']) {
    await window.webContents.executeJavaScript(`navigate(${JSON.stringify(route)});new Promise(r=>setTimeout(r,220))`);
    await inspect(route);
  }
  await window.webContents.executeJavaScript("navigate('vocabulary');new Promise(r=>setTimeout(r,100))");
  for(const action of ['import','add-reading','advisor-connect','settings']) {
    if(action === 'add-reading') await window.webContents.executeJavaScript("document.querySelector('[data-vocab-action=tools]').click();document.querySelector('[data-vocab-action=reading]').click()");
    const selector = `[data-vocab-action="${action}"]`;
    await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.click();new Promise(r=>setTimeout(r,80))`);
    await inspect('vocabulary-' + action);
    await window.webContents.executeJavaScript("document.querySelector('dialog[open]')?.close()");
  }
  await window.webContents.executeJavaScript(`(async () => {
    await window.ph.vocabulary.add([{ word:'evidence', meaning:'证据；根据', context:'The new evidence helped the students explain why the experiment had failed.', subject:'Example words' }]);
    navigate('vocabulary'); await window.vocabularyUI.refresh(); document.querySelector('[data-vocab-action=today]')?.click(); document.querySelector('[data-vocab-action=start]')?.click();
  })()`);
  await new Promise(resolve => setTimeout(resolve, 150));
  await inspect('vocabulary-example');
  await window.webContents.executeJavaScript("document.querySelector('[data-vocab-action=start-batch-recall]')?.click();new Promise(r=>setTimeout(r,100))");
  await window.webContents.executeJavaScript("document.querySelector('[data-vocab-action=reveal]')?.click();document.querySelector('[data-vocab-action=expression]')?.click()");
  await inspect('vocabulary-expression');
  await window.webContents.executeJavaScript("document.querySelector('dialog[open]')?.close();navigate('calendar');new Promise(r=>setTimeout(r,100))");
  await window.webContents.executeJavaScript("document.querySelector('[data-cal-new]').click()");
  await inspect('calendar-recurring');
  await window.webContents.executeJavaScript("document.querySelector('dialog[open]')?.close();state.data.settings.ai={...state.data.settings.ai, enabled:true,provider:'local',localModel:'example-model',localEndpoint:'http://127.0.0.1:11434'};state.aiEditing=false; navigate('ai');renderAi();document.querySelector('#aiAttachments')?.scrollIntoView({block:'end'});");
  await inspect('ai-attachments');
  for (const [width, height, font] of [[1280,800,16], [1600,1000,16], [1280,800,20]]) {
    window.setSize(width, height);
    await window.webContents.executeJavaScript(`document.documentElement.style.fontSize='${font}px';document.querySelector('#aiChat').scrollIntoView({block:'start'});document.querySelector('#chatMessages').innerHTML='<div class="chat-message user"><div class="chat-bubble">Help me plan my study session.</div></div><div class="chat-message assistant"><div class="chat-bubble">Start with your due reviews, then learn five new words.</div></div>';new Promise(r=>setTimeout(r,100))`);
    const layout = await window.webContents.executeJavaScript(`(() => {
      const chat=document.querySelector('.agent-conversation'), dock=chat.querySelector('.chat-input-dock'), messages=chat.querySelector('.chat-messages'), send=document.querySelector('#aiSend');
      const b=send.getBoundingClientRect(), c=chat.getBoundingClientRect();
      return {dockHeight:dock.offsetHeight,chatHeight:chat.offsetHeight,messagesHeight:messages.offsetHeight,sendVisible:b.bottom<=c.bottom&&b.right<=c.right&&b.top>=c.top,overflow:chat.scrollWidth>chat.clientWidth+1};
    })()`);
    assert.ok(layout.dockHeight/layout.chatHeight < .4 && layout.messagesHeight/layout.chatHeight > .6 && layout.sendVisible && !layout.overflow, JSON.stringify(layout));
    report.push({name:`composer-${width}-${font}`, ...layout});
    await inspect(`composer-${width}-${font}`);
  }
  fs.writeFileSync(path.join(output,'report.json'), JSON.stringify(report,null,2));
  console.log('LANGUAGE_AUDIT '+JSON.stringify(report.map(({name,missing,overflow,...layout})=>({name,remaining:missing?.length,overflow,...layout}))));
}
module.exports = { checkLanguage };

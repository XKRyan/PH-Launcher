'use strict';
const fs = require('node:fs');
const path = require('node:path');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Called only by --capture-ui --capture-variant=dialogs, in an isolated profile.
// These cases exercise real UI controls without saving credentials or sending data.
async function checkDialogs(win, outputRoot) {
  win.show(); win.focus();
  const output = path.join(outputRoot, 'dist', 'dialog-audit');
  fs.mkdirSync(output, { recursive: true });
  const run = (code) => win.webContents.executeJavaScript(code);
  await run("window.ph.vocabulary.addStarter('学术表达')");
  const mailCode = fs.readFileSync(path.join(outputRoot,'src','mail-ui.js'),'utf8');
  const mailFixture = `navigate('mail'); await window.mailUI.open(); const fixture={ph:{mail:{status:async()=>({saved:true}),list:async()=>({items:[]}),contacts:async()=>[]}}}; ((window)=>{${mailCode}\n})(fixture); await fixture.mailUI.open(); document.querySelector('[data-mail-compose]').click();`;
  const cases = [
    ['task', "navigate('plan'); openTaskDialog();", '#taskDialog', '.modal-head h3', '.modal-head > button', '.modal-actions button:last-child'],
    // 更新卡片（卡片确认制）：只弹提示，用户在三个按钮里选；这里只验几何与文案。
    // 没有 ✕ 关闭按钮 —— 出口是「取消」或按 Esc，所以 closeSelector 传 null。
    // 排在前面：后面 vocabulary 的用例依赖计时，偶发不稳，别把这条拖下水。
    ['update-card', "showUpdateCard({version:'1.0.11',current:'1.0.9',notes:'更新方式改为卡片确认：进入软件时弹卡片显示版本号与更新内容，可选「取消 / 跳过本版本 / 更新」——只有点「更新」才会下载安装。\\n\\n· 修复 AI 会话里思考内容有时不显示\\n· 修复工具调用线的格式'});", '#updateDialog', '.modal-head h3', null, '.modal-actions button:last-child'],
    ['focus', "navigate('plan'); openFocusSettings();", '#focusSettingsDialog', '.modal-head h3', '.modal-head > button', '.modal-actions button:last-child'],
    ['lesson', "navigate('plan'); openLessonDialog();", '#lessonDialog', '.modal-head h3', '.modal-head > button', '.modal-actions button:last-child'],
    ['website', "await openCustomSiteDialog();", '#customSiteDialog', '.modal-head h3', '.modal-head > button', '.modal-actions button:last-child'],
    ['account', "openCredentialDialog('edupage');", '#credentialDialog', '.modal-head h3', '.modal-head > button', '.modal-actions button:last-child'],
    ['ai-permission', "await openAiControlDialog('confirm');", '#aiControlDialog', '.modal-head h3', '.modal-head > button', '.modal-actions button:last-child'],
    ['ai-full-permission', "state.data.settings.ai.provider='api'; await openAiControlDialog('full');", '#aiControlDialog', '.modal-head h3', '.modal-head > button', '.modal-actions button:last-child'],
    ['calendar', "navigate('calendar'); await window.calendarUI.refresh(); document.querySelector('[data-cal-day]').click();", '.cal-dialog', '.cal-dialog-head h3', '[data-cal-close]', '.cal-form-actions button:last-child'],
    ['vocabulary', "navigate('vocabulary'); await window.vocabularyUI.refresh(); document.querySelector('[data-vocab-action=method]').click();", '#vocabDialog', '.vocab-dialog-head h3', '.vocab-dialog-head > button', '.vocab-dialog-actions button:last-child'],
    ['word-settings', "navigate('vocabulary'); await window.vocabularyUI.refresh(); document.querySelector('[data-vocab-action=settings]').click();", '#vocabDialog', '.vocab-dialog-head h3', '.vocab-dialog-head > button', '.vocab-dialog-actions button:last-child'],
    ['expression', "navigate('vocabulary'); await window.vocabularyUI.refresh(); document.querySelector('[data-vocab-action=today]').click(); document.querySelector('[data-vocab-action=start]').click(); for(let i=0;i<100&&!document.querySelector('.vocab-new-batch,.vocab-study-card');i++) await new Promise(r=>setTimeout(r,50)); while(document.querySelector('[data-vocab-action=batch-next]')) document.querySelector('[data-vocab-action=batch-next]').click(); document.querySelector('[data-vocab-action=start-batch-recall]').click(); document.querySelector('[data-vocab-action=reveal]').click(); document.querySelector('[data-vocab-action=expression]').click();", '#vocabDialog', '.vocab-dialog-head h3', '.vocab-dialog-head > button', '.vocab-dialog-actions button:last-child'],
    ['school-conflict', "navigate('class-timetable'); await window.schoolUI.open('class-timetable'); document.querySelector('[data-school-action=lesson-cluster]').click();", '.school-dialog', '.modal-head h3', '.modal-head > button', '.school-dialog-footer button:last-child'],
    ['school-details', "navigate('class-timetable'); await window.schoolUI.open('class-timetable'); document.querySelector('[data-school-action=lesson-cluster]').click(); document.querySelector('.school-conflict-row').click();", '.school-dialog', '.modal-head h3', '.modal-head > button', '.school-dialog-footer button:last-child'],
    ['command', "openCommandPalette();", '#commandDialog', '.command-search', null, '.command-hint span:last-child'],
    ['mail-compose', mailFixture, '.mail-compose', '.mail-compose-head h3', '.mail-close-compose', '.mail-compose-actions button:last-child'],
  ];
  const reports = [];
  for (const [size, width, height, fontSize] of [['normal',1440,900,16],['large-small-window',1040,700,24]]) {
    win.setSize(width, height);
    await run(`state.data.settings.appearance = { ...state.data.settings.appearance, fontSize:${fontSize} }; window.appearanceUI.apply(state.data.settings.appearance);`);
    await pause(150);
    for (const [name, open, selector, titleSelector, closeSelector, footerSelector] of cases) {
      await run("document.querySelectorAll('dialog[open]').forEach(d=>d.close()); document.querySelector('[data-mail-compose-close]')?.click();");
      await pause(25);
      await run(`(async()=>{ ${open} })()`);
      await pause(650);
      await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const selectors = JSON.stringify({ selector, titleSelector, closeSelector, footerSelector, name });
      const top = await run(`(() => {
        const s=${selectors}, d=document.querySelector(s.selector);
        if (!d || !d.getBoundingClientRect().height) throw Error('Dialog did not open: '+s.name);
        d.scrollTop=0;
        const r=d.getBoundingClientRect(), t=d.querySelector(s.titleSelector).getBoundingClientRect();
        const c=s.closeSelector ? d.querySelector(s.closeSelector).getBoundingClientRect() : null;
        return { font:getComputedStyle(document.documentElement).fontSize, bounds:[r.left,r.top,r.right,r.bottom,innerWidth,innerHeight], inside:r.left>=15&&r.top>=15&&r.right<=innerWidth-15&&r.bottom<=innerHeight-15,
          titleLeft:t.left-r.left,titleTop:t.top-r.top,closeRight:c?r.right-c.right:null,closeTop:c?c.top-r.top:null,
          closeSquare:c?Math.abs(c.width-c.height)<1:true,noHorizontalOverflow:d.scrollWidth<=d.clientWidth+1 };
      })()`);
      fs.writeFileSync(path.join(output, `${size}-${name}.png`), (await win.webContents.capturePage()).toPNG());
      await run(`document.querySelector(${JSON.stringify(selector)}).scrollTop=100000;`);
      await pause(35);
      const bottom = await run(`(() => {
        const s=${selectors},d=document.querySelector(s.selector),r=d.getBoundingClientRect();
        const buttons=d.querySelectorAll(s.footerSelector),b=buttons[buttons.length-1]?.getBoundingClientRect();
        return {footerBottom:b?r.bottom-b.bottom:0,footerRight:b?r.right-b.right:0,footerVisible:Boolean(b&&b.top>=r.top&&b.bottom<=r.bottom)};
      })()`);
      const passed = top.font===fontSize+'px' && top.inside && top.closeSquare && top.noHorizontalOverflow
        && (['command','update-card'].includes(name) || top.titleLeft>=19 && top.titleTop>=19 && top.closeRight>=19 && top.closeTop>=19)
        && bottom.footerVisible && bottom.footerBottom>=12 && bottom.footerRight>=19;
      const report = {size,name,...top,...bottom,passed}; reports.push(report);
      if (!passed) fs.writeFileSync(path.join(output, `${size}-${name}-bottom.png`), (await win.webContents.capturePage()).toPNG());
      console.log(`DIALOG_CHECK ${JSON.stringify(report)}`);
    }
  }
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(reports,null,2));
  if (reports.some((r)=>!r.passed)) throw new Error('Dialog geometry checks failed');
  return reports;
}
module.exports = { checkDialogs };

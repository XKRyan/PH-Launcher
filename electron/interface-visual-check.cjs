'use strict';
const fs=require('node:fs');
const path=require('node:path');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function checkInterfaces(win, appRoot) {
  const output=path.join(appRoot,'dist','interface-audit'); fs.mkdirSync(output,{recursive:true});
  const run=code=>win.webContents.executeJavaScript(code);
  win.show(); win.focus(); win.setSize(1440,900);
  await run("(async()=>{await window.ph.vocabulary.addStarter('学术表达');})()");
  const results=[], untranslated=new Set();
  for(const language of ['zh-CN','en']) {
    await run(`(async()=>{ await window.ph.settings.setLanguage(${JSON.stringify(language)}); state.data.settings.language=${JSON.stringify(language)}; window.i18n.apply(${JSON.stringify(language)}); })()`);
    for(const route of ['today','settings','vocabulary','plan','ai','mail','calendar','timetable','courses','notes','ib','dictionary']) {
      await run(`document.querySelectorAll('dialog[open]').forEach(d=>d.close()); navigate(${JSON.stringify(route)});`);
      if(route==='vocabulary') await run('window.vocabularyUI.refresh()');
      await pause(300);
      await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const result=await run(`(() => {
        const page=document.querySelector('.page.active');
        const walker=document.createTreeWalker(page,NodeFilter.SHOW_TEXT);let node;const remaining=[];
        while(node=walker.nextNode()) { const el=node.parentElement; if(!el?.getBoundingClientRect().height || el.closest('script,style,textarea,[data-i18n-ignore],.vocab-meaning,.dictionary-definition,blockquote')) continue; const text=node.nodeValue.trim();if(/[\u3400-\u9fff]/.test(text)) remaining.push(text); }
        return {route:${JSON.stringify(route)},language:document.documentElement.lang,title:document.querySelector('#topTitle').textContent,font:getComputedStyle(document.documentElement).fontSize,remaining:[...new Set(remaining)]};
      })()`);
      results.push(result); if(language==='en') for(const value of result.remaining) untranslated.add(value);
      fs.writeFileSync(path.join(output,language+'-'+route+'.png'),(await win.webContents.capturePage()).toPNG());
    }
  }
  for(const [name,code] of [
    ['batch',"navigate('vocabulary'); await window.vocabularyUI.refresh(); document.querySelector('[data-vocab-action=start]').click(); for(let i=0;i<100&&!document.querySelector('.vocab-new-batch,.vocab-study-card');i++) await new Promise(r=>setTimeout(r,50));"],
    ['expression',"while(document.querySelector('[data-vocab-action=batch-next]')) document.querySelector('[data-vocab-action=batch-next]').click(); document.querySelector('[data-vocab-action=start-batch-recall]').click(); document.querySelector('[data-vocab-action=reveal]').click(); document.querySelector('[data-vocab-action=expression]').click();"],
    ['focus',"document.querySelector('#vocabDialog')?.close(); navigate('plan'); openFocusSettings();"],
    ['ai-back',"document.querySelectorAll('dialog[open]').forEach(d=>d.close()); navigate('ai'); state.data.settings.ai={...state.data.settings.ai,enabled:true,provider:'local',localModel:'Local model'}; state.aiEditing=false; renderAi(); beginAiEditing();"],
  ]) {
    await run(`(async()=>{${code}})()`); await pause(350); await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(output,'en-'+name+'.png'),(await win.webContents.capturePage()).toPNG());
  }
  const mailCode = fs.readFileSync(path.join(appRoot,'src','mail-ui.js'),'utf8');
  await run(`(async()=>{
    document.querySelectorAll('dialog[open]').forEach(d=>d.close()); navigate('mail');
    const mailRoot=document.getElementById('mailPage'); mailRoot.replaceWith(mailRoot.cloneNode(false));
    const fixture={ph:{mail:{status:async()=>({saved:true}),list:async()=>({items:[{uid:'42',subject:'Password Reset Request',from:[{name:'ManageBac',address:'notice@example.com'}],date:'2026-09-06T12:00:00Z',unread:true}]}),contacts:async()=>[],read:async uid=>({uid,subject:'Password Reset Request',from:[{name:'ManageBac',address:'notice@example.com'}],to:[{address:'student@example.com'}],text:'Please click the button to reset your password.',links:[{id:'link-fixture',label:'Reset password',host:'shph.managebac.cn'}]}),openLink:async()=>{throw Error('Diagnostic never opens links');}}}};
    ((window)=>{${mailCode}\n})(fixture); await fixture.mailUI.open(); document.querySelector('[data-mail-open="42"]').click();
  })()`);
  await pause(350);await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await run("window.i18n.apply('en');");
  fs.writeFileSync(path.join(output,'en-mail-links.png'),(await win.webContents.capturePage()).toPNG());
  await run("(async()=>{navigate('ai'); state.aiEditing=false; renderAi(); state.data.settings.ai.provider='api'; await openAiControlDialog('full');})()");
  await pause(350);await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(output,'en-full-permission.png'),(await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));
  fs.writeFileSync(path.join(output,'untranslated.json'),JSON.stringify([...untranslated],null,2));
  console.log('INTERFACE_CHECK '+JSON.stringify({pages:results.length,untranslated:untranslated.size,output}));
  await run("document.querySelectorAll('dialog[open]').forEach(d=>d.close()); navigate('plan'); setPlanTab('focus'); ensureTimer().goal='Finish exercises 1–5'; ensureTimer().target=''; toggleTimer(); setNavCountBadge('#navTaskCount','[data-route=plan]','计划',6); updateVocabularyBadge({due:6});");
  for(const [preset,primary,paper,fontSize] of [['ocean','#203f60','#edf3f7',16],['plum','#513449','#f7f0f3',24]]) {
    await run(`(async()=>{ state.data.settings.appearance={preset:${JSON.stringify(preset)},primary:${JSON.stringify(primary)},paper:${JSON.stringify(paper)},fontSize:${fontSize}}; await window.ph.data.save(state.data); window.appearanceUI.apply(state.data.settings.appearance); })()`);
    await pause(300);await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(output,'theme-'+preset+'-focus.png'),(await win.webContents.capturePage()).toPNG());
  }
  await run('resetTimer()');
}
module.exports={checkInterfaces};

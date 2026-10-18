// Isolated, synthetic render audit. Never connects to a school or submits work.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-course-visual-'));
app.setPath('userData', profile); app.setPath('sessionData', profile);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, cb) => cb({ cancel: true }));
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, ...details) => console.log('Renderer:', JSON.stringify(details)));
  const run = async code => { try { return await win.webContents.executeJavaScript(code); } catch (error) { console.error('Failed script:', code.slice(0, 180)); throw error; } };
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<html><body style="overflow:auto"><section id="schoolPage" class="page active"></section></body></html>'));
  for (const file of ['styles.css', 'school.css', 'refinements.css', 'dialogs.css']) await win.webContents.insertCSS(fs.readFileSync(path.join(root, 'src', file), 'utf8'));
  await run(`
    window.fixtureUploads = 0;
    const courses = [{id:'21',name:'Biology HL',grade:'6'},{id:'22',name:'English A',grade:'6'}];
    const tasks = [
      {id:'21:31',courseId:'21',course:'Biology HL',title:'Enzyme investigation report',status:'Not submitted',dueAt:'2026-10-20T15:59:00Z'},
      {id:'22:32',courseId:'22',course:'English A',title:'Reading response',status:'Not yet submitted',dueAt:'2026-10-17T15:59:00Z'},
      {id:'21:33',courseId:'21',course:'Biology HL',title:'Cell structure worksheet',status:'Submitted',dueAt:'2026-10-15T15:59:00Z'}];
    const snapshot = {managebac:{courses,tasks,fetchedAt:new Date().toISOString(),accountKey:'synthetic'},preferences:{},status:{},epochs:{managebac:1},accounts:{managebac:{saved:true}}};
    window.ph={school:{get:async()=>snapshot,sync:async()=>snapshot,preferences:async()=>snapshot,
      course:async id=>({id,name:courses.find(c=>c.id===id).name,grade:'6',tasks:tasks.filter(t=>t.courseId===id),files:[],events:[]}),
      task:async(cid,id)=>({...tasks.find(t=>t.id===cid+':'+id),description:'Explain how temperature affects enzyme activity.\\n\\nInclude a graph, describe your method and evaluate the reliability of the results.',attachments:[{name:'Investigation guide.pdf',url:'https://shph.managebac.cn/attachments/10/download'}],url:'https://shph.managebac.cn/student/classes/'+cid+'/core_tasks/'+id}),
      prepareTaskUpload:async()=>({token:'synthetic',filename:'Biology investigation.docx',size:18432,courseId:'21',taskId:'31'}),
      submitTaskUpload:async()=>{window.fixtureUploads++;return {verification:'unverified'}},cancelTaskUpload:async()=>({ok:true})}};
    window.openSite=async()=>{}; void 0;
  `);
  for (const file of ['locales/en.js', 'i18n.js', 'course-order.js', 'school-ui.js']) await run(fs.readFileSync(path.join(root, 'src', file), 'utf8') + '\n;void 0;');
  await run("window.schoolUI.open('courses')");
  const out = path.join(root, '.cache/v2-visual'); fs.mkdirSync(out, { recursive: true });
  const wait = () => new Promise(resolve => setTimeout(resolve, 150));
  const capture = async name => { await wait(); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  await run("document.querySelector('[data-course-tab=tasks]').click()");
  await capture('tasks-zh');
  await run("document.querySelector('[data-school-action=task][data-id=\"31\"]').click()");
  await capture('task-detail-zh');
  await run("document.querySelector('[data-school-action=prepare-task-upload]').click()"); await wait();
  await run("document.querySelector('.school-upload-confirm').scrollIntoView({block:'center'})");
  await capture('upload-confirm-zh');
  assert.equal(await run('window.fixtureUploads'), 0);
  await run("window.i18n.apply('en')");
  await capture('upload-confirm-en');
  win.setSize(1040, 700);
  await run("document.documentElement.style.fontSize='24px'"); await wait();
  const geometry = await run(`(() => {
    const dialog=document.querySelector('.school-dialog').getBoundingClientRect();
    const footer=document.querySelector('.school-dialog-footer').getBoundingClientRect();
    return {dialogInside:dialog.left>=0&&dialog.right<=innerWidth&&dialog.bottom<=innerHeight,footerInside:footer.bottom<=innerHeight, horizontal:document.querySelector('.school-dialog-content').scrollWidth<=document.querySelector('.school-dialog-content').clientWidth+1};
  })()`);
  assert.equal(geometry.dialogInside, true); assert.equal(geometry.footerInside, true); assert.equal(geometry.horizontal, true);
  await capture('upload-compact-en');
  console.log(JSON.stringify({success:true,geometry,out})); app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});

// Isolated, synthetic render audit. Never connects to a school or submits work.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const rendererRoot = process.env.PHL_TEST_APP_ASAR || root;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-course-visual-'));
app.setPath('userData', profile); app.setPath('sessionData', profile);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, cb) => cb({ cancel: true }));
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, ...details) => console.log('Renderer:', JSON.stringify(details)));
  const run = async code => { try { return await win.webContents.executeJavaScript(code); } catch (error) { console.error('Failed script:', code.slice(0, 180)); throw error; } };
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<html><body style="overflow:auto"><section id="schoolPage" class="page active"></section></body></html>'));
  for (const file of ['styles.css', 'school.css', 'refinements.css', 'dialogs.css']) await win.webContents.insertCSS(fs.readFileSync(path.join(rendererRoot, 'src', file), 'utf8'));
  await run(`
    window.fixtureUploads = 0;
    const courses = [{id:'21',name:'Biology HL',grade:'6'},{id:'22',name:'English A',grade:'6'}];
    const tasks = [
      {id:'21:31',courseId:'21',course:'Biology HL',title:'Enzyme investigation report',status:'Not submitted',dueAt:'2026-10-20T15:59:00Z'},
      {id:'22:32',courseId:'22',course:'English A',title:'Reading response',status:'Not yet submitted',dueAt:'2026-10-17T15:59:00Z'},
      {id:'21:33',courseId:'21',course:'Biology HL',title:'Cell structure worksheet',status:'Submitted',dueAt:'2026-10-15T15:59:00Z'}];
    const snapshot = {managebac:{courses,tasks,fetchedAt:new Date().toISOString(),accountKey:'synthetic'},preferences:{},status:{},epochs:{managebac:1},accounts:{managebac:{saved:true}}};
    window.fixtureSnapshot=snapshot;
    window.ph={school:{get:async()=>snapshot,sync:async()=>snapshot,preferences:async change=>{snapshot.preferences={...snapshot.preferences,...change};return snapshot;},
      course:async id=>({id,name:courses.find(c=>c.id===id).name,grade:'6',tasks:tasks.filter(t=>t.courseId===id),files:[],events:[]}),
      task:async(cid,id)=>({...tasks.find(t=>t.id===cid+':'+id),uploadAvailable:true,submissionRequired:true,description:'Explain how temperature affects enzyme activity.\\n\\nInclude a graph, describe your method and evaluate the reliability of the results.',attachments:[{name:'Investigation guide.pdf',url:'https://shph.managebac.cn/attachments/10/download'}],url:'https://shph.managebac.cn/student/classes/'+cid+'/core_tasks/'+id}),
      prepareTaskUpload:async()=>({token:'synthetic',filename:'Biology investigation.docx',size:18432,courseId:'21',taskId:'31'}),
      submitTaskUpload:async()=>{window.fixtureUploads++;return {verification:'unverified'}},cancelTaskUpload:async()=>({ok:true})}};
    window.openSite=async()=>{}; void 0;
  `);
  for (const file of ['locales/en.js', 'i18n.js', 'course-order.js', 'school-selection-inference.js', 'school-tasks.js', 'school-ui.js']) await run(fs.readFileSync(path.join(rendererRoot, 'src', file), 'utf8') + '\n;void 0;');
  await run("window.i18n.mount('zh-CN'); window.schoolUI.open('courses')");
  const out = path.join(root, '.cache/v2-visual'); fs.mkdirSync(out, { recursive: true });
  const wait = () => new Promise(resolve => setTimeout(resolve, 150));
  const capture = async name => {
    win.showInactive();
    for (let attempt = 0; attempt < 5; attempt++) {
      win.webContents.invalidate();
      await new Promise(resolve => setTimeout(resolve, 400));
      const image = await win.webContents.capturePage(undefined, { stayAwake: true });
      const pixels = image.toBitmap(); const colors = new Set();
      for (let i = 0; i + 4 <= pixels.length; i += 400) colors.add(pixels.readUInt32LE(i));
      if (colors.size > 20) { fs.writeFileSync(path.join(out, name + '.png'), image.toPNG()); return; }
    }
    throw new Error('Blank renderer capture: ' + name);
  };
  await capture('courses-new-zh');
  await run("document.querySelector('[data-school-action=course]').click()"); await wait();
  await capture('course-detail-new-zh');
  await run("window.i18n.apply('en')");
  await capture('course-detail-new-en');
  await run("document.querySelector('[data-school-action=course-detail-tab][data-tab=tasks]').click()");
  await capture('class-tasks-new-en');
  await run("document.querySelector('[data-school-action=class-task-filter][data-filter=completed]').click()");
  assert.equal(await run("document.querySelectorAll('.school-course-panel [data-school-action=task]').length"),1);
  await run("document.querySelector('[data-school-action=course-detail-tab][data-tab=overview]').click()");
  win.setSize(780, 650); await wait();
  assert.equal(await run("document.querySelector('#schoolPage').scrollWidth <= document.querySelector('#schoolPage').clientWidth + 1"), true);
  await capture('course-detail-compact-en');
  await run("document.querySelector('[data-school-action=course-list]').click(); window.i18n.apply('zh-CN')");
  win.setSize(1280, 900);
  await run("document.querySelector('[data-course-tab=notifications]').click()");
  await capture('notifications-new-zh');
  assert.equal(await run("document.querySelectorAll('.school-task-row').length"), 2);
  await run("document.querySelector('[data-course-tab=tasks]').click()");
  await capture('tasks-zh');
  assert.equal(await run("document.querySelectorAll('.school-task-overview button').length"), 3);
  await run("document.querySelector('[data-school-action=task-reminders]').click()");
  await capture('task-reminders-zh');
  await run("window.i18n.apply('en')");
  await capture('task-reminders-en');
  assert.match(await run("document.querySelector('dialog').textContent"), /Task reminders/);
  win.setSize(1040, 700);
  await run("document.documentElement.style.fontSize='24px'"); await wait();
  const reminderGeometry = await run(`(() => {
    const box = document.querySelector('.school-dialog').getBoundingClientRect();
    const content = document.querySelector('.school-dialog-content');
    return { inside: box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight, horizontal: content.scrollWidth <= content.clientWidth + 1 };
  })()`);
  assert.equal(reminderGeometry.inside, true); assert.equal(reminderGeometry.horizontal, true);
  await capture('task-reminders-compact-en');
  await run("document.querySelector('dialog').close(); document.documentElement.style.fontSize='16px'; window.i18n.apply('zh-CN')");
  win.setSize(1280, 900);
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
  // Exercise failed assignment reads with same-account cached tasks in the real renderer.
  await run("document.querySelector('dialog').close(); document.documentElement.style.fontSize=''; window.ph.school.course=async id=>({id,name:'Biology HL',tasks:[],tasksStatus:'error'}); window.schoolUI.open('courses')");
  win.setSize(1280,900); await wait();
  await run("document.querySelector('[data-course-tab=courses]').click(); document.querySelector('[data-school-action=course]').click()"); await wait();
  await run("document.querySelector('[data-school-action=course-detail-tab][data-tab=tasks]').click()");
  assert.ok(await run("document.querySelector('.school-task-cache-label') !== null"));
  await capture('assignment-read-error-en');
  await run("window.i18n.apply('zh-CN')"); win.setSize(780,650); await wait();
  assert.ok(await run("document.querySelector('#schoolPage').scrollWidth <= document.querySelector('#schoolPage').clientWidth + 1"));
  await capture('assignment-read-error-compact-zh');
  await run(`(() => {
    const d=new Date();d.setDate(d.getDate()-((d.getDay()+6)%7));const week=[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
    window.fixtureSnapshot.edupage={accountKey:'edu',weekStart:week,fetchedAt:new Date().toISOString(),lessons:[{id:'lesson',groupKey:'g',course:'Biology HL',date:week,start:'08:00',end:'08:40',groups:[],teacher:'Sample Teacher',room:'A101'}],options:[]};
    window.fixtureSnapshot.preferences={accountKey:'edu',groups:['g']};
    window.schoolUI.open('timetable');
  })()`); await wait(); win.setSize(1280,900); await wait();
  await capture('unified-timetable-zh');
  await run("window.i18n.apply('en')"); await capture('unified-timetable-en');
  await run("document.querySelector('[data-school-action=lesson]').click()"); await wait();
  assert.equal(await run("document.querySelector('[data-tab=tasks]').getAttribute('aria-current')"),'page');
  assert.ok(await run("document.querySelector('[data-school-action=relink-course]') !== null"));
  assert.match(await run("document.querySelector('.school-course-breadcrumb').textContent"),/Back to timetable/);
  await capture('linked-assignments-en');
  win.setSize(780,650);await wait();
  assert.ok(await run("document.querySelector('#schoolPage').scrollWidth<=document.querySelector('#schoolPage').clientWidth+1"));
  await capture('linked-assignments-compact-en');
  await run("document.querySelector('.school-course-breadcrumb button').click()");await wait();
  assert.ok(await run("document.querySelector('[data-school-action=lesson]') !== null"));
  await run("window.schoolUI.open('courses')"); await wait();
  assert.ok(await run("document.querySelector('[data-course-tab=timetable]').getAttribute('aria-current')==='page'"));
  await run("document.querySelector('[data-course-tab=courses]').click()");
  await run("const picker=document.querySelector('[data-school-field=class-switch]');picker.value='22';picker.dispatchEvent(new Event('change',{bubbles:true}))"); await wait();
  await run("document.querySelector('[data-school-action=course-list]').click(); window.ph.school.course=()=>new Promise(()=>{}); document.querySelector('[data-school-action=course]').click()"); await wait();
  assert.ok(await run("document.querySelector('[data-tab=tasks]') !== null"));
  await run("document.querySelector('[data-tab=tasks]').click()");
  assert.ok(await run("document.querySelector('.school-task-cache-label') !== null"));
  await capture('course-loading-cache-en');
  await run("document.querySelector('[data-school-action=course-list]').click()");
  assert.ok(await run("document.querySelector('.school-course-card') !== null"));
  await run(`
    window.fixtureSnapshot.managebac.tasks.push(
      {id:'21:35',courseId:'21',course:'Biology HL',title:'Read the enzyme chapter',category:'Coursework',submissionRequired:false},
      {id:'managebac:event:21:36',courseId:'21',course:'Biology HL',title:'Laboratory assessment',category:'Assessment',kind:'event',start:'2099-11-04',dueAt:'2099-11-04T00:00:00+08:00',submissionRequired:false,allDay:true,description:'Attend the practical assessment in the laboratory.',content:[{type:'text',text:'Attend the practical assessment in the laboratory.\\nBring a calculator.'},{type:'image',url:'https://shph.managebac.cn/attachments/99/image.png',alt:'Exercise image'}],attachments:[{name:'Worksheet.pdf',url:'https://shph.managebac.cn/attachments/100/download'}]}
    );
    document.querySelector('[data-course-tab=tasks]').click();
  `);
  win.setSize(1280,900); await wait(); await capture('unified-tasks-en');
  assert.ok(await run("document.querySelector('[data-course-tab=tasks]').textContent === 'Tasks'"));
  await run("document.querySelector('[data-school-action=calendar-task]').click()");
  assert.ok(await run("document.querySelector('dialog').textContent.includes('Attend the practical') && !document.querySelector('dialog [data-school-action=prepare-task-upload]')"));
  await run("window.ph.school.resource=async()=> 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5moAAAAASUVORK5CYII=';document.querySelector('dialog [data-school-action=original]').dataset.url='https://shph.managebac.cn/attachments/99/image.png';window.ph.school.openUrl=async()=>({ok:true});void 0");
  // The first request ran before the mock existed; retry its fallback through a new modal.
  await run("document.querySelector('dialog').close();document.querySelector('[data-school-action=calendar-task]').click()");await wait();
  assert.ok(await run("document.querySelector('dialog img.school-task-image')?.naturalWidth===1 && document.querySelector('dialog').textContent.includes('Worksheet.pdf')"));
  await capture('event-task-en');
  await run("document.querySelector('dialog').close();window.ph.school.course=async id=>({id,name:'English language and literature — course title with a long descriptive name',units:[{id:'1',title:'Exploring Truth and Lies',level:'SL',start:'Starts W1 Sep',duration:'3 Weeks',state:'current',tasks:0,lessons:0},{id:'2',title:'The study of narrative, perspective and literary devices in extended creative writing',level:'HL',start:'Starts W2 Nov',duration:'6 Weeks',state:'completed',tasks:2,lessons:5}],tasks:[],files:[],events:[]});window.schoolUI.open('courses');void 0");
  await run("document.querySelector('[data-course-tab=courses]').click();document.querySelector('[data-school-action=course]').click()");await wait();
  await run("document.querySelector('[data-tab=units]').click()");await wait();
  assert.ok(await run("document.querySelectorAll('.school-unit-card').length===2 && !document.querySelector('#schoolPage').textContent.includes('Weekly Planner')"));
  await capture('structured-units-en');
  await run("window.i18n.apply('zh-CN')");win.setSize(780,650);await wait();await capture('structured-units-compact-zh');await run("window.schoolUI.openTasks()");

  await run("document.querySelector('dialog')?.close();window.i18n.apply('zh-CN')");
  win.setSize(780,650); await wait();
  assert.ok(await run("document.querySelector('#schoolPage').scrollWidth<=document.querySelector('#schoolPage').clientWidth+1"));
  await capture('unified-tasks-compact-zh');
  await run("document.querySelector('.school-task-list').scrollIntoView({block:'center'})"); await wait();
  await capture('unified-tasks-compact-rows-zh');
  await run("document.querySelector('[data-course-tab=timetable]').click()"); await wait();
  await run("window.schoolUI.open('courses')"); await wait();
  assert.ok(await run("document.querySelector('[data-course-tab=timetable]').getAttribute('aria-current')==='page'"));
  const savedSnapshot = await run('JSON.stringify(window.fixtureSnapshot)');
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<html><body><section id="schoolPage" class="page active"></section></body></html>'));
  for (const file of ['styles.css', 'school.css', 'refinements.css', 'dialogs.css']) await win.webContents.insertCSS(fs.readFileSync(path.join(rendererRoot, 'src', file), 'utf8'));
  await run(`window.fixtureSnapshot=${savedSnapshot};window.ph={school:{get:async()=>window.fixtureSnapshot,preferences:async change=>{window.fixtureSnapshot.preferences={...window.fixtureSnapshot.preferences,...change};return window.fixtureSnapshot;}}};void 0;`);
  for (const file of ['locales/en.js', 'i18n.js', 'school-tasks.js', 'school-ui.js']) await run(fs.readFileSync(path.join(rendererRoot, 'src', file), 'utf8')+'\n;void 0;');
  await run("window.i18n.mount('en');window.schoolUI.open('courses')");await wait();
  assert.ok(await run("document.querySelector('[data-course-tab=timetable]').getAttribute('aria-current')==='page'"));
  await capture('remembered-timetable-restart-en');
  console.log(JSON.stringify({success:true,geometry,out})); app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});

// Actual isolated Electron popup: synthetic tasks only, no school requests.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { createReminderWindowManager } = require('../../electron/reminder-window.cjs');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-task-popup-'));
app.setPath('userData', profile); app.setPath('sessionData', profile); app.disableHardwareAcceleration();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*/*','http://*/*'] }, (_, cb) => cb({cancel:true}));
  let opened = 0;
  const manager = createReminderWindowManager({BrowserWindow,ipcMain,path,getLanguage:()=> 'en',onOpenTask:()=>opened++});
  const item={id:'tasks',kind:'task',title:'2 assignment reminders',body:'New · Biology HL · Enzyme investigation\n\nDue soon · English A · Reading response · 11/3 18:00'};
  manager.upsert(item); await delay(1500);
  const win=BrowserWindow.getAllWindows()[0];
  assert.equal(await win.webContents.executeJavaScript('document.querySelector("#snooze").hidden'),true);
  assert.equal(await win.webContents.executeJavaScript('document.querySelector("#complete").textContent'),'View assignments');
  manager.upsert({...item,title:'1 assignment reminder',body:'Due soon · English A · Reading response · 11/3 18:00'});
  await delay(400); assert.equal(BrowserWindow.getAllWindows().length,1);
  const out=path.resolve(__dirname,'../../.cache/v2-visual/task-popup.png');
  fs.writeFileSync(out,(await win.webContents.capturePage(undefined,{stayAwake:true})).toPNG());
  assert.match(await win.webContents.executeJavaScript('document.body.textContent'),/1 assignment reminder/);
  await win.webContents.executeJavaScript('document.querySelector("#complete").click()'); await delay(200);
  assert.equal(opened,1); assert.equal(BrowserWindow.getAllWindows().length,0);
  assert.equal(manager.upsert(item,{open:false}),false);
  manager.dispose(); console.log(JSON.stringify({success:true,out}));app.exit(0);
}).catch(e=>{console.error(e);app.exit(1)});
// Keep test alive when its final window is intentionally closed.
app.on('window-all-closed',()=>{});

// Actual Electron check. The native bridges are replaced only in this isolated
// test process, so no installed reader or browser is opened.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron:electron}=require(process.env.PHL_PLAYWRIGHT_PATH || '@playwright/test');
const root=path.resolve(__dirname,'..');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'phl-vlmreader-ui-'));
const {PROJECT_URL,DOWNLOAD_URL,ACCELERATED_URL}=require('../electron/vlmreader-launcher.cjs');
const env={...process.env,PHL_DATA_DIR:path.join(profile,'data')};delete env.ELECTRON_RUN_AS_NODE;
fs.mkdirSync(path.join(env.PHL_DATA_DIR,'phl'),{recursive:true});
fs.writeFileSync(path.join(env.PHL_DATA_DIR,'phl/launcher.json'),JSON.stringify({version:999,settings:{onboardingCompleted:true,schoolStartupSync:false}}));
(async()=>{
 const app=await electron.launch({executablePath:require('electron'),args:[root,'--ph-quit-after=60'],env,timeout:30000});
 try{
  await app.evaluate(({ipcMain},info)=>{
   globalThis.readerLinks=[];
   ipcMain.removeHandler('system:vlmreader-open');ipcMain.handle('system:vlmreader-open',()=>info);
   ipcMain.removeHandler('system:open-url');ipcMain.handle('system:open-url',(_e,url)=>{globalThis.readerLinks.push(url);});
  },{opened:false,version:'0.6.16',projectUrl:PROJECT_URL,downloadUrl:DOWNLOAD_URL,acceleratedUrl:ACCELERATED_URL});
  let page;
  for(let i=0;i<100;i++){
   page=app.windows().find(p=>p.url().endsWith('/src/index.html'));
   if(page&&await page.evaluate(()=>Boolean(window.navigate)).catch(()=>false))break;
   await new Promise(r=>setTimeout(r,100));
  }
  assert.ok(page);await page.locator('#vlmReaderNav').click();
  const download=page.getByRole('button',{name:'下载 VLMReader',exact:true});await download.waitFor();
  assert.equal(await page.locator('#vlmDownloadSource').inputValue(),'accelerated');
  await download.click();assert.deepEqual(await app.evaluate(()=>globalThis.readerLinks),[ACCELERATED_URL]);
  await page.locator('#vlmDownloadSource').selectOption('official');await download.click();
  assert.deepEqual(await app.evaluate(()=>globalThis.readerLinks),[ACCELERATED_URL,DOWNLOAD_URL]);
  await page.evaluate(()=>window.i18n.apply('en'));
  await page.getByRole('button',{name:'Download VLMReader',exact:true}).waitFor();
  await page.evaluate(()=>window.i18n.apply('zh-CN'));
  await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('system:vlmreader-open');ipcMain.handle('system:vlmreader-open',()=>({opened:true}));});
  await page.getByRole('button',{name:'重新检测安装',exact:true}).click();
  await page.getByRole('button',{name:'再次打开',exact:true}).waitFor();
  assert.equal(await page.locator('[data-vlm-action="download"]').count(),0);
  console.log('PASS: sidebar replacement, in-app download page, default mirror, official download, installation retry, bilingual labels and native-open state.');
 }finally{await app.close();console.log('Isolated UI profile: '+profile);}
})().catch(e=>{console.error(e);process.exitCode=1;});

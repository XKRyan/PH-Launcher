const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const { createVlmReaderLauncher, PROJECT_URL, DOWNLOAD_URL, ACCELERATED_URL } = require('../electron/vlmreader-launcher.cjs');

test('registered custom installations open directly, including a path with spaces', async () => {
  const opened = [];
  const file = 'E:\\Study Apps\\VLMReader\\release\\win-unpacked\\VLMReader.exe';
  const launch = createVlmReaderLauncher({ platform:'win32', env:{}, readInstallLocations:async()=>['E:\\Study Apps\\VLMReader'], exists:p=>p===file, openPath:async p=>{opened.push(p);return '';} });
  assert.equal((await launch.open()).opened, true);
  assert.deepEqual(opened,[file]);
});

test('missing or broken installations provide download information without opening the browser', async () => {
  for (const exists of [()=>false,()=>true]) {
    const launch = createVlmReaderLauncher({platform:'win32',env:{},readInstallLocations:async()=>[],exists,openPath:async()=> 'Windows rejected the executable'});
    const result = await launch.open();
    assert.equal(result.opened,false);
    assert.equal(result.acceleratedUrl, 'https://gh-proxy.org/' + result.downloadUrl);
    assert.match(result.downloadUrl,/\/releases\/download\/v0\.6\.16\/VLMReader-Setup-0\.6\.16-x64\.msi$/);
  }
});

test('repeated clicks share one native launch, and installation is rechecked later', async () => {
  let calls=0, installed=true;
  const launch=createVlmReaderLauncher({platform:'win32',env:{},readInstallLocations:async()=>[],exists:()=>installed,openPath:async()=>{calls++;await new Promise(r=>setImmediate(r));return '';} });
  const [a,b]=await Promise.all([launch.open(),launch.open()]);
  assert.equal(a.opened,true);assert.equal(b.opened,true);assert.equal(calls,1);
  installed=false;assert.equal((await launch.open()).opened,false);
});

async function ui(opened=false) {
  const {window}=parseHTML('<html><body><section id="vlmReaderPage"></section></body></html>');
  const links=[];let checks=0;
  window.ph={system:{openVlmReader:async()=>{checks++;return {opened,version:'0.6.16',projectUrl:PROJECT_URL,downloadUrl:DOWNLOAD_URL,acceleratedUrl:ACCELERATED_URL};},openUrl:async url=>links.push(url)}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/vlmreader-ui.js'),'utf8'),{window,document:window.document,console});
  await window.vlmReaderUI.open();
  return {window,document:window.document,links,checks:()=>checks};
}
const click=async(ui,action)=>{ui.document.querySelector(`[data-vlm-action="${action}"]`).click();await new Promise(r=>setImmediate(r));};

test('not installed shows an in-app download page; accelerated direct download is default and official is selectable', async () => {
  const h=await ui();
  assert.equal(h.links.length,0,'entering the page never starts a download');
  assert.equal(h.document.querySelector('#vlmDownloadSource').querySelector('option').value,'accelerated');
  await click(h,'download');assert.deepEqual(h.links,[ACCELERATED_URL]);
  h.document.querySelector('#vlmDownloadSource').querySelector('[value="official"]').selected=true;
  await click(h,'download');assert.equal(h.links[1],DOWNLOAD_URL);
  await click(h,'open');assert.equal(h.checks(),2);
});

test('installed application opens without displaying download controls', async()=>{
  const h=await ui(true);
  assert.equal(h.document.querySelector('[data-vlm-action="download"]'),null);
  assert.match(h.document.body.textContent,/已打开 VLMReader/);
  assert.deepEqual(h.links,[]);
});

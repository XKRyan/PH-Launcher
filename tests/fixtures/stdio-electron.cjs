require('../../electron/stdio-guard.cjs').guardStdio();
const { app, BrowserWindow, ipcMain } = require('electron');
app.setPath('userData', process.env.PH_STDIO_TEST_PROFILE);
app.setPath('sessionData', process.env.PH_STDIO_TEST_PROFILE);
app.disableHardwareAcceleration();
setTimeout(() => app.exit(2), 15000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  ipcMain.handle('synthetic-rejection', () => { throw new Error('synthetic IPC failure'); });
  await win.loadURL('about:blank');
  process.on('message', async () => {
    const message = await win.webContents.executeJavaScript("require('electron').ipcRenderer.invoke('synthetic-rejection').catch(e => e.message)");
    if (!message.includes('synthetic IPC failure')) return app.exit(3);
    setTimeout(async () => {
      const result = await win.webContents.executeJavaScript('21 * 2');
      process.send(result === 42 ? 'alive' : 'failed', () => app.exit(0));
    }, 100);
  });
  process.send('ready');
});

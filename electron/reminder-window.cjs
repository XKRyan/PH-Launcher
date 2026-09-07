'use strict';

const { pathToFileURL } = require('node:url');
const { windowTheme } = require('./window-theme.cjs');
const MAX_REMINDER_WINDOW_QUEUE = 1_000;

function createReminderWindowManager({ BrowserWindow, ipcMain, path, parentWindow = () => null, onSnooze = () => {}, onComplete = () => {}, onCancelOccurrence = () => {}, onClose = () => {}, getAppearance = () => ({}), getLanguage = () => 'zh-CN' } = {}) {
  if (!BrowserWindow || !ipcMain || !path) throw new TypeError('Electron dependencies are required');
  let window = null;
  const queue = [];
  let active = null;
  let snoozed = false;
  let completed = false;
  let cancelled = false;
  let disposed = false;
  const reminderUrl = pathToFileURL(path.join(__dirname, '..', 'src', 'reminder.html')).href;
  const windowOptions = () => {
    let theme;
    try { theme = windowTheme(getAppearance()); } catch { theme = windowTheme(); }
    let lang;
    try { lang = getLanguage() === 'en' ? 'en' : 'zh-CN'; } catch { lang = 'zh-CN'; }
    return { appearance: { primary: theme.primary, paper: theme.paper, lang }, backgroundColor: theme.paper };
  };
  const showNext = () => {
    if (disposed || active || !queue.length) return;
    active = queue.shift();
    snoozed = false; completed = false; cancelled = false;
    const options = windowOptions();
    const reminderWindow = new BrowserWindow({ width: 680, height: 440, minWidth: 680, minHeight: 440, show: false, resizable: true, backgroundColor: options.backgroundColor, parent: parentWindow() || undefined, webPreferences: { preload: path.join(__dirname, 'reminder-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
    window = reminderWindow;
    reminderWindow.setMenuBarVisibility?.(false);
    reminderWindow.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    reminderWindow.webContents.on('will-navigate', (event) => event.preventDefault());
    reminderWindow.once('ready-to-show', () => { if (window !== reminderWindow || reminderWindow.isDestroyed()) return; reminderWindow.show(); reminderWindow.focus(); reminderWindow.webContents.send('reminder:show', { ...active, appearance: options.appearance }); });
    reminderWindow.on('closed', () => { const closed = active; const wasHandled = snoozed || completed || cancelled; if (window === reminderWindow) window = null; active = null; snoozed = false; completed = false; cancelled = false; if (closed && !wasHandled && !disposed) onClose(closed); showNext(); });
    void reminderWindow.loadFile(path.join(__dirname, '..', 'src', 'reminder.html'));
  };
  const belongsToWindow = (event) => window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.sender.getURL?.() === reminderUrl;
  const closeHandler = (event) => { if (belongsToWindow(event)) window.close(); };
  const handled = () => snoozed || completed || cancelled;
  const actionHandler = (event, mark, callback) => {
    if (!belongsToWindow(event) || !active || handled()) return;
    const reminder = active; const reminderWindow = window;
    mark(true);
    try { callback(reminder); }
    catch (error) {
      if (window === reminderWindow && active === reminder && !reminderWindow.isDestroyed()) {
        mark(false);
        reminderWindow.webContents.send('reminder:error', String(error?.message || '操作未保存，请重试').slice(0, 200));
      }
      return;
    }
    if (window === reminderWindow && !reminderWindow.isDestroyed()) reminderWindow.close();
  };
  const snoozeHandler = (event) => actionHandler(event, value => { snoozed = value; }, reminder => onSnooze(reminder, 5));
  const completeHandler = (event) => actionHandler(event, value => { completed = value; }, onComplete);
  const cancelOccurrenceHandler = (event) => actionHandler(event, value => { cancelled = value; }, onCancelOccurrence);
  ipcMain.on('reminder:close', closeHandler);
  ipcMain.on('reminder:snooze', snoozeHandler);
  ipcMain.on('reminder:complete', completeHandler);
  ipcMain.on('reminder:cancel-occurrence', cancelOccurrenceHandler);
  return {
    enqueue(reminder) { if (disposed || !reminder?.id || active?.id === reminder.id || queue.some((item) => item.id === reminder.id) || queue.length + (active ? 1 : 0) >= MAX_REMINDER_WINDOW_QUEUE) return false; queue.push(reminder); showNext(); return true; },
    remove(id) { id = String(id); for (let index = queue.length - 1; index >= 0; index--) if (queue[index].id === id) queue.splice(index, 1); if (active?.id === id && window && !window.isDestroyed()) { cancelled = true; window.close(); } },
    dispose() { disposed = true; queue.length = 0; ipcMain.removeListener?.('reminder:close', closeHandler); ipcMain.removeListener?.('reminder:snooze', snoozeHandler); ipcMain.removeListener?.('reminder:complete', completeHandler); ipcMain.removeListener?.('reminder:cancel-occurrence', cancelOccurrenceHandler); if (window && !window.isDestroyed()) window.destroy(); window = null; active = null; },
  };
}

module.exports = { createReminderWindowManager, MAX_REMINDER_WINDOW_QUEUE };

'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('reminder', Object.freeze({
  onShow: (callback) => ipcRenderer.on('reminder:show', (_event, value) => callback(value)),
  close: () => ipcRenderer.send('reminder:close'),
  snooze: () => ipcRenderer.send('reminder:snooze'),
}));

'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('reminder', Object.freeze({
  onShow: (callback) => ipcRenderer.on('reminder:show', (_event, value) => callback(value)),
  onError: (callback) => ipcRenderer.on('reminder:error', (_event, value) => callback(String(value || ''))),
  close: () => ipcRenderer.send('reminder:close'),
  snooze: () => ipcRenderer.send('reminder:snooze'),
  complete: () => ipcRenderer.send('reminder:complete'),
  cancelOccurrence: () => ipcRenderer.send('reminder:cancel-occurrence'),
}));

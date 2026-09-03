const { contextBridge, ipcRenderer } = require('electron');

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('ph', {
  data: {
    get: () => ipcRenderer.invoke('data:get'),
    save: (data) => ipcRenderer.invoke('data:save', data),
    export: () => ipcRenderer.invoke('data:export'),
    import: () => ipcRenderer.invoke('data:import'),
    onChanged: (callback) => on('data:changed', callback),
  },
  sites: {
    open: (id) => ipcRenderer.invoke('site:open', id),
    hide: () => ipcRenderer.invoke('site:hide'),
    action: (id, action) => ipcRenderer.invoke('site:action', id, action),
    setClean: (id, enabled) => ipcRenderer.invoke('site:set-clean', id, enabled),
    clearData: (id) => ipcRenderer.invoke('site:clear-data', id),
    saveCustom: (site) => ipcRenderer.invoke('site:custom-upsert', site),
    removeCustom: (id) => ipcRenderer.invoke('site:custom-remove', id),
    reorderCustom: (ids) => ipcRenderer.invoke('site:custom-reorder', ids),
    onState: (callback) => on('site:state', callback),
  },
  ai: {
    configure: (config) => ipcRenderer.invoke('ai:configure', config),
    chat: (messages) => ipcRenderer.invoke('ai:chat', messages),
    controlInfo: () => ipcRenderer.invoke('ai:control-info'),
    previewEduPage: () => ipcRenderer.invoke('ai:edupage-preview'),
    confirmAction: (proposalId) => ipcRenderer.invoke('ai:confirm-action', proposalId),
    cancelAction: (proposalId) => ipcRenderer.invoke('ai:cancel-action', proposalId),
    deploymentState: () => ipcRenderer.invoke('ai:deployment-state'),
    deployLocal: () => ipcRenderer.invoke('ai:deploy-local'),
    cancelDeployment: () => ipcRenderer.invoke('ai:cancel-deployment'),
    showDeploymentLog: () => ipcRenderer.invoke('ai:show-deployment-log'),
    onDeployment: (callback) => on('ai:deployment-state', callback),
    onCommand: (callback) => on('ai:command', callback),
  },
  dictionary: {
    info: () => ipcRenderer.invoke('dictionary:info'),
    lookup: (query) => ipcRenderer.invoke('dictionary:lookup', query),
  },
  ib: {
    commandCatalog: () => ipcRenderer.invoke('ib:command-catalog'),
  },
  system: {
    version: () => ipcRenderer.invoke('system:version'),
    hardware: () => ipcRenderer.invoke('system:hardware'),
    openUrl: (url) => ipcRenderer.invoke('system:open-url', url),
    showData: () => ipcRenderer.invoke('system:show-data'),
    notify: (payload) => ipcRenderer.invoke('system:notify', payload),
  },
  shortcuts: {
    register: () => ipcRenderer.invoke('shortcuts:register'),
    onAction: (callback) => on('shortcut:action', callback),
    onResults: (callback) => on('shortcut:results', callback),
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
  },
  onReady: (callback) => on('app:ready', callback),
});

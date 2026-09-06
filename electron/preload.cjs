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
  credentials: {
    status: () => ipcRenderer.invoke('credentials:status'),
    save: (credential) => ipcRenderer.invoke('credentials:save', credential),
    remove: (siteId) => ipcRenderer.invoke('credentials:remove', siteId),
    fill: (siteId) => ipcRenderer.invoke('credentials:fill', siteId),
    onChanged: (callback) => on('credentials:changed', callback),
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
  vocabulary: {
    get: (subject) => ipcRenderer.invoke('vocabulary:get', subject),
    saveReading: (input) => ipcRenderer.invoke('vocabulary:save-reading', input),
    finishReading: (input) => ipcRenderer.invoke('vocabulary:finish-reading', input),
    removeReading: (id) => ipcRenderer.invoke('vocabulary:remove-reading', id),
    add: (entries) => ipcRenderer.invoke('vocabulary:add', entries),
    addStarter: (subject) => ipcRenderer.invoke('vocabulary:starter', subject),
    review: (input) => ipcRenderer.invoke('vocabulary:review', input),
    undo: () => ipcRenderer.invoke('vocabulary:undo'),
    update: (input) => ipcRenderer.invoke('vocabulary:update', input),
    remove: (id) => ipcRenderer.invoke('vocabulary:remove', id),
    configure: (input) => ipcRenderer.invoke('vocabulary:configure', input),
    extract: (text) => ipcRenderer.invoke('vocabulary:extract', text),
    importText: (text) => ipcRenderer.invoke('vocabulary:import-text', text),
    exportFile: () => ipcRenderer.invoke('vocabulary:export'),
    importFile: () => ipcRenderer.invoke('vocabulary:import'),
  },
  school: {
    get: () => ipcRenderer.invoke('school:get'),
    sync: (source, options) => ipcRenderer.invoke('school:sync', source, options),
    preferences: (input) => ipcRenderer.invoke('school:preferences', input),
    importPlan: () => ipcRenderer.invoke('school:import-plan'),
    course: (id) => ipcRenderer.invoke('school:course', id),
    task: (courseId, id) => ipcRenderer.invoke('school:task', courseId, id),
    ibOverview: (kind) => ipcRenderer.invoke('school:ib-overview', kind),
    openUrl: (url) => ipcRenderer.invoke('school:open-url', url),
    onPlanImported: (callback) => on('school:plan-imported', callback),
  },
  calendar: {
    get: () => ipcRenderer.invoke('calendar:get'),
    save: (input) => ipcRenderer.invoke('calendar:save', input),
    remove: (id) => ipcRenderer.invoke('calendar:remove', id),
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

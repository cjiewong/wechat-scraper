const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openMpPlatform: () => ipcRenderer.invoke('open-mp-platform'),
  startQrLogin: () => ipcRenderer.invoke('start-qr-login'),

  loadSession: () => ipcRenderer.invoke('load-session'),
  saveSession: (session) => ipcRenderer.invoke('save-session', session),
  clearSession: () => ipcRenderer.invoke('clear-session'),
  testSession: (session) => ipcRenderer.invoke('test-session', session),

  searchAccounts: (options) => ipcRenderer.invoke('search-accounts', options),
  getArticleList: (options) => ipcRenderer.invoke('get-article-list', options),

  startScraping: (options) => ipcRenderer.invoke('start-scraping', options),
  stopScraping: () => ipcRenderer.invoke('stop-scraping'),
  startFullExport: (options) => ipcRenderer.invoke('start-full-export', options),
  stopFullExport: () => ipcRenderer.invoke('stop-full-export'),
  getFullExportTask: (options) => ipcRenderer.invoke('get-full-export-task', options),
  resumeFullExport: (options) => ipcRenderer.invoke('resume-full-export', options),
  getIncrementalSyncConfig: () => ipcRenderer.invoke('get-incremental-sync-config'),
  saveIncrementalSyncConfig: (configPayload) => ipcRenderer.invoke('save-incremental-sync-config', configPayload),
  addIncrementalTargetFromSelected: (payload) => ipcRenderer.invoke('add-incremental-target-from-selected', payload),
  removeIncrementalTarget: (payload) => ipcRenderer.invoke('remove-incremental-target', payload),
  runIncrementalSyncNow: (payload) => ipcRenderer.invoke('run-incremental-sync-now', payload),
  stopIncrementalSync: () => ipcRenderer.invoke('stop-incremental-sync'),

  selectOutputDir: () => ipcRenderer.invoke('select-output-dir'),
  getStats: () => ipcRenderer.invoke('get-stats'),

  onScrapingProgress: (callback) => {
    ipcRenderer.on('scraping-progress', (_event, payload) => callback(payload));
  },

  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (_event, payload) => callback(payload));
  },

  onFullExportProgress: (callback) => {
    ipcRenderer.on('full-export-progress', (_event, payload) => callback(payload));
  },

  onFullExportDone: (callback) => {
    ipcRenderer.on('full-export-done', (_event, payload) => callback(payload));
  },

  onIncrementalSyncProgress: (callback) => {
    ipcRenderer.on('incremental-sync-progress', (_event, payload) => callback(payload));
  },

  onIncrementalSyncDone: (callback) => {
    ipcRenderer.on('incremental-sync-done', (_event, payload) => callback(payload));
  },

  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  }
});

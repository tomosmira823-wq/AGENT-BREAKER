const { contextBridge, ipcRenderer } = require('electron');

function on(channel, fn) {
  const handler = (_ev, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('lab', {
  scenarios: () => ipcRenderer.invoke('lab:scenarios'),
  models: () => ipcRenderer.invoke('lab:models'),
  run: (opts) => ipcRenderer.invoke('lab:run', opts),
  cancel: () => ipcRenderer.invoke('lab:cancel'),
  listRuns: () => ipcRenderer.invoke('lab:list-runs'),
  loadRun: (file) => ipcRenderer.invoke('lab:load-run', file),
  report: (file) => ipcRenderer.invoke('lab:report', file),
  openRunsFolder: () => ipcRenderer.invoke('lab:open-runs-folder'),
  onEvent: (fn) => on('lab:event', fn),
  onBatchStart: (fn) => on('lab:batch-start', fn),
  onScenarioDone: (fn) => on('lab:scenario-done', fn),
  onBatchDone: (fn) => on('lab:batch-done', fn),
});

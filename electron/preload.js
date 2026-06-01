'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Bridge a small, explicit API into the renderer. No raw Node access.
contextBridge.exposeInMainWorld('fm', {
  project: {
    saveAs: (project) => ipcRenderer.invoke('project:saveAs', project),
    save: (filePath, project) => ipcRenderer.invoke('project:save', { filePath, project }),
    open: () => ipcRenderer.invoke('project:open')
  },
  source: {
    import: () => ipcRenderer.invoke('source:import'),
    read: (filePath) => ipcRenderer.invoke('source:read', filePath),
    watch: (filePath) => ipcRenderer.invoke('source:watch', filePath)
  },
  font: {
    export: (project, format, metadata) => ipcRenderer.invoke('font:export', { project, format, metadata })
  },
  dialog: {
    message: (opts) => ipcRenderer.invoke('dialog:message', opts)
  },
  // Menu actions arrive from the native menu in the main process.
  onMenu: (cb) => ipcRenderer.on('menu:action', (_e, action) => cb(action)),
  // Source file change notifications (the "source updated, refresh?" feature).
  onSourceChanged: (cb) => ipcRenderer.on('source:changed', (_e, evt) => cb(evt))
});

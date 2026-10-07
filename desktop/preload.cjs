'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('brclio', Object.freeze({
  reportReady: () => ipcRenderer.invoke('brclio:ready'),
  getPlatform: () => ipcRenderer.invoke('brclio:platform'),
  getSettings: () => ipcRenderer.invoke('brclio:settings:get'),
  saveSettings: settings => ipcRenderer.invoke('brclio:settings:save', settings),
  pickPaths: options => ipcRenderer.invoke('brclio:paths:pick', options),
  copyText: text => ipcRenderer.invoke('brclio:clipboard:write', text),
  getIntegrationStatus: () => ipcRenderer.invoke('brclio:integration:get'),
  setIntegration: enabled => ipcRenderer.invoke('brclio:integration:set', enabled),
  getUpdateState: () => ipcRenderer.invoke('brclio:update:state'),
  checkForUpdates: () => ipcRenderer.invoke('brclio:update:check'),
  downloadUpdate: () => ipcRenderer.invoke('brclio:update:download'),
  installUpdate: () => ipcRenderer.invoke('brclio:update:install'),
  onUpdateState: callback => {
    if (typeof callback !== 'function') throw new TypeError('需要更新状态处理函数。');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('brclio:update', listener);
    return () => ipcRenderer.removeListener('brclio:update', listener);
  },
  pathsFromFiles: files => ipcRenderer.invoke('brclio:paths:describe', Array.from(files).map(file => webUtils.getPathForFile(file)).filter(Boolean)),
  onPaths: callback => {
    if (typeof callback !== 'function') throw new TypeError('需要路径处理函数。');
    const listener = (_event, paths) => callback(paths);
    ipcRenderer.on('brclio:paths', listener);
    return () => ipcRenderer.removeListener('brclio:paths', listener);
  },
}));

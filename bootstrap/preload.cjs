'use strict';
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('downloader', {
  read:() => ipcRenderer.invoke('download:read'),
  subscribe:callback => ipcRenderer.on('download:state', (_event, state) => callback(state)),
  setAutoSelf:value => ipcRenderer.invoke('download:auto-self', value),
  start:action => ipcRenderer.send('download:action', action),
  retry:() => ipcRenderer.send('download:retry'),
});

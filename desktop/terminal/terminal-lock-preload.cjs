'use strict';
const {contextBridge,ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('brclioUnlock',Object.freeze({
  biometric: () => ipcRenderer.invoke('brclio:terminal-window:locked-biometric'),
  unlock: (method,pin) => ipcRenderer.invoke('brclio:terminal-window:locked-unlock',method,pin),
}));

'use strict';
const {contextBridge,ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('brclioUnlock',Object.freeze({
  systemVerification: process.platform === 'win32' ? 'Windows Hello' : 'Touch ID',
  biometric: () => ipcRenderer.invoke('brclio:terminal-window:locked-biometric'),
  unlock: (method,pin) => ipcRenderer.invoke('brclio:terminal-window:locked-unlock',method,pin),
}));

'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const prefix = 'brclio:terminal-window:';

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('需要终端事件处理函数。');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(prefix + channel, listener);
  return () => ipcRenderer.removeListener(prefix + channel, listener);
}

contextBridge.exposeInMainWorld('brclioTerminal', Object.freeze({
  platform: process.platform,
  profiles: () => ipcRenderer.invoke(prefix + 'profiles'),
  create: options => ipcRenderer.invoke(prefix + 'create', options),
  write: (id, data, binary = false) => ipcRenderer.invoke(prefix + 'write', id, data, binary),
  resize: (id, cols, rows) => ipcRenderer.invoke(prefix + 'resize', id, cols, rows),
  close: id => ipcRenderer.invoke(prefix + 'close', id),
  ack: (id, count) => ipcRenderer.send(prefix + 'ack', id, count),
  chooseDirectory: () => ipcRenderer.invoke(prefix + 'directory'),
  copy: text => ipcRenderer.invoke(prefix + 'copy', text),
  paste: () => ipcRenderer.invoke(prefix + 'paste'),
  onData: callback => subscribe('data', callback),
  onExit: callback => subscribe('exit', callback),
}));

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
  getPresentation: () => ipcRenderer.invoke(prefix + 'presentation'),
  setPresentation: mode => ipcRenderer.invoke(prefix + 'set-presentation', mode),
  onPresentation: callback => subscribe('presentation-changed', callback),
  onToolbarAction: callback => subscribe('toolbar-action', callback),
  getAlertSettings: () => ipcRenderer.invoke(prefix + 'alert-settings'),
  setHotkey: key => ipcRenderer.invoke(prefix + 'set-hotkey', key),
  setBell: enabled => ipcRenderer.invoke(prefix + 'set-bell', enabled),
  recordHotkey: enabled => ipcRenderer.invoke(prefix + 'recording-hotkey', enabled),
  onCapturedHotkey: callback => subscribe('captured-hotkey', callback),
  ringBell: () => ipcRenderer.invoke(prefix + 'bell'),
  profiles: () => ipcRenderer.invoke(prefix + 'profiles'),
  chooseDynamic: follow => ipcRenderer.invoke(prefix + 'dynamic-choose', follow),
  trackDynamic: enabled => ipcRenderer.invoke(prefix + 'dynamic-track', enabled),
  onDynamicChanged: callback => subscribe('dynamic-changed', callback),
  create: options => ipcRenderer.invoke(prefix + 'create', options),
  write: (id, data, binary = false) => ipcRenderer.invoke(prefix + 'write', id, data, binary),
  resize: (id, cols, rows) => ipcRenderer.invoke(prefix + 'resize', id, cols, rows),
  close: id => ipcRenderer.invoke(prefix + 'close', id),
  ack: (id, count) => ipcRenderer.send(prefix + 'ack', id, count),
  chooseDirectory: () => ipcRenderer.invoke(prefix + 'directory'),
  remoteClients: () => ipcRenderer.invoke(prefix + 'remote-clients'),
  listPasswords: () => ipcRenderer.invoke(prefix + 'vault-list'),
  addPassword: (name, password) => ipcRenderer.invoke(prefix + 'vault-add', name, password),
  updatePassword: (id, name, password) => ipcRenderer.invoke(prefix + 'vault-update', id, name, password),
  removePassword: id => ipcRenderer.invoke(prefix + 'vault-remove', id),
  fillPassword: (id, paneId) => ipcRenderer.invoke(prefix + 'vault-fill', id, paneId),
  copy: text => ipcRenderer.invoke(prefix + 'copy', text),
  paste: () => ipcRenderer.invoke(prefix + 'paste'),
  saveTranscript: (format, text) => ipcRenderer.invoke(prefix + 'save-transcript', format, text),
  onData: callback => subscribe('data', callback),
  onExit: callback => subscribe('exit', callback),
}));

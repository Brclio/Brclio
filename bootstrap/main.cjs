'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { app, BrowserWindow, ipcMain, net, session } = require('electron');
const { isLocalDocument } = require('../desktop/trusted-url.cjs');
const { electronUpdateFetch } = require('../desktop/electron-update-fetch.cjs');
const { createUpdateProxy } = require('./proxy.cjs');
const { runDownloader } = require('./flow.cjs');
const installer = require('./install.cjs');

app.setName('Brclio Downloader');
app.setPath('userData', path.join(app.getPath('appData'), 'Brclio Downloader'));
const documentPath = path.join(__dirname, 'index.html');
// A marker in the downloader's own profile keeps an older downloader usable
// even when a new self-update is offered.
const skipSelfFile = path.join(app.getPath('userData'), 'skip-self-update');
let window, router, selfPreference, quitting = false;
let savingPreference = Promise.resolve();
let state = {title:'启动下载器', detail:'正在准备连接。', version:app.getVersion(), progress:null,
  action:'startup', busy:false, retry:false, autoSelf:true, route:null, phase:'detecting', latencyMs:null};

function report(patch) {
  state = {...state, ...patch};
  if (window && !window.isDestroyed()) window.webContents.send('download:state', state);
}

async function start(action) {
  if (state.busy || quitting) return;
  report({action, busy:true, retry:false, installing:false, warning:'', progress:null, route:null, phase:'detecting', latencyMs:null});
  selfPreference = action === 'startup' ? new AbortController() : null;
  if (!state.autoSelf) selfPreference?.abort();
  try {
    const result = await runDownloader({action, router, installer, currentVersion:app.getVersion(), selfUpdateSignal:selfPreference?.signal,
      directory:path.join(app.getPath('userData'), 'packages'), report});
    if (result.quit) { quitting = true; app.quit(); }
  } catch (error) {
    report({title:'操作未完成', detail:error.message, retry:true, progress:null});
  } finally {
    selfPreference = null;
    if (!quitting) report({busy:false, installing:false});
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (!quitting && state.installing) event.preventDefault();
    else void router?.close();
  });
  app.whenReady().then(async () => {
    state.autoSelf = !(await fs.stat(skipSelfFile).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }));
    router = createUpdateProxy({
      whenReady:() => app.whenReady(), defaultSession:() => session.defaultSession,
      fromPartition:(name, options) => session.fromPartition(name, options),
      fetchSession:(s, url, init) => electronUpdateFetch(opts => net.request(opts), s, url, init),
      onState({route, phase, latencyMs}) { report({route, phase, latencyMs}); }
    });
    window = new BrowserWindow({width:565, height:454, minWidth:440, minHeight:405,
      show:false, backgroundColor:'#fefcf6', autoHideMenuBar:true,
      webPreferences:{preload:path.join(__dirname, 'preload.cjs'), contextIsolation:true, sandbox:true, nodeIntegration:false}});
    window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.on('close', event => { if (!quitting && state.installing) event.preventDefault(); });
    function trusted(event) {
      return event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame &&
        isLocalDocument(event.senderFrame.url, documentPath);
    }
    ipcMain.handle('download:read', event => { if (trusted(event)) return state; });
    ipcMain.handle('download:auto-self', (event, value) => {
      if (!trusted(event) || typeof value !== 'boolean') throw new Error('设置无效。');
      savingPreference = savingPreference.catch(() => {}).then(async () => {
        if (state.installing) throw new Error('安装已开始，请在下次启动时更改。');
        if (value) await fs.rm(skipSelfFile, {force:true});
        else {
          await fs.mkdir(path.dirname(skipSelfFile), {recursive:true});
          await fs.writeFile(skipSelfFile, '', {mode:0o600});
          selfPreference?.abort();
        }
        report({autoSelf:value});
      });
      return savingPreference;
    });
    ipcMain.on('download:action', (event, action) => {
      if (trusted(event) && (action === 'brclio' || action === 'self')) void start(action);
    });
    ipcMain.on('download:retry', event => { if (trusted(event) && state.retry) void start(state.action); });
    await window.loadFile(documentPath);
    window.show();
    void start('startup');
  }).catch(error => { console.error(error.message); app.exit(1); });
}

'use strict';

const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { formatPaths, normalizeSettings } = require('../core/path-engine.cjs');
const { createSettingsStore } = require('./settings.cjs');
const { createIntegration } = require('./integration.cjs');
const { getCopyPaths } = require('./arguments.cjs');
const { getCopyPathsFromURL, getCopyPathsFromURLs } = require('./deep-link.cjs');
const { createUpdater } = require('./updater.cjs');
const { createMacInstaller } = require('./mac-installer.cjs');
const { createWindowsInstaller } = require('./windows-installer.cjs');
const { isLocalDocument } = require('./trusted-url.cjs');

app.setName('Brclio');
app.setPath('userData', process.env.BRCLIO_USER_DATA
  ? path.resolve(process.env.BRCLIO_USER_DATA)
  : path.join(app.getPath('appData'), 'com.brclio.toolbox'));
if (process.platform === 'win32') app.setAppUserModelId('com.brclio.toolbox');

let initialPaths;
let startupError;
try { initialPaths = getCopyPaths(process.argv) || (process.platform === 'darwin' ? getCopyPathsFromURLs(process.argv) : null); } catch (error) { startupError = error; }
const updateLaunchArgs = process.argv.filter((value, index, argv) =>
  ['--brclio-update-job', '--brclio-update-token'].includes(value) || ['--brclio-update-job', '--brclio-update-token'].includes(argv[index - 1]));
const gotLock = app.requestSingleInstanceLock({ copyPaths: initialPaths, updateLaunchArgs });
let mainWindow;
let rendererReady = false;
let pendingUpdateLaunchArgs = updateLaunchArgs;
let pendingPaths = [];
let copyQueue = Promise.resolve();
let idleExit;
const pendingOpenURLs = [];
const indexPath = path.join(__dirname, '..', 'web', 'index.html');
const indexURL = pathToFileURL(indexPath).href;
const settings = createSettingsStore(app.getPath('userData'));
const integration = createIntegration({ launch: {
  executable: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged,
} });
const installerOptions = { executable: process.execPath, userData: app.getPath('userData'), parentPid: process.pid };
const installer = process.platform === 'darwin' ? createMacInstaller(installerOptions)
  : process.platform === 'win32' ? createWindowsInstaller(installerOptions) : null;
const updater = createUpdater({ currentVersion: app.getVersion(), directory: path.join(app.getPath('userData'), 'updates'),
  fetch: (url, options) => net.fetch(url, options),
  installPackage: descriptor => {
    if (!app.isPackaged || !installer) throw new Error('请使用安装版 Brclio 进行在线更新。');
    return installer.start(descriptor);
  },
  onState: state => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('brclio:update', state); },
  afterStart: () => setTimeout(() => app.quit(), 500),
});

async function acknowledgeUpdate() {
  if (!rendererReady || !installer || !pendingUpdateLaunchArgs.length) return;
  const argv = pendingUpdateLaunchArgs;
  pendingUpdateLaunchArgs = [];
  try {
    await installer.acknowledgeLaunch(argv, app.getVersion());
    // The helper records success after it sees our ACK. Never claim success
    // solely because the renderer loaded or because a process was spawned.
    for (let attempt = 0; attempt < 600; attempt++) {
      const result = await installer.readResult({ consume: true });
      if (result) { updater.restoreResult(result); break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  } catch (error) { console.error('Update launch acknowledgement failed:', error.message); }
}

async function describePaths(paths) {
  return Promise.all(paths.map(async filePath => {
    const absolute = path.resolve(filePath);
    const stats = await fs.stat(absolute).catch(() => null);
    return { path: absolute, name: path.basename(absolute) || absolute, kind: stats?.isDirectory() ? 'directory' : 'file' };
  }));
}

async function deliverPaths(paths) {
  const items = await describePaths(paths);
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('brclio:paths', items);
  } else pendingPaths.push(...items);
}

function createWindow() {
  clearTimeout(idleExit);
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
    return mainWindow;
  }
  if (process.platform === 'darwin') app.dock?.show();
  rendererReady = false;
  mainWindow = new BrowserWindow({
    width: 1220, height: 850, minWidth: 780, minHeight: 620,
    title: 'Brclio', backgroundColor: '#f7f4ee', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== indexURL) event.preventDefault(); });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingPaths.length) { mainWindow.webContents.send('brclio:paths', pendingPaths); pendingPaths = []; }
  });
  mainWindow.on('closed', () => { mainWindow = null; rendererReady = false; });
  mainWindow.loadFile(indexPath);
  return mainWindow;
}

function trusted(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !isLocalDocument(event.senderFrame.url, indexPath)) {
    throw new Error('此操作只能由 Brclio 本地窗口发起。');
  }
}

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => { trusted(event); return callback(...args); });
}

function registerIPC() {
  handle('brclio:ready', () => { rendererReady = true; void acknowledgeUpdate(); return { ready: true }; });
  handle('brclio:platform', () => ({ platform: process.platform, version: app.getVersion(),
    capabilities: { filePicker: true, folderPicker: true, systemIntegration: ['darwin', 'win32'].includes(process.platform) },
    homePath: app.getPath('home'), packaged: app.isPackaged,
  }));
  handle('brclio:settings:get', () => settings.read());
  handle('brclio:settings:save', async input => {
    const next = normalizeSettings(input);
    const previous = await settings.read();
    if (next.launchAtLogin !== previous.launchAtLogin) {
      if (!app.isPackaged) throw new Error('请在安装版中设置开机启动。');
      app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });
    }
    try { return await settings.write(next); }
    catch (error) {
      if (next.launchAtLogin !== previous.launchAtLogin) app.setLoginItemSettings({ openAtLogin: previous.launchAtLogin });
      throw error;
    }
  });
  handle('brclio:paths:pick', async options => {
    const kind = options?.kind;
    if (!['file', 'directory', 'base'].includes(kind)) throw new Error('请选择文件或文件夹。');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: kind === 'base' ? '选择相对路径基准文件夹' : kind === 'file' ? '选择文件' : '选择文件夹',
      properties: [kind === 'file' ? 'openFile' : 'openDirectory', ...(kind === 'base' ? [] : ['multiSelections'])],
    });
    return result.canceled ? [] : describePaths(result.filePaths);
  });
  handle('brclio:paths:describe', paths => {
    if (!Array.isArray(paths) || paths.length > 1000 || paths.some(item => typeof item !== 'string' || !path.isAbsolute(item) || item.includes('\0'))) {
      throw new Error('请选择有效的本地文件或文件夹。');
    }
    return describePaths(paths);
  });
  handle('brclio:clipboard:write', async text => {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 16 * 1024 * 1024) throw new Error('复制内容过长或格式无效。');
    await clipboard.writeText(text);
    return { copied: true };
  });
  handle('brclio:integration:get', () => integration.status());
  handle('brclio:integration:set', enabled => integration.set(enabled));
  handle('brclio:update:state', () => updater.state());
  handle('brclio:update:check', () => updater.check());
  handle('brclio:update:download', () => updater.download());
  handle('brclio:update:install', () => updater.install());
}

function copyFromMenu(paths) {
  clearTimeout(idleExit);
  copyQueue = copyQueue.then(async () => {
    try {
      const current = await settings.read();
      // Resolve the native shell's directory \\. suffix before formatting.
      const text = formatPaths(await describePaths(paths), current);
      await clipboard.writeText(text);
      if (mainWindow) await deliverPaths(paths);
    } catch (error) {
      createWindow();
      await deliverPaths(paths);
      await dialog.showMessageBox(mainWindow, { type: 'error', title: '暂时无法复制路径',
        message: error.message || '请检查路径格式设置。', detail: '原剪贴板内容已保留，可在工具箱中调整设置后重试。' });
    }
  }).catch(error => console.error('Context-menu copy failed:', error.message));
  const operation = copyQueue;
  operation.then(() => {
    if (copyQueue === operation && !mainWindow) idleExit = setTimeout(() => { if (!mainWindow && copyQueue === operation) app.quit(); }, 250);
  });
  return copyQueue;
}

if (!gotLock) {
  app.quit();
} else {
  app.on('open-url', (event, value) => {
    event.preventDefault();
    try {
      const paths = getCopyPathsFromURL(value);
      if (!paths) return;
      if (!app.isReady()) pendingOpenURLs.push(paths);
      else {
        if (!mainWindow && process.platform === 'darwin') app.dock?.hide();
        copyFromMenu(paths);
      }
    } catch (error) {
      if (!app.isReady()) startupError = error;
      else { createWindow(); dialog.showErrorBox('无法复制路径', error.message); }
    }
  });
  app.on('second-instance', (_event, _argv, _workingDirectory, additionalData) => {
    if (Array.isArray(additionalData?.updateLaunchArgs) && additionalData.updateLaunchArgs.length === 4
        && additionalData.updateLaunchArgs.filter(value => value === '--brclio-update-job').length === 1
        && additionalData.updateLaunchArgs.filter(value => value === '--brclio-update-token').length === 1
        && additionalData.updateLaunchArgs.every(value => typeof value === 'string')) {
      pendingUpdateLaunchArgs = additionalData.updateLaunchArgs;
      if (rendererReady) void acknowledgeUpdate();
    }
    const selected = additionalData?.copyPaths;
    if (Array.isArray(selected) && selected.length && selected.every(item => typeof item === 'string' && !item.includes('\0'))) {
      copyFromMenu(selected);
    } else createWindow();
  });
  app.whenReady().then(async () => {
    registerIPC();
    if (installer && !pendingUpdateLaunchArgs.length) updater.restoreResult(await installer.readResult({ consume: true }).catch(() => null));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ label: app.getName(), submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] },
    ]));
    if (startupError) {
      createWindow();
      dialog.showErrorBox('无法复制路径', startupError.message);
    } else if (initialPaths || pendingOpenURLs.length) {
      if (process.platform === 'darwin') app.dock?.hide();
      if (initialPaths) copyFromMenu(initialPaths);
      for (const paths of pendingOpenURLs.splice(0)) copyFromMenu(paths);
    } else createWindow();
  }).catch(error => { console.error(error); app.quit(); });
  app.on('activate', () => createWindow());
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

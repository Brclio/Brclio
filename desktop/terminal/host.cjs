'use strict';

const path = require('node:path');
const { isLocalDocument } = require('../trusted-url.cjs');
const { createPtySessions } = require('./pty.cjs');

const prefix = 'brclio:terminal-window:';
const documentPath = path.join(__dirname, 'index.html');

function createTerminalHost({ app, BrowserWindow, ipcMain, dialog, clipboard }) {
  let window;
  let loading;
  const channels = [];
  const sessions = createPtySessions({
    home: app.getPath('home'),
    send(channel, payload) {
      const contents = window?.webContents;
      if (contents && !contents.isDestroyed() && isLocalDocument(contents.getURL(), documentPath)) {
        contents.send(prefix + channel, payload);
      }
    },
  });

  function trusted(event) {
    const contents = window?.webContents;
    return contents && !contents.isDestroyed() && contents === event.sender &&
      contents.mainFrame === event.senderFrame && isLocalDocument(event.senderFrame.url, documentPath);
  }

  function handle(channel, fn) {
    channels.push(prefix + channel);
    ipcMain.handle(prefix + channel, (event, ...args) => {
      if (!trusted(event)) throw new Error('此操作只能由 Brclio 终端窗口发起。');
      return fn(...args);
    });
  }

  handle('profiles', sessions.profiles);
  handle('create', sessions.create);
  handle('write', sessions.write);
  handle('resize', sessions.resize);
  handle('close', sessions.close);
  handle('directory', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择终端工作目录', properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('copy', text => {
    if (typeof text !== 'string' || text.length > 16 * 1024 * 1024) throw new Error('复制内容过长或格式无效。');
    clipboard.writeText(text);
  });
  handle('paste', () => clipboard.readText());

  function acknowledge(event, id, count) {
    if (trusted(event)) sessions.ack(id, count);
  }
  ipcMain.on(prefix + 'ack', acknowledge);

  async function open() {
    if (window && !window.isDestroyed()) {
      if (loading) await loading;
      if (window?.isMinimized()) window.restore();
      window?.show();
      window?.focus();
      return { opened: true };
    }
    const win = new BrowserWindow({
      title: 'Brclio 终端', width: 1060, height: 720, minWidth: 580, minHeight: 360,
      show: false, backgroundColor: '#17191d', icon: path.join(__dirname, '../../web/assets/icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'), partition: 'brclio-terminal',
        contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
      },
    });
    window = win;
    const contents = win.webContents;
    if (process.platform !== 'darwin') win.setMenu(null);
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.session.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
    contents.session.setPermissionCheckHandler(() => false);
    for (const event of ['will-frame-navigate', 'will-redirect', 'will-attach-webview']) {
      contents.on(event, details => details.preventDefault());
    }
    contents.on('before-input-event', (_event, input) => {
      const rendererShortcut = process.platform === 'darwin'
        ? input.meta && ['c', 'v', 't', 'w', 'f', 'd', 'k'].includes(input.key.toLowerCase())
        : input.control || input.alt;
      contents.setIgnoreMenuShortcuts(Boolean(rendererShortcut));
    });
    contents.on('did-start-navigation', details => {
      if (window === win && details.isMainFrame && !details.isSameDocument) sessions.closeAll();
    });
    contents.on('render-process-gone', () => { if (window === win) sessions.closeAll(); });
    win.on('closed', () => {
      if (window === win) {
        sessions.closeAll();
        window = undefined;
        loading = undefined;
      }
    });
    loading = win.loadFile(documentPath);
    try {
      await loading;
      if (!win.isDestroyed()) { win.show(); win.focus(); }
      return { opened: true };
    } catch (error) {
      if (!win.isDestroyed()) win.destroy();
      throw error;
    } finally {
      if (window === win) loading = undefined;
    }
  }

  function dispose() {
    app.removeListener('will-quit', dispose);
    for (const channel of channels) ipcMain.removeHandler(channel);
    ipcMain.removeListener(prefix + 'ack', acknowledge);
    sessions.closeAll();
    if (window && !window.isDestroyed()) window.destroy();
  }
  app.once('will-quit', dispose);
  return { open, dispose };
}

module.exports = { createTerminalHost };

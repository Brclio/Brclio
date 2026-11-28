'use strict';

const path = require('node:path');
const { isLocalDocument } = require('../trusted-url.cjs');
const { createPtyService } = require('./service.cjs');

const prefix = 'brclio:terminal-window:';
const documentPath = path.join(__dirname, 'index.html');

function createTerminalHost({ app, BrowserWindow, WebContentsView, ipcMain, dialog, clipboard, getMainWindow, showMainWindow, onPresentation }) {
  let view;
  let owner;
  let detached;
  let loading;
  let mode = 'closed';
  let viewport = null;
  let focusOnShow = false;
  const channels = [];
  const sessions = createPtyService({ home: app.getPath('home'), send });

  function send(channel, payload) {
    const contents = view?.webContents;
    if (contents && !contents.isDestroyed() && isLocalDocument(contents.getURL(), documentPath)) {
      contents.send(prefix + channel, payload);
    }
  }

  function trusted(event) {
    const contents = view?.webContents;
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
  handle('presentation', () => mode);
  handle('set-presentation', open);
  handle('directory', async () => {
    const result = await dialog.showOpenDialog(owner, { title: '选择终端工作目录', properties: ['openDirectory'] });
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

  function presentation(next) {
    if (mode === next) return;
    mode = next;
    onPresentation(mode);
    send('presentation-changed', mode);
  }

  function removeView() {
    if (!owner) return;
    owner.removeListener('resize', layout);
    owner.removeListener('closed', ownerClosed);
    if (!owner.isDestroyed()) owner.contentView.removeChildView(view);
    owner = undefined;
  }

  function closeTerminal() {
    if (!view) return;
    const contents = view.webContents;
    removeView();
    view = undefined;
    loading = undefined;
    focusOnShow = false;
    sessions.closeAll();
    if (!contents.isDestroyed()) contents.close();
    const shell = detached;
    detached = undefined;
    if (shell && !shell.isDestroyed()) shell.destroy();
    presentation('closed');
  }

  function ownerClosed() {
    if (this === owner) closeTerminal();
  }

  function layout() {
    if (!view || !owner || owner.isDestroyed()) return;
    const [width, height] = owner.getContentSize();
    let bounds = { x: 0, y: 0, width, height };
    if (mode === 'inline') {
      if (viewport) {
        // DOM coordinates are CSS pixels, Electron view bounds use DIP.
        const zoom = owner.webContents.getZoomFactor();
        const x = Math.max(0, Math.round(viewport.x * zoom));
        const y = Math.max(0, Math.round(viewport.y * zoom));
        const right = Math.min(width, Math.round((viewport.x + viewport.width) * zoom));
        const bottom = Math.min(height, Math.round((viewport.y + viewport.height) * zoom));
        bounds = { x, y, width: right - x, height: bottom - y };
      }
      if (!viewport || bounds.width < 1 || bounds.height < 1) {
        const wasFocused = view.webContents.isFocused();
        view.setVisible(false);
        if (wasFocused && owner.isFocused()) owner.webContents.focus();
        return;
      }
    }
    view.setBounds(bounds);
    view.setVisible(true);
    if (focusOnShow && owner.isFocused()) {
      view.webContents.focus();
      focusOnShow = false;
    }
  }

  function setViewport(rect) {
    if (rect !== null && (!rect || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) || rect.width < 0 || rect.height < 0)) {
      throw new Error('终端显示区域无效。');
    }
    viewport = rect;
    if (mode === 'inline') layout();
  }

  function configureNavigation(contents) {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const event of ['will-frame-navigate', 'will-redirect', 'will-attach-webview']) {
      contents.on(event, details => details.preventDefault());
    }
  }

  function makeView() {
    const terminal = new WebContentsView({ webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), partition: 'persist:brclio-terminal',
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
    } });
    view = terminal;
    terminal.setVisible(false);
    terminal.setBackgroundColor('#181b25');
    const contents = terminal.webContents;
    configureNavigation(contents);
    contents.session.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
    contents.session.setPermissionCheckHandler(() => false);
    contents.on('before-input-event', (_event, input) => {
      const shortcut = process.platform === 'darwin'
        ? input.meta && ['c', 'v', 't', 'w', 'f', 'd', 'k'].includes(input.key.toLowerCase())
        : input.control || input.alt;
      contents.setIgnoreMenuShortcuts(Boolean(shortcut));
    });
    contents.on('did-start-navigation', details => {
      if (view === terminal && details.isMainFrame && !details.isSameDocument) sessions.closeAll();
    });
    contents.on('render-process-gone', () => { if (view === terminal) closeTerminal(); });
    contents.once('destroyed', () => { if (view === terminal) closeTerminal(); });
    loading = contents.loadFile(documentPath);
  }

  function windowForTerminal() {
    if (detached && !detached.isDestroyed()) return detached;
    detached = new BrowserWindow({
      title: 'Brclio 终端', width: 1060, height: 720, minWidth: 580, minHeight: 360,
      show: false, backgroundColor: '#181b25', icon: path.join(__dirname, '../../web/assets/icon.png'),
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, partition: 'persist:brclio-terminal' },
    });
    configureNavigation(detached.webContents);
    if (process.platform !== 'darwin') detached.setMenu(null);
    return detached;
  }

  async function open(next = 'inline') {
    if (next !== 'inline' && next !== 'window') throw new Error('未知的终端显示模式。');
    const target = next === 'window' ? windowForTerminal() : (getMainWindow() || showMainWindow());
    if (!target || target.isDestroyed()) throw new Error('无法打开 Brclio 主窗口。');
    if (!view) makeView();
    const terminal = view;
    if (owner !== target) {
      removeView();
      target.contentView.addChildView(terminal);
      owner = target;
      owner.on('resize', layout);
      owner.once('closed', ownerClosed);
    }
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
    focusOnShow = true;
    presentation(next);
    layout();
    // Remove the view before destroying its old container. Electron keeps the
    // same WebContents, isolated world, xterm buffers and PTY service alive.
    if (next === 'inline' && detached) {
      const previous = detached;
      detached = undefined;
      if (!previous.isDestroyed()) previous.destroy();
    }
    try {
      await loading;
      if (view !== terminal) throw new Error('终端已关闭。');
      return { opened: true, presentation: mode };
    } catch (error) {
      if (view === terminal) closeTerminal();
      throw error;
    }
  }

  function dispose() {
    app.removeListener('will-quit', dispose);
    for (const channel of channels) ipcMain.removeHandler(channel);
    ipcMain.removeListener(prefix + 'ack', acknowledge);
    closeTerminal();
  }
  app.once('will-quit', dispose);
  return { open, dispose, setViewport, getPresentation: () => mode, hasWindow: () => mode === 'window' };
}

module.exports = { createTerminalHost };

'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { isLocalDocument } = require('../trusted-url.cjs');
const { createPtyService } = require('./service.cjs');

const prefix = 'brclio:terminal-window:';
const documentPath = path.join(__dirname, 'index.html');

function createTerminalHost({ app, BrowserWindow, WebContentsView, ipcMain, dialog, clipboard, alerts, accountRequest, getMainWindow, showMainWindow, onPresentation }) {
  let view;
  let owner;
  let detached;
  let loading;
  let mode = 'closed';
  let viewport = null;
  let focusOnShow = false;
  let recording = false;

  let vault;
  const channels = [];
  const sessions = createPtyService({ home: app.getPath('home'), send });
  const touchBar = process.platform === 'darwin' && require('./touch-bar.cjs').terminalTouchBar(id => send('toolbar-action', id));

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

  const sftp = require('./sftp-host.cjs').registerSftp({ handle, dialog, getOwner: () => owner });
  require('./known-hosts.cjs').register({ handle, home: app.getPath('home'), confirm: async (message, detail) =>
    (await dialog.showMessageBox(owner, { type: 'question', message, detail, buttons: ['取消', '移除此记录'],
      defaultId: 0, cancelId: 0, noLink: true })).response === 1 });
  handle('serial-ports', () => require('./device-session.cjs').serialPorts());
  const { syncAccount, localIdentity } = require('./sync-account.cjs');
  const identity = localIdentity(app.getPath('userData'));
  handle('sync-config', async (op, payload) => {
    const targetView = view;
    const result = op === 'local-session' ? await identity.current() :
      op === 'session' ? await identity.verify(accountRequest) : await syncAccount(accountRequest, op, payload);
    if (view !== targetView) throw new Error('终端已关闭。');
    return result;
  });
  handle('profiles', sessions.profiles);
  const dynamic = require('./dynamic-profiles.cjs').dynamicSource(value => send('dynamic-changed', value));
  handle('dynamic-reset', dynamic.stop);
  handle('dynamic-choose', follow => dynamic.choose(async () => {
    const result = await dialog.showOpenDialog(owner, { title: '导入终端动态配置', properties: ['openFile'],
      filters: [{ name: '动态配置 JSON', extensions: ['json'] }] });
    return result.canceled ? null : result.filePaths[0];
  }, follow));
  handle('dynamic-track', dynamic.track);
  const identities = require('./identity-host.cjs').register({ handle, dialog, getOwner: () => owner, home: app.getPath('home') });
  handle('create', options => sessions.create(identities.prepare(options)));
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
  handle('remote-clients', () => {
    const { program } = require('./remote-launch.cjs');
    return { ssh: Boolean(program('ssh')), sftp: Boolean(program('sftp')) };
  });
  handle('save-transcript', async (format, text) => {
    const filter = new Map([
      ['text', { name: '纯文本', extensions: ['txt'] }],
      ['ansi', { name: 'ANSI 终端记录', extensions: ['ansi'] }],
      ['html', { name: 'HTML 文档', extensions: ['html'] }],
    ]).get(format);
    if (!filter || typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 16 * 1024 * 1024) {
      throw new Error('终端记录格式无效或超过 16 MiB。');
    }
    const chosen = await dialog.showSaveDialog(owner, {
      title: '导出终端记录', defaultPath: 'Brclio 终端.' + filter.extensions[0], filters: [filter],
    });
    if (chosen.canceled || !chosen.filePath) return { saved: false };
    const temporary = path.join(path.dirname(chosen.filePath), '.brclio-transcript-' + randomUUID() + '.tmp');
    try {
      await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, chosen.filePath);
    } finally { await fs.rm(temporary, { force: true }); }
    return { saved: true };
  });
  handle('alert-settings', async () => { await alerts.initialize(); return alerts.status(); });
  handle('set-hotkey', key => alerts.setHotkey(key));
  handle('set-bell', enabled => alerts.setBell(enabled));
  handle('recording-hotkey', enabled => {
    if (enabled && !owner?.isFocused()) throw new Error('请先返回终端再录入快捷键。');
    recording = enabled === true;
  });
  handle('bell', () => alerts.bell());

  async function passwordVault() {
    const terminal = view;
    const isActive = () => view === terminal && view?.getVisible() && owner?.isFocused();
    if (!isActive()) throw new Error('请先返回终端窗口。');
    const cached = await identity.current();
    const { user } = cached.known ? cached : await identity.verify(accountRequest);
    if (!isActive()) throw new Error('账号或活动窗口已变化。');
    const id = user?.id || '';
    if (vault?.owner !== id) {
      const directory = id ? path.join(app.getPath('userData'), 'terminal-accounts', id) : app.getPath('userData');
      vault = { owner: id, service: require('./vault.cjs').createTerminalVault({ directory, storage: require('electron').safeStorage }) };
    }
    return vault.service;
  }
  handle('vault-list', async () => (await passwordVault()).list());
  handle('vault-add', async (name, password) => (await passwordVault()).add(name, password));
  handle('vault-update', async (id, name, password) => (await passwordVault()).update(id, name, password));
  handle('vault-remove', async id => (await passwordVault()).remove(id));
  handle('vault-fill', async (id, paneId) => {
    const terminal = view;
    const window = owner;
    const target = sessions.target(paneId);
    async function checkPane() {
      if (!view || view !== terminal || !target || target.profile === 'tmux-control') throw new Error('当前窗格不支持填入。');
      const selected = await terminal.webContents.executeJavaScript(
        "document.querySelector('#actions-dialog[open] #vault-controls[open]') && document.querySelector('#workspace .panel:not([hidden]) .pane.active')?.dataset.id");
      if (selected !== paneId || view !== terminal || owner !== window || !window?.isFocused() ||
          !terminal.getVisible() || sessions.target(paneId) !== target) {
        throw new Error('活动窗格已更改或会话已结束，请重新选择。');
      }
    }
    return (await passwordVault()).fill(id, async name => {
      await checkPane();
      const program = path.basename(target.shell).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, '');
      const host = ['ssh', 'sftp'].includes(target.profile) ? ' · ' + target.host : '';
      const chosen = await dialog.showMessageBox(window, {
        type: 'question', title: '填入终端密码', message: '将「' + name + '」填入当前窗格？',
        detail: program + host + ' · PID ' + target.pid + ' · 会话 ' + paneId.slice(0, 8) +
          '\n目标程序可能回显输入，回显的文字可能出现在屏幕记录中。填入后不会按回车。',
        buttons: ['取消', '填入此窗格'], defaultId: 0, cancelId: 0, noLink: true,
      });
      return chosen.response === 1;
    }, async value => {
      await checkPane();
      try { await sessions.write(paneId, value); }
      catch { throw new Error('无法填入，请检查当前终端会话。'); }
    });
  });

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
    if (touchBar) touchBar.detach();
    if (!owner) return;
    owner.removeListener('resize', layout);
    owner.removeListener('closed', ownerClosed);
    if (!owner.isDestroyed()) owner.contentView.removeChildView(view);
    owner = undefined;
  }

  function closeTerminal() {
    vault = undefined;
    sftp.close();
    dynamic.stop();
    if (!view) return;
    const contents = view.webContents;
    removeView();
    view = undefined;
    loading = undefined;
    focusOnShow = false;
    recording = false;
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
        if (touchBar) touchBar.detach();
        if (wasFocused && owner.isFocused()) owner.webContents.focus();
        return;
      }
    }
    view.setBounds(bounds);
    view.setVisible(true);
    if (touchBar && view.webContents.isFocused()) touchBar.attach(owner);
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
    if (touchBar) {
      contents.on('focus', () => { if (view === terminal && owner && terminal.getVisible()) touchBar.attach(owner); });
      contents.on('blur', () => { if (view === terminal) touchBar.detach(); });
    }
    contents.session.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
    contents.session.setPermissionCheckHandler(() => false);
    contents.on('before-input-event', (_event, input) => {
      const shortcut = process.platform === 'darwin'
        ? input.meta && ['c', 'v', 't', 'w', 'f', 'd', 'k'].includes(input.key.toLowerCase())
        : input.control || input.alt;
      contents.setIgnoreMenuShortcuts(recording || Boolean(shortcut));
    });
    contents.on('did-start-navigation', details => {
      if (view === terminal && details.isMainFrame && !details.isSameDocument) { sftp.close(); dynamic.stop(); sessions.closeAll(); }
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

  function toggleHotkey(key) {
    if (recording && owner?.isFocused() && view?.webContents.isFocused()) {
      send('captured-hotkey', key);
      return;
    }
    if (mode === 'window' && detached?.isVisible() && detached.isFocused()) {
      detached.hide();
      return;
    }
    return open('window');
  }

  function dispose() {
    app.removeListener('will-quit', dispose);
    for (const channel of channels) ipcMain.removeHandler(channel);
    ipcMain.removeListener(prefix + 'ack', acknowledge);
    closeTerminal();
  }
  app.once('will-quit', dispose);
  return { open, toggleHotkey, dispose, setViewport, accountChanged: closeTerminal, getPresentation: () => mode, hasWindow: () => mode === 'window' };
}

module.exports = { createTerminalHost };

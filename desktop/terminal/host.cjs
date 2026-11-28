'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const { isLocalDocument } = require('../trusted-url.cjs');
const { createPtyService } = require('./service.cjs');

const prefix = 'brclio:terminal-window:';
const documentPath = path.join(__dirname, 'index.html');

function createTerminalHost({ app, BrowserWindow, WebContentsView, ipcMain, dialog, clipboard, alerts, accountRequest, getMainWindow, showMainWindow, onPresentation }) {
  let view;
  let viewGeneration = 0;
  let pendingView;
  let viewScope;
  let owner;
  let detached;
  let loading;
  let mode = 'closed';
  let viewport = null;
  let focusOnShow = false;
  let recording = false;

  const lockPage = path.join(__dirname,'terminal-lock-screen.html');
  const electron = require('electron');
  const deviceVerification = require('./biometrics.cjs').provider({preferences:electron.systemPreferences,
    getOwner:() => owner, packaged:app.isPackaged});
  const lock = require('./terminal-lock.cjs').terminalLock({directory:app.getPath('userData'),
    secureStorage:() => electron.safeStorage, biometrics:() => deviceVerification});
  let parked, screen, idleCheck, liveView;
  const heldEvents = new Map(), pendingAcks = new Map();
  let vault;
  const channels = [];
  const sessions = createPtyService({ home: app.getPath('home'), send });
  const touchBar = process.platform === 'darwin' && require('./touch-bar.cjs').terminalTouchBar(id => send('toolbar-action', id));

  function send(channel, payload) {
    if (channel === 'exit') liveView?.paneExited(payload.id);
    logs.observe(channel, payload);
    if (lock.locked) {
      // The PTY service pauses at its existing per-pane high-water mark while
      // locked, so withheld output remains bounded and can replay in order.
      if (parked && (channel === 'data' || channel === 'exit')) {
        const held = heldEvents.get(payload.id) || {data:''};
        if (channel === 'data') held.data += payload.data;
        else held.exit = payload;
        heldEvents.set(payload.id,held);
      }
      return;
    }
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
      if (lock.locked) throw new Error('终端已锁定。');
      if (!trusted(event)) throw new Error('此操作只能由 Brclio 终端窗口发起。');
      const generation = lock.generation, result = fn(...args);
      if (channel === 'lock-settings' || !result?.then) return result;
      return result.then(value => {
        if (lock.locked || generation !== lock.generation) throw new Error('终端已锁定或窗口已关闭。');
        return value;
      });
    });
  }

  const sftp = require('./sftp-host.cjs').registerSftp({ handle, dialog, getOwner: () => owner,
    editorDirectory: () => view?.webContents.session.getStoragePath() });
  require('./known-hosts.cjs').register({ handle, home: app.getPath('home'), confirm: async (message, detail) =>
    (await dialog.showMessageBox(owner, { type: 'question', message, detail, buttons: ['取消', '移除此记录'],
      defaultId: 0, cancelId: 0, noLink: true })).response === 1 });
  const inventoryBridge = require('./inventory-bridge.cjs').register({handle,send,
    available:() => Boolean(view && !view.webContents.isDestroyed() && !lock.locked && !viewScope?.temporary)});
  handle('cloud-inventory', async provider => {
    const target = view;
    if (!['aws','digitalocean','azure'].includes(provider)) throw new Error('未知的云服务。');
    const confirm = await dialog.showMessageBox(owner, { type:'question', message:'从本机已登录的云账号读取主机清单？',
      detail:'服务：' + provider + '。预览后可选择导入的主机。', buttons:['取消','读取清单'], defaultId:0,cancelId:0,noLink:true });
    if (confirm.response !== 1 || target !== view) return null;
    const result = await require('./cloud-inventory.cjs').fetchInventory(provider);
    return target === view ? result : null;
  });
  handle('serial-ports', () => require('./device-session.cjs').serialPorts());
  require('./putty-discovery.cjs').register({handle,dialog,owner:() => owner,view:() => view,home:app.getPath('home')});
  const { syncAccount, localIdentity } = require('./sync-account.cjs');
  const identity = localIdentity(app.getPath('userData'));
  async function localUser() {
    const cached = await identity.current();
    return (cached.known ? cached : await identity.verify(accountRequest)).user;
  }
  require('./unbound-transfer.cjs').registerUnboundTransfer({ handle, WebContentsView, dialog, getView: () => view,
    getOwner: () => owner, localUser, viewUserId: () => viewScope?.userId });
  const logs = require('./local-logs.cjs').registerLogs({ handle, directory: app.getPath('userData'),
    storage: require('electron').safeStorage, target: sessions.target, owner: async () => {
      const user = await localUser();
      return !viewScope?.temporary && user?.id === viewScope?.userId ? user?.id : undefined;
    } });
  liveView = require('./live-view-host.cjs').registerLiveView({handle,accountRequest,localUser,scope:() => viewScope,paneTarget:sessions.target,send});
  require('./terminal-log-cloud.cjs').registerCloudLogs({handle,accountRequest,localUser,scope:() => lock.locked ? null : viewScope,readStopped:logs.readStopped,
    confirm:async ({name,host,destination,days}) => (await dialog.showMessageBox(owner, {type:'question',noLink:true,
      message:'上传「' + name + '」的加密日志副本？',
      detail:'记录主机：' + host + '\n访问范围：' + destination + '\n可访问期限：' + days + ' 天。\n完整文本可能含有敏感信息。名称、主机和分享者可见。口令由你单独交付。',
      buttons:['取消','上传这份日志'],defaultId:0,cancelId:0})).response === 1});
  require('./shared-vault-host.cjs').registerSharedVault({handle, accountRequest, localUser, scope: () => viewScope});
  handle('snippet-sync', async (operation,payload) => {
    const scope = viewScope;
    if (!scope?.userId || scope.temporary || (await localUser())?.id !== scope.userId || scope !== viewScope) throw new Error('请先登录当前 Brclio 账号。');
    if (!['read','write'].includes(operation)) throw new Error('未知的剪藏同步操作。');
    const path = '/api/account/apps/terminal/snippets';
    const result = await accountRequest(operation === 'read' ? {path} :
      {path,method:'PUT',body:{expectedUserId:scope.userId,revision:payload?.revision,data:payload?.data}});
    if (scope !== viewScope || result.userId !== scope.userId || (await localUser())?.id !== scope.userId || scope !== viewScope) throw new Error('账号已变化。');
    return result;
  });
  handle('sync-config', async (op, payload) => {
    const targetView = view;
    if (viewScope?.temporary) {
      if (op === 'local-session') return { known: true, user: null, temporary: true };
      throw new Error('此窗口仅提供临时 Shell。联网后重新打开终端即可访问账号资料。');
    }
    const result = op === 'local-session' ? await identity.current() :
      op === 'session' ? await identity.verify(accountRequest) : await syncAccount(accountRequest, op, payload);
    if (view !== targetView) throw new Error('终端已关闭。');
    const resolved = op === 'local-session' || op === 'session' ? result.user?.id : result.userId;
    if (resolved !== viewScope?.userId) throw new Error('登录状态已变化，请重新打开终端。');
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
  handle('remote-kex', () => require('./post-quantum.cjs').capabilities(require('./remote-launch.cjs').program('ssh')));
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
    const user = await localUser();
    if (viewScope?.temporary || user?.id !== viewScope?.userId) throw new Error('请重新打开终端确认登录账号。');
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
    if (!lock.locked && trusted(event)) sessions.ack(id, count);
    else if (parked && event.sender === parked.webContents && event.senderFrame === parked.webContents.mainFrame &&
        sessions.target(id) && Number.isSafeInteger(count) && count > 0) {
      pendingAcks.set(id, Math.min(1024 * 1024, (pendingAcks.get(id) || 0) + count));
    }
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
    owner.removeListener('hide', lockTerminal);
    owner.removeListener('minimize', lockTerminal);
    if (!owner.isDestroyed()) owner.contentView.removeChildView(view);
    owner = undefined;
  }

  function closeTerminal() {
    inventoryBridge.stop();
    lock.lock();
    clearInterval(idleCheck); idleCheck = undefined;
    heldEvents.clear(); pendingAcks.clear();
    if (parked && !parked.webContents.isDestroyed()) parked.webContents.close();
    parked = undefined; screen = undefined;
    viewGeneration++;
    pendingView = undefined;
    viewScope = undefined;
    vault = undefined;
    logs.reset();
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
    if (!screen && touchBar && view.webContents.isFocused()) touchBar.attach(owner);
    if (focusOnShow && owner.isFocused()) {
      view.webContents.focus();
      focusOnShow = false;
    }
  }

  function setViewport(rect) {
    if (rect !== null && (!rect || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) || rect.width < 0 || rect.height < 0)) {
      throw new Error('终端显示区域无效。');
    }
    if (rect === null && viewport && mode === 'inline') lockTerminal();
    viewport = rect;
    if (mode === 'inline') layout();
  }

  function configureNavigation(contents) {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const event of ['will-frame-navigate', 'will-redirect', 'will-attach-webview']) {
      contents.on(event, details => details.preventDefault());
    }
  }

  async function prepareView() {
    if (view) return;
    if (pendingView) return pendingView;
    const generation = viewGeneration;
    const creating = (async () => {
      await lock.initialize();
      let scope;
      try {
        const user = await localUser();
        const partition = user ? 'persist:brclio-terminal-' + createHash('sha256').update(user.id).digest('hex') : 'persist:brclio-terminal';
        scope = { partition, userId: user?.id };
      } catch {
        // An unverified login must not expose either another account or the guest library.
        scope = { partition: 'brclio-terminal-offline-' + randomUUID(), temporary: true };
      }
      if (generation !== viewGeneration) throw new Error('账号已变化，请重新打开终端。');
      viewScope = scope;
      if (lock.locked) makeLockScreen();
      else makeView(scope.partition);
      watchIdle();
    })();
    pendingView = creating;
    try { await creating; }
    finally { if (pendingView === creating) pendingView = undefined; }
  }

  function makeView(partition) {
    const terminal = new WebContentsView({ webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), partition,
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
      if (lock.locked || view !== terminal) { _event.preventDefault(); return; }
      const shortcut = process.platform === 'darwin'
        ? input.meta && ['c', 'v', 't', 'w', 'f', 'd', 'k'].includes(input.key.toLowerCase())
        : input.control || input.alt;
      contents.setIgnoreMenuShortcuts(recording || Boolean(shortcut));
    });
    contents.on('did-start-navigation', details => {
      if (view === terminal && details.isMainFrame && !details.isSameDocument) { inventoryBridge.stop(); logs.reset(); sftp.close(); dynamic.stop(); sessions.closeAll(); }
    });
    function retireTerminal() {
      if (view === terminal) closeTerminal();
      else if (parked === terminal) {
        parked = undefined; heldEvents.clear(); pendingAcks.clear();
        inventoryBridge.stop(); logs.reset(); sftp.close(); dynamic.stop(); sessions.closeAll();
      }
    }
    contents.on('render-process-gone', retireTerminal);
    contents.once('destroyed', retireTerminal);
    loading = contents.loadFile(documentPath);
  }

  function makeLockScreen() {
    const gate = new WebContentsView({webPreferences:{preload:path.join(__dirname,'terminal-lock-preload.cjs'),
      partition:'brclio-terminal-lock-' + randomUUID(), sandbox:true, webSecurity:true, nodeIntegration:false, contextIsolation:true, devTools:false}});
    screen = view = gate;
    gate.setVisible(false);
    configureNavigation(gate.webContents);
    gate.webContents.session.setPermissionRequestHandler((_wc,_permission,respond) => respond(false));
    gate.webContents.session.setPermissionCheckHandler(() => false);
    gate.webContents.on('render-process-gone', () => {if (view === gate) closeTerminal();});
    loading = gate.webContents.loadFile(lockPage);
    loading.catch(() => {if (view === gate) closeTerminal();});
  }

  function lockTerminal() {
    inventoryBridge.stop();
    liveView?.stop();
    if (!view || !lock.enabled) return;
    lock.lock();
    if (screen) return;
    parked = view;
    parked.setVisible(false);
    if (touchBar) touchBar.detach();
    if (owner && !owner.isDestroyed()) owner.contentView.removeChildView(parked);
    makeLockScreen();
    if (owner && !owner.isDestroyed()) owner.contentView.addChildView(screen);
    focusOnShow = true;
    layout();
  }
  function watchIdle() {
    clearInterval(idleCheck); idleCheck = undefined;
    if (view && lock.enabled && electron.powerMonitor) {
      idleCheck = setInterval(() => {if (!screen && electron.powerMonitor.getSystemIdleTime() >= 300) lockTerminal();},15000);
      idleCheck.unref();
    }
  }
  for (const event of ['suspend','lock-screen']) electron.powerMonitor?.on(event,lockTerminal);
  handle('lock-settings', async (action, pin, biometric) => {
    const original = view;
    const active = () => view === original && !lock.locked && !screen;
    if (action === 'status') return lock.status();
    if (action === 'lock') {lockTerminal(); return;}
    const result = action === 'enable' ? await lock.enable(pin,biometric,active) :
      action === 'disable' ? await lock.disable(pin,active) : null;
    if (!result) throw new Error('终端锁操作无效。');
    watchIdle();
    return result;
  });
  function gateHandler(channel, fn) {
    channels.push(prefix + channel);
    ipcMain.handle(prefix + channel,(event,...args) => {
      const gate = screen;
      if (!gate || view !== gate || !lock.locked || event.sender !== gate.webContents ||
          event.senderFrame !== gate.webContents.mainFrame || !isLocalDocument(event.senderFrame.url,lockPage)) throw new Error('请使用当前终端锁屏。');
      return fn(gate,...args);
    });
  }
  gateHandler('locked-biometric', () => lock.offeredBiometric());
  gateHandler('locked-unlock', async (gate, method, pin) => {
    const active = () => view === gate && screen === gate && Boolean(owner && !owner.isDestroyed() && gate.getVisible() && owner.isFocused());
    if (!active()) throw new Error('请先返回终端锁屏。');
    await lock.unlock(method,pin,active);
    if (!active()) {lock.lock(); throw new Error('终端窗口已变化。');}
    gate.setVisible(false);
    owner.contentView.removeChildView(gate);
    screen = undefined;
    if (parked) {
      view = parked; parked = undefined;
      for (const [id,count] of pendingAcks) sessions.ack(id,count);
      pendingAcks.clear();
      for (const [id,held] of heldEvents) {
        if (held.data) view.webContents.send(prefix + 'data',{id,data:held.data});
        if (held.exit) view.webContents.send(prefix + 'exit',held.exit);
      }
      heldEvents.clear();
      loading = Promise.resolve();
    } else makeView(viewScope.partition);
    owner.contentView.addChildView(view);
    focusOnShow = true; layout();
    gate.webContents.close();
  });

  function windowForTerminal() {
    if (detached && !detached.isDestroyed()) return detached;
    detached = new BrowserWindow({
      title: 'Brclio 终端', width: 1060, height: 720, minWidth: 580, minHeight: 360,
      show: false, backgroundColor: '#181b25', icon: path.join(__dirname, '../../web/assets/icon.png'),
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, partition: 'brclio-terminal-window-shell' },
    });
    configureNavigation(detached.webContents);
    if (process.platform !== 'darwin') detached.setMenu(null);
    return detached;
  }

  async function open(next = 'inline') {
    if (next !== 'inline' && next !== 'window') throw new Error('未知的终端显示模式。');
    await prepareView();
    const target = next === 'window' ? windowForTerminal() : (getMainWindow() || showMainWindow());
    if (!target || target.isDestroyed()) throw new Error('无法打开 Brclio 主窗口。');
    const terminal = view;
    if (owner !== target) {
      removeView();
      target.contentView.addChildView(terminal);
      owner = target;
      owner.on('resize', layout);
      owner.once('closed', ownerClosed);
      owner.on('hide', lockTerminal);
      owner.on('minimize', lockTerminal);
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
    for (const event of ['suspend','lock-screen']) electron.powerMonitor?.removeListener(event,lockTerminal);
    for (const channel of channels) ipcMain.removeHandler(channel);
    ipcMain.removeListener(prefix + 'ack', acknowledge);
    closeTerminal();
  }
  app.once('will-quit', dispose);
  return { open, toggleHotkey, dispose, setViewport, accountChanged: closeTerminal, getPresentation: () => mode, hasWindow: () => mode === 'window' };
}

module.exports = { createTerminalHost };

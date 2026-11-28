'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const { createTerminalHost } = require('./terminal/host.cjs');
const { createPtyService, forkService } = require('./terminal/service.cjs');

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    connected: true, posted: [],
    disconnect() { this.connected = false; this.emit('disconnect'); },
    send(message, callback) { this.posted.push(message); callback(); },
    respond(result) { this.emit('message', { serial: this.posted.at(-1).serial, result }); },
  });
}

test('only the live terminal frame owns its IPC across docking, hiding, detaching and closing', async t => {
  const windows = [];
  const views = [];
  class FakeContents extends EventEmitter {
    constructor() {
      super();
      this.session = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} };
      this.mainFrame = { url: 'about:blank' };
    }
    setWindowOpenHandler(handler) { this.openHandler = handler; }
    loadFile(file) { this.mainFrame = { url: pathToFileURL(file).href }; return Promise.resolve(); }
    getURL() { return this.mainFrame.url; }
    isDestroyed() { return Boolean(this.destroyed); }
    getZoomFactor() { return 1.25; }
    focus() { this.focused = true; }
    isFocused() { return Boolean(this.focused); }
    send() {}
    close() { this.destroyed = true; this.emit('destroyed'); }
  }
  class FakeView {
    constructor(options) {
      this.options = options;
      this.webContents = new FakeContents();
      views.push(this);
    }
    setBounds(bounds) { this.bounds = bounds; }
    setVisible(visible) { this.visible = visible; }
    setBackgroundColor() {}
  }
  class FakeWindow extends EventEmitter {
    constructor() {
      super();
      windows.push(this);
      this.webContents = new FakeContents();
      this.attached = new Set();
      this.contentView = { addChildView: view => this.attached.add(view), removeChildView: view => this.attached.delete(view) };
    }
    getContentSize() { return [1000, 600]; }
    setMenu() {}
    show() { this.visible = true; }
    hide() { this.visible = false; }
    isVisible() { return this.visible === true; }
    focus() {}
    isFocused() { return true; }
    isMinimized() { return false; }
    isDestroyed() { return Boolean(this.destroyed); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const handlers = new Map();
  const ipcMain = Object.assign(new EventEmitter(), {
    handle: (name, fn) => handlers.set(name, fn),
    removeHandler: name => handlers.delete(name),
  });
  const app = Object.assign(new EventEmitter(), { getPath: () => os.homedir() });
  const exports = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-transcript-'));
  t.after(() => fs.rm(exports, { recursive: true, force: true }));
  const targetFile = path.join(exports, 'terminal.txt');
  let choice = { canceled: true, filePath: targetFile };
  const dialogs = [];
  const dialog = { async showSaveDialog(owner, options) { dialogs.push({ owner, options }); return choice; } };
  let main = new FakeWindow();
  const modes = [];
  const host = createTerminalHost({ app, ipcMain, dialog, BrowserWindow: FakeWindow, WebContentsView: FakeView,
    getMainWindow: () => main.isDestroyed() ? null : main, showMainWindow: () => (main = new FakeWindow()),
    onPresentation: mode => modes.push(mode) });
  const profiles = handlers.get('brclio:terminal-window:profiles');
  const request = object => ({ sender: object.webContents, senderFrame: object.webContents.mainFrame });
  assert.equal(host.getPresentation(), 'closed');
  host.setViewport({ x: 160, y: 40, width: 900, height: 400 });
  await Promise.all([host.open(), host.open()]);
  assert.equal(windows.length, 1);
  assert.equal(views.length, 1);
  const view = views[0];
  assert.equal(view.options.webPreferences.nodeIntegration, false);
  assert.equal(view.options.webPreferences.contextIsolation, true);
  assert.equal(view.options.webPreferences.sandbox, true);
  assert.deepEqual(view.webContents.openHandler(), { action: 'deny' });
  assert.ok(main.attached.has(view));
  assert.deepEqual(view.bounds, { x: 200, y: 50, width: 800, height: 500 });
  const valid = request(view);
  const save = handlers.get('brclio:terminal-window:save-transcript');
  assert.throws(() => save(request(main), 'text', 'hello'), /终端窗口/);
  await assert.rejects(save(valid, targetFile, 'hello'), /格式/);
  await assert.rejects(save(valid, 'text', '中'.repeat(6 * 1024 * 1024)), /16 MiB/);
  assert.equal(dialogs.length, 0);
  assert.deepEqual(await save(valid, 'text', 'canceled'), { saved: false });
  assert.deepEqual(await fs.readdir(exports), []);
  choice = { canceled: false, filePath: targetFile };
  for (const [format, extension] of [['text', 'txt'], ['ansi', 'ansi'], ['html', 'html']]) {
    const content = 'Brclio 终端 ' + format;
    assert.deepEqual(await save(valid, format, content), { saved: true });
    assert.deepEqual(dialogs.at(-1).options.filters[0].extensions, [extension]);
    assert.equal(dialogs.at(-1).owner, main);
    assert.equal(await fs.readFile(targetFile, 'utf8'), content);
  }
  assert.deepEqual(await fs.readdir(exports), ['terminal.txt']);
  assert.ok((await profiles(valid)).some(profile => profile.id === 'default'));
  assert.throws(() => profiles(request(main)), /终端窗口/);
  assert.throws(() => profiles({ ...valid, senderFrame: { ...valid.senderFrame } }), /终端窗口/);
  const url = valid.senderFrame.url;
  valid.senderFrame.url = 'https://example.invalid/';
  assert.throws(() => profiles(valid), /终端窗口/);
  valid.senderFrame.url = url;

  host.setViewport(null);
  assert.equal(view.visible, false);
  await host.open('window');
  const detached = windows[1];
  assert.ok(!main.attached.has(view));
  assert.ok(detached.attached.has(view));
  await host.toggleHotkey('Ctrl+Alt+Y');
  assert.equal(detached.isVisible(), false);
  assert.equal(host.getPresentation(), 'window');
  assert.ok(detached.attached.has(view));
  await host.toggleHotkey('Ctrl+Alt+Y');
  assert.equal(detached.isVisible(), true);
  assert.equal(view.visible, true);
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 1000, height: 600 });
  assert.throws(() => profiles(request(detached)), /终端窗口/);
  host.setViewport(null);
  assert.equal(view.visible, true, 'hiding the placeholder does not affect a detached terminal');
  main.destroy();
  assert.equal(view.webContents.isDestroyed(), false);
  await handlers.get('brclio:terminal-window:set-presentation')(valid, 'inline');
  assert.ok(main.attached.has(view), 'docking reopens a closed main window');
  assert.ok(detached.isDestroyed());
  assert.equal(view.visible, false, 'docked view waits for its new host DOM geometry');
  assert.equal(views.length, 1);
  assert.ok((await profiles(valid)).some(profile => profile.id === 'default'));
  await assert.rejects(host.open('invalid'), /未知/);
  assert.throws(() => host.setViewport({ width: Infinity }), /无效/);
  main.destroy();
  assert.ok(view.webContents.isDestroyed());
  assert.throws(() => profiles(valid), /终端窗口/);
  await host.open('window');
  assert.ok((await profiles(request(views[1]))).some(profile => profile.id === 'default'));
  windows.at(-1).destroy();
  assert.equal(host.getPresentation(), 'closed');
  assert.deepEqual(modes, ['inline', 'window', 'inline', 'closed', 'window', 'closed']);
  host.dispose();
  assert.equal(handlers.size, 0);
  assert.equal(ipcMain.listenerCount('brclio:terminal-window:ack'), 0);
});

test('a crashed PTY service retires its panes and pending requests, then accepts a fresh session', async () => {
  const children = [];
  const events = [];
  const service = createPtyService({
    home: os.homedir(), send: (...message) => events.push(message),
    launch() {
      const child = fakeChild();
      children.push(child);
      return child;
    },
  });
  assert.equal(children.length, 0);
  const created = service.create({ id: 'first' });
  const first = children[0];
  first.respond({ id: 'first' });
  await created;
  const write = service.write('first', 'hello');
  service.ack('first', 4);
  const resize = service.resize('first', 90, 30);
  assert.deepEqual(first.posted.map(request => request.method), ['create', 'write', 'ack', 'resize']);
  first.emit('exit', 1);
  await Promise.all([assert.rejects(write, /终端服务意外退出/), assert.rejects(resize, /终端服务意外退出/)]);
  assert.equal(events.length, 1);
  assert.equal(events[0][0], 'exit');
  assert.equal(events[0][1].id, 'first');
  assert.match(events[0][1].error, /终端服务意外退出/);
  service.ack('first', 2);
  await assert.rejects(service.write('first', 'x'), /会话已结束/);
  assert.equal(children.length, 1, 'stale input must not start another process');
  const fresh = service.create({ id: 'next' });
  children[1].respond({ id: 'next' });
  await fresh;
  first.emit('message', { channel: 'data', payload: { id: 'first', data: 'late' } });
  assert.equal(events.length, 1);
  const close = service.close('next');
  service.closeAll();
  await assert.rejects(close, /终端窗口已关闭/);
  assert.equal(children[1].connected, false);
});

test('finishing the last pane retires the service after overlapping requests complete, and new panes still start', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let child;
  const service = createPtyService({
    home: os.homedir(), send() {}, launch() { child = fakeChild(); return child; },
  });
  t.after(() => service.closeAll());
  const create = service.create({ id: 'first' });
  const firstChild = child;
  child.respond({ id: 'first' });
  await create;
  const next = service.create({ id: 'next' });
  child.emit('message', { channel: 'exit', payload: { id: 'first', exitCode: 0 } });
  t.mock.timers.tick(1000);
  assert.equal(child.connected, true, 'the in-flight create owns this service');
  child.respond({ id: 'next' });
  await next;
  t.mock.timers.tick(1000);
  assert.equal(child.connected, true, 'another pane is still running');
  const close = service.close('next');
  child.respond();
  await close;
  const profiles = service.profiles();
  t.mock.timers.tick(1000);
  assert.equal(child.connected, true, 'a queued profile read must finish');
  child.respond([]);
  await profiles;
  t.mock.timers.tick(1000);
  assert.equal(child.connected, false, 'closing the final pane releases the service');
  const fresh = service.create({ id: 'fresh' });
  assert.notEqual(child, firstChild);
  child.respond({ id: 'fresh' });
  await fresh;
  child.emit('message', { channel: 'exit', payload: { id: 'fresh', exitCode: 0 } });
  t.mock.timers.tick(1000);
  assert.equal(child.connected, false, 'natural shell exit also releases the service');
});

test('closing a terminal reaps the real service even when only shell profiles were requested', { timeout: 10000 }, async t => {
  let child;
  const service = createPtyService({
    home: os.homedir(), send() {}, launch(home) { child = forkService(home); return child; },
  });
  t.after(() => service.closeAll());
  await service.profiles();
  const ended = once(child, 'exit');
  service.closeAll();
  const [code] = await ended;
  assert.equal(code, 0);
  assert.equal(child.connected, false);
});

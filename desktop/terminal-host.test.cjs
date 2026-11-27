'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const os = require('node:os');
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

test('terminal IPC only accepts the live local main frame of its dedicated window', async () => {
  const windows = [];
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      windows.push(this);
      this.options = options;
      this.webContents = Object.assign(new EventEmitter(), {
        session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
        setWindowOpenHandler(handler) { this.openHandler = handler; },
        isDestroyed: () => Boolean(this.destroyed),
      });
    }
    loadFile(file) { this.webContents.mainFrame = { url: pathToFileURL(file).href }; return Promise.resolve(); }
    setMenu() {}
    show() {}
    focus() {}
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
  const host = createTerminalHost({ app, ipcMain, BrowserWindow: FakeWindow });
  const profiles = handlers.get('brclio:terminal-window:profiles');
  const request = win => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  await Promise.all([host.open(), host.open()]);
  assert.equal(windows.length, 1);
  const win = windows[0];
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.deepEqual(win.webContents.openHandler(), { action: 'deny' });
  const valid = request(win);
  assert.ok((await profiles(valid)).some(profile => profile.id === 'default'));
  assert.throws(() => profiles({ ...valid, sender: {} }), /终端窗口/);
  assert.throws(() => profiles({ ...valid, senderFrame: { ...valid.senderFrame } }), /终端窗口/);
  valid.senderFrame.url = 'https://example.invalid/';
  assert.throws(() => profiles(valid), /终端窗口/);
  win.destroy();
  await host.open();
  assert.throws(() => profiles(valid), /终端窗口/);
  assert.ok((await profiles(request(windows[1]))).some(profile => profile.id === 'default'));
  host.dispose();
  assert.equal(handlers.size, 0);
  assert.equal(ipcMain.listenerCount('brclio:terminal-window:ack'), 0);
  assert.ok(windows[1].isDestroyed());
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

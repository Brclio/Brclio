'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const { createTerminalHost } = require('./terminal/host.cjs');

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
  assert.ok(profiles(valid).some(profile => profile.id === 'default'));
  assert.throws(() => profiles({ ...valid, sender: {} }), /终端窗口/);
  assert.throws(() => profiles({ ...valid, senderFrame: { ...valid.senderFrame } }), /终端窗口/);
  valid.senderFrame.url = 'https://example.invalid/';
  assert.throws(() => profiles(valid), /终端窗口/);
  win.destroy();
  await host.open();
  assert.throws(() => profiles(valid), /终端窗口/);
  assert.ok(profiles(request(windows[1])).some(profile => profile.id === 'default'));
  host.dispose();
  assert.equal(handlers.size, 0);
  assert.equal(ipcMain.listenerCount('brclio:terminal-window:ack'), 0);
  assert.ok(windows[1].isDestroyed());
});

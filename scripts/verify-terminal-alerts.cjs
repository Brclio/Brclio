'use strict';

const assert = require('node:assert/strict');
const { expect } = require('@playwright/test');

async function verifyTerminalAlerts(app, terminal, command, windows) {
  const key = 'Ctrl+Alt+Shift+J';
  const capture = terminal.locator('#terminal-hotkey-record');
  const bell = terminal.locator('#terminal-bell-enabled');
  const active = terminal.locator('.pane.active:visible');
  const shell = windows
    ? "[Console]::Write(([string][char]7) * 3); Write-Output ('BELL-' + 'DELIVERED')"
    : "printf '\\a\\a\\aBELL-%s\\n' DELIVERED";
  const config = () => terminal.evaluate(() => window.brclioTerminal.getAlertSettings());
  const notices = () => app.evaluate(() => globalThis.__terminalBellTest.count);
  const initial = await config();
  assert.equal(initial.hotkey, null);
  assert.equal(initial.bell, false);
  // Run the real registration and PTY bell paths, and intercept OS notifications
  // at presentation time so a development smoke never alerts the user's desktop.
  await app.evaluate(({ Notification, globalShortcut }, key) => {
    const register = globalShortcut.register;
    const supported = Notification.isSupported;
    const show = Notification.prototype.show;
    const probe = globalThis.__terminalBellTest = { count: 0, restore() {
      globalShortcut.register = register;
      Notification.isSupported = supported;
      Notification.prototype.show = show;
    } };
    Notification.isSupported = () => true;
    Notification.prototype.show = function () { probe.count++; };
    globalShortcut.register = function (keyToRegister, action) {
      const registered = register.call(this, keyToRegister, action);
      if (keyToRegister === key && registered) probe.activate = action;
      return registered;
    };
  }, key);
  try {
    await command(shell);
    await expect(active.locator('.xterm-rows')).toContainText('BELL-DELIVERED');
    assert.equal(await notices(), 0);
    const pane = await active.getAttribute('data-id');
    const originalMode = await terminal.evaluate(() => window.brclioTerminal.getPresentation());
    await terminal.locator('#terminal-actions').click();
    await capture.click();
    await expect(capture).toHaveText('取消录入');
    await terminal.keyboard.press('Control+Alt+Shift+J');
    await expect.poll(async () => (await config()).hotkey).toBe(key);
    assert.equal((await config()).registered, true);
    assert.equal(await app.evaluate(({ globalShortcut }, value) => globalShortcut.register(value, () => {}), key), false);
    await assert.rejects(terminal.evaluate(value => window.brclioTerminal.setHotkey(value), initial.copyShortcut), /复制路径/);
    assert.equal((await config()).hotkey, key);
    await bell.check();
    await expect.poll(async () => (await config()).bell).toBe(true);
    await terminal.locator('#actions-close').click();
    await command(shell);
    await expect.poll(notices).toBe(1);
    // Exercise the callback registered with Electron, including its actual
    // BrowserWindow visibility and WebContentsView, without sending system keys.
    const fire = () => app.evaluate(() => globalThis.__terminalBellTest.activate());
    const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window =>
      window.isVisible() && window.contentView.children.some(view => view.webContents?.getURL().endsWith('/desktop/terminal/index.html')) &&
      !window.webContents.getURL().endsWith('/web/index.html')));
    if (originalMode === 'inline') await fire();
    await expect.poll(visible).toBe(true);
    await fire();
    await expect.poll(visible).toBe(false);
    await fire();
    await expect.poll(visible).toBe(true);
    assert.equal(await active.getAttribute('data-id'), pane);
    await expect(active.locator('.xterm-rows')).toContainText('BELL-DELIVERED');
    if (originalMode === 'inline') await terminal.evaluate(() => window.brclioTerminal.setPresentation('inline'));
    await terminal.locator('#terminal-actions').click();
    await bell.uncheck();
    await expect.poll(async () => (await config()).bell).toBe(false);
    await terminal.locator('#terminal-hotkey-clear').click();
    await expect.poll(async () => (await config()).hotkey).toBeNull();
    assert.equal(await app.evaluate(({globalShortcut}, value) => globalShortcut.isRegistered(value), key), false);
    await terminal.locator('#actions-close').click();
    assert.equal(await notices(), 1);
  } finally {
    await app.evaluate(() => { globalThis.__terminalBellTest.restore(); delete globalThis.__terminalBellTest; });
  }
}

module.exports = { verifyTerminalAlerts };

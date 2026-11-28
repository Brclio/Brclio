'use strict';

const assert = require('node:assert/strict');
const { expect } = require('@playwright/test');
const path = require('node:path');

async function verifyUnboundTransfer(app, terminal) {
  // Seed the actual legacy session. The hidden page has the same file origin as
  // the terminal but has no IPC preload and no active terminal or shell.
  const file = path.join(__dirname, '..', 'desktop', 'terminal', 'unbound-transfer.html');
  await app.evaluate(async ({ WebContentsView, dialog }, file) => {
    const view = new WebContentsView({ webPreferences: { partition: 'persist:brclio-terminal', sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await view.webContents.loadFile(file);
    await view.webContents.executeJavaScript(`
      localStorage.setItem('brclio.terminal.connections.v1', JSON.stringify([{name:'Guest fixture',host:'guest.example.test'}]));
      localStorage.setItem('brclio.terminal.account.v1.fixture-b/brclio.terminal.connections.v1', 'other-account-marker');
      localStorage.setItem('unrelated-guest-marker', 'private');
    `);
    const old = dialog.showMessageBox;
    const fixture = globalThis.__unboundFixture = { view, accept: false };
    dialog.showMessageBox = (win, options) => options.title === '移入未关联的本机配置' ? Promise.resolve({ response: fixture.accept ? 1 : 0 }) : old.call(dialog, win, options);
    fixture.undo = () => { dialog.showMessageBox = old; view.webContents.close(); delete globalThis.__unboundFixture; };
  }, file);
  try {
    await terminal.evaluate(() => window.BrclioTerminalSync.open());
    const section = terminal.locator('[data-sync=migration]');
    await expect(section).toBeVisible();
    assert.equal(await terminal.evaluate(() => localStorage.getItem('unrelated-guest-marker')), null);
    const rawGuest = () => app.evaluate(() => globalThis.__unboundFixture.view.webContents.executeJavaScript(
      "localStorage.getItem('brclio.terminal.connections.v1')"));
    assert.ok(await rawGuest());
    const cancel = await terminal.evaluate(() => window.brclioTerminal.unboundTransfer('move', 'fixture-a'));
    assert.deepEqual(cancel, { moved: false });
    assert.ok(await rawGuest());
    assert.equal(await terminal.evaluate(() => window.BrclioConnection.store(localStorage).all().some(item => item.name === 'Guest fixture')), false);
    await app.evaluate(() => { globalThis.__unboundFixture.accept = true; });
    await section.locator('summary').click();
    await section.locator('[data-sync=move]').click();
    await expect(terminal.locator('[data-sync=status]')).toContainText('已移入');
    await expect(section).toBeHidden();
    assert.equal(await rawGuest(), null);
    assert.deepEqual(await terminal.evaluate(() => window.BrclioConnection.store(localStorage).all().map(item => item.name)),
      ['A private fixture', 'Guest fixture']);
    const remaining = await app.evaluate(() => globalThis.__unboundFixture.view.webContents.executeJavaScript(
      "[localStorage.getItem('unrelated-guest-marker'),localStorage.getItem('brclio.terminal.account.v1.fixture-b/brclio.terminal.connections.v1')]"));
    assert.deepEqual(remaining, ['private', 'other-account-marker']);
    await expect.poll(() => terminal.evaluate(() => window.BrclioTerminalPartitions.owner)).toBe('fixture-a');
    await assert.rejects(terminal.evaluate(() => window.brclioTerminal.unboundTransfer('available', 'fixture-b')), /账号/);
    console.log('Native cross-partition transfer passed: opt-in visibility, cancellation, fixed-key import, guest cleanup and recipient binding.');
  } finally {
    await app.evaluate(() => globalThis.__unboundFixture.undo());
  }
}

module.exports = { verifyUnboundTransfer };

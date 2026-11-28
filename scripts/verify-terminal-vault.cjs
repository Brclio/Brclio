'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { expect } = require('@playwright/test');

async function verifyTerminalVault(app, terminal, command, windows) {
  if (windows && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted') {
    assert.ok(await app.evaluate(async ({ safeStorage }) => {
      const synthetic = process.getBuiltinModule('crypto').randomBytes(20).toString('hex');
      if (!await safeStorage.isAsyncEncryptionAvailable()) return false;
      const encrypted = await safeStorage.encryptStringAsync(synthetic);
      return !encrypted.includes(synthetic) && (await safeStorage.decryptStringAsync(encrypted)).result === synthetic;
    }), 'hosted Windows runner round-trips a generated value with its OS key protection');
    console.log('Terminal vault: Windows DPAPI round-trip passed on the hosted runner.');
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-vault-probe-'));
  const fixture = 'fixture-' + crypto.randomBytes(8).toString('hex');
  const digest = crypto.createHash('sha256').update(fixture).digest('hex');
  const probe = path.join(tmp, 'receiver.cjs');
  await fs.writeFile(probe, `
  process.stdin.setRawMode(true);
  process.stdout.write('BRCLIO RECEIVER READY\\n');
  const chunks = [];
  let timer;
  process.stdin.on('data', part => {
    chunks.push(part);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const value = require('node:crypto').createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
      process.stdout.write(value === ${JSON.stringify(digest)} ? 'BRCLIO SINGLE FILL' : 'BRCLIO UNEXPECTED BYTES');
      process.exit();
    }, 100);
  });
  `);
  const wrap = value => windows ? "'" + value.replaceAll("'", "''") + "'" : "'" + value.replaceAll("'", "'\\''") + "'";
  const receiver = (windows ? '& ' : '') + [process.execPath, probe].map(wrap).join(' ');
  const originalTabs = await terminal.locator('#tabs [role=tab]').count();
  const originalActive = await terminal.locator('#tabs [aria-selected=true]').getAttribute('id');
  // Substitute the OS key provider in this isolated smoke. Developer machines
  // must never be asked to unlock a personal Keychain to run this test.
  await app.evaluate(({ safeStorage, dialog, clipboard }) => {
    const probe = globalThis.__vaultTest = { checks: 0, clipboard: 0, decision: 0, targets: [] };
    const crypt = process.getBuiltinModule('crypto');
    const key = crypt.randomBytes(32);
    const undo = [];
    function replace(object, name, handler) {
      const saved = object[name]; object[name] = handler; undo.push(() => { object[name] = saved; });
    }
    replace(safeStorage, 'isAsyncEncryptionAvailable', async () => { probe.checks++; return true; });
    replace(safeStorage, 'encryptStringAsync', async value => {
      const iv = crypt.randomBytes(12), cipher = crypt.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    });
    replace(safeStorage, 'decryptStringAsync', async bytes => {
      const cipher = crypt.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return { result: Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8') };
    });
    replace(clipboard, 'writeText', () => { probe.clipboard++; });
    replace(dialog, 'showMessageBox', async (window, options) => {
      probe.targets.push(options.detail);
      if (probe.swap) {
        const contents = window.contentView.children.find(view => view.webContents?.getURL().endsWith('/desktop/terminal/index.html')).webContents;
        await contents.executeJavaScript("document.querySelector('#workspace .panel:not([hidden]) .pane:not(.active)').dispatchEvent(new Event('pointerdown',{bubbles:true}))");
      }
      return { response: probe.decision };
    });
    probe.restore = () => undo.reverse().forEach(restore => restore());
  });
  const active = terminal.locator('.pane.active:visible');
  const open = () => terminal.locator('#terminal-actions').click();
  const focus = () => app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      const view = win.contentView.children.find(child => child.webContents?.getURL().endsWith('/desktop/terminal/index.html'));
      if (view) { win.focus(); view.webContents.focus(); return; }
    }
  });
  try {
    await terminal.locator('#new-tab').click();
    await command(receiver);
    await expect(active.locator('.xterm-rows')).toContainText('BRCLIO RECEIVER READY');
    await terminal.locator('#split-right').click();
    await command(receiver);
    await expect(active.locator('.xterm-rows')).toContainText('BRCLIO RECEIVER READY');
    const paneId = await active.getAttribute('data-id');
    await open();
    await terminal.locator('#broadcast-options summary').click();
    await expect(terminal.locator('#broadcast-members input')).toHaveCount(2);
    for (const item of await terminal.locator('#broadcast-members input').all()) await item.check();
    await terminal.locator('#broadcast-toggle').click();
    await open();
    await terminal.locator('#history-details summary').click();
    await terminal.locator('#paste-record').check();
    assert.equal(await app.evaluate(() => globalThis.__vaultTest.checks), 0);
    await terminal.locator('#vault-controls summary').click();
    assert.equal(await app.evaluate(() => globalThis.__vaultTest.checks), 0);
    await focus();
    await terminal.locator('#vault-unlock').click();
    await expect(terminal.locator('#vault-add')).toBeEnabled();
    await expect(terminal.locator('#vault-list option')).toHaveCount(0);
    await terminal.locator('#vault-name').fill('合成验收条目');
    await terminal.locator('#vault-secret').fill(fixture);
    await terminal.locator('#vault-add').click();
    await expect(terminal.locator('#vault-fill')).toBeEnabled();
    assert.equal(await terminal.locator('#vault-secret').inputValue(), '');
    await terminal.locator('#vault-fill').click();
    await expect(terminal.locator('#vault-status')).toHaveText('已取消。');
    await app.evaluate(() => { globalThis.__vaultTest.decision = 1; globalThis.__vaultTest.swap = true; });
    await terminal.locator('#vault-fill').click();
    await expect(terminal.locator('#vault-status')).toContainText('活动窗格已更改');
    await terminal.evaluate(id => document.querySelector('.pane[data-id="' + id + '"]').dispatchEvent(new Event('pointerdown', { bubbles: true })), paneId);
    await app.evaluate(() => { globalThis.__vaultTest.swap = false; });
    await terminal.locator('#vault-fill').click();
    await expect(active.locator('.xterm-rows')).toContainText('BRCLIO SINGLE FILL');
    const other = terminal.locator('.panel:visible .pane:not(.active) .xterm-rows');
    await expect(other).not.toContainText(/BRCLIO SINGLE FILL|BRCLIO UNEXPECTED BYTES/);
    const proof = await app.evaluate(() => ({ clipboard: globalThis.__vaultTest.clipboard, targets: globalThis.__vaultTest.targets }));
    assert.equal(proof.clipboard, 0);
    assert.equal(proof.targets.length, 3);
    assert.ok(proof.targets.every(detail => detail.includes(paneId.slice(0, 8)) && !detail.includes(fixture)));
    await open();
    await terminal.locator('#history-details summary').click();
    await expect(terminal.locator('#paste-list option')).toHaveCount(0);
    await terminal.locator('#vault-controls summary').click();
    await focus();
    await terminal.locator('#vault-unlock').click();
    await terminal.locator('#vault-remove').click();
    await expect(terminal.locator('#vault-list option')).toHaveCount(0);
    await terminal.locator('#actions-close').click();
    await terminal.locator('#tabs .tab-close').last().click();
    await terminal.locator('#' + originalActive).click();
    assert.equal(await terminal.locator('#tabs [role=tab]').count(), originalTabs);
  } finally {
    await app.evaluate(() => { globalThis.__vaultTest.restore(); delete globalThis.__vaultTest; });
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

module.exports = { verifyTerminalVault };

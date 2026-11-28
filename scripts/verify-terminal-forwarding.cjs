'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { expect } = require('@playwright/test');

async function verifyForwarding(terminal) {
  const fixture = net.createServer();
  const pending = new Set();
  let received = false;
  fixture.on('connection', socket => {
    pending.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => pending.delete(socket));
    socket.write('SSH-2.0-BrclioForwardUIFixture\r\n');
    socket.on('data', () => { received = true; });
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  try {
    const available = await terminal.evaluate(() => window.brclioTerminal.remoteClients());
    const tabs = terminal.locator('#tabs [role=tab]');
    const original = await tabs.count();
    await terminal.evaluate(() => window.BrclioForwardControls.open());
    const dialog = terminal.locator('#forward-dialog');
    const click = key => dialog.locator('[data-action="' + key + '"]').click();
    await dialog.locator('#forward-name').fill('CI 回环转发');
    await dialog.locator('#forward-type').selectOption('dynamic');
    await expect(dialog.locator('#forward-destinationHost')).toBeHidden();
    await dialog.locator('#forward-host').fill('127.0.0.1');
    await dialog.locator('#forward-port').fill(String(fixture.address().port));
    await dialog.locator('#forward-listenPort').fill('19872');
    await click('save');
    await expect(dialog.locator('#forward-status')).toContainText('已保存');
    if (available.ssh) {
      await click('start');
      await expect(dialog).toBeHidden();
      await expect(tabs).toHaveCount(original + 1);
      await expect.poll(() => received).toBe(true);
      await terminal.evaluate(() => window.BrclioForwardControls.open());
      await expect(dialog.locator('[data-action="stop"]')).toBeVisible();
      await click('stop');
      await expect(tabs).toHaveCount(original);
      await expect.poll(() => pending.size).toBe(0);
    }
    await click('remove');
    await expect(dialog.locator('#forward-list option')).toHaveCount(1);
    await click('close');
    await terminal.evaluate(() => window.BrclioKnownHosts.open({ host: 'test-host', port: 22 }));
    const known = terminal.locator('#known-hosts-dialog');
    await expect(known.locator('#known-host')).toHaveValue('test-host');
    // An invalid target exercises IPC validation without accessing a tester's real known_hosts file.
    await known.locator('#known-host').fill('-bad-name');
    await known.locator('#known-search').click();
    await expect(known.locator('#known-status')).toContainText('主机名');
    await known.locator('#known-close').click();
    assert.equal(await tabs.count(), original);
  } finally {
    for (const socket of pending) socket.destroy();
    await new Promise(resolve => fixture.close(resolve));
  }
}
async function verifyIdentity(terminal, app, directory) {
  const file = require('node:path').join(directory, 'test Ed25519 key');
  const { ssh } = await terminal.evaluate(() => window.brclioTerminal.remoteClients());
  if (!ssh) return;
  const saved = await app.evaluateHandle(({ dialog }) => dialog.showSaveDialog);
  const savedClipboard = await app.evaluateHandle(({ clipboard }) => clipboard.writeText);
  const openFile = await app.evaluateHandle(({ dialog }) => dialog.showOpenDialog);
  try {
    await app.evaluate(({ dialog, clipboard }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
      clipboard.writeText = text => { globalThis.__brclioPublicKeyCheck = text; };
    }, file);
    await terminal.evaluate(() => window.BrclioIdentityControls.open());
    const dialog = terminal.locator('#identity-dialog');
    const click = name => dialog.locator('[data-id-action="' + name + '"]').click();
    await dialog.locator('#identity-name').fill('临时 CI 身份');
    await dialog.locator('#identity-user').fill('fixture');
    await click('generate');
    await expect(dialog).toBeHidden();
    const pane = terminal.locator('#workspace .panel:not([hidden]) .pane.active');
    const rows = pane.locator('.xterm-rows');
    const password = require('node:crypto').randomUUID();
    for (const prompt of [/enter passphrase/i, /enter same passphrase/i]) {
      await expect(rows).toContainText(prompt);
      await pane.locator('textarea.xterm-helper-textarea').focus();
      await terminal.keyboard.type(password);
      await terminal.keyboard.press('Enter');
    }
    await expect(pane).toHaveAttribute('data-state','exited');
    await expect.poll(() => terminal.evaluate(() => window.BrclioIdentities.store(localStorage).all().some(item => item.name === '临时 CI 身份'))).toBe(true);
    await terminal.locator('#tabs .tab:has([aria-selected=true]) .tab-close').click();
    await terminal.evaluate(() => window.BrclioIdentityControls.open());
    await dialog.locator('#identity-list').selectOption('临时 CI 身份');
    await click('public');
    await expect(dialog.locator('#identity-fingerprint')).toContainText('SHA256:');
    await click('copy');
    await expect.poll(() => app.evaluate(() => globalThis.__brclioPublicKeyCheck)).toMatch(/^ssh-ed25519 /);
    await click('close');
    await terminal.evaluate(() => window.BrclioRemoteConnections.open());
    const host = terminal.locator('#remote-library');
    await host.locator('#remote-new').click();
    await host.locator('#remote-name').fill('CI 认证主机');
    await host.locator('#remote-host').fill('first.example.invalid');
    await host.locator('#remote-advanced').evaluate(element => { element.open = true; });
    await host.locator('#remote-identity-preset').selectOption('临时 CI 身份');
    await expect(host.locator('#remote-identityFile')).toHaveValue(file);
    await expect(host.locator('#remote-user')).toHaveValue('fixture');
    const path = require('node:path');
    const ssh = require('../desktop/terminal/remote-launch.cjs').program('ssh');
    const keygen = path.join(path.dirname(ssh), process.platform === 'win32' ? 'ssh-keygen.exe' : 'ssh-keygen');
    const run = require('node:util').promisify(require('node:child_process').execFile);
    const ca = path.join(directory, 'fixture-ca');
    await run(keygen, ['-q','-t','ed25519','-N','','-f',ca], {timeout:10000, windowsHide:true});
    await run(keygen, ['-q','-s',ca,'-I','fixture-only','-n','fixture',file + '.pub'], {timeout:10000, windowsHide:true});
    await app.evaluate(({ dialog }, fixture) => {
      dialog.showOpenDialog = async () => ({ canceled:false, filePaths:[fixture] });
    }, file + '-cert.pub');
    await host.locator('#remote-choose-certificate').click();
    await expect(host.locator('#remote-certificateFile')).toHaveValue(file + '-cert.pub');
    await expect(host.locator('#remote-agent-forwarding')).not.toBeChecked();
    await host.locator('#remote-agent-forwarding').check();
    await host.locator('#remote-save').click();
    await host.locator('#remote-list button').filter({ hasText:'CI 认证主机' }).click();
    await expect(host.locator('#remote-agent-forwarding')).toBeChecked();
    await expect(host.locator('#remote-certificateFile')).toHaveValue(file + '-cert.pub');
    await host.locator('#remote-host').fill('other.example.invalid');
    await expect(host.locator('#remote-agent-forwarding')).not.toBeChecked();
    await expect(host.locator('#remote-certificateFile')).toHaveValue('');
    await host.locator('#remote-remove').click();
    await host.locator('#remote-delete-confirm').click();
    await host.locator('#remote-close').click();
    await terminal.evaluate(() => window.BrclioIdentityControls.open());
    await click('remove');
    await click('close');
  } finally {
    await app.evaluate(({ dialog }, original) => { dialog.showSaveDialog = original; }, saved);
    await app.evaluate(({ clipboard }, original) => { clipboard.writeText = original; delete globalThis.__brclioPublicKeyCheck; }, savedClipboard);
    await app.evaluate(({dialog},original) => { dialog.showOpenDialog = original; }, openFile);
    await openFile.dispose();
    await saved.dispose();
    await savedClipboard.dispose();
  }
}

module.exports = { verifyForwarding, verifyIdentity };

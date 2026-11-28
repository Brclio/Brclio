'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { _electron: electron, expect } = require('@playwright/test');

async function main() {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-log-ui-'));
  const windows = process.platform === 'win32';
  let app;
  try {
    const env = { ...process.env, BRCLIO_USER_DATA: temp, ZDOTDIR: temp, HISTFILE: path.join(temp, 'history') };
    if (windows) delete env.PSModulePath;
    const executable = process.env.BRCLIO_SMOKE_EXECUTABLE;
    app = await electron.launch({ cwd: root, args: executable ? [] : [root],
      ...(executable ? { executablePath: path.resolve(executable) } : {}), env });
    const home = await app.firstWindow();
    await home.locator('body[data-ready="true"]').waitFor({ state: 'attached', timeout: 90000 });
    // The fixture uses an ephemeral account, an offline identity proof and synthetic encryption.
    // Do not send fixture account credentials or prompt the user's native keychain.
    await app.evaluate(({ net, safeStorage }) => {
      const crypt = process.getBuiltinModule('crypto');
      const key = crypt.randomBytes(32);
      net.fetch = async () => { throw new Error('Offline terminal fixture'); };
      const set = (name, value) => Object.defineProperty(safeStorage, name, { configurable: true, value });
      set('isEncryptionAvailable', () => true);
      set('encryptString', value => {
        const iv = crypt.randomBytes(12), c = crypt.createCipheriv('aes-256-gcm', key, iv);
        const bytes = Buffer.concat([c.update(value, 'utf8'), c.final()]);
        return Buffer.concat([iv, c.getAuthTag(), bytes]);
      });
      set('decryptString', bytes => {
        const c = crypt.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        c.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([c.update(bytes.subarray(28)), c.final()]).toString();
      });
    });
    const token = crypto.randomUUID();
    await fs.writeFile(path.join(temp, 'account-session.json'), JSON.stringify({ token }));
    await fs.writeFile(path.join(temp, 'terminal-account-binding.json'),
      JSON.stringify({ digest: crypto.createHash('sha256').update(token).digest('hex'), user: { id: 'fixture-log-user' } }));
    const terminalReady = app.waitForEvent('window');
    await home.locator('[data-open-terminal].nav-item').click();
    const terminal = await terminalReady;
    await terminal.waitForURL('file://**/desktop/terminal/index.html');
    const pane = terminal.locator('.pane.active:visible');
    await expect(pane).toHaveCount(1);
    await terminal.locator('#connection-center').click();
    await terminal.locator('button[data-center=logs]').click();
    const dialog = terminal.getByRole('dialog', { name: '本机会话日志' });
    await dialog.getByRole('textbox', { name: '日志名称' }).fill('fixture recording');
    await dialog.getByRole('button', { name: '开始记录当前窗格' }).click();
    await expect(dialog.getByRole('button', { name: '停止记录' })).toBeEnabled();
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    const input = pane.locator('textarea.xterm-helper-textarea');
    await input.focus();
    await terminal.keyboard.type(windows ? "[Console]::WriteLine(('BRCLIO-LOG-'+'OUTPUT'))" : "printf 'BRCLIO-LOG-%s\\n' OUTPUT");
    await terminal.keyboard.press('Enter');
    await expect(pane.locator('.xterm-rows')).toContainText('BRCLIO-LOG-OUTPUT');
    await terminal.getByRole('button', { name: '正在记录 · 会话日志' }).click();
    await expect(dialog.getByRole('textbox', { name: '日志内容' })).toHaveValue(/BRCLIO-LOG-OUTPUT/);
    await dialog.getByRole('textbox', { name: '书签名称' }).fill('Command output');
    await dialog.getByRole('button', { name: '添加书签' }).click();
    await expect(dialog.locator('option').filter({ hasText: 'Command output' })).toHaveCount(1);
    await dialog.getByRole('button', { name: '停止记录' }).click();
    await expect(dialog.getByRole('button', { name: '停止记录' })).toBeDisabled();
    await require('./verify-terminal-log-cloud.cjs').verifyCloudCopy(app,terminal,dialog);
    await dialog.getByRole('button', { name: '删除所选日志' }).click();
    await dialog.getByRole('button', { name: '确认删除' }).click();
    await expect(dialog.getByRole('listbox').locator('option')).toHaveCount(0);
    assert.ok(await fs.stat(path.join(temp, 'terminal-logs')));
    console.log('Terminal UI recorded real selected shell output; bookmark, stop and deletion passed');
  } finally {
    if (app) await app.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');
const { createBrowser } = require('../desktop/terminal/sftp-host.cjs');
const { connectProtocol } = require('../desktop/terminal/sftp-protocol.cjs');

async function verifySftpHelper(app) {
  const checked = await app.evaluate(async ({ app }) => {
    const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    const fs = load('node:fs/promises');
    const path = load('node:path');
    const { spawnSync } = load('node:child_process');
    const helper = await load('./desktop/terminal/sftp-askpass.cjs').prepareAskpass();
    try {
      await fs.access(helper.file, fs.constants.X_OK);
      const probe = spawnSync(helper.file, [], { windowsHide: true, timeout: 10000 });
      if (probe.error) throw probe.error;
      const packagedExe = process.platform === 'win32' && app.isPackaged;
      return { status: probe.status, shipped: !packagedExe || path.dirname(helper.file) === path.join(process.resourcesPath, 'terminal-auth') };
    } finally { await helper.cleanup(); }
  });
  assert.deepEqual(checked, { status: 1, shipped: true });
}

async function verifySftpEntry(terminal) {
  // A refused loopback connection exercises the normal host library → trusted IPC path.
  await terminal.evaluate(() => window.BrclioRemoteConnections.open());
  const library = terminal.locator('#remote-library');
  await library.locator('#remote-new').click();
  await library.locator('#remote-host').fill('127.0.0.1');
  await library.locator('#remote-port').fill('1');
  await library.locator('#remote-files').click();
  const dialog = terminal.getByRole('dialog', { name: 'SFTP 文件管理' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('status')).toContainText(/refused|拒绝|closed|关闭/i, { timeout: 35000 });
  await dialog.getByRole('button', { name: '关闭' }).click();
  await expect(dialog).toHaveCount(0);
}

async function verifyTransferControls() {
  const binary = process.platform === 'darwin' ? '/usr/libexec/sftp-server' : process.platform === 'win32'
    ? path.join(process.env.SystemRoot, 'System32', 'OpenSSH', 'sftp-server.exe') : '/usr/lib/openssh/sftp-server';
  await fs.access(binary);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-sftp-ui-'));
  const local = path.join(root, 'local'), remote = path.join(root, 'remote');
  const chromeOptions = { headless: true, channel: process.env.BRCLIO_CHROME ? undefined : 'chrome', executablePath: process.env.BRCLIO_CHROME };
  let chrome, service;
  try {
    await fs.mkdir(local); await fs.mkdir(remote);
    await fs.writeFile(path.join(local, '上传测试.txt'), 'Brclio SFTP 浏览器');
    chrome = await chromium.launch(chromeOptions);
    const page = await chrome.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    service = createBrowser({
      chooseLocal: async () => local,
      start: () => connectProtocol(spawn(binary, [], { cwd: remote, windowsHide: true })),
    });
    await page.exposeFunction('sftpFixture', service.action);
    await page.goto(require('node:url').pathToFileURL(__filename).href);
    await page.evaluate(() => {
      document.body.replaceChildren();
      window.brclioTerminal = { sftp: window.sftpFixture };
    });
    for (const file of ['connection.js', 'sftp-browser.js']) {
      await page.addScriptTag({ path: path.join(__dirname, '../desktop/terminal', file) });
    }
    await page.addStyleTag({ path: path.join(__dirname, '../desktop/terminal/sftp-browser.css') });
    await page.evaluate(() => window.BrclioSftp.open({ host: 'fixture' }));
    const dialog = page.getByRole('dialog', { name: 'SFTP 文件管理' });
    const localList = dialog.getByRole('listbox', { name: '本地文件列表' });
    const remoteList = dialog.getByRole('listbox', { name: '远端文件列表' });
    await dialog.getByRole('button', { name: '选择目录' }).click();
    await localList.selectOption('上传测试.txt');
    await dialog.getByRole('button', { name: '上传到远端' }).click();
    await expect(dialog.getByRole('status')).toContainText('上传完成');
    await remoteList.selectOption('上传测试.txt');
    await dialog.getByRole('button', { name: '重命名' }).click();
    await dialog.getByRole('textbox', { name: '新名称' }).fill('下载测试.txt');
    await dialog.getByRole('button', { name: '确定' }).click();
    await remoteList.selectOption('下载测试.txt');
    await dialog.getByRole('button', { name: '下载到本机' }).click();
    await expect(dialog.getByRole('status')).toContainText('下载完成');
    assert.equal(await fs.readFile(path.join(local, '下载测试.txt'), 'utf8'), 'Brclio SFTP 浏览器');
    await dialog.getByRole('button', { name: '关闭' }).click();
    await expect(dialog).toHaveCount(0);
    assert.deepEqual(errors, []);
    console.log('SFTP graphical upload, rename, download and teardown passed');
  } finally {
    service?.close();
    await chrome?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
module.exports = { verifySftpEntry, verifySftpHelper };
if (require.main === module) verifyTransferControls().catch(error => { console.error(error); process.exitCode = 1; });

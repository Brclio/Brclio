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
  await require('./verify-terminal-proxy.cjs').verifyProxyHelper(app);
}

async function verifySftpEntry(terminal, app) {
  // A refused loopback connection exercises the normal host library → trusted IPC path.
  const picker = terminal.locator('#native-sftp-drop-fixture');
  await terminal.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file'; input.id = 'native-sftp-drop-fixture'; input.hidden = true;
    document.body.append(input);
  });
  try {
    await picker.setInputFiles(__filename);
    const checks = await terminal.evaluate(async () => {
      const api = window.brclioTerminal;
      const file = document.querySelector('#native-sftp-drop-fixture').files[0];
      const error = async fn => { try { await fn(); return ''; } catch(e) { return String(e.message); } };
      return await Promise.all([error(() => api.sftpDrop('bad-id','remote',file)),
        error(() => api.sftpDrop('bad-id','remote',new File(['x'],'synthetic.txt'))),
        error(() => api.sftp('native-drop', {id:'bad-id',nativePath:file.name}))]);
    });
    assert.match(checks[0], /会话编号无效/); // The native OS file reached the dedicated main-process handler.
    assert.match(checks[1], /系统文件管理器/);
    assert.match(checks[2], /系统文件管理器/);
  } finally { await picker.evaluate(el => el.remove()); }
  await terminal.evaluate(() => window.BrclioRemoteConnections.open());
  const library = terminal.locator('#remote-library');
  const localEntry=library.getByRole('button',{name:'浏览本机目录'});
  await expect(localEntry).toBeVisible();
  if (app) {
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'brclio-local-sftp-'));
    await fs.writeFile(path.join(dir,'local-fixture.txt'),'fixture');
    try {
      await app.evaluate(({dialog},directory)=>{
        global.__brclioSftpFolderPicker = dialog.showOpenDialog;
        dialog.showOpenDialog = (...args) => args.at(-1)?.title==='选择 SFTP 本地目录'
          ? Promise.resolve({canceled:false,filePaths:[directory]}) : global.__brclioSftpFolderPicker(...args);
      },dir);
      await localEntry.click();
      const local=terminal.getByRole('dialog',{name:'SFTP 文件管理'});
      await expect(local.getByRole('option',{name:/local-fixture/})).toHaveCount(1);
      await local.getByRole('button',{name:'关闭'}).click();
      await terminal.evaluate(()=>window.BrclioRemoteConnections.open());
    } finally {
      await app.evaluate(({dialog})=>{
        if (global.__brclioSftpFolderPicker) dialog.showOpenDialog=global.__brclioSftpFolderPicker;
        delete global.__brclioSftpFolderPicker;
      });
      await fs.rm(dir,{recursive:true,force:true});
    }
  }
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
  const local = path.join(root, 'local'), remote = path.join(root, 'remote'), second = path.join(root, 'peer');
  const chromeOptions = { headless: true, channel: process.env.BRCLIO_CHROME ? undefined : 'chrome', executablePath: process.env.BRCLIO_CHROME };
  let chrome, service, editingFile;
  try {
    await Promise.all([local, remote, second].map(dir => fs.mkdir(dir)));
    await fs.mkdir(path.join(remote, '目录', 'empty'), { recursive: true });
    await fs.writeFile(path.join(remote, '目录', '.hidden'), 'dot');
    await fs.writeFile(path.join(local, '上传测试.txt'), 'Brclio SFTP 浏览器');
    await fs.writeFile(path.join(root, '桌面拖入.txt'), 'dropped');
    chrome = await chromium.launch(chromeOptions);
    const page = await chrome.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    service = createBrowser({
      chooseLocal: async () => local,
      launchEditor: file => { editingFile = file; },
      chooseEditor: () => path.join(root, process.platform === 'win32' ? 'Editor.exe' : 'Editor.app'),
      start: target => connectProtocol(spawn(binary, [], { cwd: target.host === 'second' ? second : remote, windowsHide: true })),
    });
    await page.exposeFunction('sftpFixture', service.action);
    await page.exposeFunction('nativeDropFixture', (id, side, name) => {
      assert.equal(name, '桌面拖入.txt');
      return service.action('native-drop', { id, side, nativePath:path.join(root, name) });
    });
    await page.goto(require('node:url').pathToFileURL(__filename).href);
    await page.evaluate(() => {
      document.body.replaceChildren();
      window.brclioTerminal = { sftp: window.sftpFixture, sftpDrop: (id,side,file) => window.nativeDropFixture(id,side,file.name) };
    });
    for (const file of ['connection.js', 'sync-partitions.js', 'sftp-browser.js']) {
      await page.addScriptTag({ path: path.join(__dirname, '../desktop/terminal', file) });
    }
    await page.addStyleTag({ path: path.join(__dirname, '../desktop/terminal/sftp-browser.css') });
    await page.evaluate(() => {
      window.BrclioTerminalPartitions.activate('fixture-owner');
      window.BrclioSftp.open({ host: 'fixture' });
    });
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
    const left = dialog.locator('.sftp-pane').first(), right = dialog.locator('.sftp-pane').last();
    await remoteList.selectOption('下载测试.txt');
    await right.getByRole('button', { name: '选择编辑器…' }).click();
    await expect(dialog.getByRole('button', { name: '上传已保存的修改' })).toBeVisible();
    await fs.writeFile(editingFile, '新内容');
    await expect(dialog.getByText(/检测到本地编辑副本已保存/)).toBeVisible();
    await dialog.getByRole('button', { name: '上传已保存的修改' }).click();
    await expect(dialog.getByRole('status')).toContainText('远端文件已更新');
    assert.equal(await fs.readFile(path.join(remote, '下载测试.txt'), 'utf8'), '新内容');
    await dialog.getByRole('button', {name:'编辑器关联'}).click();
    const associations = dialog.getByRole('combobox', {name:'按文件类型保存的编辑器'});
    await expect(associations.getByRole('option')).toHaveText(/\.txt.*Editor/);
    await dialog.getByRole('button', {name:'恢复默认编辑器'}).click();
    await expect(associations.getByRole('option')).toHaveCount(0);
    await dialog.getByRole('button', {name:'完成',exact:true}).click();

    await left.getByRole('button', { name: '切换位置' }).click();
    await dialog.getByRole('textbox', { name: 'SFTP 地址' }).fill('second');
    await dialog.getByRole('button', { name: '连接', exact: true }).click();
    await expect(left.getByRole('heading')).toHaveText('second');
    await page.evaluate(() => {
      const input = document.createElement('input'); input.type = 'file'; input.id = 'os-drop-fixture'; document.body.append(input);
    });
    await page.locator('#os-drop-fixture').setInputFiles(path.join(root, '桌面拖入.txt'));
    await right.evaluate(pane => {
      const event = new DataTransfer();
      event.items.add(document.querySelector('#os-drop-fixture').files[0]);
      pane.dispatchEvent(new DragEvent('drop', {dataTransfer: event, bubbles: true, cancelable: true}));
    });
    await expect(dialog.getByRole('status')).toContainText('上传完成');
    assert.equal(await fs.readFile(path.join(remote,'桌面拖入.txt'),'utf8'), 'dropped');
    await remoteList.selectOption('桌面拖入.txt');
    await remoteList.dispatchEvent('contextmenu');
    await right.getByRole('menuitem', {name:'复制到目标目录'}).click();
    await expect(dialog.getByRole('status')).toContainText('复制完成');
    assert.equal(await fs.readFile(path.join(second,'桌面拖入.txt'),'utf8'), 'dropped');
    await remoteList.selectOption('目录');
    await right.getByRole('button', { name: '复制到左侧' }).dragTo(left.getByRole('heading'));
    await expect(dialog.getByRole('status')).toContainText('复制完成');
    assert.equal(await fs.readFile(path.join(second, '目录', '.hidden'), 'utf8'), 'dot');
    await localList.selectOption('目录');
    await left.getByRole('button', { name: '打开目录' }).click();
    await expect(localList.getByRole('option', { name: /hidden/ })).toHaveCount(0);
    await left.getByRole('button', { name: '显示隐藏项目' }).click();
    await expect(localList.getByRole('option', { name: /hidden/ })).toHaveCount(1);
    await left.getByRole('button', { name: '收藏当前目录' }).click();
    await expect(left.getByRole('button', { name: '取消收藏' })).toBeVisible();
    await left.getByRole('button', { name: '上一级' }).click();
    const bookmark = left.getByRole('combobox', { name: '收藏的目录' });
    await bookmark.selectOption({ index: 1 });
    await expect(localList.getByRole('option', { name: /hidden/ })).toHaveCount(1);
    const accountIsolated = await page.evaluate(() => {
      const partition = window.BrclioTerminalPartitions;
      const key = 'brclio.terminal.sftp-bookmarks.v1';
      const records = JSON.parse(partition.storage.getItem(key));
      partition.activate('different-owner');
      return records.length === 1 && partition.storage.getItem(key) === null;
    });
    assert.ok(accountIsolated, 'SFTP bookmarks use the current Brclio account');
    await dialog.getByRole('button', { name: '关闭' }).click();
    await expect(dialog).toHaveCount(0);
    await page.evaluate(() => window.BrclioSftp.open());
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('status')).toContainText('另一侧');
    await expect(dialog.getByRole('listbox',{name:'本地文件列表'}).getByRole('option',{name:/上传测试/})).toHaveCount(1);
    await dialog.getByRole('button',{name:'关闭'}).click();
    assert.deepEqual(errors, []);
    console.log('SFTP graphical upload, rename, download, server-to-server folder drag, hidden files, isolated bookmarks, confirmed editing and teardown passed');
  } finally {
    service?.close();
    await chrome?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
module.exports = { verifySftpEntry, verifySftpHelper };
if (require.main === module) verifyTransferControls().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';

// Real native smoke test. Never enables OS integration; restores every clipboard
// representation captured by Electron before performing any clipboard writes.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { _electron: electron, expect } = require('@playwright/test');

async function main() {
  const root = path.join(__dirname, '..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-native-smoke-'));
  const userData = path.join(temporary, 'tested-profile');
  const filename = path.join(temporary, '中文 空格 & $(literal).txt');
  const folder = path.join(temporary, '文件夹 with spaces');
  const driver = path.join(temporary, 'clipboard-observer.cjs');
  await fs.writeFile(filename, 'fixture');
  await fs.mkdir(folder);
  await fs.writeFile(driver, `const {app,BrowserWindow}=require('electron'); app.setPath('userData',${JSON.stringify(path.join(temporary, 'observer-profile'))}); app.whenReady().then(()=>new BrowserWindow({show:false})); app.on('window-all-closed',()=>{});`);
  const packagedExecutable = process.env.BRCLIO_SMOKE_EXECUTABLE;
  const launchOptions = { cwd: root, args: packagedExecutable ? [] : [root],
    ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
    env: { ...process.env, BRCLIO_USER_DATA: userData }, timeout: 45000 };
  const executable = packagedExecutable || require('electron');
  const commandPrefix = packagedExecutable ? [] : [root];
  let observer;
  let tested;
  let backedUp = false;
  try {
    observer = await electron.launch({ args: [driver], cwd: root, timeout: 45000 });
    await observer.evaluate(async ({ clipboard, ClipboardItem }) => {
      // Electron can represent an empty system clipboard with an item that has
      // zero MIME types; ClipboardItem cannot be constructed from that item.
      const items = (await clipboard.read()).filter(item => item.types.length > 0);
      globalThis.__brclioClipboardBackup = await Promise.all(items.map(async item => {
        const payloads = {};
        for (const type of item.types) {
          const payload = await item.getType(type);
          payloads[type] = type === 'electron application/bookmark' ? { ...payload } : new Blob([await payload.arrayBuffer()], { type });
        }
        return new ClipboardItem(payloads);
      }));
    });
    backedUp = true;
    const readClipboard = () => observer.evaluate(({ clipboard }) => clipboard.readText());
    tested = await electron.launch(launchOptions);
    const page = await tested.firstWindow();
    await page.waitForURL('file://**/web/index.html');
    await page.locator('#copy-manual').waitFor();
    const platform = await page.evaluate(() => window.brclio.getPlatform());
    assert.equal(platform.platform, process.platform);
    if (packagedExecutable) assert.equal(platform.packaged, true);
    if (process.env.BRCLIO_SMOKE_VERSION) assert.equal(platform.version, process.env.BRCLIO_SMOKE_VERSION);
    assert.equal((await page.evaluate(() => window.brclio.getSettings())).pathMode, 'absolute');
    const integration = await page.evaluate(() => window.brclio.getIntegrationStatus());
    assert.equal(integration.supported, ['darwin', 'win32'].includes(process.platform));

    await page.selectOption('#quote-mode', 'double');
    await expect.poll(() => page.evaluate(() => window.brclio.getSettings())).toMatchObject({ quoteMode: 'double' });
    await page.fill('#manual-paths', filename);
    await page.click('#copy-manual');
    await expect.poll(readClipboard).toBe(`"${filename}"`);

    // Native picker response is stubbed, while its IPC/UI/formatter remain real.
    await tested.evaluate(({ dialog }, fixture) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] }); }, folder);
    await page.click('#pick-folders');
    await page.check('#trailing-slash');
    await expect.poll(() => page.evaluate(() => window.brclio.getSettings())).toMatchObject({ trailingSlash: true });
    await page.click('#copy-manual');
    await expect.poll(readClipboard).toBe(`"${folder}${path.sep}"`);

    await page.evaluate(() => {
      const input = document.createElement('input'); input.type = 'file'; input.id = 'native-smoke-file'; document.body.append(input);
    });
    await page.locator('#native-smoke-file').setInputFiles(filename);
    const records = await page.evaluate(() => window.brclio.pathsFromFiles(Array.from(document.querySelector('#native-smoke-file').files)));
    assert.deepEqual(records, [{ path: filename, name: path.basename(filename), kind: 'file' }]);

    // An existing GUI process must receive exact paths through additionalData.
    await promisify(execFile)(executable, [...commandPrefix, '--copy-path', '--', filename], { cwd: root, env: launchOptions.env, timeout: 15000 });
    await expect.poll(readClipboard).toBe(`"${filename}"`);
    assert.equal(await tested.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    await tested.close(); tested = null;

    // A cold launch has no window and reads the very same persisted settings.
    await promisify(execFile)(executable, [...commandPrefix, '--copy-path', '--', folder], { cwd: root, env: launchOptions.env, timeout: 15000 });
    await expect.poll(readClipboard).toBe(`"${folder}${path.sep}"`);

    tested = await electron.launch(launchOptions);
    const relaunchedPage = await tested.firstWindow();
    await relaunchedPage.waitForURL('file://**/web/index.html');
    await relaunchedPage.locator('#copy-manual').waitFor();
    assert.equal((await relaunchedPage.evaluate(() => window.brclio.getSettings())).quoteMode, 'double');
    assert.equal((await relaunchedPage.evaluate(() => window.brclio.getSettings())).trailingSlash, true);
    console.log('PASS native window, local bridge, persisted settings, UI clipboard, native picker metadata, real file drag-drop bridge, second-instance and cold-launch copying.');
  } finally {
    if (tested) await tested.close().catch(() => {});
    if (observer) {
      if (backedUp) await observer.evaluate(async ({ clipboard }) => {
        if (globalThis.__brclioClipboardBackup.length) await clipboard.write(globalThis.__brclioClipboardBackup);
        else clipboard.clear();
      });
      await observer.close();
    }
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });

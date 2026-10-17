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
const { formatPaths } = require('../core/path-engine.cjs');
const { createWindowsSelectionFixture } = require('./windows-selection-smoke.cjs');

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
  let windowsSelection;
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
    const focusTestedWindow = async () => {
      await tested.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (window.isMinimized()) window.restore();
        window.show(); window.focus();
      });
      await expect.poll(() => tested.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(true);
    };
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

    const hasShortcuts = ['darwin', 'win32'].includes(process.platform);
    const customShortcut = 'Ctrl+Alt+Shift+P';
    if (hasShortcuts) {
      assert.deepEqual(await page.evaluate(() => window.brclio.getShortcutStatus()), {
        supported: true, accelerator: 'Alt+P', registered: true, error: null,
      });
      assert.equal(await tested.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Alt+P')), true);
      assert.equal((await page.evaluate(() => window.brclio.suspendShortcut())).registered, false);
      assert.equal(await tested.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Alt+P')), false);
      assert.equal((await page.evaluate(() => window.brclio.resumeShortcut())).registered, true);

      // Reserve a native binding outside the shortcut manager. Duplicate native
      // registration must leave the managed binding and disk setting unchanged.
      const conflict = 'Ctrl+Alt+Shift+O';
      assert.equal(await tested.evaluate(({ globalShortcut }, key) => globalShortcut.register(key, () => {}), conflict), true);
      const failure = await page.evaluate(async key => {
        try { await window.brclio.saveSettings({ ...await window.brclio.getSettings(), copyShortcut: key }); return null; }
        catch (error) { return error.message; }
      }, conflict);
      assert.match(failure, /占用/);
      assert.equal((await page.evaluate(() => window.brclio.getSettings())).copyShortcut, 'Alt+P');
      assert.equal(await tested.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Alt+P')), true);
      await tested.evaluate(({ globalShortcut }, key) => globalShortcut.unregister(key), conflict);

      if (process.platform === 'win32' && process.env.BRCLIO_ALLOW_SELECTION_SMOKE === '1') {
        windowsSelection = await createWindowsSelectionFixture();
        await windowsSelection.activate('first');
        await windowsSelection.pressShortcut('Alt+P');
        await expect.poll(async () => (await readClipboard()).split('\n').sort(), { timeout: 15000 }).toEqual([...windowsSelection.paths.first].sort());
        await focusTestedWindow();
      }

      await page.locator('[data-view="settings"]').click();
      await page.locator('#record-shortcut').click();
      await expect(page.locator('#launch-shortcut')).toHaveValue('请按下快捷键…');
      await page.keyboard.press('Control+Alt+Shift+P');
      await expect.poll(() => page.evaluate(() => window.brclio.getSettings())).toMatchObject({ copyShortcut: customShortcut });
      await expect(page.locator('#record-shortcut')).toBeEnabled();
      assert.equal(await tested.evaluate(({ globalShortcut }, key) => globalShortcut.isRegistered(key), customShortcut), true);
      if (windowsSelection) {
        await windowsSelection.activate('second');
        await windowsSelection.pressShortcut(customShortcut);
        await expect.poll(readClipboard, { timeout: 15000 }).toBe(windowsSelection.paths.second[0]);
        await focusTestedWindow();
      }
      assert.equal(await tested.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Alt+P')), false);
      await page.locator('#record-shortcut').click();
      await expect(page.locator('#launch-shortcut')).toHaveValue('请按下快捷键…');
      await page.reload();
      await page.waitForFunction(() => document.body.dataset.initialized === 'true');
      assert.equal(await tested.evaluate(({ globalShortcut }, key) => globalShortcut.isRegistered(key), customShortcut), true);
    }

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
    if (hasShortcuts) {
      assert.equal((await relaunchedPage.evaluate(() => window.brclio.getSettings())).copyShortcut, customShortcut);
      assert.equal(await tested.evaluate(({ globalShortcut }, key) => globalShortcut.isRegistered(key), customShortcut), true);
      if (windowsSelection) {
        await windowsSelection.activate('first');
        await windowsSelection.pressShortcut(customShortcut);
        const saved = await relaunchedPage.evaluate(() => window.brclio.getSettings());
        const formatted = await Promise.all(windowsSelection.paths.first.map(async filename => formatPaths([{ path: filename, kind: (await fs.stat(filename)).isDirectory() ? 'directory' : 'file' }], saved)));
        await expect.poll(async () => (await readClipboard()).split('\n').sort(), { timeout: 15000 }).toEqual(formatted.sort());
      }
      if (process.platform === 'darwin') {
        // A resident GUI instance must keep its shortcut after its last window
        // closes and a later Finder/context-menu request finishes copying.
        await relaunchedPage.close();
        await promisify(execFile)(executable, [...commandPrefix, '--copy-path', '--', filename], { cwd: root, env: launchOptions.env, timeout: 15000 });
        await expect.poll(readClipboard).toBe(`"${filename}"`);
        assert.equal(await tested.evaluate(async ({ globalShortcut }, key) => {
          await new Promise(resolve => setTimeout(resolve, 600));
          return globalShortcut.isRegistered(key);
        }, customShortcut), true);
      }
    }
    console.log('PASS native window, local bridge, persisted settings, native global shortcut registration/collision/restart, UI clipboard, native picker metadata, real file drag-drop bridge, second-instance and cold-launch copying.');
  } finally {
    if (windowsSelection) await windowsSelection.cleanup();
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

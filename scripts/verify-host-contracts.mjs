import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

// Test the real shared UI and bridge with deterministic asynchronous native
// responses. No installed menu, native preference, or clipboard is changed.
const root = path.resolve(fileURLToPath(new URL('../web/', import.meta.url)));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Outside test root');
    response.setHeader('Content-Type', types[path.extname(target)] || 'application/octet-stream');
    response.end(await readFile(target));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser;
const report = [];
const errors = [];

function observe(page) {
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
}

try {
  browser = await chromium.launch({
    executablePath: process.env.BRCLIO_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  observe(page);
  await page.addInitScript(() => {
    window.__savedCalls = [];
    window.__copiedTexts = [];
    window.__activeSaves = 0;
    window.__peakSaves = 0;
    window.__readyCalls = 0;
    window.brclio = {
      reportReady: async () => { window.__readyCalls++; },
      getPlatform: async () => ({ platform: 'darwin', packaged: true, capabilities: { systemIntegration: true } }),
      getSettings: async () => ({ quoteMode: 'single', separator: 'forward', launchAtLogin: true }),
      getIntegrationStatus: () => new Promise(resolve => { window.__finishInit = resolve; }),
      saveSettings: async settings => {
        window.__savedCalls.push(settings);
        window.__activeSaves += 1;
        window.__peakSaves = Math.max(window.__peakSaves, window.__activeSaves);
        await new Promise(resolve => setTimeout(resolve, 450));
        window.__activeSaves -= 1;
        return settings;
      },
      copyText: async text => { window.__copiedTexts.push(text); },
      onPaths: callback => { window.__incoming = callback; return () => {}; },
    };
  });
  await page.goto(url);
  assert.equal(await page.evaluate(() => document.body.inert), true);
  const quote = page.locator('#quote-mode');
  const box = await quote.boundingBox();
  // Native mouse/keyboard input respects inert; synthetic selectOption does not.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.locator('#quote-mode').evaluate(element => element.focus());
  assert.equal(await quote.evaluate(element => element === document.activeElement), false);
  assert.equal(await quote.inputValue(), 'none');
  assert.deepEqual(await page.evaluate(() => window.__savedCalls), []);
  assert.equal(await page.evaluate(() => window.__readyCalls), 0);
  // Incoming paths can arrive while preference initialization is still pending.
  await page.evaluate(() => {
    window.__incoming([{ path: '/work/a b.txt', name: 'a b.txt', kind: 'file' }]);
    window.__finishInit({ supported: true, installed: false });
  });
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  assert.equal(await page.evaluate(() => document.body.inert), false);
  assert.equal(await page.evaluate(() => window.__readyCalls), 1);
  assert.equal(await quote.inputValue(), 'single');
  assert.equal(await page.locator('#path-preview').innerText(), "'/work/a b.txt'");
  await page.locator('#copy-preview').click();
  assert.deepEqual(await page.evaluate(() => window.__copiedTexts), ["'/work/a b.txt'"]);
  report.push('delayed persisted initialization blocks real edits and retains early incoming paths');

  await quote.selectOption('double');
  await page.waitForFunction(() => window.__savedCalls.length === 1);
  await quote.selectOption('auto');
  await page.waitForFunction(() => window.__savedCalls.length === 2 && window.__activeSaves === 0);
  assert.equal(await page.evaluate(() => window.__peakSaves), 1);
  assert.deepEqual(await page.evaluate(() => window.__savedCalls.map(settings => settings.quoteMode)), ['double', 'auto']);
  assert.equal(await quote.inputValue(), 'auto');
  await page.locator('#reset-settings').click();
  await page.waitForFunction(() => window.__savedCalls.length === 3 && window.__activeSaves === 0);
  assert.equal(await page.evaluate(() => window.__savedCalls.at(-1).launchAtLogin), true);
  assert.equal(await quote.inputValue(), 'none');
  report.push('native settings saves stay serialized and resetting copy preferences preserves login startup');
  await page.close();

  const shortcuts = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  observe(shortcuts);
  await shortcuts.addInitScript(() => {
    window.__shortcutSettings = { copyShortcut: 'Alt+P', quoteMode: 'none' };
    window.__shortcutCalls = [];
    window.__shortcutSuspended = false;
    window.__shortcutResumeCalls = 0;
    window.__shortcutAvailable = false;
    const status = () => ({ supported: true, accelerator: window.__shortcutSettings.copyShortcut, registered: window.__shortcutAvailable && !window.__shortcutSuspended, error: window.__shortcutAvailable ? null : '默认快捷键暂时被其他应用占用。' });
    window.brclio = {
      getPlatform: async () => ({ platform: 'darwin', capabilities: { globalShortcut: true } }),
      getSettings: async () => window.__shortcutSettings,
      getIntegrationStatus: async () => ({ supported: false }),
      getShortcutStatus: async () => status(),
      suspendShortcut: async () => { await new Promise(resolve => setTimeout(resolve, 20)); window.__shortcutSuspended = true; return status(); },
      resumeShortcut: async () => { window.__shortcutResumeCalls++; window.__shortcutSuspended = false; window.__shortcutAvailable = true; return status(); },
      saveSettings: async settings => {
        window.__shortcutCalls.push(settings);
        await new Promise(resolve => setTimeout(resolve, 100));
        if (settings.copyShortcut === 'Ctrl+K') throw new Error('此快捷键已被其他应用占用，请换一个组合键。');
        window.__shortcutSettings = { ...settings };
        return { ...settings };
      },
      onPaths: () => () => {},
    };
  });
  await shortcuts.goto(url);
  await shortcuts.waitForFunction(() => document.body.dataset.initialized === 'true');
  await shortcuts.locator('[data-view="settings"]').click();
  assert.equal(await shortcuts.locator('label[for="launch-shortcut"]').innerText(), '复制所选路径');
  assert.match(await shortcuts.locator('#shortcut-hint').innerText(), /Finder.*选中.*路径格式/);
  assert.match(await shortcuts.locator('#shortcut-hint').innerText(), /允许 Brclio 控制 Finder/);
  assert.equal(await shortcuts.locator('#launch-shortcut').inputValue(), 'Option + P');
  assert.match(await shortcuts.locator('#shortcut-status').innerText(), /占用/);
  await shortcuts.locator('#retry-shortcut').click();
  await shortcuts.waitForFunction(() => document.querySelector('#retry-shortcut').hidden);
  assert.equal(await shortcuts.locator('#shortcut-status').isVisible(), false);
  report.push('macOS default shows Option+P and startup registration failures offer a working retry');

  await shortcuts.locator('#record-shortcut').click();
  await shortcuts.waitForFunction(() => window.__shortcutSuspended);
  await shortcuts.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', code: 'KeyA', shiftKey: true, bubbles: true, cancelable: true })));
  assert.equal(await shortcuts.locator('#cancel-shortcut').isVisible(), true);
  assert.match(await shortcuts.locator('#shortcut-status').innerText(), /Ctrl/);
  await shortcuts.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: '∆', code: 'KeyJ', ctrlKey: true, altKey: true, bubbles: true, cancelable: true })));
  await shortcuts.locator('[data-view="copy"]').first().click();
  await shortcuts.locator('#quote-mode').selectOption('single');
  await shortcuts.waitForFunction(() => window.__shortcutSettings.copyShortcut === 'Ctrl+Alt+J' && window.__shortcutSettings.quoteMode === 'single' && !window.__shortcutSuspended);
  assert.equal(await shortcuts.evaluate(() => window.__shortcutCalls.at(-1).copyShortcut), 'Ctrl+Alt+J');
  await shortcuts.locator('[data-view="settings"]').click();
  assert.equal(await shortcuts.locator('#launch-shortcut').inputValue(), 'Ctrl + Option + J');
  assert.match(await shortcuts.locator('#shortcut-status').innerText(), /已保存/);
  report.push('recording uses physical key codes under macOS Option and rejects Shift-only combinations');

  await shortcuts.locator('#record-shortcut').click();
  await shortcuts.waitForFunction(() => window.__shortcutSuspended);
  await shortcuts.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true })));
  await shortcuts.locator('[data-view="copy"]').first().click();
  await shortcuts.locator('#quote-mode').selectOption('double');
  await shortcuts.waitForFunction(() => window.__shortcutCalls.length === 4 && window.__shortcutSettings.quoteMode === 'double');
  assert.equal(await shortcuts.locator('#search-dialog').isVisible(), false);
  assert.equal(await shortcuts.evaluate(() => window.__shortcutSettings.copyShortcut), 'Ctrl+Alt+J');
  assert.equal(await shortcuts.evaluate(() => window.__shortcutCalls.at(-1).copyShortcut), 'Ctrl+Alt+J');
  await shortcuts.locator('[data-view="settings"]').click();
  assert.equal(await shortcuts.locator('#launch-shortcut').inputValue(), 'Ctrl + Option + J');
  assert.match(await shortcuts.locator('#shortcut-status').innerText(), /未修改.*占用/);
  report.push('conflicting shortcuts restore the old value, suppress search and preserve queued format saves');

  const savesBeforeCancel = await shortcuts.evaluate(() => window.__shortcutCalls.length);
  for (const cancel of ['escape', 'button', 'navigation', 'outside', 'blur', 'pagehide']) {
    await shortcuts.locator('#record-shortcut').click();
    await shortcuts.waitForFunction(() => window.__shortcutSuspended);
    if (cancel === 'escape') await shortcuts.keyboard.press('Escape');
    else if (cancel === 'button') await shortcuts.locator('#cancel-shortcut').click();
    else if (cancel === 'navigation') await shortcuts.locator('[data-view="copy"]').first().click();
    else if (cancel === 'outside') await shortcuts.locator('#settings-title').click();
    else await shortcuts.evaluate(type => window.dispatchEvent(new Event(type)), cancel);
    await shortcuts.waitForFunction(() => !window.__shortcutSuspended && document.querySelector('#cancel-shortcut').hidden && !document.querySelector('#record-shortcut').disabled);
    if (cancel === 'navigation') await shortcuts.locator('[data-view="settings"]').click();
  }
  assert.equal(await shortcuts.evaluate(() => window.__shortcutCalls.length), savesBeforeCancel);
  // Cancelling while native suspension is still pending must resume afterwards.
  await shortcuts.locator('#record-shortcut').click();
  await shortcuts.keyboard.press('Escape');
  await shortcuts.waitForFunction(() => !window.__shortcutSuspended && !document.querySelector('#record-shortcut').disabled);
  await shortcuts.locator('[data-view="copy"]').first().click();
  await shortcuts.locator('#reset-settings').click();
  await shortcuts.waitForFunction(() => window.__shortcutSettings.quoteMode === 'none');
  assert.equal(await shortcuts.evaluate(() => window.__shortcutSettings.copyShortcut), 'Ctrl+Alt+J');
  await shortcuts.locator('[data-view="settings"]').click();
  await shortcuts.locator('#reset-shortcut').click();
  await shortcuts.waitForFunction(() => window.__shortcutSettings.copyShortcut === 'Alt+P' && !document.querySelector('#record-shortcut').disabled);
  assert.equal(await shortcuts.locator('#launch-shortcut').inputValue(), 'Option + P');
  report.push('cancel, blur, navigation and disposal resume the binding; copy reset preserves it and shortcut reset restores Alt+P');
  await shortcuts.close();

  const windowsShortcut = await browser.newPage();
  observe(windowsShortcut);
  await windowsShortcut.addInitScript(() => {
    window.brclio = {
      getPlatform: async () => ({ platform: 'win32', capabilities: { globalShortcut: true } }),
      getSettings: async () => ({ copyShortcut: 'Super+P' }),
      getIntegrationStatus: async () => ({ supported: false }),
      getShortcutStatus: async () => ({ supported: true, accelerator: 'Super+P', registered: true, error: null }),
      suspendShortcut: async () => {}, resumeShortcut: async () => {}, onPaths: () => () => {},
    };
  });
  await windowsShortcut.goto(url);
  await windowsShortcut.waitForFunction(() => document.body.dataset.initialized === 'true');
  await windowsShortcut.locator('[data-view="settings"]').click();
  assert.match(await windowsShortcut.locator('#shortcut-hint').innerText(), /资源管理器.*选中.*路径格式/);
  assert.equal(await windowsShortcut.locator('#launch-shortcut').inputValue(), 'Win + P');
  assert.equal(await windowsShortcut.locator('#record-shortcut').isEnabled(), true);
  report.push('Windows custom shortcuts display Super as Win');
  await windowsShortcut.close();

  const failed = await browser.newPage();
  observe(failed);
  await failed.addInitScript(() => {
    window.__readyCalls = 0;
    window.brclio = {
      getPlatform: async () => ({ platform: 'darwin', version: '0.1.3', capabilities: {} }),
      getSettings: async () => { throw new Error('隔离初始化失败'); },
      getIntegrationStatus: async () => ({ supported: false }),
      reportReady: async () => { window.__readyCalls++; },
      onPaths: () => () => {},
    };
  });
  await failed.goto(url);
  await failed.waitForFunction(() => document.body.dataset.ready === 'true');
  assert.equal(await failed.evaluate(() => window.__readyCalls), 0);
  assert.equal(await failed.evaluate(() => document.body.dataset.initialized), undefined);
  report.push('failed native initialization never acknowledges healthy update startup');
  await failed.close();

  const updating = await browser.newPage();
  observe(updating);
  await updating.addInitScript(() => {
    window.__updateCalls = [];
    window.brclio = {
      getPlatform: async () => ({ platform: 'android', version: '0.1.3', capabilities: {} }),
      getSettings: async () => ({}), getIntegrationStatus: async () => ({ supported: false }),
      onPaths: () => () => {},
      checkForUpdates: async () => ({ status: 'available', version: '0.1.4' }),
      downloadUpdate: async () => { window.__updateCalls.push('download'); return { status: 'downloaded', version: '0.1.4' }; },
      installUpdate: async () => { window.__updateCalls.push('install'); return { status: 'downloaded', installerOpened: true, message: '安装后尝试自动打开；系统限制时请点击打开。' }; },
      onUpdateState: callback => { window.__emitUpdate = callback; return () => {}; },
    };
  });
  await updating.goto(url);
  await updating.waitForFunction(() => document.body.dataset.initialized === 'true');
  assert.equal(await updating.locator('#about-dialog .subtle-tag').textContent(), 'VERSION 0.1.3');
  await updating.locator('[data-view="settings"]').click();
  await updating.locator('#check-update').click();
  await updating.locator('#download-update').click();
  await updating.waitForFunction(() => window.__updateCalls.length === 2);
  assert.deepEqual(await updating.evaluate(() => window.__updateCalls), ['download', 'install']);
  assert.match(await updating.locator('#update-status-detail').innerText(), /系统限制时请点击打开/);
  assert.equal(await updating.locator('#check-update').isDisabled(), true);
  await updating.evaluate(() => window.__emitUpdate({ status: 'downloaded', version: '0.1.4' }));
  assert.equal(await updating.locator('#check-update').isDisabled(), false);
  assert.equal(await updating.locator('#install-update').isVisible(), true);
  report.push('one download-and-install click continues to native installation and preserves Android system guidance');
  await updating.close();

  const about = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  observe(about);
  await about.addInitScript(() => {
    window.__aboutUpdateCalls = [];
    const pending = {};
    const request = method => {
      window.__aboutUpdateCalls.push(method);
      return new Promise((resolve, reject) => { (pending[method] ||= []).push({ resolve, reject }); });
    };
    window.__finishAboutUpdate = (method, state, error) => {
      const next = pending[method].shift();
      if (error) next.reject(new Error(error));
      else next.resolve(state);
    };
    window.brclio = {
      getPlatform: async () => ({ platform: 'darwin', version: '0.1.3', capabilities: {} }),
      getSettings: async () => ({}), getIntegrationStatus: async () => ({ supported: false }),
      getUpdateState: async () => ({ status: 'idle' }),
      saveSettings: settings => new Promise(resolve => { window.__finishAboutSave = () => resolve(settings); }),
      onPaths: () => () => {},
      checkForUpdates: () => request('check'),
      downloadUpdate: () => request('download'),
      installUpdate: () => request('install'),
      onUpdateState: callback => { window.__emitAboutUpdate = callback; return () => {}; },
    };
  });
  await about.goto(url);
  await about.waitForFunction(() => document.body.dataset.initialized === 'true');
  // Keep a preference save pending to exercise the download/install handoff.
  await about.locator('#quote-mode').selectOption('single');
  await about.waitForFunction(() => typeof window.__finishAboutSave === 'function');
  const contextBeforeUpdate = await about.evaluate(() => ({
    view: document.querySelector('.view.active').id,
    navigation: document.querySelector('.nav-item[aria-current="page"]')?.dataset.view || 'copy',
    breadcrumb: document.querySelector('#breadcrumb-current').textContent,
    title: document.title,
  }));
  const assertAboutContext = async () => {
    assert.equal(await about.locator('#about-dialog').evaluate(element => element.open), true);
    assert.deepEqual(await about.evaluate(() => ({
      view: document.querySelector('.view.active').id,
      navigation: document.querySelector('.nav-item[aria-current="page"]')?.dataset.view || 'copy',
      breadcrumb: document.querySelector('#breadcrumb-current').textContent,
      title: document.title,
    })), contextBeforeUpdate);
  };
  const assertSharedUpdate = async () => {
    for (const suffix of ['status-title', 'status-detail', 'progress-label', 'notes']) {
      assert.equal(await about.locator(`#about-update-${suffix}`).textContent(), await about.locator(`#update-${suffix}`).textContent());
    }
    assert.equal(await about.locator('#about-update-progress-bar').evaluate(element => element.value), await about.locator('#update-progress-bar').evaluate(element => element.value));
  };
  const finishAboutUpdate = (method, state, error) => about.evaluate(({ method, state, error }) => window.__finishAboutUpdate(method, state, error), { method, state, error });
  const waitAboutAction = label => about.waitForFunction(label => {
    const button = document.querySelector('#about-update');
    return button.textContent === label && !button.disabled && button.getAttribute('aria-busy') === 'false';
  }, label);
  await about.locator('#about-button').click();
  assert.equal(await about.locator('#about-update').innerText(), '检查更新');
  assert.equal(await about.locator('#about-update-status').isVisible(), false);
  await about.locator('#about-update').click();
  assert.equal(await about.locator('#about-update').innerText(), '正在检查…');
  assert.equal(await about.locator('#about-update').isDisabled(), true);
  assert.equal(await about.locator('#about-update').getAttribute('aria-busy'), 'true');
  assert.equal(await about.locator('#check-update').isDisabled(), true);
  await assertAboutContext();
  // Even a synthetic second click must not start a concurrent native check.
  await about.locator('#about-update').dispatchEvent('click');
  assert.deepEqual(await about.evaluate(() => window.__aboutUpdateCalls), ['check']);
  await finishAboutUpdate('check', { status: 'up-to-date', currentVersion: '0.1.3' });
  await waitAboutAction('重新检查');
  assert.match(await about.locator('#about-update-status-title').innerText(), /已经是最新版本/);
  await assertSharedUpdate();
  await assertAboutContext();
  await about.locator('#about-dialog [data-close]').click();
  await about.locator('#about-button').click();
  assert.equal(await about.locator('#about-update').innerText(), '重新检查');
  assert.match(await about.locator('#about-update-status-detail').innerText(), /0\.1\.3/);
  report.push('About checks stay in the dialog, preserve the active view and title, prevent concurrent checks, and retain completed status when reopened');

  await about.locator('#about-update').click();
  await finishAboutUpdate('check', null, '检查超时，请稍后重试。');
  await waitAboutAction('重新检查');
  assert.equal(await about.locator('#about-update-status-detail').innerText(), '检查超时，请稍后重试。');
  await assertAboutContext();
  await assertSharedUpdate();
  await about.locator('#about-update').click();
  const release = { version: '0.1.4', assetName: 'Brclio-0.1.4-mac-arm64.zip', notes: '修复关于弹窗内的更新体验。\n' + 'release-note-'.repeat(180) };
  await finishAboutUpdate('check', { status: 'available', ...release });
  await waitAboutAction('下载并安装更新');
  assert.match(await about.locator('#about-update-status-title').innerText(), /v0\.1\.4/);
  assert.equal(await about.locator('#about-update-notes').isVisible(), true);
  assert.equal(await about.locator('#about-update-notes').textContent(), release.notes.slice(0, 1600));
  await assertSharedUpdate();
  await about.locator('#about-update').click();
  assert.equal(await about.locator('#about-update').isDisabled(), true);
  await about.evaluate(release => window.__emitAboutUpdate({ status: 'downloading', progress: 37.4, ...release }), release);
  assert.match(await about.locator('#about-update').innerText(), /正在下载…/);
  assert.equal(await about.locator('#about-update-progress').isVisible(), true);
  assert.equal(await about.locator('#about-update-progress-label').innerText(), '37%');
  assert.equal(await about.locator('#about-update-progress-bar').evaluate(element => element.value), 37.4);
  await assertSharedUpdate();
  await assertAboutContext();
  await about.locator('#about-dialog [data-close]').click();
  await about.locator('#about-button').click();
  assert.equal(await about.locator('#about-update-progress-label').innerText(), '37%');
  assert.equal(await about.locator('#about-update').isDisabled(), true);
  await finishAboutUpdate('download', { status: 'downloaded', canInstall: true, ...release });
  await about.waitForFunction(() => document.querySelector('#about-update').textContent === '安装更新');
  assert.equal(await about.locator('#about-update').isDisabled(), true);
  assert.equal(await about.locator('#install-update').isDisabled(), true);
  await about.locator('#about-update').dispatchEvent('click');
  assert.deepEqual(await about.evaluate(() => window.__aboutUpdateCalls), ['check', 'check', 'check', 'download']);
  await about.evaluate(() => window.__finishAboutSave());
  await about.waitForFunction(() => window.__aboutUpdateCalls.at(-1) === 'install');
  assert.equal(await about.locator('#about-update').innerText(), '正在准备安装…');
  assert.equal(await about.locator('#about-update').isDisabled(), true);
  await finishAboutUpdate('install', { status: 'error', canInstall: true, error: '安装失败，请重试。', ...release });
  await waitAboutAction('重试安装');
  assert.equal(await about.locator('#about-update-status-detail').innerText(), '安装失败，请重试。');
  await assertSharedUpdate();
  await assertAboutContext();
  await about.locator('#about-update').click();
  assert.deepEqual(await about.evaluate(() => window.__aboutUpdateCalls), ['check', 'check', 'check', 'download', 'install', 'install']);
  await finishAboutUpdate('install', { status: 'downloaded', installerOpened: true, version: '0.1.4' });
  await about.waitForFunction(() => document.querySelector('#about-update').textContent === '正在安装…');
  assert.equal(await about.locator('#about-update').isDisabled(), true);
  await assertAboutContext();
  report.push('About handles failed checks, release notes, native download progress, save-before-install locking, automatic installation, and installation-only retries');

  // A downloaded package received from the native host also stays installable
  // after reopening, and long native errors/notes must fit a narrow viewport.
  await about.evaluate(release => window.__emitAboutUpdate({ status: 'downloaded', canInstall: true, ...release }), release);
  await waitAboutAction('安装更新');
  await about.locator('#about-dialog [data-close]').click();
  await about.locator('#about-button').click();
  assert.equal(await about.locator('#about-update').innerText(), '安装更新');
  for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 950 }, { width: 320, height: 568 }]) {
    await about.setViewportSize(viewport);
    for (const state of [{ status: 'available', ...release }, { status: 'error', error: 'download-error-'.repeat(160) }]) {
      await about.evaluate(state => window.__emitAboutUpdate(state), state);
      const bounds = await about.locator('#about-dialog').evaluate(dialog => {
        const box = dialog.getBoundingClientRect();
        const button = dialog.querySelector('#about-update');
        button.scrollIntoView({ block: 'nearest' });
        const action = button.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, horizontalOverflow: dialog.scrollWidth - dialog.clientWidth, actionLeft: action.left, actionRight: action.right, actionTop: action.top, actionBottom: action.bottom };
      });
      assert.ok(bounds.left >= 0 && bounds.right <= bounds.viewportWidth, JSON.stringify(bounds));
      assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.viewportHeight, JSON.stringify(bounds));
      assert.ok(bounds.horizontalOverflow <= 1, JSON.stringify(bounds));
      assert.ok(bounds.actionLeft >= bounds.left && bounds.actionRight <= bounds.right && bounds.actionTop >= bounds.top && bounds.actionBottom <= bounds.bottom, JSON.stringify(bounds));
      await assertAboutContext();
    }
  }
  report.push('About retains downloaded state and keeps update actions and long status content within desktop and narrow dialog bounds');
  await about.close();

  const android = await browser.newPage({ viewport: { width: 390, height: 950 } });
  observe(android);
  await android.addInitScript(() => {
    window.__nativeRequests = [];
    window.__nativeCopies = [];
    window.__androidSaved = { pathMode: 'relative', basePath: '/storage/emulated/0/Documents', trailingSlash: true };
    window.__pickerResult = [];
    window.AndroidBridge = {
      postMessage: raw => {
        const request = JSON.parse(raw);
        window.__nativeRequests.push(request);
        const reply = (result, error = null) => queueMicrotask(() => window.__brclioResolve(request.id, { result, error }));
        switch (request.method) {
          case 'getPlatform': reply({ platform: 'android', capabilities: { filePicker: true, folderPicker: true, systemIntegration: false } }); break;
          case 'getSettings': window.__finishSettings = () => reply(window.__androidSaved); break;
          case 'getIntegrationStatus': reply({ supported: false, installed: false }); break;
          case 'saveSettings': window.__androidSaved = request.payload.settings; reply(window.__androidSaved); break;
          case 'pickPaths': reply(window.__pickerResult); break;
          case 'copyText': window.__nativeCopies.push(request.payload.text); reply({ ok: true }); break;
          case 'setIntegration': reply(null, 'Android 不支持系统右键菜单。'); break;
          default: reply(null, '未知操作。');
        }
      },
    };
  });
  await android.goto(url);
  await android.evaluate(() => {
    window.dispatchEvent(new CustomEvent('brclio:paths', { detail: [{
      path: '/storage/emulated/0/Documents/我的项目', name: '我的项目', kind: 'directory', isUri: false,
    }] }));
    window.__finishSettings();
  });
  await android.waitForFunction(() => document.body.dataset.ready === 'true');
  assert.equal(await android.locator('#path-preview').innerText(), '我的项目/');
  assert.equal(await android.locator('#sample-count').innerText(), '1 个文件夹');
  await android.locator('#copy-preview').click();
  assert.deepEqual(await android.evaluate(() => window.__nativeCopies), ['我的项目/']);
  report.push('Android cold-share event retains directory metadata through relative formatting and clipboard bridge');

  await android.evaluate(() => { window.__pickerResult = [{ path: '/storage/emulated/0', kind: 'directory', isUri: false }]; });
  await android.locator('#pick-base').click();
  assert.equal(await android.locator('#base-path').inputValue(), '/storage/emulated/0');
  assert.equal(await android.locator('#path-preview').innerText(), 'Documents/我的项目/');
  assert.equal(await android.evaluate(() => window.__nativeRequests.filter(request => request.method === 'pickPaths').at(-1).payload.kind), 'base');

  const uri = 'content://com.android.providers.downloads.documents/document/msf%3A42?title=a%20b';
  await android.evaluate(uri => { window.__pickerResult = [{ path: uri, name: 'a b.txt', kind: 'file', isUri: true }]; }, uri);
  await android.locator('#pick-files').click();
  assert.equal(await android.locator('#copy-preview').isDisabled(), true);
  assert.match(await android.locator('#preview-error').innerText(), /内容 URI.*相对路径/);
  await android.locator('label').filter({ has: android.locator('input[name="pathMode"][value="absolute"]') }).click();
  await android.locator('label').filter({ has: android.locator('input[name="separator"][value="backward"]') }).click();
  assert.equal(await android.locator('#path-preview').innerText(), uri);
  await android.locator('#copy-preview').click();
  assert.equal(await android.evaluate(() => window.__nativeCopies.at(-1)), uri);
  const rejected = await android.evaluate(async () => {
    try { await window.BrclioHost.setIntegration(true); return ''; }
    catch (error) { return error.message; }
  });
  assert.match(rejected, /Android 不支持/);
  await android.locator('[data-view="settings"]').click();
  assert.equal(await android.locator('#launch-shortcut').isDisabled(), true);
  assert.equal(await android.locator('#record-shortcut').isDisabled(), true);
  assert.match(await android.locator('#shortcut-hint').innerText(), /安卓端不支持全局快捷键/);
  assert.equal(await android.evaluate(() => window.__nativeRequests.some(request => /Shortcut/.test(request.method))), false);
  report.push('Android base picker contract, URI preservation, relative refusal, and native errors reach the real UI');
  await android.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: report, consoleErrors: errors }, null, 2));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

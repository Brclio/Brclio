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
    window.brclio = {
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
  // Incoming paths can arrive while preference initialization is still pending.
  await page.evaluate(() => {
    window.__incoming([{ path: '/work/a b.txt', name: 'a b.txt', kind: 'file' }]);
    window.__finishInit({ supported: true, installed: false });
  });
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  assert.equal(await page.evaluate(() => document.body.inert), false);
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
  report.push('Android base picker contract, URI preservation, relative refusal, and native errors reach the real UI');
  await android.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: report, consoleErrors: errors }, null, 2));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

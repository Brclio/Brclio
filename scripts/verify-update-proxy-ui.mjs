import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
const root = path.resolve('web');
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!target.startsWith(root + path.sep)) throw new Error('Outside test root');
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
    response.setHeader('Content-Type', types[path.extname(target)] || 'application/octet-stream');
    response.end(await readFile(target));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.BRCLIO_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    let enabled = true;
    window.__proxyCalls = [];
    window.__saveCalls = [];
    window.__systemProxy = false;
    window.__failProxy = false;
    window.__probeError = null;
    window.__directFallback = false;
    const proxyState = () => ({ enabled, supported: true, route: window.__directFallback ? 'direct' : window.__systemProxy ? 'system' : enabled ? 'builtin' : 'direct', ...(window.__directFallback ? { fallbackFrom: 'system' } : {}), error: window.__probeError });
    window.brclio = {
      accountRequest: async ({ path, method = 'GET' }) => {
        if (path === '/api/account/session' && method === 'GET') return { user: null, csrf: null, googleEnabled: false };
        throw new Error(`Unhandled account fixture operation: ${method} ${path}`);
      },
      getPlatform: async () => ({ platform: 'darwin', version: '0.1.8', capabilities: {} }),
      getSettings: async () => ({}),
      saveSettings: async settings => { window.__saveCalls.push(settings); return settings; },
      getIntegrationStatus: async () => ({ supported: false }),
      getUpdateState: async () => ({ status: 'idle' }),
      getUpdateProxyState: async () => proxyState(),
      setUpdateProxyEnabled: async value => {
        window.__proxyCalls.push(value);
        if (window.__failProxy) throw new Error('更新期间无法修改代理。');
        enabled = value; return proxyState();
      },
      checkForUpdates: () => new Promise(resolve => { window.__finishCheck = () => resolve({ status: 'up-to-date' }); }),
      onUpdateState: callback => { window.__emitUpdate = callback; return () => {}; },
      onPaths: () => () => {},
    };
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  await page.waitForFunction(() => document.body.dataset.initialized === 'true');
  await page.locator('[data-view="settings"]').click();
  await page.locator('#update-proxy:enabled').waitFor();
  assert.equal(await page.locator('#update-proxy').isChecked(), true);
  assert.match(await page.locator('#update-proxy-status').innerText(), /内置代理/);
  await page.locator('#update-proxy').uncheck();
  await page.waitForFunction(() => document.querySelector('#update-proxy-status').textContent.includes('已关闭'));
  assert.equal(await page.locator('#about-update-proxy').isChecked(), false);
  assert.deepEqual(await page.evaluate(() => window.__proxyCalls), [false]);
  assert.deepEqual(await page.evaluate(() => window.__saveCalls), []);
  await page.locator('#about-button').click();
  assert.equal(await page.locator('#about-update-proxy').isChecked(), false);
  await page.locator('#about-update-proxy').check();
  await page.waitForFunction(() => !document.querySelector('#about-update-proxy').disabled);
  assert.equal(await page.locator('#update-proxy').isChecked(), true);
  await page.evaluate(() => { window.__failProxy = true; });
  await page.locator('#about-update-proxy').click();
  await page.waitForFunction(() => document.querySelector('#about-update-proxy-status').textContent.includes('无法修改'));
  assert.equal(await page.locator('#about-update-proxy').isChecked(), true);
  assert.equal(await page.locator('#update-proxy').isChecked(), true);
  await page.evaluate(() => { window.__failProxy = false; window.__probeError = '无法读取当前系统代理设置，请稍后重试。'; });
  await page.locator('#about-update-proxy').uncheck();
  await page.waitForFunction(() => document.querySelector('#about-update-proxy-status').textContent.includes('无法读取'));
  assert.equal(await page.locator('#about-update-proxy').isChecked(), false);
  assert.equal(await page.locator('#update-proxy').isChecked(), false);
  assert.match(await page.locator('#toast').innerText(), /无法读取/);
  await page.evaluate(() => { window.__probeError = null; });
  await page.locator('#about-update-proxy').check();
  await page.locator('#about-update-proxy:enabled').waitFor();
  await page.evaluate(() => { window.__failProxy = false; window.__systemProxy = true; });
  await page.locator('#about-dialog [data-close]').click();
  await page.locator('#about-button').click();
  await page.waitForFunction(() => document.querySelector('#about-update-proxy-status').textContent.includes('系统代理'));
  await page.locator('#about-update').click();
  assert.equal(await page.locator('#about-update-proxy').isEnabled(), false);
  assert.equal(await page.locator('#update-proxy').isEnabled(), false);
  await page.evaluate(() => window.__finishCheck());
  await page.locator('#about-update-proxy:enabled').waitFor();
  await page.evaluate(() => { window.__directFallback = true; });
  await page.locator('#about-dialog [data-close]').click();
  await page.locator('#about-button').click();
  await page.waitForFunction(() => document.querySelector('#about-update-proxy-status').textContent.includes('切换为直连'));
  assert.match(await page.locator('#update-proxy-status').innerText(), /系统代理连接未成功.*切换为直连/);
  assert.equal(await page.locator('#about-update-proxy').isChecked(), true);
  await page.evaluate(() => { window.__directFallback = false; });
  await page.locator('#about-update-proxy').uncheck();
  await page.waitForFunction(() => !document.querySelector('#about-update-proxy').disabled);
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.initialized === 'true');
  assert.equal(await page.locator('#update-proxy').isChecked(), true);
  await page.locator('[data-view="settings"]').click();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: path.resolve('artifacts/update-proxy-settings.png'), fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('#about-button').click();
    assert.equal(await page.locator('#about-update-proxy').isVisible(), true);
    await page.screenshot({ path: path.resolve(`artifacts/update-proxy-about-${width}.png`), fullPage: true });
    await page.locator('#about-dialog [data-close]').click();
  }
  assert.deepEqual(errors, []);
  console.log('Passed: session-only proxy switches synchronize, reject failed changes, surface detection errors returned after switching, lock during updates, show system route and direct recovery in both panels, reset on new process, and fit narrow layouts.');
} finally {
  await browser?.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

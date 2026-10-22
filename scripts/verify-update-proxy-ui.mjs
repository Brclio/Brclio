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
    window.__updateCalls = [];
    const proxyState = () => ({ enabled, supported: true, route: window.__systemProxy ? 'system' : enabled ? 'builtin' : 'direct', error: window.__probeError });
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
      checkForUpdates: () => { window.__updateCalls.push('check'); return new Promise(resolve => { window.__finishCheck = state => resolve(state || { status: 'up-to-date' }); }); },
      downloadUpdate: () => { window.__updateCalls.push('download'); return new Promise(resolve => { window.__finishDownload = state => resolve(state); }); },
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
  for (const count of [1, 10]) {
    await page.evaluate(count => window.__emitUpdate({ status: 'checking', retryCount: count, retryLimit: 10, retrying: true, retryStage: 'check', message: `连接未完成，正在进行第 ${count}/10 次自动重试。` }), count);
    assert.equal(await page.locator('#about-update-status-title').innerText(), `正在自动重试（${count}/10）…`);
    assert.equal(await page.locator('#update-status-title').innerText(), `正在自动重试（${count}/10）…`);
    assert.equal(await page.locator('#about-update').isEnabled(), false);
    assert.equal(await page.locator('#about-update-proxy').isEnabled(), false);
  }
  await page.evaluate(() => window.__finishCheck({ status: 'error', retryCount: 10, retryLimit: 10, retryExhausted: true, retryStage: 'check', error: '已自动重试 10 次仍未成功，请点击重新检查。' }));
  await page.locator('#about-update-proxy:enabled').waitFor();
  assert.equal(await page.locator('#about-update-status-title').innerText(), '自动重试已用完，请手动重试。');
  assert.equal(await page.locator('#about-update').innerText(), '重新检查');
  assert.match(await page.locator('#about-update-status-detail').innerText(), /10.*重新检查/);
  assert.match(await page.locator('#about-update-proxy-status').innerText(), /系统代理/);
  await page.locator('#about-update').click();
  assert.equal(await page.locator('#about-update-status-title').innerText(), '正在检查 GitHub 最新版本…');
  await page.evaluate(() => window.__finishCheck({ status: 'available', version: '0.1.13', assetName: 'Brclio-0.1.13-mac-arm64.dmg' }));
  await page.locator('#about-update:enabled').waitFor();
  await page.locator('#about-update').click();
  await page.evaluate(() => window.__emitUpdate({ status: 'downloading', version: '0.1.13', progress: 0, retryCount: 10, retryLimit: 10, retrying: true, retryStage: 'download', message: '正在进行第 10/10 次自动重试。' }));
  assert.equal(await page.locator('#about-update-status-title').innerText(), '正在自动重试（10/10）…');
  assert.equal(await page.locator('#about-update-proxy').isEnabled(), false);
  await page.evaluate(() => window.__finishDownload({ status: 'error', version: '0.1.13', retryStage: 'download', retryCount: 10, retryExhausted: true, error: '已自动重试 10 次仍未成功，请点击重新下载。' }));
  await page.locator('#about-update:enabled').waitFor();
  assert.equal(await page.locator('#about-update').innerText(), '重新下载');
  assert.equal(await page.locator('#download-update').isHidden(), false);
  assert.equal(await page.locator('#download-update').textContent(), '重新下载并安装');
  await page.locator('#about-update').click();
  assert.equal(await page.locator('#about-update-status-title').innerText(), '正在下载 v0.1.13…');
  assert.deepEqual(await page.evaluate(() => window.__updateCalls), ['check', 'check', 'download', 'download']);
  await page.evaluate(() => window.__finishDownload({ status: 'error', retryStage: 'download', retryCount: 0, retryExhausted: false, error: '下载已取消。' }));
  await page.locator('#about-update-proxy:enabled').waitFor();
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
  console.log('Passed: proxy switches synchronize, system route remains visible, automatic retry counts and exhaustion appear in both panels, manual retry invokes the correct operation, controls stay locked, and fresh runs and narrow layouts work.');
} finally {
  await browser?.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

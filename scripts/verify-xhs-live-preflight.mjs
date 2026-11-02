import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'web'), output = path.join(root, 'artifacts', 'xhs-live-preflight');
const report = { passed: false, checks: [], errors: [] };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.wasm': 'application/wasm' };
const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname.startsWith('/api/account/')) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ user: null, googleEnabled: false })); return; }
    const target = path.resolve(web, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
    if (!target.startsWith(web + path.sep)) { response.writeHead(403); response.end(); return; }
    const data = await readFile(target);
    response.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' }); response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, page;
try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.BRCLIO_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1060 } });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await context.route(/^https?:/, route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  await page.locator('[data-view="xhs"]').first().click(); await page.locator('#xhs-tab-live').click();
  await page.locator('#xhs-live-support').filter({ hasText: '支持本地制作' }).waitFor();
  const live = id => page.locator('#xhs-live-' + id);
  const field = async (id, value) => { await live(id).fill(String(value)); await live(id).dispatchEvent('change'); };
  const bytes = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 10000; canvas.height = 1000;
    const context = canvas.getContext('2d'); context.fillStyle = '#2b7fd8'; context.fillRect(0, 0, 10000, 1000);
    context.fillStyle = '#f4d758'; context.fillRect(0, 0, 1000, 1000);
    context.fillStyle = '#e84a5f'; context.fillRect(9000, 0, 1000, 1000);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await live('format').selectOption('jpeg');
  await live('files').setInputFiles({ name: 'panorama.png', mimeType: 'image/png', buffer: Buffer.from(bytes, 'base64') });
  await expect(live('generate')).toBeEnabled();
  await expect(live('plan-summary')).toContainText('照片 10000 × 1000');
  await expect(live('plan-detail')).toContainText('等比例缩小');
  assert.equal(await live('result').isVisible(), false, 'The dimensions must be visible before any generation.');
  report.autoPlan = await live('plan-summary').textContent();
  report.checks.push('Panorama import checks the actual encoder and explains separate photo/motion sizes before generating.');
  await page.locator('.xhs-live-advanced summary').click();
  await field('duration', .5); await field('cover', .2); await live('motion').selectOption('still');
  await live('size-policy').selectOption('original');
  await expect(live('plan-summary')).toContainText('暂不能生成');
  await expect(live('generate')).toBeDisabled();
  await expect(live('preview')).toBeDisabled();
  await expect(live('retry')).toBeVisible();
  assert.equal(await live('file-list').locator('li').count(), 1);
  report.checks.push('Must-keep-original rejects an unsupported panorama before encoding and retains the selected file.');
  await live('size-policy').selectOption('compact');
  await expect(live('plan-summary')).toContainText('照片 1440 × 144');
  await expect(live('generate')).toBeEnabled();
  await live('preview').click();
  await expect(live('preview-canvas')).toBeVisible();
  assert.deepEqual(await live('preview-canvas').evaluate(canvas => [canvas.width, canvas.height]), [1440, 144]);
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
  await live('generate').click();
  await expect(live('result')).toBeVisible({ timeout: 60000 });
  await expect(live('result-info')).toContainText('照片 1440 × 144');
  await expect(live('result-info')).toContainText('无声');
  report.checks.push('Compact mode produces real photo/MOV output and displays both dimensions and audio state.');

  await expect(live('generate')).toBeEnabled();
  await live('size-policy').selectOption('auto');
  await page.getByRole('button', { name: '编辑 panorama.png', exact: true }).click();
  await expect(live('edit-save')).toBeEnabled();
  await field('edit-x', 10); await field('edit-width', 80);
  await live('edit-brightness').fill('110'); await live('edit-brightness').dispatchEvent('input');
  await live('edit-save').click();
  await expect(live('plan-summary')).toContainText('照片 8000 × 1000');
  await expect(live('generate')).toBeEnabled();
  // An actual configure-time failure, after successful capability preflight.
  // The subsequent retry uses the real unmodified browser encoder.
  await page.evaluate(() => {
    const configure = VideoEncoder.prototype.configure;
    VideoEncoder.prototype.configure = function (config) {
      VideoEncoder.prototype.configure = configure;
      throw new DOMException('测试编码失败：设备在启动时拒绝当前配置', 'EncodingError');
    };
  });
  await live('generate').click();
  await expect(live('status')).toContainText('素材、裁切和设置已保留');
  await expect(live('retry')).toBeVisible();
  await expect(live('retry')).toBeEnabled();
  await expect(live('file-list')).toContainText('已编辑');
  await expect(live('duration')).toHaveValue('0.5');
  await expect(live('cover')).toHaveValue('0.2');
  await live('retry').click();
  await expect(live('result')).toBeVisible({ timeout: 60000 });
  await expect(live('result-info')).toContainText('照片 1440 × 180');
  await expect(page.locator('#xhs-message')).toBeHidden();
  await expect(live('plan-detail')).toContainText('兼容尺寸重试');
  await expect(live('size-policy')).toHaveValue('auto');
  await page.getByRole('button', { name: '编辑 panorama.png', exact: true }).click();
  await expect(live('edit-save')).toBeEnabled();
  await expect(live('edit-x')).toHaveValue('10'); await expect(live('edit-width')).toHaveValue('80');
  await expect(live('edit-brightness')).toHaveValue('110'); await live('edit-cancel').click();
  report.checks.push('Configure failure offers a working compatibility retry without reimporting; crop, tone, duration, cover and original size preference survive.');
  for (const width of [900, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await live('plan').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    const bounds = await live('plan').boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
    await page.screenshot({ path: path.join(output, `width-${width}.png`), fullPage: true });
  }
  report.checks.push('Advanced controls, preflight explanations and result dimensions fit desktop/narrow layouts without horizontal overflow.');
  await page.setViewportSize({ width: 1440, height: 1060 });
  await page.evaluate(() => {
    const original = VideoEncoder.isConfigSupported;
    window.__restorePreflightProbe = () => { VideoEncoder.isConfigSupported = original; };
    VideoEncoder.isConfigSupported = () => new Promise(() => {});
  });
  await live('files').setInputFiles({ name: 'panorama.png', mimeType: 'image/png', buffer: Buffer.from(bytes, 'base64') });
  await expect(live('plan-summary')).toContainText('正在检查');
  await live('cancel').click();
  await expect(live('files')).toBeEnabled({ timeout: 2000 });
  await expect(live('plan-summary')).toContainText('已取消');
  await page.evaluate(() => window.__restorePreflightProbe());
  await live('size-policy').selectOption('compact');
  await expect(live('generate')).toBeEnabled();
  report.checks.push('Canceling an indefinitely pending encoder capability probe immediately restores the UI; retained files can be replanned.');

  // A separate page leaves its first generic capability promise unresolved.
  // The selected-file plan must recover without depending on that old result.
  await page.close(); page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.addInitScript(() => {
    const original = VideoEncoder.isConfigSupported;
    let first = true;
    VideoEncoder.isConfigSupported = function (config) {
      if (first) {
        first = false; window.__startupProbePending = true;
        return new Promise((_resolve, reject) => { window.__rejectStartupProbe = () => reject(new Error('Late startup capability failure')); });
      }
      return original.call(this, config);
    };
  });
  await page.goto(origin);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  await page.locator('[data-view="xhs"]').first().click(); await page.locator('#xhs-tab-live').click();
  await page.waitForFunction(() => window.__startupProbePending === true);
  const small = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d'); context.fillStyle = '#2b7fd8'; context.fillRect(0, 0, 64, 64);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await live('format').selectOption('jpeg');
  await live('files').setInputFiles({ name: 'startup-recovery.png', mimeType: 'image/png', buffer: Buffer.from(small, 'base64') });
  await expect(live('plan-summary')).toContainText('照片 64 × 64');
  await expect(live('support')).toContainText('支持本地制作');
  await expect(live('generate')).toBeEnabled();
  const currentSupport = await live('support').textContent();
  await page.evaluate(async () => { window.__rejectStartupProbe(); await new Promise(resolve => setTimeout(resolve, 0)); });
  await expect(live('support')).toHaveText(currentSupport);
  await expect(live('generate')).toBeEnabled();
  await live('generate').click();
  await expect(live('result')).toBeVisible({ timeout: 60000 });
  await expect(live('result-info')).toContainText('照片 64 × 64');
  await expect(live('result-info')).toContainText('动态 64 × 64');
  report.checks.push('A successful selected-file plan replaces a hung startup probe, updates support text and generates real media; a late startup rejection cannot overwrite it.');
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) {
  report.error = error.stack; process.exitCode = 1;
  if (page) {
    report.ui = await page.evaluate(() => Object.fromEntries(['status', 'plan-summary', 'plan-detail'].map(id => [id, document.getElementById('xhs-live-' + id)?.textContent]))).catch(() => ({}));
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  }
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

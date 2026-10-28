import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, _electron, expect } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'web');
const output = path.join(root, 'artifacts');
const electronMode = process.argv.includes('--electron');
const artifactPrefix = `xhs-live-import${electronMode ? '-electron' : ''}`;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.wasm': 'application/wasm' };
const report = { passed: false, checks: [], screenshots: [], errors: [] };
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/api/account/session') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ user: null, googleEnabled: false })); return;
    }
    const target = path.resolve(web, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!target.startsWith(web + path.sep)) { response.writeHead(403); response.end(); return; }
    response.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(await readFile(target));
  } catch { response.writeHead(404); response.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser, electronApp, temporary;
try {
  await mkdir(output, { recursive: true });
  let page;
  if (electronMode) {
    temporary = await mkdtemp(path.join(os.tmpdir(), 'brclio-live-import-'));
    const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    await writeFile(path.join(temporary, 'package.json'), JSON.stringify({ name: metadata.name, version: metadata.version, productName: metadata.productName, main: 'bootstrap.cjs' }));
    await writeFile(path.join(temporary, 'bootstrap.cjs'), `const { app, session } = require('electron');
const sessions = new WeakSet();
function offline(value) {
  if (sessions.has(value)) return; sessions.add(value);
  for (const scheme of ['http', 'https']) value.protocol.handle(scheme, request => {
    if (new URL(request.url).pathname.startsWith('/api/account/')) return Response.json({ user: null, csrf: 'fixture-csrf', googleEnabled: false, passwordEnabled: true });
    return new Response('<!doctype html><title>Offline verification</title>');
  });
}
app.on('session-created', offline); app.whenReady().then(() => offline(session.defaultSession));
require(${JSON.stringify(path.join(root, 'desktop/main.cjs'))});
`);
    electronApp = await _electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), temporary], env: { ...process.env, BRCLIO_USER_DATA: path.join(temporary, 'user-data'), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }, timeout: 30000 });
    page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1440, height: 1060 });
  } else {
    browser = await chromium.launch({ executablePath: process.env.BRCLIO_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1060 } });
    page = await context.newPage();
  }
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.errors.push(error.message));
  if (!electronMode) await page.goto(url);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  if (electronMode) assert.match(page.url(), /^file:\/\//);
  report.runtime = electronMode ? 'Electron real main window with production file CSP' : 'Chrome';
  report.origin = page.url();
  await page.locator('[data-view="xhs"]').first().click(); await page.locator('#xhs-tab-live').click();
  await page.locator('#xhs-live-support').filter({ hasText: '支持本地制作' }).waitFor();

  // Real PNGs total 72 megapixels. Their encoded size is small enough that the
  // decoded-pixel limit, rather than the independent byte limit, triggers here.
  const fixtureBytes = await page.evaluate(() => ['#da4535', '#338449', '#3568ce'].map(color => {
    const canvas = document.createElement('canvas'); canvas.width = 6000; canvas.height = 4000;
    const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/png').split(',')[1]; canvas.width = canvas.height = 0; return data;
  }));
  const files = fixtureBytes.map((bytes, index) => ({ name: `large-${index + 1}.png`, mimeType: 'image/png', buffer: Buffer.from(bytes, 'base64') }));
  assert.ok(files.reduce((total, file) => total + file.buffer.length, 0) < 150 * 1048576);
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    window.__importBlobCalls = []; window.__importBlobMode = 'normal';
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      window.__importBlobCalls.push({ width: this.width, height: this.height, type: args[0] });
      if (window.__importBlobMode === 'fail') { queueMicrotask(() => callback(null)); return; }
      if (window.__importBlobMode === 'hold') { window.__releaseImportBlob = () => callback(new Blob(['late'], { type: 'image/jpeg' })); return; }
      return original.call(this, callback, ...args);
    };
  });
  const picker = page.locator('#xhs-live-files');
  const dialog = page.locator('#xhs-live-compress-dialog');
  const source = page.locator('#xhs-live-source-info');
  const generate = page.locator('#xhs-live-generate');
  const preview = page.locator('#xhs-live-preview');
  const resetBlobCalls = () => page.evaluate(() => { window.__importBlobCalls = []; });
  const openConfirmation = async () => { await picker.setInputFiles(files); await dialog.waitFor({ state: 'visible' }); };
  const assertCanceled = async (text = '已取消导入') => {
    await source.filter({ hasText: text }).waitFor(); await expect(dialog).toBeHidden();
    await expect(picker).toBeEnabled(); await expect(generate).toBeDisabled(); await expect(preview).toBeDisabled();
    assert.equal(await picker.inputValue(), '', 'Canceled imports clear the picker so the same files can be reselected.');
    assert.equal(await page.locator('#xhs-live-file-list li').count(), 0);
    await expect(page.locator('#xhs-live-progress')).toBeHidden();
  };

  await picker.setInputFiles(path.join(web, 'assets/icon.png'));
  await source.filter({ hasText: '1 张图片' }).waitFor();
  await expect(dialog).toBeHidden(); await expect(generate).toBeEnabled();
  assert.doesNotMatch(await source.innerText(), /已压缩/);
  assert.equal(await page.evaluate(() => window.__importBlobCalls.length), 0);
  report.checks.push('Small images import unchanged without a compression prompt.');

  const byteLimit = await page.evaluate(async bytes => {
    const module = await import('./xhs/lib/live-photo-maker.js');
    const file = new File([Uint8Array.from(atob(bytes), char => char.charCodeAt(0))], 'declared-large.png', { type: 'image/png' });
    // Preserve actual readable image bytes while exercising a declared file
    // size over the cap without allocating a 150 MiB fixture in the test.
    Object.defineProperty(file, 'size', { value: module.LIVE_PHOTO_LIMITS.maxBytes + 1 });
    let rejected = false;
    try { await module.inspectLivePhotoFiles([file]); } catch (error) { rejected = /150 MB/.test(error.message); }
    const info = await module.inspectLivePhotoFiles([file], { allowOversizedImages: true });
    return { rejected, requiresCompression: info.requiresCompression, bytes: info.bytes, pixels: info.pixels };
  }, (await readFile(path.join(web, 'assets/icon.png'))).toString('base64'));
  assert.equal(byteLimit.rejected, true); assert.equal(byteLimit.requiresCompression, true);
  assert.ok(byteLimit.bytes > 150 * 1048576); assert.ok(byteLimit.pixels < 64_000_000);
  report.checks.push('The byte-limit inspection reports compression eligibility while strict validation still rejects oversized originals.');

  await openConfirmation();
  assert.match(await page.locator('#xhs-live-compress-description').innerText(), /7,?200.*6400/);
  await expect(generate).toBeDisabled(); await expect(preview).toBeDisabled();
  assert.equal(await page.evaluate(() => window.__importBlobCalls.length), 0, 'Compression must wait for explicit confirmation.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'xhs-live-compress-cancel');
  await page.screenshot({ path: path.join(output, artifactPrefix + '-confirm.png'), fullPage: true });
  report.screenshots.push('artifacts/' + artifactPrefix + '-confirm.png');
  await page.locator('#xhs-live-compress-cancel').click(); await assertCanceled();
  assert.equal(await page.evaluate(() => window.__importBlobCalls.length), 0);

  await page.setViewportSize({ width: 320, height: 780 }); await openConfirmation();
  const bounds = await dialog.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 320);
  assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  await page.screenshot({ path: path.join(output, artifactPrefix + '-mobile.png'), fullPage: true });
  report.screenshots.push('artifacts/' + artifactPrefix + '-mobile.png');
  await page.keyboard.press('Escape'); await assertCanceled();
  await page.setViewportSize({ width: 1440, height: 1060 }); await openConfirmation();
  await page.mouse.click(4, 4); await assertCanceled();
  report.checks.push('Explicit cancel, Escape and backdrop dismissal cancel import; the same originals can be selected again, and the modal fits 320px.');

  const dropped = await page.evaluateHandle(bytes => {
    const transfer = new DataTransfer();
    bytes.forEach((bytes, index) => transfer.items.add(new File([Uint8Array.from(atob(bytes), char => char.charCodeAt(0))], `drop-${index + 1}.png`, { type: 'image/png' })));
    return transfer;
  }, fixtureBytes);
  try { await page.locator('[for="xhs-live-files"]').dispatchEvent('drop', { dataTransfer: dropped }); }
  finally { await dropped.dispose(); }
  await dialog.waitFor({ state: 'visible' });
  assert.match(await page.locator('#xhs-live-compress-description').innerText(), /7,?200.*6400/);
  assert.equal(await page.evaluate(() => window.__importBlobCalls.length), 0);
  await page.locator('#xhs-live-compress-cancel').click(); await assertCanceled();
  report.checks.push('Dropping oversized originals reaches the same confirmation and waits for consent before compression.');

  await page.evaluate(() => { window.__importBlobMode = 'fail'; }); await openConfirmation();
  await page.locator('#xhs-live-compress-confirm').click();
  await source.filter({ hasText: '素材读取失败' }).waitFor();
  await expect(page.locator('#xhs-message')).toContainText('图片压缩失败');
  await expect(picker).toBeEnabled(); await expect(generate).toBeDisabled();
  await expect(page.locator('#xhs-live-progress')).toBeHidden();
  assert.equal(await page.locator('#xhs-live-file-list li').count(), 0);

  await page.evaluate(() => { window.__importBlobMode = 'hold'; window.__releaseImportBlob = null; }); await openConfirmation();
  await page.locator('#xhs-live-compress-confirm').click();
  await page.waitForFunction(() => typeof window.__releaseImportBlob === 'function');
  await page.locator('#xhs-live-cancel').click(); await assertCanceled('素材读取已取消');
  await page.evaluate(() => { window.__releaseImportBlob(); window.__importBlobMode = 'normal'; });
  await expect(generate).toBeDisabled();
  report.checks.push('Failed compression and cancellation during pending canvas encoding restore controls and reject late completion.');

  await resetBlobCalls(); await openConfirmation();
  await page.locator('#xhs-live-compress-confirm').click();
  await source.filter({ hasText: '已压缩导入' }).waitFor();
  await expect(generate).toBeEnabled(); await expect(preview).toBeEnabled(); await expect(dialog).toBeHidden();
  assert.equal(await picker.evaluate(input => input.files.length), 3, 'Successful imports retain the native picker file count.');
  assert.equal(await page.locator('#xhs-live-file-list li').count(), 3);
  const compressionCalls = await page.evaluate(() => window.__importBlobCalls);
  assert.equal(compressionCalls.length, 3);
  for (const call of compressionCalls) { assert.equal(call.type, 'image/jpeg'); assert.equal(call.width, 4096); assert.equal(call.height, 2730); }
  assert.match(await source.innerText(), /4096 × 2730.*原文件保留/);
  await page.getByRole('button', { name: '将 large-2-compressed.jpg 上移', exact: true }).click();
  await source.filter({ hasText: '已压缩导入' }).waitFor();
  assert.match(await page.locator('#xhs-live-file-list li').first().innerText(), /large-2-compressed.jpg/);
  assert.equal(await page.evaluate(() => window.__importBlobCalls.length), 3, 'Reordering compressed files must not compress again.');
  await page.locator('#xhs-live-duration').fill('0.5'); await page.locator('#xhs-live-duration').dispatchEvent('change');
  await page.locator('#xhs-live-cover').fill('0.1'); await page.locator('#xhs-live-cover').dispatchEvent('change');
  await page.locator('#xhs-live-motion').selectOption('still'); await page.locator('#xhs-live-format').selectOption('jpeg');
  await preview.click(); await page.locator('#xhs-live-preview-canvas').waitFor({ state: 'visible' });
  // Reading a 4K canvas on a busy runner can take longer than one image's
  // 1/6-second interval. The preview finishes at cover=.1, which selects the
  // reordered first (green) image; wait for that observable frame.
  await page.locator('#xhs-live-preview-canvas').evaluate(async () => {
    const start = performance.now();
    await new Promise(resolve => {
      const tick = () => performance.now() - start >= 500 ? resolve() : requestAnimationFrame(tick);
      requestAnimationFrame(tick);
    });
  });
  await expect.poll(async () => {
    const pixel = await page.locator('#xhs-live-preview-canvas').evaluate(canvas =>
      [...canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data]);
    return pixel[1] > pixel[0] + 30 && pixel[1] > pixel[2] + 30;
  }, { message: 'The reordered green image must be visible at the selected cover time.' }).toBe(true);
  await generate.click(); await page.locator('#xhs-live-result').waitFor({ timeout: 120000 });
  assert.match(await page.locator('#xhs-live-result-info').innerText(), /0.5 秒.*JPG \+ MOV/);
  await page.waitForFunction(() => { const image = document.getElementById('xhs-live-preview-image'); return image.complete && image.naturalWidth > 0; });
  await expect(page.locator('#xhs-live-cancel')).toBeHidden();
  report.checks.push('Confirmed compression creates three high-quality 4096x2730 JPG files in order, retains compression provenance after reordering, previews correctly and generates a real 0.5-second JPG+MOV.');

  assert.deepEqual(report.errors, []); report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) { report.failure = error.stack; throw error; }
finally {
  await browser?.close(); await electronApp?.close(); await new Promise(resolve => server.close(resolve));
  if (temporary) await rm(temporary, { recursive: true, force: true });
  await writeFile(path.join(output, artifactPrefix + '-verification.json'), JSON.stringify(report, null, 2) + '\n');
}

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'web'), output = path.join(root, 'artifacts', 'xhs-live-editor');
const report = { passed: false, checks: [], errors: [] };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.wasm': 'application/wasm' };
const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/api/account/session') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ user: null, googleEnabled: false })); return; }
    const target = path.resolve(web, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
    if (!target.startsWith(web + path.sep)) { response.writeHead(403); response.end(); return; }
    response.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' }); response.end(await readFile(target));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, page;
try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.BRCLIO_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1060 }, acceptDownloads: true });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  await page.locator('[data-view="xhs"]').first().click(); await page.locator('#xhs-tab-live').click();
  await page.locator('#xhs-live-support').filter({ hasText: '支持本地制作' }).waitFor();
  const fixtures = await page.evaluate(() => [[800, 600, '#287ba8'], [600, 900, '#478644']].map(([width, height, color]) => {
    const canvas = document.createElement('canvas'); Object.assign(canvas, { width, height });
    const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, width, height);
    context.fillStyle = '#f4d758'; context.fillRect(0, 0, width / 2, height / 2);
    context.fillStyle = '#e84a5f'; context.fillRect(width / 2, height / 2, width / 2, height / 2);
    return canvas.toDataURL('image/png').split(',')[1];
  }));
  const files = fixtures.map((bytes, index) => ({ name: index === 0 ? 'landscape.png' : 'portrait.png', mimeType: 'image/png', buffer: Buffer.from(bytes, 'base64') }));
  const picker = page.locator('#xhs-live-files'), dialog = page.locator('#xhs-live-edit-dialog');
  const edit = id => page.locator('#xhs-live-edit-' + id);
  const field = async (id, value) => { await edit(id).fill(String(value)); await edit(id).dispatchEvent('change'); };
  const open = async name => {
    await page.getByRole('button', { name: `编辑 ${name}`, exact: true }).click();
    await expect(dialog).toBeVisible(); await expect(edit('save')).toBeEnabled();
  };
  const setCrop = async () => { for (const [key, value] of [['x', 25], ['y', 25], ['width', 50], ['height', 50]]) await field(key, value); };
  const setValue = async (id, value) => { await edit(id).fill(String(value)); await edit(id).dispatchEvent('input'); };
  const settings = async () => ({ crop: await Promise.all(['x', 'y', 'width', 'height'].map(key => edit(key).inputValue())), brightness: await edit('brightness').inputValue(), rotation: await edit('rotation').textContent() });
  const noReencode = async () => assert.equal(await page.evaluate(() => window.__editBlobCalls), 0, 'Editing must keep original bytes and never JPEG-reencode them.');
  await picker.setInputFiles(files); await page.locator('#xhs-live-source-info').filter({ hasText: '2 张图片' }).waitFor();
  await page.evaluate(() => {
    window.__editBlobCalls = 0; const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (...args) { window.__editBlobCalls++; return original.apply(this, args); };
    window.__editURLs = []; window.__editRevoked = [];
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = value => { const url = create(value); window.__editURLs.push(url); return url; };
    URL.revokeObjectURL = value => { window.__editRevoked.push(value); revoke(value); };
  });

  await open('landscape.png'); await setCrop(); await edit('rotate').click(); await edit('flip-x').click(); await setValue('brightness', 120);
  await expect(edit('dimensions')).toContainText('300 × 400'); await edit('cancel').click();
  assert.equal(await page.locator('#xhs-live-file-list').textContent().then(text => text.includes('已编辑')), false);
  await open('landscape.png'); await expect(edit('dimensions')).toContainText('800 × 600');
  assert.deepEqual((await settings()).crop, ['0', '0', '100', '100']);
  await setCrop(); await edit('rotate').click(); await edit('flip-x').click(); await setValue('brightness', 120); await setValue('contrast', 110); await setValue('saturation', 80);
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
  await edit('save').click(); await expect(dialog).toBeHidden(); await expect(page.locator('#xhs-live-file-list li').first()).toContainText('已编辑');
  await noReencode(); report.checks.push('Per-image crop/rotation/flip/tone save and cancel preserve original File bytes without canvas encoding.');

  await open('portrait.png'); await expect(edit('dimensions')).toContainText('600 × 900'); await edit('cancel').click();
  await open('landscape.png'); assert.equal((await settings()).brightness, '120'); await edit('all').click();
  assert.equal(await page.locator('#xhs-live-file-list li').filter({ hasText: '已编辑' }).count(), 2);
  await open('portrait.png'); await expect(edit('dimensions')).toContainText('450 × 300'); assert.equal((await settings()).brightness, '120');
  await field('width', 25); await edit('cancel').click();
  await page.getByRole('button', { name: '将 portrait.png 上移', exact: true }).click();
  await page.locator('#xhs-live-file-list li').first().filter({ hasText: 'portrait.png' }).waitFor();
  await open('portrait.png'); await expect(edit('dimensions')).toContainText('450 × 300'); await edit('reset').click(); await expect(edit('dimensions')).toContainText('600 × 900'); await edit('save').click();
  await open('landscape.png'); await expect(edit('dimensions')).toContainText('300 × 400'); await edit('cancel').click(); await noReencode();
  report.checks.push('Apply-all uses normalized crop for different source sizes; reordering retains edits by File identity and resetting one image leaves the other intact.');

  await open('landscape.png'); await edit('ratio').selectOption('1:1'); await edit('all').click();
  await expect(page.locator('#xhs-live-generate')).toBeEnabled();
  for (const name of ['landscape.png', 'portrait.png']) {
    await open(name);
    assert.equal(await edit('ratio').inputValue(), '1:1', 'Saved ratio presets survive reopening and reordering.');
    const dimensions = await edit('dimensions').textContent(), match = dimensions.match(/裁切后 (\d+) × (\d+)/);
    assert.equal(Number(match[1]), Number(match[2]), 'A fixed ratio applies as a true square on every source aspect.');
    await edit('cancel').click();
  }
  await open('landscape.png'); const beforeCanceledBatch = await settings(); await setValue('brightness', 150);
  await page.evaluate(() => {
    const Original = window.Image, src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    window.__batchRelease = null;
    window.Image = class extends Original {
      set src(value) { if (value && !window.__batchRelease) { const image = this; window.__batchRelease = () => src.set.call(image, value); } else src.set.call(this, value); }
      get src() { return src.get.call(this); }
    };
    window.__restoreBatchImage = () => { window.Image = Original; };
  });
  await edit('all').click(); await page.waitForFunction(() => typeof window.__batchRelease === 'function');
  await page.locator('#xhs-live-cancel').click(); await expect(page.locator('#xhs-live-generate')).toBeEnabled();
  await expect(page.locator('#xhs-live-status')).toContainText('统一调整已取消');
  await page.evaluate(() => { window.__batchRelease(); window.__restoreBatchImage(); });
  await open('landscape.png'); assert.deepEqual(await settings(), beforeCanceledBatch, 'Canceled batch must leave every prior recipe unchanged.'); await edit('cancel').click();
  await open('portrait.png'); await edit('reset').click(); await edit('save').click();
  await open('landscape.png'); await edit('reset').click(); await setCrop(); await edit('rotate').click(); await edit('save').click();
  report.checks.push('Fixed 1:1 batch crops preserve real squares and saved ratio presets across source sizes; canceling a pending batch leaves all prior recipes unchanged.');

  await page.setViewportSize({ width: 320, height: 780 }); await open('landscape.png');
  const bounds = await dialog.boundingBox(); assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 320);
  assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true }); await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 1060 });
  await open('portrait.png'); await edit('ratio').selectOption('1:1'); await expect(edit('dimensions')).toContainText('600 × 600');
  await edit('unit').selectOption('pixels'); await field('x', 100); await field('y', 200); await field('width', 300); await field('height', 400); await expect(edit('dimensions')).toContainText('300 × 400');
  await edit('ratio').selectOption('original');
  const canvas = edit('crop'), area = await canvas.boundingBox();
  await page.mouse.move(area.x + area.width - 2, area.y + area.height - 2); await page.mouse.down();
  await page.mouse.move(area.x + area.width * .7, area.y + area.height * .6); await page.mouse.up();
  const cropPixels = await Promise.all(['width', 'height'].map(key => edit(key).inputValue().then(Number)));
  assert.ok(Math.abs(cropPixels[0] / cropPixels[1] - 600 / 900) < .01, 'Original-ratio corner dragging keeps the source aspect.');
  await edit('cancel').click(); await noReencode();
  report.checks.push('Editor fits 320px, supports Escape, original/fixed ratios, pixel coordinates and ratio-preserving pointer corner resizing.');

  // An image replaced while its decoder is loading must not reopen the editor
  // or apply the old draft. Instrument only the editor's next Image source.
  await page.evaluate(() => {
    const Original = window.Image, src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    window.__editorRelease = null;
    window.Image = class extends Original {
      set src(value) { if (value && !window.__editorRelease) { const image = this; window.__editorRelease = () => src.set.call(image, value); } else src.set.call(this, value); }
      get src() { return src.get.call(this); }
    };
    window.__restoreImage = () => { window.Image = Original; };
  });
  await page.getByRole('button', { name: '编辑 landscape.png', exact: true }).click(); await expect(dialog).toBeVisible(); await expect(edit('save')).toBeDisabled();
  await picker.setInputFiles(files);
  await expect(dialog).toBeHidden(); await page.evaluate(() => { window.__editorRelease(); window.__restoreImage(); });
  await page.locator('#xhs-live-source-info').filter({ hasText: '2 张图片' }).waitFor();
  await expect(dialog).toBeHidden(); await expect(page.locator('#xhs-live-generate')).toBeEnabled();
  const urls = await page.evaluate(() => ({ created: window.__editURLs, revoked: window.__editRevoked }));
  assert.deepEqual(new Set(urls.created), new Set(urls.revoked), 'All editor and import object URLs are revoked after close/reselect.');
  await noReencode(); report.checks.push('Reselecting during a pending image decode closes the stale editor, releases URLs and rejects late decoder completion.');

  // Reestablish different edits and verify actual exported cover dimensions.
  await open('landscape.png'); await setCrop(); await edit('rotate').click(); await edit('save').click();
  await page.getByRole('button', { name: '将 portrait.png 上移', exact: true }).click();
  await page.locator('#xhs-live-file-list li').first().filter({ hasText: 'portrait.png' }).waitFor();
  for (const [key, value] of [['duration', '.5'], ['cover', '.3']]) { const input = page.locator('#xhs-live-' + key); await input.fill(value); await input.dispatchEvent('change'); }
  await page.locator('#xhs-live-motion').selectOption('still'); await page.locator('#xhs-live-format').selectOption('jpeg');
  await page.locator('#xhs-live-preview').click(); await page.locator('#xhs-live-preview-canvas').waitFor({ state: 'visible' });
  await expect.poll(() => page.locator('#xhs-live-preview-canvas').evaluate(canvas => [canvas.width, canvas.height])).toEqual([600, 900]);
  const busy = await page.evaluate(() => {
    document.querySelector('#xhs-live-generate').click();
    return [...document.querySelectorAll('#xhs-live-file-list button')].every(button => button.disabled);
  });
  assert.equal(busy, true);
  await page.waitForFunction(() => !document.querySelector('#xhs-live-result').hidden || (document.querySelector('#xhs-live-cancel').hidden && document.querySelector('#xhs-live-status').textContent), null, { timeout: 120000 });
  assert.equal(await page.locator('#xhs-live-result').isVisible(), true, await page.locator('#xhs-live-status').textContent());
  await expect(page.locator('#xhs-live-result-info')).toContainText('照片 300 × 400'); await expect(page.locator('#xhs-live-result-info')).toContainText('动态 600 × 900');
  await expect.poll(() => page.locator('#xhs-live-preview-image').evaluate(image => [image.naturalWidth, image.naturalHeight])).toEqual([300, 400]);
  const downloadPromise = page.waitForEvent('download'); await page.locator('#xhs-live-export-photo').click();
  const download = await downloadPromise, photo = path.join(output, 'selected-cover.JPG'); await download.saveAs(photo);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', photo], { encoding: 'utf8' }));
  assert.equal(probe.streams[0].width, 300); assert.equal(probe.streams[0].height, 400);
  await open('landscape.png'); await edit('reset').click(); await edit('save').click(); await expect(page.locator('#xhs-live-result')).toBeHidden();
  await page.getByRole('button', { name: '移除 portrait.png', exact: true }).click();
  await page.locator('#xhs-live-file-list li').filter({ hasText: 'landscape.png' }).waitFor();
  await open('landscape.png'); await expect(edit('dimensions')).toContainText('800 × 600'); await edit('cancel').click();
  report.checks.push('Real JPEG export uses the selected cover image crop at 300×400 while MOV/preview use first-image 600×900; encoding disables edits and saving a new edit invalidates the old result.');
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.error = error.stack || String(error); process.exitCode = 1; }
finally {
  if (page && !report.passed) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await browser?.close(); await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

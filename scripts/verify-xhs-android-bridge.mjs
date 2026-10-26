import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

// Run the actual bridge and shared parser; substitute only Android's message
// transport. No account, public API, or real note is contacted by this test.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'web');
const report = { passed: false, checks: [], errors: [] };
const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://local').pathname;
    if (pathname === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; connect-src \'self\'"><title>Android bridge verification</title><script src="/bridge.js"></script>');
      return;
    }
    const filename = path.resolve(web, '.' + decodeURIComponent(pathname));
    if (!filename.startsWith(web + path.sep)) throw new Error('Outside web root');
    response.setHeader('Content-Type', { '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' }[path.extname(filename)] || 'application/octet-stream');
    response.end(await readFile(filename));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.BRCLIO_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.addInitScript(() => {
    const noteId = '0123456789abcdef01234567';
    const original = 'https://sns-video-bd.xhscdn.com/spectrum/fixture-original.mp4';
    const image = 'https://ci.xiaohongshu.com/fixture-original?imageView2/format/jpg';
    const ordinary = 'https://sns-video-bd.xhscdn.com/stream/fixture.mp4';
    const html = '<script>window.__INITIAL_STATE__=' + JSON.stringify({ note: { noteDetailMap: { [noteId]: { note: { noteId, title: '本地补充原视频', desc: '保留文案', imageList: [{ urlDefault: image, livePhoto: true, stream: { h264: [{ masterUrl: original }] } }], video: { consumer: { originVideoKey: original } } } } } } }) + '</script>';
    window.__fixture = { noteId, original, image, ordinary };
    window.__mode = 'local'; window.__calls = []; window.__chunks = [];
    window.AndroidBridge = { postMessage(raw) {
      const message = JSON.parse(raw); window.__calls.push(message);
      queueMicrotask(() => {
        try {
          if (message.method === 'getPlatform') { window.__brclioResolve(message.id, { result: { platform: 'android', capabilities: {} } }); return; }
          if (message.method !== 'xhsRequest') throw new Error('Unexpected account or unrelated operation');
          const { action, input } = message.payload; let result;
          if (action === 'parsePython') result = { success: true, engine: 'python', noteId, title: 'Python 返回', content: 'Python 文案', images: [{ index: 1, url: window.__mode === 'unsafe' ? 'https://127.0.0.1/private' : image, livePhoto: true, liveVideo: null }], videos: [{ url: ordinary }], originalVideoCount: window.__mode === 'direct' ? 0 : 2, hasOriginalVideo: window.__mode !== 'direct' };
          else if (action === 'fetchNote') {
            if (window.__mode === 'blocked') throw new Error('Fixture page is blocked');
            result = { html, finalUrl: 'https://www.xiaohongshu.com/explore/' + noteId };
          } else if (action === 'beginGenerated') {
            window.__chunks = []; result = window.__mode === 'cancel-before' ? { cancelled: true } : { token: 'fixture-generated', requestId: input.requestId };
          } else if (action === 'appendGenerated') {
            if (window.__mode === 'cancel-chunk') result = { cancelled: true };
            else { window.__chunks.push(input); result = { received: input.offset + atob(input.data).length }; }
          } else if (action === 'finishGenerated') result = { ok: true, cancelled: false };
          else if (action === 'cancelTransfer') result = { ok: true, cancelled: true };
          else if (action === 'exportArchive') result = { ok: true, cancelled: false };
          else throw new Error('Unexpected fixture action: ' + action);
          window.__brclioResolve(message.id, { result });
        } catch (error) { window.__brclioResolve(message.id, { error: error.message }); }
      });
    } };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => Boolean(window.BrclioHost?.xhsRequest));
  assert.equal((await page.evaluate(() => BrclioHost.getPlatform())).platform, 'android');
  const parsedLocal = await page.evaluate(() => BrclioHost.xhsRequest('parse', { text: 'http://xhslink.com/a/fixture', engine: 'node' }));
  assert.equal(parsedLocal.engine, 'node'); assert.equal(parsedLocal.originalVideos[0].url, 'https://sns-video-bd.xhscdn.com/spectrum/fixture-original.mp4');
  assert.equal(await page.evaluate(() => __calls.some(call => call.payload?.action === 'parsePython')), false);
  report.checks.push('Default Android parse uses the real local parser and preserves declared original-video URLs.');

  const blocked = await page.evaluate(async () => { __mode = 'blocked'; return BrclioHost.xhsRequest('parse', { text: 'https://www.xiaohongshu.com/explore/' + __fixture.noteId, engine: 'python' }); });
  assert.equal(blocked.engine, 'python'); assert.equal(blocked.images.length, 1); assert.equal(blocked.videos.length, 1);
  assert.equal(blocked.originalVideos.length, 0); assert.equal(blocked.originalVideoCount, 2); assert.equal(blocked.hasOriginalVideo, true); assert.equal(blocked.originalVideoUnavailable, true);
  report.checks.push('Python routes through parsePython; a blocked supplement retains successful public media and the accurate original-video count.');
  const supplemented = await page.evaluate(async () => { __mode = 'local'; return BrclioHost.xhsRequest('parse', { text: 'https://www.xiaohongshu.com/explore/' + __fixture.noteId, engine: 'python' }); });
  assert.equal(supplemented.content, 'Python 文案'); assert.equal(supplemented.originalVideos[0].url, 'https://sns-video-bd.xhscdn.com/spectrum/fixture-original.mp4');
  assert.equal(supplemented.images[0].liveVideo.url, 'https://sns-video-bd.xhscdn.com/spectrum/fixture-original.mp4');
  assert.equal(supplemented.images[0].url, 'https://ci.xiaohongshu.com/fixture-original?imageView2/format/jpg');
  assert.equal(supplemented.originalVideoCount, 2); assert.equal(supplemented.originalVideoUnavailable, false);
  report.checks.push('A same-note local supplement restores declared original URLs and overlapping live pairs by image index/token, without replacing Python content or original images.');
  await page.evaluate(async () => { __mode = 'direct'; return BrclioHost.xhsRequest('parse', { text: __fixture.image, engine: 'python' }); });
  assert.equal(await page.evaluate(() => __calls.at(-1).payload.action), 'parsePython');
  const unsafe = await page.evaluate(async () => { __mode = 'unsafe'; const before = __calls.filter(call => call.payload?.action === 'fetchNote').length; try { await BrclioHost.xhsRequest('parse', { text: __fixture.image, engine: 'python' }); return { rejected: false }; } catch (error) { return { rejected: true, message: error.message, before, after: __calls.filter(call => call.payload?.action === 'fetchNote').length }; } });
  assert.equal(unsafe.rejected, true); assert.equal(unsafe.before, unsafe.after); assert.match(unsafe.message, /媒体地址/);
  report.checks.push('The Python choice remains Python for direct image links; unsafe returned media never reaches local supplementation or download.');

  const archive = await page.evaluate(async () => { const input = { requestId: 'selected-request', format: 'selected', note: { title: '所选素材', content: '保留文案' }, images: [{ index: 1, url: __fixture.image }, { index: 3, url: __fixture.image, liveVideo: { url: __fixture.original } }] }; await BrclioHost.xhsRequest('exportArchive', input); await BrclioHost.xhsRequest('cancelTransfer', { requestId: input.requestId }); return __calls.slice(-2).map(call => call.payload); });
  assert.equal(archive[0].input.format, 'selected'); assert.deepEqual(archive[0].input.images.map(image => image.index), [1, 3]); assert.equal(archive[1].input.requestId, 'selected-request');
  report.checks.push('Selected mixed-image ZIP and generic cancellation preserve the caller request ID and selected photo/live pair.');
  const transferred = await page.evaluate(async () => { __mode = 'local'; const source = new Uint8Array(100000); for (let index = 0; index < source.length; index++) source[index] = index % 251; const result = await BrclioHost.saveGenerated(new Blob([source], { type: 'application/zip' }), 'fixture.zip', { requestId: 'generated-request' }); const restored = __chunks.flatMap(chunk => [...atob(chunk.data)].map(char => char.charCodeAt(0))); return { result, chunks: __chunks.map(chunk => ({ offset: chunk.offset, length: atob(chunk.data).length })), equal: source.length === restored.length && source.every((value, index) => value === restored[index]), begin: __calls.filter(call => call.payload?.action === 'beginGenerated').at(-1).payload.input }; });
  assert.equal(transferred.result.cancelled, false); assert.equal(transferred.equal, true); assert.equal(transferred.begin.requestId, 'generated-request'); assert.equal(transferred.chunks.length, 3);
  report.checks.push('Actual Blob chunking preserves exact bytes, ordered offsets, and the generated-export request ID.');
  for (const mode of ['cancel-before', 'cancel-chunk']) {
    const cancelled = await page.evaluate(async mode => { __mode = mode; const before = __calls.filter(call => call.payload?.action === 'finishGenerated').length; const result = await BrclioHost.saveGenerated(new Blob(['fixture'], { type: 'application/zip' }), 'cancelled.zip', { requestId: 'cancelled-request' }); return { result, before, after: __calls.filter(call => call.payload?.action === 'finishGenerated').length }; }, mode);
    assert.equal(cancelled.result.cancelled, true); assert.equal(cancelled.before, cancelled.after);
  }
  report.checks.push('Cancellation before or during chunk transfer returns cancelled and never commits a generated document.');
  assert.deepEqual(report.errors, []); report.passed = true;
  console.log(JSON.stringify({ passed: true, checks: report.checks.length }));
} catch (error) { report.error = error.stack; throw error; }
finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); await mkdir(path.join(root, 'artifacts'), { recursive: true }); await writeFile(path.join(root, 'artifacts/xhs-android-bridge-verification.json'), JSON.stringify(report, null, 2) + '\n'); }

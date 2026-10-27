import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

// Exercise the shared download UI with delayed host operations, and decode real
// portrait/landscape clips so intrinsic media sizes can expose layout changes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'web');
const output = path.join(root, 'artifacts');
const report = { passed: false, checks: [], screenshots: [], errors: [] };
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.wasm': 'application/wasm' };
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/api/account/session') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ user: null, googleEnabled: false })); return;
    }
    if (pathname === '/fixture/api/image') {
      response.setHeader('Content-Type', 'image/png');
      response.end(await readFile(path.join(web, 'assets/avatar.png'))); return;
    }
    const target = path.resolve(web, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!target.startsWith(web + path.sep)) { response.writeHead(403); response.end(); return; }
    response.setHeader('Content-Type', mime[path.extname(target)] || 'application/octet-stream');
    response.end(await readFile(target));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser;

async function visibleInViewport(page, selector = '#xhs-transfer-panel') {
  const box = await page.locator(selector).boundingBox();
  const viewport = page.viewportSize();
  assert.ok(box && box.width > 0 && box.height > 0, `${selector} must be visible`);
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1,
    `${selector} must stay within ${JSON.stringify(viewport)}: ${JSON.stringify(box)}`);
  const sidebar = await page.locator('.app-sidebar').evaluate(element => {
    const rectangle = element.getBoundingClientRect();
    return { position: getComputedStyle(element).position, right: rectangle.right };
  });
  if (sidebar.position === 'fixed') assert.ok(box.x >= sidebar.right, `${selector} must not sit underneath the fixed sidebar`);
}
async function activeRequest(page, action) {
  return page.evaluate(action => window.__downloadCalls.filter(call => call.action === action).at(-1).input.requestId, action);
}
async function emit(page, type, requestId, fields) {
  await page.evaluate(({ type, requestId, fields }) => window.__downloadEmit({ type, state: { requestId, ...fields } }), { type, requestId, fields });
}
async function settle(page, requestId, result = { ok: true }) {
  await page.evaluate(({ requestId, result }) => window.__downloadPending.get(requestId)(result), { requestId, result });
  await page.waitForFunction(() => document.getElementById('xhs-transfer-panel').getAttribute('aria-busy') === 'false');
}
async function dismiss(page) {
  const button = page.locator('#xhs-transfer-dismiss');
  if (await button.isVisible()) await button.click();
}

try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.BRCLIO_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1060 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.route('**/xhs.js', async route => {
    const response = await route.fetch();
    // Chrome does not implement Electron's custom protocol. Keep its media
    // paths unchanged while serving a local image fixture for visual review.
    await route.fulfill({ response, body: (await response.text()).replaceAll('brclio-xhs://local/api/', '/fixture/api/') });
  });
  await page.route('**/bridge.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() + `
      window.__downloadCalls=[];window.__downloadPending=new Map();
      window.BrclioHost={...window.BrclioHost,
        getPlatform:async()=>({platform:'darwin',capabilities:{}}),
        onXhsEvent(callback){window.__downloadEmit=callback},
        async xhsRequest(action,input={}) {
          window.__downloadCalls.push({action,input});
          if(action==='loginState')return {loggedIn:false};
          if(action==='profileState')return {status:'idle',items:[]};
          if(action==='parse')return {title:'下载界面回归',content:'验证视频、原图、实况与文案下载。',
            images:[{index:1,url:'https://fixture/image.jpg'},{index:2,url:'https://fixture/live.jpg',liveVideo:{url:'https://fixture/live.mp4'}}],
            videos:[{label:'高清',url:'https://fixture/video.mp4',width:1920,height:1080}],originalVideos:[]};
          if(['saveVideo','exportArchive','saveImages','saveNote','copyImages'].includes(action))return await new Promise(resolve=>window.__downloadPending.set(input.requestId,resolve));
          if(['cancelVideo','cancelArchive','cancelTransfer'].includes(action)){window.__downloadPending.get(input.requestId)?.({ok:true,cancelled:true});return {ok:true}}
          return {ok:true};
        }
      };` });
  });
  await page.goto(url);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  await page.locator('[data-view="xhs"]').first().click();
  await page.locator('#xhs-share').fill('https://www.xiaohongshu.com/explore/' + 'a'.repeat(24));
  await page.locator('#xhs-parse').click();
  await page.locator('#xhs-note-title').filter({ hasText: '下载界面回归' }).waitFor();
  assert.equal(await page.locator('#xhs-video-preview').getAttribute('preload'), 'metadata');
  assert.equal(await page.locator('#xhs-video-preview').getAttribute('playsinline'), '');
  assert.match(await page.locator('#xhs-video-preview').getAttribute('poster'), /api\/image/);

  // Real WebM files are generated locally; no external CDN or logged-in state
  // is needed, and both intrinsic aspect ratios must retain the same frame.
  const geometry = [];
  for (const viewport of [{ width: 1440, height: 1060 }, { width: 610, height: 844 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
    await page.setViewportSize(viewport);
    for (const dimensions of [[320, 180], [180, 320]]) {
      const sizes = await page.evaluate(async ([width, height]) => {
        const video = document.getElementById('xhs-video-preview');
        video.pause(); video.removeAttribute('src'); video.load();
        const before = video.getBoundingClientRect().height;
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const draw = canvas.getContext('2d'); draw.fillStyle = '#2b7fd8'; draw.fillRect(0, 0, width, height);
        // A fixed 220ms recording can finish before a cold/headless encoder
        // emits its first frame. Request changing frames after recorder.start
        // and wait for actual media data rather than a wall-clock deadline.
        const stream = canvas.captureStream(0), track = stream.getVideoTracks()[0];
        const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' }), chunks = [];
        let timer, timeout, framesRequested = 0;
        const ready = new Promise((resolve, reject) => {
          const check = () => { if (framesRequested >= 4 && chunks.some(chunk => chunk.size > 0)) resolve(); };
          recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); check(); };
          recorder.onerror = event => reject(new Error(`WebM fixture recording failed: ${event.error?.message || 'unknown encoder error'}`));
          recorder.onstart = () => {
            const frame = () => {
              draw.fillStyle = framesRequested % 2 ? '#2b7fd8' : '#f4d758';
              draw.fillRect(0, 0, width, height); framesRequested++; track.requestFrame(); check();
            };
            frame(); timer = setInterval(frame, 40);
          };
          timeout = setTimeout(() => reject(new Error('WebM fixture did not produce encoded frames within 5 seconds.')), 5000);
        });
        const stopped = new Promise(resolve => recorder.onstop = resolve);
        try { recorder.start(80); await ready; recorder.stop(); await stopped; }
        finally { clearTimeout(timeout); clearInterval(timer); if (recorder.state === 'recording') recorder.stop(); stream.getTracks().forEach(track => track.stop()); }
        const recording = new Blob(chunks, { type: recorder.mimeType });
        const source = URL.createObjectURL(recording);
        const metadata = new Promise((resolve, reject) => {
          const deadline = setTimeout(() => reject(new Error('Recorded WebM metadata timed out.')), 5000);
          video.onloadedmetadata = () => { clearTimeout(deadline); resolve(); };
          video.onerror = () => { clearTimeout(deadline); reject(new Error(`Recorded WebM failed to decode (${width}x${height}, ${framesRequested} requested frames, ${recording.size} bytes): ${video.error?.message || 'unknown decoder error'}`)); };
        });
        video.muted = true; video.src = source; await metadata;
        const afterMetadata = video.getBoundingClientRect().height;
        await video.play(); const afterPlay = video.getBoundingClientRect().height;
        video.pause(); video.onloadedmetadata = video.onerror = null; video.removeAttribute('src'); video.load(); URL.revokeObjectURL(source);
        return { before, afterMetadata, afterPlay, intrinsicWidth: width, intrinsicHeight: height, recordedFramesRequested: framesRequested, recordedBytes: recording.size };
      }, dimensions);
      assert.ok(sizes.before >= 190, `Video must reserve a useful height before loading: ${JSON.stringify(sizes)}`);
      assert.ok(Math.abs(sizes.before - sizes.afterMetadata) < 1 && Math.abs(sizes.before - sizes.afterPlay) < 1,
        `Metadata/playback changed frame height: ${JSON.stringify(sizes)}`);
      geometry.push({ viewport, ...sizes });
    }
  }
  report.checks.push({ name: 'Real portrait and landscape metadata/playback keep the reserved preview height at desktop, 610px, 390px and 320px widths', geometry });
  await page.setViewportSize({ width: 1440, height: 1060 });
  await page.locator('#xhs-video-preview').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'xhs-download-video-frame.png') });
  report.screenshots.push('artifacts/xhs-download-video-frame.png');

  for (const viewport of [{ width: 1440, height: 1060 }, { width: 901, height: 844 }, { width: 900, height: 844 }, { width: 610, height: 844 }, { width: 601, height: 844 }, { width: 600, height: 844 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
    await page.setViewportSize(viewport);
    await page.locator('#xhs-save-video').click();
    await visibleInViewport(page);
    assert.equal(await page.locator('#xhs-video-progress').isVisible(), true);
    assert.equal(await page.locator('#xhs-video-progress').getAttribute('value'), null);
    assert.equal(await page.locator('#xhs-parse').isDisabled(), true);
    const requestId = await activeRequest(page, 'saveVideo');
    await emit(page, 'video', requestId, { receivedBytes: 1024 });
    assert.equal(await page.locator('#xhs-video-progress').getAttribute('value'), null);
    assert.match(await page.locator('#xhs-video-status').innerText(), /1024|1(?:\.0)?\s*(?:KiB|KB)/);
    await emit(page, 'video', requestId, { loadedBytes: 1024, totalBytes: 2048 });
    assert.equal(await page.locator('#xhs-video-progress').evaluate(progress => progress.value), 50);
    if (viewport.width === 320) {
      await page.screenshot({ path: path.join(output, 'xhs-download-progress-320.png') });
      report.screenshots.push('artifacts/xhs-download-progress-320.png');
    }
    const current = await page.locator('#xhs-video-status').innerText();
    await emit(page, 'video', 'older-request', { percent: 90, message: '旧视频进度' });
    assert.equal(await page.locator('#xhs-video-status').innerText(), current);
    await emit(page, 'video', requestId, { loadedBytes: 2048, totalBytes: 2048 });
    assert.equal(await page.locator('#xhs-video-progress').evaluate(progress => progress.value), 99);
    await page.locator('#xhs-cancel-video').click();
    await page.locator('#xhs-video-status').filter({ hasText: '已取消下载' }).waitFor();
    assert.equal(await page.locator('#xhs-video-progress').isHidden(), true);
    await dismiss(page);
  }
  report.checks.push('Video progress appears immediately inside every viewport; unknown totals remain indeterminate, bytes and percentages update, stale events are ignored and cancellation clears progress.');
  report.checks.push('Download panels remain within the viewport and outside the fixed sidebar at widths 600/601px and 900/901px across both navigation-layout breakpoints.');
  await page.setViewportSize({ width: 320, height: 568 });
  const longMessage = '保存文件失败：' + 'https://sns-video.xhscdn.com/下载失败素材/'.repeat(30);
  await page.locator('#xhs-save-video').click();
  await emit(page, 'video', await activeRequest(page, 'saveVideo'), { receivedBytes: 1024, message: longMessage });
  await visibleInViewport(page);
  assert.equal(await page.locator('#xhs-transfer-panel').evaluate(panel => panel.scrollHeight > panel.clientHeight), true,
    'Long progress text must scroll inside the bounded panel');
  await page.locator('#xhs-cancel-video').click();
  await page.locator('#xhs-video-status').filter({ hasText: '已取消下载' }).waitFor();
  await visibleInViewport(page);
  await dismiss(page);
  await page.locator('#xhs-save-video').click();
  await settle(page, await activeRequest(page, 'saveVideo'), { ok: false, error: longMessage });
  await visibleInViewport(page);
  await page.locator('#xhs-transfer-panel').evaluate(panel => { panel.scrollTop = panel.scrollHeight; });
  await dismiss(page);
  assert.equal(await page.locator('#xhs-transfer-panel').isHidden(), true);
  report.checks.push('At 320x568, long progress/error text scrolls within a viewport-bounded panel; cancellation and dismissal remain reachable after scrolling.');
  await page.setViewportSize({ width: 1440, height: 1060 });
  await page.locator('#xhs-save-video').click();
  const tabRequestId = await activeRequest(page, 'saveVideo');
  for (const tab of ['profile', 'live', 'note']) {
    await page.locator('#xhs-tab-' + tab).click();
    await emit(page, 'video', tabRequestId, { percent: 42, message: '跨标签下载中' });
    await visibleInViewport(page);
    assert.equal(await page.locator('#xhs-video-progress').evaluate(progress => progress.value), 42);
    assert.equal(await page.locator('#xhs-video-status').innerText(), '跨标签下载中');
  }
  await page.locator('[data-view="copy"]').first().click();
  assert.equal(await page.locator('#xhs-transfer-panel').isHidden(), true);
  await emit(page, 'video', tabRequestId, { percent: 64, message: '离开工具期间下载继续' });
  await page.locator('[data-view="xhs"]').first().click();
  await visibleInViewport(page);
  assert.equal(await page.locator('#xhs-video-progress').evaluate(progress => progress.value), 64);
  await page.locator('#xhs-cancel-video').click();
  await page.locator('#xhs-video-status').filter({ hasText: '已取消下载' }).waitFor();
  await dismiss(page);
  report.checks.push('An active video download retains its progress and cancellation control across all three XHS tabs; leaving the tool hides its panel, background progress continues and returning restores the current progress.');
  await page.locator('#xhs-save-video').click();
  await settle(page, await activeRequest(page, 'saveVideo'));
  assert.equal(await page.locator('#xhs-video-progress').evaluate(progress => progress.value), 100);
  await dismiss(page);
  await page.locator('#xhs-save-video').click();
  await settle(page, await activeRequest(page, 'saveVideo'), { ok: false, error: { message: '下载失败回归' } });
  assert.equal(await page.locator('#xhs-video-progress').isHidden(), true);
  assert.equal(await page.locator('#xhs-video-status').innerText(), '下载失败回归');
  await dismiss(page);

  for (const button of ['xhs-export-selected', 'xhs-export-images', 'xhs-export-live']) {
    await page.locator('#' + button).click();
    await visibleInViewport(page);
    const requestId = await activeRequest(page, 'exportArchive');
    assert.equal(await page.locator('#xhs-archive-progress').isVisible(), true);
    assert.equal(await page.locator('#xhs-archive-progress').getAttribute('value'), null);
    await emit(page, 'archive', requestId, { receivedBytes: 1024, completed: 1, total: 2, message: '下载并打包所选素材' });
    assert.equal(await page.locator('#xhs-archive-status').innerText(), '下载并打包所选素材');
    assert.equal(await page.locator('#xhs-archive-progress').getAttribute('value'), null);
    await emit(page, 'archive', requestId, { percent: 50, message: 'ZIP 整体进度' });
    assert.equal(await page.locator('#xhs-archive-progress').evaluate(progress => progress.value), 50);
    await emit(page, 'archive', 'older-request', { percent: 90, message: '旧 ZIP 进度' });
    assert.equal(await page.locator('#xhs-archive-status').innerText(), 'ZIP 整体进度');
    if (button === 'xhs-export-selected') {
      await page.screenshot({ path: path.join(output, 'xhs-download-zip-progress.png') });
      report.screenshots.push('artifacts/xhs-download-zip-progress.png');
      await page.locator('#xhs-cancel-archive').click();
      await page.locator('#xhs-archive-status').filter({ hasText: 'ZIP 导出已取消' }).waitFor();
      assert.equal(await page.locator('#xhs-archive-progress').isHidden(), true);
    } else {
      await settle(page, requestId);
      assert.equal(await page.locator('#xhs-archive-progress').evaluate(progress => progress.value), 100);
    }
    await dismiss(page);
  }
  report.checks.push('Selected-media, images/text and Live Photo ZIP exports display progress immediately, process matching events, ignore stale ZIP events, and complete or cancel accurately.');
  await page.locator('#xhs-export-images').click();
  await settle(page, await activeRequest(page, 'exportArchive'), { ok: false, error: 'ZIP 失败回归' });
  assert.equal(await page.locator('#xhs-archive-progress').isHidden(), true);
  assert.equal(await page.locator('#xhs-archive-status').innerText(), 'ZIP 失败回归');
  await dismiss(page);

  for (const [button, action, type] of [['xhs-save-images', 'saveImages', 'transfer'], ['xhs-save-note', 'saveNote', 'transfer'], ['xhs-copy-images', 'copyImages', 'clipboard']]) {
    await page.locator('#' + button).click();
    await visibleInViewport(page);
    const requestId = await activeRequest(page, action);
    assert.equal(await page.locator('#xhs-transfer-progress').isVisible(), true);
    await emit(page, type, requestId, { loadedBytes: 2048, totalBytes: 2048, completed: 1, total: 2, message: '正在下载第 1 / 2 个文件' });
    assert.equal(await page.locator('#xhs-transfer-progress').getAttribute('value'), null, 'A single file cannot establish the whole batch byte percentage');
    await emit(page, type, 'older-request', { percent: 90, message: '旧素材进度' });
    assert.equal(await page.locator('#xhs-transfer-status').innerText(), '正在下载第 1 / 2 个文件');
    await page.locator('#xhs-transfer-cancel').click();
    await page.locator('#xhs-transfer-status').filter({ hasText: '素材处理已取消' }).waitFor();
    assert.equal(await page.locator('#xhs-transfer-progress').isHidden(), true);
    await dismiss(page);
    await page.locator('#' + button).click();
    await settle(page, await activeRequest(page, action));
    assert.equal(await page.locator('#xhs-transfer-progress').evaluate(progress => progress.value), 100);
    await dismiss(page);
  }
  report.checks.push('Original-image saving, whole-note saving and clipboard downloads all expose progress, preserve batch semantics and mutual exclusion, and show 100% only on successful native completion.');
  await page.locator('#xhs-save-images').click();
  await settle(page, await activeRequest(page, 'saveImages'), { ok: false, error: '素材失败回归' });
  assert.equal(await page.locator('#xhs-transfer-progress').isHidden(), true);
  assert.equal(await page.locator('#xhs-transfer-status').innerText(), '素材失败回归');
  await dismiss(page);

  await page.locator('#xhs-tab-profile').click();
  await emit(page, 'profile', '', { status: 'discovering', discovered: 2, completed: 0, items: [] });
  assert.equal(await page.locator('#xhs-profile-progress').isVisible(), true);
  assert.equal(await page.locator('#xhs-profile-progress').getAttribute('value'), null);
  await emit(page, 'profile', '', { status: 'downloading', discovered: 2, completed: 1, items: [] });
  assert.equal(await page.locator('#xhs-profile-progress').evaluate(progress => progress.value), 50);
  await emit(page, 'profile', '', { status: 'completed', discovered: 2, completed: 2, items: [] });
  assert.equal(await page.locator('#xhs-profile-progress').evaluate(progress => progress.value), 100);
  report.checks.push('Profile discovery has indeterminate progress; downloading shows handled/discovered note counts and completed queues reach 100%.');
  await page.locator('#xhs-tab-note').click();

  // Browser/system Blob downloads have no observable destination write. They
  // report handoff explicitly instead of asserting that a file was saved.
  async function checkGeneratedExport(button, suffix) {
    const pending = page.waitForEvent('download');
    await page.locator(button).click();
    const download = await pending;
    assert.match(download.suggestedFilename(), suffix);
    await page.waitForFunction(() => document.getElementById('xhs-transfer-progress').value === 100);
    await visibleInViewport(page);
    assert.match(await page.locator('#xhs-transfer-status').innerText(), /已交给.*下载/);
    assert.doesNotMatch(await page.locator('#xhs-transfer-status').innerText(), /文件已保存/);
    await download.delete(); await dismiss(page);
  }
  await checkGeneratedExport('#xhs-export-content', /\.txt$/);
  await page.locator('#xhs-tab-live').click();
  await page.locator('#xhs-live-support').filter({ hasText: '支持本地制作' }).waitFor();
  await page.locator('#xhs-live-files').setInputFiles(path.join(web, 'assets/avatar.png'));
  await page.locator('#xhs-live-source-info').filter({ hasText: '1 张图片' }).waitFor();
  await page.locator('#xhs-live-format').selectOption('jpeg');
  await page.locator('#xhs-live-duration').fill('.5');
  await page.locator('#xhs-live-duration').dispatchEvent('change');
  await page.locator('#xhs-live-generate').click();
  await page.locator('#xhs-live-result').waitFor({ timeout: 60000 });
  for (const [kind, suffix] of [['package', /\.zip$/], ['pair', /配对文件\.zip$/], ['photo', /\.JPG$/], ['mov', /\.MOV$/]]) {
    await checkGeneratedExport('#xhs-live-export-' + kind, suffix);
  }
  report.checks.push('TXT, PVT ZIP, paired ZIP, JPG and MOV exports retain the progress panel and report system-download handoff without claiming an unobservable saved destination.');
  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.failure = error.stack; throw error;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(output, 'xhs-download-ui-verification.json'), JSON.stringify(report, null, 2) + '\n');
}

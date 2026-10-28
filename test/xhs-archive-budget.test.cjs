'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const MiB = 1024 ** 2;
const imageUrl = 'https://ci.xiaohongshu.com/archive-budget?imageView2/format/jpg';
const videoUrl = 'https://sns-video-bd.xhscdn.com/spectrum/archive-budget.mp4';
const backupUrl = 'https://sns-video-qc.xhscdn.com/spectrum/archive-budget.mp4';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const imageResponse = () => new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });

async function fixture(t, fetchImpl) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-xhs-budget-')));
  const { createXhsService } = await import('../desktop/xhs/index.mjs');
  const target = path.join(directory, 'archive.zip');
  const service = await createXhsService({
    app: { getPath: () => directory, getAppPath: () => path.resolve(__dirname, '..'), isPackaged: true },
    session: { fromPartition: () => ({}) }, BrowserWindow: class {},
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: target }) },
    clipboard: { readText: () => '' }, shell: { openPath: async () => '' }, fetchImpl,
  });
  t.after(async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const exportImages = (images, format = 'selected', input = {}) => service.request('exportArchive', { note: { title: '共享预算', content: '正文' }, images, format, ...input });
  return { directory, target, exportImages, service };
}

async function zipEntryHeaders(filename) {
  const handle = await fs.open(filename, 'r');
  const result = [];
  try {
    let offset = 0;
    while (true) {
      const header = Buffer.alloc(30); await handle.read(header, 0, 30, offset);
      if (header.readUInt32LE(0) !== 0x04034b50) break;
      const nameSize = header.readUInt16LE(26), extraSize = header.readUInt16LE(28), size = header.readUInt32LE(18);
      const name = Buffer.alloc(nameSize); await handle.read(name, 0, nameSize, offset + 30);
      result.push({ name: name.toString('utf8'), size });
      offset += 30 + nameSize + extraSize + size;
    }
  } finally { await handle.close(); }
  return result;
}

test('ZIP accepts a single original above 64 MiB within the source desktop shared budget', async t => {
  const size = 65 * MiB;
  const block = Buffer.alloc(MiB);
  const f = await fixture(t, async () => {
    let offset = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (!offset) { controller.enqueue(png); offset += png.length; return; }
        if (offset >= size) { controller.close(); return; }
        const length = Math.min(block.length, size - offset);
        controller.enqueue(block.subarray(0, length)); offset += length;
      },
    }), { headers: { 'content-type': 'image/png', 'content-length': String(size) } });
  });
  const result = await f.exportImages([{ index: 1, url: imageUrl }], 'images');
  assert.equal(result.ok, true); assert.equal(result.count, 1);
  const entries = await zipEntryHeaders(f.target);
  assert.deepEqual(entries.map(entry => entry.name), ['笔记.txt', '001-共享预算.png']);
  assert.equal(entries[1].size, size);
  assert.ok(result.bytes > size && result.bytes < 256 * MiB);
});

test('ZIP accepts a live clip declared above 128 MiB and preserves backup URL fallback', async t => {
  const { mp4Fixture } = await import('../desktop/xhs/test/fixtures/mp4.js');
  const clip = mp4Fixture({ audio: false }); const calls = [];
  const f = await fixture(t, async url => {
    calls.push(url);
    if (url === imageUrl) return imageResponse();
    if (url === videoUrl) return new Response(null, { status: 503 });
    assert.equal(url, backupUrl);
    return new Response(clip, { headers: { 'content-type': 'video/mp4', 'content-length': String(clip.length) } });
  });
  const result = await f.exportImages([{ index: 1, url: imageUrl, livePhoto: true,
    liveVideo: { url: videoUrl, backupUrls: [videoUrl, backupUrl, backupUrl], size: 129 * MiB } }]);
  assert.equal(result.ok, true); assert.equal(result.count, 2);
  assert.deepEqual(calls, [imageUrl, videoUrl, backupUrl, backupUrl], 'source meta probe precedes its successful chunk');
  assert.deepEqual((await zipEntryHeaders(f.target)).map(entry => entry.name), ['笔记.txt', '001-共享预算.png', '001-共享预算.mp4']);
});

test('ZIP uses the source segmented-then-direct fallback through the production handlers', async t => {
  const { mp4Fixture } = await import('../desktop/xhs/test/fixtures/mp4.js');
  const clip = mp4Fixture({ audio: false }), calls = [];
  const f = await fixture(t, async (url, options) => {
    const range = new Headers(options?.headers).get('range');
    calls.push({ url, range });
    if (url === imageUrl) return imageResponse();
    if (range || url === videoUrl) return new Response(null, { status: 503 });
    assert.equal(url, backupUrl);
    return new Response(clip, { headers: { 'content-type': 'video/mp4', 'content-length': String(clip.length) } });
  });
  const result = await f.exportImages([{ index: 1, url: imageUrl, livePhoto: true,
    liveVideo: { url: videoUrl, backupUrls: [backupUrl] } }]);
  assert.equal(result.count, 2); assert.equal(result.failedCount, 0);
  assert.deepEqual(calls, [{ url: imageUrl, range: null }, { url: videoUrl, range: 'bytes=0-0' },
    { url: backupUrl, range: 'bytes=0-0' }, { url: videoUrl, range: null }, { url: backupUrl, range: null }]);
  const archive = await fs.readFile(f.target);
  assert.ok(archive.includes(clip), 'the valid direct backup bytes are retained in the ZIP');
});

test('a Python-parsed archive routes the source image request through the local Python engine', async t => {
  const { PythonBackend } = await import('../desktop/xhs/desktop/python-backend.js');
  const originalInitialize = PythonBackend.prototype.initialize, originalRequest = PythonBackend.prototype.request;
  const calls = [];
  PythonBackend.prototype.initialize = async () => true;
  PythonBackend.prototype.request = async (request, signal) => { calls.push(request); assert.ok(signal); return imageResponse(); };
  t.after(() => { PythonBackend.prototype.initialize = originalInitialize; PythonBackend.prototype.request = originalRequest; });
  const f = await fixture(t, async () => { throw new Error('Node transport cannot substitute for the selected Python engine'); });
  const result = await f.exportImages([{ index: 1, url: imageUrl }], 'images', { note: { title: 'Python', engine: 'python' } });
  assert.equal(result.count, 1);
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].path, '/api/python_image?token=archive-budget');
});

test('ZIP never turns a partial CDN image into a successful complete original', async t => {
  for (const [label, status, direct] of [['partial proxy', 206, false], ['range header with 200', 200, false], ['partial direct fallback', 206, true]]) {
    await t.test(label, async t => {
      let calls = 0;
      const f = await fixture(t, async () => {
        calls++;
        if (direct && calls === 1) return new Response(png, { headers: { 'content-type': 'image/png', 'content-length': '4200001' } });
        return new Response(png.subarray(0, 33), { status, headers: { 'content-type': 'image/png', 'content-length': '33', 'content-range': `bytes 0-32/${png.length}` } });
      });
      await fs.writeFile(f.target, 'existing archive');
      await assert.rejects(f.exportImages([{ index: 1, url: imageUrl }], 'images'), error => error.code === 'ARCHIVE_ALL_MEDIA_FAILED');
      assert.equal(calls, direct ? 2 : 1);
      assert.equal(await fs.readFile(f.target, 'utf8'), 'existing archive');
      assert.deepEqual((await fs.readdir(f.directory)).sort(), ['archive.zip', 'xhs']);
    });
  }
});

test('ZIP preflight sums all declared live clips against one budget before downloading', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return imageResponse(); });
  await fs.writeFile(f.target, 'existing archive');
  await assert.rejects(f.exportImages([1, 2, 3].map(index => ({ index, url: imageUrl,
    liveVideo: { url: videoUrl, size: 100 * MiB } }))), { name: 'ArchiveSizeLimitError' });
  assert.equal(calls, 0); assert.equal(await fs.readFile(f.target, 'utf8'), 'existing archive');
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['archive.zip', 'xhs']);
});

test('ZIP shared budget reserves source header allowance and includes note text', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return imageResponse(); });
  await assert.rejects(f.exportImages([{ index: 1, url: imageUrl,
    liveVideo: { url: videoUrl, size: 256 * MiB - 256 * 1024 } }]), { name: 'ArchiveSizeLimitError' });
  assert.equal(calls, 0);
});

test('ZIP rejects an actual oversized response without replacing an existing archive', async t => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(256 * MiB) } });
  });
  await fs.writeFile(f.target, 'existing archive');
  await assert.rejects(f.exportImages([{ index: 1, url: imageUrl }], 'images'), { name: 'ArchiveSizeLimitError' });
  assert.equal(calls, 2, 'source image proxy returns 413 before the bounded direct fallback'); assert.equal(await fs.readFile(f.target, 'utf8'), 'existing archive');
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['archive.zip', 'xhs']);
});

test('ZIP continues after an image failure, omits its orphan live clip and reports each omitted asset', async t => {
  const failedImage = imageUrl.replace('archive-budget?', 'archive-budget-failure?'), calls = [];
  const f = await fixture(t, async url => {
    calls.push(url);
    return url === failedImage ? new Response(null, { status: 503 }) : imageResponse();
  });
  const result = await f.exportImages([
    { index: 1, url: failedImage, livePhoto: true, liveVideo: { url: videoUrl } },
    { index: 2, url: imageUrl },
  ]);
  assert.equal(result.ok, true); assert.equal(result.count, 1); assert.equal(result.total, 3); assert.equal(result.failedCount, 2);
  assert.deepEqual(result.failures.map(({ index, kind }) => ({ index, kind })), [{ index: 1, kind: 'image' }, { index: 1, kind: 'video' }]);
  assert.match(result.failures[0].message, /503/); assert.match(result.failures[1].message, /孤立/);
  assert.deepEqual(calls, [failedImage, imageUrl]);
  assert.deepEqual((await zipEntryHeaders(f.target)).map(entry => entry.name), ['笔记.txt', '002-共享预算.png']);
});

test('ZIP keeps an original whose paired clip failed and continues to later media', async t => {
  const calls = [];
  const f = await fixture(t, async url => {
    calls.push(url);
    return url === videoUrl || url === backupUrl ? new Response(null, { status: 503 }) : imageResponse();
  });
  const result = await f.exportImages([
    { index: 1, url: imageUrl, livePhoto: true, liveVideo: { url: videoUrl, backupUrls: [backupUrl] } },
    { index: 2, url: imageUrl },
  ]);
  assert.equal(result.count, 2); assert.equal(result.total, 3); assert.equal(result.failedCount, 1);
  assert.equal(result.failures[0].kind, 'video'); assert.equal(result.failures[0].index, 1);
  assert.deepEqual(calls, [imageUrl, videoUrl, backupUrl, videoUrl, backupUrl, imageUrl], 'source tries all chunk candidates before all direct candidates');
  assert.deepEqual((await zipEntryHeaders(f.target)).map(entry => entry.name), ['笔记.txt', '001-共享预算.png', '002-共享预算.png']);
});

test('ZIP with no successful media rejects after trying later images and never exports only text', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return new Response(null, { status: 503 }); });
  await fs.writeFile(f.target, 'existing archive');
  await assert.rejects(f.exportImages([{ index: 1, url: imageUrl }, { index: 2, url: imageUrl }], 'images'),
    error => error.code === 'ARCHIVE_ALL_MEDIA_FAILED' && error.failures.length === 2 && /所有图片均下载失败/.test(error.message));
  assert.equal(calls, 2); assert.equal(await fs.readFile(f.target, 'utf8'), 'existing archive');
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['archive.zip', 'xhs']);
});

test('ZIP cancellation after a successful asset stops the loop and preserves the existing archive', async t => {
  let begin; const began = new Promise(resolve => { begin = resolve; }); let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    if (calls === 1) return imageResponse();
    begin(); return new Promise(() => {});
  });
  await fs.writeFile(f.target, 'existing archive');
  const pending = f.exportImages([1, 2, 3].map(index => ({ index, url: imageUrl })), 'images', { requestId: 'cancel-partial' });
  await began; await f.service.request('cancelArchive', { requestId: 'cancel-partial' });
  assert.equal((await pending).cancelled, true); assert.equal(calls, 2);
  assert.equal(await fs.readFile(f.target, 'utf8'), 'existing archive');
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['archive.zip', 'xhs']);
});

test('ZIP budget overflow after a successful asset aborts immediately without partial publication', async t => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return calls === 1 ? imageResponse() : new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(256 * MiB) } });
  });
  await fs.writeFile(f.target, 'existing archive');
  await assert.rejects(f.exportImages([1, 2, 3].map(index => ({ index, url: imageUrl })), 'images'), { name: 'ArchiveSizeLimitError' });
  assert.equal(calls, 3, 'the second asset crosses the image proxy limit then the shared direct-read budget'); assert.equal(await fs.readFile(f.target, 'utf8'), 'existing archive');
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['archive.zip', 'xhs']);
});

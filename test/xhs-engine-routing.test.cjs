'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const imageUrl = 'https://ci.xiaohongshu.com/engine-routing?imageView2/format/jpg';
const videoUrl = 'https://sns-video-bd.xhscdn.com/spectrum/engine-routing.mp4';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const imageResponse = () => new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
const image = { index: 1, url: imageUrl };

async function fixture(t, { fetchImpl = async () => { throw new Error('Unexpected Node media request'); }, initialize = async () => true,
  pythonRequest = async () => { throw new Error('Unexpected Python request'); } } = {}) {
  const { PythonBackend } = await import('../desktop/xhs/desktop/python-backend.js');
  const originalInitialize = PythonBackend.prototype.initialize, originalRequest = PythonBackend.prototype.request;
  PythonBackend.prototype.initialize = initialize; PythonBackend.prototype.request = pythonRequest;
  const { createXhsService } = await import('../desktop/xhs/index.mjs');
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-xhs-engine-')));
  const output = path.join(directory, 'downloads'); await fs.mkdir(output);
  const archive = path.join(output, 'archive.zip'); let dialogCalls = 0;
  const service = await createXhsService({
    app: { getPath: name => name === 'downloads' ? output : directory, getAppPath: () => path.resolve(__dirname, '..'), isPackaged: true },
    session: { fromPartition: () => ({}) }, BrowserWindow: class { constructor() { throw new Error('Download must not reparse or open a browser'); } },
    dialog: { showOpenDialog: async () => { dialogCalls++; return { canceled: false, filePaths: [output] }; },
      showSaveDialog: async () => { dialogCalls++; return { canceled: false, filePath: archive }; } }, fetchImpl,
  });
  t.after(async () => {
    await service.close(); PythonBackend.prototype.initialize = originalInitialize; PythonBackend.prototype.request = originalRequest;
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { service, output, archive, dialogCalls: () => dialogCalls };
}

test('current Python selection overrides a Node-parsed note for ZIP images and live video metadata/chunks without reparsing', async t => {
  const { mp4Fixture } = await import('../desktop/xhs/test/fixtures/mp4.js'); const clip = mp4Fixture({ audio: false });
  const calls = [];
  const f = await fixture(t, { pythonRequest: async (request, signal) => {
    assert.ok(signal instanceof AbortSignal); assert.equal(request.method, 'GET'); calls.push(request.path);
    const route = new URL(request.path, 'http://localhost');
    if (route.pathname === '/api/python_image') return imageResponse();
    assert.equal(route.pathname, '/api/python_video'); assert.equal(route.searchParams.get('url'), videoUrl);
    if (route.searchParams.get('action') === 'meta') return Response.json({ size: clip.length, chunkSize: 3500000, contentType: 'video/mp4' });
    assert.equal(route.searchParams.get('action'), 'chunk');
    assert.equal(route.searchParams.get('start'), '0'); assert.equal(route.searchParams.get('end'), String(clip.length - 1));
    return new Response(clip, { headers: { 'content-type': 'video/mp4', 'content-length': String(clip.length) } });
  } });
  const result = await f.service.request('exportArchive', { engine: 'python', note: { title: '改选 Python', engine: 'node' },
    images: [{ ...image, livePhoto: true, liveVideo: { url: videoUrl } }], format: 'live' });
  assert.equal(result.count, 2); assert.equal(calls.length, 3); assert.equal(calls[0], '/api/python_image?token=engine-routing');
  const bytes = await fs.readFile(result.path); assert.ok(bytes.includes(png)); assert.ok(bytes.includes(clip));
});

test('current Node selection overrides a Python-parsed note without initializing Python', async t => {
  let nodeCalls = 0;
  const f = await fixture(t, { initialize: async () => { throw new Error('Python must not initialize'); },
    fetchImpl: async url => { assert.equal(url, imageUrl); nodeCalls++; return imageResponse(); } });
  const result = await f.service.request('exportArchive', { engine: 'node', note: { title: '改选 Node', engine: 'python' }, images: [image], format: 'images' });
  assert.equal(result.count, 1); assert.equal(nodeCalls, 1);
  assert.ok((await fs.readFile(result.path)).includes(png));
});

test('saveImages and saveNote use the selected image engine while saveNote video keeps its native path', async t => {
  const { mp4Fixture } = await import('../desktop/xhs/test/fixtures/mp4.js'); const clip = mp4Fixture({ audio: true });
  let pythonCalls = 0, nativeCalls = 0;
  const f = await fixture(t, { pythonRequest: async request => { assert.equal(request.path, '/api/python_image?token=engine-routing'); pythonCalls++; return imageResponse(); },
    fetchImpl: async url => { assert.equal(url, videoUrl); nativeCalls++; return new Response(clip, { headers: { 'content-type': 'video/mp4' } }); } });
  const single = await f.service.request('saveImages', { title: '原图', images: [image], engine: 'python' });
  assert.equal(single.count, 1); assert.deepEqual(await fs.readFile(path.join(single.path, single.files[0].name)), png);
  const whole = await f.service.request('saveNote', { engine: 'python', note: { title: '整篇', engine: 'node', images: [image],
    originalVideos: [{ url: videoUrl, hasAudio: true }] }, format: 'all' });
  assert.equal(whole.count, 2); assert.equal(pythonCalls, 2); assert.equal(nativeCalls, 1);
  const data = JSON.parse(await fs.readFile(path.join(whole.path, '笔记.json'), 'utf8'));
  assert.equal(data.engine, 'node', 'changing the download engine does not rewrite the parse metadata');
});

test('single Python image falls back directly only for HTTP 413', async t => {
  let status = 413, directCalls = 0;
  const f = await fixture(t, { pythonRequest: async () => Response.json({ message: 'Python response failed' }, { status }),
    fetchImpl: async url => { assert.equal(url, imageUrl); directCalls++; return imageResponse(); } });
  const result = await f.service.request('saveImages', { title: '直链回退', images: [image], engine: 'python' });
  assert.deepEqual(await fs.readFile(path.join(result.path, result.files[0].name)), png); assert.equal(directCalls, 1);
  status = 502;
  await assert.rejects(f.service.request('saveImages', { title: '禁止静默切换', images: [image], engine: 'python' }), /Python response failed/);
  assert.equal(directCalls, 1);
});

test('cancelling during optional Python initialization returns immediately and releases the transfer guard', async t => {
  let start, complete, requests = 0;
  const started = new Promise(resolve => { start = resolve; });
  const initialization = new Promise(resolve => { complete = resolve; });
  const f = await fixture(t, { initialize: () => { start(); return initialization; }, pythonRequest: async () => { requests++; return imageResponse(); } });
  const pending = f.service.request('saveImages', { requestId: 'initializing', title: '取消初始化', images: [image], engine: 'python' });
  await started; await f.service.request('cancelTransfer', { requestId: 'initializing' });
  assert.equal((await pending).cancelled, true); assert.equal(f.service.isBusy(), false);
  complete(true); await new Promise(resolve => setImmediate(resolve)); assert.equal(requests, 0);
  for (const folder of await fs.readdir(f.output)) assert.deepEqual(await fs.readdir(path.join(f.output, folder)), []);
});

test('cancelling an unresponsive Python ZIP request preserves the existing archive and cancels late response bytes', async t => {
  let start, respond, requestSignal, bodyCancelled = false;
  const started = new Promise(resolve => { start = resolve; });
  const f = await fixture(t, { pythonRequest: (_request, signal) => { requestSignal = signal; start(); return new Promise(resolve => { respond = resolve; }); } });
  await fs.writeFile(f.archive, 'existing archive');
  const pending = f.service.request('exportArchive', { requestId: 'python-zip', engine: 'python', note: { title: '取消 ZIP', engine: 'node' }, images: [image], format: 'images' });
  await started; await f.service.request('cancelArchive', { requestId: 'python-zip' });
  assert.equal((await pending).cancelled, true); assert.equal(requestSignal.aborted, true); assert.equal(f.service.isBusy(), false);
  assert.equal(await fs.readFile(f.archive, 'utf8'), 'existing archive'); assert.deepEqual(await fs.readdir(f.output), ['archive.zip']);
  respond(new Response(new ReadableStream({ cancel() { bodyCancelled = true; } })));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(bodyCancelled, true);
});

test('invalid current download engine is rejected before dialogs or media requests', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.request('saveImages', { images: [image], engine: 'unsupported' }), /下载引擎无效/);
  await assert.rejects(f.service.request('exportArchive', { note: {}, images: [image], format: 'images', engine: 'unsupported' }), /下载引擎无效/);
  assert.equal(f.dialogCalls(), 0); assert.equal(f.service.isBusy(), false);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const noteId = 'abcdef1234567890abcdef12';
const imageUrl = 'https://ci.xiaohongshu.com/fixture-image?imageView2/format/jpg';
const originalUrl = 'https://sns-video-bd.xhscdn.com/spectrum/fixture-original.mp4';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
function imageResponse() { return new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } }); }
async function temporary(t) { const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-xhs-'))); t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory; }

async function serviceFixture(t, { fetchImpl = async () => imageResponse(), saveDialog, openDialog, onEvent, clipboardWriters } = {}) {
  const directory = await temporary(t), output = path.join(directory, 'downloads'); await fs.mkdir(output);
  const { createXhsService } = await import('../desktop/xhs/index.mjs');
  let windows = 0;
  const service = await createXhsService({
    app: { getPath: name => name === 'downloads' ? output : directory, getAppPath: () => path.resolve(__dirname, '..'), isPackaged: true },
    session: { fromPartition: () => ({}) }, BrowserWindow: class { constructor() { windows++; throw new Error('Unexpected browser creation'); } },
    dialog: { showOpenDialog: openDialog || (async () => ({ canceled: false, filePaths: [output] })),
      showSaveDialog: saveDialog || (async () => ({ canceled: false, filePath: path.join(output, 'archive.zip') })) },
    clipboard: { readText: () => '' }, shell: { openPath: async () => '' }, fetchImpl, onEvent, clipboardWriters,
  });
  t.after(() => service.close());
  return { service, output, directory, windowCount: () => windows };
}

function zipEntries(bytes) {
  const entries = new Map(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0, 'archive uses inspectable Store entries');
    const size = bytes.readUInt32LE(offset + 18), nameSize = bytes.readUInt16LE(offset + 26), extraSize = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameSize).toString('utf8');
    const dataOffset = offset + 30 + nameSize + extraSize;
    entries.set(name, bytes.subarray(dataOffset, dataOffset + size)); offset = dataOffset + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50, 'archive has a central directory'); return entries;
}

test('XHS native parse returns declared originals without an account gate, and excludes unrelated recommended media', async () => {
  const { createParseHandler } = await import('../desktop/xhs/api/parse.js');
  const { invokeHandler } = await import('../desktop/xhs/index.mjs');
  const unrelated = 'https://sns-video-bd.xhscdn.com/spectrum/unrelated.mp4';
  const value = { note: { noteDetailMap: {
    [noteId]: { note: { noteId, title: '原视频', desc: '正文', video: { consumer: { originVideoKey: originalUrl } } } },
    aaaaaaaaaaaaaaaaaaaaaaaa: { note: { noteId: 'aaaaaaaaaaaaaaaaaaaaaaaa', video: { consumer: { originVideoKey: unrelated } } } },
  } } };
  const handler = createParseHandler({ fetchPage: async () => ({ finalUrl: `https://www.xiaohongshu.com/explore/${noteId}`,
    html: `<script>window.__INITIAL_STATE__=${JSON.stringify(value)}</script>` }), onError: () => {} });
  const response = await invokeHandler(handler, { method: 'POST', body: JSON.stringify({ text: `https://www.xiaohongshu.com/explore/${noteId}` }) });
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.originalVideos[0].url, originalUrl);
  assert.equal(result.originalVideos[0].sourceWatermark, 'unknown');
  assert.equal(result.noteId, noteId); assert.equal(result.title, '原视频');
  assert.ok(!JSON.stringify(result).includes(unrelated));
});

test('media proxy rejects private hosts and validates redirect targets before connecting', async () => {
  const { fetchMedia } = await import('../desktop/xhs/index.mjs');
  let calls = 0;
  await assert.rejects(fetchMedia('http://127.0.0.1/private', { kind: 'image', fetchImpl: async () => { calls++; } }), /小红书 CDN/);
  assert.equal(calls, 0);
  await assert.rejects(fetchMedia(imageUrl, { kind: 'image', fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }); } }), /小红书 CDN/);
  assert.equal(calls, 1);
  const response = await fetchMedia(originalUrl, { kind: 'video', fetchImpl: async () => new Response('video', { headers: { 'content-type': 'video/mp4' } }) });
  assert.equal(await response.text(), 'video');
});

test('service isolates storage, requires an OS-approved directory, and gives custom protocol responses CORS', async t => {
  const directory = await temporary(t); const output = path.join(directory, 'downloads'); await fs.mkdir(output);
  const { createXhsService } = await import('../desktop/xhs/index.mjs');
  const accountFile = path.join(directory, 'account.json'); await fs.writeFile(accountFile, '{"existing":"account"}');
  const partitions = [];
  const service = await createXhsService({
    app: { getPath: name => name === 'downloads' ? output : directory, getAppPath: () => path.resolve(__dirname, '..'), isPackaged: true },
    session: { fromPartition: name => { partitions.push(name); return {}; } }, BrowserWindow: class {},
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [output] }) },
    clipboard: { readText: () => 'fixture clipboard' }, shell: { openPath: async () => '' }, fetchImpl: async () => imageResponse(),
  });
  t.after(() => service.close());
  await assert.rejects(service.request('saveImages', { directory: output, images: [{ index: 1, url: imageUrl }] }), /重新授权/);
  assert.equal(await service.request('chooseDirectory'), output);
  const saved = await service.request('saveImages', { directory: output, title: '图片', images: [{ index: 1, url: imageUrl }] });
  assert.equal(saved.ok, true); assert.equal(saved.count, 1);
  assert.deepEqual(await fs.readFile(path.join(saved.path, saved.files[0].name)), png);
  assert.equal(await fs.readFile(accountFile, 'utf8'), '{"existing":"account"}');
  assert.ok(partitions.every(value => value === 'persist:brclio-xhs'));
  assert.equal(await service.request('readClipboard'), 'fixture clipboard');
  const response = await service.handleProtocol(new Request(`brclio-xhs://local/api/image?url=${encodeURIComponent(imageUrl)}`));
  assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  const denied = await service.handleProtocol(new Request('brclio-xhs://other/api/image?url=https://127.0.0.1/a'));
  assert.equal(denied.status, 403); assert.equal(denied.headers.get('access-control-allow-origin'), '*');
  await assert.rejects(service.request('accountLogin'), /不支持/);
});

test('profile queue saves media and text, restores persisted jobs without fetching, and verifies before skipping', async t => {
  const directory = await temporary(t); const output = path.join(directory, 'downloads'); await fs.mkdir(output);
  const { ProfileManager } = await import('../desktop/xhs/desktop/profile-manager.js');
  let requests = 0, resolves = 0, discoveries = 0;
  const browser = {
    async *discover() { discoveries++; yield { notes: [{ id: noteId, url: `https://www.xiaohongshu.com/explore/${noteId}`, title: '笔记' }], done: true, profileName: '测试主页' }; },
    async resolveNote() { resolves++; return { title: '笔记', content: '保留文案', strategy: 'exact-initial-state', images: [{ index: 1, url: imageUrl }], videos: [] }; },
  };
  let complete;
  const finished = new Promise(resolve => { complete = resolve; });
  const manager = new ProfileManager({ stateDirectory: path.join(directory, 'state'), browser,
    fetchImpl: async () => { requests++; return imageResponse(); }, sleep: async () => {}, onUpdate: state => { if (state.status === 'completed' || state.status === 'error') complete(state); } });
  await manager.initialize();
  await manager.start({ profileUrl: 'https://www.xiaohongshu.com/user/profile/5e413a430000000001000f4c', directory: output, intervalSeconds: 3, jitterSeconds: 0 });
  const state = await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error('profile fixture timeout')), 5000))]);
  assert.equal(state.status, 'completed', state.message); assert.equal(state.completed, 1); assert.equal(requests, 1);
  const noteDirectory = path.join(output, state.items[0].directoryName);
  assert.match(await fs.readFile(path.join(noteDirectory, '笔记.txt'), 'utf8'), /保留文案/);
  await manager.shutdown();
  let finishedAgain;
  const nextFinished = new Promise(resolve => { finishedAgain = resolve; });
  const restored = new ProfileManager({ stateDirectory: path.join(directory, 'state'), browser,
    fetchImpl: async () => { requests++; return imageResponse(); }, sleep: async () => {},
    onUpdate: current => { if (current.status === 'completed' && current.skipped === 1) finishedAgain(current); } });
  await restored.initialize(); assert.equal(discoveries, 1); assert.equal(resolves, 1); assert.equal(requests, 1);
  await restored.resume();
  const verified = await Promise.race([nextFinished, new Promise((_, reject) => setTimeout(() => reject(new Error('restore fixture timeout')), 5000))]);
  assert.equal(verified.skipped, 1); assert.equal(requests, 1); assert.equal(resolves, 1);
  await restored.shutdown();
});

test('video download cancellation returns cancelled and does not publish a file', async t => {
  const directory = await temporary(t);
  const { NativeVideoDownload } = await import('../desktop/xhs/desktop/native-video-download.js');
  let began; const started = new Promise(resolve => { began = resolve; });
  const downloader = new NativeVideoDownload({ showSaveDialog: async () => ({ canceled: false, filePath: path.join(directory, 'video.mp4') }),
    fetchImpl: async (_url, options) => { began(); return new Promise((_, reject) => { options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); }); } });
  const saving = downloader.save({ requestId: 'fixture', video: { url: originalUrl } });
  await started; downloader.cancel('fixture');
  const result = await saving; assert.equal(result.cancelled, true);
  await assert.rejects(fs.stat(path.join(directory, 'video.mp4')), { code: 'ENOENT' });
  await downloader.shutdown();
});

test('a paired Live Photo keeps its video when the same URL is also a declared original source', async () => {
  const { createParseHandler } = await import('../desktop/xhs/api/parse.js');
  const { invokeHandler } = await import('../desktop/xhs/index.mjs');
  const value = { note: { noteDetailMap: { [noteId]: { note: { noteId, title: '实况',
    imageList: [{ urlDefault: imageUrl, livePhoto: true, stream: { h264: [{ masterUrl: originalUrl }] } }],
    video: { consumer: { originVideoKey: originalUrl } },
  } } } } };
  const handler = createParseHandler({ fetchPage: async () => ({ finalUrl: `https://www.xiaohongshu.com/explore/${noteId}`,
    html: `<script>window.__INITIAL_STATE__=${JSON.stringify(value)}</script>` }), onError: () => {} });
  const response = await invokeHandler(handler, { method: 'POST', body: JSON.stringify({ text: `https://www.xiaohongshu.com/explore/${noteId}` }) });
  const result = await response.json(); assert.equal(result.success, true);
  assert.equal(result.images[0].liveVideo.url, originalUrl); assert.equal(result.originalVideos[0].url, originalUrl);
});

test('ZIP export preserves selected originals, includes UTF-8 note text, and pairs silent live clips', async t => {
  const { mp4Fixture } = await import('../desktop/xhs/test/fixtures/mp4.js'); const clip = mp4Fixture({ audio: false });
  const f = await serviceFixture(t, { fetchImpl: async url => String(url).includes('spectrum')
    ? new Response(clip, { headers: { 'content-type': 'video/mp4', 'content-length': String(clip.length) } }) : imageResponse() });
  const image = { index: 3, url: imageUrl, livePhoto: true, liveVideo: { url: originalUrl } };
  const note = { title: '压缩包', content: '保留笔记正文', sourceUrl: `https://www.xiaohongshu.com/explore/${noteId}`, images: [image] };
  const saved = await f.service.request('exportArchive', { note, images: [image], format: 'live', requestId: 'live-zip' });
  assert.equal(saved.ok, true); assert.equal(saved.count, 2);
  let entries = zipEntries(await fs.readFile(saved.path));
  assert.match(entries.get('笔记.txt').toString('utf8'), /保留笔记正文/);
  assert.deepEqual(entries.get('003-压缩包.png'), png); assert.deepEqual(entries.get('003-压缩包.mp4'), clip);
  await f.service.request('exportArchive', { note, images: [image], format: 'images' });
  entries = zipEntries(await fs.readFile(saved.path)); assert.equal(entries.size, 2); assert.equal([...entries.keys()].some(name => name.endsWith('.mp4')), false);
  const ordinary = { index: 1, url: imageUrl };
  await f.service.request('exportArchive', { note, images: [ordinary, image], format: 'selected' });
  entries = zipEntries(await fs.readFile(saved.path));
  assert.equal(entries.size, 4, 'mixed ZIP includes both originals, the paired clip, and note text');
  assert.deepEqual(entries.get('001-压缩包.png'), png); assert.deepEqual(entries.get('003-压缩包.png'), png);
  assert.deepEqual(entries.get('003-压缩包.mp4'), clip);
  assert.deepEqual((await fs.readdir(f.output)), ['archive.zip']);
});

test('image saving reports its request ID, is cancellable, and releases the native busy guard', async t => {
  const events = []; let begin;
  const began = new Promise(resolve => { begin = resolve; });
  const f = await serviceFixture(t, { onEvent: event => events.push(event), fetchImpl: async () => { begin(); return new Promise(() => {}); } });
  const pending = f.service.request('saveImages', { requestId: 'selected-images', title: '取消原图', images: [{ index: 1, url: imageUrl }] });
  await began;
  assert.equal(f.service.isBusy(), true);
  assert.equal((await f.service.request('cancelTransfer', { requestId: 'other-operation' })).cancelled, false);
  assert.equal(f.service.isBusy(), true);
  assert.equal((await f.service.request('cancelTransfer', { requestId: 'selected-images' })).cancelled, true);
  assert.equal((await pending).cancelled, true);
  assert.equal(f.service.isBusy(), false);
  assert.ok(events.some(event => event.type === 'transfer' && event.state.requestId === 'selected-images'));
  const folders = await fs.readdir(f.output);
  for (const folder of folders) assert.deepEqual(await fs.readdir(path.join(f.output, folder)), [], 'cancelled download cannot publish partial media');
});

test('native image clipboard honours per-request cancellation before writing and reports request identity', async t => {
  const { NativeImageClipboard } = await import('../desktop/xhs/desktop/image-clipboard.js');
  const directory = await temporary(t), controller = new AbortController(), events = [];
  let begin; const began = new Promise(resolve => { begin = resolve; }); let writes = 0;
  const copier = new NativeImageClipboard({ directory, platform: 'darwin', onProgress: state => events.push(state),
    fetchImpl: async (_url, options) => { begin(); return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })); },
    writeFiles: async () => { writes++; }, writeImage: async () => { writes++; } });
  const pending = copier.copy({ requestId: 'copy-selected', images: [{ index: 1, url: imageUrl }] }, { signal: controller.signal });
  const rejection = assert.rejects(pending);
  await began; controller.abort(); await rejection;
  assert.equal(writes, 0); assert.equal(copier.busy, false);
  assert.ok(events.some(state => state.requestId === 'copy-selected'));
  assert.deepEqual(await fs.readdir(directory), []);
});

test('archive cancellation and size preflight preserve an existing file and leave no staging data', async t => {
  let began; const started = new Promise(resolve => { began = resolve; }); let requests = 0;
  const f = await serviceFixture(t, { fetchImpl: async () => { requests++; began(); return new Promise(() => {}); } });
  const target = path.join(f.output, 'archive.zip'); await fs.writeFile(target, 'prior archive');
  const image = { index: 1, url: imageUrl, liveVideo: { url: originalUrl, size: 129 * 1024 ** 2 } };
  await assert.rejects(f.service.request('exportArchive', { note: { title: '超限' }, images: [image], format: 'live' }), /256 MiB/);
  assert.equal(requests, 0);
  const pending = f.service.request('exportArchive', { note: { title: '取消' }, images: [image], format: 'images', requestId: 'cancel-zip' });
  await started; assert.equal((await f.service.request('cancelArchive', { requestId: 'cancel-zip' })).cancelled, true);
  assert.equal((await pending).cancelled, true); assert.equal(await fs.readFile(target, 'utf8'), 'prior archive');
  assert.deepEqual(await fs.readdir(f.output), ['archive.zip']);
});

test('archive export refuses a symlink save target before fetching any media', async t => {
  let requests = 0;
  const f = await serviceFixture(t, { fetchImpl: async () => { requests++; return imageResponse(); } });
  const outside = path.join(f.directory, 'outside.zip'); await fs.writeFile(outside, 'preserve'); await fs.symlink(outside, path.join(f.output, 'archive.zip'));
  await assert.rejects(f.service.request('exportArchive', { note: { title: '路径检查' }, images: [{ index: 1, url: imageUrl }], format: 'images' }), /符号链接|硬链接|普通文件/);
  assert.equal(requests, 0); assert.equal(await fs.readFile(outside, 'utf8'), 'preserve');
});

test('single-note export rejects silent or missing ordinary video instead of reporting a complete save', async t => {
  const f = await serviceFixture(t); const directory = await f.service.request('chooseDirectory');
  for (const note of [
    { title: '静音', type: 'video', videos: [{ url: originalUrl, hasAudio: false }] },
    { title: '缺少视频', type: 'video', videos: [] },
  ]) await assert.rejects(f.service.request('saveNote', { note, directory, format: 'all' }), /包含声音的完整视频/);
  for (const name of await fs.readdir(f.output)) assert.deepEqual(await fs.readdir(path.join(f.output, name)), []);
});

test('login status reads do not create a browser or start a network request', async t => {
  let requests = 0; const f = await serviceFixture(t, { fetchImpl: async () => { requests++; return imageResponse(); } });
  assert.equal((await f.service.request('loginState')).status, 'unknown');
  assert.equal((await f.service.request('profileState')).status, 'idle');
  assert.equal(f.windowCount(), 0); assert.equal(requests, 0);
});

test('close aborts a pending parser request even when the transport ignores AbortSignal', async t => {
  let began; const started = new Promise(resolve => { began = resolve; });
  const f = await serviceFixture(t, { fetchImpl: async () => { began(); return new Promise(() => {}); } });
  const pending = f.service.request('parse', { text: `https://www.xiaohongshu.com/explore/${noteId}` });
  const rejected = assert.rejects(pending); await started; await f.service.close(); await rejected;
});

test('close terminates a media response reader that already left the protocol handler', async t => {
  let cancelled = false;
  const f = await serviceFixture(t, { fetchImpl: async () => new Response(new ReadableStream({
    pull: () => new Promise(() => {}), cancel: () => { cancelled = true; },
  }), { headers: { 'content-type': 'video/mp4' } }) });
  const response = await f.service.handleProtocol(new Request(`brclio-xhs://local/api/video?url=${encodeURIComponent(originalUrl)}`));
  assert.equal(response.status, 200); const rejected = assert.rejects(response.arrayBuffer());
  await f.service.close(); await rejected; assert.equal(cancelled, true);
});

test('video cancellation does not wait for a native save dialog or start a late download', async t => {
  const directory = await temporary(t), { NativeVideoDownload } = await import('../desktop/xhs/desktop/native-video-download.js');
  let opened, answer, requests = 0; const dialogOpened = new Promise(resolve => { opened = resolve; });
  const download = new NativeVideoDownload({ showSaveDialog: () => { opened(); return new Promise(resolve => { answer = resolve; }); },
    fetchImpl: async () => { requests++; throw new Error('must not fetch'); } });
  const pending = download.save({ requestId: 'pending-dialog', video: { url: originalUrl } });
  await dialogOpened; download.cancel('pending-dialog');
  assert.equal((await pending).cancelled, true); await download.shutdown();
  answer({ canceled: false, filePath: path.join(directory, 'late.mp4') }); await Promise.resolve(); await Promise.resolve();
  assert.equal(requests, 0); assert.deepEqual(await fs.readdir(directory), []);
});

test('close releases pending archive and folder dialogs without publishing late choices', async t => {
  for (const action of ['exportArchive', 'chooseDirectory']) {
    let opened, answer; const dialogOpened = new Promise(resolve => { opened = resolve; });
    const dialog = () => { opened(); return new Promise(resolve => { answer = resolve; }); };
    const f = await serviceFixture(t, action === 'exportArchive' ? { saveDialog: dialog } : { openDialog: dialog });
    const pending = f.service.request(action, { note: { title: '退出' }, images: [{ index: 1, url: imageUrl }], format: 'images' });
    const outcome = action === 'exportArchive' ? pending : assert.rejects(pending);
    await dialogOpened; await f.service.close();
    if (action === 'exportArchive') assert.equal((await outcome).cancelled, true); else await outcome;
    answer({ canceled: false, filePath: path.join(f.output, 'late.zip'), filePaths: [f.output] }); await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(await fs.readdir(f.output), []);
  }
});

test('clipboard shutdown after downloads prevents a late clipboard write and removes staged images', async t => {
  const directory = await temporary(t), { NativeImageClipboard } = await import('../desktop/xhs/desktop/image-clipboard.js');
  const controller = new AbortController(); let writes = 0;
  const copy = new NativeImageClipboard({ directory, platform: 'darwin', signal: controller.signal, fetchImpl: async () => imageResponse(),
    writeImage: async () => { writes++; }, writeFiles: async () => { writes++; },
    onProgress: state => { if (state.phase === 'writing') controller.abort(); } });
  await assert.rejects(copy.copy({ images: [{ index: 1, url: imageUrl }] }), { name: 'AbortError' });
  assert.equal(writes, 0); assert.deepEqual(await fs.readdir(directory), []);
});

test('profile navigation cancellation rejects even when a stalled browser ignores stop', async () => {
  const { XhsBrowser } = await import('../desktop/xhs/desktop/profile-browser.js');
  const { EventEmitter } = require('node:events'); const controller = new AbortController(); let stopped = 0;
  const win = { isDestroyed: () => false, loadURL: () => new Promise(() => {}),
    webContents: Object.assign(new EventEmitter(), { stop: () => { stopped++; }, getURL: () => '' }) };
  const pending = new XhsBrowser().navigate(win, `https://www.xiaohongshu.com/explore/${noteId}`, controller.signal);
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(stopped, 1); assert.equal(win.webContents.listenerCount('dom-ready'), 0);
});

for (const suite of ['xhs', 'media-download', 'media-tracks', 'profile-browser', 'profile-manager', 'xhs-login-reset', 'profile-source', 'login-state']) {
  test(`ported XHS ${suite} regressions`, async t => {
    const { run } = await import(`../desktop/xhs/test/${suite}.js`);
    await run(t);
  });
}

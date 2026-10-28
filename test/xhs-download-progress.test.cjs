'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const imageUrl = 'https://ci.xiaohongshu.com/fixture-image?imageView2/format/jpg';
const videoUrl = 'https://sns-video-bd.xhscdn.com/spectrum/fixture.mp4';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

async function fixture(t, { saveDialog, openDialog } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-xhs-progress-')));
  const output = path.join(directory, 'downloads'); await fs.mkdir(output);
  const events = [], partitions = [], proxyConfigurations = [], requests = [];
  let direct = false;
  const mediaSession = {
    async setProxy(configuration) { await Promise.resolve(); proxyConfigurations.push(configuration); direct = configuration.mode === 'direct'; },
    async fetch(url) {
      assert.equal(direct, true, 'proxy isolation must finish before any XHS request');
      requests.push(url);
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(png.subarray(0, 24)); controller.enqueue(png.subarray(24)); controller.close();
      } }), { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
    },
  };
  const { createXhsService } = await import('../desktop/xhs/index.mjs');
  const service = await createXhsService({
    app: { getPath: name => name === 'downloads' ? output : directory, getAppPath: () => path.resolve(__dirname, '..'), isPackaged: true },
    session: { fromPartition(name) { partitions.push(name); return mediaSession; } }, BrowserWindow: class {},
    fetchImpl: (url, options) => mediaSession.fetch(url, options),
    dialog: { showOpenDialog: openDialog || (async () => ({ canceled: false, filePaths: [output] })),
      showSaveDialog: saveDialog || (async () => ({ canceled: false, filePath: path.join(output, 'archive.zip') })) },
    clipboard: { readText: () => '' }, shell: {}, onEvent: event => events.push(event),
  });
  t.after(async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { service, events, partitions, proxyConfigurations, requests, output };
}

test('XHS uses its own direct session and reports byte and file progress through completed folder and ZIP saves', async t => {
  const f = await fixture(t);
  const images = [{ index: 1, url: imageUrl }, { index: 2, url: imageUrl }];
  const directory = await f.service.request('chooseDirectory');
  await f.service.request('saveImages', { directory, images, title: '原图', requestId: 'folder-progress' });
  await f.service.request('exportArchive', { note: { title: '压缩包' }, images, format: 'images', requestId: 'zip-progress' });
  assert.deepEqual(f.partitions, ['persist:brclio-xhs']);
  assert.deepEqual(f.proxyConfigurations, [{ mode: 'direct' }]);
  assert.equal(f.requests.length, 4);
  for (const [type, requestId] of [['transfer', 'folder-progress'], ['archive', 'zip-progress']]) {
    const states = f.events.filter(event => event.type === type).map(event => event.state);
    assert.ok(states.every(state => state.requestId === requestId));
    assert.equal(states[0].phase, 'preparing');
    assert.ok(states.some(state => state.phase === 'downloading' && state.loadedBytes === 24 && state.totalBytes === png.length));
    assert.ok(states.some(state => state.completed === 1 && state.total === 2));
    assert.equal(states.at(-1).phase, 'saved');
    assert.equal(states.at(-1).completed, 2);
    assert.equal(states.at(-1).receivedBytes, png.length * 2);
    assert.ok(states.filter(state => state.phase !== 'saved').every(state => state.progress !== 100), 'a completed file cannot report a completed batch');
  }
  const states = f.events.filter(event => event.type === 'archive').map(event => event.state);
  assert.ok(states.some(state => state.completed === 1 && state.loadedBytes === 24 && state.receivedBytes === png.length + 24));
  assert.ok(states.findIndex(state => state.phase === 'archiving') < states.findIndex(state => state.phase === 'saved'));
});

test('video, ZIP and folder downloads emit preparing while their save dialogs are open, then cancelled without network traffic', async t => {
  for (const [action, type] of [['saveVideo', 'video'], ['exportArchive', 'archive'], ['saveImages', 'transfer']]) {
    let opened; const dialogOpened = new Promise(resolve => { opened = resolve; });
    const pendingDialog = () => { opened(); return new Promise(() => {}); };
    const f = await fixture(t, action === 'saveImages' ? { openDialog: pendingDialog } : { saveDialog: pendingDialog });
    const input = { requestId: `cancel-${type}`, video: { url: videoUrl }, note: { title: '取消' }, images: [{ index: 1, url: imageUrl }], format: 'images' };
    const pending = f.service.request(action, input);
    await dialogOpened;
    const states = () => f.events.filter(event => event.type === type).map(event => event.state);
    assert.equal(states()[0].phase, 'preparing');
    await f.service.request(action === 'saveVideo' ? 'cancelVideo' : action === 'exportArchive' ? 'cancelArchive' : 'cancelTransfer', { requestId: input.requestId });
    assert.equal((await pending).cancelled, true);
    assert.equal(states().at(-1).phase, 'cancelled');
    assert.equal(f.requests.length, 0);
    assert.equal(f.service.isBusy(), false);
  }
});

test('a video reports saved only after its validated file is published, and emits an error for a failed download', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-xhs-video-progress-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { NativeVideoDownload } = await import('../desktop/xhs/desktop/native-video-download.js');
  const { mp4Fixture } = await import('../desktop/xhs/test/fixtures/mp4.js');
  const clip = mp4Fixture({ audio: true }), target = path.join(directory, 'video.mp4'), states = [];
  let fail = false;
  const download = new NativeVideoDownload({ showSaveDialog: async () => ({ canceled: false, filePath: target }),
    fetchImpl: async () => { if (fail) throw new Error('fixture offline'); return new Response(clip, { headers: { 'content-type': 'video/mp4', 'content-length': String(clip.length) } }); },
    onProgress(state) { if (state.phase === 'saved') assert.equal(require('node:fs').existsSync(target), true); states.push(state); } });
  t.after(() => download.shutdown());
  const saved = await download.save({ requestId: 'video-saved', video: { url: videoUrl } });
  assert.equal(saved.ok, true); assert.equal(states[0].phase, 'preparing'); assert.equal(states.at(-1).phase, 'saved');
  assert.deepEqual(await fs.readFile(target), clip);
  fail = true;
  const failed = await download.save({ requestId: 'video-failed', video: { url: videoUrl } });
  assert.equal(failed.ok, false); assert.equal(states.at(-1).phase, 'error'); assert.equal(states.at(-1).requestId, 'video-failed');
  assert.deepEqual(await fs.readFile(target), clip, 'a failed retry preserves the previously published file');
});

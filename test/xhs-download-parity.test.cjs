'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const noteId = 'abcdef1234567890abcdef12';
const imageUrl = 'https://ci.xiaohongshu.com/download-parity?imageView2/format/jpg';
const videoUrl = name => `https://sns-video-bd.xhscdn.com/stream/${name}.mp4`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const response = (bytes, contentType = 'video/mp4') => new Response(bytes, { headers: { 'content-type': contentType, 'content-length': String(bytes.length) } });

async function temporary(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-download-parity-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function serviceFixture(t, fetchImpl) {
  const directory = await temporary(t), { createXhsService } = await import('../desktop/xhs/index.mjs');
  const target = path.join(directory, 'archive.zip');
  const service = await createXhsService({
    app: { getPath: () => directory, getAppPath: () => path.resolve(__dirname, '..'), isPackaged: true },
    session: { fromPartition: () => ({}) }, BrowserWindow: class {},
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [directory] }),
      showSaveDialog: async () => ({ canceled: false, filePath: target }) },
    clipboard: { readText: () => '' }, shell: { openPath: async () => '' }, fetchImpl,
  });
  t.after(() => service.close());
  return { service, directory, target };
}

test('whole-note video retries every source candidate and its backup in the original order', async t => {
  const { mp4Fixture } = await import('../desktop/xhs/test/fixtures/mp4.js');
  const clip = mp4Fixture(), calls = [];
  const f = await serviceFixture(t, async url => {
    calls.push(url);
    return url === videoUrl('alternative-backup') ? response(clip) : new Response(null, { status: 503 });
  });
  const saved = await f.service.request('saveNote', { note: { noteId, title: '备用来源', images: [], originalVideos: [
    { url: videoUrl('preferred'), isDefault: true, backupUrls: [videoUrl('preferred-backup')] },
    { url: videoUrl('alternative'), backupUrls: [videoUrl('alternative-backup')] },
  ] }, format: 'all' });
  assert.equal(saved.ok, true); assert.equal(saved.count, 1);
  assert.deepEqual(calls, ['preferred', 'alternative', 'preferred-backup', 'alternative-backup'].map(videoUrl));
  assert.deepEqual(await fs.readFile(path.join(saved.path, 'video.mp4')), clip);
});

test('whole-note source collections above twenty URLs preserve both early success and the final backup', async t => {
  const { mp4Fixture } = await import('../desktop/xhs/test/fixtures/mp4.js');
  const clip = mp4Fixture();
  const preferred = { url: videoUrl('large-preferred'), isDefault: true,
    backupUrls: Array.from({ length: 10 }, (_, index) => videoUrl(`large-preferred-backup-${index}`)) };
  const alternative = { url: videoUrl('large-alternative'),
    backupUrls: Array.from({ length: 10 }, (_, index) => videoUrl(`large-alternative-backup-${index}`)) };
  const ordered = [preferred.url, alternative.url, ...preferred.backupUrls, ...alternative.backupUrls];
  assert.equal(ordered.length, 22);
  for (const [label, successfulURL, expected] of [
    ['preferred succeeds', ordered[0], ordered.slice(0, 1)],
    ['last backup succeeds', ordered.at(-1), ordered],
  ]) {
    await t.test(label, async t => {
      const calls = [];
      const f = await serviceFixture(t, async url => {
        calls.push(url);
        return url === successfulURL ? response(clip) : new Response(null, { status: 503 });
      });
      const saved = await f.service.request('saveNote', { note: { noteId, title: '完整备用列表', images: [],
        originalVideos: [preferred, alternative] }, format: 'all' });
      assert.equal(saved.ok, true); assert.equal(saved.count, 1);
      assert.deepEqual(calls, expected);
      assert.deepEqual(await fs.readFile(path.join(saved.path, 'video.mp4')), clip);
    });
  }
});

test('live ZIP follows more than twenty source CDN candidates to the final valid segmented backup', async t => {
  const { mp4Fixture } = await import('../desktop/xhs/test/fixtures/mp4.js');
  const clip = mp4Fixture({ audio: false }), calls = [];
  const urls = Array.from({ length: 25 }, (_, index) => videoUrl(`large-live-candidate-${index}`));
  const f = await serviceFixture(t, async (url, options) => {
    const range = new Headers(options?.headers).get('range');
    calls.push({ url, range });
    if (url === imageUrl) return response(png, 'image/png');
    if (url !== urls.at(-1)) return new Response(null, { status: 503 });
    assert.ok(range, 'A valid final segmented candidate must complete before direct fallback');
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range);
    const from = Number(start), to = Number(end), bytes = clip.subarray(from, to + 1);
    return new Response(bytes, { status: 206, headers: { 'content-type': 'video/mp4',
      'content-length': String(bytes.length), 'content-range': `bytes ${from}-${to}/${clip.length}` } });
  });
  const images = [{ index: 1, url: imageUrl, livePhoto: true,
    liveVideo: { url: urls[0], backupUrls: urls.slice(1) } }];
  const saved = await f.service.request('exportArchive', { note: { title: '完整实况列表' }, images, format: 'selected' });
  assert.equal(saved.ok, true); assert.equal(saved.count, 2); assert.equal(saved.failedCount, 0);
  assert.deepEqual(calls, [{ url: imageUrl, range: null }, ...urls.map(url => ({ url, range: 'bytes=0-0' })),
    { url: urls.at(-1), range: `bytes=0-${clip.length - 1}` }]);
  assert.ok((await fs.readFile(f.target)).includes(clip), 'ZIP retains the complete silent Live Photo source bytes');
});

test('whole-note normal video retains a metadata-silent preferred candidate until its bytes are inspected', async t => {
  const { mp4Fixture } = await import('../desktop/xhs/test/fixtures/mp4.js');
  const clip = mp4Fixture(); const calls = [];
  const f = await serviceFixture(t, async url => { calls.push(url); return response(clip); });
  const saved = await f.service.request('saveNote', { note: { noteId, title: '媒体轨道', videos: [
    { url: videoUrl('metadata-silent'), isDefault: true, hasAudio: false },
  ] }, format: 'all' });
  assert.equal(saved.ok, true); assert.deepEqual(calls, [videoUrl('metadata-silent')]);
  assert.equal(saved.files[0].mediaTracks.hasAudio, true);
});

test('whole-note live pairs preserve silent MP4 bytes and try their original backup URLs', async t => {
  const { mp4Fixture } = await import('../desktop/xhs/test/fixtures/mp4.js');
  const clip = mp4Fixture({ audio: false }), calls = [];
  const f = await serviceFixture(t, async url => {
    calls.push(url);
    return url === imageUrl ? response(png, 'image/png') : url === videoUrl('live-backup') ? response(clip) : new Response(null, { status: 503 });
  });
  const saved = await f.service.request('saveNote', { note: { noteId, title: '静音实况', images: [
    { index: 1, url: imageUrl, livePhoto: true, liveVideo: { url: videoUrl('live'), backupUrls: [videoUrl('live-backup')] } },
  ] }, format: 'all' });
  assert.equal(saved.count, 2); assert.deepEqual(calls, [imageUrl, videoUrl('live'), videoUrl('live-backup')]);
  assert.deepEqual(await fs.readFile(path.join(saved.path, 'image-001.png')), png);
  assert.deepEqual(await fs.readFile(path.join(saved.path, 'live-001.mp4')), clip);
  assert.equal(saved.files[1].mediaTracks.hasAudio, false);
});

test('source image API binary MIME fallback works for previews, original saving and ZIP', async t => {
  const f = await serviceFixture(t, async () => response(png, 'application/octet-stream'));
  const preview = await f.service.handleProtocol(new Request(`brclio-xhs://local/api/image?url=${encodeURIComponent(imageUrl)}`));
  assert.equal(preview.status, 200); assert.equal(preview.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
  const images = [{ index: 1, url: imageUrl }];
  const saved = await f.service.request('saveImages', { title: '原图', images });
  assert.deepEqual(await fs.readFile(path.join(saved.path, saved.files[0].name)), png);
  const archive = await f.service.request('exportArchive', { note: { title: '原图' }, images, format: 'images' });
  assert.equal(archive.ok, true); assert.equal(archive.count, 1); assert.equal(archive.failedCount, 0);
});

test('binary image MIME fallback never saves or previews non-image bytes', async t => {
  const f = await serviceFixture(t, async () => response(Buffer.from('<html>not an image</html>'), 'application/octet-stream'));
  const preview = await f.service.handleProtocol(new Request(`brclio-xhs://local/api/image?url=${encodeURIComponent(imageUrl)}`));
  assert.equal(preview.status, 502); assert.match((await preview.json()).message, /图片格式/);
  await assert.rejects(f.service.request('saveImages', { title: '图片校验', images: [{ index: 1, url: imageUrl }] }), /不符合图片/);
  const noteDirectory = (await fs.readdir(f.directory)).find(name => name.startsWith('图片校验-'));
  assert.deepEqual(await fs.readdir(path.join(f.directory, noteDirectory)), []);
});

test('binary image sniffing preserves chunk boundaries, all bytes, and cancellation', async () => {
  const { fetchMedia } = await import('../desktop/xhs/index.mjs');
  let cancelled = false, pulls = 0;
  const original = new Response(new ReadableStream({
    pull(controller) {
      pulls++;
      if (pulls <= 40) controller.enqueue(png.subarray(pulls - 1, pulls));
      else return new Promise(() => {});
    }, cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/octet-stream' } });
  const fetched = await fetchMedia(imageUrl, { kind: 'image', fetchImpl: async () => original });
  assert.equal(fetched.headers.get('content-type'), 'image/png');
  const reader = fetched.body.getReader();
  const prefix = [];
  for (let i = 0; i < 32; i++) prefix.push((await reader.read()).value[0]);
  assert.deepEqual(Buffer.from(prefix), png.subarray(0, 32));
  await reader.cancel(); assert.equal(cancelled, true);
});

test('native source validation returns typed input errors before opening the save dialog', async t => {
  const { NativeVideoDownload } = await import('../desktop/xhs/desktop/native-video-download.js');
  let dialogs = 0, calls = 0;
  const downloader = new NativeVideoDownload({ showSaveDialog: async () => { dialogs++; return { canceled: true }; },
    fetchImpl: async () => { calls++; throw Error('must not connect'); } });
  t.after(() => downloader.shutdown());
  const valid = { requestId: 'validation', video: { url: videoUrl('valid') } };
  for (const invalid of [null, {}, { ...valid, filename: 5 }, { ...valid, title: 'x'.repeat(1001) },
    { ...valid, video: { url: 'https://attacker.example/video.mp4' } },
    { ...valid, video: { url: videoUrl('valid'), backupUrls: 'invalid' } },
    { ...valid, video: { url: videoUrl('valid'), backupUrls: Array(20).fill(videoUrl('valid')) } }]) {
    const result = await downloader.save(invalid);
    assert.equal(result.ok, false); assert.equal(result.error.code, 'VIDEO_INPUT_INVALID'); assert.equal(result.error.status, 400);
  }
  assert.equal(dialogs, 0); assert.equal(calls, 0);
  assert.deepEqual(await downloader.save(valid), { ok: true, cancelled: true });
});

test('native source progress exceptions cannot turn an actual saved video into a failed download', async t => {
  const directory = await temporary(t), { NativeVideoDownload } = await import('../desktop/xhs/desktop/native-video-download.js');
  const { mp4Fixture } = await import('../desktop/xhs/test/fixtures/mp4.js'); const clip = mp4Fixture();
  for (const asyncFailure of [false, true]) {
    const target = path.join(directory, `saved-${asyncFailure}.mp4`);
    const downloader = new NativeVideoDownload({ showSaveDialog: async () => ({ canceled: false, filePath: target }),
      fetchImpl: async () => response(clip), onProgress: () => { if (asyncFailure) return Promise.reject(Error('closed renderer')); throw Error('closed renderer'); } });
    const saved = await downloader.save({ requestId: 'progress', video: { url: videoUrl('valid') } });
    assert.equal(saved.ok, true); assert.deepEqual(await fs.readFile(target), clip);
    await downloader.shutdown();
  }
});

test('native fallback inspects real audio, resets each attempt and publishes exactly the OS-selected name', async t => {
  const directory = await temporary(t), { NativeVideoDownload } = await import('../desktop/xhs/desktop/native-video-download.js');
  const { mp4Fixture } = await import('../desktop/xhs/test/fixtures/mp4.js');
  const target = path.join(directory, 'without-extension'), events = [], calls = [];
  const downloader = new NativeVideoDownload({ showSaveDialog: async () => ({ canceled: false, filePath: target }),
    onProgress: event => events.push(event), fetchImpl: async url => { calls.push(url); return response(mp4Fixture({ audio: url === videoUrl('audible') })); } });
  t.after(() => downloader.shutdown());
  await fs.writeFile(target, 'previous complete video');
  const result = await downloader.save({ requestId: 'fallback', video: { url: videoUrl('silent'), backupUrls: [videoUrl('audible')] } });
  assert.equal(result.ok, true); assert.equal(result.path, target); assert.equal(result.mediaTracks.hasAudio, true);
  assert.deepEqual(calls, [videoUrl('silent'), videoUrl('audible')]);
  assert.deepEqual(events.filter(event => event.phase === 'downloading' && event.totalBytes === null).map(event => event.attempt), [1, 2]);
  assert.deepEqual(await fs.readFile(target), mp4Fixture());
  assert.deepEqual(await fs.readdir(directory), ['without-extension']);
});

test('profile ordinary video uses the source preferred candidate even when audio metadata is stale', async t => {
  const { ProfileManager } = await import('../desktop/xhs/desktop/profile-manager.js');
  const { mp4Fixture } = await import('../desktop/xhs/test/fixtures/mp4.js');
  for (const actualAudio of [true, false]) {
    const directory = await temporary(t), calls = [];
    const manager = new ProfileManager({ stateDirectory: path.join(directory, 'state'), sleep: async () => {},
      browser: { async *discover() { yield { done: true, notes: [{ id: noteId }] }; },
        async resolveNote() { return { strategy: 'exact-initial-state', title: '真实音轨', images: [], videos: [
          { url: videoUrl('metadata-silent'), isDefault: true, hasAudio: false },
        ] }; } },
      fetchImpl: async url => { calls.push(url); return response(mp4Fixture({ audio: actualAudio })); } });
    t.after(() => manager.shutdown());
    await manager.initialize();
    await manager.start({ profileUrl: 'https://www.xiaohongshu.com/user/profile/5e413a430000000001000f4c', directory, intervalSeconds: 3, jitterSeconds: 0 });
    const run = manager._runTask; await run;
    assert.equal(manager.state.items[0].status, actualAudio ? 'completed' : 'failed');
    assert.ok(calls.length > 0); assert.ok(calls.every(url => url === videoUrl('metadata-silent')));
    if (actualAudio) assert.equal(manager.state.items[0].files.find(file => file.key === 'video').mediaTracks.hasAudio, true);
    else assert.match(manager.state.items[0].error, /音轨|声音/);
  }
});

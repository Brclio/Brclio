import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { downloadMedia, verifyFile } from '../desktop/media-download.js';
import { mp4Fixture } from './fixtures/mp4.js';

// Adapted from the downloader regression suite; account gates are intentionally absent.
export async function run(t) {

const videoUrl = 'https://sns-video-bd.xhscdn.com/stream/video.mp4';
const MP4 = mp4Fixture();
const GIB = 1024 ** 3;

async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xhs-media-download-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return {
    directory,
    options: {
      root: directory, directory,
      asset: { key: 'video', kind: 'video', url: videoUrl, requireAudio: true },
      fetchImpl: async () => response(MP4)
    }
  };
}

function response(body, headers = {}, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'video/mp4', ...headers } });
}

await t.test('explicit video limits still apply to declared and streamed sizes; zero is unlimited', async t => {
  const f = await fixture(t);
  for (const headers of [{}, { 'content-length': String(MP4.length) }]) {
    await assert.rejects(downloadMedia({ ...f.options, maxBytes: MP4.length - 1,
      fetchImpl: async () => response(MP4, headers) }), /超过/);
    assert.deepEqual(await fs.readdir(f.directory), []);
  }
  const saved = await downloadMedia({ ...f.options, maxBytes: 0 });
  assert.equal(saved.bytes, MP4.length);
  assert.equal(await verifyFile(f.directory, f.directory, saved), true);
});

await t.test('images retain the 2 GiB default cap, and invalid limits or keys cannot start requests', async t => {
  const f = await fixture(t);
  await assert.rejects(downloadMedia({ ...f.options,
    asset: { key: 'image', kind: 'image', url: 'https://ci.xiaohongshu.com/image' },
    fetchImpl: async () => new Response(null, { headers: { 'content-type': 'image/jpeg', 'content-length': String(2 * GIB + 1) } })
  }), /2 GiB/);
  let requested = false;
  const fetchImpl = async () => { requested = true; return response(MP4); };
  for (const maxBytes of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(downloadMedia({ ...f.options, fetchImpl, maxBytes }), /大小限制/);
  }
  for (const key of ['../escape', 'nested/name', 'back\\slash', '', 'con']) {
    await assert.rejects(downloadMedia({ ...f.options, fetchImpl, asset: { ...f.options.asset, key } }), /文件名/);
  }
  assert.equal(requested, false);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

await t.test('unsafe Content-Length, overflow, truncation and unsolicited partial responses are never published', async t => {
  const f = await fixture(t);
  for (const length of ['9007199254740992', '-1', '0', '1.5', '1e3', 'NaN', '', String(MP4.length - 1), String(MP4.length + 1)]) {
    await assert.rejects(downloadMedia({ ...f.options, fetchImpl: async () => response(MP4, { 'content-length': length }) }));
    assert.deepEqual(await fs.readdir(f.directory), []);
  }
  for (const status of [200, 206]) {
    await assert.rejects(downloadMedia({ ...f.options,
      fetchImpl: async () => response(MP4, { 'content-range': `bytes 0-${MP4.length - 1}/${MP4.length * 2}` }, status)
    }), /部分内容/);
  }
  await assert.rejects(downloadMedia({ ...f.options, fetchImpl: async () => response(MP4, {}, 206) }), /部分内容/);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

await t.test('the inactivity watchdog allows a healthy transfer longer than its timeout and ignores progress callback errors', async t => {
  const f = await fixture(t);
  let offset = 0;
  const started = Date.now();
  const body = new ReadableStream({
    async pull(controller) {
      await delay(25);
      if (offset === MP4.length) { controller.close(); return; }
      const end = Math.min(offset + 24, MP4.length);
      controller.enqueue(MP4.subarray(offset, end));
      offset = end;
    }
  }, { highWaterMark: 0 });
  const saved = await downloadMedia({ ...f.options, timeoutMs: 100,
    fetchImpl: async () => response(body), onProgress() { throw Error('renderer gone'); } });
  assert.ok(Date.now() - started > 100);
  assert.equal(saved.bytes, MP4.length);
  assert.deepEqual(await fs.readFile(path.join(f.directory, saved.name)), MP4);
});

await t.test('fetches that ignore AbortSignal still time out, and late responses are cancelled', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  let finishFetch, cancelled = 0, requestSignal;
  await assert.rejects(downloadMedia({ ...f.options, timeoutMs: 20,
    fetchImpl: async (_url, options) => {
      requestSignal = options.signal;
      return new Promise(resolve => { finishFetch = resolve; });
    }
  }), { code: 'MEDIA_DOWNLOAD_TIMEOUT' });
  assert.equal(requestSignal.aborted, true);
  finishFetch(response(new ReadableStream({ cancel() { cancelled++; } })));
  await delay(0);
  assert.equal(cancelled, 1);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

await t.test('user cancellation aborts fetches that ignore AbortSignal', { timeout: 2000 }, async t => {
  const f = await fixture(t), controller = new AbortController();
  const pending = downloadMedia({ ...f.options, signal: controller.signal, fetchImpl: () => new Promise(() => {}) });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(await fs.readdir(f.directory), []);
});

await t.test('stalled readers are timed out or cancelled and cleaned even if stream cancellation never resolves', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  for (const userAbort of [false, true]) {
    const controller = new AbortController();
    let pulls = 0, cancelled = false;
    const body = new ReadableStream({
      pull(stream) {
        if (++pulls === 1) { stream.enqueue(MP4.subarray(0, 32)); return; }
        if (userAbort) setTimeout(() => controller.abort(), 5);
        return new Promise(() => {});
      },
      cancel() { cancelled = true; return new Promise(() => {}); }
    }, { highWaterMark: 0 });
    await assert.rejects(downloadMedia({ ...f.options, timeoutMs: 25, signal: controller.signal,
      fetchImpl: async () => response(body) }), userAbort ? { name: 'AbortError' } : { code: 'MEDIA_DOWNLOAD_TIMEOUT' });
    assert.equal(cancelled, true);
    assert.deepEqual(await fs.readdir(f.directory), []);
  }
});

await t.test('empty chunks do not keep a stalled transfer alive, and async progress rejections remain harmless', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  const body = new ReadableStream({
    async pull(controller) { await delay(5); controller.enqueue(new Uint8Array()); }
  }, { highWaterMark: 0 });
  await assert.rejects(downloadMedia({ ...f.options, timeoutMs: 30,
    fetchImpl: async () => response(body), onProgress: async () => { throw Error('UI disconnected'); }
  }), { code: 'MEDIA_DOWNLOAD_TIMEOUT' });
  assert.deepEqual(await fs.readdir(f.directory), []);
  const saved = await downloadMedia({ ...f.options, onProgress: async () => { throw Error('UI disconnected'); } });
  assert.equal(saved.bytes, MP4.length);
});

await t.test('cancellation during the saving progress callback still prevents publication', async t => {
  const f = await fixture(t), controller = new AbortController();
  await assert.rejects(downloadMedia({ ...f.options, signal: controller.signal,
    onProgress({ phase }) { if (phase === 'saving') controller.abort(); }
  }), { name: 'AbortError' });
  assert.deepEqual(await fs.readdir(f.directory), []);
});

await t.test('disk write, sync and rename errors remove all partial files and preserve the previous destination', async t => {
  const f = await fixture(t);
  const destination = path.join(f.directory, 'video.mp4');
  await fs.writeFile(destination, 'previous file');
  for (const fail of ['writeFile', 'sync', 'rename']) {
    if (fail === 'rename') t.mock.method(fs, 'rename', async () => { throw Object.assign(Error('disk error'), { code: 'EIO' }); });
    else {
      const originalOpen = fs.open.bind(fs);
      t.mock.method(fs, 'open', async (...args) => {
        const handle = await originalOpen(...args);
        if (String(args[0]).endsWith('.part')) handle[fail] = async () => { throw Object.assign(Error('disk full'), { code: 'ENOSPC' }); };
        return handle;
      });
    }
    await assert.rejects(downloadMedia(f.options), { code: fail === 'rename' ? 'EIO' : 'ENOSPC' });
    t.mock.restoreAll();
    assert.deepEqual(await fs.readdir(f.directory), ['video.mp4']);
    assert.equal(await fs.readFile(destination, 'utf8'), 'previous file');
  }
});

await t.test('MIME, signature, MP4 integrity and required audio are checked before publication', async t => {
  const f = await fixture(t);
  for (const body of [Buffer.from('<html>login</html>'), MP4.subarray(0, MP4.length - 1), mp4Fixture({ audio: false })]) {
    await assert.rejects(downloadMedia({ ...f.options, fetchImpl: async () => response(body) }));
    assert.deepEqual(await fs.readdir(f.directory), []);
  }
  await assert.rejects(downloadMedia({ ...f.options, fetchImpl: async () => response(MP4, { 'content-type': 'text/html' }) }), /响应类型/);
});


}

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const origin = 'https://source-download.fixture';
const sourceURL = name => `https://sns-video-bd.xhscdn.com/spectrum/${name}.mp4`;
const primary = sourceURL('primary'), backup = sourceURL('backup'), last = sourceURL('last');
const video = { url: primary, backupUrls: [backup, primary, last, backup] };

function body(bytes, headers = {}) {
  return new Response(bytes, { headers: { 'content-type': 'video/mp4', ...headers } });
}
function unavailable(status = 503) {
  return Response.json({ message: 'Fixture source unavailable' }, { status });
}

async function fixture(transport, options = {}) {
  const { createSourceDownload } = await import('../desktop/xhs/lib/source-download.js');
  const calls = [];
  const download = createSourceDownload({
    proxyUrl: image => `${origin}/image?url=${encodeURIComponent(image.url)}`,
    videoApiUrl: (action, source, extra = {}) => `${origin}/video?${new URLSearchParams({ action, url: source, ...extra })}`,
    fetch: async (input, init = {}) => {
      const url = new URL(input);
      const call = url.origin === origin
        ? { kind: url.pathname === '/image' ? 'image' : url.searchParams.get('action'), source: url.searchParams.get('url'),
          ...(url.searchParams.has('start') ? { start: Number(url.searchParams.get('start')), end: Number(url.searchParams.get('end')) } : {}) }
        : { kind: 'direct', source: url.href };
      calls.push(call);
      return transport(call, init);
    },
    ...options,
  });
  return { download, calls };
}

test('source download exhausts each unique segmented CDN before trying each unique direct CDN', async () => {
  const { download, calls } = await fixture(call => {
    if (call.kind === 'meta') return Response.json({ size: 4, chunkSize: 2 });
    if (call.kind === 'direct' && call.source === last) return body('DONE');
    return unavailable();
  });
  const blob = await download.fetchVideoBlobWithFallback(video);
  assert.equal(await blob.text(), 'DONE');
  assert.deepEqual(calls, [
    { kind: 'meta', source: primary }, { kind: 'chunk', source: primary, start: 0, end: 1 },
    { kind: 'meta', source: backup }, { kind: 'chunk', source: backup, start: 0, end: 1 },
    { kind: 'meta', source: last }, { kind: 'chunk', source: last, start: 0, end: 1 },
    { kind: 'direct', source: primary }, { kind: 'direct', source: backup }, { kind: 'direct', source: last },
  ]);
});

test('segmented success reads inclusive ranges exactly once and never requests direct fallback', async () => {
  const content = Buffer.from('abcdefg'), progress = [];
  const { download, calls } = await fixture(call => {
    if (call.kind === 'meta') return Response.json({ size: content.length, chunkSize: 3, contentType: 'video/mp4' });
    assert.equal(call.kind, 'chunk');
    const bytes = content.subarray(call.start, call.end + 1);
    return body(bytes, { 'content-length': String(bytes.length) });
  });
  const blob = await download.fetchVideoBlobWithFallback(video, { onProgress: value => progress.push(value) });
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), content);
  assert.equal(blob.type, 'video/mp4');
  assert.deepEqual(calls, [
    { kind: 'meta', source: primary },
    { kind: 'chunk', source: primary, start: 0, end: 2 },
    { kind: 'chunk', source: primary, start: 3, end: 5 },
    { kind: 'chunk', source: primary, start: 6, end: 6 },
  ]);
  assert.deepEqual(progress.at(-1), { loadedBytes: 7, totalBytes: 7, chunkIndex: 3, totalChunks: 3 });
});

test('a bad later chunk discards earlier bytes before starting a clean backup download', async t => {
  for (const failure of ['declared-length', 'short-body', 'oversized-body']) {
    await t.test(failure, async () => {
      let cancelled = 0;
      const { download, calls } = await fixture(call => {
        if (call.kind === 'meta') return Response.json({ size: 6, chunkSize: 3 });
        assert.equal(call.kind, 'chunk', 'a successful segmented backup must suppress every direct request');
        if (call.source === backup) return body(call.start === 0 ? 'BBB' : 'CCC', { 'content-length': '3' });
        if (call.start === 0) return body('AAA', { 'content-length': '3' });
        if (failure === 'short-body') return body('XX');
        const stream = new ReadableStream({
          start(controller) { if (failure === 'oversized-body') controller.enqueue(Buffer.from('XXXXX')); },
          cancel() { cancelled++; },
        });
        return body(stream, { 'content-length': failure === 'declared-length' ? '2' : '3' });
      });
      const result = await download.fetchVideoBlobWithFallback({ url: primary, backupUrls: [backup] });
      assert.equal(await result.text(), 'BBBCCC', 'failed CDN bytes cannot contaminate the chosen backup');
      assert.equal(result.size, 6);
      assert.deepEqual(calls, [
        { kind: 'meta', source: primary },
        { kind: 'chunk', source: primary, start: 0, end: 2 },
        { kind: 'chunk', source: primary, start: 3, end: 5 },
        { kind: 'meta', source: backup },
        { kind: 'chunk', source: backup, start: 0, end: 2 },
        { kind: 'chunk', source: backup, start: 3, end: 5 },
      ]);
      if (failure !== 'short-body') assert.equal(cancelled, 1, 'discard the invalid response stream');
    });
  }
});

test('one shared archive budget subtracts prior images and stops oversized video before any request', async () => {
  const imageURL = 'https://ci.xiaohongshu.com/source-budget-image';
  const { download, calls } = await fixture(call => {
    assert.equal(call.kind, 'image', 'declared video cannot fit the remaining shared budget');
    return body('IMAGE', { 'content-type': 'image/jpeg', 'content-length': '5' });
  });
  const budget = download.createArchiveBudget('batch');
  const initial = budget.remainingBytes('素材');
  assert.deepEqual(Buffer.from(await download.fetchImageArchiveData({ index: 1, url: imageURL }, budget, '原图')), Buffer.from('IMAGE'));
  assert.equal(budget.remainingBytes('视频'), initial - 5);
  await assert.rejects(download.fetchVideoArchiveData({ ...video, size: initial - 4 }, budget, '实况视频'), {
    name: 'ArchiveSizeLimitError',
  });
  assert.deepEqual(calls, [{ kind: 'image', source: imageURL }]);
  assert.equal(budget.remainingBytes('视频'), initial - 5, 'failed media never consumes or resets the existing budget');
});

test('metadata exceeding the remaining archive budget is terminal before chunks or other CDNs', async () => {
  let remaining;
  const { download, calls } = await fixture(call => {
    assert.equal(call.kind, 'meta');
    return Response.json({ size: remaining + 1, chunkSize: 3 });
  });
  const budget = download.createArchiveBudget('batch');
  budget.consumeData(Uint8Array.of(1, 2, 3), '已下载图片');
  remaining = budget.remainingBytes('实况视频');
  await assert.rejects(download.fetchVideoArchiveData(video, budget, '实况视频'), { name: 'ArchiveSizeLimitError' });
  assert.deepEqual(calls, [{ kind: 'meta', source: primary }]);
  assert.equal(budget.remainingBytes('实况视频'), remaining);
});

test('unknown video size prevents unsafe segmentation while allowing bounded direct download', async () => {
  const { download, calls } = await fixture(call => {
    if (call.kind === 'meta') return Response.json({ size: 0, chunkSize: 3 });
    assert.equal(call.kind, 'direct', 'unknown length must never produce chunk ranges');
    return body('MP4');
  });
  const blob = await download.fetchVideoBlobWithFallback({ url: primary, backupUrls: [backup] }, { maxBytes: 5, onProgress: () => {} });
  assert.equal(await blob.text(), 'MP4');
  assert.deepEqual(calls, [{ kind: 'meta', source: primary }, { kind: 'meta', source: backup }, { kind: 'direct', source: primary }]);
});

test('a direct response exceeding the byte ceiling stops fallback instead of trying another CDN', async () => {
  let cancelled = 0;
  const { download, calls } = await fixture(call => {
    if (call.kind === 'meta') return Response.json({ size: 0 });
    return body(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('TOO LARGE')); }, cancel() { cancelled++; } }));
  });
  await assert.rejects(download.fetchVideoBlobWithFallback({ url: primary, backupUrls: [backup] }, { maxBytes: 5 }), { name: 'VideoTooLargeError' });
  assert.equal(cancelled, 1);
  assert.deepEqual(calls, [{ kind: 'meta', source: primary }, { kind: 'meta', source: backup }, { kind: 'direct', source: primary }]);
});

test('the host cancellation boundary prevents further network requests during source fallback', async t => {
  for (const alreadyAborted of [false, true]) {
    await t.test(alreadyAborted ? 'cancelled before start' : 'cancelled during first chunk', async () => {
      const controller = new AbortController(), actualNetwork = [];
      if (alreadyAborted) controller.abort();
      const { download } = await fixture(() => { throw Error('The host wrapper owns transport'); }, {
        // The unchanged source fallback may invoke this adapter again after an
        // AbortError. As in the production host, reject before any new network
        // operation, and preserve the caller's abort reason.
        fetch: async (input, init = {}) => {
          const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
          signal.throwIfAborted();
          const url = new URL(input);
          actualNetwork.push({ action: url.searchParams.get('action'), source: url.searchParams.get('url') });
          if (url.searchParams.get('action') === 'meta') return Response.json({ size: 6, chunkSize: 3 });
          controller.abort(); signal.throwIfAborted();
        },
      });
      await assert.rejects(download.fetchVideoBlobWithFallback(video), { name: 'AbortError' });
      assert.deepEqual(actualNetwork, alreadyAborted ? [] : [{ action: 'meta', source: primary }, { action: 'chunk', source: primary }]);
    });
  }
});

test('source image fallback uses direct original bytes only for an HTTP 413 proxy response', async () => {
  const url = 'https://ci.xiaohongshu.com/source-original-image';
  const image = { index: 1, url };
  const { download, calls } = await fixture((call, init) => {
    if (call.kind === 'image') return unavailable(413);
    assert.equal(init.mode, 'cors'); assert.equal(init.referrerPolicy, 'no-referrer');
    return body('ORIGINAL', { 'content-type': 'image/jpeg' });
  });
  const result = await download.fetchImageBlob(image, { maxBytes: 8 });
  assert.equal(await result.text(), 'ORIGINAL');
  assert.deepEqual(calls, [{ kind: 'image', source: url }, { kind: 'direct', source: url }]);
  const denied = await fixture(() => unavailable(403));
  await assert.rejects(denied.download.fetchImageBlob(image), /Fixture source unavailable/);
  assert.deepEqual(denied.calls, [{ kind: 'image', source: url }]);
});

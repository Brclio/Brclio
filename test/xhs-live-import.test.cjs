const { test } = require('node:test');
const assert = require('node:assert/strict');

const source = (name, { width = 6000, height = 6000, size = 100, ...options } = {}) => ({
  name, type: name.endsWith('.mp4') ? 'video/mp4' : 'image/png', size,
  width, height, lastModified: 1234, ...options,
  arrayBuffer() { throw new Error('The original image must stay in its File/Blob URL.'); }
});

// The decoder stub exposes dimensions without allocating enormous bitmaps.
// Canvas encoding still returns real Blobs and the API creates real File copies.
function imageEnvironment(t, { encode, canvasError, noContext = false } = {}) {
  const images = [], canvases = [], sources = new Map(), revoked = [];
  const replace = (target, name, value) => {
    const previous = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, { configurable: true, writable: true, value });
    t.after(() => previous ? Object.defineProperty(target, name, previous) : delete target[name]);
  };
  replace(URL, 'createObjectURL', file => {
    const url = `blob:import-test-${sources.size}`;
    sources.set(url, file); return url;
  });
  replace(URL, 'revokeObjectURL', url => { revoked.push(url); });
  replace(globalThis, 'Image', class extends EventTarget {
    constructor() { super(); this.value = ''; images.push(this); }
    set src(value) {
      this.value = value;
      if (!value) return;
      const file = sources.get(value);
      this.naturalWidth = file.width; this.naturalHeight = file.height;
      queueMicrotask(() => {
        if (this.value === value && !file.holdDecode)
          this.dispatchEvent(new Event(file.decodeError ? 'error' : 'load'));
      });
    }
    get src() { return this.value; }
  });
  replace(globalThis, 'document', {
    createElement(name) {
      assert.equal(name, 'canvas');
      if (canvasError) throw canvasError;
      const canvas = {
        width: 0, height: 0,
        getContext() {
          return noContext ? null : {
            fillRect() {},
            drawImage(image, ...dimensions) { canvas.drawn = { image, dimensions }; }
          };
        },
        toBlob(callback, type, quality) {
          canvas.encoding = { type, quality, width: canvas.width, height: canvas.height };
          if (encode) encode(callback, canvases.indexOf(canvas), canvas);
          else queueMicrotask(() => callback(new Blob(['compressed'], { type })));
        }
      };
      canvases.push(canvas); return canvas;
    }
  });
  return {
    images, canvases, sources,
    assertReleased() {
      assert.deepEqual(new Set(revoked), new Set(sources.keys()), 'Every source Blob URL is revoked.');
      assert.ok(images.every(image => image.src === ''), 'Every decoded image is released.');
      assert.ok(canvases.every(canvas => canvas.width === 0 && canvas.height === 0), 'Every canvas backing store is released.');
    }
  };
}

test('live-photo image import limits and compression', async t => {
  const { LIVE_PHOTO_LIMITS, validateLivePhotoFiles, inspectLivePhotoFiles, compressLivePhotoFiles } =
    await import('../web/xhs/lib/live-photo-maker.js');

  await t.test('oversized inspection is opt-in and retains count, type and video limits', async t => {
    const environment = imageEnvironment(t);
    const oversized = source('large.png', { size: LIVE_PHOTO_LIMITS.maxBytes + 1 });
    assert.throws(() => validateLivePhotoFiles([oversized]), /150 MB/);
    await assert.rejects(inspectLivePhotoFiles([oversized]), /150 MB/);
    assert.equal(environment.sources.size, 0, 'Byte rejection happens before decoding.');
    const info = await inspectLivePhotoFiles([oversized], { allowOversizedImages: true });
    assert.equal(info.bytes, oversized.size);
    assert.equal(info.requiresCompression, true);
    for (const files of [Array.from({ length: 13 }, (_, index) => source(`${index}.png`)),
      [source('image.png'), source('clip.mp4')]]) {
      await assert.rejects(inspectLivePhotoFiles(files, { allowOversizedImages: true }), /12|不能混合/);
      await assert.rejects(compressLivePhotoFiles(files), /12|不能混合/);
    }
    assert.throws(() => validateLivePhotoFiles([source('huge.mp4', { size: oversized.size })],
      { allowOversizedImages: true }), /150 MB/);
    await assert.rejects(compressLivePhotoFiles([source('clip.mp4')]), /只有图片/);
    environment.assertReleased();
  });

  await t.test('the pixel guard remains strict by default and reports the full group when opted in', async t => {
    const environment = imageEnvironment(t);
    const files = [source('first.png'), source('second.png')];
    await assert.rejects(inspectLivePhotoFiles(files), /6400 万/);
    const info = await inspectLivePhotoFiles(files, { allowOversizedImages: true });
    assert.deepEqual(info, {
      kind: 'images', duration: null, width: 6000, height: 6000, hasAudio: false,
      pixels: 72_000_000, bytes: 200, requiresCompression: true
    });
    const boundary = await inspectLivePhotoFiles([source('boundary.png', { width: 8000, height: 8000 })]);
    assert.equal(boundary.pixels, LIVE_PHOTO_LIMITS.maxDecodedPixels);
    assert.equal(boundary.requiresCompression, false);
    environment.assertReleased();
  });

  await t.test('compression returns ordered JPEG copies bounded for later preview and encoding', async t => {
    const environment = imageEnvironment(t);
    const files = [source('portrait.png', { width: 6000, height: 9000 }),
      source('landscape.png', { width: 9000, height: 6000 })];
    const progress = [];
    const result = await compressLivePhotoFiles(files, { onProgress: value => progress.push(value.progress) });
    assert.equal(result.length, 2);
    assert.deepEqual(result.map(file => file.name), ['portrait-compressed.jpg', 'landscape-compressed.jpg']);
    assert.ok(result.every(file => file instanceof File && file.type === 'image/jpeg' && file.size > 0));
    assert.deepEqual(result.map(file => file.lastModified), [1234, 1234]);
    assert.deepEqual(files.map(file => file.name), ['portrait.png', 'landscape.png'], 'Original inputs are untouched.');
    assert.deepEqual(environment.canvases.map(canvas => [canvas.encoding.width, canvas.encoding.height]),
      [[960, 1440], [1440, 960]]);
    assert.ok(environment.canvases.every(canvas => canvas.encoding.type === 'image/jpeg'));
    assert.deepEqual(progress, [0, .5, 1]);
    environment.assertReleased();
  });

  await t.test('a later encoding failure rejects the batch instead of returning a partial import', async t => {
    const environment = imageEnvironment(t, { encode(callback, index) {
      queueMicrotask(() => callback(index === 0 ? new Blob(['ok'], { type: 'image/jpeg' }) : null));
    } });
    let imported;
    await assert.rejects(compressLivePhotoFiles([source('first.png'), source('broken.png')])
      .then(files => { imported = files; }), /压缩失败/);
    assert.equal(imported, undefined);
    environment.assertReleased();
  });

  await t.test('cancellation during encoding releases resources and ignores a late encoder result', async t => {
    const controller = new AbortController();
    let lateResult, imported;
    const environment = imageEnvironment(t, { encode(callback, index) {
      if (index === 0) queueMicrotask(() => callback(new Blob(['ok'], { type: 'image/jpeg' })));
      else { lateResult = callback; queueMicrotask(() => controller.abort()); }
    } });
    await assert.rejects(compressLivePhotoFiles([source('first.png'), source('second.png')], { signal: controller.signal })
      .then(files => { imported = files; }), { name: 'AbortError' });
    assert.equal(imported, undefined);
    environment.assertReleased();
    lateResult(new Blob(['late'], { type: 'image/jpeg' }));
    await Promise.resolve();
    assert.equal(imported, undefined);
  });

  await t.test('decoder and canvas failures both release the decoded source', async t => {
    await t.test('decode error', async t => {
      const environment = imageEnvironment(t);
      await assert.rejects(compressLivePhotoFiles([source('broken.png', { decodeError: true })]), /素材读取失败/);
      environment.assertReleased();
    });
    await t.test('missing canvas context', async t => {
      const environment = imageEnvironment(t, { noContext: true });
      await assert.rejects(compressLivePhotoFiles([source('large.png')]), /无法压缩图片/);
      environment.assertReleased();
    });
    await t.test('canvas allocation failure', async t => {
      const environment = imageEnvironment(t, { canvasError: new Error('Canvas allocation failed') });
      await assert.rejects(compressLivePhotoFiles([source('large.png')]), /Canvas allocation failed/);
      environment.assertReleased();
    });
  });

  await t.test('an already cancelled import does not decode any images', async t => {
    const environment = imageEnvironment(t), controller = new AbortController(); controller.abort();
    await assert.rejects(inspectLivePhotoFiles([source('large.png')], { allowOversizedImages: true, signal: controller.signal }),
      { name: 'AbortError' });
    await assert.rejects(compressLivePhotoFiles([source('large.png')], { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(environment.sources.size, 0);
    environment.assertReleased();
  });
});

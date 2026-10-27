const { test } = require('node:test');
const assert = require('node:assert/strict');

const image = (width, height) => ({ naturalWidth: width, naturalHeight: height });
const originalState = () => ({ transform: [2, 0, 0, 2, 17, 23], fillStyle: '#123456', filter: 'blur(2px)',
  globalAlpha: 0.4, globalCompositeOperation: 'multiply', imageSmoothingEnabled: false, imageSmoothingQuality: 'low' });
const properties = ['fillStyle', 'filter', 'globalAlpha', 'globalCompositeOperation', 'imageSmoothingEnabled', 'imageSmoothingQuality'];
function recordingContext({ failDraw = false } = {}) {
  const stack = [], draws = [], fills = [];
  const context = { ...originalState(), draws, fills, saves: 0, restores: 0,
    snapshot() { return { transform: [...this.transform], ...Object.fromEntries(properties.map(key => [key, this[key]])) }; },
    save() { this.saves++; stack.push(this.snapshot()); },
    restore() { this.restores++; Object.assign(this, stack.pop()); },
    setTransform(...values) { this.transform = values; },
    translate(x, y) {
      const [a, b, c, d, e, f] = this.transform;
      this.transform = [a, b, c, d, e + a * x + c * y, f + b * x + d * y];
    },
    scale(x, y) {
      const [a, b, c, d, e, f] = this.transform;
      this.transform = [a * x, b * x, c * y, d * y, e, f];
    },
    rotate(angle) {
      const [a, b, c, d, e, f] = this.transform, cosine = Math.cos(angle), sine = Math.sin(angle);
      this.transform = [a * cosine + c * sine, b * cosine + d * sine,
        c * cosine - a * sine, d * cosine - b * sine, e, f];
    },
    fillRect(...rect) { fills.push({ ...this.snapshot(), rect }); },
    drawImage(source, ...rect) {
      if (failDraw) throw new Error('decoder draw failed');
      draws.push({ ...this.snapshot(), source, rect });
    }
  };
  return context;
}

function transformPoint(transform, x, y) {
  const [a, b, c, d, e, f] = transform;
  return [a * x + c * y + e, b * x + d * y + f];
}

// Inspect where distinct source pixels land, independently of the draw helper's
// source crop and transform operations. Fixtures here use integer 1:1 rotations.
function pixelRows(draw, width, height) {
  const [sx, sy, sw, sh, dx, dy, dw, dh] = draw.rect;
  const output = Array.from({ length: height }, () => Array(width).fill('.'));
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const point = transformPoint(draw.transform, dx + (x + 0.5) / sw * dw, dy + (y + 0.5) / sh * dh);
    output[Math.floor(point[1])][Math.floor(point[0])] = draw.source.pixels[sy + y][sx + x];
  }
  return output.map(row => row.join(''));
}

test('Live Photo image edits validate normalized source coordinates and return independent defaults', async () => {
  const { normalizeLivePhotoImageEdit: normalize } = await import('../web/xhs/lib/live-photo-image-edit.js');
  const defaults = { crop: { x: 0, y: 0, width: 1, height: 1 }, rotation: 0, flipX: false, flipY: false,
    brightness: 1, contrast: 1, saturation: 1 };
  assert.deepEqual(normalize(), defaults);
  const first = normalize(); first.crop.width = 0.5;
  assert.deepEqual(normalize(), defaults, 'changing one edit does not alter later defaults');
  const edit = { crop: { x: 0.1, y: 0.2, width: 0.9, height: 0.8 }, rotation: 270, flipX: true,
    flipY: true, brightness: 0.25, contrast: 2, saturation: 0 };
  const before = structuredClone(edit);
  assert.deepEqual(normalize(edit), edit);
  assert.deepEqual(edit, before, 'normalization does not modify user edits');
  for (const value of [null, [], true, 1, 'edit']) assert.throws(() => normalize(value), /参数/);
  for (const crop of [null, [], { x: -0.1 }, { x: 1 }, { y: 1 }, { width: 0 }, { height: 0 },
    { x: 0.5, width: 0.6 }, { y: 0.5, height: 0.6 }, { width: 1.1 }, { width: NaN }, { x: '0' }])
    assert.throws(() => normalize({ crop }), /裁切/);
  for (const rotation of [-90, 45, 360, '90', NaN, Infinity]) assert.throws(() => normalize({ rotation }), /旋转/);
  for (const value of [null, 1, 'true']) for (const key of ['flipX', 'flipY']) assert.throws(() => normalize({ [key]: value }), /翻转/);
  for (const key of ['brightness', 'contrast']) for (const value of [0.249, 2.001, NaN, Infinity, '1', null])
    assert.throws(() => normalize({ [key]: value }), /亮度|对比度/);
  for (const value of [-0.001, 2.001, NaN, Infinity, '1', null]) assert.throws(() => normalize({ saturation: value }), /饱和度/);
});

test('source crops retain native pixels, round outward, and rotate each image independently', async () => {
  const { livePhotoImageCropRect: rect, livePhotoImageDimensions: dimensions } = await import('../web/xhs/lib/live-photo-image-edit.js');
  const edit = { crop: { x: 0.1, y: 0.25, width: 0.6, height: 0.5 } };
  assert.deepEqual(rect(image(6000, 4000), edit), { x: 600, y: 1000, width: 3600, height: 2000 });
  assert.deepEqual(rect(image(3000, 6000), edit), { x: 300, y: 1500, width: 1800, height: 3000 });
  assert.deepEqual(dimensions(image(6000, 4000), edit), { width: 3600, height: 2000 });
  assert.deepEqual(dimensions(image(3000, 6000), { ...edit, rotation: 90 }), { width: 3000, height: 1800 });
  assert.deepEqual(dimensions(image(641, 479)), { width: 641, height: 479 }, 'odd source dimensions remain exact');
  for (const rotation of [0, 90, 180, 270]) assert.deepEqual(dimensions(image(3, 2), { rotation }),
    rotation % 180 ? { width: 2, height: 3 } : { width: 3, height: 2 });
  assert.deepEqual(rect(image(7, 5), { crop: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 } }),
    { x: 1, y: 1, width: 3, height: 2 });
  assert.deepEqual(rect(image(10, 10), { crop: { x: 0.9999, y: 0.9999, width: 0.0001, height: 0.0001 } }),
    { x: 9, y: 9, width: 1, height: 1 });
  assert.deepEqual(rect(image(3000, 3000), { crop: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }),
    { x: 300, y: 300, width: 600, height: 600 }, 'floating point noise does not add an extra boundary pixel');
  assert.deepEqual(dimensions({ width: 1024, height: 768 }), { width: 1024, height: 768 }, 'ImageBitmap dimensions are supported');
  for (const source of [null, image(0, 10), image(10, Infinity), image(2.5, 10), { naturalWidth: 0, naturalHeight: 0, width: 100, height: 100 }])
    assert.throws(() => dimensions(source), /原图尺寸/);
});

test('rotation and final-axis flips place selected source pixels in the expected order', async () => {
  const { drawEditedLivePhotoImage: draw } = await import('../web/xhs/lib/live-photo-image-edit.js');
  const source = { ...image(3, 2), pixels: ['ABC', 'DEF'] };
  const cases = [
    [{ rotation: 0 }, 3, 2, ['ABC', 'DEF']],
    [{ rotation: 90 }, 2, 3, ['DA', 'EB', 'FC']],
    [{ rotation: 180 }, 3, 2, ['FED', 'CBA']],
    [{ rotation: 270 }, 2, 3, ['CF', 'BE', 'AD']],
    [{ rotation: 90, flipX: true }, 2, 3, ['AD', 'BE', 'CF']],
    [{ rotation: 90, flipY: true }, 2, 3, ['FC', 'EB', 'DA']],
    [{ crop: { x: 1 / 3, y: 0, width: 2 / 3, height: 1 }, rotation: 90 }, 2, 2, ['EB', 'FC']]
  ];
  for (const [edit, width, height, expected] of cases) {
    const context = recordingContext(), initial = context.snapshot();
    assert.deepEqual(draw(context, source, { edit }), { width, height });
    assert.deepEqual(pixelRows(context.draws[0], width, height), expected, JSON.stringify(edit));
    assert.deepEqual(context.snapshot(), initial, 'all context state is restored');
    assert.equal(context.saves, 1); assert.equal(context.restores, 1);
  }
});

test('batch aspect presets retain real pixel ratios across source shapes, preserve edits, and fit the current crop', async () => {
  const { fitLivePhotoImageEditAspectRatio: fit, livePhotoImageDimensions: dimensions,
    livePhotoImageCropRect: rect } = await import('../web/xhs/lib/live-photo-image-edit.js');
  const edit = { crop: { x: 0.2, y: 0.1, width: 0.6, height: 0.8 }, rotation: 90,
    flipX: true, flipY: false, brightness: 0.7, contrast: 1.3, saturation: 0.4 };
  for (const source of [image(601, 401), image(401, 901), image(900, 600)]) for (const ratio of [1, 4 / 3, 3 / 4, 16 / 9, 9 / 16]) {
    const before = structuredClone(edit), result = fit(source, edit, ratio), pixels = rect(source, result), original = rect(source, edit);
    const size = dimensions(source, result);
    assert.equal(size.width / size.height, ratio, `${source.naturalWidth} × ${source.naturalHeight}, ratio ${ratio}`);
    assert.ok(pixels.x >= original.x && pixels.y >= original.y);
    assert.ok(pixels.x + pixels.width <= original.x + original.width);
    assert.ok(pixels.y + pixels.height <= original.y + original.height);
    assert.ok(Math.abs(pixels.x + pixels.width / 2 - (edit.crop.x + edit.crop.width / 2) * source.naturalWidth) <= 0.5);
    assert.ok(Math.abs(pixels.y + pixels.height / 2 - (edit.crop.y + edit.crop.height / 2) * source.naturalHeight) <= 0.5);
    const { crop, ...adjustments } = result;
    assert.deepEqual(adjustments, { rotation: 90, flipX: true, flipY: false, brightness: 0.7, contrast: 1.3, saturation: 0.4 });
    assert.deepEqual(edit, before);
  }
  for (const ratio of [0, -1, Infinity, NaN, '1', null]) assert.throws(() => fit(image(100, 100), {}, ratio), /比例/);
  const small = dimensions(image(10, 10), fit(image(10, 10), {}, 16 / 9));
  assert.deepEqual(small, { width: 10, height: 6 }, 'tiny crops use the nearest available native pixels');
  const primeSource = image(601, 400), smallerOriginal = fit(primeSource,
    { crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } }, 601 / 400);
  const originalSize = dimensions(primeSource, smallerOriginal);
  assert.ok(Math.abs(originalSize.width - originalSize.height * 601 / 400) <= 1,
    'a smaller original-aspect crop does not require full prime-dimension units');
  assert.throws(() => fit(image(10, 10), {}, 1000), /过小/);
  const arbitrary = fit(image(1000, 1000), {}, Math.SQRT2), arbitrarySize = dimensions(image(1000, 1000), arbitrary);
  assert.ok(Math.abs(arbitrarySize.width / arbitrarySize.height - Math.SQRT2) < 0.002);
});

test('drawing contains the image, isolates its background and tones, and preserves the 5.5 percent zoom', async () => {
  const { drawEditedLivePhotoImage: draw } = await import('../web/xhs/lib/live-photo-image-edit.js');
  const context = recordingContext(), initial = context.snapshot();
  draw(context, image(400, 200), { width: 400, height: 400,
    edit: { brightness: 1.2, contrast: 0.5, saturation: 0 } });
  const fill = context.fills[0], result = context.draws[0];
  assert.deepEqual(fill.rect, [0, 0, 400, 400]);
  assert.deepEqual(fill.transform, [1, 0, 0, 1, 0, 0]);
  assert.equal(fill.fillStyle, '#fefcf6'); assert.equal(fill.filter, 'none'); assert.equal(fill.globalAlpha, 1);
  assert.equal(result.filter, 'brightness(1.2) contrast(0.5) saturate(0)');
  assert.equal(result.imageSmoothingEnabled, true); assert.equal(result.imageSmoothingQuality, 'high');
  assert.equal(result.globalCompositeOperation, 'source-over');
  assert.deepEqual(transformPoint(result.transform, -200, -100), [0, 100]);
  assert.deepEqual(transformPoint(result.transform, 200, 100), [400, 300]);
  assert.deepEqual(context.snapshot(), initial);
  const zoom = recordingContext();
  draw(zoom, image(400, 200), { motion: 'zoom', time: 2, duration: 2 });
  assert.equal(zoom.draws[0].filter, 'none', 'Unadjusted images avoid an unnecessary filtered intermediate.');
  assert.equal(zoom.draws[0].transform[0], 1.055);
  assert.equal(zoom.draws[0].transform[3], 1.055);
  const midway = recordingContext();
  draw(midway, image(400, 200), { motion: 'zoom', time: 1, duration: 2 });
  assert.equal(midway.draws[0].transform[0], 1.0275);
});

test('invalid draw inputs fail before drawing and decoder failures still restore context state', async () => {
  const { drawEditedLivePhotoImage: draw } = await import('../web/xhs/lib/live-photo-image-edit.js');
  const context = recordingContext();
  for (const options of [{ width: 0 }, { height: NaN }, { width: 3.5 }, { time: -1 }, { time: 2 },
    { time: NaN }, { duration: 0 }, { duration: Infinity }, { motion: 'pan' }, { edit: { rotation: 45 } }])
    assert.throws(() => draw(context, image(3, 2), options));
  assert.equal(context.saves, 0); assert.equal(context.draws.length, 0); assert.equal(context.fills.length, 0);
  assert.throws(() => draw({}, image(3, 2)), /画布/);
  const broken = recordingContext({ failDraw: true }), initial = broken.snapshot();
  assert.throws(() => draw(broken, image(3, 2)), /decoder draw failed/);
  assert.deepEqual(broken.snapshot(), initial); assert.equal(broken.saves, 1); assert.equal(broken.restores, 1);
});

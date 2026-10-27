const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { _electron } = require('@playwright/test');

test('Live Photo maker retains edited cover pixels through real Canvas, JPEG and AVC encoding', {
  timeout: 120000, skip: process.platform === 'linux' && !process.env.DISPLAY ? 'Run with xvfb-run in the browser CI job.' : false
}, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-live-edit-'));
  let application;
  t.after(async () => { await application?.close(); await fs.rm(temporary, { recursive: true, force: true }); });
  await fs.writeFile(path.join(temporary, 'package.json'), JSON.stringify({ name: 'brclio-live-edit-verification', main: 'main.cjs' }));
  await fs.writeFile(path.join(temporary, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Local image edit verification</title>');
  await fs.writeFile(path.join(temporary, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await window.loadFile(${JSON.stringify(path.join(temporary, 'index.html'))});
});
`);
  const environment = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
  delete environment.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath: require('electron'),
    // Linux runs under the browser job's Xvfb display. Combining its virtual
    // display with Electron's headless Ozone backend crashes before CDP starts.
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), temporary],
    env: environment, timeout: 30000 });
  const page = await application.firstWindow();
  const makerUrl = pathToFileURL(path.resolve(__dirname, '../web/xhs/lib/live-photo-maker.js')).href;
  const editorUrl = pathToFileURL(path.resolve(__dirname, '../web/xhs/lib/live-photo-image-edit.js')).href;
  await page.evaluate(async ({ makerUrl, editorUrl }) => {
    window.maker = await import(makerUrl); window.editor = await import(editorUrl);
    window.canvasFile = async (width, height, paint, name) => {
      const canvas = document.createElement('canvas'); Object.assign(canvas, { width, height });
      const context = canvas.getContext('2d'); paint(context, width, height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      return { canvas, file: new File([blob], name, { type: 'image/png' }) };
    };
    window.decodePhoto = async bytes => {
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      const canvas = document.createElement('canvas'); Object.assign(canvas, { width: bitmap.width, height: bitmap.height });
      canvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close(); return canvas;
    };
  }, { makerUrl, editorUrl });

  await t.test('a later cropped and rotated cover keeps its own odd native dimensions and matches the preview', async () => {
    const result = await page.evaluate(async () => {
      const first = await canvasFile(96, 64, context => { context.fillStyle = '#ff0000'; context.fillRect(0, 0, 96, 64); }, 'first.png');
      const second = await canvasFile(151, 91, (context, width, height) => {
        context.fillStyle = '#204080'; context.fillRect(0, 0, width, height);
        context.fillStyle = '#f8c840'; context.fillRect(20, 10, 55, 61);
        context.fillStyle = '#208080'; context.fillRect(75, 10, 56, 61);
      }, 'second.png');
      const imageEdits = [{}, { crop: { x: 20 / 151, y: 10 / 91, width: 111 / 151, height: 61 / 91 },
        rotation: 90, flipX: true, brightness: 0.8, contrast: 1.2, saturation: 0 }];
      const generated = await maker.createLivePhoto({ files: [first.file, second.file], imageEdits,
        duration: 0.5, keyPhotoTime: 0.36, motion: 'still', includeAudio: false, photoFormat: 'jpeg' });
      const decoded = await decodePhoto(generated.photo);
      const preview = document.createElement('canvas'); preview.width = 61; preview.height = 111;
      const frame = maker.drawLivePhotoImageFrame(preview.getContext('2d'), [first.canvas, second.canvas], {
        time: generated.keyPhotoTime, duration: generated.duration, motion: 'still', imageEdits, size: { width: 61, height: 111 } });
      const actual = decoded.getContext('2d').getImageData(0, 0, 61, 111).data;
      const expected = preview.getContext('2d').getImageData(0, 0, 61, 111).data;
      let absoluteDifference = 0, maximumDifference = 0;
      for (let index = 0; index < actual.length; index += 4) for (let channel = 0; channel < 3; channel++) {
        const difference = Math.abs(actual[index + channel] - expected[index + channel]);
        absoluteDifference += difference; maximumDifference = Math.max(maximumDifference, difference);
      }
      return { movie: [generated.width, generated.height], photo: [generated.photoWidth, generated.photoHeight],
        decoded: [decoded.width, decoded.height], preview: [preview.width, preview.height], index: frame.index,
        meanDifference: absoluteDifference / (61 * 111 * 3), maximumDifference,
        keyPhotoTime: generated.keyPhotoTime, videoResized: generated.videoResized,
        sample: [...actual.slice(0, 3)] };
    });
    assert.deepEqual(result.movie, [96, 64]);
    assert.deepEqual(result.photo, [61, 111]); assert.deepEqual(result.decoded, [61, 111]);
    assert.deepEqual(result.preview, [61, 111]); assert.equal(result.index, 1);
    assert.ok(result.meanDifference < 1, JSON.stringify(result));
    assert.ok(result.maximumDifference <= 4, JSON.stringify(result));
    assert.equal(result.sample[0], result.sample[1]); assert.equal(result.sample[1], result.sample[2]);
    assert.equal(result.keyPhotoTime, 11 / 30); assert.equal(result.videoResized, false);
  });

  await t.test('an unsupported native AVC size reduces only the movie while retaining the full photo', async () => {
    const result = await page.evaluate(async () => {
      const source = await canvasFile(1301, 801, (context, width, height) => {
        context.fillStyle = '#316273'; context.fillRect(0, 0, width, height);
      }, 'native-odd.png');
      const original = VideoEncoder.isConfigSupported;
      const probes = [];
      VideoEncoder.isConfigSupported = async config => {
        probes.push([config.width, config.height]);
        return config.width > 1280 ? { supported: false, config } : original.call(VideoEncoder, config);
      };
      try {
        const generated = await maker.createLivePhoto({ files: [source.file], duration: 0.5,
          keyPhotoTime: 0.25, motion: 'still', includeAudio: false, photoFormat: 'jpeg' });
        const decoded = await decodePhoto(generated.photo);
        return { movie: [generated.width, generated.height], photo: [generated.photoWidth, generated.photoHeight],
          decoded: [decoded.width, decoded.height], videoResized: generated.videoResized, probes };
      } finally { VideoEncoder.isConfigSupported = original; }
    });
    assert.deepEqual(result.photo, [1301, 801]); assert.deepEqual(result.decoded, [1301, 801]);
    assert.equal(result.videoResized, true);
    assert.ok(result.probes.some(([width, height]) => width === 1300 && height === 800));
    assert.ok(result.movie[0] <= 1280 && result.movie[1] < 800, JSON.stringify(result));
    assert.equal(result.movie[0] % 2, 0); assert.equal(result.movie[1] % 2, 0);
  });

  await t.test('real Canvas filters affect only image pixels and leave caller state intact', async () => {
    const result = await page.evaluate(async () => {
      const source = await canvasFile(4, 2, context => { context.fillStyle = 'rgb(100,100,100)'; context.fillRect(0, 0, 4, 2); }, 'gray.png');
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
      const context = canvas.getContext('2d'); context.filter = 'blur(3px)'; context.globalAlpha = 0.3;
      context.translate(2, 3); context.fillStyle = '#112233';
      editor.drawEditedLivePhotoImage(context, source.canvas, { width: 8, height: 8, edit: { brightness: 2 } });
      const pixels = context.getImageData(0, 0, 8, 8).data;
      return { background: [...pixels.slice(0, 4)], image: [...pixels.slice((3 * 8 + 3) * 4, (3 * 8 + 3) * 4 + 4)],
        filter: context.filter, alpha: context.globalAlpha, fillStyle: context.fillStyle,
        transform: [...['a', 'b', 'c', 'd', 'e', 'f'].map(key => context.getTransform()[key])] };
    });
    assert.deepEqual(result.background, [254, 252, 246, 255]);
    assert.ok(result.image.slice(0, 3).every(value => Math.abs(value - 200) <= 1), JSON.stringify(result));
    assert.equal(result.filter, 'blur(3px)'); assert.ok(Math.abs(result.alpha - 0.3) < 1e-6);
    assert.equal(result.fillStyle, '#112233'); assert.deepEqual(result.transform, [1, 0, 0, 1, 2, 3]);
  });
});

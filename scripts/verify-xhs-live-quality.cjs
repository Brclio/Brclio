'use strict';
// Real 4K exports through Brclio's production file document and local codecs.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { _electron } = require('@playwright/test');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts', 'xhs-live-quality');
const jpegOnly = process.argv.includes('--jpeg-only');
const reportPath = path.join(output, jpegOnly ? 'verification-jpeg.json' : 'verification.json');
const width = 3840, height = 2160;
const report = { passed: false, testedAt: new Date().toISOString(), platform: process.platform,
  source: { width, height }, formats: jpegOnly ? ['jpeg'] : ['jpeg', 'heic'], checks: [], consoleErrors: [] };
let electronApp, page, temporary, nativeReader;

function command(binary, args, timeout = 60000) {
  return execFileSync(binary, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
const probe = filename => JSON.parse(command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-show_packets', '-of', 'json', filename]));
async function field(id, value) {
  await page.locator(`#xhs-live-${id}`).fill(String(value));
  await page.locator(`#xhs-live-${id}`).dispatchEvent('change');
}
async function generate() {
  await page.locator('#xhs-live-generate').click();
  await page.waitForFunction(() => !document.querySelector('#xhs-live-result').hidden
    || (document.querySelector('#xhs-live-cancel').hidden && document.querySelector('#xhs-live-status').textContent), null, { timeout: 120000 });
  assert.equal(await page.locator('#xhs-live-result').isVisible(), true, await page.locator('#xhs-live-status').textContent());
  await page.waitForFunction(() => document.querySelector('#xhs-live-cancel').hidden);
}
async function exportFile(kind, target) {
  const count = await electronApp.evaluate(() => global.__xhsLiveQualityDownloads.length);
  await page.locator(`#xhs-live-export-${kind}`).click();
  await page.waitForFunction(() => {
    // Main process writes the actual finished download, observed below.
    return !document.querySelector('#xhs-message').classList.contains('error');
  });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const result = await electronApp.evaluate((_electron, index) => global.__xhsLiveQualityDownloads[index], count);
    if (result?.state === 'completed') { await fs.copyFile(result.path, target); return target; }
    if (result?.state && result.state !== 'progressing') throw new Error(`Download failed: ${result.state}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Download timed out: ${target}`);
}
function similarity(reference, actual, minimum = .97) {
  // ffmpeg emits quality statistics on stderr even after success.
  const result = spawnSync('ffmpeg', ['-v', 'info', '-i', reference, '-i', actual,
    '-filter_complex', '[0:v]format=yuv420p[a];[1:v]format=yuv420p[b];[a][b]ssim', '-frames:v', '1', '-f', 'null', '-'],
  { timeout: 60000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const log = result.stderr;
  const match = log.match(/SSIM Y:([\d.]+).*?All:([\d.]+)/);
  assert.ok(match, log);
  const luma = Number(match[1]), all = Number(match[2]);
  assert.ok(luma >= minimum, `Luma SSIM ${luma} < ${minimum}: ${path.basename(actual)}`);
  return { lumaSsim: luma, allSsim: all, minimumLumaSsim: minimum };
}
async function inspectMovie(filename, reference, expected = { width, height }) {
  const info = probe(filename), video = info.streams.find(stream => stream.codec_type === 'video');
  assert.equal(video.codec_name, 'h264');
  assert.equal(video.width, expected.width); assert.equal(video.height, expected.height);
  assert.ok(Math.abs(Number(info.format.duration) - .5) < .002);
  const identifier = info.format.tags['com.apple.quicktime.content.identifier'];
  assert.match(identifier, /^[\da-f-]{36}$/i);
  const timedMetadata = info.streams.find(stream => stream.codec_tag_string === 'mebx');
  assert.ok(timedMetadata);
  const key = info.packets.find(packet => packet.stream_index === timedMetadata.index);
  assert.ok(Math.abs(Number(key.pts_time) - .2) < .035);
  command('ffmpeg', ['-v', 'error', '-i', filename, '-map', '0:v', '-f', 'null', '-']);
  const decoded = filename + '.png';
  command('ffmpeg', ['-y', '-v', 'error', '-ss', '0.2', '-i', filename, '-frames:v', '1', decoded]);
  return { filename, width: video.width, height: video.height, codec: video.codec_name,
    profile: video.profile, bitrate: Number(video.bit_rate), identifier, bytes: (await fs.stat(filename)).size,
    ...similarity(reference, decoded) };
}
async function inspectPhoto(filename, identifier, reference, expected = { width, height }) {
  const bytes = await fs.readFile(filename);
  assert.ok(bytes.includes(Buffer.from(identifier)), 'Photo and MOV must contain the same pairing UUID.');
  let info, decoded = filename + '.png';
  if (nativeReader) {
    info = JSON.parse(command(nativeReader, [filename, decoded]));
    assert.equal(info.identifier, identifier, 'Native ImageIO must read MakerApple 17.');
    assert.equal(info.type, filename.endsWith('.HEIC') ? 'public.heic' : 'public.jpeg');
  } else {
    const stream = probe(filename).streams.find(stream => stream.codec_type === 'video');
    info = { width: stream.width, height: stream.height, nativeMetadataRead: false };
    command('ffmpeg', ['-y', '-v', 'error', '-i', filename, '-frames:v', '1', decoded]);
  }
  assert.equal(info.width, expected.width); assert.equal(info.height, expected.height);
  return { filename, bytes: bytes.length, ...info, ...similarity(reference, decoded) };
}
async function prepareNativeReader() {
  if (process.platform !== 'darwin') return;
  const swift = path.join(temporary, 'inspect.swift'); nativeReader = path.join(temporary, 'inspect-photo');
  await fs.writeFile(swift, `import Foundation
import ImageIO
import UniformTypeIdentifiers
let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, nil)!
let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)! as NSDictionary
let maker = properties[kCGImagePropertyMakerAppleDictionary] as! NSDictionary
let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[2]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, image, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("PNG conversion failed") }
let output: [String: Any] = ["type": CGImageSourceGetType(source)! as String, "width": image.width, "height": image.height, "identifier": maker["17"]!]
print(String(data: try! JSONSerialization.data(withJSONObject: output), encoding: .utf8)!)
`);
  // Compiler startup and actual decoding have separate timeout budgets.
  command('swiftc', [swift, '-o', nativeReader], 180000);
}
async function main() {
  await fs.mkdir(output, { recursive: true });
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-live-quality-'));
  await prepareNativeReader();
  const outputs = path.join(temporary, 'exports'); await fs.mkdir(outputs);
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  await fs.writeFile(path.join(temporary, 'package.json'), JSON.stringify({ name: metadata.name, version: metadata.version, productName: metadata.productName, main: 'bootstrap.cjs' }));
  await fs.writeFile(path.join(temporary, 'bootstrap.cjs'), `const { app, session } = require('electron');
global.__xhsLiveQualityDownloads = []; global.__xhsLiveQualityNetwork = []; const sessions = new WeakSet();
function offline(value) {
  if (sessions.has(value)) return; sessions.add(value);
  for (const scheme of ['http', 'https']) value.protocol.handle(scheme, request => {
    global.__xhsLiveQualityNetwork.push(request.url);
    if (new URL(request.url).pathname.startsWith('/api/account/')) return Response.json({ user: null, csrf: 'fixture', googleEnabled: false, passwordEnabled: true });
    return new Response('<!doctype html><title>Offline quality verification</title>');
  });
  value.on('will-download', (_event, item) => {
    const entry = { path: ${JSON.stringify(outputs)} + '/' + global.__xhsLiveQualityDownloads.length + '-' + item.getFilename(), state: 'progressing' };
    global.__xhsLiveQualityDownloads.push(entry); item.setSavePath(entry.path);
    item.once('done', (_event, state) => { entry.state = state; });
  });
}
app.on('session-created', offline); app.whenReady().then(() => offline(session.defaultSession));
require(${JSON.stringify(path.join(root, 'desktop/main.cjs'))});
`);
  electronApp = await _electron.launch({ executablePath: require('electron'), args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), temporary],
    env: { ...process.env, BRCLIO_USER_DATA: path.join(temporary, 'user-data'), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }, timeout: 30000 });
  page = await electronApp.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.consoleErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  await page.evaluate(() => {
    window.__liveQualityConfigs = [];
    const configure = VideoEncoder.prototype.configure, encode = VideoEncoder.prototype.encode;
    VideoEncoder.prototype.configure = function (config) { window.__liveQualityConfigs.push(structuredClone(config)); window.__liveQualityInput = null; return configure.call(this, config); };
    VideoEncoder.prototype.encode = function (frame, options) {
      if (!window.__liveQualityInput) {
        const canvas = document.createElement('canvas'); canvas.width = frame.displayWidth; canvas.height = frame.displayHeight;
        canvas.getContext('2d').drawImage(frame, 0, 0);
        window.__liveQualityInput = { width: frame.displayWidth, height: frame.displayHeight, codedWidth: frame.codedWidth,
          codedHeight: frame.codedHeight, format: frame.format, png: canvas.toDataURL('image/png').split(',')[1] };
      }
      return encode.call(this, frame, options);
    };
  });
  assert.match(page.url(), /^file:\/\//);
  report.origin = page.url(); report.csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  await page.locator('[data-view="xhs"]').first().click(); await page.locator('#xhs-tab-live').click();
  await page.locator('#xhs-live-support').filter({ hasText: '支持本地制作' }).waitFor();
  // Fine grayscale texture measures spatial detail independently of chroma
  // subsampling. Larger color patches and text also exercise normal artwork.
  const fixture = await page.evaluate(({ width, height }) => {
    const canvas = document.createElement('canvas'); Object.assign(canvas, { width, height });
    const context = canvas.getContext('2d'), pixels = context.createImageData(width, height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const value = 45 + ((x >> 1) % 2) * 42 + ((y >> 2) % 2) * 38 + Math.round(45 * x / width);
      pixels.data[at] = pixels.data[at + 1] = pixels.data[at + 2] = value; pixels.data[at + 3] = 255;
    }
    context.putImageData(pixels, 0, 0); context.fillStyle = '#f6f1e5'; context.fillRect(300, 400, 2400, 500);
    context.fillStyle = '#202f35'; context.font = 'bold 92px sans-serif'; context.fillText('Brclio 4K · Source detail 3840 × 2160', 350, 550);
    context.font = '24px monospace'; context.fillText('Fine text / 2 px lines / 4 px texture / native resolution', 350, 650);
    context.fillStyle = '#dc5537'; context.fillRect(2900, 450, 300, 300); context.fillStyle = '#267c9c'; context.fillRect(3250, 450, 300, 300);
    return canvas.toDataURL('image/png').split(',')[1];
  }, { width, height });
  const reference = path.join(output, 'source-4k.png'); await fs.writeFile(reference, Buffer.from(fixture, 'base64'));
  const reduced = path.join(output, 'simulated-1440-limit.png');
  command('ffmpeg', ['-y', '-v', 'error', '-i', reference,
    '-vf', `scale=1440:810:flags=lanczos,scale=${width}:${height}:flags=lanczos`, '-frames:v', '1', reduced]);
  report.reducedResolutionBaseline = { name: 'Simulated former 1440px limit, resampled to source size', ...similarity(reference, reduced, 0) };
  assert.ok(report.reducedResolutionBaseline.lumaSsim < .97, 'The source fixture must detect detail lost by the former 1440px cap.');
  await page.locator('#xhs-live-files').setInputFiles(reference);
  await page.locator('#xhs-live-source-info').filter({ hasText: `${width} × ${height}` }).waitFor();
  await field('duration', .5); await field('cover', .2); await page.locator('#xhs-live-motion').selectOption('still');
  for (const format of report.formats) {
    await page.locator('#xhs-live-format').selectOption(format);
    await generate();
    const movie = await exportFile('mov', path.join(output, `${format}-4k.MOV`));
    const photo = await exportFile('photo', path.join(output, `${format}-4k.${format === 'heic' ? 'HEIC' : 'JPG'}`));
    const motion = await inspectMovie(movie, reference);
    report.checks.push({ name: `4K image to ${format.toUpperCase()} + MOV`, motion, photo: await inspectPhoto(photo, motion.identifier, reference) });
  }
  const videoSource = path.join(output, 'source-4k.mp4');
  command('ffmpeg', ['-y', '-v', 'error', '-loop', '1', '-framerate', '30', '-i', reference, '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-bf', '0', '-pix_fmt', 'yuv420p', videoSource], 120000);
  const videoReference = path.join(output, 'source-video-frame.png');
  command('ffmpeg', ['-y', '-v', 'error', '-ss', '0.2', '-i', videoSource, '-frames:v', '1', videoReference]);
  await page.locator('#xhs-live-files').setInputFiles(videoSource);
  await page.locator('#xhs-live-source-info').filter({ hasText: '视频' }).waitFor();
  await field('duration', .5); await field('cover', .2); await page.locator('#xhs-live-format').selectOption('jpeg');
  if (await page.locator('#xhs-live-audio').isEnabled()) await page.locator('#xhs-live-audio').uncheck();
  await generate();
  const movie = await exportFile('mov', path.join(output, 'video-4k.MOV'));
  const photo = await exportFile('photo', path.join(output, 'video-4k.JPG'));
  const motion = await inspectMovie(movie, videoReference);
  report.checks.push({ name: '4K video clip to JPG + MOV', motion, photo: await inspectPhoto(photo, motion.identifier, videoReference) });
  // A common 24 MP photo must keep all its still-image pixels even when the
  // local H.264 encoder cannot accept its full frame size.
  const largeReference = path.join(output, 'source-24mp.png');
  const largeFixture = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 6000; canvas.height = 4000;
    const context = canvas.getContext('2d'); context.fillStyle = '#faf6eb'; context.fillRect(0, 0, 6000, 4000);
    context.fillStyle = '#454452';
    for (let x = 0; x < 6000; x += 8) context.fillRect(x, 0, 2, 4000);
    context.fillStyle = '#f4d758'; context.fillRect(500, 1300, 4500, 600);
    context.fillStyle = '#1a1a2e'; context.font = 'bold 120px sans-serif'; context.fillText('24 MP · 6000 × 4000 original photo', 650, 1650);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await fs.writeFile(largeReference, Buffer.from(largeFixture, 'base64'));
  const nativeVideoSupported = await page.evaluate(async () => {
    const module = await import('./xhs/lib/live-photo-maker.js');
    return (await VideoEncoder.isConfigSupported(module.livePhotoVideoConfig(6000, 4000))).supported;
  });
  await page.locator('#xhs-live-files').setInputFiles(largeReference);
  await page.locator('#xhs-live-source-info').filter({ hasText: '6000 × 4000' }).waitFor();
  await field('duration', .5); await field('cover', .2); await page.locator('#xhs-live-motion').selectOption('still');
  await generate();
  assert.match(await page.locator('#xhs-live-result-info').textContent(), /照片 6000 × 4000/);
  await page.waitForFunction(() => { const image = document.querySelector('#xhs-live-preview-image'); return image.naturalWidth === 6000 && image.naturalHeight === 4000; });
  const largeMovie = await exportFile('mov', path.join(output, 'photo-24mp.MOV'));
  const largePhoto = await exportFile('photo', path.join(output, 'photo-24mp.JPG'));
  const largeStream = probe(largeMovie).streams.find(stream => stream.codec_type === 'video');
  assert.ok(largeStream.width <= 6000 && largeStream.height <= 4000);
  assert.ok(Math.abs(largeStream.width / largeStream.height - 1.5) < .002);
  if (nativeVideoSupported) { assert.equal(largeStream.width, 6000); assert.equal(largeStream.height, 4000); }
  else {
    assert.ok(largeStream.width < 6000 && largeStream.height < 4000, 'Unsupported native H.264 must use an explicit motion-only fallback.');
    assert.equal(largeStream.width % 16, 0); assert.equal(largeStream.height % 16, 0, 'Fallback dimensions must avoid hidden large-frame encoder resampling.');
  }
  // The fallback deliberately changes spatial resolution. Capture its real
  // encoder input and compare at that size. Compare the native photo against
  // the original 24 MP source independently below.
  const encoderConfig = await page.evaluate(() => window.__liveQualityConfigs.at(-1));
  assert.match(encoderConfig.codec, /^avc1\.6400/); assert.equal(encoderConfig.latencyMode, 'realtime');
  assert.equal(encoderConfig.width, largeStream.width); assert.equal(encoderConfig.height, largeStream.height);
  assert.ok(encoderConfig.bitrate >= largeStream.width * largeStream.height * 30 * .25, 'Fallback must keep a high quality video bitrate target.');
  const encoderInput = await page.evaluate(() => window.__liveQualityInput);
  assert.equal(encoderInput.width, largeStream.width); assert.equal(encoderInput.height, largeStream.height);
  const encoderReference = path.join(output, 'photo-24mp-encoder-input.png');
  await fs.writeFile(encoderReference, Buffer.from(encoderInput.png, 'base64'));
  delete encoderInput.png;
  const largeMotion = { ...await inspectMovie(largeMovie, encoderReference, largeStream), encoderConfig, encoderInput,
    comparisonReference: 'Actual first VideoFrame input at the supported motion resolution; native photo compared to original pixels separately.' };
  report.checks.push({ name: '24 MP photo keeps original still/cover pixels with highest supported H.264 motion size', nativeVideoSupported,
    preview: { width: 6000, height: 4000 }, motion: largeMotion,
    photo: await inspectPhoto(largePhoto, largeMotion.identifier, largeReference, { width: 6000, height: 4000 }) });
  await page.screenshot({ path: path.join(output, 'result.png'), fullPage: true });
  report.interceptedNetwork = await electronApp.evaluate(() => global.__xhsLiveQualityNetwork);
  assert.deepEqual(report.consoleErrors, []); report.passed = true;
}
main().catch(error => { report.error = error.stack || String(error); process.exitCode = 1; }).finally(async () => {
  if (page && !report.passed) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await electronApp?.close().catch(() => {});
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, report: reportPath, ...(report.error ? { error: report.error } : {}) }));
});

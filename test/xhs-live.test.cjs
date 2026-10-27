// Migrated from brclio-xhs-media-downloader a818212fc0d4450f8cf192e644cdc2f39103e810.
// Independent container readers and native decoder checks are retained.
const suite = require('node:test');

suite('live-photo-maker', async context => {
  const test = (...args) => context.test(...args);
const { default: assert } = await import('node:assert/strict');
const { LIVE_PHOTO_LIMITS, validateLivePhotoFiles, normalizeLivePhotoOptions, livePhotoDimensions,
  livePhotoCoverTime, livePhotoVideoConfig, selectLivePhotoVideoConfig, checkLivePhotoSupport } = await import('../web/xhs/lib/live-photo-maker.js');

const file = (name, type, size = 10) => ({ name, type, size, arrayBuffer: async () => new ArrayBuffer(size) });

await test('local maker accepts one video or an ordered image sequence and rejects ambiguous inputs', () => {
  assert.equal(validateLivePhotoFiles([file('clip.MOV', '')]), 'video');
  assert.equal(validateLivePhotoFiles([file('1.jpg', 'image/jpeg'), file('2.webp', 'image/webp')]), 'images');
  assert.throws(() => validateLivePhotoFiles([]), /请选择/);
  assert.throws(() => validateLivePhotoFiles([file('image.jpg', 'image/jpeg'), file('clip.mp4', 'video/mp4')]), /不能混合/);
  assert.throws(() => validateLivePhotoFiles([file('a.mp4', 'video/mp4'), file('b.mp4', 'video/mp4')]), /一个视频/);
  assert.throws(() => validateLivePhotoFiles([file('bad.pdf', 'application/pdf')]), /可读取/);
  assert.throws(() => validateLivePhotoFiles([file('empty.jpg', 'image/jpeg', 0)]), /为空/);
  assert.throws(() => validateLivePhotoFiles(Array.from({ length: 13 }, () => file('1.jpg', 'image/jpeg'))), /12/);
  assert.throws(() => validateLivePhotoFiles([file('huge.mp4', 'video/mp4', LIVE_PHOTO_LIMITS.maxBytes + 1)]), /150 MB/);
});

await test('clip bounds and cover position are validated before encoding', () => {
  const options = { kind: 'video', sourceDuration: 5, start: 2, duration: 3, keyPhotoTime: 1.5 };
  assert.equal(normalizeLivePhotoOptions(options).start, 2);
  assert.throws(() => normalizeLivePhotoOptions({ ...options, start: 2.01 }), /超出/);
  assert.throws(() => normalizeLivePhotoOptions({ ...options, start: -1 }), /起点/);
  assert.throws(() => normalizeLivePhotoOptions({ ...options, duration: 8.01 }), /0.5 至 8/);
  assert.throws(() => normalizeLivePhotoOptions({ ...options, duration: 0.49 }), /0.5 至 8/);
  assert.throws(() => normalizeLivePhotoOptions({ ...options, keyPhotoTime: 3 }), /封面/);
  assert.throws(() => normalizeLivePhotoOptions({ ...options, keyPhotoTime: -1 }), /封面/);
  assert.throws(() => normalizeLivePhotoOptions({ ...options, duration: NaN }), /时长/);
  assert.throws(() => normalizeLivePhotoOptions({ ...options, motion: 'other' }), /动效/);
  assert.throws(() => normalizeLivePhotoOptions({ ...options, sourceDuration: 0.3, start: 0 }), /超出/);
});

await test('video speed selects a longer source interval while images keep their original timing', () => {
  for (const speed of [1, 1.5, 2, 3]) {
    const result = normalizeLivePhotoOptions({ kind: 'video', sourceDuration: 25, start: 1,
      duration: 8, keyPhotoTime: 7.999, speed });
    assert.equal(result.speed, speed);
    assert.equal(result.sourceSpan, 8 * speed);
    assert.equal(result.keyPhotoTime, 239 / 30);
  }
  const options = { kind: 'video', sourceDuration: 6, start: 0, duration: 3, speed: 2 };
  assert.equal(normalizeLivePhotoOptions(options).sourceSpan, 6);
  assert.throws(() => normalizeLivePhotoOptions({ ...options, start: 0.01 }), /超出/);
  assert.throws(() => normalizeLivePhotoOptions({ ...options, speed: 3 }), /超出/);
  for (const speed of [0, 0.5, 1.25, 4, NaN, Infinity, '2'])
    assert.throws(() => normalizeLivePhotoOptions({ ...options, speed }), /倍速/);
  assert.equal(normalizeLivePhotoOptions({ kind: 'images', duration: 8 }).sourceSpan, 8);
  assert.throws(() => normalizeLivePhotoOptions({ kind: 'images', duration: 3, speed: 1.5 }), /图片制作不支持/);
});

await test('cover time points at a real encoded frame including a fractional final frame', () => {
  assert.equal(livePhotoCoverTime(0.5, 0), 0);
  assert.equal(livePhotoCoverTime(0.5, 0.499999), 14 / 30);
  assert.equal(livePhotoCoverTime(0.5001, 0.500099), 0.5);
  assert.equal(livePhotoCoverTime(0.5000001, 0.50000009), 14 / 30);
  assert.equal(livePhotoCoverTime(2 / 3, 2 / 3 - 1e-10), 19 / 30);
  assert.equal(livePhotoCoverTime(1.5, 0.75), 23 / 30);
  assert.equal(livePhotoCoverTime(8, 7.999999), 239 / 30);
  assert.equal(normalizeLivePhotoOptions({ kind: 'images', duration: 0.5001,
    keyPhotoTime: 0.500099 }).keyPhotoTime, 0.5);
  assert.equal(normalizeLivePhotoOptions({ kind: 'images', duration: 0.5000001 }).duration, 0.5);
  for (const key of [-1, 0.5, Infinity, NaN])
    assert.throws(() => livePhotoCoverTime(0.5, key), /封面/);
  for (const duration of [0.49, 8.001, NaN])
    assert.throws(() => livePhotoCoverTime(duration, 0), /时长/);
});

await test('a failed video or audio support probe does not suppress the other capability', async t => {
  const names = ['VideoEncoder', 'VideoFrame', 'AudioEncoder', 'AudioData', 'AudioContext', 'MediaRecorder'];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const set = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, value });
  for (const name of ['VideoFrame', 'AudioData', 'AudioContext']) set(name, class {});
  set('MediaRecorder', { isTypeSupported: () => true });
  set('VideoEncoder', { isConfigSupported: async () => { throw new Error('Video encoder unavailable'); } });
  set('AudioEncoder', { isConfigSupported: async () => ({ supported: true }) });
  let support = await checkLivePhotoSupport();
  assert.equal(support.supported, false);
  assert.equal(support.audioSupported, true);
  set('VideoEncoder', { isConfigSupported: async () => ({ supported: true }) });
  set('AudioEncoder', { isConfigSupported: async () => { throw new Error('Audio encoder unavailable'); } });
  support = await checkLivePhotoSupport();
  assert.equal(support.supported, true);
  assert.equal(support.audioSupported, false);
});

await test('trusted desktop videos have no browser byte cap while web and image protections remain', t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const previousBridge = Object.getOwnPropertyDescriptor(globalThis, 'brclio');
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'location', previous); else delete globalThis.location; if (previousBridge) Object.defineProperty(globalThis, 'brclio', previousBridge); else delete globalThis.brclio; });
  const large = file('large.mp4', 'video/mp4', 5 * 1024 ** 3);
  large.arrayBuffer = () => { throw new Error('Full source must not be read into memory'); };
  for (const origin of ['https://example.test/live.html?source=desktop', 'brclio-xhs://other/live.html', 'file:///tmp/ordinary.html']) {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL(origin) });
    assert.throws(() => validateLivePhotoFiles([large]), /150 MB/);
  }
  Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL('brclio-xhs://local/live.html?source=desktop') });
  assert.equal(validateLivePhotoFiles([large]), 'video');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL('file:///Applications/Brclio.app/Contents/Resources/app.asar/web/index.html') });
  Object.defineProperty(globalThis, 'brclio', { configurable: true, value: Object.freeze({ xhsRequest() {} }) });
  assert.equal(validateLivePhotoFiles([large]), 'video', 'real Brclio file document keeps streaming large videos');
  assert.throws(() => validateLivePhotoFiles([file('huge.jpg', 'image/jpeg', LIVE_PHOTO_LIMITS.maxBytes + 1)]), /150 MB/);
  assert.throws(() => validateLivePhotoFiles([large, file('another.mp4', 'video/mp4')]), /一个视频/);
});

await test('encoding retains native 4K and photo resolution without silently downscaling', () => {
  assert.deepEqual(livePhotoDimensions(3840, 2160), { width: 3840, height: 2160 });
  assert.deepEqual(livePhotoDimensions(1080, 1920), { width: 1080, height: 1920 });
  assert.deepEqual(livePhotoDimensions(6000, 4000), { width: 6000, height: 4000 });
  assert.deepEqual(livePhotoDimensions(641, 479), { width: 640, height: 478 });
  assert.deepEqual(livePhotoDimensions(10, 10), { width: 10, height: 10 });
  assert.throws(() => livePhotoDimensions(0, 1080), /尺寸/);
  assert.throws(() => livePhotoDimensions(100, Infinity), /尺寸/);
  assert.throws(() => livePhotoDimensions(9000, 6000), /8192/);
  assert.throws(() => livePhotoDimensions(8192, 8192), /6400 万/);
});

await test('video quality scales with source resolution while retaining a muxable no-B-frame configuration', () => {
  const hd = livePhotoVideoConfig(1920, 1080), uhd = livePhotoVideoConfig(3840, 2160);
  assert.ok(hd.bitrate >= 24000000);
  assert.ok(uhd.bitrate >= hd.bitrate * 4);
  assert.equal(uhd.latencyMode, 'realtime');
  assert.equal(uhd.bitrateMode, 'variable');
  assert.equal(uhd.avc.format, 'avc');
  assert.equal(uhd.codec, 'avc1.640033');
  assert.equal(livePhotoVideoConfig(4096, 2304).codec, 'avc1.640034');
  assert.equal(livePhotoVideoConfig(6000, 4000).codec, 'avc1.64003c');
});

await test('movie resolution uses native pixels when supported and probes a high-quality device fallback separately', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'VideoEncoder');
  t.after(() => previous ? Object.defineProperty(globalThis, 'VideoEncoder', previous) : delete globalThis.VideoEncoder);
  const probed = [];
  Object.defineProperty(globalThis, 'VideoEncoder', { configurable: true, value: { isConfigSupported: async config => {
    probed.push(config);
    return { supported: config.width * config.height <= 3840 * 2160 };
  } } });
  const native = await selectLivePhotoVideoConfig({ width: 3840, height: 2160 });
  assert.deepEqual([native.width, native.height], [3840, 2160]);
  assert.equal(probed.length, 1, 'A supported native source is never downscaled.');
  probed.length = 0;
  const movie = await selectLivePhotoVideoConfig({ width: 6000, height: 4000 });
  assert.deepEqual([probed[0].width, probed[0].height], [6000, 4000]);
  assert.ok(movie.width > 3000 && movie.height > 2000, 'A large photo uses the available movie pixel budget.');
  assert.ok(Math.abs(movie.width / movie.height - 1.5) < .01);
  assert.equal(movie.width % 16, 0); assert.equal(movie.height % 16, 0);
  Object.defineProperty(globalThis, 'VideoEncoder', { configurable: true, value: { isConfigSupported: async config =>
    ({ supported: config.codec === 'avc1.640034' }) } });
  const largestAvc = await selectLivePhotoVideoConfig({ width: 6000, height: 4000 });
  assert.ok(largestAvc.width * largestAvc.height > 9_000_000, 'Macroblock padding must not skip a supported level-5.2 frame.');
  assert.ok(Math.ceil(largestAvc.width / 16) * Math.ceil(largestAvc.height / 16) <= 36864);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(selectLivePhotoVideoConfig({ width: 3840, height: 2160 }, { signal: controller.signal }), { name: 'AbortError' });
});

});

suite('live-photo-format', async context => {
  const test = (...args) => context.test(...args);
const { default: assert } = await import('node:assert/strict');
const { execFileSync, spawnSync } = await import('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { muxLivePhotoMov, pairLivePhotoJpeg, validateLivePhotoOptions } = await import('../web/xhs/lib/live-photo-format.js');

const id = "01234567-89AB-CDEF-0123-456789ABCDEF";
const config = Uint8Array.from([1, 66, 0, 30, 255, 225, 0, 2, 0x67, 0, 1, 0, 2, 0x68, 0]);
function options() {
  return { samples: [{ data: Uint8Array.from([0, 0, 0, 2, 0x65, 0]), timestamp: 0, duration: 500000, keyFrame: true }], decoderConfig: config, width: 32, height: 32, duration: 0.5, keyPhotoTime: 0.25, assetIdentifier: id };
}

// A reader independent of the container writer. It checks actual table offsets
// and sample bytes; finding strings alone would accept an ordinary tagged MOV.
function atoms(bytes, start = 0, end = bytes.length) {
  const items = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = start; offset < end;) {
    assert.ok(offset + 8 <= end, "complete atom header");
    const size = view.getUint32(offset);
    assert.ok(size >= 8 && offset + size <= end, "valid atom size");
    items.push({ type: Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString("latin1"), start: offset, data: offset + 8, end: offset + size });
    offset += size;
  }
  return items;
}
function child(bytes, parent, type) { const result = atoms(bytes, parent.data, parent.end).find(item => item.type === type); assert.ok(result, `found ${type}`); return result; }
function uint(bytes, offset) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset); }

await test("MOV contains matching movie identifier and a timed int8 mebx sample at the key-photo time", () => {
  const data = muxLivePhotoMov(options());
  const boxes = atoms(data);
  const moov = boxes.find(box => box.type === "moov");
  const tracks = atoms(data, moov.data, moov.end).filter(box => box.type === "trak");
  assert.equal(tracks.length, 2);
  const meta = child(data, moov, "meta");
  const list = child(data, meta, "ilst");
  const item = atoms(data, list.data, list.end)[0];
  const value = child(data, item, "data");
  assert.equal(Buffer.from(data.subarray(value.data + 8, value.end)).toString(), id);
  const metadataTrack = tracks[1];
  const edit = child(data, child(data, metadataTrack, "edts"), "elst");
  assert.equal(uint(data, edit.data + 4), 2);
  assert.equal(uint(data, edit.data + 8), 250000);
  assert.equal(uint(data, edit.data + 12), 0xffffffff);
  const stbl = child(data, child(data, child(data, metadataTrack, "mdia"), "minf"), "stbl");
  const stsd = child(data, stbl, "stsd");
  const sample = atoms(data, stsd.data + 8, stsd.end)[0];
  assert.equal(sample.type, "mebx");
  const key = atoms(data, child(data, { ...sample, data: sample.data + 8 }, "keys").data, sample.end)[0];
  const keyd = child(data, key, "keyd");
  assert.equal(Buffer.from(data.subarray(keyd.data, keyd.end)).toString(), "mdtacom.apple.quicktime.still-image-time");
  const dtyp = child(data, key, "dtyp");
  assert.equal(uint(data, dtyp.data + 4), 65);
  const stco = child(data, stbl, "stco");
  const payloadOffset = uint(data, stco.data + 8);
  assert.deepEqual([...data.subarray(payloadOffset, payloadOffset + 9)], [0, 0, 0, 9, 0, 0, 0, 1, 255]);
});

await test("JPEG pairs through the Apple maker note while preserving image scan bytes and replacing stale EXIF", () => {
  const source = Uint8Array.from([255, 216, 255, 225, 0, 10, 69, 120, 105, 102, 0, 0, 0, 0, 255, 218, 0, 2, 12, 34, 255, 217]);
  const data = pairLivePhotoJpeg(source, id);
  assert.deepEqual([...data.slice(-8)], [255, 218, 0, 2, 12, 34, 255, 217]);
  const tiffStart = 12;
  assert.equal(Buffer.from(data.subarray(tiffStart, tiffStart + 2)).toString(), "MM");
  const view = new DataView(data.buffer);
  const ifd = tiffStart + view.getUint32(tiffStart + 4);
  assert.equal(view.getUint16(ifd), 2);
  const exif = tiffStart + view.getUint32(ifd + 2 + 12 + 8);
  assert.equal(view.getUint16(exif + 2), 0x927c);
  const note = tiffStart + view.getUint32(exif + 10);
  assert.equal(Buffer.from(data.subarray(note, note + 10)).toString(), "Apple iOS\0");
  assert.equal(view.getUint16(note + 16), 17);
  const uuid = note + view.getUint32(note + 24);
  assert.equal(Buffer.from(data.subarray(uuid, uuid + 36)).toString(), id);
  assert.equal(Buffer.from(data).toString().split("Exif\0\0").length, 2);
  assert.equal(Buffer.from(pairLivePhotoJpeg(data, id)).toString().split("Exif\0\0").length, 2);
});

await test("strict validation rejects mislabeled Annex B, missing codec config, reordered timestamps, and excessive duration", () => {
  assert.throws(() => validateLivePhotoOptions({ ...options(), duration: 8.1 }), /duration/);
  assert.throws(() => validateLivePhotoOptions({ ...options(), keyPhotoTime: 0.5 }), /keyPhotoTime/);
  assert.throws(() => validateLivePhotoOptions({ ...options(), assetIdentifier: "bad" }), /UUID/);
  assert.throws(() => validateLivePhotoOptions({ ...options(), decoderConfig: new Uint8Array([1]) }), /configuration/);
  assert.throws(() => validateLivePhotoOptions({ ...options(), samples: [{ ...options().samples[0], timestamp: 1000 }] }), /contiguous/);
  assert.throws(() => validateLivePhotoOptions({ ...options(), samples: [{ ...options().samples[0], keyFrame: false }] }), /key frame/);
  assert.throws(() => validateLivePhotoOptions({ ...options(), samples: [{ ...options().samples[0], data: new Uint8Array([0, 0, 0, 1, 0x65, 0]) }] }), /AVC/);
  assert.throws(() => validateLivePhotoOptions({ ...options(), audio: { sampleRate: 44100, channels: 2, decoderConfig: new Uint8Array([0x11, 0x90]), samples: [{ data: new Uint8Array([1]), timestamp: 0, duration: 500000 }] } }), /sample rate/);
  assert.throws(() => pairLivePhotoJpeg(new Uint8Array([255, 216, 255, 217]), id), /scan/);
});

await test("eight-second video and AAC retain final packets and key-photo timed metadata", () => {
  const input = options();
  const durationUs = 8_000_000;
  input.duration = 8;
  input.keyPhotoTime = 239 / 30;
  input.samples = Array.from({ length: 240 }, (_, index) => {
    const timestamp = Math.round(index / 30 * 1e6);
    return { ...options().samples[0], timestamp,
      duration: Math.round((index + 1) / 30 * 1e6) - timestamp, keyFrame: index % 30 === 0 };
  });
  input.audio = { sampleRate: 48000, channels: 2, decoderConfig: new Uint8Array([0x11, 0x90]),
    samples: Array.from({ length: 375 }, (_, index) => {
      const timestamp = Math.round(index * 1024 / 48000 * 1e6);
      return { data: new Uint8Array([1]), timestamp,
        duration: Math.round((index + 1) * 1024 / 48000 * 1e6) - timestamp };
    }) };
  const normalized = validateLivePhotoOptions(input);
  assert.equal(normalized.samples.at(-1).timestamp + normalized.samples.at(-1).duration, durationUs);
  assert.equal(normalized.audio.samples.at(-1).timestamp + normalized.audio.samples.at(-1).duration, durationUs);
  const data = muxLivePhotoMov(input), moov = atoms(data).find(box => box.type === 'moov');
  const tracks = atoms(data, moov.data, moov.end).filter(box => box.type === 'trak');
  assert.equal(tracks.length, 3);
  for (const track of tracks.slice(0, 2)) {
    const header = child(data, child(data, track, 'mdia'), 'mdhd');
    assert.equal(uint(data, header.data + 16), durationUs);
  }
  const edit = child(data, child(data, tracks[2], 'edts'), 'elst');
  assert.equal(uint(data, edit.data + 8), Math.round(input.keyPhotoTime * 1e6));
  const metadata = child(data, child(data, tracks[2], 'mdia'), 'mdhd');
  assert.equal(uint(data, metadata.data + 16), 33333);
  const lastFrame = input.samples.at(-1);
  assert.throws(() => validateLivePhotoOptions({ ...input,
    samples: [...input.samples.slice(0, -1), { ...lastFrame, timestamp: durationUs }] }), /timestamp/);
});

await test("AAC padding is capped by an edit while the media sample remains complete", () => {
  const input = options();
  input.audio = { sampleRate: 48000, channels: 2, decoderConfig: new Uint8Array([0x11, 0x90]), samples: [{ data: new Uint8Array([1, 2]), timestamp: 0, duration: 520000 }] };
  const data = muxLivePhotoMov(input);
  const moov = atoms(data).find(atom => atom.type === "moov");
  const audioTrack = atoms(data, moov.data, moov.end).filter(atom => atom.type === "trak")[1];
  const mdhd = child(data, child(data, audioTrack, "mdia"), "mdhd");
  assert.equal(uint(data, mdhd.data + 16), 520000);
  const edit = child(data, child(data, audioTrack, "edts"), "elst");
  assert.equal(uint(data, edit.data + 8), 500000);
});

const hasFFmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 && spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;
await test("independent ffprobe and decoder read real AVC/AAC output with a timed metadata track", { skip: !hasFFmpeg }, t => {
  const directory = mkdtempSync(join(tmpdir(), "brclio-live-photo-format-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixturePath = join(directory, "source.mov");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=32x32:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1", "-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", fixturePath]);
  const fixture = readFileSync(fixturePath);
  const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_packets", "-of", "json", fixturePath]));
  function record(type) { const at = fixture.indexOf(type); assert.ok(at >= 4); return fixture.subarray(at + 4, at - 4 + fixture.readUInt32BE(at - 4)); }
  const videoPackets = info.packets.filter(packet => packet.stream_index === 0);
  const video = videoPackets.map((packet, index) => ({ data: fixture.subarray(Number(packet.pos), Number(packet.pos) + Number(packet.size)), timestamp: Math.round(index / 30 * 1e6), duration: Math.round((index + 1) / 30 * 1e6) - Math.round(index / 30 * 1e6), keyFrame: packet.flags.includes("K") }));
  const audioPackets = info.packets.filter(packet => packet.stream_index === 1 && Number(packet.pts_time) >= 0);
  const audio = audioPackets.map(packet => ({ data: fixture.subarray(Number(packet.pos), Number(packet.pos) + Number(packet.size)), timestamp: Math.round(Number(packet.pts_time) * 1e6), duration: Math.round(Number(packet.duration_time) * 1e6) }));
  const output = muxLivePhotoMov({ ...options(), duration: 1, keyPhotoTime: 0.5, samples: video, decoderConfig: record("avcC"), audio: { samples: audio, decoderConfig: new Uint8Array([0x11, 0x90]), sampleRate: 48000, channels: 2 } });
  const outputPath = join(directory, "paired.mov");
  writeFileSync(outputPath, output);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-show_packets", "-of", "json", outputPath]));
  assert.equal(probe.format.tags["com.apple.quicktime.content.identifier"], id);
  assert.equal(Number(probe.format.duration), 1);
  assert.equal(probe.streams[0].codec_name, "h264");
  assert.equal(probe.streams[0].width, 32);
  assert.equal(probe.streams[1].codec_name, "aac");
  assert.equal(probe.streams[1].sample_rate, "48000");
  assert.equal(probe.streams[1].channels, 2);
  const metadata = probe.streams.find(stream => stream.codec_tag_string === "mebx");
  assert.ok(metadata, "real timed metadata stream");
  const timedPacket = probe.packets.find(packet => packet.stream_index === metadata.index);
  assert.equal(Number(timedPacket.pts_time), 0.5);
  assert.equal(Number(timedPacket.size), 9);
  execFileSync("ffmpeg", ["-v", "error", "-i", outputPath, "-map", "0:v", "-map", "0:a", "-f", "null", "-"], { stdio: "pipe" });
});

});

suite('live-photo-heic', async context => {
  const test = (...args) => context.test(...args);
const { default: assert } = await import('node:assert/strict');
const { execFileSync } = await import('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join: pathJoin } = await import('node:path');
const { muxHeicStill, pairLivePhotoHeic } = await import('../web/xhs/lib/live-photo-heic.js');

const id = "01234567-89AB-CDEF-0123-456789ABCDEF";
const secondId = "FEDCBA98-7654-3210-FEDC-BA9876543210";
// A real 160×96 blue image encoded by Apple's HEVC WebCodecs encoder. Keeping
// this tiny fixture in the test makes browser/Node checks independent of codecs.
const sample = new Uint8Array(Buffer.from("AAAAJygBrwrbLE1AU3/7Ae73yE//7qXv6j29b/T1Ht620N4tu9NH22y2wA==", "base64"));
const config = new Uint8Array(Buffer.from("AQFgAAAAsAAAAAAAP/AA/P34+AAAFwOgAAEAGkABDAP//wFgAAADALAAAAMAAAMAPwAABDAkoQABAFRCAQMBYAAAAwCwAAADAAADAD8AAKAUIGFiAQ7kUggufhPQvqG9UP6qCPVUE+qqCvVVQX6qqgz1VVQb6qqqDvVVVUH+qqqqBD1VVVUpqAgICB/CAQSiAAEAB0QBwHLwWyQ=", "base64"));
const encode = value => new Uint8Array(Buffer.from(value, "latin1"));
const concat = (...parts) => new Uint8Array(Buffer.concat(parts));
function integer(value, width) { const output = Buffer.alloc(width); output.writeUIntBE(value, 0, width); return output; }
const short = value => integer(value, 2), uint = value => integer(value, 4);
const atom = (type, ...parts) => { const body = concat(...parts); return concat(uint(body.length + 8), encode(type), body); };
const full = (type, version, flags, ...parts) => atom(type, uint(version * 0x1000000 + flags), ...parts);
function atoms(data, start = 0, end = data.length) {
  const output = [], view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  while (start < end) {
    let size = view.getUint32(start), header = 8;
    if (size === 1) { size = Number(view.getBigUint64(start + 8)); header = 16; }
    if (!size) size = end - start;
    assert.ok(size >= header && start + size <= end);
    output.push({ type: Buffer.from(data.subarray(start + 4, start + 8)).toString("latin1"), start, data: start + header, end: start + size });
    start += size;
  }
  return output;
}
function metadata(data) {
  const top = atoms(data), meta = top.find(box => box.type === "meta");
  assert.ok(meta);
  return { top, meta, children: atoms(data, meta.data + 4, meta.end) };
}
// Independent reader checks item-table references and actual bytes at offsets;
// merely finding a UUID string cannot pass these assertions.
function inspect(data) {
  const { children } = metadata(data), view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const info = children.find(box => box.type === "iinf"), locations = children.find(box => box.type === "iloc"), idat = children.find(box => box.type === "idat");
  const items = atoms(data, info.data + (data[info.data] ? 8 : 6), info.end).map(box => ({ id: data[box.data] === 3 ? view.getUint32(box.data + 4) : view.getUint16(box.data + 4), type: Buffer.from(data.subarray(box.data + (data[box.data] === 3 ? 10 : 8), box.data + (data[box.data] === 3 ? 14 : 12))).toString("latin1") }));
  let position = locations.data + 4;
  const version = data[locations.data], first = data[position++], second = data[position++];
  function number(width) { let value = 0; for (let index = 0; index < width; index++) value = value * 256 + data[position++]; return value; }
  const count = number(version === 2 ? 4 : 2), payloads = new Map();
  for (let index = 0; index < count; index++) {
    const itemId = number(version === 2 ? 4 : 2), method = version ? number(2) : 0;
    assert.equal(number(2), 0);
    const base = number(second >>> 4), extents = number(2), parts = [];
    for (let extent = 0; extent < extents; extent++) {
      if (version) number(second & 15);
      const offset = base + number(first >>> 4) + (method ? idat.data : 0), length = number(first & 15);
      assert.ok(offset + length <= data.length);
      parts.push(data.subarray(offset, offset + length));
    }
    payloads.set(itemId, concat(...parts));
  }
  assert.equal(position, locations.end);
  const exifItems = items.filter(item => item.type === "Exif");
  assert.equal(exifItems.length, 1);
  const exif = payloads.get(exifItems[0].id), exifView = new DataView(exif.buffer, exif.byteOffset, exif.byteLength);
  const tiff = 4 + exifView.getUint32(0);
  assert.equal(Buffer.from(exif.subarray(tiff, tiff + 2)).toString(), "MM");
  const ifd = tiff + exifView.getUint32(tiff + 4);
  const exifIfd = tiff + exifView.getUint32(ifd + 2 + 12 + 8);
  assert.equal(exifView.getUint16(exifIfd + 2), 0x927c);
  const note = tiff + exifView.getUint32(exifIfd + 10);
  assert.equal(Buffer.from(exif.subarray(note, note + 10)).toString(), "Apple iOS\0");
  assert.equal(exifView.getUint16(note + 16), 17);
  const value = note + exifView.getUint32(note + 24);
  const identifier = Buffer.from(exif.subarray(value, value + exifView.getUint32(note + 20) - 1)).toString();
  return { items, payloads, identifier, exif };
}
function fixture({ method = 0, version = 0, oldExif, grid = false, duplicate = false, badOffset = false, badReference = false, split = false, zeroMdat = false } = {}) {
  const definitions = [{ id: 1, type: "hvc1", data: sample }];
  if (grid) definitions.push({ id: 2, type: "grid", data: new Uint8Array([0, 0, 0, 0, 0, 160, 0, 96]) });
  if (oldExif) definitions.push({ id: 3, type: "Exif", data: oldExif });
  const primary = grid ? 2 : 1;
  const ftyp = atom("ftyp", encode("heic"), uint(0), encode("mif1heic"));
  const media = concat(...definitions.map(item => item.data));
  const makeMeta = start => {
    let offset = 0;
    const entries = definitions.map(item => full("infe", 2, 0, short(item.id), short(0), encode(item.type), new Uint8Array(1)));
    if (duplicate) entries.push(entries[0]);
    const locations = definitions.map(item => {
      const absolute = method ? offset : start + offset;
      offset += item.data.length;
      const extents = split && item.id === 1 ? [concat(uint(absolute), uint(20)), concat(uint(absolute + 20), uint(item.data.length - 20))] : [concat(uint(badOffset ? 0xffffff : absolute), uint(item.data.length))];
      return concat(short(item.id), ...(version ? [short(method)] : []), short(0), short(extents.length), ...extents);
    });
    const refs = [];
    if (grid) refs.push(atom("dimg", short(2), short(1), short(badReference ? 99 : 1)));
    if (oldExif) refs.push(atom("cdsc", short(3), short(1), short(badReference ? 99 : primary)));
    const iprp = atom("iprp", atom("ipco", atom("hvcC", config), full("ispe", 0, 0, uint(160), uint(96))), full("ipma", 0, 0, uint(grid ? 2 : 1), short(1), new Uint8Array([2, 129, 130]), ...(grid ? [short(2), new Uint8Array([1, 130])] : [])));
    return full("meta", 0, 0, full("hdlr", 0, 0, uint(0), encode("pict"), new Uint8Array(13)), full("pitm", 0, 0, short(primary)), full("iloc", version, 0, new Uint8Array([0x44, 0]), short(definitions.length), ...locations), full("iinf", 0, 0, short(entries.length), ...entries), ...(refs.length ? [full("iref", 0, 0, ...refs)] : []), iprp, ...(method ? [atom("idat", media)] : []));
  };
  const meta = makeMeta(ftyp.length + makeMeta(0).length + 8);
  const mdat = atom("mdat", media);
  if (zeroMdat) mdat.fill(0, 0, 4);
  return concat(ftyp, meta, ...(method ? [] : [mdat]));
}

await test("WebCodecs HEVC mux writes a genuine HEIC and Apple Exif identifier", () => {
  const output = muxHeicStill({ sample, decoderConfig: config, width: 160, height: 96, assetIdentifier: id });
  const result = inspect(output);
  assert.equal(result.identifier, id);
  assert.deepEqual(result.payloads.get(1), sample);
  assert.deepEqual(result.items.map(item => item.type), ["hvc1", "Exif"]);
});
await test("pairs iloc v0/v1, idat-relative extents, grids and split image data without transcoding", () => {
  for (const options of [{}, { version: 1, split: true }, { version: 1, method: 1 }, { grid: true }, { zeroMdat: true }]) {
    const source = fixture(options), original = source.slice(), output = pairLivePhotoHeic(source, id);
    assert.deepEqual(source, original, "does not modify input");
    const result = inspect(output);
    assert.deepEqual(result.payloads.get(1), sample);
    assert.equal(result.identifier, id);
  }
});
await test("replaces old Exif and cdsc instead of retaining a conflicting pairing UUID", () => {
  const oldExif = inspect(muxHeicStill({ sample, decoderConfig: config, width: 160, height: 96, assetIdentifier: id })).exif;
  for (const options of [{ oldExif }, { oldExif, version: 1, method: 1 }]) {
    const output = pairLivePhotoHeic(fixture(options), secondId);
    assert.equal(inspect(output).identifier, secondId);
    assert.equal(Buffer.from(output).includes(Buffer.from(id)), false);
    assert.deepEqual(inspect(output).payloads.get(1), sample);
    assert.equal(inspect(pairLivePhotoHeic(output, id)).identifier, id);
  }
});
await test("rejects malformed containers, missing data, undefined references and duplicate items", () => {
  const source = fixture(), meta = metadata(source).meta;
  for (const malformed of [fixture({ badOffset: true }), fixture({ grid: true, badReference: true }), fixture({ duplicate: true }), source.subarray(0, source.length - 1), concat(source, source.subarray(meta.start, meta.end)), concat(source, atom("moov"))]) assert.throws(() => pairLivePhotoHeic(malformed, id), /Invalid HEIC/);
  const corrupted = source.slice();
  corrupted.set(uint(7), 0);
  assert.throws(() => pairLivePhotoHeic(corrupted, id), /box size/);
  assert.throws(() => pairLivePhotoHeic(new Uint8Array([255, 216, 255, 217]), id), /Invalid HEIC/);
});
await test("rejects wrong image codecs, absent parameter sets and non-key HEVC samples", () => {
  for (const [from, to] of [["hvc1", "av01"], ["hvcC", "av1C"]]) {
    const source = fixture();
    source.set(encode(to), Buffer.from(source).indexOf(from));
    assert.throws(() => pairLivePhotoHeic(source, id), /HEVC|hvcC/);
  }
  const source = fixture(), info = metadata(source).children.find(box => box.type === "iprp");
  const hvcC = atoms(source, atoms(source, info.data, info.end)[0].data, atoms(source, info.data, info.end)[0].end)[0];
  source[hvcC.data + 22] = 0;
  assert.throws(() => pairLivePhotoHeic(source, id), /Invalid HEIC/);
  assert.throws(() => pairLivePhotoHeic(fixture(), "bad-id"), /UUID/);
  const delta = sample.slice(); delta[4] = 2;
  assert.throws(() => muxHeicStill({ sample: delta, decoderConfig: config, width: 160, height: 96, assetIdentifier: id }), /key frame/);
  assert.throws(() => muxHeicStill({ sample: sample.subarray(1), decoderConfig: config, width: 160, height: 96, assetIdentifier: id }), /Invalid HEIC/);
  assert.throws(() => muxHeicStill({ sample, decoderConfig: config, width: 0, height: 96, assetIdentifier: id }), /width/);
});
await test("native ImageIO decodes HEIC pixels and reads MakerApple 17", { skip: process.platform !== "darwin" }, () => {
  const temporary = mkdtempSync(pathJoin(tmpdir(), "brclio-heic-test-"));
  try {
    const file = pathJoin(temporary, "image.heic"), swift = pathJoin(temporary, "inspect.swift");
    writeFileSync(file, muxHeicStill({ sample, decoderConfig: config, width: 160, height: 96, assetIdentifier: id }));
    writeFileSync(swift, `import Foundation\nimport ImageIO\nlet source = CGImageSourceCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, nil)!\nlet image = CGImageSourceCreateImageAtIndex(source, 0, nil)!\nlet properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)! as NSDictionary\nlet maker = properties[kCGImagePropertyMakerAppleDictionary] as! NSDictionary\nlet result: [String: Any] = ["type": CGImageSourceGetType(source)! as String, "count": CGImageSourceGetCount(source), "width": image.width, "height": image.height, "identifier": maker["17"]!]\nprint(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)\n`);
    // Cold SDK module compilation on Intel runners can exceed 30 seconds.
    // Budget compilation separately so the actual ImageIO decode stays bounded.
    const executable = pathJoin(temporary, "inspect-heic");
    execFileSync("/usr/bin/swiftc", [swift, "-o", executable], { encoding: "utf8", timeout: 120000 });
    const result = JSON.parse(execFileSync(executable, [file], { encoding: "utf8", timeout: 10000 }));
    assert.deepEqual(result, { type: "public.heic", count: 1, width: 160, height: 96, identifier: id });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

});

suite('live-photo-package', async context => {
  const test = (...args) => context.test(...args);
const { default: assert } = await import('node:assert/strict');
const { execFileSync } = await import('node:child_process');
const { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { muxLivePhotoMov, pairLivePhotoJpeg } = await import('../web/xhs/lib/live-photo-format.js');
const { muxHeicStill } = await import('../web/xhs/lib/live-photo-heic.js');
const { makeLivePhotoPackage } = await import('../web/xhs/lib/live-photo-package.js');

const identifier = '01234567-89AB-CDEF-0123-456789ABCDEF';
const date = new Date('2026-10-10T01:02:04Z');
const jpeg = pairLivePhotoJpeg(Uint8Array.from([255, 216, 255, 218, 0, 2, 12, 34, 255, 217]), identifier);
const heic = muxHeicStill({
  sample: new Uint8Array(Buffer.from('AAAAJygBrwrbLE1AU3/7Ae73yE//7qXv6j29b/T1Ht620N4tu9NH22y2wA==', 'base64')),
  decoderConfig: new Uint8Array(Buffer.from('AQFgAAAAsAAAAAAAP/AA/P34+AAAFwOgAAEAGkABDAP//wFgAAADALAAAAMAAAMAPwAABDAkoQABAFRCAQMBYAAAAwCwAAADAAADAD8AAKAUIGFiAQ7kUggufhPQvqG9UP6qCPVUE+qqCvVVQX6qqgz1VVQb6qqqDvVVVUH+qqqqBD1VVVUpqAgICB/CAQSiAAEAB0QBwHLwWyQ=', 'base64')),
  width: 160, height: 96, assetIdentifier: identifier
});
const mov = muxLivePhotoMov({
  samples: [{ data: Uint8Array.from([0, 0, 0, 2, 0x65, 0]), timestamp: 0, duration: 500000, keyFrame: true }],
  decoderConfig: Uint8Array.from([1, 66, 0, 30, 255, 225, 0, 2, 0x67, 0, 1, 0, 2, 0x68, 0]),
  width: 32, height: 32, duration: 0.5, keyPhotoTime: 0.25, assetIdentifier: identifier
});
const fixture = (photoFormat = 'jpeg') => ({ assetIdentifier: identifier, photoFormat,
  photoExtension: photoFormat === 'heic' ? 'HEIC' : 'JPG', photo: photoFormat === 'heic' ? heic : jpeg, mov });

for (const format of ['jpeg', 'heic']) {
  await test(`${format} package preserves paired bytes and keeps README outside the .pvt directory`, async () => {
    const result = fixture(format), output = makeLivePhotoPackage(result, { date });
    const stem = `Brclio-Live-${identifier}`, bundle = `${stem}.pvt`;
    assert.equal(output.stem, stem);
    assert.equal(output.bundleName, bundle);
    assert.deepEqual(output.files.map(file => file.name), [
      `${bundle}/${stem}.${result.photoExtension}`, `${bundle}/${stem}.MOV`, `${bundle}/metadata.plist`, 'README.txt'
    ]);
    assert.equal(output.files[0].data, result.photo);
    assert.equal(output.files[1].data, result.mov);
    assert.match(new TextDecoder().decode(output.files[2].data), /<key>PFVideoComplementMetadataVersionKey<\/key>\s*<string>1<\/string>/);
    assert.match(output.readme, /目标设备上确认/);
    assert.equal(output.zip.type, 'application/zip');
    assert.deepEqual(await output.zip.arrayBuffer(), await makeLivePhotoPackage(result, { date }).zip.arrayBuffer());
  });
}

await test('package rejects unsafe identifiers, inconsistent formats and non-byte payloads', () => {
  for (const assetIdentifier of [undefined, '', '../bad', `${identifier}/file`, `${identifier}\n`, {}, '0123456789AB-CDEF-0123-456789ABCDEF']) {
    assert.throws(() => makeLivePhotoPackage({ ...fixture(), assetIdentifier }), /UUID/);
  }
  for (const changes of [{ photoFormat: 'png' }, { photoExtension: 'JPEG' }, { photoExtension: '../JPG' }, { photoFormat: 'heic' }, { photoFormat: '__proto__' }, { photoFormat: 'toString' }]) {
    assert.throws(() => makeLivePhotoPackage({ ...fixture(), ...changes }), /photoFormat/);
  }
  for (const key of ['photo', 'mov']) {
    for (const value of [new ArrayBuffer(1), new Uint8Array(), [], null]) {
      assert.throws(() => makeLivePhotoPackage({ ...fixture(), [key]: value }), /nonempty Uint8Array/);
    }
  }
});

await test('package rejects mislabeled media and truncated container bytes', () => {
  assert.throws(() => makeLivePhotoPackage({ ...fixture(), photo: heic }), /JPG format/);
  assert.throws(() => makeLivePhotoPackage({ ...fixture('heic'), photo: jpeg }), /HEIC photo/);
  assert.throws(() => makeLivePhotoPackage({ ...fixture(), mov: jpeg }), /MOV/);
  assert.throws(() => makeLivePhotoPackage({ ...fixture(), mov: mov.subarray(0, mov.length - 1) }), /invalid box size/);
  assert.throws(() => makeLivePhotoPackage({ ...fixture('heic'), photo: heic.subarray(0, heic.length - 1) }), /invalid box size/);
  const avif = heic.slice();
  avif.set(new TextEncoder().encode('avif'), 8);
  avif.set(new TextEncoder().encode('avif'), 20);
  assert.throws(() => makeLivePhotoPackage({ ...fixture('heic'), photo: avif }), /HEIC format/);
  const mp4 = mov.slice();
  mp4.set(new TextEncoder().encode('isom'), 8);
  mp4.set(new TextEncoder().encode('isom'), 16);
  assert.throws(() => makeLivePhotoPackage({ ...fixture(), mov: mp4 }), /QuickTime MOV/);
});

await test('system unzip reads the package paths and plutil parses the metadata string', { skip: process.platform !== 'darwin' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'brclio-pvt-'));
  try {
    const bundlePaths = [];
    for (const format of ['jpeg', 'heic']) {
      const result = fixture(format), output = makeLivePhotoPackage(result, { date });
      const zipPath = join(directory, `${format}.zip`), destination = join(directory, format);
      writeFileSync(zipPath, new Uint8Array(await output.zip.arrayBuffer()));
      execFileSync('/usr/bin/unzip', ['-t', zipPath]);
      execFileSync('/usr/bin/unzip', ['-q', zipPath, '-d', destination]);
      assert.deepEqual(readdirSync(destination).sort(), [output.bundleName, 'README.txt'].sort());
      const bundlePath = join(destination, output.bundleName);
      bundlePaths.push(bundlePath);
      assert.deepEqual(readdirSync(bundlePath).sort(), [`${output.stem}.${result.photoExtension}`, `${output.stem}.MOV`, 'metadata.plist'].sort());
      assert.deepEqual(readFileSync(join(bundlePath, `${output.stem}.${result.photoExtension}`)), Buffer.from(result.photo));
      assert.deepEqual(readFileSync(join(bundlePath, `${output.stem}.MOV`)), Buffer.from(result.mov));
      const plistPath = join(bundlePath, 'metadata.plist');
      execFileSync('/usr/bin/plutil', ['-lint', plistPath]);
      assert.deepEqual(JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8' })), {
        PFVideoComplementMetadataVersionKey: '1'
      });
    }
    // Query actual extracted directories: resolving the extension without a
    // directory/package constraint can produce an unrelated dynamic UTI.
    const swiftPath = join(directory, 'inspect-package.swift');
    writeFileSync(swiftPath, `import Foundation
import UniformTypeIdentifiers
var entries: [[String: Any]] = []
for path in CommandLine.arguments.dropFirst() {
  let values = try URL(fileURLWithPath: path).resourceValues(forKeys: [.isPackageKey, .typeIdentifierKey, .isDirectoryKey])
  let type = values.typeIdentifier.flatMap(UTType.init)
  entries.append([
    "isDirectory": values.isDirectory ?? false,
    "isPackage": values.isPackage ?? false,
    "typeIdentifier": values.typeIdentifier ?? "",
    "conformsToPackage": type?.conforms(to: .package) ?? false
  ])
}
print(String(decoding: try JSONSerialization.data(withJSONObject: entries), as: UTF8.self))
`);
    const entries = JSON.parse(execFileSync('/usr/bin/swift', [swiftPath, ...bundlePaths], { encoding: 'utf8' }));
    assert.deepEqual(entries, bundlePaths.map(() => ({
      isDirectory: true, isPackage: true,
      typeIdentifier: 'com.apple.private.live-photo-bundle', conformsToPackage: true
    })));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

});

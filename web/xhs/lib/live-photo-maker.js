import { muxLivePhotoMov, pairLivePhotoJpeg, LIVE_PHOTO_MIN_DURATION, LIVE_PHOTO_MAX_DURATION } from './live-photo-format.js';
import { normalizeLivePhotoImageEdit, livePhotoImageDimensions, drawEditedLivePhotoImage } from './live-photo-image-edit.js';

export const LIVE_PHOTO_LIMITS = Object.freeze({ minDuration: LIVE_PHOTO_MIN_DURATION, maxDuration: LIVE_PHOTO_MAX_DURATION, maxFiles: 12,
  maxBytes: 150 * 1024 * 1024, maxDecodedPixels: 64_000_000, maxDimension: 8192, importMaxDimension: 4096, fps: 30 });
const VIDEO_SPEEDS = [1, 1.5, 2, 3];
const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif|avif|bmp)$/i;
const VIDEO_EXT = /\.(?:mp4|mov|m4v|webm)$/i;
const AUDIO_CONFIG = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 };

function abort(signal) { signal?.throwIfAborted(); }
function abortedError() { return new DOMException('制作已取消。', 'AbortError'); }
export function validateLivePhotoFiles(files, { allowOversizedImages = false } = {}) {
  if (!Array.isArray(files) || !files.length) throw new Error('请选择图片或视频。');
  if (files.length > LIVE_PHOTO_LIMITS.maxFiles) throw new Error('一次最多选择 12 张图片。');
  let bytes = 0;
  const kinds = files.map(file => {
    if (!file || typeof file.arrayBuffer !== 'function' || !Number.isSafeInteger(file.size) || file.size <= 0)
      throw new Error('素材为空或不可读取，请重新选择。');
    bytes += file.size;
    if (IMAGE_EXT.test(file.name) || /^image\//.test(file.type)) return 'images';
    if (VIDEO_EXT.test(file.name) || /^video\//.test(file.type)) return 'video';
    throw new Error('请选择浏览器可读取的图片或 MP4、MOV、WebM 视频。');
  });
  if (kinds.some(kind => kind !== kinds[0]) || (kinds[0] === 'video' && files.length !== 1))
    throw new Error('请选择一个视频，或一组图片；图片和视频不能混合制作。');
  // Desktop File/Blob URLs are read on demand by the media decoder. Only the
  // selected short clip is encoded; the full source never becomes an ArrayBuffer.
  // Brclio's main document loads from file: with its isolated preload bridge;
  // standalone web pages retain the bounded browser input policy.
  const desktopOrigin = (globalThis.location?.protocol === 'brclio-xhs:' && globalThis.location.hostname === 'local')
    || (globalThis.location?.protocol === 'file:' && typeof globalThis.brclio?.xhsRequest === 'function');
  const desktopVideo = kinds[0] === 'video' && desktopOrigin;
  if (!Number.isSafeInteger(bytes) || (bytes > LIVE_PHOTO_LIMITS.maxBytes && !desktopVideo && !(allowOversizedImages && kinds[0] === 'images')))
    throw new Error('素材总大小不能超过 150 MB，请先缩小文件。');
  return kinds[0];
}

function eventPromise(target, success, { signal, timeout = 20000, message = '素材读取失败，请使用其他格式。' } = {}) {
  abort(signal);
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer); target.removeEventListener(success, done);
      target.removeEventListener('error', fail); signal?.removeEventListener('abort', cancel);
    };
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error(message)); };
    const cancel = () => { cleanup(); reject(signal.reason || abortedError()); };
    target.addEventListener(success, done, { once: true }); target.addEventListener('error', fail, { once: true });
    signal?.addEventListener('abort', cancel, { once: true }); timer = setTimeout(fail, timeout);
  });
}

async function loadImage(file, signal) {
  const url = URL.createObjectURL(file), image = new Image();
  try {
    const loaded = eventPromise(image, 'load', { signal }); image.src = url; await loaded;
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('图片没有可读取的尺寸。');
    return image;
  } catch (error) { image.src = ''; throw error; }
  finally { URL.revokeObjectURL(url); }
}

async function loadVideo(file, signal) {
  const video = document.createElement('video'), url = URL.createObjectURL(file);
  video.preload = 'auto'; video.playsInline = true; video.muted = true;
  const dispose = () => { video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); };
  try {
    const loaded = eventPromise(video, 'loadeddata', { signal }); video.src = url; video.load(); await loaded;
    if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight)
      throw new Error('无法读取视频时长或画面，请选择完整的视频文件。');
    return { video, dispose };
  } catch (error) { dispose(); throw error; }
}

function hasVideoAudio(video) {
  if (typeof video.mozHasAudio === 'boolean') return video.mozHasAudio;
  if (video.audioTracks) return video.audioTracks.length > 0;
  // Zero may mean the browser has not decoded audio yet; it does not prove the
  // source is silent. Never discard the user's audio on an undecoded counter.
  if (video.webkitAudioDecodedByteCount > 0) return true;
  return null;
}

export async function inspectLivePhotoFiles(files, { signal, allowOversizedImages = false } = {}) {
  const kind = validateLivePhotoFiles(files, { allowOversizedImages }); abort(signal);
  if (kind === 'video') {
    const source = await loadVideo(files[0], signal);
    try { return { kind, duration: source.video.duration, width: source.video.videoWidth,
      height: source.video.videoHeight, hasAudio: hasVideoAudio(source.video) }; }
    finally { source.dispose(); }
  }
  let first, pixels = 0;
  for (const file of files) {
    const image = await loadImage(file, signal);
    pixels += image.naturalWidth * image.naturalHeight;
    first ??= { width: image.naturalWidth, height: image.naturalHeight };
    image.src = '';
    if (pixels > LIVE_PHOTO_LIMITS.maxDecodedPixels && !allowOversizedImages) throw new Error('图片总像素超过 6400 万，请缩小图片或减少张数后制作。');
  }
  abort(signal);
  const bytes = files.reduce((total, file) => total + file.size, 0);
  return { kind, duration: null, ...first, hasAudio: false, pixels, bytes,
    requiresCompression: pixels > LIVE_PHOTO_LIMITS.maxDecodedPixels || bytes > LIVE_PHOTO_LIMITS.maxBytes };
}

// Keep originals untouched. Decode, resize and release one image at a time so
// importing a large group does not retain all full-resolution decoded images.
export async function compressLivePhotoFiles(files, { signal, onProgress = () => {} } = {}) {
  if (validateLivePhotoFiles(files, { allowOversizedImages: true }) !== 'images') throw new Error('只有图片支持压缩导入。');
  abort(signal);
  const compressed = [];
  for (const [index, file] of files.entries()) {
    abort(signal);
    onProgress({ progress: index / files.length, message: `正在压缩图片 ${index + 1} / ${files.length}…` });
    const image = await loadImage(file, signal);
    let canvas;
    try {
      abort(signal);
      canvas = document.createElement('canvas');
      // Compression is an explicit import choice. Use the available pixel
      // budget for detail instead of applying the old 1440px export limit.
      const scale = Math.min(1, LIVE_PHOTO_LIMITS.importMaxDimension / Math.max(image.naturalWidth, image.naturalHeight),
        Math.sqrt(LIVE_PHOTO_LIMITS.maxDecodedPixels / files.length / (image.naturalWidth * image.naturalHeight)));
      Object.assign(canvas, evenDimensions(image.naturalWidth * scale, image.naturalHeight * scale));
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('当前设备无法压缩图片，请更换图片后重试。');
      context.fillStyle = '#fefcf6'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve, reject) => {
        const finish = (error, value) => { signal?.removeEventListener('abort', cancel); error ? reject(error) : resolve(value); };
        const cancel = () => finish(signal.reason || abortedError());
        signal?.addEventListener('abort', cancel, { once: true });
        try {
          canvas.toBlob(value => {
            if (signal?.aborted) cancel();
            else if (!value?.size) finish(new Error('图片压缩失败，请重新选择或手动缩小图片。'));
            else finish(null, value);
          }, 'image/jpeg', 0.98);
        } catch (error) { finish(error); }
      });
      abort(signal);
      const name = file.name.replace(/\.[^.]+$/, '') || '图片';
      compressed.push(new File([blob], `${name}-compressed.jpg`, { type: 'image/jpeg', lastModified: file.lastModified }));
    } finally { image.src = ''; if (canvas) canvas.width = canvas.height = 0; }
  }
  abort(signal);
  validateLivePhotoFiles(compressed);
  onProgress({ progress: 1, message: '图片压缩完成，正在导入…' });
  return compressed;
}

export function livePhotoVideoConfig(width, height) {
  // High profile, with a level that can describe the source frame size and
  // 30fps throughput. Keep realtime mode: the MOV muxer requires no B-frames.
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  const level = macroblocks <= 36864 && macroblocks * LIVE_PHOTO_LIMITS.fps <= 983040 ? '33'
    : macroblocks <= 36864 && macroblocks * LIVE_PHOTO_LIMITS.fps <= 2073600 ? '34' : '3c';
  return { codec: `avc1.6400${level}`, width, height,
    bitrate: Math.min(240000000, Math.max(12000000, Math.round(width * height * LIVE_PHOTO_LIMITS.fps * 0.4))),
    bitrateMode: 'variable', framerate: LIVE_PHOTO_LIMITS.fps,
    latencyMode: 'realtime', avc: { format: 'avc' }, hardwareAcceleration: 'no-preference' };
}

export async function selectLivePhotoVideoConfig(size, { signal } = {}) {
  // The still image keeps all its native pixels even when the device's AVC
  // encoder cannot make a movie at that resolution (e.g. a 24MP photograph).
  // Probe the native frame first, then the largest practical AVC frame budgets.
  const candidates = [size];
  for (const [maxEdge, maxPixels, maxMacroblocks] of [[4096, 36864 * 256, 36864], [4096, 3840 * 2160, 32768],
    [2560, 2560 * 1440, 32768], [1920, 1920 * 1080, 32768], [1280, 1280 * 720, 32768]]) {
    let lower = 0, upper = Math.min(1, maxEdge / Math.max(size.width, size.height), Math.sqrt(maxPixels / (size.width * size.height)));
    let candidate = evenDimensions(size.width * upper, size.height * upper);
    // AVC limits count padded 16px blocks, not only visible pixels. Without
    // this adjustment a near-limit frame accidentally requests level 6 and
    // skips a larger supported level-5.2 result.
    if (Math.ceil(candidate.width / 16) * Math.ceil(candidate.height / 16) > maxMacroblocks) {
      for (let index = 0; index < 40; index++) {
        const scale = (lower + upper) / 2, value = evenDimensions(size.width * scale, size.height * scale);
        if (Math.ceil(value.width / 16) * Math.ceil(value.height / 16) <= maxMacroblocks) lower = scale;
        else upper = scale;
      }
      candidate = evenDimensions(size.width * lower, size.height * lower);
    }
    // Some hardware AVC encoders resample non-macroblock-aligned frames. Keep
    // fallback movie canvases aligned; the separate still keeps native pixels.
    candidate = { width: candidate.width >= 16 ? Math.floor(candidate.width / 16) * 16 : candidate.width,
      height: candidate.height >= 16 ? Math.floor(candidate.height / 16) * 16 : candidate.height };
    if (!candidates.some(value => value.width === candidate.width && value.height === candidate.height)) candidates.push(candidate);
  }
  for (const dimensions of candidates) {
    abort(signal);
    const config = livePhotoVideoConfig(dimensions.width, dimensions.height);
    try {
      if ((await VideoEncoder.isConfigSupported(config)).supported) { abort(signal); return config; }
    } catch (error) { if (signal?.aborted) throw error; }
  }
  throw new Error('当前设备无法编码此画幅的实况动态画面，请更换设备或裁切素材后重试。');
}
function recorderType() {
  if (typeof MediaRecorder === 'undefined') return null;
  return ['audio/webm;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type)) || null;
}

export async function checkLivePhotoSupport() {
  let supported = false, audioSupported = false;
  try {
    supported = typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined'
      && (await VideoEncoder.isConfigSupported(livePhotoVideoConfig(640, 480))).supported;
  } catch { /* Video and audio capability failures must remain independent. */ }
  try {
    audioSupported = typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined'
      && typeof AudioContext !== 'undefined' && Boolean(recorderType())
      && (await AudioEncoder.isConfigSupported(AUDIO_CONFIG)).supported;
  } catch { /* Capability failures are displayed before starting work. */ }
  const heicSupported = typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined';
  return { supported, audioSupported, heicSupported,
    message: supported ? (audioSupported ? '本地制作已就绪。' : '当前浏览器可制作无声实况；保留声音请使用桌面客户端或新版 Chrome。')
      : '当前浏览器不支持 H.264 本地编码。请使用新版 Chrome、Edge 或 Brclio 桌面客户端。' };
}

function validateDuration(duration) {
  if (!Number.isFinite(duration) || duration < LIVE_PHOTO_LIMITS.minDuration || duration > LIVE_PHOTO_LIMITS.maxDuration)
    throw new Error('实况时长请选择 0.5 至 8 秒。');
}

function livePhotoFrameCount(duration) {
  const durationUs = Math.round(duration * 1e6);
  const count = Math.ceil(durationUs * LIVE_PHOTO_LIMITS.fps / 1e6);
  // Rounding to the MOV/WebCodecs microsecond timescale can put a theoretical
  // final frame exactly at the end. Such a frame would have zero duration.
  return Math.round((count - 1) / LIVE_PHOTO_LIMITS.fps * 1e6) < durationUs ? count : count - 1;
}

// The cover, preview and timed metadata must point at a frame that is actually
// encoded. A fractional final frame is valid, but time === duration is not.
export function livePhotoCoverTime(duration, keyPhotoTime) {
  validateDuration(duration);
  if (!Number.isFinite(keyPhotoTime) || keyPhotoTime < 0 || keyPhotoTime >= duration)
    throw new Error('封面位置必须在所选片段内。');
  const frameCount = livePhotoFrameCount(duration);
  const frame = Math.min(frameCount - 1, Math.round(keyPhotoTime * LIVE_PHOTO_LIMITS.fps));
  return frame / LIVE_PHOTO_LIMITS.fps;
}

export function normalizeLivePhotoOptions({ kind, sourceDuration, start = 0, duration = 3, keyPhotoTime = duration / 2, motion = 'zoom', speed = 1 }) {
  validateDuration(duration);
  if (!Number.isFinite(start) || start < 0) throw new Error('片段起点不能小于 0 秒。');
  if (!VIDEO_SPEEDS.includes(speed)) throw new Error('视频倍速请选择 1、1.5、2 或 3 倍。');
  if (kind !== 'video' && speed !== 1) throw new Error('图片制作不支持视频倍速，请使用 1 倍速。');
  const normalizedDuration = Math.round(duration * 1e6) / 1e6;
  const sourceSpan = normalizedDuration * speed;
  if (kind === 'video' && (!Number.isFinite(sourceDuration) || start + sourceSpan > sourceDuration + 0.001))
    throw new Error('所选片段超出视频时长，请调整起点或缩短片段。');
  const coverTime = livePhotoCoverTime(duration, keyPhotoTime);
  if (!['zoom', 'still'].includes(motion)) throw new Error('请选择有效的图片动效。');
  return { start, duration: normalizedDuration, keyPhotoTime: coverTime, motion, speed, sourceSpan };
}

export function livePhotoDimensions(width, height) {
  if (![width, height].every(value => Number.isSafeInteger(value) && value >= 2)) throw new Error('素材尺寸无效。');
  if (Math.max(width, height) > LIVE_PHOTO_LIMITS.maxDimension || width * height > LIVE_PHOTO_LIMITS.maxDecodedPixels)
    throw new Error('原始画面超过本地编码上限（长边 8192 像素、6400 万像素），请先裁剪素材。');
  // H.264 4:2:0 needs even dimensions. Do not rescale a high-resolution source.
  return evenDimensions(width, height);
}

function evenDimensions(width, height) {
  return { width: Math.max(2, Math.floor(width / 2) * 2), height: Math.max(2, Math.floor(height / 2) * 2) };
}

async function seek(video, time, signal) {
  abort(signal);
  if (Math.abs(video.currentTime - time) < 0.0001 && video.readyState >= 2) return;
  const pending = eventPromise(video, 'seeked', { signal, message: '视频片段定位失败，请重试或更换格式。' });
  video.currentTime = time; await pending;
}

async function encodingBackpressure(encoder, limit, signal) {
  while (encoder.encodeQueueSize > limit) {
    abort(signal);
    await eventPromise(encoder, 'dequeue', { signal, message: '本地编码响应超时，请重试。' });
  }
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob)
    : reject(new Error('封面生成失败。')), 'image/jpeg', 1));
}

/** Draw an image-group frame using the same layout used by the encoder. */
export function drawLivePhotoImageFrame(context, images, { time, duration, motion = 'zoom', size, imageEdits = [] } = {}) {
  if (!context || !Array.isArray(images) || !images.length || !Number.isFinite(time) || time < 0 || !Number.isFinite(duration) || duration <= 0)
    throw new Error('实况预览帧参数无效。');
  const first = livePhotoImageDimensions(images[0], imageEdits[0]);
  const dimensions = size || livePhotoDimensions(first.width, first.height);
  if (context.canvas.width !== dimensions.width) context.canvas.width = dimensions.width;
  if (context.canvas.height !== dimensions.height) context.canvas.height = dimensions.height;
  context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
  const index = Math.min(images.length - 1, Math.floor(time / duration * images.length)), interval = duration / images.length;
  drawEditedLivePhotoImage(context, images[index], { edit: imageEdits[index], ...dimensions, time: time % interval, duration: interval, motion });
  return { ...dimensions, index };
}

// Record only the selected audio interval. Decoding this small recording avoids
// allocating PCM for an entire long input video. The audio never reaches speakers.
async function selectedAudio(video, start, duration, signal) {
  const context = new AudioContext({ sampleRate: 48000 });
  let recorder, source, destination;
  try {
    await seek(video, start, signal); abort(signal);
    source = context.createMediaElementSource(video); destination = context.createMediaStreamDestination();
    source.connect(destination); await context.resume(); abort(signal);
    if (context.state !== 'running') throw new Error('音频处理未启动，请重新点击制作或关闭保留声音。');
    recorder = new MediaRecorder(destination.stream, { mimeType: recorderType() });
    const chunks = [];
    const recorded = new Promise((resolve, reject) => {
      recorder.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data); });
      recorder.addEventListener('stop', resolve, { once: true });
      recorder.addEventListener('error', () => reject(new Error('音频截取失败，请重试或关闭保留声音。')), { once: true });
    });
    video.muted = false;
    const recordingOrigin = context.currentTime; recorder.start();
    await video.play(); abort(signal);
    const playbackOrigin = context.currentTime - Math.max(0, video.currentTime - start);
    await new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      const cancel = () => { cleanup(); reject(signal.reason || abortedError()); };
      const started = performance.now();
      const tick = () => {
        if (video.currentTime >= start + duration || video.ended) { cleanup(); resolve(); }
        else if (performance.now() - started > duration * 1000 + 10000) { cleanup(); reject(new Error('视频声音截取超时，请重试。')); }
        else timer = setTimeout(tick, 10);
      };
      signal?.addEventListener('abort', cancel, { once: true }); tick();
    });
    video.pause(); recorder.stop(); await recorded; abort(signal);
    const buffer = await context.decodeAudioData(await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer()); abort(signal);
    const offset = Math.max(0, Math.round((playbackOrigin - recordingOrigin) * buffer.sampleRate));
    return { buffer, offset };
  } catch (error) {
    if (signal?.aborted || error.name === 'AbortError') throw error;
    throw new Error(`无法保留视频声音：${error.message} 可以关闭“保留声音”后制作。`);
  } finally {
    video.pause(); video.muted = true;
    if (recorder?.state === 'recording') recorder.stop();
    source?.disconnect(); destination?.stream.getTracks().forEach(track => track.stop());
    await context.close();
  }
}

async function encodeAudio({ buffer, offset }, duration, signal) {
  const samples = []; let decoderConfig, failed;
  const encoder = new AudioEncoder({ output(chunk, metadata) {
    const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
    samples.push({ data, timestamp: chunk.timestamp, duration: chunk.duration, keyFrame: true });
    if (metadata?.decoderConfig?.description) decoderConfig = new Uint8Array(metadata.decoderConfig.description);
  }, error(error) { failed = error; } });
  try {
    encoder.configure(AUDIO_CONFIG);
    const count = Math.ceil(duration * buffer.sampleRate);
    for (let first = 0; first < count; first += 1024) {
      abort(signal); if (failed) throw failed;
      const frames = Math.min(1024, count - first), pcm = new Float32Array(frames * 2);
      for (let channel = 0; channel < 2; channel++) {
        const plane = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
        const slice = plane.subarray(offset + first, Math.min(offset + first + frames, plane.length));
        pcm.set(slice, channel * frames);
      }
      const data = new AudioData({ format: 'f32-planar', sampleRate: buffer.sampleRate, numberOfChannels: 2,
        numberOfFrames: frames, timestamp: Math.round(first / buffer.sampleRate * 1e6), data: pcm });
      try { encoder.encode(data); } finally { data.close(); }
      await encodingBackpressure(encoder, 12, signal);
    }
    await encoder.flush(); abort(signal); if (failed) throw failed;
    if (!decoderConfig || !samples.length) throw new Error('音频编码没有产生有效数据。');
    const origin = samples[0].timestamp;
    samples.forEach(sample => { sample.timestamp -= origin; sample.duration ||= Math.round(1024 / buffer.sampleRate * 1e6); });
    return { samples, decoderConfig, sampleRate: buffer.sampleRate, channels: 2 };
  } finally { if (encoder.state !== 'closed') encoder.close(); }
}

export async function createLivePhoto({ files, start = 0, duration = 3, keyPhotoTime = duration / 2,
  motion = 'zoom', speed = 1, includeAudio = true, photoFormat = 'jpeg', imageEdits = [], signal, onProgress = () => {} }) {
  if (!['jpeg', 'heic'].includes(photoFormat)) throw new Error('请选择 HEIC 或 JPG 照片格式。');
  const kind = validateLivePhotoFiles(files), support = await checkLivePhotoSupport(); abort(signal);
  if (!support.supported) throw new Error(support.message);
  if (photoFormat === 'heic' && !support.heicSupported) throw new Error('当前设备不支持本地 HEIC 编码，请使用新版浏览器或桌面客户端。');
  if (!Array.isArray(imageEdits) || imageEdits.length > files.length) throw new Error('图片调整参数与素材不匹配。');
  const edits = files.map((_, index) => normalizeLivePhotoImageEdit(imageEdits[index]));
  let source, encoder, canvas, coverCanvas;
  const images = [];
  try {
    onProgress({ progress: 0.02, message: '正在读取本地素材…' });
    if (kind === 'video') source = await loadVideo(files[0], signal);
    else {
      let pixels = 0;
      for (const file of files) {
        const image = await loadImage(file, signal); images.push(image);
        pixels += image.naturalWidth * image.naturalHeight;
        if (pixels > LIVE_PHOTO_LIMITS.maxDecodedPixels) throw new Error('图片总像素超过 6400 万，请缩小图片或减少张数后制作。');
      }
    }
    const options = normalizeLivePhotoOptions({ kind, sourceDuration: source?.video.duration, start, duration, keyPhotoTime, motion, speed });
    const firstImageSize = kind === 'images' ? livePhotoImageDimensions(images[0], edits[0]) : null;
    const nativeSize = kind === 'video' ? livePhotoDimensions(source.video.videoWidth, source.video.videoHeight)
      : livePhotoDimensions(firstImageSize.width, firstImageSize.height);
    const config = await selectLivePhotoVideoConfig(nativeSize, { signal });
    const size = { width: config.width, height: config.height };
    const videoResized = size.width !== nativeSize.width || size.height !== nativeSize.height;
    if (videoResized) onProgress({ progress: 0.04, message: `照片保留原始像素，动态画面按设备支持的 ${size.width} × ${size.height} 制作。` });
    abort(signal);
    let audio;
    if (kind === 'video' && options.speed === 1 && includeAudio && hasVideoAudio(source.video) !== false) {
      if (!support.audioSupported) throw new Error('当前浏览器不支持保留声音，请关闭“保留声音”或使用桌面客户端。');
      onProgress({ progress: 0.06, message: '正在截取所选片段的声音…' });
      audio = await encodeAudio(await selectedAudio(source.video, options.start, options.duration, signal), options.duration, signal);
    }
    abort(signal);
    canvas = document.createElement('canvas'); Object.assign(canvas, size);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('当前设备无法分配原始分辨率画面，请减少素材后重试。');
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
    const samples = []; let decoderConfig, failed;
    encoder = new VideoEncoder({ output(chunk, metadata) {
      const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
      samples.push({ data, timestamp: chunk.timestamp, duration: chunk.duration, keyFrame: chunk.type === 'key' });
      if (metadata?.decoderConfig?.description) decoderConfig = new Uint8Array(metadata.decoderConfig.description);
    }, error(error) { failed = error; } });
    encoder.configure(config);
    const frameCount = livePhotoFrameCount(options.duration);
    const draw = async (time, target = context, dimensions = size) => {
      if (kind === 'video') {
        await seek(source.video, Math.min(options.start + time * options.speed, source.video.duration - 0.001), signal);
        target.drawImage(source.video, 0, 0, dimensions.width, dimensions.height);
      } else {
        drawLivePhotoImageFrame(target, images, { time, duration: options.duration, motion: options.motion, size: dimensions, imageEdits: edits });
      }
    };
    for (let index = 0; index < frameCount; index++) {
      abort(signal); if (failed) throw failed;
      const timestamp = Math.round(index / LIVE_PHOTO_LIMITS.fps * 1e6);
      const end = Math.min(Math.round(options.duration * 1e6), Math.round((index + 1) / LIVE_PHOTO_LIMITS.fps * 1e6));
      await draw(index / LIVE_PHOTO_LIMITS.fps); abort(signal);
      const frame = new VideoFrame(canvas, { timestamp, duration: end - timestamp });
      try { encoder.encode(frame, { keyFrame: index === 0 || index % 30 === 0 }); } finally { frame.close(); }
      onProgress({ progress: 0.2 + 0.7 * (index + 1) / frameCount, message: `正在制作画面 ${index + 1} / ${frameCount}…` });
      // Bound queued raw pixels as well as frame count for 4K/6K sources.
      await encodingBackpressure(encoder, Math.max(1, Math.min(8, Math.floor(16_000_000 / (size.width * size.height)))), signal);
      if (index % 10 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    await encoder.flush(); abort(signal); if (failed) throw failed;
    if (!decoderConfig || samples.length !== frameCount) throw new Error('视频编码不完整，请重试。');
    // Cover and metadata refer to the same encoded frame, including image cuts.
    const coverTime = options.keyPhotoTime;
    const coverIndex = kind === 'images' ? Math.min(images.length - 1, Math.floor(coverTime / options.duration * images.length)) : 0;
    const photoSize = kind === 'video' ? { width: source.video.videoWidth, height: source.video.videoHeight }
      : livePhotoImageDimensions(images[coverIndex], edits[coverIndex]);
    coverCanvas = document.createElement('canvas'); Object.assign(coverCanvas, photoSize);
    const coverContext = coverCanvas.getContext('2d', { alpha: false });
    if (!coverContext) throw new Error('当前设备无法分配原始分辨率封面，请减少素材后重试。');
    coverContext.imageSmoothingEnabled = true; coverContext.imageSmoothingQuality = 'high';
    await draw(coverTime, coverContext, photoSize); abort(signal);
    // Browsers cannot display HEIC directly. Preview the source cover rather
    // than extracting and recompressing an already encoded H.264 frame.
    const photoPreviewBlob = await canvasBlob(coverCanvas); abort(signal);
    const identifier = crypto.randomUUID();
    let photo;
    if (photoFormat === 'heic') {
      onProgress({ progress: 0.92, message: '正在制作 HEIC 实况照片…' });
      const [{ encodeHeicCanvas }, { pairLivePhotoHeic }] = await Promise.all([
        import('./live-photo-heic-encoder.js'), import('./live-photo-heic.js')
      ]);
      abort(signal);
      photo = pairLivePhotoHeic(await encodeHeicCanvas(coverCanvas, { signal }), identifier);
    } else photo = pairLivePhotoJpeg(new Uint8Array(await photoPreviewBlob.arrayBuffer()), identifier);
    abort(signal); onProgress({ progress: 0.96, message: '正在写入实况配对信息…' });
    const mov = muxLivePhotoMov({ samples, decoderConfig, ...size, duration: options.duration,
      keyPhotoTime: coverTime, assetIdentifier: identifier, audio });
    abort(signal); onProgress({ progress: 1, message: '实况已制作完成。' });
    return { photo, photoFormat, photoExtension: photoFormat === 'heic' ? 'HEIC' : 'JPG',
      photoMimeType: photoFormat === 'heic' ? 'image/heic' : 'image/jpeg',
      ...(photoFormat === 'heic' ? { heic: photo } : { jpeg: photo }), mov,
      previewBlob: new Blob([mov], { type: 'video/quicktime' }), photoPreviewBlob, ...size,
      photoWidth: photoSize.width, photoHeight: photoSize.height, videoBitrate: config.bitrate, videoResized,
      duration: options.duration, keyPhotoTime: coverTime, speed: options.speed,
      sourceSpan: options.sourceSpan, hasAudio: Boolean(audio), assetIdentifier: identifier };
  } finally {
    if (encoder && encoder.state !== 'closed') encoder.close(); source?.dispose();
    if (canvas) canvas.width = canvas.height = 0;
    if (coverCanvas) coverCanvas.width = coverCanvas.height = 0;
    images.forEach(image => { image.src = ''; });
  }
}

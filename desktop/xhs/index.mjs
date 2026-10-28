import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PythonBackend } from './desktop/python-backend.js';
import { createElectronUpdateFetch } from './desktop/electron-fetch.js';
import { XhsBrowser } from './desktop/profile-browser.js';
import { ProfileManager } from './desktop/profile-manager.js';
import { XhsLoginReset } from './desktop/xhs-login-reset.js';
import { NativeVideoDownload } from './desktop/native-video-download.js';
import { NativeImageClipboard } from './desktop/image-clipboard.js';
import { createParseHandler } from './api/parse.js';
import { createVideoHandler } from './api/video.js';
import { buildNoWatermarkUrl, extractOriginalAssetToken, isXhsImageUrl, isXhsVideoUrl, normalizeImageUrl, fetchNotePage } from './lib/xhs.js';
import { makeNoteTextFileData, makeZipBlob } from './lib/archive.js';
import { atomicWrite, assertSafeDirectory, assertSafeTarget, ensureNoteDirectory, safeFilename, downloadMedia, throwIfAborted, abortableOperation } from './desktop/media-download.js';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, X-Video-Total',
  'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };

function cors(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}
function jsonError(message, status = 400) { return Response.json({ success: false, message }, { status, headers: CORS }); }

function abortableFetch(fetchImpl, url, options = {}) {
  const { signal } = options;
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => { if (settled) return; settled = true; reject(signal.reason || new Error('请求已取消。')); };
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => fetchImpl(url, options)).then(response => {
      if (settled) { void response.body?.cancel().catch(() => {}); return; }
      settled = true; signal?.removeEventListener('abort', abort);
      if (!response.body || !signal) { resolve(response); return; }
      // The response may have left handleProtocol already when the app quits.
      // Keep its reader attached to the same lifetime cancellation signal.
      const reader = response.body.getReader(); let finished = false, abortBody;
      const cleanup = () => { finished = true; signal.removeEventListener('abort', abortBody); };
      const body = new ReadableStream({
        start(controller) {
          abortBody = () => {
            if (finished) return;
            cleanup(); controller.error(signal.reason || new Error('请求已取消。')); void reader.cancel().catch(() => {});
          };
          signal.addEventListener('abort', abortBody, { once: true });
          if (signal.aborted) abortBody();
        },
        async pull(controller) {
          try {
            const chunk = await reader.read(); if (finished) return;
            if (chunk.done) { cleanup(); controller.close(); }
            else controller.enqueue(chunk.value);
          } catch (error) { if (!finished) { cleanup(); controller.error(error); } }
        },
        cancel(reason) { cleanup(); void reader.cancel(reason).catch(() => {}); },
      });
      const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      Object.defineProperty(wrapped, 'url', { value: response.url });
      resolve(wrapped);
    }, error => {
      signal?.removeEventListener('abort', abort);
      if (!settled) { settled = true; reject(error); }
    });
  });
}

export async function invokeHandler(handler, { method = 'GET', body = '', query = {}, headers: inputHeaders = {} } = {}) {
  const headers = new Headers(); let status = 200, payload = null;
  const response = {
    setHeader(name, value) { headers.set(name, String(value)); return this; },
    status(value) { status = value; return this; },
    json(value) { headers.set('Content-Type', 'application/json; charset=utf-8'); payload = JSON.stringify(value); return this; },
    send(value) { payload = value; return this; }, end(value) { payload = value ?? null; return this; },
  };
  await handler({ method, body, query, headers: inputHeaders }, response);
  return new Response(payload, { status, headers });
}

/** Every redirect is validated before connecting; loopback/private hosts never qualify. */
export async function fetchMedia(source, { fetchImpl = fetch, kind, range, signal } = {}) {
  let url = normalizeImageUrl(String(source || ''));
  const valid = kind === 'image' ? isXhsImageUrl : isXhsVideoUrl;
  for (let hop = 0; hop < 6; hop++) {
    if (url.length > 12020 || !valid(url) || new URL(url).protocol !== 'https:') throw new Error('媒体链接不属于受支持的小红书 CDN。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('读取媒体响应超时。')), 60000);
    let response;
    try {
      response = await fetchImpl(url, { redirect: 'manual', signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        headers: { referer: 'https://www.xiaohongshu.com/', 'user-agent': 'Mozilla/5.0',
          accept: kind === 'image' ? 'image/*' : 'video/mp4,application/octet-stream', ...(range ? { range } : {}) } });
    } finally { clearTimeout(timer); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel().catch(() => {});
      if (!location || hop === 5) throw new Error('媒体重定向次数过多或目标缺失。');
      url = new URL(location, url).href; continue;
    }
    if (response.url && !valid(response.url)) { await response.body?.cancel().catch(() => {}); throw new Error('媒体服务器重定向异常。'); }
    if (![200, 206].includes(response.status)) { await response.body?.cancel().catch(() => {}); throw new Error(`媒体服务器返回 HTTP ${response.status}。`); }
    const type = (response.headers.get('content-type') || '').split(';')[0];
    if (!(kind === 'image' ? /^image\/(jpeg|jpg|png|webp|gif|avif|heic|heif)$/.test(type) : ['video/mp4', 'video/quicktime', 'video/x-m4v', 'application/octet-stream'].includes(type))) {
      await response.body?.cancel().catch(() => {}); throw new Error('媒体响应类型异常。');
    }
    return response;
  }
  throw new Error('媒体请求失败。');
}

function selection(input) {
  if (!Array.isArray(input) || input.length > 1000) throw new Error('图片选择无效。');
  const used = new Set();
  return input.map((image, ordinal) => {
    const index = image?.index ?? ordinal + 1;
    if (!image || typeof image.url !== 'string' || !isXhsImageUrl(image.url) || new URL(image.url).protocol !== 'https:'
      || !Number.isInteger(index) || index < 1 || index > 10000 || used.has(index)) throw new Error('图片链接或序号无效。');
    used.add(index); return { ...image, index };
  });
}

export async function createXhsService({ app, BrowserWindow, session, dialog, clipboard, net, shell, getWindow = () => undefined,
  onEvent = () => {}, fetchImpl, clipboardWriters } = {}) {
  const directory = path.join(app.getPath('userData'), 'xhs');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  // No account API, authentication token or shared Brclio setting enters this module.
  const browserSession = session.fromPartition('persist:brclio-xhs');
  // XHS parsing, previews and downloads never share the updater's built-in proxy.
  // Pin this isolated session to direct connections before making any requests.
  await browserSession.setProxy?.({ mode: 'direct' });
  const lifetime = new AbortController();
  // Match the source client: page parsing, profile jobs and media proxies use
  // Node fetch; native video/clipboard downloads use the unchanged net.request
  // adapter. Electron session.fetch rejects the manual redirects both need.
  const withLifetime = transport => (url, options = {}) => abortableFetch(transport, url, { ...options,
    signal: options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal });
  const network = withLifetime(fetchImpl || globalThis.fetch);
  const nativeNetwork = withLifetime(fetchImpl || createElectronUpdateFetch(net, { session: browserSession }));
  const emit = (type, state) => { try { onEvent({ type, state }); } catch { /* Closed renderer. */ } };
  const browser = new XhsBrowser({ BrowserWindow, session, fetchPage: (url, options) => fetchNotePage(url, { ...options, fetchImpl: network }),
    onLoginState: state => emit('login', state) });
  const manager = new ProfileManager({ stateDirectory: path.join(directory, 'profile-jobs'), browser, fetchImpl: network,
    onUpdate: state => emit('profile', state) });
  await manager.initialize();
  const approved = new Set();
  async function validateDirectory(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('请先选择下载目录。');
    const root = await fs.realpath(value);
    await assertSafeDirectory(root, root); await fs.access(root, constants.R_OK | constants.W_OK); return root;
  }
  if (manager.snapshot().directory) {
    try { approved.add(await validateDirectory(manager.snapshot().directory)); } catch { /* Removable drive may be absent. */ }
  }
  async function approvedDirectory(value) {
    const root = await validateDirectory(value);
    if (!approved.has(root)) throw new Error('请通过“选择保存目录”重新授权此文件夹。'); return root;
  }
  async function chooseDirectory(signal = lifetime.signal) {
    const result = await abortableOperation(() => dialog.showOpenDialog(getWindow(), { title: '选择小红书下载文件夹', properties: ['openDirectory', 'createDirectory'],
      defaultPath: manager.snapshot().directory || app.getPath('downloads') }), signal);
    if (result.canceled || !result.filePaths?.[0]) return null;
    const root = await validateDirectory(result.filePaths[0]); approved.add(root); return root;
  }
  const reset = new XhsLoginReset({ manager, confirm: async () => {
    const result = await abortableOperation(() => dialog.showMessageBox(getWindow(), { type: 'question', title: '清除小红书登录记录',
      message: '清除后需要重新登录小红书。', detail: '将清空这台电脑的小红书 Cookie、网站存储与缓存。主页任务会先暂停，已下载文件与任务记录会保留。',
      buttons: ['取消', '清除登录记录'], defaultId: 0, cancelId: 0, noLink: true }), lifetime.signal); return result.response === 1;
  } });
  const python = new PythonBackend({ appDirectory: app.getAppPath(), sourceDirectory, resourcesDirectory: process.resourcesPath,
    packaged: app.isPackaged });
  // Python is an optional alternate parser. Initialize it on demand, without delaying the existing app or the native parser.
  let pythonReady;
  const ensurePython = () => pythonReady ||= python.initialize();
  const video = new NativeVideoDownload({ fetchImpl: nativeNetwork,
    showSaveDialog: options => dialog.showSaveDialog(getWindow(), options), onProgress: state => emit('video', state) });
  let imageClipboard;
  async function copyImages(input) {
    const transfer = beginTransfer(input);
    const requestId = transfer.requestId;
    try {
      emit('clipboard', { requestId, phase: 'preparing', completed: 0, total: input.images?.length || 0 });
      if (!imageClipboard) {
        const writers = clipboardWriters || await import('./desktop/native-clipboard.js');
        imageClipboard = new NativeImageClipboard({ directory: path.join(directory, 'clipboard-images'), fetchImpl: nativeNetwork,
          writeFiles: writers.writeImageFiles, writeImage: writers.writeSingleImage, onProgress: state => emit('clipboard', state), signal: lifetime.signal });
      }
      const result = await imageClipboard.copy({ ...input, requestId }, { signal: transfer.controller.signal });
      emit('clipboard', { requestId, phase: 'saved', completed: result.count, total: result.count });
      return result;
    } catch (error) {
      if (transfer.controller.signal.aborted) {
        emit('clipboard', { requestId, phase: 'cancelled' });
        return { ok: true, cancelled: true };
      }
      emit('clipboard', { requestId, phase: 'error', message: error.message });
      throw error;
    } finally { endTransfer(transfer); }
  }
  const parse = createParseHandler({ fetchPage: url => fetchNotePage(url, { fetchImpl: network }), onError: () => {} });
  const videoProxy = createVideoHandler({ fetchImpl: network });
  let saving = false, closing = false;
  const transfers = new Set(), operations = new Set();
  const archives = new Map();
  const genericTransfers = new Map();
  function beginTransfer(input) {
    if (genericTransfers.size || archives.size || video.requests.size) throw new Error('请先完成或取消当前素材操作。');
    const requestId = input.requestId || randomUUID();
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw new Error('素材操作编号无效。');
    const controller = new AbortController(); genericTransfers.set(requestId, controller); transfers.add(controller);
    return { requestId, controller };
  }
  function endTransfer({ requestId, controller }) { genericTransfers.delete(requestId); transfers.delete(controller); }
  function track(operation) {
    operations.add(operation);
    void operation.then(() => operations.delete(operation), () => operations.delete(operation));
    return operation;
  }
  async function saveNote(input, imagesOnly = false) {
    if (saving) throw new Error('正在保存上一篇笔记，请稍候。');
    const note = imagesOnly ? { title: input.title, images: input.images } : input.note;
    if (!note || typeof note !== 'object' || JSON.stringify(note).length > 4 * 1024 * 1024) throw new Error('笔记信息无效或过大。');
    const images = selection(input.images ?? note.images ?? []);
    const format = imagesOnly ? 'images' : input.format || 'all';
    if (!['images', 'text', 'all', 'live'].includes(format)) throw new Error('保存格式无效。');
    if ((format === 'images' || format === 'live') && !images.length) throw new Error('请先选择图片。');
    const transfer = beginTransfer(input), { controller, requestId } = transfer;
    saving = true;
    const total = format === 'text' ? 0 : images.filter(image => format !== 'live' || image.liveVideo?.url)
      .reduce((count, image) => count + 1 + (['all', 'live'].includes(format) && image.liveVideo?.url ? 1 : 0), 0)
      + (format === 'all' && (note.originalVideos?.length || note.videos?.length) ? 1 : 0);
    let completedBytes = 0;
    const progress = state => emit('transfer', { requestId, total, ...state });
    try {
      progress({ phase: 'preparing', completed: 0, message: '请选择保存位置。' });
      const root = input.directory ? await approvedDirectory(input.directory) : await chooseDirectory(controller.signal);
      if (!root) { progress({ phase: 'cancelled' }); return { ok: true, cancelled: true }; }
      throwIfAborted(controller.signal);
      const id = /^[a-f0-9]{24}$/i.test(note.noteId || '') ? note.noteId : randomUUID().slice(0, 8);
      const target = await ensureNoteDirectory(root, `${safeFilename(note.title || '小红书笔记', 55, 160)}-${id}`);
      approved.add(target);
      const files = [];
      async function saveAsset(asset) {
        const urls = [...new Set([asset.url, ...(asset.backupUrls || [])])]; let lastError;
        if (urls.length > 20) throw new Error('媒体备用地址过多。');
        for (const url of urls) {
          try {
            const result = await downloadMedia({ root, directory: target, asset: { ...asset, url }, signal: controller.signal, fetchImpl: nativeNetwork,
              onProgress: state => progress({ ...state, completed: files.length, receivedBytes: completedBytes + (state.loadedBytes || 0), message: `正在保存第 ${files.length + 1} 个素材` }) });
            files.push(result); completedBytes += result.bytes;
            progress({ completed: files.length, receivedBytes: completedBytes, message: `已保存 ${files.length} / ${total} 个素材` }); return;
          } catch (error) { lastError = error; if (controller.signal.aborted) throw error; }
        }
        throw lastError || new Error('媒体下载失败。');
      }
      if (format !== 'text') for (const image of images) {
        throwIfAborted(controller.signal);
        if (format !== 'live' || image.liveVideo?.url) {
          await saveAsset({ key: `image-${String(image.index).padStart(3, '0')}`, kind: 'image', url: image.url });
          if ((format === 'all' || format === 'live') && image.liveVideo?.url) await saveAsset({ key: `live-${String(image.index).padStart(3, '0')}`, kind: 'video',
            url: image.liveVideo.url, backupUrls: image.liveVideo.backupUrls, requireAudio: false });
          else if ((format === 'all' || format === 'live') && image.livePhoto) throw new Error('实况缺少配对视频，未标记为完整下载。');
        }
      }
      if (format === 'all') {
        const originals = (note.originalVideos || []).filter(item => item.hasAudio !== false);
        const candidates = originals.length ? originals : (note.videos || []).filter(item => item.hasAudio !== false);
        const selected = candidates.find(item => item.isDefault) || candidates[0];
        if (!selected && ((note.videos?.length || note.originalVideos?.length) || ['video', 'mixed'].includes(note.type))) {
          throw new Error('当前笔记未提供包含声音的完整视频，未将整篇标为保存完成。');
        }
        if (selected) await saveAsset({ key: 'video', kind: 'video', url: selected.url,
          backupUrls: [...(selected.backupUrls || []), ...candidates.filter(item => item !== selected && item.hasAudio !== false).map(item => item.url)], requireAudio: true });
      }
      if (!imagesOnly) {
        throwIfAborted(controller.signal);
        const text = makeNoteTextFileData({ title: String(note.title || '').slice(0, 1000), content: String(note.content || ''), sourceUrl: String(note.sourceUrl || ''), engine: note.engine || 'desktop' });
        await atomicWrite(root, target, '笔记.txt', Buffer.from(text));
        await atomicWrite(root, target, '笔记.json', JSON.stringify({ ...note, files, downloadedAt: new Date().toISOString() }, null, 2));
      }
      if (format === 'live' && !files.length) throw new Error('所选图片没有可保存的实况视频。');
      throwIfAborted(controller.signal);
      progress({ phase: 'saved', completed: files.length, receivedBytes: completedBytes, message: '素材已保存。' });
      return { ok: true, cancelled: false, path: target, directory: target, count: files.length, files };
    } catch (error) {
      if (controller.signal.aborted || error.name === 'AbortError') {
        progress({ phase: 'cancelled', receivedBytes: completedBytes });
        return { ok: true, cancelled: true };
      }
      progress({ phase: 'error', receivedBytes: completedBytes, message: error.message });
      throw error;
    } finally { saving = false; endTransfer(transfer); }
  }
  async function exportArchive(input) {
    const note = input.note;
    if (!note || typeof note !== 'object' || JSON.stringify(note).length > 4 * 1024 * 1024) throw new Error('笔记信息无效或过大。');
    const images = selection(input.images ?? note.images ?? []);
    if (!images.length) throw new Error('请先选择图片。');
    if (!['images', 'live', 'selected'].includes(input.format)) throw new Error('压缩包格式无效。');
    if (input.format === 'live' && images.some(image => !image.liveVideo?.url)) throw new Error('所选图片缺少配对实况视频，请只选择完整实况。');
    const requestId = input.requestId || randomUUID();
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw new Error('压缩包请求编号无效。');
    if (archives.size || genericTransfers.size || video.requests.size) throw new Error('请先完成或取消当前素材操作。');
    const controller = new AbortController(); archives.set(requestId, controller); transfers.add(controller);
    let stage;
    const signal = controller.signal;
    // Keep the source downloader's shared desktop ZIP budget: all originals,
    // paired clips and note text share 256 MiB, with space reserved for headers.
    const maxTotalBytes = 256 * 1024 ** 2;
    const payloadLimitBytes = maxTotalBytes - 256 * 1024;
    const archiveLimitError = () => Object.assign(new Error('所选媒体超过当前桌面端 256 MiB 的归档上限，请减少勾选数量、分批下载或保存到文件夹。'), { name: 'ArchiveSizeLimitError', limitBytes: maxTotalBytes });
    const text = makeNoteTextFileData({ title: note.title, content: note.content, sourceUrl: note.sourceUrl, engine: note.engine || 'desktop' });
    let consumed = text.byteLength;
    let receivedBytes = 0;
    const emitProgress = state => emit('archive', { requestId, ...state });
    try {
      emitProgress({ phase: 'preparing', completed: 0, message: '请选择保存位置。' });
      const kind = input.format === 'live' ? '实况' : input.format === 'selected' ? '所选素材' : '原图';
      const choice = await abortableOperation(() => dialog.showSaveDialog(getWindow(), { title: `保存${kind}压缩包`,
        defaultPath: `${safeFilename(note.title || '小红书笔记', 80, 200)}-${kind}.zip`,
        filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }], properties: ['createDirectory', 'showOverwriteConfirmation'] }), signal);
      throwIfAborted(signal);
      if (choice.canceled || !choice.filePath) { emitProgress({ phase: 'cancelled' }); return { ok: true, cancelled: true }; }
      if (!path.isAbsolute(choice.filePath)) throw new Error('压缩包保存位置无效。');
      const root = await fs.realpath(path.dirname(choice.filePath)), name = path.basename(choice.filePath);
      await assertSafeTarget(root, root, name);
      const assets = images.flatMap(image => {
        const key = `${String(image.index).padStart(3, '0')}-${safeFilename(note.title || '小红书', 40, 100)}`;
        if (input.format === 'selected' && image.livePhoto && !image.liveVideo?.url) throw new Error('所选实况缺少配对视频，请重新解析后保存。');
        return [{ key, kind: 'image', imageIndex: image.index, url: image.url }, ...(['live', 'selected'].includes(input.format) && image.liveVideo?.url ? [{ key, kind: 'video', imageIndex: image.index, url: image.liveVideo.url,
          backupUrls: image.liveVideo.backupUrls, size: image.liveVideo.size, requireAudio: false }] : [])];
      });
      const declaredBytes = assets.reduce((total, asset) => {
        if (asset.size === undefined || asset.size === null || asset.size === '') return total;
        const size = Number(asset.size);
        return total + (Number.isFinite(size) && size >= 0 && Number.isSafeInteger(Math.ceil(size)) ? Math.ceil(size) : Number.MAX_SAFE_INTEGER);
      }, 0);
      if (!Number.isSafeInteger(declaredBytes) || consumed + declaredBytes > payloadLimitBytes) throw archiveLimitError();
      stage = await fs.mkdtemp(path.join(root, '.brclio-xhs-zip-'));
      const files = [{ name: '笔记.txt', data: text }];
      const failures = [], failedImages = new Set();
      for (const [index, asset] of assets.entries()) {
        throwIfAborted(signal);
        try {
          // Match the source: never add an orphan live clip when its still failed.
          if (asset.kind === 'video' && failedImages.has(asset.imageIndex)) throw new Error('配对原图下载失败，未加入孤立的实况 MP4。');
          const remaining = payloadLimitBytes - consumed;
          if (remaining <= 0) throw archiveLimitError();
          const urls = [...new Set([asset.url, ...(asset.backupUrls || [])])];
          if (urls.length > 20) throw new Error('媒体备用地址过多。');
          let file, lastError;
          for (const url of urls) {
            try {
              file = await downloadMedia({ root, directory: stage, asset: { ...asset, url }, signal, fetchImpl: network,
                maxBytes: remaining,
                onProgress: state => emitProgress({ completed: index, total: assets.length, ...state,
                  receivedBytes: receivedBytes + (state.loadedBytes || 0) }) });
              break;
            } catch (error) {
              if (signal.aborted || ['AbortError', 'ArchiveSizeLimitError'].includes(error.name)) throw error;
              if (/^媒体文件(?:大小)?超过 .+ 限制。$/.test(error.message)) throw archiveLimitError();
              lastError = error;
            }
          }
          if (!file) throw lastError || new Error('压缩包素材下载失败。');
          const stat = await fs.lstat(path.join(stage, file.name));
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes || stat.size > remaining) throw new Error('压缩包素材大小校验失败。');
          const data = await fs.readFile(path.join(stage, file.name));
          consumed += file.bytes;
          receivedBytes += file.bytes;
          files.push({ name: file.name, data });
        } catch (error) {
          if (signal.aborted || ['AbortError', 'ArchiveSizeLimitError'].includes(error.name)) throw error;
          failures.push({ kind: asset.kind, index: asset.imageIndex, message: error.message });
          if (asset.kind === 'image') failedImages.add(asset.imageIndex);
        } finally {
          emitProgress({ phase: 'downloading', completed: index + 1, total: assets.length, receivedBytes,
            savedCount: files.length - 1, failedCount: failures.length });
        }
      }
      const savedCount = files.length - 1;
      if (!savedCount) throw Object.assign(new Error(`所有图片均下载失败。${failures[0]?.message || ''}`), { code: 'ARCHIVE_ALL_MEDIA_FAILED', failures });
      throwIfAborted(signal); emitProgress({ phase: 'archiving', completed: assets.length, total: assets.length, receivedBytes });
      const { estimateStoredZipSize } = await import('./lib/archive.js');
      const expectedSize = estimateStoredZipSize(files);
      if (expectedSize > maxTotalBytes) throw archiveLimitError();
      const zip = makeZipBlob(files); files.length = 0;
      if (zip.size > maxTotalBytes || zip.size !== expectedSize) throw archiveLimitError();
      const temporary = path.join(stage, 'archive.zip');
      await pipeline(Readable.fromWeb(zip.stream()), createWriteStream(temporary, { flags: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), mode: 0o600 }), { signal });
      await assertSafeTarget(root, root, name); throwIfAborted(signal);
      const target = path.join(root, name); await fs.rename(temporary, target);
      emitProgress({ phase: 'saved', completed: assets.length, total: assets.length, receivedBytes, savedCount, failedCount: failures.length,
        message: failures.length ? `ZIP 已保存：${savedCount} 个素材成功，${failures.length} 个未加入。` : 'ZIP 已保存，内含所选素材与笔记文案。' });
      return { ok: true, cancelled: false, path: target, count: savedCount, total: assets.length,
        failedCount: failures.length, failures, bytes: zip.size };
    } catch (error) {
      if (signal.aborted || error.name === 'AbortError') {
        emitProgress({ phase: 'cancelled', receivedBytes });
        return { ok: true, cancelled: true };
      }
      emitProgress({ phase: 'error', receivedBytes, message: error.message });
      throw error;
    } finally {
      archives.delete(requestId); transfers.delete(controller);
      if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }
  async function request(action, input = {}) {
    if (closing) throw new Error('客户端正在退出。');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('小红书操作参数无效。');
    switch (action) {
      case 'info': return { platform: process.platform, pythonAvailable: await ensurePython(), engine: 'node', features: ['single', 'original-video', 'profile', 'live-photo', 'clipboard'] };
      case 'parse': {
        if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 3000) throw new Error('请粘贴有效的小红书分享文案或链接（最多 3000 字）。');
        if (input.engine !== undefined && !['node', 'python'].includes(input.engine)) throw new Error('解析引擎无效。');
        const body = JSON.stringify({ text: input.text }); let response;
        if (input.engine === 'python') {
          if (!await ensurePython()) throw new Error('Python 备用引擎尚未准备好，请运行 npm run prepare:xhs 或使用完整安装包。');
          response = await python.request({ path: '/api/python_parse', method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        } else response = await invokeHandler(parse, { method: 'POST', body });
        const result = await response.json(); if (!response.ok || !result.success) throw new Error(result.message || '小红书解析失败。');
        return result;
      }
      case 'chooseDirectory': return chooseDirectory(lifetime.signal);
      case 'openDirectory': { const root = await approvedDirectory(input.directory || manager.snapshot().directory); const error = await shell.openPath(root); if (error) throw new Error(error); return true; }
      case 'readClipboard': return clipboard.readText();
      case 'openVideo': {
        if (typeof input.url !== 'string' || input.url.length > 12020 || !isXhsVideoUrl(input.url) || new URL(input.url).protocol !== 'https:') throw new Error('视频链接无效。');
        await shell.openExternal(input.url); return { ok: true };
      }
      case 'login': reset.assertIdle(); return abortableOperation(() => browser.openLogin(input.profileUrl || undefined), lifetime.signal);
      case 'loginState': {
        const existing = [browser.accountWindow, browser.profileWindow, browser.detailWindow].find(win => win && !win.isDestroyed());
        return reset.busy || !existing ? { ...browser.loginState } : abortableOperation(() => browser.refreshLogin(existing), lifetime.signal);
      }
      case 'clearLogin': return abortableOperation(() => reset.run(), lifetime.signal);
      case 'profileState': return manager.snapshot();
      case 'startProfile': { const revision = reset.revision; reset.assertIdle(); const root = await approvedDirectory(input.directory); reset.assertIdle(revision);
        return manager.start({ profileUrl: input.profileUrl, directory: root, intervalSeconds: input.intervalSeconds, jitterSeconds: input.jitterSeconds }); }
      case 'pauseProfile': return manager.pause();
      case 'cancelProfile': return manager.cancel();
      case 'resumeProfile': case 'retryFailed': case 'retryItem': {
        const revision = reset.revision; reset.assertIdle(); await approvedDirectory(manager.snapshot().directory); reset.assertIdle(revision);
        return action === 'resumeProfile' ? manager.resume() : action === 'retryFailed' ? manager.retryFailed() : manager.retryItem(input.noteId);
      }
      case 'saveVideo':
        if (genericTransfers.size || archives.size || video.requests.size) throw new Error('请先完成或取消当前素材操作。');
        return video.save(input);
      case 'cancelVideo': return video.cancel(input.requestId);
      case 'copyImages': return track(copyImages(input));
      case 'saveImages': return track(saveNote(input, true));
      case 'saveNote': return track(saveNote(input));
      case 'exportArchive': return track(exportArchive(input));
      case 'cancelArchive': { const controller = archives.get(input.requestId); controller?.abort(); return { ok: true, cancelled: Boolean(controller) }; }
      case 'cancelTransfer': {
        const controller = input.requestId ? genericTransfers.get(input.requestId) : genericTransfers.values().next().value;
        controller?.abort(); return { ok: true, cancelled: Boolean(controller) };
      }
      default: throw new Error('不支持的小红书操作。');
    }
  }
  async function handleProtocol(incoming) {
    try {
      if (closing) return jsonError('客户端正在退出。', 503);
      const url = new URL(incoming.url);
      if (url.protocol !== 'brclio-xhs:' || url.hostname !== 'local' || url.username || url.password || url.port) return jsonError('不支持的本地媒体地址。', 403);
      if (incoming.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      const route = url.pathname;
      if (route === '/api/python_image' || (route === '/api/python_video' && ['meta', 'chunk'].includes(url.searchParams.get('action')))) {
        if (incoming.method !== 'GET') return jsonError('只支持 GET 请求。', 405);
        if (!await ensurePython()) return jsonError('Python 备用引擎不可用，请使用完整安装包。', 503);
        if (route === '/api/python_image' && !url.searchParams.has('token') && url.searchParams.has('url')) {
          const token = extractOriginalAssetToken(url.searchParams.get('url')); if (!token) return jsonError('图片资源标识无效。');
          url.searchParams.set('token', token);
        }
        return cors(await python.request({ path: `${route}${url.search}`, method: 'GET', headers: Object.fromEntries(incoming.headers), body: '' }, incoming.signal));
      }
      if (['/api/video', '/api/python_video'].includes(route) && ['meta', 'chunk'].includes(url.searchParams.get('action'))) {
        if (incoming.method !== 'GET') return jsonError('只支持 GET 请求。', 405);
        return cors(await invokeHandler(videoProxy, { query: Object.fromEntries(url.searchParams) }));
      }
      if (['/api/image', '/api/python_image', '/api/video', '/api/python_video'].includes(route)) {
        if (!['GET', 'HEAD'].includes(incoming.method)) return jsonError('只支持 GET 请求。', 405);
        const kind = route.endsWith('image') ? 'image' : 'video';
        const source = url.searchParams.get('url') || (kind === 'image' ? buildNoWatermarkUrl(url.searchParams.get('token')) : '');
        const range = incoming.headers.get('range');
        if (range && !/^bytes=\d+-\d*$/.test(range)) return jsonError('视频范围无效。', 416);
        const upstream = await fetchMedia(source, { fetchImpl: network, kind, range, signal: incoming.signal });
        const headers = new Headers(CORS);
        for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
          const value = upstream.headers.get(name); if (value) headers.set(name, value);
        }
        if (incoming.method === 'HEAD') { await upstream.body?.cancel().catch(() => {}); return new Response(null, { status: upstream.status, headers }); }
        return new Response(upstream.body, { status: upstream.status, headers });
      }
      return jsonError('本地媒体接口不存在。', 404);
    } catch (error) { return jsonError(error.message || '本地媒体请求失败。', 502); }
  }
  async function close() {
    closing = true; lifetime.abort(new Error('客户端正在退出。')); for (const controller of transfers) controller.abort();
    python.close(); await Promise.allSettled([manager.shutdown(), video.shutdown(), ...operations]); browser.close();
  }
  return { request: (action, input) => track(request(action, input)), handleProtocol: incoming => track(handleProtocol(incoming)), close,
    isBusy: () => Boolean(genericTransfers.size || archives.size || video.requests.size || ['discovering', 'downloading', 'waiting'].includes(manager.snapshot().status)) };
}

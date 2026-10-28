import fs from 'node:fs/promises';
import path from 'node:path';
import { isXhsVideoUrl } from '../lib/xhs.js';
import { downloadMedia, safeFilename, assertSafeTarget, throwIfAborted, abortableOperation } from './media-download.js';

function invalid(message) { return Object.assign(new Error(message), { code: 'VIDEO_INPUT_INVALID', status: 400 }); }

// Preserve the source native downloader's validation and candidate ordering.
function selection(input) {
  if (!input || typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId)) throw invalid('视频下载请求无效。');
  if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 1000)) throw invalid('视频标题无效。');
  if (input.filename !== undefined && (typeof input.filename !== 'string' || input.filename.length > 1000)) throw invalid('视频文件名无效。');
  const video = input.video;
  if (!video || typeof video !== 'object' || (video.backupUrls !== undefined && !Array.isArray(video.backupUrls))) throw invalid('视频信息无效，请重新解析。');
  const urls = [video.url, ...(video.backupUrls || [])];
  if (urls.length > 20 || urls.some(url => typeof url !== 'string' || url.length > 12020 || !isXhsVideoUrl(url) || new URL(url).protocol !== 'https:')) throw invalid('视频链接无效，请重新解析。');
  return { urls: [...new Set(urls)],
    filename: `${safeFilename((input.filename || input.title || '小红书视频').replace(/\.mp4$/i, ''), 100, 220)}.mp4`,
    requireAudio: input.requireAudio !== false };
}

/** A trusted save dialog owns the output path; the renderer supplies only media. */
export class NativeVideoDownload {
  constructor({ showSaveDialog, fetchImpl = fetch, onProgress = () => {}, onDiagnostic = () => {} }) {
    Object.assign(this, { showSaveDialog, fetchImpl, onProgress, onDiagnostic });
    this.requests = new Map(); this.operations = new Set(); this.stopping = false;
  }
  progress(requestId, value) {
    try { Promise.resolve(this.onProgress({ requestId, ...value })).catch(() => {}); } catch { /* UI cannot interrupt saving. */ }
  }
  save(input) {
    const operation = this.saveSelection(input);
    this.operations.add(operation);
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation));
    return operation;
  }
  async saveSelection(input) {
    let controller, stage;
    const requestId = input?.requestId;
    try {
      if (this.stopping) throw Object.assign(new Error('客户端正在退出。'), { code: 'DOWNLOAD_SHUTDOWN' });
      const { urls, filename, requireAudio } = selection(input);
      if (this.requests.has(requestId)) throw invalid('该视频正在下载，请稍候。');
      if (this.requests.size >= 4) throw invalid('同时下载的视频过多，请等待当前下载完成。');
      controller = new AbortController(); this.requests.set(requestId, controller);
      const signal = controller.signal;
      this.progress(requestId, { phase: 'preparing', loadedBytes: 0, message: '请选择保存位置。' });
      const choice = await abortableOperation(() => this.showSaveDialog({ title: '保存视频', defaultPath: filename,
        filters: [{ name: 'MP4 视频', extensions: ['mp4'] }], properties: ['createDirectory', 'showOverwriteConfirmation'] }), signal);
      throwIfAborted(signal);
      if (choice?.canceled || !choice?.filePath) {
        this.progress(requestId, { phase: 'cancelled' });
        return { ok: true, cancelled: true };
      }
      if (!path.isAbsolute(choice.filePath)) throw invalid('保存位置无效，请重新选择。');
      const root = await fs.realpath(path.dirname(choice.filePath)); const name = path.basename(choice.filePath);
      await assertSafeTarget(root, root, name);
      throwIfAborted(signal);
      stage = await fs.mkdtemp(path.join(root, '.brclio-xhs-video-'));
      let file, lastError;
      for (const [index, url] of urls.entries()) {
        throwIfAborted(signal);
        try {
          this.progress(requestId, { phase: 'downloading', loadedBytes: 0, totalBytes: null, attempt: index + 1 });
          file = await downloadMedia({ root, directory: stage, signal, fetchImpl: this.fetchImpl,
            asset: { key: 'video', kind: 'video', url, requireAudio }, onDiagnostic: this.onDiagnostic,
            onProgress: state => this.progress(requestId, { attempt: index + 1, ...state }) });
          break;
        } catch (error) { lastError = error; if (signal.aborted) throw error; }
      }
      if (!file) throw lastError || new Error('视频下载失败。');
      await assertSafeTarget(root, root, name); throwIfAborted(signal);
      const target = path.join(root, name); await fs.rename(path.join(stage, file.name), target);
      this.progress(requestId, { phase: 'saved', loadedBytes: file.bytes, totalBytes: file.bytes });
      return { ok: true, cancelled: false, path: target, bytes: file.bytes, mediaTracks: file.mediaTracks };
    } catch (error) {
      if (controller?.signal.aborted || error.name === 'AbortError') {
        this.progress(requestId, { phase: 'cancelled' });
        return { ok: true, cancelled: true };
      }
      this.progress(requestId, { phase: 'error', message: error.message });
      return { ok: false, cancelled: false, error: { code: error.cause?.code || error.code || 'VIDEO_DOWNLOAD_FAILED',
        status: error.status || error.statusCode || 500, message: error.message || '视频下载失败，请重试。' } };
    } finally {
      if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
      if (controller && this.requests.get(requestId) === controller) this.requests.delete(requestId);
    }
  }
  cancel(requestId) { const controller = this.requests.get(requestId); controller?.abort(); return { ok: true, cancelled: Boolean(controller) }; }
  cancelAll() { for (const controller of this.requests.values()) controller.abort(); }
  async shutdown() { this.stopping = true; this.cancelAll(); await Promise.allSettled([...this.operations]); }
}

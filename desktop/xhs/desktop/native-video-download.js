import fs from 'node:fs/promises';
import path from 'node:path';
import { isXhsVideoUrl } from '../lib/xhs.js';
import { downloadMedia, safeFilename, assertSafeTarget, throwIfAborted, abortableOperation } from './media-download.js';

/** A trusted save dialog owns the output path; the renderer supplies only media. */
export class NativeVideoDownload {
  constructor({ showSaveDialog, fetchImpl = fetch, onProgress = () => {} }) {
    Object.assign(this, { showSaveDialog, fetchImpl, onProgress });
    this.requests = new Map(); this.operations = new Set(); this.stopping = false;
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
      if (this.stopping) throw new Error('客户端正在退出。');
      if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw new Error('视频下载请求无效。');
      if (this.requests.has(requestId) || this.requests.size >= 4) throw new Error('请等待当前视频下载完成。');
      const video = input.video;
      if (!video || (video.backupUrls !== undefined && !Array.isArray(video.backupUrls))) throw new Error('视频信息无效。');
      const urls = [...new Set([video.url, ...(video.backupUrls || [])])];
      if (!urls.length || urls.length > 20 || urls.some(url => typeof url !== 'string' || url.length > 12020 || !isXhsVideoUrl(url) || new URL(url).protocol !== 'https:')) throw new Error('视频链接无效。');
      controller = new AbortController(); this.requests.set(requestId, controller);
      const signal = controller.signal;
      const filename = `${safeFilename(String(input.filename || input.title || '小红书视频').replace(/\.mp4$/i, ''), 100, 220)}.mp4`;
      const choice = await abortableOperation(() => this.showSaveDialog({ title: '保存视频', defaultPath: filename,
        filters: [{ name: 'MP4 视频', extensions: ['mp4'] }], properties: ['createDirectory', 'showOverwriteConfirmation'] }), signal);
      throwIfAborted(signal);
      if (choice.canceled || !choice.filePath) return { ok: true, cancelled: true };
      if (!path.isAbsolute(choice.filePath)) throw new Error('保存位置无效。');
      const root = await fs.realpath(path.dirname(choice.filePath)); const name = path.basename(choice.filePath);
      await assertSafeTarget(root, root, name);
      stage = await fs.mkdtemp(path.join(root, '.brclio-xhs-video-'));
      let file, lastError;
      for (const [index, url] of urls.entries()) {
        throwIfAborted(signal);
        try {
          file = await downloadMedia({ root, directory: stage, signal, fetchImpl: this.fetchImpl,
            asset: { key: 'video', kind: 'video', url, requireAudio: input.requireAudio !== false },
            onProgress: state => this.onProgress({ requestId, attempt: index + 1, ...state }) });
          break;
        } catch (error) { lastError = error; if (signal.aborted) throw error; }
      }
      if (!file) throw lastError || new Error('视频下载失败。');
      await assertSafeTarget(root, root, name); throwIfAborted(signal);
      const target = path.join(root, name); await fs.rename(path.join(stage, file.name), target);
      this.onProgress({ requestId, phase: 'saved', loadedBytes: file.bytes, totalBytes: file.bytes });
      return { ok: true, cancelled: false, path: target, bytes: file.bytes, mediaTracks: file.mediaTracks };
    } catch (error) {
      if (controller?.signal.aborted || error.name === 'AbortError') return { ok: true, cancelled: true };
      return { ok: false, error: { code: error.code || 'VIDEO_DOWNLOAD_FAILED', message: error.message } };
    } finally {
      if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
      if (controller && this.requests.get(requestId) === controller) this.requests.delete(requestId);
    }
  }
  cancel(requestId) { const controller = this.requests.get(requestId); controller?.abort(); return { ok: true, cancelled: Boolean(controller) }; }
  async shutdown() { this.stopping = true; for (const controller of this.requests.values()) controller.abort(); await Promise.allSettled([...this.operations]); }
}

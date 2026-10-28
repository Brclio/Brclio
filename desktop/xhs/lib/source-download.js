// Download algorithms copied verbatim from app.js in the source downloader.
// Source commit: a818212fc0d4450f8cf192e644cdc2f39103e810.
// Host adapters supply URL routing, cancellation and progress without rewriting
// source fallback order, byte limits, chunk checks or the shared archive budget.
import { estimateStoredZipSize } from './archive.js';

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "大小未知";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 100 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

export function createSourceDownload({
  fetch = globalThis.fetch, proxyUrl, videoApiUrl, setProgress = () => {},
  formatBytes: renderBytes = formatBytes,
  navigator: device = { userAgent: 'Desktop', deviceMemory: 8, maxTouchPoints: 0 },
} = {}) {
  if (typeof fetch !== 'function' || typeof proxyUrl !== 'function' || typeof videoApiUrl !== 'function') {
    throw new TypeError('Source download requires fetch, proxyUrl and videoApiUrl adapters.');
  }
  const formatBytes = renderBytes;
  const navigator = device;
const MEBIBYTE = 1024 * 1024;
const DESKTOP_ARCHIVE_LIMIT_BYTES = 256 * MEBIBYTE;
const CONSTRAINED_ARCHIVE_LIMIT_BYTES = 128 * MEBIBYTE;
const ARCHIVE_OVERHEAD_RESERVE_BYTES = 256 * 1024;
const ARCHIVE_SIZE_LIMIT_ERROR = "ArchiveSizeLimitError";

function declaredVideoSize(video) {
  const rawSize = video?.size;
  if (rawSize === undefined || rawSize === null || rawSize === "") return 0;
  const size = Number(rawSize);
  if (!Number.isFinite(size) || size < 0) return Number.MAX_SAFE_INTEGER;
  if (size === 0) return 0;
  const rounded = Math.ceil(size);
  return Number.isSafeInteger(rounded) ? rounded : Number.MAX_SAFE_INTEGER;
}

function archiveLimitProfile() {
  const userAgent = String(navigator.userAgent || "");
  const mobileHint = navigator.userAgentData?.mobile === true
    || /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)
    || (/Macintosh/i.test(userAgent) && Number(navigator.maxTouchPoints || 0) > 1);
  const deviceMemory = Number(navigator.deviceMemory || 0);
  const lowMemory = Number.isFinite(deviceMemory) && deviceMemory > 0 && deviceMemory <= 4;
  const constrained = mobileHint || lowMemory;

  return {
    constrained,
    label: constrained ? "移动端或低内存设备" : "桌面端",
    limitBytes: constrained
      ? CONSTRAINED_ARCHIVE_LIMIT_BYTES
      : DESKTOP_ARCHIVE_LIMIT_BYTES
  };
}

function isArchiveSizeLimitError(error) {
  return error?.name === ARCHIVE_SIZE_LIMIT_ERROR;
}

function createArchiveBudget(kind) {
  const profile = archiveLimitProfile();
  const payloadLimitBytes = profile.limitBytes - ARCHIVE_OVERHEAD_RESERVE_BYTES;
  const subject = kind === "batch" ? "所选媒体" : "这张实况图片";
  const advice = kind === "batch"
    ? "请减少勾选数量或分批下载。"
    : "请在内存更充足的桌面浏览器中重试，或只下载原图 / 实况 MP4。";
  let committedBytes = 0;

  function limitError(label, attemptedBytes = 0) {
    const attempted = Number(attemptedBytes);
    const normalizedAttempt = Number.isFinite(attempted)
      ? Math.max(0, attempted)
      : 0;
    const projectedBytes = committedBytes
      + normalizedAttempt
      + ARCHIVE_OVERHEAD_RESERVE_BYTES;
    const projected = normalizedAttempt > 0
      ? `预计归档至少需要 ${formatBytes(projectedBytes)}，`
      : "";
    const error = new Error(
      `${label || subject}${projected}超过当前${profile.label} ${formatBytes(profile.limitBytes)} 的浏览器归档上限。${advice}`
    );
    error.name = ARCHIVE_SIZE_LIMIT_ERROR;
    error.limitBytes = profile.limitBytes;
    return error;
  }

  function assertFits(byteLength, label) {
    const bytes = Number(byteLength ?? 0);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw limitError(label);
    if (committedBytes + bytes > payloadLimitBytes) {
      throw limitError(label, bytes);
    }
  }

  function remainingBytes(label) {
    const remaining = payloadLimitBytes - committedBytes;
    if (remaining <= 0) throw limitError(label);
    return remaining;
  }

  async function consumeBlob(blob, label) {
    assertFits(blob.size, label);
    const buffer = await blob.arrayBuffer();
    assertFits(buffer.byteLength, label);
    committedBytes += buffer.byteLength;
    return new Uint8Array(buffer);
  }

  function consumeData(data, label) {
    if (!(data instanceof Uint8Array)) throw limitError(label);
    assertFits(data.byteLength, label);
    committedBytes += data.byteLength;
    return data;
  }

  function assertFilesFit(files) {
    const estimatedSize = estimateStoredZipSize(files);
    if (estimatedSize > profile.limitBytes) {
      throw limitError(
        `${subject}生成的 ZIP`,
        Math.max(0, estimatedSize - committedBytes)
      );
    }
    return estimatedSize;
  }

  function assertFinalZip(blob, expectedSize) {
    if (blob.size > profile.limitBytes || blob.size !== expectedSize) {
      throw limitError(`${subject}生成的 ZIP`);
    }
  }

  return {
    assertFilesFit,
    assertFinalZip,
    assertFits,
    consumeBlob,
    consumeData,
    limitErrorFactory: (label) => () => limitError(label),
    remainingBytes
  };
}

async function readApiError(response) {
  try {
    const body = await response.json();
    return body.message || `请求失败：HTTP ${response.status}`;
  } catch {
    return `请求失败：HTTP ${response.status}`;
  }
}

function imageTooLargeError() {
  const error = new Error("单张原图超过 30 MB，请改用下载原图或 ZIP。");
  error.name = "ImageTooLargeError";
  return error;
}

function responseSizeLimitError(limitErrorFactory) {
  return typeof limitErrorFactory === "function"
    ? limitErrorFactory()
    : imageTooLargeError();
}

async function responseBlobWithLimit(
  response,
  maxBytes = 0,
  limitErrorFactory = null,
  onProgress = null
) {
  const contentType = response.headers.get("content-type") || "";
  if (!maxBytes && typeof onProgress !== "function") return response.blob();

  const contentLength = Number(response.headers.get("content-length") || 0);
  const total = Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : 0;
  if (maxBytes && Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw responseSizeLimitError(limitErrorFactory);
  }

  if (!response.body?.getReader) {
    const blob = await response.blob();
    if (maxBytes && blob.size > maxBytes) {
      throw responseSizeLimitError(limitErrorFactory);
    }
    onProgress?.({ loadedBytes: blob.size, totalBytes: total });
    return blob;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (maxBytes && totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw responseSizeLimitError(limitErrorFactory);
      }
      chunks.push(value);
      onProgress?.({ loadedBytes: totalBytes, totalBytes: total });
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    chunks.length = 0;
    throw error;
  } finally {
    reader.releaseLock?.();
  }

  return new Blob(chunks, { type: contentType });
}

async function fetchImageBlob(
  image,
  { signal, maxBytes = 0, limitErrorFactory = null } = {}
) {
  const response = await fetch(proxyUrl(image), { signal });

  if (response.ok) {
    return responseBlobWithLimit(response, maxBytes, limitErrorFactory);
  }

  if (response.status === 413) {
    try {
      const directResponse = await fetch(image.url, {
        mode: "cors",
        referrerPolicy: "no-referrer",
        signal
      });
      if (directResponse.ok) {
        return responseBlobWithLimit(
          directResponse,
          maxBytes,
          limitErrorFactory
        );
      }
    } catch (error) {
      if (
        ["AbortError", "ImageTooLargeError"].includes(error?.name)
        || isArchiveSizeLimitError(error)
      ) {
        throw error;
      }
      // 继续抛出更明确的提示。
    }

    throw new Error(
      "图片超过 Vercel 单次响应限制，且浏览器无法跨域读取原图。请点击“打开原图”。"
    );
  }

  throw new Error(await readApiError(response));
}

async function readVideoApiError(response) {
  let body = {};
  try {
    body = await response.json() || {};
  } catch { /* Include the HTTP status when a proxy cannot return JSON. */ }
  const error = new Error(body.message || body.error?.message || `视频请求失败：HTTP ${response.status}`);
  error.code = body.code || body.error?.code;
  error.status = response.status;
  return error;
}

async function getVideoMeta(sourceUrl, fallbackSize = 0) {
  const response = await fetch(videoApiUrl("meta", sourceUrl));
  if (!response.ok) throw await readVideoApiError(response);
  const meta = await response.json();
  const size = Number(meta.size || fallbackSize || 0);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error("无法确定安全的视频大小，不能执行分段下载。");
  }
  const requestedChunkSize = Number(meta.chunkSize || 3_500_000);
  if (!Number.isSafeInteger(requestedChunkSize) || requestedChunkSize <= 0) {
    throw new Error("视频分段大小无效，已停止下载。");
  }
  return {
    size,
    contentType: meta.contentType || "video/mp4",
    chunkSize: Math.min(requestedChunkSize, 3_500_000)
  };
}

function videoTooLargeError(maxBytes, label = "视频") {
  const error = new Error(
    `${label}超过当前 ${formatBytes(maxBytes)} 的安全读取上限。`
  );
  error.name = "VideoTooLargeError";
  return error;
}

function videoSizeLimitError(limitErrorFactory, maxBytes) {
  return typeof limitErrorFactory === "function"
    ? limitErrorFactory()
    : videoTooLargeError(maxBytes);
}

function assertVideoSizeWithinLimit(byteLength, maxBytes, limitErrorFactory) {
  if (!maxBytes) return;
  const bytes = Number(byteLength ?? 0);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes) {
    throw videoSizeLimitError(limitErrorFactory, maxBytes);
  }
}

async function downloadVideoByChunks(
  sourceUrl,
  video,
  { onProgress, maxBytes = 0, limitErrorFactory = null } = {}
) {
  assertVideoSizeWithinLimit(
    declaredVideoSize(video),
    maxBytes,
    limitErrorFactory
  );
  const meta = await getVideoMeta(sourceUrl, video.size);
  assertVideoSizeWithinLimit(meta.size, maxBytes, limitErrorFactory);
  const chunks = [];
  const totalChunks = Math.ceil(meta.size / meta.chunkSize);
  let receivedBytes = 0;

  const reportProgress = (loadedBytes, chunkIndex) => {
    if (typeof onProgress === "function") {
      onProgress({
        loadedBytes,
        totalBytes: meta.size,
        chunkIndex,
        totalChunks
      });
      return;
    }
    setProgress(
      chunkIndex,
      totalChunks,
      `正在分段下载视频 ${formatBytes(loadedBytes)} / ${formatBytes(meta.size)}`
    );
  };

  try {
    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * meta.chunkSize;
      const end = Math.min(meta.size - 1, start + meta.chunkSize - 1);
      const expected = end - start + 1;
      reportProgress(start, index);

      const response = await fetch(
        videoApiUrl("chunk", sourceUrl, {
          start: String(start),
          end: String(end)
        })
      );
      if (!response.ok) throw await readVideoApiError(response);

      const declaredChunkLength = Number(
        response.headers.get("content-length") || 0
      );
      if (
        Number.isFinite(declaredChunkLength)
        && declaredChunkLength > 0
        && declaredChunkLength !== expected
      ) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`视频第 ${index + 1} 段声明长度异常。`);
      }

      const chunk = await responseBlobWithLimit(
        response,
        expected,
        () => new Error(`视频第 ${index + 1} 段长度异常。`),
        ({ loadedBytes }) => reportProgress(receivedBytes + loadedBytes, index)
      );
      if (chunk.size !== expected) {
        throw new Error(`视频第 ${index + 1} 段长度异常。`);
      }
      receivedBytes += chunk.size;
      assertVideoSizeWithinLimit(
        receivedBytes,
        maxBytes,
        limitErrorFactory
      );
      chunks.push(chunk);
      reportProgress(Math.min(meta.size, end + 1), index + 1);
    }
  } catch (error) {
    // 当前线路失败后先释放分段引用，再由上层尝试备用 CDN 或直连。
    chunks.length = 0;
    throw error;
  }

  const blob = new Blob(chunks, { type: meta.contentType || "video/mp4" });
  if (blob.size !== meta.size) {
    throw new Error("视频合并后的长度与元数据不一致。");
  }
  assertVideoSizeWithinLimit(blob.size, maxBytes, limitErrorFactory);
  return blob;
}

async function tryDirectVideoDownload(
  sourceUrl,
  { maxBytes = 0, limitErrorFactory = null, onProgress } = {}
) {
  if (String(sourceUrl).startsWith("member-video:")) throw new Error("会员原视频需要通过授权下载接口读取。");
  const response = await fetch(sourceUrl, {
    mode: "cors",
    referrerPolicy: "no-referrer"
  });
  if (!response.ok) throw new Error(`视频 CDN 返回 HTTP ${response.status}`);
  const factory = limitErrorFactory
    || (maxBytes ? () => videoTooLargeError(maxBytes) : null);
  onProgress?.({ loadedBytes: 0, totalBytes: 0 });
  const blob = await responseBlobWithLimit(response, maxBytes, factory, onProgress);
  assertVideoSizeWithinLimit(blob.size, maxBytes, factory);
  return blob;
}

async function fetchVideoBlobWithFallback(video, options = {}) {
  const { maxBytes = 0, limitErrorFactory = null, onProgress } = options;
  assertVideoSizeWithinLimit(
    declaredVideoSize(video),
    maxBytes,
    limitErrorFactory
  );
  const candidates = [
    ...new Set([video.url, ...(video.backupUrls || [])].filter(Boolean))
  ];
  let lastError = null;

  for (const sourceUrl of candidates) {
    try {
      return await downloadVideoByChunks(sourceUrl, video, options);
    } catch (error) {
      if (isArchiveSizeLimitError(error) || error?.name === "VideoTooLargeError") {
        throw error;
      }
      lastError = error;
    }
  }

  for (const sourceUrl of candidates) {
    try {
      return await tryDirectVideoDownload(sourceUrl, {
        maxBytes,
        limitErrorFactory,
        onProgress
      });
    } catch (error) {
      if (isArchiveSizeLimitError(error) || error?.name === "VideoTooLargeError") {
        throw error;
      }
      lastError = error;
    }
  }

  throw lastError || new Error("实况动态片段下载失败。");
}

function preflightLiveArchive(images, archiveBudget, label) {
  const declaredBytes = images.reduce(
    (total, image) => total + declaredVideoSize(image.liveVideo),
    0
  );
  if (!Number.isSafeInteger(declaredBytes)) {
    throw archiveBudget.limitErrorFactory(label)();
  }
  if (declaredBytes > 0) archiveBudget.assertFits(declaredBytes, label);
}

async function fetchImageArchiveData(image, archiveBudget, label) {
  const limitErrorFactory = archiveBudget.limitErrorFactory(label);
  const blob = await fetchImageBlob(image, {
    maxBytes: archiveBudget.remainingBytes(label),
    limitErrorFactory
  });
  return archiveBudget.consumeBlob(blob, label);
}

async function fetchVideoArchiveData(
  video,
  archiveBudget,
  label,
  onProgress
) {
  const limitErrorFactory = archiveBudget.limitErrorFactory(label);
  const blob = await fetchVideoBlobWithFallback(video, {
    maxBytes: archiveBudget.remainingBytes(label),
    limitErrorFactory,
    onProgress
  });
  return archiveBudget.consumeBlob(blob, label);
}

  return {
    fetchImageBlob, fetchVideoBlobWithFallback, responseBlobWithLimit,
    getVideoMeta, downloadVideoByChunks, tryDirectVideoDownload,
    declaredVideoSize, createArchiveBudget, preflightLiveArchive,
    fetchImageArchiveData, fetchVideoArchiveData, isArchiveSizeLimitError,
  };
}

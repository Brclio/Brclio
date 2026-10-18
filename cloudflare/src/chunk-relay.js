import {officialTarget, redirectTarget} from './protocol.js';
import {tunnelRequest, safeFailure} from './tunnel.js';
import {relayResponse} from './relay.js';

export const MAX_CHUNK_BYTES = 128 * 1024;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024;
const strongETag = value => typeof value === 'string' && /^"[\x21\x23-\x7e]{1,256}"$/.test(value);
const successfulNodes = new WeakMap();
const signedRedirects = new WeakMap();
const REDIRECT_TTL_MS = 60000;
const MAX_REDIRECTS = 16;
class InvalidChunk extends Error {}
class ExpiredRedirect extends Error {}
function redirectsFor(nodes) {
  let redirects = signedRedirects.get(nodes);
  if (!redirects) { redirects = new Map(); signedRedirects.set(nodes, redirects); }
  for (const [key, entry] of redirects) if (entry.expires <= Date.now()) redirects.delete(key);
  return redirects;
}

export function isInstallerTarget(value) {
  const target = officialTarget(value);
  const installer = /^\/Brclio\/Brclio\/releases\/download\/v?(\d+\.\d+\.\d+)\/Brclio-(\d+\.\d+\.\d+)-(?:mac-arm64\.dmg|mac-x64\.dmg|windows-x64\.exe|android\.apk)$/.exec(target.pathname);
  return target.hostname === 'github.com' && Boolean(installer && installer[1] === installer[2]);
}
export function parseChunkRequest(value, range, ifRange) {
  const match = /^bytes=(0|[1-9]\d*)-(0|[1-9]\d*)$/.exec(range || '');
  if (!isInstallerTarget(value) || !match) throw new InvalidChunk('只允许安装包的显式单段范围');
  const start = Number(match[1]), end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start >= MAX_CHUNK_BYTES) throw new InvalidChunk('下载范围超过允许长度');
  if (ifRange !== null && ifRange !== undefined && !strongETag(ifRange)) throw new InvalidChunk('需要有效的强实体标记');
  return {start, end, ifRange: ifRange ?? undefined};
}

function validateHead(response, range) {
  const match = /^bytes (0|[1-9]\d*)-(0|[1-9]\d*)\/(0|[1-9]\d*)$/.exec(response.headers.get('content-range') || '');
  if (response.status !== 206 || !match) throw new InvalidChunk('上游未返回有效的部分下载');
  const start = Number(match[1]), end = Number(match[2]), total = Number(match[3]);
  const length = response.headers.get('content-length'), etag = response.headers.get('etag');
  if (response.headers.has('content-encoding') && response.headers.get('content-encoding').toLowerCase() !== 'identity') throw new InvalidChunk('不支持压缩的下载范围');
  if (![start, end, total].every(Number.isSafeInteger) || total < 1 || total > MAX_ARTIFACT_BYTES || start !== range.start || start >= total || end !== Math.min(range.end, total - 1) || end < start ||
      !/^(0|[1-9]\d*)$/.test(length || '') || Number(length) !== end - start + 1 || end - start + 1 > MAX_CHUNK_BYTES || !strongETag(etag) || (range.ifRange !== undefined && range.ifRange !== etag)) throw new InvalidChunk('上游下载范围或实体标记不一致');
  return {length: end - start + 1, etag};
}

async function completeBody(response, length, signal) {
  const reader = response.body.getReader();
  const output = new Uint8Array(length);
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error('下载已取消');
      let abort;
      const canceled = new Promise((_, reject) => {
        abort = () => reject(new Error('下载已取消'));
        signal.addEventListener('abort', abort, {once: true});
      });
      let next;
      try { next = await Promise.race([reader.read(), canceled]); }
      finally { signal.removeEventListener('abort', abort); }
      if (next.done) break;
      size += next.value.byteLength;
      if (size > length) throw new InvalidChunk('上游下载长度超限');
      output.set(next.value, size - next.value.byteLength);
    }
    if (size !== length) throw new Error('上游下载未完成');
    return output;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// Each invocation verifies and buffers one bounded segment before any bytes escape.
// The two attempts include body failures, and never become a monolithic installer relay.
export async function relayChunk(value, nodes, {range, signal, transport = tunnelRequest, headerDeadlineMs = 18000, waitUntil} = {}) {
  const initial = officialTarget(value);
  range = parseChunkRequest(initial.href, `bytes=${range?.start}-${range?.end}`, range?.ifRange);
  const abort = new AbortController(), failed = new Map();
  let preferred = successfulNodes.get(nodes);
  if (!preferred) { preferred = new Map(); successfulNodes.set(nodes, preferred); }
  const redirects = redirectsFor(nodes);
  const cancel = () => abort.abort();
  signal?.addEventListener('abort', cancel, {once: true});
  if (signal?.aborted) cancel();
  const timer = setTimeout(cancel, Math.max(1, headerDeadlineMs));
  const started = Date.now();
  let active, activeHost, activeNode, refreshedRedirect = false;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (abort.signal.aborted || !nodes.length) throw new Error('下载已取消或没有可用节点');
      const cached = redirects.get(initial.href);
      const usingCache = Boolean(cached && cached.expires > Date.now());
      if (cached && !usingCache) redirects.delete(initial.href);
      let current = usingCache ? new URL(cached.url) : initial;
      try {
        for (let redirect = 0; ; redirect++) {
          if (abort.signal.aborted) throw new Error('下载已取消');
          activeHost = current.hostname;
          const excluded = failed.get(activeHost) || new Set();
          const previous = preferred.get(activeHost);
          activeNode = previous && !excluded.has(previous) ? previous : nodes.find(node => !excluded.has(node));
          if (!activeNode) throw new Error('没有可用的备用节点');
          active = await transport(current, activeNode, {signal: abort.signal, range: `bytes=${range.start}-${range.end}`, ifRange: range.ifRange});
          if (usingCache && active.status === 403) { redirects.delete(initial.href); refreshedRedirect = true; throw new ExpiredRedirect('缓存下载地址已失效'); }
          if (active.status >= 500 || active.status === 429) throw new Error('代理上游暂不可用');
          if (![301, 302, 303, 307, 308].includes(active.status)) break;
          const location = active.headers.get('location');
          active.close(); await active.body?.cancel().catch(() => {}); active = null;
          if (!location || redirect >= 4) throw new InvalidChunk('下载重定向异常');
          try { current = redirectTarget(location, current.href); }
          catch { throw new InvalidChunk('下载重定向异常'); }
          preferred.set(activeHost, activeNode);
        }
        const {length, etag} = validateHead(active, range);
        const bytes = await completeBody(active, length, abort.signal);
        preferred.set(activeHost, activeNode);
        if (!usingCache && ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(current.hostname)) {
          const validated = redirectTarget(current.href, initial.href);
          redirects.delete(initial.href);
          while (redirects.size >= MAX_REDIRECTS) redirects.delete(redirects.keys().next().value);
          redirects.set(initial.href, {url: validated.href, expires: Date.now() + REDIRECT_TTL_MS});
        }
        const headers = new Headers({'Cache-Control': 'no-store, no-transform', 'X-Content-Type-Options': 'nosniff', 'X-Brclio-Route': 'subscription-vless', 'X-Brclio-Redirect-Cache': refreshedRedirect ? 'refreshed' : usingCache ? 'hit' : 'miss', 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream', 'Content-Length': String(length), 'Content-Range': active.headers.get('content-range'), ETag: etag});
        for (const name of ['content-disposition', 'last-modified']) if (active.headers.has(name)) headers.set(name, active.headers.get(name));
        return relayResponse(new Response(bytes).body, {status: 206, headers}, waitUntil);
      } catch (error) {
        if (!(error instanceof ExpiredRedirect)) {
          if (preferred.get(activeHost) === activeNode) preferred.delete(activeHost);
          if (activeNode) { const excluded = failed.get(activeHost) || new Set(); excluded.add(activeNode); failed.set(activeHost, excluded); }
        }
        if (active) { active.close(); await active.body?.cancel().catch(() => {}); active = null; }
        const terminal = error instanceof InvalidChunk || abort.signal.aborted || attempt === 1;
        const failure = error instanceof InvalidChunk ? {stage: 'http', code: 'invalid_segment_response'} : error instanceof ExpiredRedirect ? {stage: 'http', code: 'signed_url_expired'} : abort.signal.aborted ? {stage: 'relay', code: 'timeout_or_cancelled'} : safeFailure(error);
        console.warn(JSON.stringify({event: terminal ? 'proxy_chunk_failed' : 'proxy_chunk_retry', ...failure, attempt: attempt + 1, nodeIndex: nodes.indexOf(activeNode), elapsedMs: Date.now() - started}));
        if (terminal) throw error;
      }
    }
    throw new Error('内置代理暂不可用');
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel); cancel(); active?.close();
  }
}

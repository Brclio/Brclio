'use strict';

const { API_URL } = require('./updater.cjs');

const SERVICE_ORIGIN = 'https://tools.brclio.com';
const SYSTEM_PARTITION = 'brclio-update-system';
const DIRECT_PARTITION = 'brclio-update-direct';
const OFFICIAL_HOSTS = new Set(['github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const CHUNK_BYTES = 1024 * 1024;
const MAX_INSTALLER_BYTES = 1536 * 1024 * 1024;

function routingError(message) { const error = new Error(message); error.code = 'BRCLIO_UPDATE_ROUTE'; return error; }

function officialURL(value, initial = false) {
  let url;
  try { url = new URL(value); } catch { throw routingError('更新地址无效，已停止。'); }
  if (url.protocol !== 'https:' || !OFFICIAL_HOSTS.has(url.hostname) || url.username || url.password || url.port || url.hash) {
    throw routingError('下载重定向至非官方地址，已停止。');
  }
  if (initial && url.href !== API_URL && !(url.hostname === 'github.com' && !url.search
      && /^\/Brclio\/Brclio\/releases\/download\/v?\d+\.\d+\.\d+\/(?:SHA256SUMS\.txt|Brclio-\d+\.\d+\.\d+-(?:mac-(?:arm64|x64)\.dmg|windows-x64\.exe))$/.test(url.pathname))) {
    throw routingError('更新地址不属于 Brclio 官方发布文件。');
  }
  return url.href;
}

function usesProxy(value) {
  const first = typeof value === 'string' ? value.split(';')[0].trim() : '';
  if (/^DIRECT$/i.test(first)) return false;
  if (/^(?:PROXY|HTTPS?|SOCKS(?:4|5)?|QUIC)\s+\S+$/i.test(first)) return true;
  throw routingError('无法读取当前系统代理设置，请稍后重试。');
}

// Electron's fetch Response.url is not reliable. Expose the validated target we
// actually requested while retaining the native response's streaming body.
function responseAt(response, url, route, signal) {
  const reader = response.body?.getReader();
  const body = reader ? new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close(); else controller.enqueue(value);
      } catch { controller.error(connectionError(route, signal)); }
    },
    cancel(reason) { return reader.cancel(reason); },
  }) : null;
  const result = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

async function cancel(response) {
  try { await response.body?.cancel(); } catch { /* Preserve the validation error. */ }
}

function connectionError(route, signal) {
  if (signal?.aborted) { const error = new Error('更新请求已取消。'); error.name = 'AbortError'; return error; }
  return new Error(route === 'builtin' ? '内置更新代理连接失败，可关闭内置代理或稍后重试。' : '更新服务连接失败，请检查网络或系统代理后重试。');
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    // Callers may already have started an async proxy/session lookup. Consume
    // its later rejection even though this request has already been cancelled.
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(connectionError(null, signal));
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(connectionError(null, signal));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function recoveryDelay(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(connectionError('builtin', signal)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 400);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function createUpdateProxy(options) {
  let enabled = true;
  let busy = false;
  let route = 'builtin';
  let error = null;
  let sessionsPromise;
  const publish = options.onState || (() => {});
  function snapshot() { return { enabled, supported: true, route, busy, error }; }
  function change(next) {
    if ('enabled' in next) enabled = next.enabled;
    if ('route' in next) route = next.route;
    if ('error' in next) error = next.error;
    const state = snapshot(); publish(state); return state;
  }

  function sessions() {
    if (!sessionsPromise) {
      sessionsPromise = (async () => {
        await options.whenReady();
        const system = options.fromPartition(SYSTEM_PARTITION, { cache: false });
        const direct = options.fromPartition(DIRECT_PARTITION, { cache: false });
        await Promise.all([system.setProxy({ mode: 'system' }), direct.setProxy({ mode: 'direct' })]);
        return { system, direct, native: options.defaultSession() };
      })().catch(failure => { sessionsPromise = null; throw failure; });
    }
    return sessionsPromise;
  }

  async function select(url, signal) {
    const available = await abortable(sessions(), signal);
    const [nativeProxy, systemProxy] = await abortable(Promise.all([available.native.resolveProxy(url), available.system.resolveProxy(url)]), signal);
    if (usesProxy(nativeProxy)) return { route: 'system', fetch: options.netFetch };
    if (usesProxy(systemProxy)) return { route: 'system', fetch: (target, init) => available.system.fetch(target, init) };
    return enabled ? { route: 'builtin', fetch: (target, init) => available.direct.fetch(target, init) }
      : { route: 'direct', fetch: options.netFetch };
  }

  async function state() {
    if (busy) return snapshot();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try { const selected = await select(API_URL, controller.signal); return change({ route: selected.route, error: null }); }
    catch { return change({ error: '无法读取当前系统代理设置，请稍后重试。' }); }
    finally { clearTimeout(timer); }
  }

  async function setEnabled(value) {
    if (typeof value !== 'boolean') throw new TypeError('内置代理开关必须为开启或关闭。');
    if (busy) throw new Error('正在检查或下载更新，请完成后再切换内置代理。');
    change({ enabled: value, route: value ? 'builtin' : 'direct', error: null });
    return state();
  }

  function setBusy(value) { busy = value === true; publish(snapshot()); }

  async function builtinRequest(selected, target, init, recoverUnavailable = false) {
    const endpoint = new URL('/api/update', SERVICE_ORIGIN);
    endpoint.searchParams.set('url', target);
    for (let attempt = 0; ; attempt++) {
      if (init.signal?.aborted) throw connectionError('builtin', init.signal);
      const response = await selected.fetch(endpoint.href, { ...init, redirect: 'manual', credentials: 'omit' });
      if (REDIRECTS.has(response.status) || response.redirected || (response.url && response.url !== endpoint.href)) {
        await cancel(response);
        throw routingError('内置更新代理返回异常重定向，已停止。');
      }
      // A platform-level 503 can terminate an invocation before the Worker's
      // own bounded upstream retries run. Recover once, only for installers.
      if (response.status === 503 && recoverUnavailable && attempt === 0) {
        await cancel(response);
        await recoveryDelay(init.signal);
        continue;
      }
      if (response.status >= 500) {
        await cancel(response);
        throw connectionError('builtin', init.signal);
      }
      return response;
    }
  }

  async function installerResponse(selected, target, init, expectedSize) {
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > MAX_INSTALLER_BYTES) {
      throw routingError('安装包大小无效，已停止分段下载。');
    }
    // A fresh service invocation per segment bounds Worker CPU use. Keep the
    // original route and expose bytes only after the whole segment is verified.
    const abort = new AbortController();
    let reader; let offset = 0; let etag; let closed = false;
    const stop = () => { abort.abort(); return reader?.cancel().catch(() => {}); };
    init.signal?.addEventListener('abort', stop, { once: true });
    if (init.signal?.aborted) stop();
    const finish = () => { closed = true; init.signal?.removeEventListener('abort', stop); };
    const active = () => { if (abort.signal.aborted || closed) throw connectionError('builtin', { aborted: true }); };
    async function next() {
      active();
      const end = Math.min(expectedSize - 1, offset + CHUNK_BYTES - 1);
      const headers = new Headers(init.headers);
      headers.set('Range', `bytes=${offset}-${end}`);
      headers.delete('If-Range');
      if (etag) headers.set('If-Range', etag);
      const response = await builtinRequest(selected, target, { ...init, headers, signal: abort.signal }, true);
      if (abort.signal.aborted) await cancel(response);
      active();
      if (offset === 0 && !response.ok) return response;
      const range = /^bytes (0|[1-9]\d*)-(0|[1-9]\d*)\/(0|[1-9]\d*)$/.exec(response.headers.get('content-range') || '');
      const currentETag = response.headers.get('etag');
      if (response.status !== 206 || !range || Number(range[1]) !== offset || Number(range[2]) !== end
          || Number(range[3]) !== expectedSize || response.headers.get('content-length') !== String(end - offset + 1)
          || !/^"[\x21\x23-\x7e]{1,256}"$/.test(currentETag || '') || (etag && currentETag !== etag)
          || (response.headers.has('content-encoding') && response.headers.get('content-encoding').toLowerCase() !== 'identity') || !response.body) {
        await cancel(response);
        throw routingError('安装包分段信息不一致，已停止下载。');
      }
      etag = currentETag;
      reader = response.body.getReader();
      return response;
    }
    let first;
    try { first = await next(); } catch (failure) { stop(); finish(); throw failure; }
    if (!first.ok) { finish(); return responseAt(first, target, 'builtin', init.signal); }
    const headers = new Headers(first.headers);
    headers.delete('content-range'); headers.delete('accept-ranges');
    headers.set('content-length', String(expectedSize));
    const body = new ReadableStream({
      async pull(controller) {
        try {
          active();
          if (!reader) await next();
          const expected = Math.min(CHUNK_BYTES, expectedSize - offset);
          const chunks = []; let length = 0;
          while (true) {
            const item = await reader.read(); active();
            if (item.done) break;
            length += item.value.length;
            if (length > expected) throw routingError('安装包分段长度异常，已停止下载。');
            chunks.push(item.value);
          }
          reader.releaseLock(); reader = undefined;
          if (length !== expected) throw routingError('安装包分段未完成，请重新下载。');
          const bytes = new Uint8Array(length); let written = 0;
          for (const chunk of chunks) { bytes.set(chunk, written); written += chunk.length; }
          offset += length; controller.enqueue(bytes);
          if (offset === expectedSize) { finish(); controller.close(); }
        } catch (failure) {
          const safe = failure?.code === 'BRCLIO_UPDATE_ROUTE' ? failure : connectionError('builtin', abort.signal);
          await stop(); finish();
          change({ error: safe.message }); controller.error(safe);
        }
      },
      cancel() { const stopped = stop(); finish(); return stopped; },
    }, { highWaterMark: 0 });
    const response = new Response(body, { status: 200, headers });
    Object.defineProperty(response, 'url', { value: target });
    return response;
  }

  async function fetch(url, init = {}, context = {}) {
    let selected;
    try {
      let target = officialURL(url, true);
      selected = await select(target, init.signal);
      change({ route: selected.route, error: null });
      if (selected.route === 'builtin') {
        if (/\.(?:dmg|exe)$/.test(new URL(target).pathname)) return await installerResponse(selected, target, init, context.expectedSize);
        const response = await builtinRequest(selected, target, init);
        return responseAt(response, target, selected.route, init.signal);
      }
      for (let redirects = 0; ; redirects++) {
        // PAC decisions are made for the actual URL, including every CDN hop.
        if (redirects) selected = await select(target, init.signal);
        if (selected.route === 'builtin') {
          // A system PAC may send the release through its proxy and a CDN
          // directly. Continue that chain natively without adding a second
          // proxy mid-request; the next independent request resolves anew.
          selected = { route: 'direct', fetch: options.netFetch };
        }
        change({ route: selected.route, error: null });
        const response = await selected.fetch(target, { ...init, redirect: 'manual', credentials: 'omit' });
        if (response.redirected) {
          await cancel(response);
          throw routingError('下载重定向至非官方地址，已停止。');
        }
        if (!REDIRECTS.has(response.status)) return responseAt(response, target, selected.route, init.signal);
        const location = response.headers.get('location');
        await cancel(response);
        if (!location || redirects >= 5) throw routingError('更新重定向次数过多或地址无效，已停止。');
        target = officialURL(new URL(location, target).href);
      }
    } catch (failure) {
      const safe = failure?.code === 'BRCLIO_UPDATE_ROUTE' ? failure : connectionError(selected?.route, init.signal);
      change({ error: safe.message });
      throw safe;
    }
  }

  return { fetch, state, setEnabled, setBusy };
}

module.exports = { createUpdateProxy, officialURL, usesProxy, SERVICE_ORIGIN, SYSTEM_PARTITION, DIRECT_PARTITION, CHUNK_BYTES };

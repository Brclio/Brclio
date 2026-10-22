'use strict';

const { API_URL, requestBlockMessage } = require('./updater.cjs');
const { createConnectBridge, parseProxyConfiguration } = require('./update-connect-bridge.cjs');

const SERVICE_ORIGIN = 'https://tools.brclio.com';
const PROBE_URL = 'https://github.com/robots.txt';
const CONFIG_URL = `${SERVICE_ORIGIN}/api/client/update-proxy`;
const CONFIG_FALLBACK_URL = 'https://brclio-client-services.aiyuechuang.workers.dev/api/client/update-proxy';
const BUILTIN_PARTITION = 'brclio-update-builtin';
const SYSTEM_PARTITION = 'brclio-update-system';
const DIRECT_PARTITION = 'brclio-update-direct';
const OFFICIAL_HOSTS = new Set(['github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
function routingError(message) { const error = new Error(message); error.code = 'BRCLIO_UPDATE_ROUTE'; return error; }
function securityError() { return Object.assign(new Error('更新连接证书验证失败，已停止。'), { code: 'BRCLIO_UPDATE_SECURITY' }); }

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

// Keep only the validated official URL while retaining native TLS/body handling.
function responseAt(response, url, route, signal, finish = async () => {}) {
  const reader = response.body?.getReader();
  let finished = false;
  const done = async () => { if (!finished) { finished = true; await finish(); } };
  const body = reader ? new ReadableStream({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) { await done(); controller.close(); } else controller.enqueue(item.value);
      } catch (failure) { await done(); controller.error(transportError(failure, route, signal)); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { await done(); } },
  }, { highWaterMark: 0 }) : null;
  if (!body) void done();
  const result = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

async function cancel(response) {
  // A remote cancellation must never turn an already known security rejection
  // into a timeout that the outer updater would retry.
  try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch { /* Preserve the validation error. */ }
}

async function closeSession(value) {
  try { await value?.closeAllConnections?.(); } catch { /* Cleanup never exposes native transport errors. */ }
}

function connectionError(route, signal) {
  if (signal?.aborted) { const error = new Error('更新请求已取消。'); error.name = 'AbortError'; return error; }
  return Object.assign(new Error(route === 'builtin' ? '内置更新代理连接失败，可关闭内置代理或稍后重试。' : '更新服务连接失败，请检查网络或系统代理后重试。'), { code: 'BRCLIO_UPDATE_NETWORK' });
}

function transportError(failure, route, signal) {
  if (signal?.aborted || failure?.name === 'AbortError') return connectionError(route, { aborted: true });
  if (['BRCLIO_UPDATE_ROUTE', 'BRCLIO_UPDATE_SECURITY', 'BRCLIO_UPDATE_NETWORK'].includes(failure?.code)) return failure;
  const codes = [failure?.code, ...(String(failure?.message || '').match(/\b(?:ERR_[A-Z0-9_]+|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)\b/g) || [])];
  if (codes.some(value => /^(?:ERR_CERT_|ERR_SSL_|ERR_TLS_CERT_|CERT_HAS_EXPIRED$|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_VERIFY_LEAF_SIGNATURE$|UNABLE_TO_GET_ISSUER_CERT_LOCALLY$)/.test(value || ''))) return securityError();
  return connectionError(route, signal);
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

async function configurationBody(response) {
  const reader = response.body?.getReader();
  if (!reader) throw routingError('内置更新代理配置无效，请稍后重试。');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.length;
      if (size > 32768) throw routingError('内置更新代理配置无效，请稍后重试。');
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw routingError('内置更新代理配置无效，请稍后重试。'); }
  } finally { void reader.cancel().catch(() => {}); }
}

function createUpdateProxy(options) {
  let enabled = true, busy = false, route = 'builtin', error = null;
  let sessionsPromise, operation;
  const scopes = new Set();
  const publish = options.onState || (() => {});
  const now = options.now || (() => performance.now());
  const bridgeFactory = options.createBridge || createConnectBridge;
  const sessionFetch = options.fetchSession || ((value, url, init) => value.fetch(url, init));
  function snapshot() { return { enabled, supported: true, route, busy, error }; }
  function change(next) {
    if ('enabled' in next) enabled = next.enabled;
    if ('route' in next) route = next.route;
    if ('error' in next) error = next.error;
    const state = snapshot(); publish(state); return state;
  }
  function sessions() {
    if (!sessionsPromise) sessionsPromise = (async () => {
      await options.whenReady();
      const system = options.fromPartition(SYSTEM_PARTITION, { cache: false });
      const direct = options.fromPartition(DIRECT_PARTITION, { cache: false });
      await Promise.all([system.setProxy({ mode: 'system' }), direct.setProxy({ mode: 'direct' })]);
      return { system, direct, native: options.defaultSession() };
    })().catch(failure => { sessionsPromise = null; throw failure; });
    return sessionsPromise;
  }
  async function select(targets, signal) {
    const available = await abortable(sessions(), signal);
    const resolutions = await abortable(Promise.all(targets.map(async url => ({
      native: usesProxy(await available.native.resolveProxy(url)), system: usesProxy(await available.system.resolveProxy(url)),
    }))), signal);
    if (resolutions.some(value => value.native)) return { route: 'system', available, fetch: options.netFetch };
    if (resolutions.some(value => value.system)) return { route: 'system', available, fetch: (url, init) => sessionFetch(available.system, url, init) };
    return enabled ? { route: 'builtin', available } : { route: 'direct', fetch: options.netFetch };
  }
  async function state() {
    if (busy) return snapshot();
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5000);
    try { return change({ route: (await select([API_URL], controller.signal)).route, error: null }); }
    catch { return change({ error: '无法读取当前系统代理设置，请稍后重试。' }); }
    finally { clearTimeout(timer); }
  }
  async function setEnabled(value) {
    if (typeof value !== 'boolean') throw new TypeError('内置代理开关必须为开启或关闭。');
    if (busy) throw new Error('正在检查或下载更新，请完成后再切换内置代理。');
    change({ enabled: value, route: value ? 'builtin' : 'direct', error: null });
    return state();
  }
  function dispose(scope) {
    if (!scope) return Promise.resolve();
    if (scope.disposing) return scope.disposing;
    scope.closed = true;
    scope.probeStop?.();
    scope.disposing = (async () => {
      await scope.initializing?.catch(() => {});
      await Promise.all([
        closeSession(scope.builtin),
        Promise.resolve(scope.bridge?.close()).catch(() => {}),
      ]);
      scopes.delete(scope);
    })();
    return scope.disposing;
  }
  function setBusy(value, targets = []) {
    const previous = operation;
    if (value === true) {
      // Create synchronously for existing callers; the updater awaits disposal
      // before starting the next attempt while controls remain locked.
      operation = { targets: targets.map(url => officialURL(url, true)), configEndpoint: previous?.nextConfigEndpoint || CONFIG_URL }; busy = true;
    } else { operation = null; busy = false; }
    publish(snapshot());
    return dispose(previous);
  }
  async function initializeBuiltin(scope, selected, init) {
    if (!scope.initializing) scope.initializing = (async () => {
      let response;
      const endpoint = scope.configEndpoint || CONFIG_URL;
      const nextEndpoint = () => { scope.nextConfigEndpoint = endpoint === CONFIG_URL ? CONFIG_FALLBACK_URL : CONFIG_URL; };
      try {
        response = await sessionFetch(selected.available.direct, endpoint, { signal: init.signal, redirect: 'manual', credentials: 'omit', cache: 'no-store', headers: {
          Accept: 'application/json', 'Cache-Control': 'no-store, no-cache', 'User-Agent': new Headers(init.headers).get('user-agent') || 'Brclio-Updater/1.0',
        } });
      } catch (failure) {
        const safe = transportError(failure, 'builtin', init.signal);
        if (safe.code === 'BRCLIO_UPDATE_NETWORK') nextEndpoint();
        throw safe;
      }
      if (response.redirected || REDIRECTS.has(response.status) || (response.url && response.url !== endpoint)) {
        await cancel(response); throw routingError('内置更新代理配置返回异常重定向，已停止。');
      }
      if (endpoint === CONFIG_URL && response.status === 403 && response.headers.get('cf-mitigated')?.trim().toLowerCase() === 'challenge') {
        nextEndpoint(); await cancel(response); throw connectionError('builtin', init.signal);
      }
      const blocked = requestBlockMessage(response, true);
      if (blocked) { await cancel(response); throw routingError(blocked); }
      if (response.status !== 200) {
        let unsupported = false;
        if (response.status === 502) { try { unsupported = (await configurationBody(response)).code === 'proxy_configuration_unsupported'; } catch { /* The status still identifies a failed bootstrap. */ } }
        await cancel(response);
        if (unsupported) throw routingError('内置更新代理配置无效，请联系管理员调整订阅。');
        if (response.status >= 400 && response.status < 500 && ![408, 425].includes(response.status)) throw routingError('内置更新代理配置请求被拒绝，请稍后重试。');
        throw connectionError('builtin', init.signal);
      }
      let configuration;
      let document;
      try { document = await configurationBody(response); }
      catch (failure) {
        const safe = transportError(failure, 'builtin', init.signal);
        if (safe.code === 'BRCLIO_UPDATE_NETWORK') nextEndpoint();
        throw safe;
      }
      try { configuration = parseProxyConfiguration(document); }
      catch { throw routingError('内置更新代理配置无效，请稍后重试。'); }
      const controller = new AbortController();
      const stop = () => controller.abort();
      scope.probeStop = stop;
      init.signal?.addEventListener('abort', stop, { once: true });
      if (init.signal?.aborted || scope.closed) stop();
      const totalTimer = setTimeout(stop, 8000);
      const successful = [], failures = []; let next = 0;
      async function probe(node, index) {
        let bridge, builtin, retained = false, failureCode = 'BRCLIO_UPDATE_NETWORK';
        const candidate = new AbortController();
        const abort = () => candidate.abort();
        controller.signal.addEventListener('abort', abort, { once: true });
        if (controller.signal.aborted) abort();
        const timer = setTimeout(abort, 4000);
        try {
          if (candidate.signal.aborted) return;
          bridge = await bridgeFactory({ nodes: [node] });
          builtin = options.fromPartition(`${BUILTIN_PARTITION}-${index + 1}`, { cache: false });
          await closeSession(builtin);
          await builtin.setProxy({ mode: 'fixed_servers', proxyRules: bridge.proxyRules, proxyBypassRules: '<-loopback>' });
          const close = () => { void bridge.close(); void closeSession(builtin); };
          candidate.signal.addEventListener('abort', close, { once: true });
          if (candidate.signal.aborted) { close(); return; }
          const started = now();
          try {
            const checked = await sessionFetch(builtin, PROBE_URL, { method: 'HEAD', signal: candidate.signal, redirect: 'manual', credentials: 'omit', cache: 'no-store',
              headers: { Accept: 'application/vnd.github+json', 'User-Agent': new Headers(init.headers).get('user-agent') || 'Brclio-Updater/1.0' } });
            const elapsed = now() - started;
            const valid = checked.status === 200 && !checked.redirected && (!checked.url || checked.url === PROBE_URL) && !requestBlockMessage(checked);
            if (checked.redirected || REDIRECTS.has(checked.status) || checked.url && checked.url !== PROBE_URL || [403, 429].includes(checked.status)) failureCode = 'BRCLIO_UPDATE_ROUTE';
            await cancel(checked);
            if (valid && !candidate.signal.aborted && !scope.closed) { successful.push({ bridge, builtin, elapsed }); retained = true; }
          } finally { candidate.signal.removeEventListener('abort', close); }
        } catch (failure) {
          const safe = transportError(failure, 'builtin', candidate.signal);
          failureCode = bridge?.failureCode || safe.code || failureCode;
        }
        finally {
          clearTimeout(timer); controller.signal.removeEventListener('abort', abort);
          if (!retained) { failures.push(failureCode); await closeSession(builtin); await bridge?.close().catch(() => {}); }
        }
      }
      async function worker() {
        while (!controller.signal.aborted && next < configuration.nodes.length) { const index = next++; await probe(configuration.nodes[index], index); }
      }
      try {
        await Promise.all(Array.from({ length: Math.min(16, configuration.nodes.length) }, () => worker()));
        successful.sort((left, right) => left.elapsed - right.elapsed);
        const chosen = successful.shift();
        await Promise.all(successful.map(async value => { await closeSession(value.builtin); await value.bridge.close(); }));
        if (!chosen) {
          if (failures.length && failures.every(code => code === 'BRCLIO_UPDATE_SECURITY')) throw securityError();
          if (failures.length && failures.every(code => ['BRCLIO_UPDATE_ROUTE', 'BRCLIO_UPDATE_SECURITY'].includes(code))) throw routingError('更新节点验证失败，已停止。');
          throw connectionError('builtin', init.signal);
        }
        if (scope.closed || init.signal?.aborted) { await chosen.bridge.close(); await closeSession(chosen.builtin); throw connectionError('builtin', { aborted: true }); }
        scope.bridge = chosen.bridge; scope.builtin = chosen.builtin;
      } finally { clearTimeout(totalTimer); init.signal?.removeEventListener('abort', stop); }
    })();
    await abortable(scope.initializing, init.signal);
    return (url, options) => sessionFetch(scope.builtin, url, options);
  }
  async function fetch(url, init = {}) {
    const scope = operation || { targets: [url] };
    const standalone = !operation;
    scopes.add(scope);
    let selected;
    try {
      let target = officialURL(url, true);
      if (!scope.selection) scope.selection = select(scope.targets.length ? scope.targets : [target], init.signal);
      selected = await abortable(scope.selection, init.signal);
      change({ route: selected.route, error: null });
      const request = selected.route === 'builtin' ? await initializeBuiltin(scope, selected, init) : selected.fetch;
      for (let redirects = 0; ; redirects++) {
        if (scope.closed || init.signal?.aborted) throw connectionError(selected.route, { aborted: true });
        const requestOptions = { ...init, redirect: 'manual', credentials: 'omit' };
        const response = await request(target, requestOptions);
        if (response.redirected) { await cancel(response); throw routingError('下载重定向至非官方地址，已停止。'); }
        const blocked = requestBlockMessage(response);
        if (blocked) { await cancel(response); throw routingError(blocked); }
        if (!REDIRECTS.has(response.status)) return responseAt(response, target, selected.route, init.signal, standalone ? () => dispose(scope) : undefined);
        const location = response.headers.get('location'); await cancel(response);
        if (!location || redirects >= 5) throw routingError('更新重定向次数过多或地址无效，已停止。');
        target = officialURL(new URL(location, target).href);
      }
    } catch (failure) {
      if (standalone) await dispose(scope);
      const bridgeCode = !init.signal?.aborted && failure?.name !== 'AbortError' ? scope.bridge?.failureCode : undefined;
      const safe = bridgeCode === 'BRCLIO_UPDATE_SECURITY' ? securityError()
        : bridgeCode === 'BRCLIO_UPDATE_ROUTE' ? routingError('内置更新代理连接被拒绝或返回无效跳转，已停止。')
          : transportError(failure, selected?.route, init.signal);
      change({ error: safe.message }); throw safe;
    }
  }
  async function close() { operation = null; await Promise.all([...scopes].map(dispose)); }
  return { fetch, state, setEnabled, setBusy, close };
}

module.exports = { createUpdateProxy, officialURL, usesProxy, SERVICE_ORIGIN, PROBE_URL, CONFIG_URL, CONFIG_FALLBACK_URL, SYSTEM_PARTITION, DIRECT_PARTITION, BUILTIN_PARTITION };

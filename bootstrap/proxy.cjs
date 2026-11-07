'use strict';

const { API_URL, requestBlockMessage } = require('../desktop/updater.cjs');
const { createConnectBridge, parseProxyConfiguration } = require('../desktop/update-connect-bridge.cjs');
const { officialURL, usesProxy, CONFIG_URL, CONFIG_FALLBACK_URL, PROBE_URL, SERVICE_ORIGIN } = require('../desktop/update-proxy.cjs');
const DIRECT_PARTITION = 'downloader-subscription';
const BUILTIN_PARTITION = 'downloader-node';
const SYSTEM_PARTITION = 'downloader-system';
const SELF_POINTER = 'https://github.com/Brclio/Brclio/releases/download/downloader-stable/latest.json';
const RELEASE_METADATA = SERVICE_ORIGIN + '/api/update?url=' + encodeURIComponent(API_URL);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
function routingError(message) { const error = new Error(message); error.code = 'BRCLIO_UPDATE_ROUTE'; return error; }
function securityError() { return Object.assign(new Error('更新连接证书验证失败，已停止。'), { code: 'BRCLIO_UPDATE_SECURITY' }); }

function initialURL(value) {
  const normalized = officialURL(value);
  if (normalized === SELF_POINTER) return normalized;
  const url = new URL(normalized);
  if (!url.search && url.hostname === 'github.com' && /^\/Brclio\/Brclio\/releases\/download\/downloader-v(\d+\.\d+\.\d+)\/(?:SHA256SUMS\.txt|Brclio-Downloader-\1-(?:mac-(?:arm64|x64)\.dmg|windows-x64\.exe))$/.test(url.pathname)) return normalized;
  return officialURL(value, true);
}

// Keep only the validated official URL while retaining native TLS/body handling.
function responseAt(response, url, signal, route, finish = async () => {}) {
  const reader = response.body?.getReader();
  let finished = false;
  const done = async () => { if (!finished) { finished = true; await finish(); } };
  const body = reader ? new ReadableStream({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) { await done(); controller.close(); } else controller.enqueue(item.value);
      } catch (failure) { const safe = transportError(failure, signal, route); await done(); controller.error(safe); }
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

function connectionError(signal, route = 'builtin') {
  if (signal?.aborted) { const error = new Error('更新请求已取消。'); error.name = 'AbortError'; return error; }
  const message = route === 'system' ? '系统代理连接失败，请检查电脑的代理设置后重试。' : '内置更新代理连接失败，请稍后重试。';
  return Object.assign(new Error(message), { code: 'BRCLIO_UPDATE_NETWORK' });
}

function transportError(failure, signal, route) {
  if (signal?.aborted || failure?.name === 'AbortError') return connectionError({ aborted: true });
  if (['BRCLIO_UPDATE_ROUTE', 'BRCLIO_UPDATE_SECURITY', 'BRCLIO_UPDATE_NETWORK'].includes(failure?.code)) return failure;
  const codes = [failure?.code, ...(String(failure?.message || '').match(/\b(?:ERR_[A-Z0-9_]+|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)\b/g) || [])];
  if (codes.some(value => /^(?:ERR_CERT_|ERR_SSL_|ERR_TLS_CERT_|CERT_HAS_EXPIRED$|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_VERIFY_LEAF_SIGNATURE$|UNABLE_TO_GET_ISSUER_CERT_LOCALLY$)/.test(value || ''))) return securityError();
  return connectionError(signal, route);
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    // Callers may already have started an async proxy/session lookup. Consume
    // its later rejection even though this request has already been cancelled.
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(connectionError(signal));
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(connectionError(signal));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function boundedJSON(response, signal, limit = 32768, message = '内置更新代理配置无效，请稍后重试。') {
  const reader = response.body?.getReader();
  if (!reader) throw routingError(message);
  const chunks = []; let size = 0;
  try {
    while (true) {
      const item = await abortable(reader.read(), signal); if (item.done) break;
      size += item.value.length;
      if (size > limit) throw routingError(message);
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw routingError(message); }
  } finally { void reader.cancel().catch(() => {}); }
}

function createUpdateProxy(options) {
  let operation, directPromise, systemPromise;
  let route = null, phase = 'idle', latencyMs = null, error = null;
  const scopes = new Set();
  const publish = options.onState || (() => {});
  const now = options.now || (() => performance.now());
  const bridgeFactory = options.createBridge || createConnectBridge;
  const sessionFetch = options.fetchSession || ((value, url, init) => value.fetch(url, init));
  function state() { return { route, phase, latencyMs, busy: Boolean(operation), error }; }
  function emit() { publish(state()); }
  function directSession() {
    if (!directPromise) directPromise = (async () => {
      await options.whenReady();
      const session = options.fromPartition(DIRECT_PARTITION, { cache: false });
      await session.setProxy({ mode: 'direct' });
      return session;
    })().catch(failure => { directPromise = undefined; throw failure; });
    return directPromise;
  }
  async function systemRoute(targets, signal) {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
    try {
      if (!systemPromise) systemPromise = (async () => {
        await options.whenReady();
        const system = options.fromPartition(SYSTEM_PARTITION, { cache: false });
        await system.setProxy({mode:'system'});
        return {native:options.defaultSession(), system};
      })().catch(failure => { systemPromise = null; throw failure; });
      const {native, system} = await abortable(systemPromise, deadline);
      await abortable(Promise.all([native.forceReloadProxyConfig(), system.forceReloadProxyConfig()]), deadline);
      async function resolve(url) {
        const [nativeRule, systemRule] = await Promise.all([native.resolveProxy(url), system.resolveProxy(url)]);
        if (usesProxy(nativeRule)) return native;
        return usesProxy(systemRule) ? system : null;
      }
      const matches = new Map(await abortable(Promise.all(targets.map(async url => [url, await resolve(url)])), deadline));
      const preferred = [...matches.values()].find(Boolean);
      if (!preferred) return null;
      // A single PAC can bypass the checksum URL and proxy the installer or CDN.
      // Honor each host's actual rule with Chromium's session throughout this operation.
      return async (url, init) => {
        if (!matches.has(url)) matches.set(url, await abortable(resolve(url), init.signal));
        return sessionFetch(matches.get(url) || preferred, url, init);
      };
    } catch (failure) {
      if (signal.aborted) throw connectionError(signal);
      if (failure.code === 'BRCLIO_UPDATE_ROUTE') throw failure;
      throw routingError('无法读取当前系统代理设置，请稍后重试。');
    }
  }
  function dispose(scope) {
    if (!scope) return Promise.resolve();
    if (scope.disposing) return scope.disposing;
    scope.closed = true;
    scope.controller.abort();
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
      operation = { controller: new AbortController(), targets:targets.map(initialURL) };
      route = null; phase = 'detecting'; latencyMs = null; error = null;
    } else { operation = null; }
    emit();
    return dispose(previous);
  }
  async function configurationFrom(endpoint, init) {
    const signal = AbortSignal.any([init.signal, AbortSignal.timeout(8000)]);
    const transportFailure = failure => {
      const safe = signal.aborted ? connectionError(init.signal) : transportError(failure, init.signal);
      if (safe.code === 'BRCLIO_UPDATE_NETWORK') safe.allowConfigAlias = true;
      return safe;
    };
    let response;
    try {
      const session = await abortable(directSession(), signal);
      response = await abortable(sessionFetch(session, endpoint, { signal, redirect: 'manual', credentials: 'omit', cache: 'no-store', headers: {
        Accept: 'application/json', 'Cache-Control': 'no-store, no-cache', 'User-Agent': new Headers(init.headers).get('user-agent') || 'Brclio-Downloader',
      } }), signal);
    } catch (failure) { throw transportFailure(failure); }
    if (response.redirected || REDIRECTS.has(response.status) || (response.url && response.url !== endpoint)) {
      await cancel(response); throw routingError('内置更新代理配置返回异常重定向，已停止。');
    }
    if (endpoint === CONFIG_URL && response.status === 403 && response.headers.get('cf-mitigated')?.trim().toLowerCase() === 'challenge') {
      await cancel(response); throw Object.assign(connectionError(init.signal), { allowConfigAlias: true });
    }
    const blocked = requestBlockMessage(response, true);
    if (blocked) { await cancel(response); throw routingError(blocked.replace('可关闭内置代理或', '请')); }
    if (response.status !== 200) {
      let unsupported = false;
      if (response.status === 502) {
        try { unsupported = (await boundedJSON(response, signal)).code === 'proxy_configuration_unsupported'; }
        catch { /* A 502 still identifies a failed subscription refresh. */ }
      }
      await cancel(response);
      if (unsupported) throw routingError('内置更新代理配置无效，请联系管理员调整订阅。');
      if (response.status >= 400 && response.status < 500 && ![408, 425].includes(response.status)) throw routingError('内置更新代理配置请求被拒绝，请稍后重试。');
      throw connectionError(init.signal);
    }
    let document;
    try { document = await boundedJSON(response, signal); }
    catch (failure) { throw transportFailure(failure); }
    try { return parseProxyConfiguration(document); }
    catch { throw routingError('内置更新代理配置无效，请稍后重试。'); }
  }
  async function initializeBuiltin(scope, init) {
    if (!scope.initializing) scope.initializing = (async () => {
      phase = 'refreshing'; latencyMs = null; error = null; emit();
      let configuration;
      try { configuration = await configurationFrom(CONFIG_URL, init); }
      catch (failure) {
        if (init.signal.aborted || !failure.allowConfigAlias) throw failure;
        configuration = await configurationFrom(CONFIG_FALLBACK_URL, init);
      }
      phase = 'probing'; emit();
      const controller = new AbortController();
      const stop = () => controller.abort();
      init.signal?.addEventListener('abort', stop, { once: true });
      if (init.signal?.aborted || scope.closed) stop();
      const totalTimer = setTimeout(stop, 8000);
      const successful = [], failures = [];
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
          const safe = transportError(failure, candidate.signal);
          failureCode = bridge?.failureCode || safe.code || failureCode;
        }
        finally {
          clearTimeout(timer); controller.signal.removeEventListener('abort', abort);
          if (!retained) { failures.push(failureCode); await closeSession(builtin); await bridge?.close().catch(() => {}); }
        }
      }
      try {
        await Promise.all(configuration.nodes.map(probe));
        successful.sort((left, right) => left.elapsed - right.elapsed);
        const chosen = successful.shift();
        await Promise.all(successful.map(async value => { await closeSession(value.builtin); await value.bridge.close(); }));
        if (!chosen) {
          if (failures.length && failures.every(code => code === 'BRCLIO_UPDATE_SECURITY')) throw securityError();
          if (failures.length && failures.every(code => ['BRCLIO_UPDATE_ROUTE', 'BRCLIO_UPDATE_SECURITY'].includes(code))) throw routingError('更新节点验证失败，已停止。');
          throw connectionError(init.signal);
        }
        if (scope.closed || init.signal?.aborted) { await chosen.bridge.close(); await closeSession(chosen.builtin); throw connectionError({ aborted: true }); }
        scope.bridge = chosen.bridge; scope.builtin = chosen.builtin;
        phase = 'ready'; latencyMs = Math.round(chosen.elapsed); emit();
      } finally { clearTimeout(totalTimer); init.signal?.removeEventListener('abort', stop); }
    })();
    await abortable(scope.initializing, init.signal);
    return (url, options) => sessionFetch(scope.builtin, url, options);
  }
  async function releaseMetadata(signal, systemRequest) {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
    let metadata, response;
    try {
      const request = systemRequest || ((url, init) => directSession().then(session => sessionFetch(session, url, init)));
      response = await abortable(request(RELEASE_METADATA, {
        signal: deadline, redirect: 'manual', credentials: 'omit', cache: 'no-store',
        headers: { Accept: 'application/json', 'User-Agent': 'Brclio-Downloader' },
      }), deadline);
      if (response.redirected || (response.url && response.url !== RELEASE_METADATA) || REDIRECTS.has(response.status)) {
        throw routingError('发布服务元数据返回异常重定向。');
      }
      if (response.status !== 200 || requestBlockMessage(response)) throw connectionError(signal, systemRequest ? 'system' : 'builtin');
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw routingError('发布服务元数据格式无效。');
      metadata = await boundedJSON(response, deadline, 1024 * 1024, '发布服务元数据无效。');
    } catch (failure) {
      if (response) await cancel(response);
      if (deadline.aborted && !signal.aborted) throw connectionError(signal, systemRequest ? 'system' : 'builtin');
      throw failure;
    }
    if (metadata?.html_url !== 'https://github.com/Brclio/Brclio/releases/tag/' + metadata?.tag_name ||
        !/^v?\d+\.\d+\.\d+$/.test(metadata.tag_name) || metadata.draft !== false || metadata.prerelease !== false || !Array.isArray(metadata.assets) || metadata.assets.length > 128) {
      throw routingError('发布服务元数据与 Brclio 稳定版本不匹配。');
    }
    // The regular updater validates the asset URLs, size, checksums and release digest.
    return Response.json(metadata);
  }
  async function fetch(url, init = {}) {
    const scope = operation || { controller: new AbortController(), targets:[] };
    init = { ...init, signal: init.signal ? AbortSignal.any([init.signal, scope.controller.signal]) : scope.controller.signal };
    const standalone = !operation;
    scopes.add(scope);
    try {
      let target = initialURL(url);
      if (!scope.selection) {
        route = null; phase = 'detecting'; latencyMs = null; error = null; emit();
        scope.selection = systemRoute(scope.targets.length ? scope.targets : [target], init.signal);
      }
      const systemRequest = await abortable(scope.selection, init.signal);
      scope.route = systemRequest ? 'system' : 'builtin';
      route = scope.route;
      if (systemRequest) { phase = 'ready'; emit(); }
      const request = systemRequest || await initializeBuiltin(scope, init);
      for (let redirects = 0; ; redirects++) {
        if (scope.closed || init.signal?.aborted) throw connectionError({ aborted: true });
        const requestOptions = { ...init, redirect: 'manual', credentials: 'omit' };
        let response = await request(target, requestOptions);
        if (response.redirected || (response.url && response.url !== target)) { await cancel(response); throw routingError('下载重定向至非官方地址，已停止。'); }
        const blocked = requestBlockMessage(response);
        if (blocked) { await cancel(response); throw routingError(blocked); }
        if (target === API_URL && (response.status === 429 ||
            (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0'))) {
          await cancel(response);
          response = await releaseMetadata(init.signal, systemRequest);
        }
        if (!REDIRECTS.has(response.status)) return responseAt(response, target, init.signal, scope.route, standalone ? () => dispose(scope) : undefined);
        const location = response.headers.get('location'); await cancel(response);
        if (!location || redirects >= 5) throw routingError('更新重定向次数过多或地址无效，已停止。');
        target = officialURL(new URL(location, target).href);
      }
    } catch (failure) {
      const bridgeCode = !init.signal?.aborted && failure?.name !== 'AbortError' ? scope.bridge?.failureCode : undefined;
      const safe = bridgeCode === 'BRCLIO_UPDATE_SECURITY' ? securityError()
        : bridgeCode === 'BRCLIO_UPDATE_ROUTE' ? routingError('内置更新代理连接被拒绝或返回无效跳转，已停止。')
          : transportError(failure, init.signal, scope.route);
      if (standalone) await dispose(scope);
      error = safe.message; phase = 'error'; emit(); throw safe;
    }
  }
  async function close() { operation = null; await Promise.all([...scopes].map(dispose)); }
  return { fetch, state, setBusy, close };
}

module.exports = { createUpdateProxy, initialURL, SELF_POINTER };

import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {parseProxyConfiguration, bootstrapFallbackOrigin} from '../scripts/native-transport.mjs';
import {officialTarget, publicHTTPS, redirectTarget} from '../src/protocol.js';
import {smokeResponseDiagnostic} from '../scripts/smoke-segment.mjs';

// Execute the CLI's actual bootstrap and body helpers, with no external nodes.
const source = await readFile(new URL('../scripts/verify-live.mjs', import.meta.url), 'utf8');
const bootstrap = source.slice(source.indexOf('async function cancel(response)'), source.indexOf('async function operationBridge('));
const primary = 'https://tools.brclio.com';
const node = {uuid: '00112233-4455-6677-8899-aabbccddeeff', host: 'vpn.example.com', port: 443,
  path: '/fixture', servername: 'vpn.example.com', wsHost: 'vpn.example.com', dialAddress: '104.17.1.1'};
const configuration = {version: 1, ttlSeconds: 600, nodes: [node]};
function fixture(fetchImpl, {origin = primary, signal = new AbortController().signal, realTimers = false} = {}) {
  const calls = [], signals = [], delays = [], pending = new Set();
  const context = {
    assert, URL, TextDecoder, Uint8Array, AbortController, AbortSignal, parseProxyConfiguration, bootstrapFallbackOrigin,
    service: {origin}, requestHeaders: {'User-Agent': 'Brclio-Updater/1.0'}, signal,
    progress: {retryCount: 0, bootstrapAttempts: 0, configurationRefreshes: 0}, errorEnum: null,
    stage(name) { context.progress.stage = name; context.clearResponse(); },
    clearResponse() { context.errorEnum = null; },
    inspect(response) { if (response.status !== 200) context.errorEnum = 'http_status'; },
    networkFailure(error) { return ['AbortError', 'TimeoutError'].includes(error?.name) ? 'timeout_or_cancelled' : 'network_failed'; },
    fetch(url, options) {
      assert.equal(options.signal.aborted, false); assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit');
      assert.equal(options.cache, 'no-store'); calls.push(url.origin); signals.push(options.signal);
      return fetchImpl(url, options, calls.length);
    },
    setTimeout(callback, delay) {
      delays.push(delay);
      if (realTimers) return setTimeout(callback, delay);
      const timer = {callback, delay}; pending.add(timer);
      if (delay < 20000) queueMicrotask(() => { if (pending.delete(timer)) callback(); });
      return timer;
    },
    clearTimeout(timer) { if (realTimers) clearTimeout(timer); else pending.delete(timer); },
  };
  return {calls, signals, delays, context, pending,
    expireAttempt() {
      const timer = [...pending].find(value => value.delay === 20000);
      assert.ok(timer); pending.delete(timer); timer.callback();
    },
    run: () => vm.runInNewContext(`${bootstrap}\nconst scope = {endpointIndex: 0}; operationAttempts(current => configuration(current, scope), {signal, timeoutMs: 20000})`, context)};
}

test('bootstrap recovers from an actual HTTP502 on the same endpoint and releases its error body', async () => {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    response.writeHead(++requests === 1 ? 502 : 200, {'Content-Type': 'application/json'});
    response.end(JSON.stringify(requests === 1 ? {code: 'proxy_configuration_unavailable', error: 'private-fixture-body'} : configuration));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const f = fixture((url, options) => fetch(url, options), {origin});
  try {
    const nodes = await f.run();
    assert.equal(nodes.length, 1); assert.equal(nodes[0].uuid, node.uuid);
    assert.deepEqual(f.calls, [origin, origin]); assert.deepEqual(f.delays, [20000, 1000, 20000]);
    assert.notEqual(f.signals[0], f.signals[1]); assert.equal(f.signals[0].aborted, true);
    assert.equal(f.context.progress.retryCount, 1); assert.equal(f.context.progress.bootstrapAttempts, 2);
    assert.equal(f.context.progress.configurationRefreshes, 1); assert.equal(f.context.errorEnum, null);
    assert.ok(!JSON.stringify(f.context.progress).includes('private-fixture-body'));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

for (const status of [500, 502, 503, 504, 599]) test(`bootstrap retries ordinary HTTP${status} without switching origin`, async () => {
  const f = fixture((_url, _options, attempt) => attempt === 1 ? new Response('private-error-body', {status}) : Response.json(configuration));
  await f.run(); assert.deepEqual(f.calls, [primary, primary]); assert.equal(f.context.progress.retryCount, 1);
});

test('bootstrap stops after ten retries, preserves client backoff, and cancels every rejected response', async () => {
  let cancelled = 0;
  const f = fixture(() => new Response(new ReadableStream({cancel() { cancelled++; }}), {status: 503}));
  await assert.rejects(f.run(), /retry budget exhausted/);
  assert.equal(f.calls.length, 11); assert.ok(f.calls.every(origin => origin === primary));
  assert.equal(f.context.progress.retryCount, 10); assert.equal(f.context.progress.bootstrapAttempts, 11);
  assert.deepEqual(f.delays.filter(delay => delay < 20000), [1000, 2000, 4000, 5000, 5000, 5000, 5000, 5000, 5000, 5000]);
  assert.equal(f.delays.filter(delay => delay === 20000).length, 11); assert.equal(new Set(f.signals).size, 11);
  assert.equal(cancelled, 11); assert.equal(f.pending.size, 0);
});

test('a timed-out attempt receives a fresh20s budget and a late response cannot replace the new body', async () => {
  let finishLate, lateCancelled = false;
  const f = fixture((_url, _options, attempt) => {
    if (attempt > 1) return Response.json(configuration);
    queueMicrotask(() => f.expireAttempt());
    return new Promise(resolve => { finishLate = resolve; });
  });
  const nodes = await f.run();
  assert.equal(nodes[0].uuid, node.uuid); assert.equal(f.context.progress.configurationRefreshes, 1);
  assert.equal(f.context.progress.retryCount, 1); assert.deepEqual(f.delays, [20000, 1000, 20000]);
  assert.notEqual(f.signals[0], f.signals[1]); assert.equal(f.context.errorEnum, null);
  finishLate(new Response(new ReadableStream({cancel() { lateCancelled = true; }}), {status: 502}));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lateCancelled, true); assert.equal(f.context.progress.configurationRefreshes, 1);
});

for (const status of [401, 403, 404, 408, 425, 429]) test(`bootstrap HTTP${status} is a permanent failure`, async () => {
  let cancelled = 0;
  const f = fixture(() => new Response(new ReadableStream({cancel() { cancelled++; }}), {status}));
  await assert.rejects(f.run(), /Configuration HTTP status/);
  assert.equal(f.calls.length, 1); assert.equal(f.context.progress.retryCount, 0); assert.equal(cancelled, 1);
});

test('unsupported502 stops immediately and cannot expose the upstream body', async () => {
  const f = fixture(() => Response.json({code: 'proxy_configuration_unsupported', error: 'private-body-marker'}, {status: 502}));
  await assert.rejects(f.run(), /Configuration unsupported/);
  assert.equal(f.calls.length, 1); assert.equal(f.context.progress.retryCount, 0);
  assert.ok(!JSON.stringify(f.context.progress).includes('private-body-marker'));
});

for (const status of [200, 502, 503]) test(`a challenged HTTP${status} cannot be treated as a transient5xx`, async () => {
  const f = fixture(() => new Response(null, {status, headers: {'cf-mitigated': 'challenge'}}));
  await assert.rejects(f.run(), /challenge refused/);
  assert.equal(f.calls.length, 1); assert.equal(f.context.progress.retryCount, 0);
  assert.equal(f.context.progress.configurationRefreshes, 0);
});

for (const kind of ['http', 'followed', 'changed-url']) test(`bootstrap ${kind} redirect cannot retry or switch origin`, async () => {
  const response = new Response(null, {status: kind === 'http' ? 302 : 503, headers: {Location: 'https://private-fixture.example/'}});
  if (kind === 'followed') Object.defineProperty(response, 'redirected', {value: true});
  if (kind === 'changed-url') Object.defineProperty(response, 'url', {value: 'https://private-fixture.example/'});
  const f = fixture(() => response);
  await assert.rejects(f.run(), /redirect refused/);
  assert.equal(f.calls.length, 1); assert.equal(f.context.progress.retryCount, 0); assert.equal(f.context.errorEnum, 'invalid_redirect');
});

for (const cause of ['network', 'challenge']) test(`bootstrap keeps the fixed fallback for ${cause} only`, async () => {
  const f = fixture((_url, _options, attempt) => {
    if (attempt > 1) return Response.json(configuration);
    if (cause === 'network') throw new Error('private-transport-message');
    return new Response(null, {status: 403, headers: {'cf-mitigated': ' Challenge '}});
  });
  await f.run(); assert.deepEqual(f.calls, [primary, bootstrapFallbackOrigin]); assert.equal(f.context.progress.retryCount, 0);
  assert.equal(f.context.progress.bootstrapEndpoint, 'fallback');
});

for (const code of ['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_REVOKED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_CERT_AUTHORITY_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']) {
  for (const alias of [false, true]) test(`bootstrap permanently refuses${alias ? ' fallback' : ' primary'} TLS cause ${code}`, async () => {
    const f = fixture((_url, _options, attempt) => {
      if (alias && attempt === 1) throw new TypeError('ordinary network failure');
      throw new TypeError('fetch failed with private detail', {cause: new Error('private-certificate-detail', {cause: Object.assign(new Error('private-cause'), {code})})});
    });
    await assert.rejects(f.run(), /TLS verification failed/);
    assert.equal(f.calls.length, alias ? 2 : 1); assert.equal(f.context.progress.retryCount, 0);
    assert.equal(f.context.errorEnum, 'tls_failed');
    assert.deepEqual(f.calls, alias ? [primary, bootstrapFallbackOrigin] : [primary]);
  });
}

test('an aggregate containing a certificate failure is also a permanent bootstrap failure', async () => {
  const f = fixture(() => { throw new AggregateError([new Error('ordinary error'), Object.assign(new Error('private-certificate-detail'), {code: 'CERT_SIGNATURE_FAILURE'})]); });
  await assert.rejects(f.run(), /TLS verification failed/);
  assert.equal(f.calls.length, 1); assert.equal(f.context.progress.retryCount, 0); assert.equal(f.context.errorEnum, 'tls_failed');
});

for (const kind of ['401', '403', 'schema', 'unsupported', 'success']) test(`stalled cleanup cannot turn ${kind} into a successful retry`, async () => {
  const f = fixture(() => kind === 'unsupported' ? Response.json({code: 'proxy_configuration_unsupported'}, {status: 502}) :
    kind === 'schema' ? Response.json({version: 999}) : kind === 'success' ? Response.json(configuration) : new Response(null, {status: Number(kind)}));
  f.context.cleanupStall = () => { queueMicrotask(() => f.expireAttempt()); return new Promise(() => {}); };
  const operation = vm.runInNewContext(`${bootstrap}\nconst scope = {endpointIndex: 0};
    operationAttempts(async (current, beforeCleanup) => {
      let failure;
      try { return await configuration(current, scope); }
      catch (error) { failure = error; throw error; }
      finally { beforeCleanup(failure); await cleanupStall(); }
    }, {signal, timeoutMs: 20000})`, f.context);
  await assert.rejects(operation);
  assert.equal(f.calls.length, 1); assert.equal(f.context.progress.retryCount, 0); assert.equal(f.pending.size, 0);
  assert.equal(f.context.errorEnum, kind === 'success' ? 'cleanup_failed' : kind === 'schema' ? null : 'http_status');
});

test('cleanup is bounded even when a download operation has no total deadline', async () => {
  const f = fixture(() => Response.json(configuration)); let calls = 0;
  f.context.cleanupStall = () => { calls++; queueMicrotask(() => f.expireAttempt()); return new Promise(() => {}); };
  const operation = vm.runInNewContext(`${bootstrap}\noperationAttempts(async (_current, beforeCleanup) => {
    beforeCleanup(); await cleanupStall();
  }, {signal})`, f.context);
  await assert.rejects(operation, /cleanup did not complete/);
  assert.equal(calls, 1); assert.equal(f.context.progress.retryCount, 0); assert.equal(f.context.errorEnum, 'cleanup_failed');
  assert.deepEqual(f.delays, [20000]); assert.equal(f.pending.size, 0);
});

test('switching to the fixed fallback does not reset the operation retry budget', async () => {
  const f = fixture((_url, _options, attempt) => {
    if (attempt === 2) throw new Error('private-transport-message');
    return new Response(null, {status: 503});
  });
  await assert.rejects(f.run(), /retry budget exhausted/);
  assert.equal(f.context.progress.retryCount, 10); assert.equal(f.calls.length, 12);
  assert.deepEqual(f.calls.slice(0, 2), [primary, primary]);
  assert.ok(f.calls.slice(2).every(origin => origin === bootstrapFallbackOrigin));
});

for (const stage of ['before-fetch', 'fetch', 'body', 'backoff']) test(`bootstrap abort stops ${stage} without waiting for a stalled cancellation`, async () => {
  const controller = new AbortController(); let cancelled = false;
  const reason = Object.assign(new Error('fixture deadline'), {name: 'TimeoutError'});
  const f = fixture(() => {
    if (stage === 'fetch') return new Promise(() => {});
    if (stage === 'body') return new Response(new ReadableStream({cancel() { cancelled = true; return new Promise(() => {}); }}), {status: 502});
    return new Response(null, {status: 503});
  }, {signal: controller.signal, realTimers: true});
  if (stage === 'before-fetch') controller.abort(reason);
  const timer = setTimeout(() => controller.abort(reason), 15);
  try {
    await assert.rejects(f.run(), {name: 'TimeoutError'});
    assert.equal(f.calls.length, stage === 'before-fetch' ? 0 : 1);
    assert.equal(f.context.progress.retryCount, 0); assert.equal(f.context.errorEnum, 'timeout_or_cancelled');
    if (stage === 'body') assert.equal(cancelled, true);
  } finally { clearTimeout(timer); }
});

test('an oversized502 body is cancelled at the size bound before a same-endpoint recovery', async () => {
  let cancelled = false;
  const f = fixture((_url, _options, attempt) => attempt === 1 ? new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(32769)); }, cancel() { cancelled = true; }
  }), {status: 502}) : Response.json(configuration));
  await f.run(); assert.equal(cancelled, true); assert.equal(f.context.progress.retryCount, 1);
  assert.deepEqual(f.calls, [primary, primary]);
});

for (const failures of [[1], [1, 3]]) test(`the complete CLI accumulates${failures.length} recoveries while checking metadata, manifest and installer SHA`, async () => {
  const bytes = new Uint8Array([1, 2, 3]), digest = createHash('sha256').update(bytes).digest('hex');
  const base = 'https://github.com/Brclio/Brclio/releases/download/v0.1.8/';
  const asset = {name: 'Brclio-0.1.8-android.apk', size: bytes.length, digest: 'sha256:' + digest,
    browser_download_url: base + 'Brclio-0.1.8-android.apk'};
  const manifest = new TextEncoder().encode(`${digest}  ${asset.name}\n`);
  const release = {tag_name: 'v0.1.8', draft: false, prerelease: false, assets: [asset,
    {name: 'SHA256SUMS.txt', size: manifest.length, digest: 'sha256:' + createHash('sha256').update(manifest).digest('hex'),
      browser_download_url: base + 'SHA256SUMS.txt'}]};
  let attempts = 0, report, closed = 0;
  const processFixture = {argv: ['node', 'verify-live.mjs'], env: {}};
  await vm.runInNewContext(`(async () => {${source.replace(/^import .*;\n/gm, '')}\n})()`, {
    assert, createHash, officialTarget, publicHTTPS, redirectTarget, smokeResponseDiagnostic, parseProxyConfiguration, bootstrapFallbackOrigin,
    fetch: async () => failures.includes(++attempts) ? Response.json({code: 'proxy_configuration_unavailable'}, {status: 502}) : Response.json(configuration),
    selectNativeNodes: async nodes => ({nodes, reachable: 1, latencyMs: 1}),
    createSelectedBridge: async () => ({close: async () => { closed++; }}),
    nativeHTTPSRequest: async url => url.includes('api.github.com') ? Response.json(release) :
      url.endsWith('SHA256SUMS.txt') ? new Response(manifest) : new Response(bytes, {headers: {'Content-Length': '3'}}),
    process: processFixture, URL, Headers, AbortSignal, AbortController, Uint8Array, TextDecoder, Date,
    setTimeout: (callback, delay) => setTimeout(callback, delay < 20000 ? 0 : delay), clearTimeout,
    console: {log: value => { report = JSON.parse(value); }},
  });
  assert.equal(report.ok, true); assert.equal(report.retryCount, failures.length); assert.equal(report.configurationRefreshes, 2);
  assert.equal(report.bootstrapEndpoint, 'primary'); assert.equal(report.bytes, 3); assert.equal(report.sha256, digest);
  assert.equal(report.manifestVerified, true); assert.equal(report.timeoutOverrides, false);
  assert.equal(attempts, 2 + failures.length); assert.equal(closed, 2); assert.equal(processFixture.exitCode, undefined);
});

for (const status of [401, 403, 200]) test(`the actual check callback cannot hide HTTP${status} behind a stalled bridge close`, async () => {
  let report, calls = 0, closes = 0;
  const processFixture = {argv: ['node', 'verify-live.mjs'], env: {}};
  await vm.runInNewContext(`(async () => {${source.replace(/^import .*;\n/gm, '')}\n})()`, {
    assert, createHash, officialTarget, publicHTTPS, redirectTarget, smokeResponseDiagnostic, parseProxyConfiguration, bootstrapFallbackOrigin,
    fetch: async () => { calls++; return Response.json(configuration); },
    selectNativeNodes: async nodes => ({nodes, reachable: 1, latencyMs: 1}),
    createSelectedBridge: async () => ({close: () => { closes++; return new Promise(() => {}); }}),
    nativeHTTPSRequest: async () => Response.json({tag_name: 'v0.1.8', draft: false, prerelease: false, assets: []}, {status}),
    process: processFixture, URL, Headers, AbortSignal, AbortController, Uint8Array, TextDecoder, Date,
    setTimeout: (callback, delay) => setTimeout(callback, delay === 20000 ? 15 : delay), clearTimeout,
    console: {log: value => { report = JSON.parse(value); }},
  });
  assert.equal(report.ok, false); assert.equal(report.retryCount, 0); assert.equal(calls, 1); assert.equal(closes, 1);
  assert.equal(report.errorEnum, status === 200 ? 'cleanup_failed' : 'http_status');
  assert.equal(processFixture.exitCode, 1);
});

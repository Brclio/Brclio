'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUpdateProxy, initialURL, SELF_POINTER } = require('./proxy.cjs');
const { API_URL } = require('../desktop/updater.cjs');
const { CONFIG_URL, CONFIG_FALLBACK_URL, PROBE_URL } = require('../desktop/update-proxy.cjs');

const selfRelease = 'https://api.github.com/repos/Brclio/Brclio/releases/tags/downloader-v1.2.3';
const prefix = 'https://github.com/Brclio/Brclio/releases/download/downloader-v1.2.3/';
const asset = prefix + 'Brclio-Downloader-1.2.3-mac-arm64.dmg';
const nodes = ['1.1.1.1', '1.1.1.2'].map(dialAddress => ({
  uuid: '12345678-1234-1234-1234-123456789abc', host: 'relay.example.com', port: 443,
  dialAddress, path: '/fixture', servername: 'relay.example.com', wsHost: 'relay.example.com',
}));

test('release channels allow only the official repository, file type, and versioned self-installers', () => {
  for (const url of [API_URL, SELF_POINTER, asset, prefix + 'SHA256SUMS.txt',
    prefix + 'Brclio-Downloader-1.2.3-windows-x64.exe', prefix + 'Brclio-Downloader-1.2.3-mac-x64.dmg']) {
    assert.equal(initialURL(url), url);
  }
  for (const url of [selfRelease, selfRelease.replace('Brclio/Brclio', 'other/fork'), asset.replace('1.2.3-mac', '1.3.0-mac'),
    asset + '?redirect=yes', asset.replace('.dmg', '.zip'), SELF_POINTER.replace('https:', 'http:')]) {
    assert.throws(() => initialURL(url), { code: 'BRCLIO_UPDATE_ROUTE' });
  }
});

function fixture({ request, config, metadata, resolve = () => 'DIRECT' } = {}) {
  const events = [], calls = [], bridges = [], lookups = [], reloads = [];
  function proxyLookup(name) {
    return {
      async forceReloadProxyConfig() { reloads.push(name); },
      async resolveProxy(url) { lookups.push({name, url}); return resolve(name, url); },
    };
  }
  const router = createUpdateProxy({
    whenReady: async () => {},
    defaultSession: () => ({name:'native', ...proxyLookup('native')}),
    fromPartition(name, { cache }) {
      assert.equal(cache, false);
      return {
        name,
        async setProxy({ mode }) {
          assert.equal(mode, name === 'downloader-subscription' ? 'direct' : name === 'downloader-system' ? 'system' : 'fixed_servers');
        },
        ...proxyLookup(name),
        async closeAllConnections() {},
      };
    },
    onState(state) { events.push(state); },
    async createBridge() {
      const bridge = { closed: false, proxyRules: 'http://127.0.0.1:12345', async close() { this.closed = true; } };
      bridges.push(bridge);
      return bridge;
    },
    async fetchSession(session, url, init) {
      calls.push({ name: session.name, url });
      assert.equal(init.credentials, 'omit');
      assert.equal(init.redirect, 'manual');
      if (session.name === 'downloader-subscription') {
        if (metadata && url === 'https://tools.brclio.com/api/update?url=' + encodeURIComponent(API_URL)) {
          return metadata(url, init);
        }
        assert.ok([CONFIG_URL, CONFIG_FALLBACK_URL].includes(url));
        assert.equal(init.cache, 'no-store');
        return config ? config(url, init) : Response.json({ version: 1, ttlSeconds: 600, nodes });
      }
      if (url === PROBE_URL) {
        assert.equal(init.method, 'HEAD');
        if (session.name.endsWith('-1')) await new Promise(resolve => setTimeout(resolve, 30));
        return new Response(null, { status: 200 });
      }
      return request ? request(url, init, session.name) : new Response('verified route');
    },
  });
  return { router, calls, bridges, events, lookups, reloads };
}

test('a new action detects system proxy changes and skips subscription and probes while configured', async () => {
  let proxy = 'PROXY localhost:7890; DIRECT';
  const {router, calls, bridges, reloads} = fixture({resolve:name => name === 'native' ? proxy : 'DIRECT'});
  for (const [answer, route] of [['PROXY localhost:7890; DIRECT','system'], ['DIRECT','builtin'], ['SOCKS5 localhost:1080','system']]) {
    proxy = answer;
    const start = calls.length;
    await router.setBusy(true, [SELF_POINTER]);
    assert.equal(router.state().route, null);
    assert.equal(await (await router.fetch(SELF_POINTER)).text(), 'verified route');
    assert.equal(router.state().route, route);
    if (route === 'system') {
      assert.equal(router.state().latencyMs, null);
      assert.deepEqual(calls.slice(start), [{name:'native', url:SELF_POINTER}]);
    }
    await router.setBusy(false);
  }
  assert.equal(reloads.length, 6);
  assert.equal(calls.filter(call => call.url === CONFIG_URL).length, 1);
  assert.equal(bridges.length, 2);
  assert.ok(bridges.every(bridge => bridge.closed));
});

test('system PAC honors native and OS rules per target and redirect, including DIRECT exceptions', async () => {
  const sum = prefix + 'SHA256SUMS.txt';
  const cdn = 'https://release-assets.githubusercontent.com/example';
  const {router, calls, bridges} = fixture({
    resolve(name, url) {
      if (url === asset && name === 'downloader-system') return 'SOCKS5 local:1080';
      if (url === cdn && name === 'native') return 'PROXY local:8080';
      return 'DIRECT';
    },
    request:url => url === asset ? Response.redirect(cdn) : new Response('payload'),
  });
  await router.setBusy(true, [sum, asset]);
  await (await router.fetch(sum)).text();
  const response = await router.fetch(asset);
  assert.equal(response.url, cdn);
  assert.equal(await response.text(), 'payload');
  assert.deepEqual(calls, [{name:'downloader-system', url:sum}, {name:'downloader-system', url:asset}, {name:'native', url:cdn}]);
  assert.equal(bridges.length, 0);
  await router.setBusy(false);
});

test('system routes preserve HTTPS validation, proxy failures, and metadata fallback without starting a bridge', async () => {
  const metadata = 'https://tools.brclio.com/api/update?url=' + encodeURIComponent(API_URL);
  const release = { html_url:'https://github.com/Brclio/Brclio/releases/tag/v2.0.1',
    tag_name:'v2.0.1', draft:false, prerelease:false, assets:[] };
  const f = fixture({resolve:name => name === 'downloader-system' ? 'PROXY localhost:7890' : 'DIRECT',
    request(url) {
      if (url === API_URL) return new Response(null, {status:429});
      if (url === metadata) return Response.json(release);
      if (url === SELF_POINTER) return Response.redirect('https://untrusted.invalid/file');
      throw Error('net::ERR_PROXY_CONNECTION_FAILED');
    }});
  assert.deepEqual(await (await f.router.fetch(API_URL)).json(), release);
  await assert.rejects(f.router.fetch(SELF_POINTER), {code:'BRCLIO_UPDATE_ROUTE'});
  await assert.rejects(f.router.fetch(asset), {code:'BRCLIO_UPDATE_NETWORK', message:/系统代理/});
  assert.deepEqual(f.calls.map(c => c.url), [API_URL, metadata, SELF_POINTER, asset]);
  assert.ok(f.calls.every(c => c.name === 'downloader-system'));
  assert.equal(f.bridges.length, 0);

  const rewritten = fixture({resolve:() => 'PROXY localhost:7890',
    request:() => Object.defineProperty(new Response('another origin'), 'url', {value:'https://foreign.invalid/file'})});
  await assert.rejects(rewritten.router.fetch(asset), {code:'BRCLIO_UPDATE_ROUTE'});
});

test('inconclusive or cancelled proxy resolution never starts the subscription', async () => {
  const invalid = fixture({resolve:() => 'UNKNOWN'});
  await assert.rejects(invalid.router.fetch(API_URL), {code:'BRCLIO_UPDATE_ROUTE'});
  assert.equal(invalid.calls.length, 0);
  let begin;
  const began = new Promise(resolve => { begin = resolve; });
  const slow = fixture({resolve:() => { begin(); return new Promise(() => {}); }});
  const waiting = slow.router.fetch(API_URL);
  await began;
  const stopped = assert.rejects(waiting, {name:'AbortError'});
  await slow.router.close();
  await stopped;
  assert.equal(slow.calls.length, 0);
});

test('each attempt refreshes subscription and keeps the quickest GitHub route for both channels', async () => {
  const { router, calls, bridges, events } = fixture();
  for (let run = 0; run < 2; run++) {
    await router.setBusy(true, [API_URL, SELF_POINTER]);
    for (const url of [API_URL, SELF_POINTER, asset]) {
      assert.equal(await (await router.fetch(url)).text(), 'verified route');
    }
    assert.equal(bridges.filter(bridge => !bridge.closed).length, 1);
    await router.setBusy(false);
  }
  assert.equal(calls.filter(call => call.url === CONFIG_URL).length, 2);
  assert.equal(calls.filter(call => call.url === PROBE_URL).length, 4);
  assert.ok(calls.filter(call => [API_URL, SELF_POINTER, asset].includes(call.url)).every(call => call.name.endsWith('-2')));
  assert.ok(bridges.every(bridge => bridge.closed));
  assert.ok(events.some(state => state.phase === 'refreshing'));
  assert.ok(events.some(state => state.phase === 'probing'));
  assert.ok(events.some(state => state.phase === 'ready' && Number.isInteger(state.latencyMs)));
});

test('unsafe redirect is permanent and cancellation closes the active subscription fetch', async () => {
  const { router, calls, bridges } = fixture({ request: () => Response.redirect('https://example.com/file') });
  await assert.rejects(router.fetch(asset), { code: 'BRCLIO_UPDATE_ROUTE' });
  assert.ok(calls.every(call => !call.url.includes('example.com')));
  assert.ok(bridges.every(bridge => bridge.closed));
  let started;
  const beginning = new Promise(resolve => { started = resolve; });
  const aborted = fixture({ config: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    started();
  }) });
  const pending = aborted.router.fetch(API_URL);
  await beginning;
  const stopped = assert.rejects(pending, { name: 'AbortError' });
  await aborted.router.close();
  await stopped;
  assert.equal(aborted.bridges.length, 0);
});

test('network challenge permits the fixed alias within a single self-update check', async () => {
  const { router, calls } = fixture({ config: url => url === CONFIG_URL
    ? new Response(null, { status: 403, headers: { 'cf-mitigated': 'challenge' } })
    : Response.json({ version: 1, ttlSeconds: 600, nodes }) });
  await router.setBusy(true, [API_URL]);
  assert.equal(await (await router.fetch(SELF_POINTER)).text(), 'verified route');
  await router.setBusy(false);
  assert.deepEqual(calls.filter(call => call.name === 'downloader-subscription').map(call => call.url), [CONFIG_URL, CONFIG_FALLBACK_URL]);
});

test('only an explicit GitHub metadata rate limit uses the fixed bounded raw-release endpoint', async () => {
  const release = { html_url: 'https://github.com/Brclio/Brclio/releases/tag/v2.0.1',
    tag_name: 'v2.0.1', draft: false, prerelease: false, assets: [] };
  for (const mock of [
    { status: 429, expectedFallback: true },
    { status: 403, remaining: '0', expectedFallback: true },
    { status: 403, remaining: '4', expectedFallback: false },
    { status: 403, expectedFallback: false },
  ]) {
    let fallbacks = 0;
    const limited = () => new Response(null, { status: mock.status, headers: mock.remaining ? { 'x-ratelimit-remaining': mock.remaining } : {} });
    const { router } = fixture({ request: limited, metadata: () => { fallbacks++; return Response.json(release); } });
    await router.setBusy(true, [API_URL, asset]);
    const response = await router.fetch(API_URL);
    if (mock.expectedFallback) {
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), release);
    } else assert.equal(response.status, 403);
    assert.equal((await router.fetch(asset)).status, mock.status);
    assert.equal(fallbacks, Number(mock.expectedFallback));
    await router.setBusy(false);
  }
});

test('fallback rejects untrusted redirects, oversized responses and unofficial metadata', async () => {
  for (const metadata of [
    () => Response.redirect('https://other.invalid/private'),
    () => Object.defineProperty(Response.json({}), 'url', { value: 'https://other.invalid/resource' }),
    () => new Response('x'.repeat(1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
    () => Response.json({ tag_name: 'v9.0.0', html_url: 'https://github.com/other/fork/releases/tag/v9.0.0' }),
  ]) {
    const { router } = fixture({ request: () => new Response(null, { status: 429 }), metadata });
    await assert.rejects(router.fetch(API_URL), { code: 'BRCLIO_UPDATE_ROUTE' });
  }
});

test('cancelled slow metadata stream closes reader and releases every probe', async () => {
  const controller = new AbortController();
  let readStarted, wasCancelled = false;
  const reading = new Promise(resolve => { readStarted = resolve; });
  const { router, bridges } = fixture({
    request: () => new Response(null, { status: 429 }),
    metadata: () => new Response(new ReadableStream({
      pull() { readStarted(); },
      cancel() { wasCancelled = true; },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } }),
  });
  const request = router.fetch(API_URL, { signal: controller.signal });
  await reading;
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  assert.equal(wasCancelled, true);
  assert.ok(bridges.every(bridge => bridge.closed));
});

test('configuration certificate, invalid subscription and rate-limit errors never switch to the alias', async () => {
  for (const config of [
    () => { throw Error('net::ERR_CERT_AUTHORITY_INVALID'); },
    () => Response.json({ secret: 'invalid' }),
    () => new Response(null, { status: 429 }),
    () => new Response(null, { status: 502 }),
  ]) {
    const { router, calls } = fixture({ config });
    await assert.rejects(router.fetch(SELF_POINTER));
    assert.deepEqual(calls.map(call => call.url), [CONFIG_URL]);
  }
});

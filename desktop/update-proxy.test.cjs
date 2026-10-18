'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createUpdateProxy, usesProxy, SERVICE_ORIGIN, SYSTEM_PARTITION, DIRECT_PARTITION, CHUNK_BYTES } = require('./update-proxy.cjs');
const { createUpdater, API_URL } = require('./updater.cjs');

const downloadURL = 'https://github.com/Brclio/Brclio/releases/download/v0.2.0/Brclio-0.2.0-mac-arm64.dmg';
const checksumURL = 'https://github.com/Brclio/Brclio/releases/download/v0.2.0/SHA256SUMS.txt';

function fixture(overrides = {}) {
  const calls = []; const configurations = []; const resolved = []; const states = [];
  const resolution = async (kind, url) => {
    resolved.push([kind, url]);
    return overrides.resolve ? overrides.resolve(kind, url) : 'DIRECT';
  };
  const native = { resolveProxy: url => resolution('native', url) };
  const system = { setProxy: async value => { configurations.push(['system', value]); }, resolveProxy: url => resolution('system', url),
    fetch: async (url, init) => { calls.push(['system', url, init]); return overrides.fetch ? overrides.fetch('system', url, init) : new Response('system'); } };
  const direct = { setProxy: async value => { configurations.push(['direct', value]); },
    fetch: async (url, init) => { calls.push(['builtin', url, init]); return overrides.fetch ? overrides.fetch('builtin', url, init) : new Response('builtin'); } };
  const router = createUpdateProxy({ whenReady: async () => {}, defaultSession: () => native,
    fromPartition: (name, options) => {
      assert.equal(options.cache, false);
      assert.ok(!name.startsWith('persist:'));
      assert.ok([SYSTEM_PARTITION, DIRECT_PARTITION].includes(name));
      return name === SYSTEM_PARTITION ? system : direct;
    },
    netFetch: async (url, init) => { calls.push(['native', url, init]); return overrides.fetch ? overrides.fetch('native', url, init) : new Response('native'); },
    onState: value => states.push(value),
  });
  return { router, calls, configurations, resolved, states };
}

test('PAC direct choice is respected and proxy fallbacks are not confused with an active proxy', () => {
  assert.equal(usesProxy('DIRECT'), false);
  assert.equal(usesProxy('DIRECT; PROXY fallback.invalid:8080'), false);
  for (const value of ['PROXY localhost:7890; DIRECT', 'SOCKS5 localhost:1080', 'HTTPS localhost:443', 'SOCKS localhost:1080']) {
    assert.equal(usesProxy(value), true);
  }
  assert.throws(() => usesProxy(''), /无法读取/);
});

test('direct system enables the isolated built-in route and preserves validated official response URLs', async () => {
  assert.equal(SERVICE_ORIGIN, 'https://tools.brclio.com');
  const { router, calls, configurations } = fixture();
  const state = await router.state();
  assert.deepEqual(state, { enabled: true, supported: true, route: 'builtin', busy: false, error: null });
  const response = await router.fetch(API_URL, { headers: { 'User-Agent': 'Brclio/0.1.0' } });
  assert.equal(await response.text(), 'builtin');
  assert.equal(response.url, API_URL);
  const service = new URL(calls[0][1]);
  assert.equal(service.origin, SERVICE_ORIGIN);
  assert.equal(service.pathname, '/api/update');
  assert.equal(service.searchParams.get('url'), API_URL);
  assert.equal(calls[0][2].redirect, 'manual');
  assert.equal(calls[0][2].credentials, 'omit');
  assert.deepEqual(configurations, [['system', { mode: 'system' }], ['direct', { mode: 'direct' }]]);
});

test('native configured proxy including CLI wins over built-in, without changing global settings', async () => {
  const { router, calls, resolved } = fixture({ resolve: kind => kind === 'native' ? 'PROXY 127.0.0.1:7890' : 'DIRECT' });
  assert.equal((await router.state()).route, 'system');
  assert.equal(await (await router.fetch(downloadURL)).text(), 'native');
  assert.deepEqual(calls.map(([kind, url]) => [kind, url]), [['native', downloadURL]]);
  assert.ok(resolved.some(([kind, url]) => kind === 'system' && url === downloadURL));
});

test('OS proxy uses dedicated system session when native configuration resolves DIRECT', async () => {
  const { router, calls } = fixture({ resolve: kind => kind === 'system' ? 'SOCKS5 127.0.0.1:1080' : 'DIRECT' });
  assert.equal((await router.state()).route, 'system');
  await router.fetch(API_URL);
  assert.equal(calls[0][0], 'system');
  assert.equal(calls[0][1], API_URL);
  await router.setEnabled(false);
  assert.equal((await router.state()).route, 'system');
});

test('switch is session-only, validates booleans, and becomes enabled in a new process instance', async () => {
  const first = fixture();
  assert.equal((await first.router.setEnabled(false)).route, 'direct');
  await first.router.fetch(API_URL);
  assert.equal(first.calls[0][0], 'native');
  assert.equal((await fixture().router.state()).enabled, true);
  await assert.rejects(first.router.setEnabled('false'), /开启或关闭/);
  first.router.setBusy(true);
  await assert.rejects(first.router.setEnabled(true), /检查或下载/);
  assert.equal((await first.router.state()).busy, true);
  assert.equal((await first.router.state()).enabled, false);
});

test('every request resolves its own PAC target and reflects system proxy changes', async () => {
  let active = false;
  const { router, calls } = fixture({ resolve: (_kind, url) => active && url === downloadURL ? 'PROXY localhost:7890; DIRECT' : 'DIRECT' });
  await router.fetch(API_URL);
  active = true;
  await router.fetch(downloadURL);
  await router.fetch(checksumURL);
  assert.deepEqual(calls.map(([kind]) => kind), ['builtin', 'native', 'builtin']);
});

test('built-in endpoint rejects all service redirects and unexpected response URLs', async () => {
  for (const response of [new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
    Object.defineProperty(new Response('untrusted'), 'url', { value: 'https://evil.example/' }),
    Object.defineProperty(new Response('untrusted'), 'redirected', { value: true })]) {
    const { router } = fixture({ fetch: async () => response });
    await assert.rejects(router.fetch(API_URL), /异常重定向/);
  }
});

test('unavailable built-in service cancels its body and explains the temporary off switch', async () => {
  let cancelled = 0;
  const { router } = fixture({ fetch: async () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 502 }) });
  await assert.rejects(router.fetch(API_URL), /内置更新代理连接失败，可关闭内置代理/);
  assert.equal(cancelled, 1);
  const notPublished = fixture({ fetch: async () => new Response('GitHub response', { status: 404 }) });
  assert.equal((await notPublished.router.fetch(API_URL)).status, 404);
});

test('built-in access errors identify challenges or service refusal without reading or exposing response content', async () => {
  for (const [status, headers, message] of [
    [403, {}, /内置更新服务拒绝请求（HTTP 403）/],
    [429, {}, /内置更新服务暂时限制请求（HTTP 429）/],
    [403, { 'cf-mitigated': 'challenge' }, /Cloudflare 安全验证拦截/],
    [200, { 'cf-mitigated': 'CHALLENGE' }, /Cloudflare 安全验证拦截/],
    [503, { 'cf-mitigated': 'challenge' }, /Cloudflare 安全验证拦截/],
  ]) {
    let cancelled = 0; let read = 0;
    const { router, calls, states } = fixture({ fetch: async () => new Response(new ReadableStream({
      pull() { read++; throw new Error('private URL and response HTML must remain unread'); },
      cancel() { cancelled++; },
    }, { highWaterMark: 0 }), { status, headers }) });
    await assert.rejects(router.fetch(API_URL), error => message.test(error.message) && !/GitHub|private|HTML/.test(error.message));
    assert.equal(cancelled, 1); assert.equal(read, 0); assert.equal(calls.length, 1);
    assert.ok(states.every(state => !/private|HTML/.test(JSON.stringify(state))));
  }
});

test('native direct and system routes preserve GitHub limits and expose challenge headers to the updater', async () => {
  for (const system of [false, true]) {
    for (const challenge of [false, true]) {
      const { router, calls } = fixture({ resolve: () => system ? 'PROXY localhost:7890' : 'DIRECT',
        fetch: async () => new Response(null, { status: 403, headers: challenge ? { 'cf-mitigated': 'challenge' } : {} }) });
      if (!system) await router.setEnabled(false);
      const updater = createUpdater({ currentVersion: '0.1.0', directory: '/unused-check-only', fetch: router.fetch });
      const state = await updater.check();
      assert.match(state.error, challenge ? /Cloudflare 安全验证拦截/ : /GitHub 暂时限制请求/);
      assert.equal(calls.length, 1); assert.equal(calls[0][0], 'native'); assert.equal(calls[0][1], API_URL);
    }
  }
});

test('native redirects are manually checked before making another request and retain CDN final URL', async () => {
  const cdnURL = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/asset?signature=value';
  const { router, calls, resolved } = fixture({ resolve: () => 'PROXY localhost:7890', fetch: async (_kind, url) => url === downloadURL
    ? new Response(null, { status: 302, headers: { location: cdnURL } }) : new Response('verified') });
  const response = await router.fetch(downloadURL);
  assert.equal(response.url, cdnURL);
  assert.equal(await response.text(), 'verified');
  assert.deepEqual(calls.map(([, url]) => url), [downloadURL, cdnURL]);
  assert.ok(resolved.some(([, url]) => url === cdnURL));
  assert.ok(calls.every(([, , init]) => init.redirect === 'manual'));
});

test('native redirect chains cannot leave HTTPS official hosts or smuggle credentials', async () => {
  for (const location of ['https://evil.example/asset', 'http://github.com/asset', 'https://name:password@github.com/asset']) {
    const { router, calls } = fixture({ resolve: () => 'PROXY localhost:7890', fetch: async () => new Response(null, { status: 302, headers: { location } }) });
    await assert.rejects(router.fetch(downloadURL), /非官方/);
    assert.equal(calls.length, 1);
  }
});

test('unsupported target URLs are rejected before proxy detection or network access', async () => {
  const { router, calls, resolved } = fixture();
  for (const target of ['https://github.com/another/repository', 'https://api.github.com/user', 'https://evil.example/latest']) {
    await assert.rejects(router.fetch(target), /官方/);
  }
  assert.equal(calls.length, 0);
  assert.equal(resolved.length, 0);
});

test('release download tags may omit v just as the updater release parser allows', async () => {
  const { router, calls } = fixture({ resolve: () => 'PROXY localhost:7890' });
  await router.fetch(downloadURL.replace('/v0.2.0/', '/0.2.0/'));
  assert.equal(calls.length, 1);
});

test('a native PAC redirect chain can select DIRECT for CDN without inserting built-in routing', async () => {
  const cdnURL = 'https://objects.githubusercontent.com/verified-installer';
  const { router, calls } = fixture({ resolve: (_kind, url) => url === downloadURL ? 'PROXY localhost:7890; DIRECT' : 'DIRECT',
    fetch: async (_kind, url) => url === downloadURL ? new Response(null, { status: 302, headers: { location: cdnURL } }) : new Response('verified') });
  assert.equal(await (await router.fetch(downloadURL)).text(), 'verified');
  assert.deepEqual(calls.map(([kind, url]) => [kind, url]), [['native', downloadURL], ['native', cdnURL]]);
});

test('connection, PAC and streaming errors never expose raw URLs or sensitive transport messages', async () => {
  const secret = 'https://private.invalid/?token=sensitive-value';
  const broken = fixture({ fetch: async () => { throw new Error(`更新地址 ${secret}`); } });
  await assert.rejects(broken.router.fetch(API_URL), error => /内置更新代理连接失败/.test(error.message) && !error.message.includes(secret));
  assert.ok(broken.states.every(state => !JSON.stringify(state).includes(secret)));
  const pac = fixture({ resolve: () => { throw new Error(secret); } });
  assert.match((await pac.router.state()).error, /无法读取/);
  await assert.rejects(pac.router.fetch(API_URL), error => !error.message.includes(secret));
  const stream = fixture({ fetch: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(secret)); } })) });
  const response = await stream.router.fetch(checksumURL);
  await assert.rejects(response.text(), error => /内置更新代理连接失败/.test(error.message) && !error.message.includes(secret));
});

test('abort interrupts stalled PAC resolution and remains an AbortError for updater timeouts', async () => {
  const { router } = fixture({ resolve: () => new Promise(() => {}) });
  const controller = new AbortController();
  const pending = router.fetch(API_URL, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('a pre-aborted request consumes an in-flight session initialization rejection', async () => {
  let rejectReady;
  const router = createUpdateProxy({ whenReady: () => new Promise((_resolve, reject) => { rejectReady = reject; }) });
  const controller = new AbortController(); controller.abort();
  const pending = router.fetch(API_URL, { signal: controller.signal });
  await assert.rejects(pending, { name: 'AbortError' });
  rejectReady(new Error('late session initialization failure'));
  await new Promise(resolve => setImmediate(resolve));
});

test('check, checksum and streamed installer all use built-in routing; switch stays locked for download', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-proxy-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('a verified installer through the built-in proxy');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const assetName = 'Brclio-0.2.0-mac-arm64.dmg';
  let releaseStream;
  let manifestBusy;
  const { router, calls } = fixture({ fetch: async (_kind, url) => {
    const target = new URL(url).searchParams.get('url');
    assert.ok((await router.state()).busy);
    await assert.rejects(router.setEnabled(false), /检查或下载/);
    if (target === API_URL) return new Response(JSON.stringify({ tag_name: 'v0.2.0', body: '', assets: [
      { name: assetName, size: bytes.length, browser_download_url: downloadURL, digest: `sha256:${digest}` },
      { name: 'SHA256SUMS.txt', size: 100, browser_download_url: checksumURL },
    ] }));
    if (target === checksumURL) { manifestBusy = (await router.state()).busy; return new Response(`${digest}  ${assetName}`); }
    return new Response(new ReadableStream({ start(controller) { releaseStream = () => { controller.enqueue(bytes); controller.close(); }; } }),
      { status: 206, headers: { 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}`, 'content-length': String(bytes.length), etag: '"fixture"' } });
  } });
  const updater = createUpdater({ currentVersion: '0.1.0', directory, platform: 'darwin', architecture: 'arm64',
    fetch: router.fetch, onOperation: (_kind, active) => router.setBusy(active) });
  assert.equal((await updater.check()).status, 'available');
  assert.equal((await router.state()).busy, false);
  const download = updater.download();
  while (!releaseStream) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await router.state()).busy, true);
  await assert.rejects(router.setEnabled(false), /检查或下载/);
  releaseStream();
  assert.equal((await download).status, 'downloaded');
  assert.equal(manifestBusy, true);
  assert.equal((await router.state()).busy, false);
  assert.deepEqual(calls.map(([, url]) => new URL(url).searchParams.get('url')), [API_URL, checksumURL, downloadURL]);
  assert.deepEqual(await fs.readFile(path.join(directory, assetName)), bytes);
});

function segment(bytes, init, overrides = {}) {
  const headers = new Headers(init.headers);
  const match = /^bytes=(\d+)-(\d+)$/.exec(headers.get('range'));
  assert.ok(match);
  const start = Number(match[1]), end = Number(match[2]);
  return new Response(bytes.subarray(start, end + 1), { status: 206, ...overrides, headers: {
    'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': String(end - start + 1), etag: '"fixture"', ...overrides.headers,
  } });
}

test('built-in installer buffers validated 128KiB segments, locks route and keeps internal size out of fetch options', async () => {
  assert.equal(CHUNK_BYTES, 131072);
  const bytes = crypto.randomBytes(CHUNK_BYTES * 2 + 17);
  let native = false;
  const { router, calls, resolved } = fixture({ resolve: () => native ? 'PROXY localhost:7890' : 'DIRECT', fetch: async (_kind, _url, init) => {
    assert.equal('expectedSize' in init, false);
    return segment(bytes, init);
  } });
  const response = await router.fetch(downloadURL, { headers: { 'User-Agent': 'Brclio/test' } }, { expectedSize: bytes.length });
  assert.equal(response.status, 200); assert.equal(response.url, downloadURL);
  assert.equal(response.headers.get('content-range'), null);
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.equal(calls.length, 1);
  native = true;
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.deepEqual(calls.map(([, , init]) => new Headers(init.headers).get('range')), [`bytes=0-${CHUNK_BYTES - 1}`, `bytes=${CHUNK_BYTES}-${CHUNK_BYTES * 2 - 1}`, `bytes=${CHUNK_BYTES * 2}-${bytes.length - 1}`]);
  assert.deepEqual(calls.map(([, , init]) => new Headers(init.headers).get('if-range')), [null, '"fixture"', '"fixture"']);
  assert.ok(calls.every(([kind]) => kind === 'builtin'));
  assert.equal(resolved.length, 2, 'PAC selected only once for this virtual response');
});

test('system and disabled routes do not split installer requests or expose internal size', async () => {
  for (const enabled of [true, false]) {
    const { router, calls } = fixture({ resolve: () => enabled ? 'PROXY localhost:7890' : 'DIRECT' });
    if (!enabled) await router.setEnabled(false);
    assert.equal(await (await router.fetch(downloadURL, {}, { expectedSize: CHUNK_BYTES * 2 })).text(), 'native');
    assert.equal(calls.length, 1); assert.equal(calls[0][2].headers, undefined); assert.equal('expectedSize' in calls[0][2], false);
  }
});

test('installer range validation rejects fallback, malformed metadata, weak ETag and changing segments', async () => {
  const bytes = Buffer.alloc(CHUNK_BYTES + 3, 1);
  const invalid = [
    { status: 200 }, { headers: { 'content-range': `bytes 1-${CHUNK_BYTES}/${bytes.length}` } },
    { headers: { 'content-range': `bytes 0-${CHUNK_BYTES - 1}/${bytes.length + 1}` } },
    { headers: { 'content-range': `bytes 00-${CHUNK_BYTES - 1}/${bytes.length}` } },
    { headers: { 'content-length': String(CHUNK_BYTES - 1) } }, { headers: { etag: 'W/"weak"' } },
    { headers: { etag: '' } }, { headers: { etag: '""' } }, { headers: { etag: '"é"' } },
    { headers: { etag: '"' + 'x'.repeat(257) + '"' } }, { headers: { etag: '"one", "two"' } }, { headers: { 'content-encoding': 'gzip' } },
  ];
  for (const override of invalid) {
    const { router, calls } = fixture({ fetch: async (_kind, _url, init) => segment(bytes, init, override) });
    await assert.rejects(router.fetch(downloadURL, {}, { expectedSize: bytes.length }), /分段信息/);
    assert.equal(calls.length, 1);
  }
  const { router, calls } = fixture({ fetch: async (_kind, _url, init) => segment(bytes, init, calls.length === 2 ? { headers: { etag: '"changed"' } } : {}) });
  const response = await router.fetch(downloadURL, {}, { expectedSize: bytes.length });
  await assert.rejects(response.arrayBuffer(), /分段信息/); assert.equal(calls.length, 2);
});

test('truncated or oversized segment emits no bytes and does not start another request', async () => {
  const size = CHUNK_BYTES + 3;
  for (const actual of [CHUNK_BYTES - 1, CHUNK_BYTES + 1]) {
    const { router, calls } = fixture({ fetch: async () => new Response(Buffer.alloc(actual), { status: 206,
      headers: { 'content-range': `bytes 0-${CHUNK_BYTES - 1}/${size}`, 'content-length': String(CHUNK_BYTES), etag: '"fixture"' } }) });
    const response = await router.fetch(downloadURL, {}, { expectedSize: size });
    await assert.rejects(response.body.getReader().read(), /分段/); assert.equal(calls.length, 1);
  }
});

test('cancelling or aborting a segmented stream cancels the current body and never opens the next segment', async () => {
  const bytes = Buffer.alloc(CHUNK_BYTES + 3);
  for (const abortRequest of [false, true]) {
    let cancelled = 0;
    const controller = new AbortController();
    const { router, calls } = fixture({ fetch: async () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 206,
      headers: { 'content-range': `bytes 0-${CHUNK_BYTES - 1}/${bytes.length}`, 'content-length': String(CHUNK_BYTES), etag: '"fixture"' } }) });
    const response = await router.fetch(downloadURL, { signal: controller.signal }, { expectedSize: bytes.length });
    if (abortRequest) { const pending = response.text(); controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); }
    else await response.body.cancel();
    assert.equal(cancelled, 1); assert.equal(calls.length, 1);
  }
});

test('installer size is required before any built-in network request', async () => {
  const { router, calls } = fixture();
  for (const expectedSize of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER]) await assert.rejects(router.fetch(downloadURL, {}, { expectedSize }), /大小无效/);
  assert.equal(calls.length, 0);
});

test('segment redirects and transient errors do not expose transport details or silently retry', async () => {
  const bytes = Buffer.alloc(CHUNK_BYTES + 3);
  for (const failure of ['redirect', 'service', 'stream']) {
    const { router, calls } = fixture({ fetch: async (_kind, _url, init) => {
      if (calls.length === 1) return segment(bytes, init);
      if (failure === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://private.invalid/?token=secret' } });
      if (failure === 'service') return new Response('secret transport detail', { status: 502 });
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error('secret transport detail')); } }), { status: 206,
        headers: { 'content-range': `bytes ${CHUNK_BYTES}-${bytes.length - 1}/${bytes.length}`, 'content-length': '3', etag: '"fixture"' } });
    } });
    const response = await router.fetch(downloadURL, {}, { expectedSize: bytes.length });
    await assert.rejects(response.arrayBuffer(), error => !error.message.includes('secret') && (failure === 'redirect' ? /异常重定向/.test(error.message) : /内置更新代理连接失败/.test(error.message)));
    assert.equal(calls.length, 2);
  }
});

test('cancellation between validated segments does not prefetch another segment', async () => {
  const bytes = Buffer.alloc(CHUNK_BYTES + 3);
  const { router, calls } = fixture({ fetch: async (_kind, _url, init) => segment(bytes, init) });
  const response = await router.fetch(downloadURL, {}, { expectedSize: bytes.length });
  const reader = response.body.getReader();
  assert.equal((await reader.read()).value.length, CHUNK_BYTES);
  assert.equal(calls.length, 1);
  await reader.cancel();
  assert.equal(calls.length, 1);
});

test('updater retains whole-package SHA verification and removes partial files after later-segment failure', async t => {
  const bytes = crypto.randomBytes(CHUNK_BYTES + 37);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const assetName = 'Brclio-0.2.0-mac-arm64.dmg';
  for (const mode of ['corrupted', 'truncated']) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-chunk-cleanup-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const { router } = fixture({ fetch: async (_kind, url, init) => {
      const target = new URL(url).searchParams.get('url');
      if (target === API_URL) return new Response(JSON.stringify({ tag_name: 'v0.2.0', assets: [
        { name: assetName, size: bytes.length, browser_download_url: downloadURL, digest: `sha256:${digest}` },
        { name: 'SHA256SUMS.txt', browser_download_url: checksumURL },
      ] }));
      if (target === checksumURL) { assert.equal(new Headers(init.headers).get('range'), null); return new Response(`${digest}  ${assetName}`); }
      if (new Headers(init.headers).get('range').startsWith('bytes=0-')) return segment(bytes, init);
      const wrong = Buffer.from(bytes); wrong[wrong.length - 1] ^= 0xff;
      if (mode === 'corrupted') return segment(wrong, init);
      return new Response(bytes.subarray(CHUNK_BYTES, bytes.length - 1), { status: 206,
        headers: { 'content-range': `bytes ${CHUNK_BYTES}-${bytes.length - 1}/${bytes.length}`, 'content-length': '37', etag: '"fixture"' } });
    } });
    const updater = createUpdater({ currentVersion: '0.1.0', directory, platform: 'darwin', architecture: 'arm64', fetch: router.fetch,
      onOperation: (_kind, active) => router.setBusy(active) });
    await updater.check();
    const state = await updater.download();
    assert.equal(state.status, 'error');
    assert.match(state.error, mode === 'corrupted' ? /SHA256/ : /分段未完成/);
    assert.deepEqual(await fs.readdir(directory), []);
    assert.equal((await router.state()).busy, false);
    assert.match((await updater.install()).error, /先下载并校验/);
  }
});

test('installer-only 503 recovery repeats the same uncommitted segment once and still requires whole-package SHA', async t => {
  const bytes = crypto.randomBytes(CHUNK_BYTES + 29);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const assetName = 'Brclio-0.2.0-mac-arm64.dmg';
  for (const exhausted of [false, true]) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-503-recovery-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    let attempts = 0, cancelled = 0;
    const { router, calls } = fixture({ fetch: async (_kind, url, init) => {
      const target = new URL(url).searchParams.get('url');
      if (target === API_URL) return new Response(JSON.stringify({ tag_name: 'v0.2.0', assets: [
        { name: assetName, size: bytes.length, browser_download_url: downloadURL, digest: `sha256:${digest}` },
        { name: 'SHA256SUMS.txt', browser_download_url: checksumURL },
      ] }));
      if (target === checksumURL) return new Response(`${digest}  ${assetName}`);
      if (new Headers(init.headers).get('range').startsWith(`bytes=${CHUNK_BYTES}-`)) {
        attempts++;
        if (exhausted || attempts === 1) return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 503 });
      }
      return segment(bytes, init);
    } });
    const updater = createUpdater({ currentVersion: '0.1.0', directory, platform: 'darwin', architecture: 'arm64', fetch: router.fetch,
      onOperation: (_kind, active) => router.setBusy(active) });
    await updater.check(); const state = await updater.download();
    assert.equal(attempts, 2); assert.equal(cancelled, exhausted ? 2 : 1);
    assert.equal(state.status, exhausted ? 'error' : 'downloaded');
    if (exhausted) { assert.match(state.error, /内置更新代理连接失败/); assert.deepEqual(await fs.readdir(directory), []); }
    else assert.deepEqual(await fs.readFile(path.join(directory, assetName)), bytes);
    assert.equal((await router.state()).busy, false);
    const segmentCalls = calls.filter(([, , init]) => new Headers(init.headers).has('range'));
    assert.equal(segmentCalls.length, 3);
    assert.deepEqual([...new Headers(segmentCalls[1][2].headers)], [...new Headers(segmentCalls[2][2].headers)]);
  }
});

test('503 recovery never applies to metadata, checksum, 502, 429 or transport failures', async () => {
  for (const target of [API_URL, checksumURL]) {
    const { router, calls } = fixture({ fetch: async () => new Response('unavailable', { status: 503 }) });
    await assert.rejects(router.fetch(target), /内置更新代理连接失败/); assert.equal(calls.length, 1);
  }
  for (const status of [502, 429]) {
    const { router, calls } = fixture({ fetch: async () => new Response('unavailable', { status }) });
    const request = router.fetch(downloadURL, {}, { expectedSize: 1 });
    await assert.rejects(request, status === 429 ? /内置更新服务暂时限制请求/ : /内置更新代理连接失败/);
    assert.equal(calls.length, 1);
  }
  const { router, calls } = fixture({ fetch: async () => { throw new Error('TLS connection failed'); } });
  await assert.rejects(router.fetch(downloadURL, {}, { expectedSize: 1 }), /内置更新代理连接失败/); assert.equal(calls.length, 1);
});

test('later installer access blocks preserve the safe explanation and remove partial downloads without retry', async t => {
  const bytes = crypto.randomBytes(CHUNK_BYTES + 29);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const assetName = 'Brclio-0.2.0-mac-arm64.dmg';
  for (const [status, headers, message] of [
    [403, {}, /内置更新服务拒绝请求/],
    [429, {}, /内置更新服务暂时限制请求/],
    [403, { 'cf-mitigated': 'challenge' }, /Cloudflare 安全验证拦截/],
    [200, { 'cf-mitigated': 'challenge' }, /Cloudflare 安全验证拦截/],
  ]) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-access-block-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    let blockedRequests = 0; let cancelled = 0;
    const { router, states } = fixture({ fetch: async (_kind, url, init) => {
      const target = new URL(url).searchParams.get('url');
      if (target === API_URL) return new Response(JSON.stringify({ tag_name: 'v0.2.0', assets: [
        { name: assetName, size: bytes.length, browser_download_url: downloadURL, digest: `sha256:${digest}` },
        { name: 'SHA256SUMS.txt', browser_download_url: checksumURL },
      ] }));
      if (target === checksumURL) return new Response(`${digest}  ${assetName}`);
      if (new Headers(init.headers).get('range').startsWith('bytes=0-')) return segment(bytes, init);
      blockedRequests++;
      return new Response(new ReadableStream({
        pull() { throw new Error('https://private.invalid/?token=secret HTML must not be read'); },
        cancel() { cancelled++; },
      }, { highWaterMark: 0 }), { status, headers });
    } });
    const updater = createUpdater({ currentVersion: '0.1.0', directory, platform: 'darwin', architecture: 'arm64', fetch: router.fetch,
      onOperation: (_kind, active) => router.setBusy(active) });
    await updater.check(); const state = await updater.download();
    assert.equal(state.status, 'error'); assert.match(state.error, message); assert.equal(state.canInstall, false);
    assert.equal(blockedRequests, 1); assert.equal(cancelled, 1);
    assert.deepEqual(await fs.readdir(directory), []);
    assert.ok(states.every(value => !/private|token=|HTML/.test(JSON.stringify(value))));
    assert.equal((await router.state()).busy, false);
  }
});

test('abort during the 503 recovery delay stops promptly without a second request', async () => {
  let cancelled = 0;
  const { router, calls } = fixture({ fetch: async () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 503 }) });
  const controller = new AbortController();
  const pending = router.fetch(downloadURL, { signal: controller.signal }, { expectedSize: 1 });
  while (!cancelled) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setTimeout(resolve, 20));
  const start = Date.now(); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(Date.now() - start < 300);
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(calls.length, 1); assert.equal(cancelled, 1);
});

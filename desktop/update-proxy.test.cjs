'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createUpdateProxy, usesProxy, SERVICE_ORIGIN, SYSTEM_PARTITION, DIRECT_PARTITION } = require('./update-proxy.cjs');
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
  for (const status of [403, 404, 429]) {
    const fixtureWithStatus = fixture({ fetch: async () => new Response('GitHub response', { status }) });
    assert.equal((await fixtureWithStatus.router.fetch(API_URL)).status, status);
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
  const { router, calls } = fixture();
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
  const response = await stream.router.fetch(downloadURL);
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
    return new Response(new ReadableStream({ start(controller) { releaseStream = () => { controller.enqueue(bytes); controller.close(); }; } }));
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

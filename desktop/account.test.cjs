'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAccountClient, createAccountStore, validateAccountRequest, ORIGIN, MAX_BYTES } = require('./account.cjs');
const token = 'fixture-token-private-native-session';
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
function fixture(overrides = {}) {
  let saved = null;
  const calls = [], opened = [];
  const client = createAccountClient({ store: { read: async () => saved, write: async value => { saved = value; } },
    fetch: async (url, init) => { calls.push({ url, ...init }); return response({ user: null }); },
    openExternal: async url => opened.push(url), ...overrides });
  return { client, calls, opened, saved: () => saved };
}
test('renderer requests are confined to account operations and bounded JSON', () => {
  assert.deepEqual(validateAccountRequest({ path: '/api/account/session' }), { path: '/api/account/session', method: 'GET', body: undefined });
  for (const request of [null, { path: 'https://evil.example/api/account/login', method: 'POST' },
    { path: '//evil.example' }, { path: '/api/account/session?x=y' }, { path: '/api/account/device/poll' },
    { path: '/api/account/login', method: 'GET' }, { path: '/api/account/data', method: 'PUT', body: [] },
    { path: '/api/account/session', body: {} }, { path: '/api/account/login', method: 'POST', body: { value: 'x'.repeat(MAX_BYTES) } }]) {
    assert.throws(() => validateAccountRequest(request));
  }
});
test('native sessions persist privately and auth results never expose bearer tokens', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-account-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createAccountStore(directory);
  assert.equal(await store.read(), null);
  await store.write(token);
  assert.equal(await createAccountStore(directory).read(), token);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(directory, 'account-session.json'))).mode & 0o777, 0o600);
  const calls = [];
  const f = fixture({ store, fetch: async (url, init) => { calls.push({ url, ...init }); return response({ token, user: { id: 'u1' }, csrf: 'csrf-fixture' }); } });
  const result = await f.client.request({ path: '/api/account/login', method: 'POST', body: { identifier: 'alice', password: 'fixture' } });
  assert.deepEqual(result, { user: { id: 'u1' }, csrf: 'csrf-fixture' });
  await f.client.request({ path: '/api/account/session' });
  assert.equal(calls[1].headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[1].headers['X-Brclio-Client'], 'native');
  assert.equal(calls[1].headers.Origin, undefined);
  assert.equal(calls[1].redirect, 'manual');
  assert.equal(calls[1].credentials, 'omit');
  assert.equal(calls[1].url, ORIGIN + '/api/account/session');
});
test('logout sends the old bearer and clears local state even if server unavailable', async () => {
  const f = fixture({ fetch: async (_url, init) => {
    if (init.method === 'POST' && init.body) return response({ token, user: { id: 'u1' } });
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    return response({ error: 'Offline' }, 503);
  } });
  await f.client.request({ path: '/api/account/login', method: 'POST', body: {} });
  await assert.rejects(f.client.request({ path: '/api/account/logout', method: 'POST' }), /Offline/);
  assert.equal(f.saved(), null);
});
test('native handoff opens only trusted browser URL and polls with verifier proof', async () => {
  const id = 'fixture_device_0123456789';
  const bytes = Buffer.alloc(32, 7);
  const verifier = bytes.toString('base64url');
  let polls = 0;
  const opened = [];
  const f = fixture({ randomBytes: () => bytes, pollInterval: 0, delay: async () => {}, openExternal: async url => opened.push(url),
    fetch: async (url, init) => {
      if (url.endsWith('/device/start')) {
        assert.deepEqual(JSON.parse(init.body), { challenge: crypto.createHash('sha256').update(verifier).digest('base64url') });
        return response({ id, url: `${ORIGIN}/api/account/google/start?device=${id}` });
      }
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get('id'), id);
      assert.equal(parsed.searchParams.get('verifier'), verifier);
      return response(++polls === 1 ? { pending: true } : { token, user: { id: 'u2' } });
    } });
  assert.deepEqual(await f.client.google(), { user: { id: 'u2' } });
  assert.equal(f.saved(), token);
  assert.deepEqual(opened, [`${ORIGIN}/api/account/google/start?device=${id}`]);
  assert.equal(polls, 2);
});
test('untrusted OAuth links, redirects, HTML and oversized responses are rejected', async () => {
  const id = 'fixture_device_0123456789';
  for (const url of [`https://evil.example/api/account/google/start?device=${id}`, `${ORIGIN}/other?device=${id}`, `${ORIGIN}/api/account/google/start?device=other`, `https://user@tools.brclio.com/api/account/google/start?device=${id}`]) {
    const f = fixture({ fetch: async () => response({ id, url }) });
    await assert.rejects(f.client.google(), /登录链接无效/);
    assert.deepEqual(f.opened, []);
  }
  for (const value of [new Response('', { status: 302, headers: { Location: 'https://evil.example' } }),
    new Response('<html>challenge</html>', { status: 403, headers: { 'Content-Type': 'text/html' } }),
    response({ padding: 'x'.repeat(MAX_BYTES) })]) {
    const f = fixture({ fetch: async () => value });
    await assert.rejects(f.client.request({ path: '/api/account/session' }));
  }
});
test('cancelling a pending browser handoff rejects and does not persist a token', async () => {
  const id = 'fixture_device_0123456789';
  const f = fixture({ fetch: async () => response({ id, url: `${ORIGIN}/api/account/google/start?device=${id}` }),
    openExternal: async () => { f.client.cancelGoogle(); } });
  await assert.rejects(f.client.google(), /取消/);
  assert.equal(f.saved(), null);
});

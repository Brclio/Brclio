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
const settingsRequests = [
  { path: '/api/account/profile', method: 'PUT', body: { username: 'alice', nickname: 'Alice' } },
  { path: '/api/account/password', method: 'POST', body: { currentPassword: 'old-fixture', password: 'new-fixture' } },
];
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
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
test('account settings allow only exact methods and bounded object bodies', () => {
  for (const input of settingsRequests) {
    assert.deepEqual(validateAccountRequest(input), { ...input, body: JSON.stringify(input.body) });
    for (const method of ['GET', 'DELETE', 'PATCH', input.method === 'PUT' ? 'POST' : 'PUT', input.method.toLowerCase()]) {
      assert.throws(() => validateAccountRequest({ ...input, method }));
    }
    for (const path of [input.path + '?x=y', input.path + '/', ORIGIN + input.path, input.path.replace('/api/', '//api/'), input.path.replace('/account/', '/account/%2e%2e/')]) {
      assert.throws(() => validateAccountRequest({ ...input, path }));
    }
    for (const body of [null, [], 'fixture', { nickname: '字'.repeat(50000) }]) {
      assert.throws(() => validateAccountRequest({ ...input, body }));
    }
  }
});
test('profile and password updates keep the bearer and do not invalidate concurrent session reads', async t => {
  for (const input of settingsRequests) await t.test(input.path, async () => {
    const started = deferred(), pendingSession = deferred();
    const calls = [], writes = [];
    const user = { id: 'u1', username: 'alice', nickname: 'Alice' };
    const f = fixture({ store: { read: async () => token, write: async value => writes.push(value) },
      fetch: async (url, init) => {
        calls.push({ url, ...init });
        if (url.endsWith('/session')) { started.resolve(); return pendingSession.promise; }
        return response({ user });
      } });
    const session = f.client.request({ path: '/api/account/session' });
    await started.promise;
    assert.deepEqual(await f.client.request({ ...input, headers: { Authorization: 'renderer-value' }, origin: 'https://evil.example' }), { user });
    pendingSession.resolve(response({ user }));
    assert.deepEqual(await session, { user });
    assert.deepEqual(writes, []);
    assert.equal(calls[1].url, ORIGIN + input.path);
    assert.equal(calls[1].method, input.method);
    assert.equal(calls[1].body, JSON.stringify(input.body));
    assert.equal(calls[1].headers.Authorization, `Bearer ${token}`);
    assert.equal(calls[1].headers['X-Brclio-Client'], 'native');
    assert.equal(calls[1].headers.Origin, undefined);
  });
});
test('settings cancel Google handoff and reject a late poll response without replacing the current account', async t => {
  for (const input of settingsRequests) await t.test(input.path, async () => {
    const id = 'fixture_device_0123456789';
    const started = deferred(), pendingPoll = deferred();
    const writes = [];
    let pollSignal;
    const f = fixture({ store: { read: async () => token, write: async value => writes.push(value) }, delay: async () => {},
      fetch: async (url, init) => {
        if (url.endsWith('/device/start')) return response({ id, url: `${ORIGIN}/api/account/google/start?device=${id}` });
        if (url.includes('/device/poll?')) { pollSignal = init.signal; started.resolve(); return pendingPoll.promise; }
        assert.equal(init.headers.Authorization, `Bearer ${token}`);
        return response({ user: { id: 'u1' } });
      } });
    const handoff = assert.rejects(f.client.google(), /取消/);
    await started.promise;
    assert.deepEqual(await f.client.request(input), { user: { id: 'u1' } });
    assert.equal(pollSignal.aborted, true);
    // A response that won the network abort race must still never reach the token store.
    pendingPoll.resolve(response({ token: 'late-google-token-fixture', user: { id: 'u2' } }));
    await handoff;
    assert.deepEqual(writes, []);
  });
});
test('duplicate email failures preserve the safe message used by the login fallback', async () => {
  const message = '该邮箱已注册，请登录后在账号设置中设置昵称、账号和密码';
  const f = fixture({ fetch: async () => response({ error: message, code: 'EMAIL_EXISTS' }, 409) });
  for (const path of ['/api/account/code', '/api/account/register']) {
    await assert.rejects(f.client.request({ path, method: 'POST', body: { email: 'alice@example.com' } }), error => {
      assert.equal(error.message, message);
      assert.equal(error.status, 409);
      return true;
    });
  }
  assert.equal(f.saved(), null);
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

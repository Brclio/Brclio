import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleAccount} from '../src/accounts.js';
import {digest, hashPassword, checkPassword, random} from '../src/accounts-crypto.js';
import {createAccountStore} from '../src/account-store.js';
import {sendRegistrationCode} from '../src/mail.js';
import {googleIdentity} from '../src/accounts-google.js';
import {encode64} from '../src/accounts-crypto.js';
import {build} from 'esbuild';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {fileURLToPath} from 'node:url';

function memoryStore() {
  const files = new Map(); let queue = Promise.resolve();
  return {
    files,
    async snapshot() { const current = new Map(structuredClone([...files])); return {read: async (path, fallback = null) => structuredClone(current.has(path) ? current.get(path) : fallback)}; },
    transaction(mutate) {
      const operation = queue.then(async () => {
        const writes = new Map();
        const result = await mutate({read: async (path, fallback = null) => structuredClone(files.has(path) ? files.get(path) : fallback), write: (path, value) => writes.set(path, structuredClone(value))});
        for (const [path, value] of writes) files.set(path, value);
        return result;
      });
      queue = operation.catch(() => {}); return operation;
    }
  };
}
const allow = {limit: async () => ({success: true})};
function fixture() {
  const store = memoryStore(), sent = [];
  const env = {SESSION_SECRET: 'test-account-secret-of-at-least-32-characters', SMTP_EMAIL: 'sender@example.com', SMTP_APP_PASSWORD: 'test-app-password', GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', ACCOUNT_LIMITER: allow, ACCOUNT_AUTH_LIMITER: allow, ACCOUNT_EMAIL_LIMITER: allow, ACCOUNT_EMAIL_GLOBAL_LIMITER: allow};
  const dependencies = {accountDiagnostic: () => {}, accountStore: store, sendRegistrationCode: async (_env, email, code) => sent.push({email, code}), googleIdentity: async () => ({sub: 'google-test-sub', email: 'google@example.com', name: 'Google User'})};
  async function call(path, method = 'GET', body, options = {}) {
    const headers = {...(method !== 'GET' ? {'Content-Type': 'application/json', Origin: 'https://tools.brclio.com'} : {}), ...(options.native ? {'X-Brclio-Client': 'native'} : {}), ...options.headers};
    if (options.native) delete headers.Origin;
    return handleAccount(new Request('https://tools.brclio.com/api/account/' + path, {method, headers, ...(method !== 'GET' ? {body: JSON.stringify(body || {})} : {})}), env, dependencies);
  }
  async function register(username = 'alice', email = 'alice@example.com', native = false) {
    assert.equal((await call('code', 'POST', {email}, {native})).status, 200);
    const response = await call('register', 'POST', {username, email, code: sent.at(-1).code, password: 'my correct password'}, {native});
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value));
    return {...value, cookie: response.headers.get('Set-Cookie')?.split(';')[0]};
  }
  return {store, env, dependencies, sent, call, register};
}

test('registration persists readable independent user folders, hashes secrets, consumes code, and signs cookie', async () => {
  const f = fixture(), signed = await f.register();
  assert.match(signed.cookie, /^__Host-brclio_user=/);
  assert.equal(signed.token, undefined);
  assert.equal(signed.user.username, 'alice');
  const records = [...f.store.files];
  assert.deepEqual(records.filter(([path]) => path.startsWith('users/' + signed.user.id + '/')).map(([path]) => path.split('/').at(-1)).sort(), ['credentials.json', 'data.json', 'profile.json']);
  const stored = JSON.stringify(records);
  assert.ok(!stored.includes('my correct password'));
  assert.ok(!stored.includes(signed.cookie));
  assert.ok(!stored.includes('"code":'));
  assert.equal(f.store.files.get('users/_index.json').verifications['alice@example.com'], undefined);
  const session = await (await f.call('session', 'GET', undefined, {headers: {Cookie: signed.cookie}})).json();
  assert.equal(session.user.id, signed.user.id); assert.equal(session.csrf, signed.csrf);
});

test('password verification uses random salts and accepts only the correct password', async () => {
  const first = await hashPassword('my correct password'), second = await hashPassword('my correct password');
  assert.equal(first.iterations, 100000); assert.notEqual(first.salt, second.salt); assert.notEqual(first.hash, second.hash);
  assert.equal(await checkPassword('my correct password', first), true);
  assert.equal(await checkPassword('wrong password', first), false);
});

test('OTP cooldown, invalid attempt lock, and expiration are durable', async () => {
  const f = fixture();
  assert.equal((await f.call('code', 'POST', {email: 'alice@example.com'})).status, 200);
  assert.equal((await f.call('code', 'POST', {email: 'alice@example.com'})).status, 429);
  const code = f.sent[0].code, wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await f.call('register', 'POST', {username: 'alice', email: 'alice@example.com', code: wrong, password: 'long password'})).status, 400);
  assert.equal(f.store.files.get('users/_index.json').verifications['alice@example.com'].attempts, 5);
  assert.equal((await f.call('register', 'POST', {username: 'alice', email: 'alice@example.com', code, password: 'long password'})).status, 400);
  const index = f.store.files.get('users/_index.json'); index.verifications['alice@example.com'].attempts = 0; index.verifications['alice@example.com'].expiresAt = Date.now() - 1;
  assert.equal((await f.call('register', 'POST', {username: 'alice', email: 'alice@example.com', code, password: 'long password'})).status, 400);
});

test('simultaneous registration cannot create duplicate usernames', async () => {
  const f = fixture();
  await f.call('code', 'POST', {email: 'one@example.com'}); await f.call('code', 'POST', {email: 'two@example.com'});
  const responses = await Promise.all(f.sent.map(({email, code}) => f.call('register', 'POST', {username: 'SameName', email, code, password: 'long password'})));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 400]);
  assert.equal(Object.keys(f.store.files.get('users/_index.json').usernames).length, 1);
});

test('login accepts username or email and native sessions never become web cookies', async () => {
  const f = fixture(), signed = await f.register();
  for (const identifier of ['ALICE', 'alice@example.com']) {
    const response = await f.call('login', 'POST', {identifier, password: 'my correct password'}, {native: true});
    assert.equal(response.status, 200); assert.equal(response.headers.get('Set-Cookie'), null);
    const value = await response.json(); assert.ok(value.token);
    const session = await (await f.call('session', 'GET', undefined, {native: true, headers: {Authorization: 'Bearer ' + value.token}})).json(); assert.equal(session.user.id, signed.user.id);
    const wrongMode = await (await f.call('session', 'GET', undefined, {headers: {Cookie: '__Host-brclio_user=' + value.token}})).json(); assert.equal(wrongMode.user, null);
  }
  assert.equal((await f.call('login', 'POST', {identifier: 'alice', password: 'wrong password'})).status, 401);
});

test('origin and CSRF protect mutations; logout revokes signed token; data is scoped to signed user', async () => {
  const f = fixture(), alice = await f.register(), bob = await f.register('bobby', 'bob@example.com');
  const update = {preferences: {pathMode: 'relative', quoteMode: 'auto', separator: 'forward', trailingSlash: true, joinWith: 'newline'}};
  assert.equal((await f.call('data', 'PUT', update, {headers: {Cookie: alice.cookie}})).status, 403);
  assert.equal((await f.call('data', 'PUT', update, {headers: {Cookie: alice.cookie, 'X-CSRF-Token': alice.csrf, Origin: 'https://evil.example'}})).status, 403);
  assert.equal((await f.call('data', 'PUT', update, {headers: {Cookie: alice.cookie, 'X-CSRF-Token': alice.csrf}})).status, 200);
  assert.deepEqual((await (await f.call('data', 'GET', undefined, {headers: {Cookie: alice.cookie}})).json()).preferences, update.preferences);
  assert.deepEqual((await (await f.call('data', 'GET', undefined, {headers: {Cookie: bob.cookie}})).json()).preferences, {});
  assert.equal((await (await f.call('data', 'GET', undefined, {headers: {Cookie: alice.cookie}})).json()).userId, alice.user.id);
  assert.equal((await (await f.call('data', 'GET', undefined, {headers: {Cookie: bob.cookie}})).json()).userId, bob.user.id);
  assert.equal((await (await f.call('data', 'PUT', update, {headers: {Cookie: alice.cookie, 'X-CSRF-Token': alice.csrf}})).json()).userId, alice.user.id);
  assert.equal((await f.call('data', 'PUT', {preferences: {basePath: '/private/path'}}, {headers: {Cookie: alice.cookie, 'X-CSRF-Token': alice.csrf}})).status, 400);
  for (const key of ['constructor', 'toString', '__proto__']) {
    assert.equal((await f.call('data', 'PUT', {preferences: {[key]: 'unexpected'}}, {headers: {Cookie: alice.cookie, 'X-CSRF-Token': alice.csrf}})).status, 400, 'inherited preference names must be rejected cleanly');
  }
  assert.equal((await f.call('logout', 'POST', {}, {headers: {Cookie: alice.cookie, 'X-CSRF-Token': alice.csrf}})).status, 200);
  assert.equal((await (await f.call('session', 'GET', undefined, {headers: {Cookie: alice.cookie}})).json()).user, null);
  assert.equal((await f.call('register', 'POST', {}, {headers: {Origin: 'https://evil.example', 'X-Brclio-Client': 'native'}})).status, 403);
});

test('Google authorization verifies state cookie and creates a Google identity with readable profile', async () => {
  const f = fixture(), start = await f.call('google/start');
  assert.equal(start.status, 302);
  const location = new URL(start.headers.get('Location')); assert.equal(location.origin, 'https://accounts.google.com');
  assert.equal(location.searchParams.get('scope'), 'openid email profile'); assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  const state = location.searchParams.get('state'), oauthCookie = start.headers.get('Set-Cookie').split(';')[0];
  const rejected = await f.call('google/callback?state=' + encodeURIComponent(state) + '&code=valid');
  assert.equal(rejected.headers.get('Location'), '/account?error=google');
  const complete = await f.call('google/callback?state=' + encodeURIComponent(state) + '&code=valid', 'GET', undefined, {headers: {Cookie: oauthCookie}});
  assert.equal(complete.headers.get('Location'), '/account');
  const index = f.store.files.get('users/_index.json'), profile = f.store.files.get('users/' + index.google['google-test-sub'] + '/profile.json');
  assert.equal(profile.email, 'google@example.com'); assert.deepEqual(profile.providers, ['google']);
});

test('verified Google email links the existing password account and preserves its user folder and password', async () => {
  const f = fixture(), existing = await f.register('existing-user', 'google@example.com');
  const credentialsPath = 'users/' + existing.user.id + '/credentials.json';
  const originalPassword = structuredClone(f.store.files.get(credentialsPath).password);
  const start = await f.call('google/start');
  const state = new URL(start.headers.get('Location')).searchParams.get('state');
  const completed = await f.call('google/callback?state=' + state + '&code=valid', 'GET', undefined, {headers:{Cookie:start.headers.get('Set-Cookie').split(';')[0]}});
  assert.equal(completed.headers.get('Location'), '/account');
  const index = f.store.files.get('users/_index.json');
  assert.equal(index.google['google-test-sub'], existing.user.id);
  assert.equal(index.emails['google@example.com'], existing.user.id);
  assert.equal(index.usernames['existing-user'], existing.user.id);
  assert.equal(Object.keys(index.emails).length, 1);
  const profile = f.store.files.get('users/' + existing.user.id + '/profile.json');
  assert.deepEqual(profile.providers.sort(), ['google', 'password']);
  assert.deepEqual(f.store.files.get(credentialsPath).password, originalPassword);
  assert.equal(f.store.files.get(credentialsPath).googleSub, 'google-test-sub');
  assert.equal((await f.call('login', 'POST', {identifier:'google@example.com', password:'my correct password'})).status, 200);
});

test('Google failure diagnostics identify finite phases and never include callback or provider secrets', async () => {
  const sensitive = 'callback-code-token-cookie-secret-should-never-be-logged';
  for (const [scenario, expected] of [
    ['missing-cookie', 'state_cookie_missing'], ['invalid-cookie', 'state_cookie_invalid'], ['mismatched-state', 'state_mismatch'], ['provider-denied', 'provider_denied'],
    ['invalid-grant', 'token_invalid_grant'], ['unknown-provider-error', 'token_rejected'], ['network', 'token_exchange'],
    ['injected-error', 'identity_exchange'], ['invalid-profile', 'identity_profile'], ['storage', 'storage_transaction'], ['commit', 'storage_commit']
  ]) {
    const f = fixture(), events = [];
    f.dependencies.accountDiagnostic = event => events.push(event);
    const started = await f.call('google/start');
    const state = new URL(started.headers.get('Location')).searchParams.get('state');
    const cookie = started.headers.get('Set-Cookie').split(';')[0];
    let query = 'state=' + state + '&code=' + sensitive;
    if (scenario === 'mismatched-state') query = 'state=wrong&code=' + sensitive;
    if (scenario === 'provider-denied') query = 'state=' + state + '&error=' + sensitive;
    if (['invalid-grant', 'unknown-provider-error', 'network'].includes(scenario)) {
      delete f.dependencies.googleIdentity;
      f.dependencies.accountFetchImpl = async () => {
        if (scenario === 'network') throw new Error(sensitive);
        return Response.json({error: scenario === 'invalid-grant' ? 'invalid_grant' : sensitive, error_description: sensitive, access_token: sensitive}, {status: 400});
      };
    }
    if (scenario === 'injected-error') f.dependencies.googleIdentity = async (...args) => { args.at(-1)(sensitive); throw new Error(sensitive); };
    if (scenario === 'invalid-profile') f.dependencies.googleIdentity = async () => ({sub:'test-sub', email:sensitive});
    if (scenario === 'storage') f.store.transaction = async () => {throw new Error(sensitive);};
    if (scenario === 'commit') {
      const transaction = f.store.transaction.bind(f.store);
      f.store.transaction = async mutate => {await transaction(mutate); throw new Error(sensitive);};
    }
    const response = await f.call('google/callback?' + query, 'GET', undefined, {headers:scenario === 'missing-cookie' ? {} : {Cookie:scenario === 'invalid-cookie' ? '__Host-brclio_oauth=' + sensitive : cookie}});
    assert.equal(response.status, 302, scenario);
    assert.equal(response.headers.get('Location'), '/account?error=google', scenario);
    assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/);
    assert.deepEqual(events, [{event:'account_google_callback_failed', stage:expected}], scenario);
    assert.ok(!JSON.stringify(events).includes(sensitive));
  }
  const success = fixture(), events = [];
  success.dependencies.accountDiagnostic = value => events.push(value);
  const start = await success.call('google/start');
  const state = new URL(start.headers.get('Location')).searchParams.get('state');
  const completed = await success.call('google/callback?state=' + state + '&code=valid', 'GET', undefined, {headers:{Cookie:start.headers.get('Set-Cookie').split(';')[0]}});
  assert.equal(completed.headers.get('Location'), '/account');
  assert.deepEqual(events, [], 'successful sign-ins do not log identities or request data');
});

test('device polling requires its verifier, explicit authenticated approval, and consumes grant once', async () => {
  const f = fixture(), signed = await f.register(), verifier = random(), challenge = await digest(verifier);
  const started = await (await f.call('device/start', 'POST', {challenge}, {native: true})).json();
  assert.equal(new URL(started.url).searchParams.get('device'), started.id);
  const path = 'device/poll?id=' + started.id + '&verifier=' + verifier;
  assert.deepEqual(await (await f.call(path, 'GET', undefined, {native: true})).json(), {pending: true});
  assert.equal((await f.call('device/poll?id=' + started.id + '&verifier=' + random(), 'GET', undefined, {native: true})).status, 400);
  assert.equal((await f.call('device/approve', 'POST', {id: started.id}, {headers: {Cookie: signed.cookie, 'X-CSRF-Token': signed.csrf}})).status, 200);
  const other = await f.register('other-user', 'other@example.com');
  assert.equal((await f.call('device/approve', 'POST', {id: started.id}, {headers: {Cookie: other.cookie, 'X-CSRF-Token': other.csrf}})).status, 400, 'another account must not replace an approved device identity');
  const token = await (await f.call(path, 'GET', undefined, {native: true})).json(); assert.ok(token.token); assert.equal(token.user.id, signed.user.id);
  assert.equal((await f.call(path, 'GET', undefined, {native: true})).status, 400);
  const bearer = {native: true, headers: {Authorization: 'Bearer ' + token.token}};
  assert.equal((await f.call('logout', 'POST', {}, bearer)).status, 200);
  assert.equal((await (await f.call('session', 'GET', undefined, bearer)).json()).user, null, 'native logout must revoke the issued bearer');
});

test('failed Google callbacks preserve only the device bound to a valid signed OAuth cookie', async () => {
  const f = fixture(), verifier = random();
  const device = await (await f.call('device/start', 'POST', {challenge: await digest(verifier)}, {native: true})).json();
  const start = await f.call('google/start?device=' + device.id);
  const state = new URL(start.headers.get('Location')).searchParams.get('state');
  const oauthCookie = start.headers.get('Set-Cookie').split(';')[0];
  const canceled = await f.call('google/callback?error=access_denied&state=' + state, 'GET', undefined, {headers: {Cookie: oauthCookie}});
  const target = new URL(canceled.headers.get('Location'), 'https://tools.brclio.com');
  assert.equal(target.pathname, '/account');
  assert.equal(target.searchParams.get('error'), 'google');
  assert.equal(target.searchParams.get('device'), device.id);
  assert.match(canceled.headers.get('Set-Cookie'), /Max-Age=0/);
  const forged = await f.call('google/callback?error=access_denied&device=' + device.id, 'GET', undefined, {headers: {Cookie: oauthCookie + 'tampered'}});
  assert.equal(forged.headers.get('Location'), '/account?error=google');
});

test('account storage rejects public repositories before fetching account content', async () => {
  const calls = [];
  const store = createAccountStore({GITHUB_DATA_REPOSITORY: 'owner/public-repo-test', GITHUB_TOKEN: 'not-real'}, async url => { calls.push(url); return Response.json({private: false, default_branch: 'main'}); });
  await assert.rejects(store.snapshot(), /private repository/); assert.equal(calls.length, 1);
});

test('Git compare-and-swap retries a concurrent commit before returning a result', async () => {
  let head = 'old', writes = 0, mutations = 0; const patches = [];
  const store = createAccountStore({GITHUB_DATA_REPOSITORY: 'owner/cas-repo-test', GITHUB_TOKEN: 'not-real'}, async (url, options) => {
    const path = new URL(url).pathname, body = options.body && JSON.parse(options.body);
    if (path.endsWith('/cas-repo-test')) return Response.json({private: true, default_branch: 'main'});
    if (path.endsWith('/git/ref/heads/main')) return Response.json({object: {sha: head}});
    if (path.includes('/contents/')) return new Response(null, {status: 404});
    if (path.includes('/git/commits/')) return Response.json({tree: {sha: 'tree-' + head}});
    if (path.endsWith('/git/trees')) return Response.json({sha: 'new-tree'});
    if (path.endsWith('/git/commits')) return Response.json({sha: 'commit-' + (++writes)});
    if (path.endsWith('/git/refs/heads/main')) { patches.push(body); if (patches.length === 1) { head = 'concurrent'; return new Response(null, {status: 422}); } return Response.json({object: {sha: body.sha}}); }
    throw new Error('Unexpected request ' + path);
  });
  const result = await store.transaction(async tx => { mutations++; const index = await tx.read('users/_index.json', {version: 1}); tx.write('users/_index.json', index); return 'saved'; });
  assert.equal(result, 'saved'); assert.equal(mutations, 2); assert.deepEqual(patches.map(body => body.force), [false, false]);
});

test('Gmail SMTPS uses TLS, authenticates privately, and sends the six digit message', async () => {
  const chunks = ['220 smtp ready\r\n', '250-smtp.gmail.com\r\n250 AUTH PLAIN\r\n', '235 authenticated\r\n', '250 sender\r\n', '250 recipient\r\n', '354 proceed\r\n', '250 accepted\r\n', '221 bye\r\n'];
  const commands = [], encoder = new TextEncoder(); let address, options;
  await sendRegistrationCode({SMTP_EMAIL: 'sender@example.com', SMTP_APP_PASSWORD: 'app pass word'}, 'recipient@example.com', '123456', {connectImpl: (target, config) => {
    address = target; options = config;
    return {opened: Promise.resolve({}), readable: new ReadableStream({pull(controller) { const chunk = chunks.shift(); if (chunk) controller.enqueue(encoder.encode(chunk)); else controller.close(); }}), writable: new WritableStream({write(chunk) {commands.push(new TextDecoder().decode(chunk));}}), close: async () => {}};
  }});
  assert.equal(address.port, 465); assert.equal(options.secureTransport, 'on');
  assert.ok(commands.some(command => command.startsWith('AUTH PLAIN ')));
  const mail = commands.find(command => command.includes('Content-Transfer-Encoding: base64'));
  const encoded = mail.split('\r\n\r\n')[1].replace(/\r\n\.\r\n$/, '').replace(/\r\n/g, '');
  assert.ok(new TextDecoder().decode(Uint8Array.from(atob(encoded), char => char.charCodeAt(0))).includes('123456'));
});

test('Google ID tokens require signature, matching audience and nonce, verified email and future expiration', async () => {
  const pair = await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify']);
  const jwk = {...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'test-google-key', alg: 'RS256', use: 'sig'};
  const encoder = new TextEncoder(), now = Math.floor(Date.now() / 1000);
  const valid = {iss: 'https://accounts.google.com', aud: 'client', sub: 'google-user-1', email: 'verified@example.com', email_verified: true, nonce: 'nonce', iat: now, exp: now + 3600};
  let token;
  const fetchImpl = async url => url.endsWith('/token') ? Response.json({id_token: token}) : Response.json({keys: [jwk]});
  async function signed(claims) {
    const data = encode64(encoder.encode(JSON.stringify({alg: 'RS256', kid: jwk.kid}))) + '.' + encode64(encoder.encode(JSON.stringify(claims)));
    return data + '.' + encode64(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, encoder.encode(data))));
  }
  token = await signed(valid);
  assert.equal((await googleIdentity('code', 'verifier', 'nonce', 'https://tools.brclio.com/api/account/google/callback', {GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret'}, fetchImpl)).email, valid.email);
  for (const invalid of [{...valid, aud: 'another-client'}, {...valid, nonce: 'other-nonce'}, {...valid, email_verified: false}, {...valid, exp: now - 1}]) {
    token = await signed(invalid);
    await assert.rejects(googleIdentity('code', 'verifier', 'nonce', 'https://tools.brclio.com/api/account/google/callback', {GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret'}, fetchImpl), /claims/);
  }
  token = await signed(valid);
  const parts = token.split('.'); parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1); token = parts.join('.');
  await assert.rejects(googleIdentity('code', 'verifier', 'nonce', 'https://tools.brclio.com/api/account/google/callback', {GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret'}, fetchImpl), /signature/);
});

test('actual workerd registers and authenticates with the supported 100000 iteration password hash', async () => {
  const bundled = await build({stdin: {contents: `
    import {handleAccount} from './src/accounts.js';
    const files = new Map(), allowed = {limit: async () => ({success: true})};
    const env = {SESSION_SECRET: 'runtime-test-account-secret-at-least-32-characters', SMTP_EMAIL: 'sender@example.com', SMTP_APP_PASSWORD: 'test-password', ACCOUNT_LIMITER: allowed, ACCOUNT_AUTH_LIMITER: allowed, ACCOUNT_EMAIL_LIMITER: allowed, ACCOUNT_EMAIL_GLOBAL_LIMITER: allowed};
    let code;
    const store = {snapshot: async () => ({read: async (path, fallback = null) => structuredClone(files.has(path) ? files.get(path) : fallback)}), transaction: async mutate => mutate({read: async (path, fallback = null) => structuredClone(files.has(path) ? files.get(path) : fallback), write: (path, value) => files.set(path, structuredClone(value))})};
    const dependencies = {accountStore: store, sendRegistrationCode: async (_env, _email, value) => {code = value;}};
    const request = (path, method = 'GET', data, cookie) => new Request('https://tools.brclio.com/api/account/' + path, {method, headers: {...(method !== 'GET' ? {'Content-Type': 'application/json', Origin: 'https://tools.brclio.com'} : {}), ...(cookie ? {Cookie: cookie} : {})}, ...(data ? {body: JSON.stringify(data)} : {})});
    export default {async fetch() {
      await handleAccount(request('code', 'POST', {email: 'runtime@example.com'}), env, dependencies);
      const response = await handleAccount(request('register', 'POST', {username: 'runtime', email: 'runtime@example.com', password: 'runtime-password', code}), env, dependencies);
      const signed = await response.json();
      const session = await (await handleAccount(request('session', 'GET', undefined, response.headers.get('Set-Cookie').split(';')[0]), env, dependencies)).json();
      const credentials = files.get('users/' + signed.user.id + '/credentials.json');
      return Response.json({status: response.status, username: session.user.username, algorithm: credentials.password.algorithm, iterations: credentials.password.iterations});
    }};
  `, resolveDir: fileURLToPath(new URL('..', import.meta.url)), sourcefile: 'account-runtime-fixture.js'}, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:sockets']});
  const mf = new Miniflare(convertV4MiniflareOptions({modules: true, compatibilityDate: '2026-10-18', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'], script: bundled.outputFiles[0].text}));
  try {
    const response = await mf.dispatchFetch('https://runtime-test.example/');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {status: 200, username: 'runtime', algorithm: 'PBKDF2-SHA256', iterations: 100000});
  } finally { await mf.dispose(); }
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleAccount} from '../src/accounts.js';
import {digest, hashPassword, checkPassword, random, seal} from '../src/accounts-crypto.js';
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
  env.GITHUB_OAUTH_CLIENT_ID = 'github-client';
  env.GITHUB_OAUTH_CLIENT_SECRET = 'github-secret';
  const dependencies = {accountDiagnostic: () => {}, accountStore: store, sendRegistrationCode: async (_env, email, code) => sent.push({email, code}), googleIdentity: async () => ({sub: 'google-test-sub', email: 'google@example.com', emailAuthority: true, name: 'Google User'}), githubIdentity: async () => ({sub: '42', email: 'github@example.com'})};
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
  async function providerSignIn(provider) {
    const finish = await startOAuth({call}, provider);
    const completed = await finish();
    assert.equal(completed.headers.get('Location'), '/account');
    const cookie = completed.headers.getSetCookie().find(value => value.startsWith('__Host-brclio_user=')).split(';')[0];
    const session = await (await call('session', 'GET', undefined, {headers: {Cookie: cookie}})).json();
    return {...session, cookie};
  }
  return {store, env, dependencies, sent, call, register, providerSignIn};
}

async function githubCallback(f, device) {
  const finish = await startOAuth(f, 'github', device ? '?device=' + device : '');
  return finish();
}

async function startOAuth(f, provider, query = '', webCookie = '') {
  const start = await f.call(provider + '/start' + query, 'GET', undefined, {headers: {Cookie: webCookie, 'Sec-Fetch-Site': 'same-origin'}});
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get('Location')).searchParams.get('state');
  const oauthCookie = start.headers.get('Set-Cookie').split(';')[0];
  return (cookie = webCookie) => f.call(provider + '/callback?code=valid&state=' + state, 'GET', undefined, {
    headers: {Cookie: [oauthCookie, cookie].filter(Boolean).join('; ')}
  });
}

function browserLink(f, provider, owner) {
  return startOAuth(f, provider, '?link=1&expectedUserId=' + owner.user.id, owner.cookie);
}

test('registration persists independent readable user folders, plaintext password and hash, consumes code, and signs cookie', async () => {
  const f = fixture(), signed = await f.register();
  assert.match(signed.cookie, /^__Host-brclio_user=/);
  assert.equal(signed.token, undefined);
  assert.equal(signed.user.username, 'alice');
  const records = [...f.store.files];
  assert.deepEqual(records.filter(([path]) => path.startsWith('users/' + signed.user.id + '/')).map(([path]) => path.split('/').at(-1)).sort(), ['credentials.json', 'data.json', 'profile.json']);
  const stored = JSON.stringify(records);
  const credentials = f.store.files.get('users/' + signed.user.id + '/credentials.json');
  assert.equal(credentials.passwordPlaintext, 'my correct password');
  assert.equal(credentials.password.algorithm, 'PBKDF2-SHA256');
  assert.equal(await checkPassword(credentials.passwordPlaintext, credentials.password), true);
  assert.ok(!JSON.stringify(signed).includes('my correct password'), 'plaintext password stays outside public responses');
  assert.ok(Object.keys(credentials.sessions).every(key => /^[A-Za-z0-9_-]{43}$/.test(key)));
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

test('one shared native account accesses isolated Brclio and miniapp data with revision protection', async () => {
  const f = fixture(), signed = await f.register('shared-user', 'shared@example.com', true);
  const headers = {Authorization: 'Bearer ' + signed.token};
  assert.ok(f.store.files.has('users/' + signed.user.id + '/apps/brclio/data.json'));
  assert.equal(f.store.files.has('users/' + signed.user.id + '/data.json'), false);
  assert.equal((await f.call('apps/miniapp/data', 'PUT', {revision: 0, data: {history: []}}, {native: true, headers})).status, 200);
  assert.equal((await f.call('data', 'PUT', {revision: 0, preferences: {quoteMode: 'auto'}}, {native: true, headers})).status, 200);
  const app = await (await f.call('apps/miniapp/data', 'GET', undefined, {native: true, headers})).json();
  assert.equal(app.userId, signed.user.id); assert.deepEqual(app.data, {history: []});
  const copy = await (await f.call('data', 'GET', undefined, {native: true, headers})).json();
  assert.deepEqual(copy.preferences, {quoteMode: 'auto'});
  assert.equal((await f.call('apps/miniapp/data', 'PUT', {revision: 0, data: {history: [1]}}, {native: true, headers})).status, 409);
  await f.call('logout', 'POST', {}, {native: true, headers});
  assert.equal((await f.call('apps/miniapp/data', 'GET', undefined, {native: true, headers})).status, 401);
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

test('profile settings rename the signed account without changing its ID, email or another user', async () => {
  const f = fixture(), alice = await f.register(), bob = await f.register('bobby', 'bob@example.com');
  const beforeBob = structuredClone(f.store.files.get('users/' + bob.user.id + '/profile.json'));
  const beforePaths = [...f.store.files.keys()].sort();
  const response = await f.call('profile', 'PUT', {username:'Alice-Renamed', nickname:'  新昵称  ', userId:bob.user.id}, {headers:{Cookie:alice.cookie, 'X-CSRF-Token':alice.csrf}});
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.user.id, alice.user.id);
  assert.equal(value.user.username, 'Alice-Renamed');
  assert.equal(value.user.nickname, '新昵称');
  assert.equal(value.user.email, 'alice@example.com');
  assert.equal(value.token, undefined); assert.equal(response.headers.get('Set-Cookie'), null);
  assert.deepEqual(f.store.files.get('users/' + bob.user.id + '/profile.json'), beforeBob);
  assert.deepEqual([...f.store.files.keys()].sort(), beforePaths);
  const index = f.store.files.get('users/_index.json');
  assert.equal(index.usernames.alice, undefined);
  assert.equal(index.usernames['alice-renamed'], alice.user.id);
  assert.equal(index.emails['alice@example.com'], alice.user.id);
  assert.equal((await f.call('login', 'POST', {identifier:'alice', password:'my correct password'})).status, 401);
  assert.equal((await f.call('login', 'POST', {identifier:'ALICE-RENAMED', password:'my correct password'})).status, 200);
  const session = await (await f.call('session', 'GET', undefined, {headers:{Cookie:alice.cookie}})).json();
  assert.equal(session.user.id, alice.user.id); assert.equal(session.user.nickname, '新昵称'); assert.equal(session.csrf, alice.csrf);
});

test('concurrent profile changes reserve one case-insensitive username atomically', async () => {
  const f = fixture(), alice = await f.register(), bob = await f.register('bobby', 'bob@example.com');
  const results = await Promise.all([alice, bob].map((account, i) => f.call('profile', 'PUT', {username:i ? 'reserved-name' : 'Reserved-Name', nickname:'Nickname'}, {headers:{Cookie:account.cookie, 'X-CSRF-Token':account.csrf}})));
  assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
  const winner = await results.find(response => response.status === 200).json();
  const index = f.store.files.get('users/_index.json');
  assert.equal(index.usernames['reserved-name'], winner.user.id);
  assert.equal(Object.keys(index.usernames).length, 2);
  for (const account of [alice,bob]) {
    const profile = f.store.files.get('users/' + account.user.id + '/profile.json');
    assert.equal(index.usernames[profile.username.toLowerCase()], account.user.id);
  }
});

test('profile and password settings require authentication, same origin and web CSRF', async () => {
  const f = fixture(), signed = await f.register();
  for (const [path, method, body] of [['profile','PUT',{username:'renamed-user',nickname:'Nickname'}], ['password','POST',{currentPassword:'my correct password',newPassword:'my new password'}]]) {
    assert.equal((await f.call(path, method, body)).status, 401);
    assert.equal((await f.call(path, method, body, {headers:{Cookie:signed.cookie}})).status, 403);
    assert.equal((await f.call(path, method, body, {headers:{Cookie:signed.cookie,'X-CSRF-Token':'wrong'}})).status, 403);
    assert.equal((await f.call(path, method, body, {headers:{Cookie:signed.cookie,'X-CSRF-Token':signed.csrf,Origin:'https://evil.example'}})).status, 403);
  }
  for (const body of [{username:'renamed-user',nickname:'x'.repeat(41)}, {username:'renamed-user',nickname:'bad\nname'}, {username:'x',nickname:'Nickname'}]) {
    assert.equal((await f.call('profile','PUT',body,{headers:{Cookie:signed.cookie,'X-CSRF-Token':signed.csrf}})).status,400);
  }
});

test('password changes verify the old password, synchronize plaintext and hash, retain current bearer and revoke every other session', async () => {
  const f = fixture(), signed = await f.register('alice','alice@example.com',true);
  const webResponse = await f.call('login','POST',{identifier:'alice',password:'my correct password'});
  const webCookie = webResponse.headers.get('Set-Cookie').split(';')[0];
  const other = await (await f.call('login','POST',{identifier:'alice@example.com',password:'my correct password'},{native:true})).json();
  const bob = await f.register('bobby','bob@example.com');
  const bobCredentials = structuredClone(f.store.files.get('users/' + bob.user.id + '/credentials.json'));
  const path = 'users/' + signed.user.id + '/credentials.json';
  const before = structuredClone(f.store.files.get(path));
  const bearer = {native:true,headers:{Authorization:'Bearer ' + signed.token}};
  for (const currentPassword of [undefined, 'wrong password']) {
    const body = {newPassword:'brand new password', ...(currentPassword === undefined ? {} : {currentPassword})};
    assert.equal((await f.call('password','POST',body,bearer)).status,401);
    assert.deepEqual(f.store.files.get(path),before);
  }
  const changed = await f.call('password','POST',{currentPassword:'my correct password',newPassword:'brand new password',userId:bob.user.id},bearer);
  assert.equal(changed.status,200); assert.equal(changed.headers.get('Set-Cookie'),null);
  const value = await changed.json();
  assert.deepEqual(value,{ok:true,passwordEnabled:true});
  assert.ok(!JSON.stringify(value).includes('brand new password'));
  const credentials = f.store.files.get(path);
  assert.equal(credentials.passwordPlaintext,'brand new password');
  assert.equal(await checkPassword('brand new password',credentials.password),true);
  assert.equal(await checkPassword('my correct password',credentials.password),false);
  assert.equal(Object.keys(credentials.sessions).length,1);
  assert.ok(!JSON.stringify(credentials).includes(signed.token));
  assert.deepEqual(f.store.files.get('users/' + bob.user.id + '/credentials.json'),bobCredentials);
  const retained = await (await f.call('session','GET',undefined,bearer)).json();
  assert.equal(retained.user.id,signed.user.id); assert.equal(retained.csrf,signed.csrf); assert.equal(retained.passwordEnabled,true);
  assert.equal((await (await f.call('session','GET',undefined,{headers:{Cookie:webCookie}})).json()).user,null);
  assert.equal((await (await f.call('session','GET',undefined,{native:true,headers:{Authorization:'Bearer ' + other.token}})).json()).user,null);
  assert.equal((await f.call('login','POST',{identifier:'alice',password:'my correct password'})).status,401);
  assert.equal((await f.call('login','POST',{identifier:'alice@example.com',password:'brand new password'})).status,200);
});

test('Google-only accounts set nickname, username and their first password while preserving Google identity and current web session', async () => {
  const f = fixture(), signed = await f.providerSignIn('google');
  assert.equal(signed.passwordEnabled,false);
  const path = 'users/' + signed.user.id + '/credentials.json';
  assert.equal(f.store.files.get(path).password,null);
  const auth = {headers:{Cookie:signed.cookie,'X-CSRF-Token':signed.csrf}};
  const renamed = await f.call('profile','PUT',{username:'google-custom',nickname:'谷歌昵称'},auth);
  assert.equal(renamed.status,200); assert.equal((await renamed.json()).user.id,signed.user.id);
  const response = await f.call('password','POST',{newPassword:'my first password'},auth);
  assert.equal(response.status,200); assert.equal(response.headers.get('Set-Cookie'),null);
  assert.deepEqual(await response.json(),{ok:true,passwordEnabled:true});
  const credentials = f.store.files.get(path);
  assert.equal(credentials.googleSub,'google-test-sub');
  assert.equal(credentials.passwordPlaintext,'my first password');
  assert.equal(await checkPassword('my first password',credentials.password),true);
  const session = await (await f.call('session','GET',undefined,{headers:{Cookie:signed.cookie}})).json();
  assert.equal(session.user.id,signed.user.id); assert.equal(session.user.username,'google-custom'); assert.equal(session.user.nickname,'谷歌昵称');
  assert.deepEqual(session.user.providers.sort(),['google','password']); assert.equal(session.passwordEnabled,true); assert.equal(session.csrf,signed.csrf);
  assert.equal((await f.call('login','POST',{identifier:'google-custom',password:'my first password'})).status,200);
  assert.equal((await f.call('login','POST',{identifier:'google@example.com',password:'my first password'})).status,200);
});

test('a successful legacy password login backfills plaintext without changing its existing hash or exposing it publicly', async () => {
  const f = fixture(), signed = await f.register();
  const path = 'users/' + signed.user.id + '/credentials.json';
  delete f.store.files.get(path).passwordPlaintext;
  const previousHash = f.store.files.get(path).password.hash;
  assert.equal((await f.call('login','POST',{identifier:'alice',password:'wrong password'})).status,401);
  assert.equal(f.store.files.get(path).passwordPlaintext,undefined);
  const success = await f.call('login','POST',{identifier:'alice',password:'my correct password'});
  assert.equal(success.status,200); assert.ok(!JSON.stringify(await success.json()).includes('my correct password'));
  assert.equal(f.store.files.get(path).password.hash,previousHash);
  assert.equal(f.store.files.get(path).passwordPlaintext,'my correct password');
});

test('both Google and password emails return EMAIL_EXISTS409 for code requests and repeated registration without sending mail', async () => {
  for (const provider of ['google','password']) {
    const f = fixture();
    const account = provider === 'google' ? await f.providerSignIn('google') : await f.register();
    const beforeIndex = structuredClone(f.store.files.get('users/_index.json'));
    const sentCount = f.sent.length;
    for (const [path,body] of [['code',{email:account.user.email}],['register',{username:'another-user',email:account.user.email,code:'123456',password:'other valid password'}]]) {
      const response = await f.call(path,'POST',body);
      assert.equal(response.status,409,provider + ':' + path);
      const value = await response.json(); assert.equal(value.code,'EMAIL_EXISTS'); assert.match(value.error,/账号设置/);
      assert.ok(!JSON.stringify(value).includes('other valid password'));
    }
    assert.equal(f.sent.length,sentCount);
    assert.deepEqual(f.store.files.get('users/_index.json'),beforeIndex);
  }
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

test('a Google-authoritative email links the existing password account and preserves its user folder and password', async () => {
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

test('a third-party Google email needs mailbox proof for its first signup or automatic link', async () => {
  const f = fixture(), existing = await f.register();
  const device = await (await f.call('device/start', 'POST', {challenge: await digest(random())}, {native: true})).json();
  const before = structuredClone([...f.store.files]);
  for (const email of ['new@example.com', existing.user.email]) {
    f.dependencies.googleIdentity = async () => ({sub: 'third-party', email, emailAuthority: false});
    const finish = await startOAuth(f, 'google', '?device=' + device.id, existing.cookie);
    const result = await finish();
    assert.equal(result.headers.get('Location'), '/account?error=google_email_proof&device=' + device.id);
    assert.ok(result.headers.getSetCookie().every(value => !value.startsWith('__Host-brclio_user=')));
    assert.deepEqual([...f.store.files], before);
  }
});

test('Google explicit linking keeps the original verified web account and its session', async () => {
  const f = fixture(), owner = await f.register();
  const identity = {sub: 'third-party', email: owner.user.email, emailAuthority: false};
  f.dependencies.googleIdentity = async () => identity;
  const path = 'users/' + owner.user.id + '/credentials.json';
  const sessions = structuredClone(f.store.files.get(path).sessions);
  const expiredCookie = await seal({typ: 'account', id: owner.user.id, exp: Math.floor(Date.now() / 1000) - 1}, f.env.SESSION_SECRET);
  for (const cookie of ['', '__Host-brclio_user=' + expiredCookie]) {
    const signIn = await f.call('google/start?link=1', 'GET', undefined, {headers: {Cookie: cookie}});
    assert.equal(signIn.status, 302);
    assert.equal(signIn.headers.get('Location'), '/account?error=google_email_proof');
    assert.equal(signIn.headers.has('Set-Cookie'), false);
  }
  const native = await f.call('login', 'POST', {identifier: owner.user.username, password: 'my correct password'}, {native: true});
  const token = (await native.json()).token;
  assert.equal((await f.call('google/start?link=1', 'GET', undefined, {headers: {Authorization: 'Bearer ' + token}})).status, 401);
  const finish = await startOAuth(f, 'google', '?link=1', owner.cookie);
  const before = structuredClone(f.store.files.get(path).sessions);
  const result = await finish();
  assert.equal(result.headers.get('Location'), '/account');
  assert.ok(result.headers.getSetCookie().every(value => !value.startsWith('__Host-brclio_user=')));
  assert.deepEqual(f.store.files.get(path).sessions, before);
  assert.ok(Object.keys(sessions).every(key => before[key]));
  const web = await (await f.call('session', 'GET', undefined, {headers: {Cookie: owner.cookie}})).json();
  assert.equal(web.csrf, owner.csrf); assert.deepEqual(web.user.providers, ['password', 'google']);

  // An ordinary Google authorization started by a previous Worker version
  // has no link metadata. A previously associated sub remains sufficient.
  identity.email = 'changed-outside-brclio@example.com';
  const oldState = random();
  const oldCookie = await seal({typ: 'google', state: oldState, nonce: random(), verifier: random(), device: null,
    exp: Math.floor(Date.now() / 1000) + 60}, f.env.SESSION_SECRET);
  const again = await f.call('google/callback?code=valid&state=' + oldState, 'GET', undefined, {headers: {Cookie: '__Host-brclio_oauth=' + oldCookie}});
  assert.equal(again.headers.get('Location'), '/account');
  const returnedCookie = again.headers.getSetCookie().find(value => value.startsWith('__Host-brclio_user=')).split(';')[0];
  const returned = await (await f.call('session', 'GET', undefined, {headers: {Cookie: returnedCookie}})).json();
  assert.equal(returned.user.id, owner.user.id); assert.equal(returned.user.email, owner.user.email);
});

test('Google explicit linking rejects a changed account, session, email or provider binding', async () => {
  const f = fixture(), owner = await f.register(), other = await f.providerSignIn('google');
  const anotherLogin = await f.call('login', 'POST', {identifier: owner.user.username, password: 'my correct password'});
  const sameAccountDifferentSession = anotherLogin.headers.get('Set-Cookie').split(';')[0];
  const identity = {sub: 'unbound', email: owner.user.email, emailAuthority: false};
  f.dependencies.googleIdentity = async () => identity;
  const before = structuredClone([...f.store.files]);
  const finish = await startOAuth(f, 'google', '?link=1', owner.cookie);
  for (const cookie of ['', other.cookie, sameAccountDifferentSession]) {
    assert.equal((await finish(cookie)).headers.get('Location'), '/account?error=google_email_proof');
  }
  identity.email = other.user.email;
  assert.equal((await finish()).headers.get('Location'), '/account?error=google_email_proof');
  identity.sub = 'google-test-sub'; identity.email = owner.user.email;
  assert.equal((await finish()).headers.get('Location'), '/account?error=google_email_proof');
  assert.deepEqual([...f.store.files], before);

  // The browser session is valid when the callback arrives and revoked
  // before the account-link transaction begins.
  f.dependencies.googleIdentity = async () => {
    assert.equal((await f.call('logout', 'POST', {}, {headers: {Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf}})).status, 200);
    return {...identity, sub: 'unbound'};
  };
  const revoked = await finish();
  assert.equal(revoked.headers.get('Location'), '/account?error=google_email_proof');
  assert.equal(f.store.files.get('users/_index.json').google.unbound, undefined);
});

for (const first of ['password', 'google', 'github']) {
  test(`an account created with ${first} can add the other two methods and sign back into the same data`, async () => {
    const f = fixture();
    const owner = first === 'password' ? await f.register() : await f.providerSignIn(first);
    const auth = {headers: {Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf}};
    const preferences = {separator: 'forward'};
    assert.equal((await f.call('data', 'PUT', {preferences}, auth)).status, 200);
    const data = await (await f.call('data', 'GET', undefined, auth)).json();
    const password = 'my correct password';
    if (first !== 'password') {
      assert.equal((await f.call('password', 'POST', {newPassword: password}, auth)).status, 200);
    }
    for (const provider of ['google', 'github'].filter(provider => provider !== first)) {
      const finish = await browserLink(f, provider, owner);
      const result = await finish();
      assert.equal(result.headers.get('Location'), '/account?linked=' + provider);
      assert.ok(result.headers.getSetCookie().every(cookie => !cookie.startsWith('__Host-brclio_user=')));
    }
    const linked = await (await f.call('session', 'GET', undefined, auth)).json();
    assert.equal(linked.csrf, owner.csrf);
    assert.equal(linked.user.email, owner.user.email);
    assert.deepEqual(linked.user.providers.sort(), ['github', 'google', 'password']);
    assert.deepEqual(f.store.files.get('users/_index.json').emails, {[owner.user.email]: owner.user.id});
    const passwordLogin = await f.call('login', 'POST', {identifier: owner.user.email, password});
    assert.equal(passwordLogin.status, 200);
    assert.equal((await passwordLogin.json()).user.id, owner.user.id);
    for (const provider of ['google', 'github']) {
      const again = await f.providerSignIn(provider);
      assert.equal(again.user.id, owner.user.id);
      assert.equal(again.user.email, owner.user.email);
      assert.deepEqual(await (await f.call('data', 'GET', undefined, {headers: {Cookie: again.cookie}})).json(), data);
    }
    assert.equal([...f.store.files.keys()].filter(path => path.endsWith('/profile.json')).length, 1);
  });
}

test('explicit GitHub binding keeps provider IDs unique and preserves other accounts', async () => {
  const f = fixture(), owner = await f.register(), other = await f.providerSignIn('github');
  const identity = {sub: '42', email: owner.user.email};
  f.dependencies.githubIdentity = async () => identity;
  const finish = await browserLink(f, 'github', owner);
  const before = structuredClone([...f.store.files]);
  for (const candidate of [
    {sub: '42', email: owner.user.email},
    {sub: '43', email: other.user.email}
  ]) {
    Object.assign(identity, candidate);
    assert.equal((await finish()).headers.get('Location'), '/account?error=github_link');
    assert.deepEqual([...f.store.files], before);
  }
  identity.email = 'additional@example.com';
  assert.equal((await finish(other.cookie)).headers.get('Location'), '/account?error=github_link');
  assert.deepEqual([...f.store.files], before);
  assert.equal((await finish()).headers.get('Location'), '/account?linked=github');
  const after = structuredClone([...f.store.files]);
  identity.sub = '44';
  const replacement = await browserLink(f, 'github', owner);
  assert.equal((await replacement()).headers.get('Location'), '/account?error=github_link');
  assert.deepEqual([...f.store.files], after);
});

test('the web binding starts only from the account page origin and for the signed-in page user', async () => {
  const f = fixture(), owner = await f.register(), other = await f.providerSignIn('github');
  for (const provider of ['github', 'google']) {
    const start = (id, headers) => f.call(provider + '/start?link=1&expectedUserId=' + id, 'GET', undefined, {
      headers: {Cookie: owner.cookie, ...headers}
    });
    for (const headers of [{}, {'Sec-Fetch-Site': 'cross-site'}, {Referer: 'https://other.example/'}]) {
      const response = await start(owner.user.id, headers);
      assert.equal(response.status, 403);
      assert.equal(response.headers.has('Set-Cookie'), false);
    }
    const stalePage = await start(other.user.id, {'Sec-Fetch-Site': 'same-origin'});
    assert.equal(stalePage.headers.has('Set-Cookie'), false);
    assert.equal((stalePage.headers.get('Location') || '').startsWith('https://'), false);
    const success = await start(owner.user.id, {Referer: 'https://tools.brclio.com/account'});
    assert.equal(success.status, 302);
    assert.ok(success.headers.has('Set-Cookie'));
  }
});

test('GitHub configuration is independent of Google and repository access credentials', async () => {
  const f = fixture(), challenge = await digest(random());
  f.env.GITHUB_APP_ID = 'repository-app';
  delete f.env.GITHUB_OAUTH_CLIENT_SECRET;
  assert.equal((await (await f.call('session')).json()).githubEnabled, false);
  assert.equal((await f.call('github/start')).status, 503);
  assert.equal((await f.call('device/start', 'POST', {provider: 'github', challenge}, {native: true})).status, 503);
  const legacy = await (await f.call('device/start', 'POST', {challenge}, {native: true})).json();
  assert.equal(new URL(legacy.url).pathname, '/api/account/google/start');
  assert.equal((await f.call('device/start', 'POST', {provider: 'unsupported', challenge}, {native: true})).status, 400);
  delete f.env.GOOGLE_CLIENT_SECRET;
  f.env.GITHUB_OAUTH_CLIENT_SECRET = 'github-secret';
  const available = await (await f.call('session')).json();
  assert.equal(available.githubEnabled, true);
  assert.equal(available.googleEnabled, false);
});

test('GitHub OAuth uses provider-bound state, PKCE and verified-email access', async () => {
  const f = fixture(), github = await f.call('github/start'), google = await f.call('google/start');
  const location = new URL(github.headers.get('Location'));
  assert.equal(location.origin + location.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(location.searchParams.get('scope'), 'user:email');
  assert.equal(location.searchParams.get('client_id'), 'github-client');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(location.searchParams.get('redirect_uri'), 'https://tools.brclio.com/api/account/github/callback');
  const state = location.searchParams.get('state');
  const githubCookie = github.headers.get('Set-Cookie').split(';')[0];
  const googleCookie = google.headers.get('Set-Cookie').split(';')[0];
  let exchanges = 0;
  f.dependencies.githubIdentity = async (code, verifier, redirectUri) => {
    exchanges++;
    assert.equal(code, 'valid'); assert.equal(await digest(verifier), location.searchParams.get('code_challenge'));
    assert.equal(redirectUri, location.searchParams.get('redirect_uri'));
    return {sub: '42', email: 'github@example.com'};
  };
  const callback = (params, cookie) => f.call('github/callback?' + params, 'GET', undefined, {headers: {Cookie: cookie}});
  const wrongProvider = googleCookie.replace('__Host-brclio_oauth=', '__Host-brclio_github_oauth=');
  for (const [params, cookie] of [
    ['state=' + state + '&code=valid', googleCookie],
    ['state=' + new URL(google.headers.get('Location')).searchParams.get('state') + '&code=valid', wrongProvider],
    ['state=other&code=valid', githubCookie],
    ['state=' + state + '&error=access_denied', githubCookie]
  ]) {
    assert.equal((await callback(params, cookie)).headers.get('Location'), '/account?error=github');
  }
  assert.equal(exchanges, 0);
  const complete = await callback('state=' + state + '&code=valid', githubCookie);
  assert.equal(complete.headers.get('Location'), '/account');
  assert.equal(exchanges, 1);
  assert.match(complete.headers.get('Set-Cookie'), /__Host-brclio_github_oauth=; Path=\/; Max-Age=0/);
  const id = f.store.files.get('users/_index.json').github['42'];
  assert.deepEqual(f.store.files.get('users/' + id + '/profile.json').providers, ['github']);
  assert.equal(f.store.files.get('users/' + id + '/credentials.json').githubSub, '42');
  assert.ok(f.store.files.has('users/' + id + '/apps/brclio/data.json'));
});

test('GitHub links a verified legacy account once and preserves its identity when the primary email changes', async () => {
  const f = fixture(), existing = await f.register(), other = await f.register('bobby', 'bob@example.com');
  delete f.store.files.get('users/_index.json').github;
  const github = {sub: '42', email: existing.user.email};
  f.dependencies.githubIdentity = async () => github;
  const linked = await githubCallback(f);
  assert.equal(linked.headers.get('Location'), '/account');
  const profiles = id => f.store.files.get('users/' + id + '/profile.json');
  assert.deepEqual(profiles(existing.user.id).providers, ['password', 'github']);
  assert.equal(f.store.files.get('users/_index.json').github['42'], existing.user.id);
  assert.equal((await f.call('login', 'POST', {identifier: 'alice', password: 'my correct password'})).status, 200);
  github.email = other.user.email;
  const returned = await githubCallback(f);
  const cookie = returned.headers.getSetCookie().find(value => value.startsWith('__Host-brclio_user=')).split(';')[0];
  const {user} = await (await f.call('session', 'GET', undefined, {headers: {Cookie: cookie}})).json();
  assert.equal(user.id, existing.user.id); assert.equal(user.email, existing.user.email);
  assert.deepEqual(profiles(other.user.id).providers, ['password']);
  github.email = existing.user.email; github.sub = '43';
  const before = structuredClone([...f.store.files]);
  assert.equal((await githubCallback(f)).headers.get('Location'), '/account?error=github');
  assert.deepEqual([...f.store.files], before);
});

test('GitHub browser authorization preserves the device and requires explicit approval before native login', async () => {
  const f = fixture(), verifier = random(), challenge = await digest(verifier);
  const device = await (await f.call('device/start', 'POST', {provider: 'github', challenge}, {native: true})).json();
  assert.equal(new URL(device.url).pathname, '/api/account/github/start');
  assert.equal(new URL(device.url).searchParams.get('device'), device.id);
  const start = await f.call('github/start?device=' + device.id);
  const state = new URL(start.headers.get('Location')).searchParams.get('state');
  const cancel = await f.call('github/callback?state=' + state + '&error=access_denied', 'GET', undefined, {
    headers: {Cookie: start.headers.get('Set-Cookie').split(';')[0]}
  });
  assert.equal(cancel.headers.get('Location'), '/account?error=github&device=' + device.id);
  const forged = await f.call('github/callback?state=' + state + '&error=access_denied&device=' + device.id);
  assert.equal(forged.headers.get('Location'), '/account?error=github');
  const ready = await githubCallback(f, device.id);
  assert.equal(ready.headers.get('Location'), '/account?device=' + device.id);
  const poll = () => f.call('device/poll?id=' + device.id + '&verifier=' + verifier, 'GET', undefined, {native: true});
  assert.deepEqual(await (await poll()).json(), {pending: true});
  const cookie = ready.headers.getSetCookie().find(value => value.startsWith('__Host-brclio_user=')).split(';')[0];
  const session = await (await f.call('session', 'GET', undefined, {headers: {Cookie: cookie}})).json();
  assert.equal((await f.call('device/approve', 'POST', {id: device.id}, {headers: {Cookie: cookie, 'X-CSRF-Token': session.csrf}})).status, 200);
  const authenticated = await (await poll()).json();
  assert.ok(authenticated.token); assert.deepEqual(authenticated.user.providers, ['github']);
  assert.equal((await poll()).status, 400);
});

async function nativeLink(f, owner, provider) {
  const verifier = random(), challenge = await digest(verifier);
  const auth = {native: true, headers: {Authorization: 'Bearer ' + owner.token}};
  const start = await f.call('device/link/start', 'POST', {provider, challenge, expectedUserId: owner.user.id}, auth);
  assert.equal(start.status, 200);
  const {id, url} = await start.json();
  assert.equal(new URL(url).pathname, '/api/account/' + provider + '/start');
  const query = new URL(url).search;
  assert.equal(new URLSearchParams(query).get('device'), id);
  assert.equal(Object.hasOwn(f.store.files.get('users/_index.json').devices, id), false);
  const finish = await startOAuth(f, provider, query);
  const poll = (options = auth, proof = verifier) => f.call('device/poll?id=' + id + '&verifier=' + proof, 'GET', undefined, options);
  const confirm = (options = auth, proof = verifier) => f.call('device/link', 'POST', {id, verifier: proof}, options);
  return {id, finish, poll, confirm};
}

for (const provider of ['google', 'github']) {
  test(`native ${provider} binding requires confirmation by the initiating session and preserves its bearer`, async () => {
    const f = fixture(), owner = await f.register('owner', 'owner@example.com', true);
    const other = await f.register('other-user', 'other@example.com');
    const otherWeb = {headers: {Cookie: other.cookie, 'X-CSRF-Token': other.csrf}};
    const secondSession = await (await f.call('login', 'POST', {identifier: owner.user.email, password: 'my correct password'}, {native: true})).json();
    const sameUserOtherBearer = {native: true, headers: {Authorization: 'Bearer ' + secondSession.token}};
    const credentials = () => f.store.files.get('users/' + owner.user.id + '/credentials.json');
    const grants = structuredClone(credentials().sessions);
    const pending = await nativeLink(f, owner, provider);
    assert.deepEqual(await (await pending.poll()).json(), {pending: true});
    assert.ok((await pending.confirm()).status >= 400);
    const returned = await pending.finish(other.cookie);
    assert.equal(returned.headers.get('Location'), '/account?link_device=ready');
    assert.ok(returned.headers.getSetCookie().every(cookie => !cookie.startsWith('__Host-brclio_user=')));
    const identity = await f.dependencies[provider + 'Identity']();
    assert.deepEqual(await (await pending.poll()).json(), {pending: false, linkReady: true, provider, email: identity.email});
    assert.ok((await f.call('device/approve', 'POST', {id: pending.id}, otherWeb)).status >= 400);
    for (const invalidAuth of [{native: true}, sameUserOtherBearer, otherWeb]) {
      assert.ok((await pending.poll(invalidAuth)).status >= 400);
      assert.ok((await pending.confirm(invalidAuth)).status >= 400);
    }
    assert.ok((await pending.poll(undefined, random())).status >= 400);
    assert.ok((await pending.confirm(undefined, random())).status >= 400);
    const bearer = {native: true, headers: {Authorization: 'Bearer ' + owner.token}};
    const before = await (await f.call('session', 'GET', undefined, bearer)).json();
    assert.deepEqual(before.user.providers, ['password']);
    const confirmed = await pending.confirm();
    assert.equal(confirmed.status, 200);
    const after = await (await f.call('session', 'GET', undefined, bearer)).json();
    assert.deepEqual(await confirmed.json(), {ok: true, user: after.user});
    assert.equal(confirmed.headers.has('Set-Cookie'), false);
    assert.deepEqual(after.user.providers.sort(), ['password', provider].sort());
    assert.equal(after.user.id, owner.user.id);
    assert.equal(after.user.email, owner.user.email);
    assert.equal(after.csrf, before.csrf);
    assert.deepEqual(credentials().sessions, grants);
    assert.equal((await f.providerSignIn(provider)).user.id, owner.user.id);
    assert.ok((await pending.confirm()).status >= 400);
    assert.ok((await pending.poll()).status >= 400);
    assert.deepEqual((await (await f.call('session', 'GET', undefined, otherWeb)).json()).user, other.user);
  });
}

test('native binding validates the expected user on start and requires the original active session at confirmation', async () => {
  const f = fixture(), owner = await f.register('owner', 'owner@example.com', true);
  const other = await f.register('other-user', 'other@example.com');
  const bearer = {native: true, headers: {Authorization: 'Bearer ' + owner.token}};
  const params = {provider: 'github', challenge: await digest(random()), expectedUserId: owner.user.id};
  assert.ok((await f.call('device/link/start', 'POST', params, {native: true})).status >= 400);
  assert.ok((await f.call('device/link/start', 'POST', {...params, expectedUserId: other.user.id}, bearer)).status >= 400);
  const pending = await nativeLink(f, owner, 'github');
  assert.equal((await pending.finish()).headers.get('Location'), '/account?link_device=ready');
  assert.equal((await f.call('logout', 'POST', {}, bearer)).status, 200);
  assert.ok((await pending.confirm()).status >= 400);
  assert.equal(f.store.files.get('users/_index.json').github['42'], undefined);
  assert.deepEqual(f.store.files.get('users/' + owner.user.id + '/profile.json').providers, ['password']);
});

test('native confirmation leaves a GitHub identity with its existing account if it was claimed while awaiting confirmation', async () => {
  const f = fixture(), owner = await f.register('owner', 'owner@example.com', true);
  const pending = await nativeLink(f, owner, 'github');
  assert.equal((await pending.finish()).headers.get('Location'), '/account?link_device=ready');
  const other = await f.providerSignIn('github');
  assert.notEqual(other.user.id, owner.user.id);
  assert.ok((await pending.confirm()).status >= 400);
  const index = f.store.files.get('users/_index.json');
  assert.equal(index.github['42'], other.user.id);
  assert.deepEqual(f.store.files.get('users/' + owner.user.id + '/profile.json').providers, ['password']);
  assert.deepEqual(f.store.files.get('users/' + other.user.id + '/profile.json').providers, ['github']);
  const retry = await nativeLink(f, owner, 'github');
  assert.equal((await retry.finish()).headers.get('Location'), '/account?link_device=error');
  const conflict = await retry.poll();
  assert.equal(conflict.status, 409);
  assert.match((await conflict.json()).error, /关联冲突/);
});

test('returning from a second provider selection cannot change the GitHub identity shown for native confirmation', async () => {
  const f = fixture(), owner = await f.register('owner', 'owner@example.com', true);
  const pending = await nativeLink(f, owner, 'github');
  const secondSelection = await startOAuth(f, 'github', '?device=' + pending.id);
  assert.equal((await pending.finish()).headers.get('Location'), '/account?link_device=ready');
  const displayed = await (await pending.poll()).json();
  f.dependencies.githubIdentity = async () => ({sub: '43', email: 'second-choice@example.com'});
  assert.equal((await secondSelection()).headers.get('Location'), '/account?link_device=error');
  assert.deepEqual(await (await pending.poll()).json(), displayed);
  assert.equal((await pending.confirm()).status, 200);
  assert.deepEqual(f.store.files.get('users/_index.json').github, {'42': owner.user.id});
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

test('password changes revoke approved device grants while preserving other users and unapproved requests', async () => {
  const f = fixture(), alice = await f.register(), bob = await f.register('bobby', 'bob@example.com');
  const login = await f.call('login', 'POST', {identifier: 'alice', password: 'my correct password'});
  assert.equal(login.status, 200);
  const oldAlice = {headers: {Cookie: login.headers.get('Set-Cookie').split(';')[0], 'X-CSRF-Token': (await login.json()).csrf}};
  const bobAuth = {headers: {Cookie: bob.cookie, 'X-CSRF-Token': bob.csrf}};
  async function device(auth) {
    const verifier = random();
    const started = await (await f.call('device/start', 'POST', {challenge: await digest(verifier)}, {native: true})).json();
    if (auth) assert.equal((await f.call('device/approve', 'POST', {id: started.id}, auth)).status, 200);
    return {...started, poll: 'device/poll?id=' + started.id + '&verifier=' + verifier};
  }
  const approvedAlice = await device(oldAlice), approvedBob = await device(bobAuth), pending = await device();
  const beforeDevices = structuredClone(f.store.files.get('users/_index.json').devices);
  const bobRecords = () => [...f.store.files].filter(([path]) => path.startsWith('users/' + bob.user.id + '/'));
  const beforeBob = structuredClone(bobRecords());
  const changed = await f.call('password', 'POST', {currentPassword: 'my correct password', newPassword: 'new correct password'},
    {headers: {Cookie: alice.cookie, 'X-CSRF-Token': alice.csrf}});
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), {ok: true, passwordEnabled: true});
  assert.equal((await (await f.call('session', 'GET', undefined, oldAlice)).json()).user, null);
  const current = await (await f.call('session', 'GET', undefined, {headers: {Cookie: alice.cookie}})).json();
  assert.equal(current.user.id, alice.user.id);
  assert.equal(current.csrf, alice.csrf);
  const afterDevices = f.store.files.get('users/_index.json').devices;
  assert.equal(afterDevices[approvedAlice.id], undefined);
  assert.deepEqual(afterDevices[approvedBob.id], beforeDevices[approvedBob.id]);
  assert.deepEqual(afterDevices[pending.id], beforeDevices[pending.id]);
  assert.deepEqual(bobRecords(), beforeBob);
  const rejected = await f.call(approvedAlice.poll, 'GET', undefined, {native: true});
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).token, undefined);
  assert.deepEqual(await (await f.call(pending.poll, 'GET', undefined, {native: true})).json(), {pending: true});
  const bobGrant = await f.call(approvedBob.poll, 'GET', undefined, {native: true});
  assert.equal(bobGrant.status, 200);
  assert.equal((await bobGrant.json()).user.id, bob.user.id);
});

test('device approval rechecks a revoked session when a password change commits after authentication', {timeout: 5000}, async () => {
  const f = fixture(), alice = await f.register();
  const login = await f.call('login', 'POST', {identifier: 'alice', password: 'my correct password'});
  assert.equal(login.status, 200);
  const oldAlice = {headers: {Cookie: login.headers.get('Set-Cookie').split(';')[0], 'X-CSRF-Token': (await login.json()).csrf}};
  const verifier = random();
  const device = await (await f.call('device/start', 'POST', {challenge: await digest(verifier)}, {native: true})).json();
  const beforeDevice = structuredClone(f.store.files.get('users/_index.json').devices[device.id]);
  const transaction = f.store.transaction.bind(f.store);
  let pauseNext = true, entered, release;
  const paused = new Promise(resolve => { entered = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  f.store.transaction = async mutate => {
    if (pauseNext) { pauseNext = false; entered(); await resume; }
    return transaction(mutate);
  };
  // Pause after authenticate succeeds, before the approval transaction reads current credentials.
  const approving = f.call('device/approve', 'POST', {id: device.id}, oldAlice);
  try {
    await paused;
    const changed = await f.call('password', 'POST', {currentPassword: 'my correct password', newPassword: 'new correct password'},
      {headers: {Cookie: alice.cookie, 'X-CSRF-Token': alice.csrf}});
    assert.equal(changed.status, 200);
    assert.equal((await (await f.call('session', 'GET', undefined, oldAlice)).json()).user, null);
    release();
    const rejected = await approving;
    assert.equal(rejected.status, 401);
    assert.deepEqual(f.store.files.get('users/_index.json').devices[device.id], beforeDevice);
    const polled = await f.call('device/poll?id=' + device.id + '&verifier=' + verifier, 'GET', undefined, {native: true});
    assert.equal(polled.status, 200);
    assert.deepEqual(await polled.json(), {pending: true});
  } finally {
    release();
    await approving.catch(() => {});
    f.store.transaction = transaction;
  }
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
  const store = createAccountStore({GITHUB_DATA_REPOSITORY: 'owner/public-repo-test'}, async url => { calls.push(url); return Response.json({private: false, default_branch: 'main'}); }, async () => 'fixture-installation-token');
  await assert.rejects(store.snapshot(), /private repository/); assert.equal(calls.length, 1);
});

test('Git compare-and-swap retries a concurrent commit before returning a result', async () => {
  let head = 'old', writes = 0, mutations = 0; const patches = [];
  const store = createAccountStore({GITHUB_DATA_REPOSITORY: 'owner/cas-repo-test'}, async (url, options) => {
    const path = new URL(url).pathname, body = options.body && JSON.parse(options.body);
    if (path.endsWith('/cas-repo-test')) return Response.json({private: true, default_branch: 'main'});
    if (path.endsWith('/git/ref/heads/main')) return Response.json({object: {sha: head}});
    if (path.includes('/contents/')) return new Response(null, {status: 404});
    if (path.includes('/git/commits/')) return Response.json({tree: {sha: 'tree-' + head}});
    if (path.endsWith('/git/trees')) return Response.json({sha: 'new-tree'});
    if (path.endsWith('/git/commits')) return Response.json({sha: 'commit-' + (++writes)});
    if (path.endsWith('/git/refs/heads/main')) { patches.push(body); if (patches.length === 1) { head = 'concurrent'; return new Response(null, {status: 422}); } return Response.json({object: {sha: body.sha}}); }
    throw new Error('Unexpected request ' + path);
  }, async () => 'fixture-installation-token');
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
  for (const [emailClaims, authority] of [[{}, false], [{hd: ' '}, false], [{hd: true}, false],
    [{hd: 'example.com'}, true], [{email: 'verified@GMAIL.COM'}, true], [{email: 'verified@gmail.com.example'}, false]]) {
    token = await signed({...valid, ...emailClaims});
    const identity = await googleIdentity('code', 'verifier', 'nonce', 'https://tools.brclio.com/api/account/google/callback', {GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret'}, fetchImpl);
    assert.equal(identity.email, emailClaims.email || valid.email);
    assert.equal(identity.emailAuthority, authority);
  }
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

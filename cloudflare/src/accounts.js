import {json, readJSON, rateLimit} from './http.js';
import {sameOrigin, safeEqual} from './auth.js';
import {createAccountStore, emptyAccountIndex, userPath} from './account-store.js';
import {random, digest, seal, unseal, hashPassword, checkPassword} from './accounts-crypto.js';
import {googleIdentity} from './accounts-google.js';
import {sendRegistrationCode} from './mail.js';

const COOKIE = '__Host-brclio_user', OAUTH_COOKIE = '__Host-brclio_oauth';
const WEB_LIFETIME = 7 * 86400, NATIVE_LIFETIME = 30 * 86400;
const CODE_LIFETIME = 600000, DEVICE_LIFETIME = 300000;
const GOOGLE_DIAGNOSTIC_STAGES = new Set([
  'not_configured', 'state_cookie_missing', 'state_cookie_invalid', 'state_type', 'state_mismatch', 'provider_denied', 'missing_code',
  'identity_exchange', 'token_exchange', 'token_invalid_grant', 'token_invalid_client', 'token_unauthorized_client', 'token_invalid_request', 'token_redirect_mismatch', 'token_rejected', 'token_response',
  'identity_header', 'identity_keys', 'identity_signature', 'identity_issuer', 'identity_audience', 'identity_nonce', 'identity_expiration', 'identity_subject', 'identity_email', 'identity_profile',
  'storage_transaction', 'storage_identity_conflict', 'storage_commit', 'session_cookie', 'unknown'
]);
function googleDiagnostic(dependencies, stage) {
  // Only locally defined finite stages can reach logs. Never include request URLs,
  // provider bodies, exception messages, identity claims, cookies, or credentials.
  const event = {event: 'account_google_callback_failed', stage: GOOGLE_DIAGNOSTIC_STAGES.has(stage) ? stage : 'unknown'};
  try { (dependencies.accountDiagnostic || (value => console.warn(JSON.stringify(value))))(event); } catch {}
}
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
const seconds = () => Math.floor(Date.now() / 1000);
const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
const cookieValue = (request, name) => (request.headers.get('cookie') || '').split(';').map(item => item.trim()).find(item => item.startsWith(name + '='))?.slice(name.length + 1);
const native = request => request.headers.get('X-Brclio-Client') === 'native' && !request.headers.has('Origin');
const publicUser = profile => ({id: profile.id, username: profile.username, email: profile.email, avatarUrl: profile.avatarUrl || null, providers: profile.providers || []});
const errorResult = (error, status = 400) => ({error, status});
const fail = result => json({error: result.error}, result.status);
function emailValue(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email) ? email : null;
}
function usernameValue(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().normalize('NFKC');
  return /^[\p{L}\p{N}][\p{L}\p{N}_.-]{2,31}$/u.test(name) ? name : null;
}
function cleanIndex(index) {
  const now = Date.now();
  for (const [key, value] of Object.entries(index.verifications)) if (value.expiresAt < now && value.sentAt < now - 86400000) delete index.verifications[key];
  for (const [key, value] of Object.entries(index.devices)) if (value.expiresAt < now) delete index.devices[key];
  return index;
}
async function makeGrant(mode) {
  const sid = random(), csrf = random(24), exp = seconds() + (mode === 'native' ? NATIVE_LIFETIME : WEB_LIFETIME);
  return {sid, csrf, exp, mode, key: await digest(sid)};
}
function addGrant(credentials, grant) {
  credentials.sessions ||= {};
  for (const [key, value] of Object.entries(credentials.sessions)) if (value.exp <= seconds()) delete credentials.sessions[key];
  const all = Object.entries(credentials.sessions).sort((a, b) => a[1].exp - b[1].exp);
  for (const [key] of all.slice(0, Math.max(0, all.length - 19))) delete credentials.sessions[key];
  credentials.sessions[grant.key] = {exp: grant.exp, mode: grant.mode};
}
async function grantResponse(profile, grant, env) {
  const token = await seal({typ: 'account', id: profile.id, sid: grant.sid, csrf: grant.csrf, mode: grant.mode, exp: grant.exp}, env.SESSION_SECRET);
  return json({user: publicUser(profile), csrf: grant.csrf, ...(grant.mode === 'native' ? {token} : {})}, 200,
    grant.mode === 'web' ? {'Set-Cookie': cookie(COOKIE, token, WEB_LIFETIME)} : {});
}
async function authenticate(request, env, store) {
  const authorization = request.headers.get('Authorization');
  const isBearer = authorization?.startsWith('Bearer ');
  const token = isBearer ? authorization.slice(7) : cookieValue(request, COOKIE);
  const session = await unseal(token, env.SESSION_SECRET);
  if (!session || session.typ !== 'account' || !/^[a-zA-Z0-9-]+$/.test(session.id || '') || typeof session.sid !== 'string' || typeof session.csrf !== 'string' ||
      session.mode !== (isBearer ? 'native' : 'web')) return null;
  const state = await store.snapshot();
  const credentials = await state.read(userPath(session.id, 'credentials'));
  const sessionKey = await digest(session.sid);
  if (!credentials || credentials.sessions?.[sessionKey]?.exp !== session.exp || credentials.sessions[sessionKey].mode !== session.mode) return null;
  const profile = await state.read(userPath(session.id, 'profile'));
  return profile ? {...session, sessionKey, profile, isBearer} : null;
}
function preferencesValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const enums = {pathMode: ['absolute', 'relative'], quoteMode: ['none', 'double', 'single', 'auto'], separator: ['native', 'forward', 'backward'], joinWith: ['newline', 'space', 'comma']};
  const preferences = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'trailingSlash' && typeof entry === 'boolean') preferences[key] = entry;
    else if (Object.hasOwn(enums, key) && enums[key].includes(entry)) preferences[key] = entry;
    else return null;
  }
  return preferences;
}

export async function handleAccount(request, env, dependencies = {}) {
  const url = new URL(request.url), path = url.pathname;
  if (!path.startsWith('/api/account/')) return null;
  if (!['GET', 'POST', 'PUT'].includes(request.method)) return json({error: '不支持的请求方法'}, 405);
  const isNative = native(request);
  if (request.method !== 'GET' && !isNative && !sameOrigin(request)) return json({error: '请求来源无效'}, 403);
  if (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin) return json({error: '请求来源无效'}, 403);
  if (typeof env.SESSION_SECRET !== 'string' || env.SESSION_SECRET.length < 32) return json({error: '账号服务暂不可用'}, 503);
  const fetchImpl = dependencies.accountFetchImpl || dependencies.fetchImpl || fetch;
  const store = dependencies.accountStore || createAccountStore(env, fetchImpl);
  const ip = request.headers.get('CF-Connecting-IP') || 'development';
  const googleEnabled = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const limit = async (name, key, count) => rateLimit(env, name, key, count);
  if (!await limit('ACCOUNT_LIMITER', ip, 120)) return json({error: '请求过于频繁，请稍后重试'}, 429, {'Retry-After': '60'});

  if (path === '/api/account/session' && request.method === 'GET') {
    const session = await authenticate(request, env, store);
    return json({user: session ? publicUser(session.profile) : null, csrf: session?.csrf || null, googleEnabled, emailEnabled: Boolean(env.SMTP_EMAIL && env.SMTP_APP_PASSWORD)});
  }

  if (path === '/api/account/google/start' && request.method === 'GET') {
    if (!googleEnabled) return json({error: '谷歌登录尚未配置'}, 503);
    if (!await limit('ACCOUNT_AUTH_LIMITER', ip, 10)) return json({error: '请求过于频繁'}, 429);
    const device = url.searchParams.get('device');
    if (device) {
      const state = await store.snapshot(), index = await state.read('users/_index.json', emptyAccountIndex());
      if (!/^[A-Za-z0-9_-]{32,64}$/.test(device) || !own(index.devices, device) || index.devices[device].expiresAt <= Date.now()) return json({error: '客户端登录请求已过期'}, 400);
    }
    const verifier = random(), nonce = random(), state = random();
    // Only the opaque state identifier enters the redirect URL. The PKCE
    // verifier remains in an HttpOnly cookie until the server exchanges code.
    const oauthCookie = await seal({typ: 'google', state, nonce, verifier, device: device || null, exp: seconds() + 600}, env.SESSION_SECRET);
    const target = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    target.search = new URLSearchParams({client_id: env.GOOGLE_CLIENT_ID, redirect_uri: url.origin + '/api/account/google/callback', response_type: 'code', scope: 'openid email profile', state, nonce, code_challenge: await digest(verifier), code_challenge_method: 'S256', prompt: 'select_account'}).toString();
    return new Response(null, {status: 302, headers: {'Location': target.href, 'Set-Cookie': cookie(OAUTH_COOKIE, oauthCookie, 600), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'}});
  }

  if (path === '/api/account/google/callback' && request.method === 'GET') {
    const stateText = url.searchParams.get('state'), stateCookie = cookieValue(request, OAUTH_COOKIE), state = await unseal(stateCookie, env.SESSION_SECRET);
    const clear = cookie(OAUTH_COOKIE, '', 0);
    const failure = stage => {
      googleDiagnostic(dependencies, stage);
      // Preserve only the device bound to our signed OAuth cookie. This lets a
      // canceled Google flow fall back to password login and client approval.
      const query = new URLSearchParams({error: 'google'});
      if (state?.typ === 'google' && /^[A-Za-z0-9_-]{32,64}$/.test(state.device || '')) query.set('device', state.device);
      return new Response(null, {status: 302, headers: {'Location': '/account?' + query, 'Set-Cookie': clear, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'}});
    };
    if (!googleEnabled) return failure('not_configured');
    if (!state) return failure(stateCookie ? 'state_cookie_invalid' : 'state_cookie_missing');
    if (state.typ !== 'google') return failure('state_type');
    if (!await safeEqual(stateText || '', state.state)) return failure('state_mismatch');
    if (url.searchParams.has('error')) return failure('provider_denied');
    if (!url.searchParams.get('code')) return failure('missing_code');
    let stage = 'identity_exchange';
    try {
      const identity = await (dependencies.googleIdentity || googleIdentity)(url.searchParams.get('code'), state.verifier, state.nonce, url.origin + path, env, fetchImpl, value => {
        if (GOOGLE_DIAGNOSTIC_STAGES.has(value)) stage = value;
      });
      stage = 'identity_profile';
      const email = emailValue(identity.email);
      if (!email || typeof identity.sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(identity.sub)) return failure(stage);
      const grant = await makeGrant('web'), newId = crypto.randomUUID();
      stage = 'storage_transaction';
      const profile = await store.transaction(async tx => {
        const index = cleanIndex(await tx.read('users/_index.json', emptyAccountIndex()));
        const existing = own(index.google, identity.sub) || own(index.emails, email);
        let profile, credentials;
        if (existing) {
          profile = await tx.read(userPath(existing, 'profile'));
          credentials = await tx.read(userPath(existing, 'credentials'));
          if (!profile || !credentials || profile.email !== email || (credentials.googleSub && credentials.googleSub !== identity.sub)) { stage = 'storage_identity_conflict'; throw new Error('Google identity conflict'); }
          profile.providers = Array.from(new Set([...(profile.providers || []), 'google']));
          credentials.googleSub = identity.sub;
        } else {
          const base = [...(usernameValue(identity.name) || usernameValue(email.split('@')[0]) || 'user')].slice(0, 20).join('');
          let username = base, suffix = 0;
          while (own(index.usernames, username.toLowerCase())) username = base + '-' + newId.slice(0, 6) + (++suffix);
          profile = {version: 1, id: newId, username, email, emailVerified: true, avatarUrl: identity.picture || null, providers: ['google'], createdAt: new Date().toISOString()};
          credentials = {version: 1, password: null, googleSub: identity.sub, sessions: {}};
          index.usernames[username.toLowerCase()] = newId; index.emails[email] = newId;
          tx.write(userPath(newId, 'data'), {version: 1, preferences: {}, updatedAt: new Date().toISOString()});
        }
        index.google[identity.sub] = profile.id;
        addGrant(credentials, grant);
        tx.write('users/_index.json', index); tx.write(userPath(profile.id, 'profile'), profile); tx.write(userPath(profile.id, 'credentials'), credentials);
        stage = 'storage_commit';
        return profile;
      });
      stage = 'session_cookie';
      const response = await grantResponse(profile, grant, env);
      const headers = new Headers({'Location': '/account' + (state.device ? '?device=' + encodeURIComponent(state.device) : ''), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'});
      headers.append('Set-Cookie', response.headers.get('Set-Cookie')); headers.append('Set-Cookie', clear);
      return new Response(null, {status: 302, headers});
    } catch { return failure(stage); }
  }

  if (path === '/api/account/device/poll' && request.method === 'GET') {
    if (!isNative || !/^[A-Za-z0-9_-]{32,64}$/.test(url.searchParams.get('id') || '') || !/^[A-Za-z0-9_-]{43,128}$/.test(url.searchParams.get('verifier') || '')) return json({error: '客户端登录请求无效'}, 400);
    const id = url.searchParams.get('id'), challenge = await digest(url.searchParams.get('verifier'));
    const state = await store.snapshot(), index = await state.read('users/_index.json', emptyAccountIndex()), device = own(index.devices, id);
    if (!device || device.expiresAt <= Date.now() || !await safeEqual(device.challenge, challenge)) return json({error: '客户端登录请求已过期'}, 400);
    if (!device.userId) return json({pending: true});
    const grant = await makeGrant('native');
    const result = await store.transaction(async tx => {
      const current = cleanIndex(await tx.read('users/_index.json', emptyAccountIndex())), entry = own(current.devices, id);
      if (!entry || entry.expiresAt <= Date.now() || !await safeEqual(entry.challenge, challenge) || !entry.userId) return errorResult('客户端登录请求已过期');
      const profile = await tx.read(userPath(entry.userId, 'profile')), credentials = await tx.read(userPath(entry.userId, 'credentials'));
      if (!profile || !credentials) return errorResult('客户端登录请求无效');
      addGrant(credentials, grant); delete current.devices[id];
      tx.write('users/_index.json', current); tx.write(userPath(profile.id, 'credentials'), credentials);
      return profile;
    });
    return result.error ? fail(result) : grantResponse(result, grant, env);
  }

  let input;
  if (request.method !== 'GET') {
    try { input = await readJSON(request); if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(); }
    catch { return json({error: '请求格式无效'}, 400); }
  }

  if (path === '/api/account/device/start' && request.method === 'POST') {
    if (!isNative || !/^[A-Za-z0-9_-]{43}$/.test(input.challenge || '')) return json({error: '客户端登录请求无效'}, 400);
    if (!googleEnabled) return json({error: '谷歌登录尚未配置'}, 503);
    if (!await limit('ACCOUNT_AUTH_LIMITER', ip, 10)) return json({error: '请求过于频繁'}, 429);
    const id = random(24);
    await store.transaction(async tx => {
      const index = cleanIndex(await tx.read('users/_index.json', emptyAccountIndex()));
      index.devices[id] = {challenge: input.challenge, expiresAt: Date.now() + DEVICE_LIFETIME};
      tx.write('users/_index.json', index);
    });
    return json({id, url: url.origin + '/api/account/google/start?device=' + id});
  }

  if (path === '/api/account/code' && request.method === 'POST') {
    const email = emailValue(input.email);
    if (!email) return json({error: '请输入有效邮箱地址'}, 400);
    if (!env.SMTP_EMAIL || !env.SMTP_APP_PASSWORD) return json({error: '验证码邮件服务暂不可用'}, 503);
    if (!await limit('ACCOUNT_EMAIL_LIMITER', ip, 5) || !await limit('ACCOUNT_EMAIL_GLOBAL_LIMITER', 'registration', 30)) return json({error: '验证码发送过于频繁，请稍后重试'}, 429, {'Retry-After': '60'});
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
    const codeHash = await digest(email + ':' + code + ':' + env.SESSION_SECRET);
    const result = await store.transaction(async tx => {
      const index = cleanIndex(await tx.read('users/_index.json', emptyAccountIndex()));
      if (own(index.emails, email)) return {existing: true};
      const previous = own(index.verifications, email);
      if (previous && previous.sentAt > Date.now() - 60000) return errorResult('请等待 60 秒后再发送验证码', 429);
      index.verifications[email] = {hash: codeHash, expiresAt: Date.now() + CODE_LIFETIME, sentAt: Date.now(), attempts: 0};
      tx.write('users/_index.json', index);
      return {existing: false};
    });
    if (result.error) return fail(result);
    if (!result.existing) {
      try { await (dependencies.sendRegistrationCode || sendRegistrationCode)(env, email, code); }
      catch {
        await store.transaction(async tx => {
          const index = await tx.read('users/_index.json', emptyAccountIndex());
          if (own(index.verifications, email)?.hash === codeHash) { index.verifications[email].expiresAt = 0; tx.write('users/_index.json', index); }
        });
        return json({error: '验证码邮件发送失败，请稍后重试'}, 503);
      }
    }
    return json({ok: true, message: '若该邮箱可以注册，验证码已发送，有效期 10 分钟', retryAfter: 60});
  }

  if (path === '/api/account/register' && request.method === 'POST') {
    if (!await limit('ACCOUNT_AUTH_LIMITER', ip, 10)) return json({error: '尝试过多，请一分钟后重试'}, 429);
    const email = emailValue(input.email), username = usernameValue(input.username);
    if (!email || !username || typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 128 || !/^\d{6}$/.test(input.code || '')) return json({error: '请输入 3–32 位账号、有效邮箱、6 位验证码和 8–128 位密码'}, 400);
    const password = await hashPassword(input.password), codeHash = await digest(email + ':' + input.code + ':' + env.SESSION_SECRET);
    const grant = await makeGrant(isNative ? 'native' : 'web'), id = crypto.randomUUID();
    const result = await store.transaction(async tx => {
      const index = cleanIndex(await tx.read('users/_index.json', emptyAccountIndex())), verification = own(index.verifications, email);
      if (!verification || verification.expiresAt <= Date.now() || verification.attempts >= 5) return errorResult('验证码无效或已过期，请重新获取');
      if (!await safeEqual(verification.hash, codeHash)) {
        verification.attempts++; tx.write('users/_index.json', index);
        return errorResult('验证码无效或已过期，请重新获取');
      }
      if (own(index.usernames, username.toLowerCase()) || own(index.emails, email)) return errorResult('账号或邮箱不可用，请直接登录或更换账号');
      const profile = {version: 1, id, username, email, emailVerified: true, avatarUrl: null, providers: ['password'], createdAt: new Date().toISOString()};
      const credentials = {version: 1, password, sessions: {}, failedAttempts: 0}; addGrant(credentials, grant);
      index.usernames[username.toLowerCase()] = id; index.emails[email] = id; delete index.verifications[email];
      tx.write('users/_index.json', index); tx.write(userPath(id, 'profile'), profile); tx.write(userPath(id, 'credentials'), credentials);
      tx.write(userPath(id, 'data'), {version: 1, preferences: {}, updatedAt: new Date().toISOString()});
      return profile;
    });
    return result.error ? fail(result) : grantResponse(result, grant, env);
  }

  if (path === '/api/account/login' && request.method === 'POST') {
    if (!await limit('ACCOUNT_AUTH_LIMITER', ip, 10)) return json({error: '尝试过多，请一分钟后重试'}, 429);
    if (typeof input.identifier !== 'string' || input.identifier.length > 254 || typeof input.password !== 'string' || input.password.length > 128) return json({error: '账号、邮箱或密码不正确'}, 401);
    const identifier = input.identifier.trim().normalize('NFKC').toLowerCase();
    const state = await store.snapshot(), index = await state.read('users/_index.json', emptyAccountIndex());
    const id = own(index.emails, identifier) || own(index.usernames, identifier);
    const credentials = id ? await state.read(userPath(id, 'credentials')) : null;
    let valid = false;
    if (credentials?.password) valid = await checkPassword(input.password, credentials.password);
    else await hashPassword(input.password, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    if (!id || !credentials) return json({error: '账号、邮箱或密码不正确'}, 401);
    const grant = await makeGrant(isNative ? 'native' : 'web');
    const result = await store.transaction(async tx => {
      const current = await tx.read(userPath(id, 'credentials'));
      if (!current || current.lockedUntil > Date.now()) return errorResult('账号、邮箱或密码不正确，或尝试过多，请稍后重试', 401);
      if (!valid || current.password?.hash !== credentials.password?.hash) {
        current.failedAttempts = (current.failedAttempts || 0) + 1;
        if (current.failedAttempts >= 8) { current.lockedUntil = Date.now() + 900000; current.failedAttempts = 0; }
        tx.write(userPath(id, 'credentials'), current);
        return errorResult('账号、邮箱或密码不正确', 401);
      }
      current.failedAttempts = 0; current.lockedUntil = 0; addGrant(current, grant);
      tx.write(userPath(id, 'credentials'), current);
      return tx.read(userPath(id, 'profile'));
    });
    return result.error ? fail(result) : grantResponse(result, grant, env);
  }

  const session = await authenticate(request, env, store);
  if (!session) return json({error: '请先登录'}, 401);
  if (request.method !== 'GET' && !session.isBearer && !await safeEqual(request.headers.get('X-CSRF-Token') || '', session.csrf)) return json({error: '页面会话已更新，请刷新后重试'}, 403);

  if (path === '/api/account/logout' && request.method === 'POST') {
    await store.transaction(async tx => {
      const credentials = await tx.read(userPath(session.id, 'credentials'));
      if (credentials?.sessions?.[session.sessionKey]) { delete credentials.sessions[session.sessionKey]; tx.write(userPath(session.id, 'credentials'), credentials); }
    });
    return json({ok: true}, 200, {'Set-Cookie': cookie(COOKIE, '', 0)});
  }
  if (path === '/api/account/device/approve' && request.method === 'POST') {
    if (session.isBearer || !/^[A-Za-z0-9_-]{32,64}$/.test(input.id || '')) return json({error: '客户端登录请求无效'}, 400);
    const result = await store.transaction(async tx => {
      const index = cleanIndex(await tx.read('users/_index.json', emptyAccountIndex())), device = own(index.devices, input.id);
      if (!device || device.expiresAt <= Date.now() || (device.userId && device.userId !== session.id)) return errorResult('客户端登录请求已过期');
      device.userId = session.id; tx.write('users/_index.json', index); return {ok: true};
    });
    return result.error ? fail(result) : json(result);
  }
  if (path === '/api/account/data' && request.method === 'GET') {
    const state = await store.snapshot(), data = await state.read(userPath(session.id, 'data'), {version: 1, preferences: {}, updatedAt: null});
    return json({userId: session.id, preferences: data.preferences, updatedAt: data.updatedAt});
  }
  if (path === '/api/account/data' && request.method === 'PUT') {
    const preferences = preferencesValue(input.preferences);
    if (!preferences) return json({error: '复制偏好格式无效'}, 400);
    const data = {version: 1, preferences, updatedAt: new Date().toISOString()};
    await store.transaction(async tx => { tx.write(userPath(session.id, 'data'), data); });
    return json({userId: session.id, preferences: data.preferences, updatedAt: data.updatedAt});
  }
  return json({error: '未找到账号接口'}, 404);
}

import {decode64} from './accounts-crypto.js';
let cachedKeys;

export async function googleIdentity(code, verifier, nonce, callback, env, fetchImpl = fetch) {
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({code, code_verifier: verifier, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: callback, grant_type: 'authorization_code'}),
    redirect: 'error', signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Google authorization failed'); }
  const result = await response.json();
  const parts = String(result.id_token || '').split('.');
  if (parts.length !== 3 || parts.some(part => part.length > 16384)) throw new Error('Invalid Google identity');
  const header = JSON.parse(new TextDecoder().decode(decode64(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(decode64(parts[1])));
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Invalid Google signing algorithm');
  async function keys(fresh = false) {
    if (!fresh && cachedKeys?.until > Date.now()) return cachedKeys.value;
    const certs = await fetchImpl('https://www.googleapis.com/oauth2/v3/certs', {redirect: 'error', signal: AbortSignal.timeout(10000)});
    if (!certs.ok) throw new Error('Google keys unavailable');
    const value = await certs.json();
    if (!Array.isArray(value.keys)) throw new Error('Google keys unavailable');
    cachedKeys = {value: value.keys, until: Date.now() + 3600000};
    return value.keys;
  }
  let jwk = (await keys()).find(key => key.kid === header.kid);
  if (!jwk) jwk = (await keys(true)).find(key => key.kid === header.kid);
  if (!jwk) throw new Error('Google identity key unavailable');
  const key = await crypto.subtle.importKey('jwk', jwk, {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['verify']);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode64(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]))) throw new Error('Invalid Google identity signature');
  const now = Math.floor(Date.now() / 1000);
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || claims.aud !== env.GOOGLE_CLIENT_ID ||
      (claims.azp && claims.azp !== env.GOOGLE_CLIENT_ID) || claims.nonce !== nonce ||
      !Number.isSafeInteger(claims.exp) || claims.exp <= now || !Number.isSafeInteger(claims.iat) || claims.iat > now + 60 ||
      typeof claims.sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(claims.sub) || claims.email_verified !== true || typeof claims.email !== 'string') throw new Error('Invalid Google identity claims');
  return {sub: claims.sub, email: claims.email, name: typeof claims.name === 'string' ? claims.name : '', picture: typeof claims.picture === 'string' && claims.picture.startsWith('https://') ? claims.picture : null};
}

import {decode64} from './accounts-crypto.js';
let cachedKeys;

export async function googleIdentity(code, verifier, nonce, callback, env, fetchImpl = fetch, onStage = () => {}) {
  onStage('token_exchange');
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({code, code_verifier: verifier, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: callback, grant_type: 'authorization_code'}),
    redirect: 'manual', signal: AbortSignal.timeout(10000)
  });
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); onStage('token_rejected'); throw new Error('Google authorization redirect refused'); }
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    const known = {invalid_grant: 'token_invalid_grant', invalid_client: 'token_invalid_client', unauthorized_client: 'token_unauthorized_client', invalid_request: 'token_invalid_request', redirect_uri_mismatch: 'token_redirect_mismatch'};
    onStage(Object.hasOwn(known, failure?.error || '') ? known[failure.error] : 'token_rejected');
    throw new Error('Google authorization failed');
  }
  onStage('token_response');
  const result = await response.json();
  const parts = String(result.id_token || '').split('.');
  if (parts.length !== 3 || parts.some(part => part.length > 16384)) throw new Error('Invalid Google identity');
  onStage('identity_header');
  const header = JSON.parse(new TextDecoder().decode(decode64(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(decode64(parts[1])));
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Invalid Google signing algorithm');
  async function keys(fresh = false) {
    if (!fresh && cachedKeys?.until > Date.now()) return cachedKeys.value;
    onStage('identity_keys');
    const certs = await fetchImpl('https://www.googleapis.com/oauth2/v3/certs', {redirect: 'manual', signal: AbortSignal.timeout(10000)});
    if (certs.status >= 300 && certs.status < 400) { await certs.body?.cancel(); throw new Error('Google keys redirect refused'); }
    if (!certs.ok) throw new Error('Google keys unavailable');
    const value = await certs.json();
    if (!Array.isArray(value.keys)) throw new Error('Google keys unavailable');
    cachedKeys = {value: value.keys, until: Date.now() + 3600000};
    return value.keys;
  }
  let jwk = (await keys()).find(key => key.kid === header.kid);
  if (!jwk) jwk = (await keys(true)).find(key => key.kid === header.kid);
  if (!jwk) throw new Error('Google identity key unavailable');
  onStage('identity_signature');
  const key = await crypto.subtle.importKey('jwk', jwk, {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['verify']);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode64(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]))) throw new Error('Invalid Google identity signature');
  const now = Math.floor(Date.now() / 1000);
  const checks = [
    ['identity_issuer', ['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss)],
    ['identity_audience', claims.aud === env.GOOGLE_CLIENT_ID && (!claims.azp || claims.azp === env.GOOGLE_CLIENT_ID)],
    ['identity_nonce', claims.nonce === nonce],
    ['identity_expiration', Number.isSafeInteger(claims.exp) && claims.exp > now && Number.isSafeInteger(claims.iat) && claims.iat <= now + 60],
    ['identity_subject', typeof claims.sub === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(claims.sub)],
    ['identity_email', claims.email_verified === true && typeof claims.email === 'string']
  ];
  for (const [stage, valid] of checks) if (!valid) { onStage(stage); throw new Error('Invalid Google identity claims'); }
  return {sub: claims.sub, email: claims.email, name: typeof claims.name === 'string' ? claims.name : '', picture: typeof claims.picture === 'string' && claims.picture.startsWith('https://') ? claims.picture : null};
}

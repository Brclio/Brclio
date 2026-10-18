import { encoder } from './protocol.js';
const COOKIE = '__Host-brclio_admin';
const lifetime = 8 * 60 * 60;
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/, '');
const unb64 = text => Uint8Array.from(atob(text.replaceAll('-','+').replaceAll('_','/')), c => c.charCodeAt(0));
async function key(secret) { if (!secret || secret.length < 32) throw new Error('后台会话密钥尚未配置'); return crypto.subtle.importKey('raw', encoder.encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign','verify']); }
export async function safeEqual(a, b) {
  const [x,y] = await Promise.all([a,b].map(v => crypto.subtle.digest('SHA-256', encoder.encode(String(v)))));
  const aa = new Uint8Array(x), bb = new Uint8Array(y); let diff = 0;
  for(let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}
export function sameOrigin(request) {
  return request.headers.get('origin') === new URL(request.url).origin && !['cross-site', 'none'].includes(request.headers.get('sec-fetch-site'));
}
export async function createSession(env) {
  const csrf = b64(crypto.getRandomValues(new Uint8Array(24)));
  const payload = b64(encoder.encode(JSON.stringify({email: env.ADMIN_EMAIL, exp: Math.floor(Date.now()/1000)+lifetime, csrf})));
  const signature = b64(new Uint8Array(await crypto.subtle.sign('HMAC', await key(env.SESSION_SECRET), encoder.encode(payload))));
  return {csrf, cookie: `${COOKIE}=${payload}.${signature}; Path=/; Max-Age=${lifetime}; HttpOnly; Secure; SameSite=Strict`};
}
export async function sessionFrom(request, env) {
  try {
    const token = (request.headers.get('cookie') || '').split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
    if (!token || token.length > 2048) return null;
    const [payload, sig, extra] = token.split('.'); if (!sig || extra) return null;
    if (!await crypto.subtle.verify('HMAC', await key(env.SESSION_SECRET), unb64(sig), encoder.encode(payload))) return null;
    const data = JSON.parse(new TextDecoder().decode(unb64(payload)));
    if (data.email !== env.ADMIN_EMAIL || !Number.isSafeInteger(data.exp) || data.exp <= Math.floor(Date.now()/1000) || typeof data.csrf !== 'string') return null;
    return data;
  } catch { return null; }
}
export function clearSessionCookie() { return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`; }

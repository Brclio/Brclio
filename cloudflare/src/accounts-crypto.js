const encoder = new TextEncoder();
export const encode64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
export const decode64 = text => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
export const random = (length = 32) => encode64(crypto.getRandomValues(new Uint8Array(length)));
export const digest = async value => encode64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
async function signingKey(secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Account signing unavailable');
  return crypto.subtle.importKey('raw', encoder.encode('brclio-user-v1:' + secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign', 'verify']);
}
export async function seal(value, secret) {
  const payload = encode64(encoder.encode(JSON.stringify(value)));
  const signature = encode64(new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(payload))));
  return `${payload}.${signature}`;
}
export async function unseal(token, secret) {
  try {
    if (typeof token !== 'string' || token.length > 4096) return null;
    const [payload, signature, extra] = token.split('.');
    if (!signature || extra || !await crypto.subtle.verify('HMAC', await signingKey(secret), decode64(signature), encoder.encode(payload))) return null;
    const value = JSON.parse(new TextDecoder().decode(decode64(payload)));
    return Number.isSafeInteger(value.exp) && value.exp > Math.floor(Date.now() / 1000) ? value : null;
  } catch { return null; }
}
export async function hashPassword(password, salt = random(24)) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const hash = encode64(new Uint8Array(await crypto.subtle.deriveBits({name: 'PBKDF2', hash: 'SHA-256', salt: decode64(salt), iterations: 100000}, material, 256)));
  return {algorithm: 'PBKDF2-SHA256', iterations: 100000, salt, hash};
}
export async function checkPassword(password, record) {
  if (!record || record.algorithm !== 'PBKDF2-SHA256' || record.iterations !== 100000) return false;
  const candidate = await hashPassword(password, record.salt);
  const material = await crypto.subtle.importKey('raw', decode64(record.hash), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign', 'verify']);
  const signature = await crypto.subtle.sign('HMAC', material, encoder.encode('password comparison'));
  const other = await crypto.subtle.importKey('raw', decode64(candidate.hash), {name: 'HMAC', hash: 'SHA-256'}, false, ['verify']);
  return crypto.subtle.verify('HMAC', other, signature, encoder.encode('password comparison'));
}

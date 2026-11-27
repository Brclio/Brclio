import {userPath} from './account-store.js';

const error = (message, status) => ({error: message, status});
const ownerOf = (map, key) => map && Object.hasOwn(map, key) ? map[key] : undefined;

export const validDeviceId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{32,64}$/.test(value);
export const validVerifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(value);
export const expiredLink = () => error('绑定请求已失效，请在客户端重新发起', 400);

export function fromAccountPage(request) {
  const site = request.headers.get('Sec-Fetch-Site');
  if (site) return site === 'same-origin';
  const origin = new URL(request.url).origin;
  if (request.headers.has('Origin')) return request.headers.get('Origin') === origin;
  try { return new URL(request.headers.get('Referer')).origin === origin; }
  catch { return false; }
}

export function activeSession(credentials, owner) {
  const active = credentials?.sessions?.[owner.sessionKey];
  return active?.mode === owner.mode && active.exp === owner.exp && active.exp > Math.floor(Date.now() / 1000);
}

export function deviceLink(index, id) {
  return ownerOf(index.deviceLinks, id);
}

export function sameLinkSession(entry, session) {
  return session?.isBearer && entry.owner.id === session.id && entry.owner.sessionKey === session.sessionKey;
}

// Use the authenticated owner as the target. Provider email is a conflict
// check only. Never write it to the owner's profile or the email-to-user index.
export async function checkLink(tx, index, provider, identity, owner, sameEmail = false) {
  const profile = await tx.read(userPath(owner.id, 'profile'));
  const credentials = await tx.read(userPath(owner.id, 'credentials'));
  if (profile?.id !== owner.id || !activeSession(credentials, owner)) return error('会话已失效，请重新登录', 401);
  const bySubject = ownerOf(index[provider], identity.sub);
  const byEmail = ownerOf(index.emails, identity.email);
  const credentialKey = provider === 'github' ? 'githubSub' : 'googleSub';
  const savedSubject = credentials[credentialKey];
  if (!profile.emailVerified || ownerOf(index.emails, profile.email) !== owner.id ||
      (sameEmail && profile.email !== identity.email) || (byEmail && byEmail !== owner.id) ||
      (bySubject && (bySubject !== owner.id || savedSubject !== identity.sub)) ||
      (savedSubject && savedSubject !== identity.sub)) {
    return error('无法绑定此第三方账号，请检查已关联的账号和邮箱', 409);
  }
  return {profile, credentials, credentialKey};
}

export function saveLink(tx, index, provider, identity, {profile, credentials, credentialKey}) {
  index[provider] = {...index[provider], [identity.sub]: profile.id};
  profile.providers = Array.from(new Set([...(profile.providers || []), provider]));
  credentials[credentialKey] = identity.sub;
  tx.write('users/_index.json', index);
  tx.write(userPath(profile.id, 'profile'), profile);
  tx.write(userPath(profile.id, 'credentials'), credentials);
}

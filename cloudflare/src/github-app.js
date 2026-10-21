// GitHub App credentials stay on the server. Only short-lived installation
// tokens scoped to the requested repository are used for repository API calls.
const tokens = new Map();
const inFlight = new Map();
const encoder = new TextEncoder();
const FAILURE = 'GitHub App authentication unavailable';
const ALGORITHM = {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'};

export class GitHubAppAuthenticationError extends Error {
  constructor() { super(FAILURE); this.name = 'GitHubAppAuthenticationError'; }
}
function check(value) { if (!value) throw new GitHubAppAuthenticationError(); }
function concatenate(...parts) {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function der(tag, value) {
  const length = [];
  for (let remaining = value.length; remaining; remaining = Math.floor(remaining / 256)) length.unshift(remaining & 255);
  return concatenate(new Uint8Array([tag, ...(value.length < 128 ? [value.length] : [0x80 | length.length, ...length])]), value);
}
function privateKeyDER(pem) {
  check(typeof pem === 'string' && pem.length <= 20000);
  const value = pem.replace(/\\n/g, '\n').trim();
  const match = /^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----\s+([A-Za-z0-9+/=\s]+?)\s+-----END \1-----$/.exec(value);
  check(match);
  const content = Uint8Array.from(atob(match[2].replace(/\s/g, '')), char => char.charCodeAt(0));
  check(content.length >= 256 && content.length <= 16384);
  if (match[1] === 'PRIVATE KEY') return content;
  // PKCS#8 PrivateKeyInfo ::= SEQUENCE {version, rsaEncryption AlgorithmIdentifier,
  // privateKey OCTET STRING}. GitHub downloads its RSA key in PKCS#1 format.
  return der(0x30, concatenate(new Uint8Array([0x02, 0x01, 0x00]),
    new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]),
    der(0x04, content)));
}
function base64url(bytes) {
  let content = '';
  for (const byte of bytes) content += String.fromCharCode(byte);
  return btoa(content).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function identifier(value) {
  check(typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value));
  return value;
}
async function issueToken(appId, installationId, keyDER, repository, fetchImpl) {
  const key = await crypto.subtle.importKey('pkcs8', keyDER, ALGORITHM, false, ['sign']);
  check(key.algorithm.modulusLength >= 2048);
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(encoder.encode(JSON.stringify({alg: 'RS256', typ: 'JWT'})));
  const claims = base64url(encoder.encode(JSON.stringify({iat: now - 60, exp: now + 540, iss: appId})));
  const message = header + '.' + claims;
  const signature = await crypto.subtle.sign(ALGORITHM, key, encoder.encode(message));
  const response = await fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: {Authorization: 'Bearer ' + message + '.' + base64url(new Uint8Array(signature)),
      Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Brclio-GitHub-App', 'Content-Type': 'application/json'},
    body: JSON.stringify({repositories: [repository.split('/')[1]], permissions: {contents: 'write'}})
  });
  if (!response.ok || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel();
    throw new GitHubAppAuthenticationError();
  }
  const value = await response.json();
  check(value && typeof value === 'object' && !Array.isArray(value));
  // Installation tokens are opaque. GitHub's 2026 stateless format includes
  // an App ID and a long JWT with dots, underscores and hyphens.
  check(typeof value.token === 'string' && value.token.length <= 16384 && /^ghs_[A-Za-z0-9._-]{36,}$/.test(value.token));
  check(typeof value.expires_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.expires_at));
  const expiry = Date.parse(value.expires_at), current = Date.now();
  check(Number.isFinite(expiry) && expiry > current + 60000 && expiry <= current + 65 * 60000);
  if (value.permissions !== undefined) {
    check(value.permissions && typeof value.permissions === 'object' && !Array.isArray(value.permissions) && value.permissions.contents === 'write');
    check(Object.entries(value.permissions).every(([name, permission]) => name === 'contents' || (name === 'metadata' && permission === 'read')));
  }
  if (value.repository_selection !== undefined) check(value.repository_selection === 'selected');
  if (value.repositories !== undefined) {
    check(Array.isArray(value.repositories) && value.repositories.length === 1 &&
      typeof value.repositories[0]?.full_name === 'string' && value.repositories[0].full_name.toLowerCase() === repository.toLowerCase());
  }
  return {token: value.token, until: expiry - 60000};
}

export async function githubInstallationToken(env, repository, fetchImpl = fetch) {
  try {
    check(typeof repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository));
    check(repository.split('/').every(part => part !== '.' && part !== '..'));
    const appId = identifier(env.GITHUB_APP_ID), installationId = identifier(env.GITHUB_APP_INSTALLATION_ID);
    const keyDER = privateKeyDER(env.GITHUB_APP_PRIVATE_KEY);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', keyDER));
    const fingerprint = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
    const cacheKey = JSON.stringify([repository.toLowerCase(), appId, installationId, fingerprint]);
    const cached = tokens.get(cacheKey);
    if (cached?.until > Date.now()) return cached.token;
    if (inFlight.has(cacheKey)) return await inFlight.get(cacheKey);
    // Never keep an expired credential or an unbounded collection of scopes.
    for (const [key, entry] of tokens) if (entry.until <= Date.now()) tokens.delete(key);
    const operation = issueToken(appId, installationId, keyDER, repository, fetchImpl).then(result => {
      if (tokens.size >= 64) tokens.delete(tokens.keys().next().value);
      tokens.set(cacheKey, result);
      return result.token;
    });
    inFlight.set(cacheKey, operation);
    try { return await operation; }
    finally { if (inFlight.get(cacheKey) === operation) inFlight.delete(cacheKey); }
  } catch {
    // Do not propagate crypto, HTTP, provider bodies, private keys, JWTs or token
    // values through the caller's diagnostics or public API errors.
    throw new GitHubAppAuthenticationError();
  }
}

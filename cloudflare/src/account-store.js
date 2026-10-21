import {githubInstallationToken} from './github-app.js';

// Shared identity records and app-owned data live in a private GitHub repository.
// One Git commit updates all affected files together; a non-forced ref update
// retries the complete mutation when another application commits concurrently.
const metadataCache = new Map();
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const USER_ID = '[a-zA-Z0-9-]+';
const APP_ID = '[a-z][a-z0-9-]{0,47}';
const RESERVED_APP_IDS = new Set(['users', 'apps', 'profile', 'credentials', 'data', 'protocol', 'identity', 'system']);
const USER_RECORD = new RegExp(`^users/(${USER_ID})/(?:profile|credentials|data)\\.json$`);
const APP_RECORD = new RegExp(`^users/(${USER_ID})/apps/(${APP_ID})/data\\.json$`);
const MISSING = Symbol('missing record');
const encoder = new TextEncoder();

export class AccountStorageError extends Error {}

function validAppId(id) {
  return typeof id === 'string' && new RegExp(`^${APP_ID}$`).test(id) && !RESERVED_APP_IDS.has(id);
}
function recordPath(path, allowProtocol = false) {
  if (typeof path !== 'string') throw new AccountStorageError('Invalid user record path');
  if (allowProtocol && path === 'protocol.json') return path;
  if (path === 'users/_index.json' || USER_RECORD.test(path)) return path;
  const app = APP_RECORD.exec(path);
  if (app && validAppId(app[2])) return path;
  throw new AccountStorageError('Invalid user record path');
}
function recordObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
// JSON.stringify silently drops or transforms several JavaScript values. Reject
// those values so an integration cannot accidentally save a lossy record.
function jsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value)) throw new AccountStorageError('Invalid account JSON');
  if (!Array.isArray(value) && !recordObject(value)) throw new AccountStorageError('Invalid account JSON');
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value) && keys.length !== value.length + 1) throw new AccountStorageError('Invalid account JSON');
  for (const key of keys) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new AccountStorageError('Invalid account JSON');
    if (Array.isArray(value) && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) throw new AccountStorageError('Invalid account JSON');
    jsonValue(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}
function recordVersion(value) {
  if (Object.hasOwn(value, 'version') && value.version !== 1) throw new AccountStorageError('Unsupported account record version');
}
function serializeRecord(value) {
  try {
    if (!recordObject(value)) throw new AccountStorageError('Invalid account JSON');
    jsonValue(value);
    recordVersion(value);
    const content = JSON.stringify(value, null, 2) + '\n';
    if (encoder.encode(content).byteLength > MAX_RECORD_BYTES) throw new AccountStorageError('Account record is too large');
    return content;
  } catch (error) {
    if (error instanceof AccountStorageError) throw error;
    throw new AccountStorageError('Invalid account JSON');
  }
}
function recordBytes(file) {
  if (file?.encoding !== 'base64' || typeof file.content !== 'string' || !Number.isInteger(file.size) || file.size < 0 || file.size > MAX_RECORD_BYTES) throw new AccountStorageError('Invalid account record');
  try {
    const encoded = file.content.replace(/\s/g, '');
    if (encoded.length > Math.ceil(MAX_RECORD_BYTES / 3) * 4) throw new AccountStorageError('Account record is too large');
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    if (bytes.byteLength !== file.size) throw new AccountStorageError('Account record size mismatch');
    return bytes;
  } catch (error) {
    if (error instanceof AccountStorageError) throw error;
    throw new AccountStorageError('Invalid account record');
  }
}
function parseRecord(bytes) {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    if (!recordObject(value)) throw new AccountStorageError('Invalid account JSON');
    jsonValue(value);
    return value;
  } catch (error) {
    if (error instanceof AccountStorageError) throw error;
    throw new AccountStorageError('Invalid account JSON');
  }
}
function decodeRecord(file) { return parseRecord(recordBytes(file)); }

export function createAccountStore(env, fetchImpl = fetch, tokenProvider = githubInstallationToken) {
  const repo = env.GITHUB_DATA_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '')) throw new AccountStorageError('Account storage unavailable');
  const base = `https://api.github.com/repos/${repo}`;
  async function github(path, method = 'GET', body) {
    const token = await tokenProvider(env, repo, fetchImpl);
    const response = await fetchImpl(base + path, {
      method, headers: {Authorization: `Bearer ${token}`, Accept: path.startsWith('/contents/') ? 'application/vnd.github.object+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Brclio-Accounts', ...(body ? {'Content-Type': 'application/json'} : {})},
      ...(body ? {body: JSON.stringify(body)} : {}), redirect: 'manual', signal: AbortSignal.timeout(10000)
    });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new AccountStorageError('Repository redirect refused'); }
    return response;
  }
  async function requireJSON(path, method, body) {
    const response = await github(path, method, body);
    if (!response.ok) { await response.body?.cancel(); throw new AccountStorageError('Repository operation failed'); }
    return response.json();
  }
  async function readContentsRecord(file) {
    if (file?.encoding !== 'none') return decodeRecord(file);
    // The Contents object media type omits content above 1 MiB. Follow only the
    // immutable blob SHA returned for our pinned commit, never a download URL.
    if (file.type !== 'file' || !Number.isInteger(file.size) || file.size < 0 || file.size > MAX_RECORD_BYTES ||
      typeof file.sha !== 'string' || !/^[0-9a-f]{40}$/.test(file.sha)) throw new AccountStorageError('Invalid account record');
    const blob = await requireJSON(`/git/blobs/${file.sha}`);
    if (blob.sha !== file.sha || blob.size !== file.size) throw new AccountStorageError('Account blob metadata mismatch');
    const bytes = recordBytes(blob), prefix = encoder.encode(`blob ${bytes.byteLength}\0`);
    const input = new Uint8Array(prefix.length + bytes.length); input.set(prefix); input.set(bytes, prefix.length);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', input));
    const checksum = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
    if (checksum !== file.sha) throw new AccountStorageError('Account blob checksum mismatch');
    return parseRecord(bytes);
  }
  async function branch() {
    const cache = metadataCache.get(repo);
    if (cache?.until > Date.now()) return cache.branch;
    const data = await requireJSON('');
    if (data.private !== true || !data.default_branch) throw new AccountStorageError('User data requires a private repository');
    metadataCache.set(repo, {branch: data.default_branch, until: Date.now() + 60000});
    return data.default_branch;
  }
  async function snapshot() {
    const name = await branch();
    const reference = await requireJSON(`/git/ref/heads/${encodeURIComponent(name)}`);
    const head = reference.object.sha;
    const files = new Map();
    const state = {
      name, head,
      async read(path, fallback = null) {
        recordPath(path, true);
        if (!files.has(path)) {
          const response = await github(`/contents/${path}?ref=${encodeURIComponent(head)}`);
          if (response.status === 404) { await response.body?.cancel(); files.set(path, MISSING); }
          else {
            if (!response.ok) { await response.body?.cancel(); throw new AccountStorageError('Cannot read account record'); }
            const value = await readContentsRecord(await response.json());
            if (path !== 'protocol.json') recordVersion(value);
            files.set(path, value);
          }
        }
        const value = files.get(path);
        return structuredClone(value === MISSING ? fallback : value);
      }
    };
    // A missing manifest is an existing legacy repository. An unsupported or
    // corrupt manifest must stop all reads and mutations before data is changed.
    const protocol = await state.read('protocol.json');
    if (protocol !== null && protocol.version !== 1) throw new AccountStorageError('Unsupported account storage protocol');
    return state;
  }
  return {
    snapshot,
    async transaction(mutate) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const state = await snapshot(), writes = new Map();
        const result = await mutate({
          async read(path, fallback = null) {
            recordPath(path, true);
            return writes.has(path) ? JSON.parse(writes.get(path)) : state.read(path, fallback);
          },
          write(path, value) { recordPath(path); writes.set(path, serializeRecord(value)); }
        });
        if (!writes.size) return result;
        // Even a caller replacing a whole record must not overwrite an unknown
        // future version or a damaged file that it did not explicitly read.
        for (const path of writes.keys()) await state.read(path);
        const parent = await requireJSON(`/git/commits/${state.head}`);
        const tree = await requireJSON('/git/trees', 'POST', {base_tree: parent.tree.sha, tree: Array.from(writes, ([path, content]) => ({path, mode: '100644', type: 'blob', content}))});
        const commit = await requireJSON('/git/commits', 'POST', {message: 'Update shared account records', tree: tree.sha, parents: [state.head]});
        const updated = await github(`/git/refs/heads/${encodeURIComponent(state.name)}`, 'PATCH', {sha: commit.sha, force: false});
        if (updated.ok) { await updated.body?.cancel(); return result; }
        const retry = [409, 422].includes(updated.status); await updated.body?.cancel();
        if (!retry) throw new AccountStorageError('Cannot save account records');
      }
      throw new AccountStorageError('Concurrent account update; retry');
    }
  };
}

export const emptyAccountIndex = () => ({version: 1, usernames: {}, emails: {}, google: {}, verifications: {}, devices: {}});
export const userPath = (id, name) => recordPath(`users/${id}/${name}.json`);
export function appDataPath(id, appId) {
  if (!validAppId(appId)) throw new AccountStorageError('Invalid application ID');
  return recordPath(`users/${id}/apps/${appId}/data.json`);
}

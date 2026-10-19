// User records live only in the existing private GitHub data repository.
// A single Git commit updates identity indexes and user files together; the
// non-forced ref update is the compare-and-swap protecting concurrent signups.
const metadataCache = new Map();
const decode = value => new TextDecoder().decode(Uint8Array.from(atob(value.replace(/\s/g, '')), c => c.charCodeAt(0)));

export class AccountStorageError extends Error {}

export function createAccountStore(env, fetchImpl = fetch) {
  const repo = env.GITHUB_DATA_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '') || !env.GITHUB_TOKEN) throw new AccountStorageError('Account storage unavailable');
  const base = `https://api.github.com/repos/${repo}`;
  async function github(path, method = 'GET', body) {
    const response = await fetchImpl(base + path, {
      method, headers: {Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Brclio-Accounts', ...(body ? {'Content-Type': 'application/json'} : {})},
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
    return {
      name, head,
      async read(path, fallback = null) {
        if (!/^users\/(?:_index\.json|[a-zA-Z0-9-]+\/(?:profile|credentials|data)\.json)$/.test(path)) throw new AccountStorageError('Invalid user record path');
        if (files.has(path)) return structuredClone(files.get(path));
        const response = await github(`/contents/${path}?ref=${head}`);
        if (response.status === 404) { await response.body?.cancel(); files.set(path, fallback); return structuredClone(fallback); }
        if (!response.ok) { await response.body?.cancel(); throw new AccountStorageError('Cannot read account record'); }
        const file = await response.json();
        if (file.encoding !== 'base64' || file.size > 2 * 1024 * 1024) throw new AccountStorageError('Invalid account record');
        let data; try { data = JSON.parse(decode(file.content)); } catch { throw new AccountStorageError('Invalid account JSON'); }
        files.set(path, data);
        return structuredClone(data);
      }
    };
  }
  return {
    snapshot,
    async transaction(mutate) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const state = await snapshot(), writes = new Map();
        const result = await mutate({read: state.read, write(path, value) { writes.set(path, structuredClone(value)); }});
        if (!writes.size) return result;
        const parent = await requireJSON(`/git/commits/${state.head}`);
        const tree = await requireJSON('/git/trees', 'POST', {base_tree: parent.tree.sha, tree: Array.from(writes, ([path, value]) => ({path, mode: '100644', type: 'blob', content: JSON.stringify(value, null, 2) + '\n'}))});
        const commit = await requireJSON('/git/commits', 'POST', {message: 'Update Brclio account records', tree: tree.sha, parents: [state.head]});
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
export const userPath = (id, name) => `users/${id}/${name}.json`;

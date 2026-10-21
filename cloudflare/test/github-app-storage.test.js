import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {createAccountStore} from '../src/account-store.js';
import {readConfig, writeConfig, clearConfigCache} from '../src/config.js';

test('account and program reads and writes use distinct App installation scopes and token caches', async () => {
  const pair = generateKeyPairSync('rsa', {modulusLength: 2048});
  const repository = 'fixture/app-storage-integration-users', programRepository = 'fixture/app-storage-integration-program';
  const env = {GITHUB_APP_ID: '9123001', GITHUB_APP_INSTALLATION_ID: '9123002',
    GITHUB_APP_PRIVATE_KEY: pair.privateKey.export({type: 'pkcs8', format: 'pem'}).toString(),
    GITHUB_DATA_REPOSITORY: repository, GITHUB_PROGRAM_DATA_REPOSITORY: programRepository, PROXY_SUBSCRIPTION_URL: 'https://subscription.example/fallback',
    GITHUB_TOKEN: 'legacy-personal-token-must-never-be-used'};
  const tokens = {[repository]: 'ghs_' + '8'.repeat(40), [programRepository]: 'ghs_' + '9'.repeat(40)};
  const exchanges = [], mutations = [];
  let programContent;
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'manual');
    if (url === 'https://api.github.com/app/installations/9123002/access_tokens') {
      assert.equal(options.method, 'POST');
      assert.match(options.headers.Authorization, /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      const body = JSON.parse(options.body), selected = 'fixture/' + body.repositories[0];
      assert.deepEqual(body, {repositories: [selected.split('/')[1]], permissions: {contents: 'write'}});
      assert.ok(Object.hasOwn(tokens, selected)); exchanges.push(selected);
      return Response.json({token: tokens[selected], expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: {contents: 'write', metadata: 'read'}, repository_selection: 'selected', repositories: [{full_name: selected}]});
    }
    if (url === env.PROXY_SUBSCRIPTION_URL) {
      assert.equal(options.headers.Authorization, undefined);
      return Response.json({proxies: [{type: 'vless', uuid: '00112233-4455-6677-8899-aabbccddeeff', tls: true, network: 'ws', servername: 'vpn.example.com', port: 443, 'ws-opts': {path: '/tunnel', headers: {Host: 'vpn.example.com'}}}]});
    }
    const parsed = new URL(url), selected = parsed.pathname.startsWith('/repos/' + repository + '/') || parsed.pathname === '/repos/' + repository ? repository : programRepository;
    assert.ok(parsed.pathname.startsWith('/repos/' + selected));
    assert.equal(options.headers.Authorization, 'Bearer ' + tokens[selected]);
    const path = parsed.pathname.slice(('/repos/' + selected).length);
    if (selected === programRepository) {
      assert.equal(path, '/contents/config/update-proxy.json');
      if (options.method === 'PUT') {
        mutations.push({repository: selected, path}); programContent = JSON.parse(options.body).content;
        return Response.json({content: {sha: 'program-config-sha'}});
      }
      if (!programContent) return new Response(null, {status: 404});
      return Response.json({sha: 'program-config-sha', size: Buffer.from(programContent, 'base64').length, encoding: 'base64', content: programContent});
    }
    if (!path) return Response.json({private: true, default_branch: 'main'});
    if (path === '/git/ref/heads/main') return Response.json({object: {sha: 'fixture-head'}});
    if (path.startsWith('/contents/')) return new Response(null, {status: 404});
    if (path === '/git/commits/fixture-head') return Response.json({tree: {sha: 'fixture-tree'}});
    if (options.method !== 'GET') {
      mutations.push({repository: selected, path}); const body = JSON.parse(options.body);
      if (path === '/git/trees') {
        assert.deepEqual(body.tree.map(x => x.path), ['users/fixture-user/profile.json']);
        return Response.json({sha: 'new-tree'});
      }
      if (path === '/git/commits') return Response.json({sha: 'new-user-commit'});
      if (path === '/git/refs/heads/main') { assert.equal(body.force, false); return Response.json({object: {sha: body.sha}}); }
    }
    throw new Error('Unexpected mock request');
  };
  clearConfigCache();
  const store = createAccountStore(env, fetchImpl);
  const [snapshot, config] = await Promise.all([store.snapshot(), readConfig(env, {fresh: true, fetchImpl})]);
  assert.equal(await snapshot.read('users/_index.json'), null);
  assert.equal(config.subscriptionUrl, env.PROXY_SUBSCRIPTION_URL);
  await store.transaction(tx => tx.write('users/fixture-user/profile.json', {version: 1, id: 'fixture-user'}));
  const saved = await writeConfig(env, {subscriptionUrl: env.PROXY_SUBSCRIPTION_URL, sha: null}, fetchImpl);
  assert.equal(saved.sha, 'program-config-sha');
  assert.equal((await readConfig(env, {fresh: true, fetchImpl})).sha, 'program-config-sha');
  assert.deepEqual(exchanges.sort(), [repository, programRepository].sort(), 'each repository gets its own cached installation token');
  assert.deepEqual(mutations.map(x => x.repository), [repository, repository, repository, programRepository]);
  clearConfigCache();
});

test('personal tokens cannot authenticate private account or config storage when App credentials are absent', async () => {
  let calls = 0;
  const env = {GITHUB_DATA_REPOSITORY: 'fixture/no-app-credentials', GITHUB_PROGRAM_DATA_REPOSITORY: 'fixture/no-app-program-credentials', GITHUB_TOKEN: 'personal-token-not-a-fallback'};
  const fetchImpl = async () => { calls++; throw new Error('must not reach repository'); };
  await assert.rejects(createAccountStore(env, fetchImpl).snapshot(), /GitHub App authentication unavailable/);
  clearConfigCache();
  await assert.rejects(readConfig(env, {fresh: true, fetchImpl}), /读取私有配置失败/);
  assert.equal(calls, 0); clearConfigCache();
});
test('account storage requires its own explicit repository even when program storage is configured', () => {
  assert.throws(() => createAccountStore({GITHUB_PROGRAM_DATA_REPOSITORY: 'fixture/program-only'}), /Account storage unavailable/);
});

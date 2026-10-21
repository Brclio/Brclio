import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {AccountStorageError, appDataPath, createAccountStore, userPath} from '../src/account-store.js';

let fixtureId = 0;
const encode = content => ({encoding: 'base64', size: Buffer.byteLength(content), content: Buffer.from(content).toString('base64')});
function repositoryFixture(initial = {}, intercept) {
  let head = 'commit-0', sequence = 0;
  const first = new Map(Object.entries(initial).map(([path, value]) => [path, typeof value === 'string' ? value : JSON.stringify(value)]));
  const trees = new Map([['tree-0', first]]), commits = new Map([['commit-0', {tree: {sha: 'tree-0'}, parents: []}]]);
  const calls = [], updates = [], env = {GITHUB_DATA_REPOSITORY: 'fixture/account-store-' + (++fixtureId), GITHUB_PROGRAM_DATA_REPOSITORY: 'fixture/program-data-must-not-be-used'};
  const current = () => trees.get(commits.get(head).tree.sha);
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url), prefix = '/repos/' + env.GITHUB_DATA_REPOSITORY;
    assert.ok(parsed.pathname === prefix || parsed.pathname.startsWith(prefix + '/'), 'account reads and writes stay in the account repository');
    const path = parsed.pathname.slice(prefix.length);
    const body = options.body && JSON.parse(options.body), call = {path, method: options.method, body, ref: parsed.searchParams.get('ref'), accept: options.headers.Accept};
    calls.push(call);
    const intercepted = await intercept?.(call);
    if (intercepted) return intercepted;
    if (!path) return Response.json({private: true, default_branch: 'main'});
    if (path === '/git/ref/heads/main') return Response.json({object: {sha: head}});
    if (path.startsWith('/contents/')) {
      const content = trees.get(commits.get(call.ref).tree.sha).get(path.slice('/contents/'.length));
      return content === undefined ? new Response(null, {status: 404}) : Response.json(encode(content));
    }
    if (path.startsWith('/git/commits/')) return Response.json(commits.get(path.slice('/git/commits/'.length)));
    if (path === '/git/trees') {
      const next = new Map(trees.get(body.base_tree)), sha = 'tree-' + (++sequence);
      for (const entry of body.tree) {
        assert.equal(entry.mode, '100644'); assert.equal(entry.type, 'blob');
        next.set(entry.path, entry.content);
      }
      trees.set(sha, next); return Response.json({sha});
    }
    if (path === '/git/commits') {
      const sha = 'commit-' + (++sequence);
      commits.set(sha, {...body, tree: {sha: body.tree}}); return Response.json({sha});
    }
    if (path === '/git/refs/heads/main') {
      assert.equal(body.force, false, 'ref updates must never force overwrite another application');
      if (commits.get(body.sha).parents[0] !== head) return new Response(null, {status: 422});
      head = body.sha; updates.push(new Map(current())); return Response.json({object: {sha: head}});
    }
    throw new Error('Unexpected repository request: ' + path);
  };
  const tokenProvider = async (received, repository, transport) => { assert.equal(received, env); assert.equal(repository, env.GITHUB_DATA_REPOSITORY); assert.equal(transport, fetchImpl); return 'fixture-installation-token'; };
  return {store: createAccountStore(env, fetchImpl, tokenProvider), calls, updates, current, read: path => JSON.parse(current().get(path))};
}
const profile = 'users/alice/profile.json', credentials = 'users/alice/credentials.json';
const brclio = appDataPath('alice', 'brclio'), miniapp = appDataPath('alice', 'miniapp');

test('app data paths support registered and future apps while refusing traversal and reserved names', () => {
  assert.equal(brclio, 'users/alice/apps/brclio/data.json');
  assert.equal(miniapp, 'users/alice/apps/miniapp/data.json');
  assert.equal(appDataPath('f33-UUID', 'future-app-2'), 'users/f33-UUID/apps/future-app-2/data.json');
  assert.equal(appDataPath('alice', 'a'.repeat(48)), `users/alice/apps/${'a'.repeat(48)}/data.json`);
  assert.equal(userPath('alice', 'data'), 'users/alice/data.json', 'legacy data paths remain supported');
  for (const app of ['', '../brclio', 'Brclio', 'a/b', '.', ' a', 'a_b', '1app', 'a'.repeat(49), 'users', 'apps', 'profile', 'credentials', 'data', 'protocol', 'identity', 'system']) {
    assert.throws(() => appDataPath('alice', app), AccountStorageError, app);
  }
  for (const id of ['', '../alice', 'alice/../bob', 'alice?ref=other', 'alice%2fbob']) assert.throws(() => appDataPath(id, 'brclio'), AccountStorageError, id);
  assert.throws(() => userPath('alice', '../profile'), AccountStorageError);
});

test('legacy repositories without a manifest read missing records with each caller fallback', async () => {
  const f = repositoryFixture({[profile]: {id: 'alice', custom: {keep: true}}});
  const state = await f.store.snapshot();
  const first = await state.read(credentials, {sessions: {}}); first.sessions.changed = true;
  assert.equal(await state.read(credentials), null);
  assert.deepEqual(await state.read(credentials, {another: true}), {another: true});
  assert.equal(f.calls.filter(call => call.path === '/contents/' + credentials).length, 1);
  const value = await state.read(profile); value.custom.keep = false;
  assert.equal((await state.read(profile)).custom.keep, true);
});

test('version 1 manifest permits data access and unknown protocol versions stop reads and writes', async () => {
  const supported = repositoryFixture({'protocol.json': {version: 1, repository: 'unbound-for-tests', futureField: true}, [profile]: {id: 'alice'}});
  assert.equal((await (await supported.store.snapshot()).read(profile)).id, 'alice');
  for (const version of [undefined, 0, 2, '1', null]) {
    const f = repositoryFixture({'protocol.json': {version}});
    await assert.rejects(f.store.snapshot(), /Unsupported account storage protocol/);
    let called = false;
    await assert.rejects(f.store.transaction(() => { called = true; }), /Unsupported account storage protocol/);
    assert.equal(called, false); assert.equal(f.calls.some(call => call.method !== 'GET'), false);
  }
});


test('unknown record versions stop reads and blind replacement writes for identity, legacy and app files', async () => {
  for (const path of [profile, credentials, 'users/_index.json', 'users/alice/data.json', brclio]) {
    for (const version of [0, 2, '1', null]) {
      const f = repositoryFixture({[path]: {version, preserved: true}});
      await assert.rejects((await f.store.snapshot()).read(path, {}), /Unsupported account record version/);
      await assert.rejects(f.store.transaction(tx => tx.write(path, {version: 1, replacement: true})), /Unsupported account record version/);
      assert.equal(f.calls.some(call => call.method !== 'GET'), false);
      assert.deepEqual(f.read(path), {version, preserved: true});
    }
  }
  for (const version of [0, 2, '1', null]) {
    const f = repositoryFixture();
    await assert.rejects(f.store.transaction(tx => tx.write(profile, {version})), /Unsupported account record version/);
    assert.equal(f.calls.some(call => call.method !== 'GET'), false);
  }
  const legacy = repositoryFixture({[profile]: {id: 'alice'}});
  await legacy.store.transaction(tx => tx.write(profile, {id: 'alice', nickname: 'Allowed legacy version'}));
  assert.equal(legacy.read(profile).nickname, 'Allowed legacy version');
});

test('read and write paths reject non-record files before any content or mutation request', async () => {
  const f = repositoryFixture(), state = await f.store.snapshot();
  for (const path of ['README.md', 'config/update-proxy.json', 'users/alice/other.json', 'users/alice/apps/miniapp/credentials.json', 'users/alice/apps/../data.json', 'users/alice/apps/profile/data.json', 'users/alice/apps/UPPER/data.json', 'users/alice/profile.json?ref=other', '../users/_index.json', null]) {
    const before = f.calls.length;
    await assert.rejects(state.read(path), AccountStorageError);
    assert.equal(f.calls.length, before, 'invalid reads never reach GitHub');
    await assert.rejects(f.store.transaction(tx => tx.write(path, {value: true})), AccountStorageError);
  }
  await assert.rejects(f.store.transaction(tx => tx.write('protocol.json', {version: 1})), AccountStorageError);
  assert.equal(f.calls.some(call => call.method !== 'GET'), false);
});

test('null, malformed, non-object and invalid UTF-8 records never fall back to empty data', async () => {
  for (const content of ['null', '{broken', '[]', '"text"', '42', '{"value":1e999}']) {
    const f = repositoryFixture({[brclio]: content}), state = await f.store.snapshot();
    await assert.rejects(state.read(brclio, {preferences: {}}), AccountStorageError, content);
    await assert.rejects(f.store.transaction(async tx => { const value = await tx.read(brclio, {preferences: {}}); tx.write(brclio, value); }), AccountStorageError, content);
    assert.equal(f.calls.some(call => call.method !== 'GET'), false);
  }
  for (const content of ['null', '{broken', '[]']) await assert.rejects(repositoryFixture({'protocol.json': content}).store.snapshot(), AccountStorageError);
  const f = repositoryFixture({}, call => call.path === '/contents/' + brclio ? Response.json({encoding: 'base64', size: 2, content: Buffer.from([0xff, 0xfe]).toString('base64')}) : null);
  await assert.rejects((await f.store.snapshot()).read(brclio), AccountStorageError);
});

test('invalid, lossy or oversized writes abort without creating any Git object', async () => {
  const cycle = {}; cycle.self = cycle;
  const accessor = {}; Object.defineProperty(accessor, 'secret', {enumerable: true, get() { throw new Error('getters must not execute'); }});
  const hidden = {}; Object.defineProperty(hidden, 'hidden', {value: true});
  const symbol = {[Symbol('hidden')]: true};
  for (const value of [null, [], 'text', 5, undefined, {value: undefined}, {value: () => {}}, {value: Symbol()}, {value: 1n}, {value: NaN}, {value: Infinity}, {value: new Date()}, {value: new Map()}, {value: new Set()}, {value: [, 1]}, cycle, accessor, hidden, symbol, {value: '界'.repeat(700000)}]) {
    const f = repositoryFixture();
    await assert.rejects(f.store.transaction(tx => { tx.write(profile, {id: 'alice'}); tx.write(brclio, value); }), AccountStorageError);
    assert.equal(f.calls.some(call => call.method !== 'GET'), false);
    assert.equal(f.updates.length, 0);
  }
});

test('oversized content and malformed GitHub file representations fail closed', async () => {
  for (const file of [
    {...encode('{}'), size: 2 * 1024 * 1024 + 1},
    {...encode('{}'), size: undefined},
    {...encode('{}'), encoding: 'none'},
    {...encode('{}'), content: 'not-base64!'},
    encode('{"value":"' + 'x'.repeat(2 * 1024 * 1024) + '"}')
  ]) {
    const f = repositoryFixture({}, call => call.path === '/contents/' + brclio ? Response.json(file) : null);
    await assert.rejects((await f.store.snapshot()).read(brclio), AccountStorageError);
  }
});

const blobSHA = content => createHash('sha1').update('blob ' + Buffer.byteLength(content) + '\0').update(content).digest('hex');
test('records above 1 MiB read immutable verified Git blobs and remain writable up to 2 MiB', async () => {
  const value = {version: 1, preferences: {theme: 'dark'}, unknown: '界'.repeat(400000)}, raw = JSON.stringify(value), checksum = blobSHA(raw);
  assert.ok(Buffer.byteLength(raw) > 1024 * 1024 && Buffer.byteLength(raw) < 2 * 1024 * 1024);
  const f = repositoryFixture({[brclio]: raw}, call => {
    if (call.path === '/contents/' + brclio) {
      assert.equal(call.ref, 'commit-0');
      assert.equal(call.accept, 'application/vnd.github.object+json');
      return Response.json({type: 'file', encoding: 'none', size: Buffer.byteLength(raw), sha: checksum, content: '', download_url: 'https://untrusted.example/must-not-follow'});
    }
    if (call.path === '/git/blobs/' + checksum) return Response.json({...encode(raw), sha: checksum});
  });
  const state = await f.store.snapshot(), first = await state.read(brclio);
  assert.deepEqual(first, value); first.preferences.theme = 'caller changed';
  assert.deepEqual(await state.read(brclio), value);
  assert.equal(f.calls.filter(call => call.path.startsWith('/git/blobs/')).length, 1, 'one immutable blob fetch per snapshot');
  await f.store.transaction(async tx => { const data = await tx.read(brclio); data.preferences.theme = 'light'; tx.write(brclio, data); });
  assert.equal(f.read(brclio).unknown, value.unknown);
  assert.equal(f.read(brclio).preferences.theme, 'light');
  assert.equal(f.updates.length, 1);
});

test('Git blob fallback rejects unsafe metadata, byte or size mismatches before any mutation', async () => {
  const raw = JSON.stringify({version: 1, preferences: {theme: 'dark'}, unknown: 'x'.repeat(1024 * 1024 + 20)}), checksum = blobSHA(raw);
  const metadata = {type: 'file', encoding: 'none', size: Buffer.byteLength(raw), sha: checksum, content: ''};
  for (const invalid of [{...metadata, sha: '../other'}, {...metadata, sha: 'not-a-sha'}, {...metadata, type: 'symlink'}, {...metadata, size: 2 * 1024 * 1024 + 1}, {...metadata, size: undefined}]) {
    const f = repositoryFixture({}, call => call.path === '/contents/' + brclio ? Response.json(invalid) : null);
    await assert.rejects((await f.store.snapshot()).read(brclio, {}), AccountStorageError);
    assert.equal(f.calls.some(call => call.path.startsWith('/git/blobs/')), false);
  }
  for (const invalid of [
    {...encode(raw), sha: 'a'.repeat(40)}, {...encode(raw), sha: checksum, size: Buffer.byteLength(raw) - 1},
    {...encode(raw.replace('dark', 'fake')), sha: checksum},
    {...encode(raw), sha: checksum, content: Buffer.from(raw + ' ').toString('base64')},
    {encoding: 'none', sha: checksum, size: Buffer.byteLength(raw), content: ''}
  ]) {
    const f = repositoryFixture({}, call => call.path === '/contents/' + brclio ? Response.json(metadata) : call.path === '/git/blobs/' + checksum ? Response.json(invalid) : null);
    await assert.rejects(f.store.transaction(async tx => { const data = await tx.read(brclio, {}); tx.write(brclio, data); }), AccountStorageError);
    assert.equal(f.calls.some(call => call.method !== 'GET'), false);
  }
});

test('transactions read their latest writes and commit all changed files atomically', async () => {
  const f = repositoryFixture({[profile]: {id: 'alice', extensions: {otherApp: true}}, [miniapp]: {keep: ['original']}});
  const result = await f.store.transaction(async tx => {
    const value = await tx.read(profile); value.nickname = 'New name'; tx.write(profile, value);
    value.extensions.otherApp = false;
    assert.equal((await tx.read(profile)).extensions.otherApp, true, 'mutating caller data after write cannot alter pending content');
    const read = await tx.read(profile); read.nickname = 'Second name'; tx.write(profile, read);
    read.nickname = 'caller changed';
    assert.equal((await tx.read(profile)).nickname, 'Second name');
    tx.write(brclio, {version: 1, preferences: {theme: 'dark'}});
    assert.deepEqual(await tx.read(brclio), {version: 1, preferences: {theme: 'dark'}});
    return 'saved';
  });
  assert.equal(result, 'saved'); assert.equal(f.updates.length, 1);
  assert.equal(f.calls.filter(call => call.path === '/git/trees').length, 1);
  assert.equal(f.calls.filter(call => call.path === '/git/commits').length, 1);
  assert.deepEqual(f.read(profile), {id: 'alice', nickname: 'Second name', extensions: {otherApp: true}});
  assert.deepEqual(f.read(miniapp), {keep: ['original']});
  assert.equal(f.updates[0].has(brclio), true);
  assert.equal(JSON.parse(f.updates[0].get(profile)).nickname, 'Second name');
});

test('concurrent application transactions reread current data and preserve each other and unknown fields', async () => {
  const index = 'users/_index.json', f = repositoryFixture({[index]: {version: 1, count: 0, unknown: {preserve: true}}, [miniapp]: {version: 1, retain: true}});
  let entered = 0, release;
  const bothReading = new Promise(resolve => { release = resolve; });
  const attempts = [0, 0];
  await Promise.all([brclio, miniapp].map((path, app) => f.store.transaction(async tx => {
    attempts[app]++;
    const latest = await tx.read(index);
    if (attempts[app] === 1) { if (++entered === 2) release(); await bothReading; }
    latest.count++; tx.write(index, latest);
    const data = await tx.read(path, {version: 1}); data.updatedBy = app; tx.write(path, data);
  })));
  assert.equal(attempts[0] + attempts[1], 3, 'one stale mutation is rerun against the winning commit');
  assert.deepEqual(f.read(index), {version: 1, count: 2, unknown: {preserve: true}});
  assert.deepEqual(f.read(brclio), {version: 1, updatedBy: 0});
  assert.deepEqual(f.read(miniapp), {version: 1, retain: true, updatedBy: 1});
  assert.equal(f.updates.length, 2);
  assert.equal(f.calls.filter(call => call.path === '/git/refs/heads/main').length, 3);
});

test('four ref conflicts fail without publishing any partial mutation', async () => {
  const f = repositoryFixture({[profile]: {id: 'alice'}}, call => call.path === '/git/refs/heads/main' ? new Response(null, {status: 409}) : null);
  let mutations = 0;
  await assert.rejects(f.store.transaction(tx => { mutations++; tx.write(profile, {id: 'changed'}); tx.write(brclio, {updated: true}); }), /Concurrent account update/);
  assert.equal(mutations, 4); assert.equal(f.updates.length, 0);
  assert.deepEqual(f.read(profile), {id: 'alice'}); assert.equal(f.current().has(brclio), false);
});

test('network failures and non-conflict server errors are not blindly retried', async () => {
  for (const failure of ['read', 'tree', 'commit', 'ref', 'ref-status']) {
    const target = {read: '/contents/' + profile, tree: '/git/trees', commit: '/git/commits', ref: '/git/refs/heads/main', 'ref-status': '/git/refs/heads/main'}[failure];
    const f = repositoryFixture({[profile]: {id: 'alice'}}, call => {
      if (call.path !== target) return null;
      if (failure === 'ref-status') return new Response(null, {status: 503});
      throw new Error('simulated network failure');
    });
    let mutations = 0;
    await assert.rejects(f.store.transaction(async tx => { mutations++; const value = await tx.read(profile); value.nickname = 'New'; tx.write(profile, value); }));
    assert.equal(mutations, 1, failure); assert.equal(f.updates.length, 0, failure);
    assert.equal(f.calls.filter(call => call.path === target).length, 1, failure);
    assert.deepEqual(f.read(profile), {id: 'alice'}, failure);
  }
});

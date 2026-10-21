import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleAccountData} from '../src/account-data.js';

function fixture() {
  const session = {id: 'user-a', sessionKey: 'session', mode: 'native', exp: Math.floor(Date.now() / 1000) + 600};
  const files = new Map([['users/user-a/credentials.json', {sessions: {session: {mode: session.mode, exp: session.exp}}}]]);
  let queue = Promise.resolve();
  const read = async (path, fallback = null) => structuredClone(files.has(path) ? files.get(path) : fallback);
  const store = {
    snapshot: async () => ({read}),
    transaction(mutate) {
      const result = queue.then(async () => {
        const writes = new Map();
        const value = await mutate({read, write: (path, value) => writes.set(path, structuredClone(value))});
        for (const [path, value] of writes) files.set(path, value);
        return value;
      });
      queue = result.catch(() => {}); return result;
    }
  };
  const call = (path = 'apps/miniapp/data', method = 'GET', input) => handleAccountData({path: '/api/account/' + path, request: {method}, input, session, store, preferencesValue: value => value && typeof value === 'object' ? value : null});
  return {session, files, call};
}
test('miniapp starts empty and a signed account writes only its application folder', async () => {
  const f = fixture();
  assert.deepEqual(await (await f.call()).json(), {userId: 'user-a', appId: 'miniapp', version: 1, revision: 0, data: {}, updatedAt: null});
  const response = await f.call(undefined, 'PUT', {revision: 0, data: {preferences: {sound: true}, history: []}, userId: 'user-b'});
  assert.equal(response.status, 200); assert.equal((await response.json()).revision, 1);
  assert.ok(f.files.has('users/user-a/apps/miniapp/data.json'));
  assert.equal(f.files.has('users/user-b/apps/miniapp/data.json'), false);
  assert.equal(f.files.has('users/user-a/apps/brclio/data.json'), false);
});
test('two devices with the same revision cannot silently overwrite a snapshot', async () => {
  const f = fixture();
  const responses = await Promise.all([1, 2].map(value => f.call(undefined, 'PUT', {revision: 0, data: {value}})));
  assert.deepEqual(responses.map(value => value.status).sort(), [200, 409]);
  assert.equal(f.files.get('users/user-a/apps/miniapp/data.json').revision, 1);
  assert.equal((await responses.find(value => value.status === 409).json()).code, 'REVISION_CONFLICT');
});
test('app updates preserve unknown fields recursively and replace explicit arrays', async () => {
  const f = fixture(), path = 'users/user-a/apps/miniapp/data.json';
  f.files.set(path, {version: 1, revision: 4, futureEnvelope: 'keep', data: {future: true, preferences: {futureOption: 'keep', sound: false}, history: [1, 2]}, updatedAt: null});
  assert.equal((await f.call(undefined, 'PUT', {revision: 4, data: {preferences: {sound: true}, history: [3]}})).status, 200);
  const value = f.files.get(path);
  assert.equal(value.futureEnvelope, 'keep');
  assert.deepEqual(value.data, {future: true, preferences: {futureOption: 'keep', sound: true}, history: [3]});
});
test('malformed data, missing revision, unknown application and oversized merged data fail without a write', async () => {
  const f = fixture();
  for (const input of [{data: {}}, {revision: -1, data: {}}, {revision: 0, data: []}, {revision: 0, data: JSON.parse('{"__proto__":{"x":1}}')}, {revision: 0, data: {text: '中'.repeat(5000)}}]) assert.equal((await f.call(undefined, 'PUT', input)).status, 400);
  assert.equal((await f.call('apps/another/data')).status, 404);
  assert.equal((await f.call('apps/../data')).status, 404);
  assert.equal(f.files.size, 1);
  f.files.set('users/user-a/apps/miniapp/data.json', {version: 1, revision: 1, data: {old: 'a'.repeat(9000)}, updatedAt: null});
  assert.equal((await f.call(undefined, 'PUT', {revision: 1, data: {new: 'b'.repeat(9000)}})).status, 400);
  assert.equal(f.files.get('users/user-a/apps/miniapp/data.json').revision, 1);
});
test('logout between authentication and commit prevents the write', async () => {
  const f = fixture(); f.files.get('users/user-a/credentials.json').sessions = {};
  assert.equal((await f.call(undefined, 'PUT', {revision: 0, data: {value: 1}})).status, 401);
  assert.equal(f.files.size, 1);
});
test('miniapp validates known business data after merging while preserving future fields', async () => {
  const f = fixture(), duel = {preferences: {targetScore: 3, haptics: true, names: ['A', 'B'], future: true}, matches: [], future: 'keep'};
  assert.equal((await f.call(undefined, 'PUT', {revision: 0, data: {duel}})).status, 200);
  assert.equal((await f.call(undefined, 'PUT', {revision: 1, data: {duel: {preferences: {targetScore: 999}}}})).status, 400);
  assert.equal((await f.call(undefined, 'PUT', {revision: 1, data: {duel: {matches: [{id: 'bad'}]}}})).status, 400);
  assert.equal(f.files.get('users/user-a/apps/miniapp/data.json').revision, 1);
  assert.equal((await f.call(undefined, 'PUT', {revision: 1, data: {duel: {preferences: {haptics: false}}}})).status, 200);
  const saved = f.files.get('users/user-a/apps/miniapp/data.json').data.duel;
  assert.equal(saved.future, 'keep'); assert.equal(saved.preferences.future, true); assert.equal(saved.preferences.haptics, false);
});
test('corrupt or unsupported records never become empty data', async () => {
  const f = fixture();
  f.files.set('users/user-a/apps/miniapp/data.json', {version: 2, revision: 1, data: {keep: true}});
  await assert.rejects(f.call(), /Invalid app data/);
  await assert.rejects(f.call(undefined, 'PUT', {revision: 0, data: {}}), /Invalid app data/);
  f.files.set('users/user-a/apps/brclio/data.json', {version: 2, preferences: {}});
  f.files.set('users/user-a/data.json', {version: 1, preferences: {quoteMode: 'double'}});
  await assert.rejects(f.call('data'), /Invalid Brclio data/);
});
test('legacy Brclio data migrates on write while the original and unknown fields survive', async () => {
  const f = fixture(), legacy = {version: 1, preferences: {quoteMode: 'double', future: 'keep'}, futureEnvelope: true, updatedAt: null};
  f.files.set('users/user-a/data.json', structuredClone(legacy));
  assert.equal((await (await f.call('data')).json()).preferences.quoteMode, 'double');
  assert.equal((await f.call('data', 'PUT', {preferences: {quoteMode: 'auto'}, revision: 0})).status, 200);
  assert.deepEqual(f.files.get('users/user-a/data.json'), legacy);
  const value = f.files.get('users/user-a/apps/brclio/data.json');
  assert.deepEqual(value.preferences, {quoteMode: 'auto', future: 'keep'}); assert.equal(value.futureEnvelope, true);
  assert.equal((await f.call('data', 'PUT', {preferences: {quoteMode: 'none'}, revision: 0})).status, 409);
});

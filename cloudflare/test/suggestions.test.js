import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleAccount} from '../src/accounts.js';
import {digest, seal} from '../src/accounts-crypto.js';
import {indexHeadPath as feedbackHead} from '../src/feedback-store.js';
import {headPath} from '../src/suggestion-store.js';
import {repositoryFixture} from './fixtures/private-record-store.js';

const origin = 'https://tools.brclio.com', endpoint = origin + '/api/account/suggestions';
const topic = {requestId: crypto.randomUUID(), title: '批量复制', description: '希望一次处理多条路径'};
const allow = {limit: async () => ({success: true})};

async function fixture(initial = {}, intercept) {
  const repo = repositoryFixture(initial, intercept, 'suggestions');
  const env = {SESSION_SECRET: 'feature-suggestions-test-session-secret', ACCOUNT_LIMITER: allow, ACCOUNT_AUTH_LIMITER: allow};
  const accounts = new Map();
  const accountStore = {snapshot: async () => ({read: async path => accounts.get(path)})};
  const sessions = {};
  for (const [who, mode] of [['alice', 'web'], ['bob', 'native']]) {
    const sid = crypto.randomUUID(), csrf = crypto.randomUUID(), id = 'account-' + who, exp = Math.floor(Date.now() / 1000) + 3600;
    const token = await seal({typ: 'account', sid, id, csrf, mode, exp}, env.SESSION_SECRET);
    accounts.set('users/' + id + '/credentials.json', {sessions: {[await digest(sid)]: {mode, exp}}});
    accounts.set('users/' + id + '/profile.json', {id, email: who + '@private.test', username: who, nickname: who === 'alice' ? '小甲' : ''});
    sessions[who] = mode === 'web' ? {Cookie: '__Host-brclio_user=' + token, Origin: origin, 'X-CSRF-Token': csrf} : {Authorization: 'Bearer ' + token, 'X-Brclio-Client': 'native'};
  }
  const call = (who, method, path = '', body, headers = {}) => handleAccount(new Request(endpoint + path, {
    method, headers: {'Content-Type': 'application/json', ...(sessions[who] || {Origin: origin}), ...headers},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})
  }), env, {accountStore, suggestionStore: repo.store});
  return {repo, call, accounts};
}
async function success(response) {
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
}

test('all accounts see the same suggestions, comments and atomic half-star totals across concurrent writes and retries', async () => {
  const f = await fixture({[feedbackHead]: {version: 1, page: 1}, 'feedback/v1/index/00000001.json': {version: 1, items: [{title: '私人诊断记录'}]}});
  const path = '/' + topic.requestId;
  const create = () => f.call('alice', 'POST', '', {...topic, author: '冒用', ratingCount: 99});
  const results = await Promise.all([create(), create()]);
  for (const result of results) {
    const {suggestion} = await success(result);
    assert.equal(suggestion.author, '小甲'); assert.equal(suggestion.category, '');
    assert.equal(suggestion.averageRating, null); assert.equal(suggestion.ratingCount, 0);
  }
  assert.equal(f.repo.updates.length, 1);
  assert.equal((await f.call('bob', 'POST', '', topic)).status, 409);
  assert.equal((await f.call('alice', 'POST', '', {...topic, title: '新内容'})).status, 409);

  const ratings = await Promise.all([
    f.call('alice', 'PUT', path + '/rating', {rating: 0.5}),
    f.call('bob', 'PUT', path + '/rating', {rating: 5})
  ]);
  for (const response of ratings) await success(response);
  const detail = await success(await f.call('alice', 'GET', path));
  assert.equal(detail.suggestion.ratingCount, 2); assert.equal(detail.suggestion.averageRating, 2.75); assert.equal(detail.suggestion.myRating, 0.5);
  const changed = await success(await f.call('alice', 'PUT', path + '/rating', {rating: 2}));
  assert.equal(changed.suggestion.averageRating, 3.5); assert.equal(changed.suggestion.ratingCount, 2);
  const commits = f.repo.updates.length;
  await success(await f.call('alice', 'PUT', path + '/rating', {rating: 2}));
  assert.equal(f.repo.updates.length, commits);

  const input = {requestId: crypto.randomUUID(), text: '可以支持空格吗？', author: '管理员'};
  const comment = () => f.call('bob', 'POST', path + '/comments', input);
  const comments = await Promise.all([comment(), comment(), f.call('alice', 'POST', path + '/comments', {requestId: crypto.randomUUID(), text: '我也需要'})]);
  for (const response of comments) await success(response);
  assert.equal((await f.call('alice', 'POST', path + '/comments', input)).status, 409);
  assert.equal((await f.call('bob', 'POST', path + '/comments', {...input, text: '不同的评论'})).status, 409);
  const other = await success(await f.call('bob', 'GET', path));
  assert.equal(other.suggestion.myRating, 5); assert.equal(other.suggestion.commentCount, 2);
  assert.equal(other.comments.length, 2); assert.equal(other.comments.find(item => item.id === input.requestId).author, 'bob');
  const listing = await success(await f.call('bob', 'GET'));
  assert.equal(listing.items.length, 1); assert.equal(listing.items[0].commentCount, 2); assert.equal(listing.items[0].averageRating, 3.5);
  for (const data of [listing, other]) assert.doesNotMatch(JSON.stringify(data), /account-alice|account-bob|private\.test|私人诊断记录|ratingUnits|member/);
  assert.deepEqual(f.repo.read(feedbackHead), {version: 1, page: 1});
  const touched = f.repo.calls.filter(call => call.path.startsWith('/contents/'));
  assert.ok(touched.length && touched.every(call => call.path.startsWith('/contents/suggestions/v1/')));
});

test('session, CSRF, account switches and invalid submissions are rejected without mutating storage', async () => {
  const f = await fixture(), path = '/' + topic.requestId;
  for (const [method, suffix, data] of [['GET', ''], ['GET', path], ['POST', '', topic], ['PUT', path + '/rating', {rating: 5}], ['POST', path + '/comments', {requestId: crypto.randomUUID(), text: 'hi'}]]) {
    assert.equal((await f.call(null, method, suffix, data)).status, 401);
  }
  assert.equal((await f.call('alice', 'POST', '', topic, {'X-CSRF-Token': 'stale'})).status, 403);
  assert.equal((await f.call('alice', 'POST', '', topic, {Origin: 'https://foreign.test'})).status, 403);
  assert.equal((await f.call('bob', 'POST', '', {...topic, expectedUserId: 'account-alice'})).status, 409);
  for (const override of [{title: ' '}, {description: '\t'}, {title: '长'.repeat(101)}, {category: '类'.repeat(41)}, {requestId: [topic.requestId]}]) {
    assert.equal((await f.call('alice', 'POST', '', {...topic, ...override})).status, 400);
  }
  for (const rating of [0, 5.5, 2.25, true, '4.5', null]) assert.equal((await f.call('bob', 'PUT', path + '/rating', {rating})).status, 400);
  for (const text of ['', '\t', '长'.repeat(1001)]) assert.equal((await f.call('bob', 'POST', path + '/comments', {requestId: crypto.randomUUID(), text})).status, 400);
  assert.equal((await f.call('alice', 'GET', '?cursor=0')).status, 400);
  assert.equal((await f.call('alice', 'GET', '?cursor=1&cursor=1')).status, 400);
  assert.equal((await f.call('alice', 'GET', '?debug=1')).status, 400);
  assert.equal((await f.call('alice', 'POST', '?cursor=1', topic)).status, 400);
  assert.equal((await f.call('alice', 'GET', '/invalid')).status, 404);
  assert.equal((await f.call('alice', 'PUT', '', {})).status, 405);
  assert.equal(f.repo.calls.length, 0);
  assert.equal((await f.call('alice', 'GET', path)).status, 404);
  assert.equal((await f.call('alice', 'PUT', path + '/rating', {rating: 3})).status, 404);
  assert.equal((await f.call('alice', 'POST', path + '/comments', {text: 'abc', requestId: crypto.randomUUID()})).status, 404);
  assert.equal(f.repo.updates.length, 0);
});

test('suggestions and comments paginate newest first with stable older pages below the native byte limit', async () => {
  const f = await fixture();
  const ids = [];
  for (let i = 0; i < 12; i++) {
    const requestId = crypto.randomUUID(); ids.push(requestId);
    await success(await f.call('alice', 'POST', '', {requestId, title: '名'.repeat(100), category: '类'.repeat(40), description: '议'.repeat(3000)}));
  }
  const newest = await success(await f.call('bob', 'GET'));
  assert.deepEqual(newest.items.map(item => item.id), ids.slice(10).reverse()); assert.equal(newest.nextCursor, 1);
  const first = await success(await f.call('bob', 'GET', '?cursor=1'));
  assert.deepEqual(first.items.map(item => item.id), ids.slice(0, 10).reverse()); assert.equal(first.nextCursor, null);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 128 * 1024);
  assert.equal((await f.call('bob', 'GET', '?cursor=3')).status, 404);
  const comments = [], path = '/' + ids[0];
  for (let i = 0; i < 22; i++) {
    const requestId = crypto.randomUUID(); comments.push(requestId);
    await success(await f.call('bob', 'POST', path + '/comments', {requestId, text: '评'.repeat(1000)}));
  }
  const head = await success(await f.call('alice', 'GET', path));
  assert.deepEqual(head.comments.map(item => item.id), comments.slice(20).reverse()); assert.equal(head.nextCursor, 1);
  const older = await success(await f.call('alice', 'GET', path + '?cursor=1'));
  assert.deepEqual(older.comments.map(item => item.id), comments.slice(0, 20).reverse()); assert.equal(older.nextCursor, null);
  assert.ok(Buffer.byteLength(JSON.stringify(older)) < 128 * 1024);
});

test('unavailable or occupied storage cannot publish partial suggestions or access existing private feedback records', async () => {
  for (const intercept of [call => !call.path ? Response.json({private: false, default_branch: 'main'}) : null,
    call => call.path === '/git/refs/heads/main' ? new Response(null, {status: 409}) : null]) {
    const f = await fixture({}, intercept);
    assert.equal((await f.call('alice', 'POST', '', topic)).status, 503);
    assert.equal(f.repo.updates.length, 0);
  }
  const missing = await fixture({[headPath]: {version: 1, count: 1}});
  assert.equal((await missing.call('alice', 'POST', '', topic)).status, 503); assert.equal(missing.repo.updates.length, 0);
  const f = await fixture();
  await assert.rejects(f.repo.store.transaction(tx => tx.write(feedbackHead, {version: 1})), /Invalid suggestion record path/);
});

test('legacy profile names do not expose contact addresses in public suggestions or comments', async () => {
  const f = await fixture();
  const profile = f.accounts.get('users/account-alice/profile.json');
  profile.nickname = '客服（alice＠private.test）';
  const {suggestion} = await success(await f.call('alice', 'POST', '', topic));
  assert.equal(suggestion.author, 'alice');
  profile.username = 'alice@private.test';
  const {comment} = await success(await f.call('alice', 'POST', '/' + topic.requestId + '/comments', {requestId: crypto.randomUUID(), text: '试一下'}));
  assert.equal(comment.author, 'Brclio 用户');
  const board = await success(await f.call('bob', 'GET', '/' + topic.requestId));
  assert.doesNotMatch(JSON.stringify(board), /private\.test/);
});

test('a comment commit succeeds after two ref conflicts within the free Worker subrequest budget', async () => {
  let conflicts = 0;
  const f = await fixture({}, call => {
    if (call.path === '/git/refs/heads/main' && conflicts > 0) {
      conflicts--;
      return new Response(null, {status: 409});
    }
  });
  await success(await f.call('alice', 'POST', '', topic));
  conflicts = 2;
  const before = f.repo.calls.length;
  const {suggestion} = await success(await f.call('bob', 'POST', '/' + topic.requestId + '/comments', {requestId: crypto.randomUUID(), text: '已使用'}));
  assert.equal(suggestion.commentCount, 1); assert.equal(conflicts, 0);
  // Allow two token issuances, five cold account reads, and two limiter calls.
  assert.ok(f.repo.calls.length - before + 9 <= 50);
});

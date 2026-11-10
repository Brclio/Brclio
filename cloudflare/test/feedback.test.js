import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleAccount} from '../src/accounts.js';
import {digest, seal} from '../src/accounts-crypto.js';
import {handleAdmin as manageFeedback} from '../src/modules/feedback.js';
import {indexHeadPath, indexPagePath, reportDirectory} from '../src/feedback-store.js';
import {repositoryFixture} from './fixtures/private-record-store.js';

const origin = 'https://tools.brclio.com';
const id = '01234567-89ab-4cde-9234-a56789012345';
const input = {requestId: id, title: '解析失败', description: '跳转被拦截', category: 'download', appVersion: '0.2.9', platform: 'darwin'};
const endpoint = '/api/account/feedback', admin = '/api/admin/feedback';
const allow = {limit: async () => ({success: true})};

async function fixture({initial = {}, intercept, mode = 'native', userId = 'account-123'} = {}) {
  const repo = repositoryFixture(initial, intercept, 'feedback');
  const secret = 'feedback-test-secret-must-be-long-enough';
  const env = {SESSION_SECRET: secret, ACCOUNT_LIMITER: allow, ACCOUNT_AUTH_LIMITER: allow};
  const sid = 'test-session-id', csrf = 'test-csrf', exp = Math.floor(Date.now() / 1000) + 3600;
  const token = await seal({typ: 'account', id: userId, sid, csrf, mode, exp}, secret);
  const credentials = {sessions: {[await digest(sid)]: {mode, exp}}};
  const accountStore = {snapshot: async () => ({read: async path => {
    if (path === `users/${userId}/credentials.json`) return credentials;
    if (path === `users/${userId}/profile.json`) return {id: userId, email: 'private@example.com', username: 'private-account'};
    throw new Error('Unexpected account path');
  }}), transaction: () => { throw new Error('Feedback must not mutate account storage'); }};
  const deps = {accountStore, feedbackStore: repo.store};
  const request = (path, method, body, headers = {}) => new Request(origin + path, {
    method, headers: {'Content-Type': 'application/json', ...headers}, ...(body === undefined ? {} : {body: JSON.stringify(body)})
  });
  const headers = mode === 'native' ? {Authorization: 'Bearer ' + token, 'X-Brclio-Client': 'native'}
    : {Origin: origin, Cookie: '__Host-brclio_user=' + token, 'X-CSRF-Token': csrf};
  const submit = (body, auth = headers) => handleAccount(request(endpoint, 'POST', body, auth), env, deps);
  const manage = (path = '', method = 'GET', body) => manageFeedback(request(admin + path, method, body), env, {}, deps);
  return {repo, submit, manage, headers};
}

test('feedback uploads are atomic, idempotent, seven-day bounded and server-sanitized; admin revisions preserve history', async () => {
  const f = await fixture({initial: {'README.md': 'original README'}});
  const day = 86400000, at = n => new Date(Date.now() - n * day - 5000).toISOString();
  const log = (time, action = 'xhs.parse') => ({time, action, level: 'ERROR', fields: {code: 'XHS_URL_PROTOCOL', stage: 'redirect',
    engine: 'node', protocol: 'http', hop: 1, host: 'www.xiaohongshu.com', token: 'private-flag', stderr: 'raw path', status: 302}});
  const data = {...input, userId: 'attacker', description: 'see https://user:password@example.com/abc?xsec_token=private-flag\nCookie: private-flag\n/home/private-flag/debug.log',
    logs: [log(at(0)), log(at(6), 'xhs.openDirectory'), log(at(8)), log(at(-1))]};
  const submitted = await Promise.all([f.submit(data), f.submit(data)]);
  for (const response of submitted) { assert.equal(response.status, 200); assert.equal((await response.json()).id, id); }
  assert.equal(f.repo.updates.length, 1);
  const directory = reportDirectory(id);
  const stored = f.repo.read(directory + '/report.json');
  assert.equal(stored.userId, 'account-123'); assert.equal(stored.logCount, 2);
  assert.deepEqual(stored.logDays, [data.logs[1].time.slice(0, 10), data.logs[0].time.slice(0, 10)]);
  const files = f.repo.current();
  assert.equal(files.get('README.md'), 'original README');
  assert.deepEqual([...files.keys()].sort(), ['README.md', indexHeadPath, indexPagePath(1), directory + '/report.json', directory + '/history/000001.json',
    ...stored.logDays.map(date => directory + '/logs/' + date + '.json')].sort());
  const raw = [...files.values()].join('\n');
  for (const secret of ['private-flag', 'user:password', 'private@example.com', 'private-account', 'raw path']) assert.ok(!raw.includes(secret));
  assert.equal(f.repo.read(directory + '/logs/' + stored.logDays[1] + '.json').entries[0].fields.hop, 1);
  assert.equal((await f.submit({...data, title: 'different'})).status, 409);
  const first = await (await f.manage()).json();
  assert.equal(first.items[0].title, input.title); assert.equal(first.nextCursor, null);
  const details = await (await f.manage('/' + id)).json();
  assert.equal(details.logs.length, 2); assert.equal(details.logs[0].action, 'xhs.openDirectory');
  assert.equal(details.report.repositoryPath, directory);
  const revision = details.report.revision;
  const [a, b] = await Promise.all([f.manage('/' + id, 'PUT', {revision, status: 'resolved', note: 'Fixed ghp_secret123456789'}),
    f.manage('/' + id, 'PUT', {revision, status: 'in_progress', note: 'Started'})]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const changed = await (await f.manage('/' + id)).json();
  assert.equal(changed.history.length, 2); assert.equal(changed.report.revision, 1);
  assert.ok(!JSON.stringify(changed).includes('ghp_secret'));
  assert.equal((await (await f.manage()).json()).items[0].status, changed.report.status);
});

test('protected submission refuses missing login, CSRF, invalid inputs and oversized payloads without repository writes', async () => {
  const f = await fixture({mode: 'web'});
  assert.equal((await f.submit(input, {Origin: origin})).status, 401);
  assert.equal((await f.submit(input, {...f.headers, 'X-CSRF-Token': 'stale'})).status, 403);
  assert.equal((await f.submit(input, {...f.headers, Origin: 'https://attacker.test'})).status, 403);
  for (const invalid of [{requestId: [id]}, {category: 'constructor'}, {title: ''}, {logs: [{time: 'bad'}]}, {logs: Array(1793).fill({})}]) {
    assert.equal((await f.submit({...input, ...invalid})).status, 400);
  }
  assert.equal((await f.submit({...input, extra: 'x'.repeat(1024 * 1024)})).status, 413);
  assert.equal(f.repo.calls.length, 0);
  assert.equal((await f.submit(input)).status, 200);
});

test('storage failures cannot publish partial feedback or redirect writes to account or program repositories', async () => {
  for (const intercept of [call => !call.path ? Response.json({private: false, default_branch: 'main'}) : null,
    call => call.path === '/git/refs/heads/main' ? new Response(null, {status: 409}) : null]) {
    const f = await fixture({intercept});
    assert.equal((await f.submit(input)).status, 503); assert.equal(f.repo.updates.length, 0);
    assert.equal(f.repo.current().size, 0);
  }
  const f = await fixture();
  await assert.rejects(f.repo.store.transaction(tx => tx.write('users/_index.json', {version: 1})), /Invalid feedback record path/);
});

test('feedback index flips to a bounded new page without rewriting older pages and history continues across page boundaries', async () => {
  const mockRows = Array.from({length: 40}, (_, i) => ({id: String(i), status: 'open'}));
  const f = await fixture({initial: {[indexHeadPath]: {version: 1, page: 1}, [indexPagePath(1)]: {version: 1, items: mockRows}}});
  assert.equal((await f.submit(input)).status, 200);
  assert.equal((await (await f.manage()).json()).nextCursor, 1);
  const previous = await (await f.manage('?cursor=1')).json();
  assert.deepEqual(previous.items, mockRows); assert.equal(previous.nextCursor, null);
  assert.equal((await f.manage('?cursor=3')).status, 404);
  assert.equal((await f.manage('?cursor=__proto__')).status, 400);
  const directory = reportDirectory(id);
  const entries = Array(50).fill({at: '2026-11-10T00:00:00Z', status: 'open', note: '', actor: 'admin'});
  await f.repo.store.transaction(async tx => {
    const report = await tx.read(directory + '/report.json');
    tx.write(directory + '/report.json', {...report, revision: 49});
    tx.write(directory + '/history/000001.json', {version: 1, entries});
  });
  assert.equal((await f.manage('/' + id, 'PUT', {revision: 49, status: 'resolved', note: 'done'})).status, 200);
  const current = await (await f.manage('/' + id)).json(), older = await (await f.manage('/' + id + '?historyCursor=1')).json();
  assert.equal(current.nextHistoryCursor, 1); assert.equal(current.history[0].note, 'done'); assert.deepEqual(older.history, entries);
});

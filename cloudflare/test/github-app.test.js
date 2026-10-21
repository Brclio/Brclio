import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, verify} from 'node:crypto';
import {GitHubAppAuthenticationError, githubInstallationToken} from '../src/github-app.js';

const pair = generateKeyPairSync('rsa', {modulusLength: 2048});
const rotated = generateKeyPairSync('rsa', {modulusLength: 2048});
const pem = pair.privateKey.export({type: 'pkcs8', format: 'pem'}).toString();
const pkcs1 = pair.privateKey.export({type: 'pkcs1', format: 'pem'}).toString();
let sequence = 0;
const fixture = (overrides = {}) => ({GITHUB_APP_ID: String(20000 + ++sequence), GITHUB_APP_INSTALLATION_ID: '910001', GITHUB_APP_PRIVATE_KEY: pem, ...overrides});
const token = (n = 1) => 'ghs_' + String(n).padStart(40, '0');
const payload = (overrides = {}) => ({token: token(), expires_at: new Date(Date.now() + 3600000).toISOString(), ...overrides});
const decode = value => JSON.parse(Buffer.from(value, 'base64url').toString());
function sanitized(error) {
  assert.ok(error instanceof GitHubAppAuthenticationError);
  assert.equal(error.message, 'GitHub App authentication unavailable');
  assert.equal(error.cause, undefined);
  assert.ok(!String(error).includes('PRIVATE KEY'));
  assert.ok(!String(error).includes('ghs_'));
  return true;
}

test('App JWT uses verified RS256 signature, short claims and exact repository contents scope', async () => {
  const env = fixture(), repository = 'BrclioData/BrclioUserData';
  let calls = 0;
  const issued = await githubInstallationToken(env, repository, async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.github.com/app/installations/910001/access_tokens');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Accept, 'application/vnd.github+json');
    assert.equal(options.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.deepEqual(JSON.parse(options.body), {repositories: ['BrclioUserData'], permissions: {contents: 'write'}});
    const parts = options.headers.Authorization.replace(/^Bearer /, '').split('.');
    assert.equal(parts.length, 3);
    assert.deepEqual(decode(parts[0]), {alg: 'RS256', typ: 'JWT'});
    const claims = decode(parts[1]), now = Math.floor(Date.now() / 1000);
    assert.equal(claims.iss, env.GITHUB_APP_ID);
    assert.ok(claims.iat >= now - 61 && claims.iat <= now - 60);
    assert.ok(claims.exp > now && claims.exp <= now + 540);
    assert.ok(verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), pair.publicKey, Buffer.from(parts[2], 'base64url')));
    return Response.json(payload({permissions: {contents: 'write', metadata: 'read'}, repository_selection: 'selected', repositories: [{full_name: repository}]}));
  });
  assert.equal(issued, token()); assert.equal(calls, 1);
});

test('GitHub PKCS1 download and PKCS8 keys both sign valid App JWTs, including escaped newlines', async () => {
  for (const key of [pkcs1, pem, pkcs1.replace(/\n/g, '\\n')]) {
    const env = fixture({GITHUB_APP_PRIVATE_KEY: key});
    let called = false;
    const value = await githubInstallationToken(env, 'test/keys', async (_url, options) => {
      called = true;
      const parts = options.headers.Authorization.slice(7).split('.');
      assert.ok(verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), pair.publicKey, Buffer.from(parts[2], 'base64url')));
      return Response.json(payload());
    });
    assert.equal(value, token()); assert.equal(called, true);
  }
});

test('concurrent callers share one token exchange and reuse its cached credential', async () => {
  const env = fixture(); let count = 0, enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const fetchImpl = async () => { count++; enter(); await gate; return Response.json(payload()); };
  const pending = Promise.all(Array.from({length: 8}, () => githubInstallationToken(env, 'test/singleflight', fetchImpl)));
  await entered; assert.equal(count, 1); release();
  assert.deepEqual(await pending, Array(8).fill(token()));
  assert.equal(await githubInstallationToken(env, 'test/singleflight', fetchImpl), token());
  assert.equal(count, 1);
});

test('cache refreshes at expires_at minus sixty seconds', async context => {
  let now = Date.parse('2026-10-21T02:00:00Z'), count = 0;
  context.mock.method(Date, 'now', () => now);
  const env = fixture(), fetchImpl = async () => Response.json(payload({token: token(++count)}));
  assert.equal(await githubInstallationToken(env, 'test/expiry', fetchImpl), token(1));
  now += 3539000;
  assert.equal(await githubInstallationToken(env, 'test/expiry', fetchImpl), token(1));
  now += 1000;
  assert.equal(await githubInstallationToken(env, 'test/expiry', fetchImpl), token(2));
  assert.equal(count, 2);
});

test('repository, owner, app, installation and key rotation have independent cache scopes', async () => {
  const env = fixture(); let count = 0;
  const fetchImpl = async () => Response.json(payload({token: token(++count)}));
  const scopes = [
    [env, 'owner/repo'], [env, 'owner/other'], [env, 'another-owner/repo'],
    [{...env, GITHUB_APP_ID: '731000'}, 'owner/repo'],
    [{...env, GITHUB_APP_INSTALLATION_ID: '999002'}, 'owner/repo'],
    [{...env, GITHUB_APP_PRIVATE_KEY: rotated.privateKey.export({type: 'pkcs8', format: 'pem'}).toString()}, 'owner/repo']
  ];
  for (let index = 0; index < scopes.length; index++) {
    assert.equal(await githubInstallationToken(...scopes[index], fetchImpl), token(index + 1));
  }
  assert.equal(await githubInstallationToken(env, 'OWNER/REPO', fetchImpl), token(1));
  assert.equal(count, scopes.length);
});

test('missing or invalid App configuration and repositories fail without network or personal-token fallback', async () => {
  const base = fixture(); let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('must not fetch'); };
  for (const env of [
    {}, {GITHUB_TOKEN: 'personal-token-must-not-work'},
    {...base, GITHUB_APP_ID: undefined}, {...base, GITHUB_APP_INSTALLATION_ID: undefined}, {...base, GITHUB_APP_PRIVATE_KEY: undefined},
    {...base, GITHUB_APP_ID: '0'}, {...base, GITHUB_APP_ID: ' 123'}, {...base, GITHUB_APP_ID: '12/path'},
    {...base, GITHUB_APP_INSTALLATION_ID: '-1'}, {...base, GITHUB_APP_INSTALLATION_ID: '1?redirect'},
    {...base, GITHUB_APP_PRIVATE_KEY: 'PRIVATE KEY malicious-value'},
    {...base, GITHUB_APP_PRIVATE_KEY: pair.publicKey.export({type: 'spki', format: 'pem'}).toString()},
    {...base, GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\n' + 'A'.repeat(512) + '\n-----END PRIVATE KEY-----'},
    {...base, GITHUB_APP_PRIVATE_KEY: pem.repeat(20)}
  ]) await assert.rejects(githubInstallationToken(env, 'owner/repo', fetchImpl), sanitized);
  for (const repository of ['', '../repo', 'owner/..', 'owner/repo/extra', 'owner/repo?ref=main', 'owner%2frepo', null]) {
    await assert.rejects(githubInstallationToken(base, repository, fetchImpl), sanitized);
  }
  assert.equal(calls, 0);
});

test('redirects, HTTP failures, network failures and invalid API JSON expose one sanitized error', async () => {
  for (const status of [301, 302, 307, 308, 401, 403, 404, 422, 500]) {
    await assert.rejects(githubInstallationToken(fixture(), 'test/failure', async (_url, options) => {
      assert.equal(options.redirect, 'manual');
      return new Response('sensitive-provider-response', {status, headers: {Location: 'https://untrusted.test/private'}});
    }), sanitized);
  }
  await assert.rejects(githubInstallationToken(fixture(), 'test/network', async () => { throw new Error(pem + token()); }), sanitized);
  await assert.rejects(githubInstallationToken(fixture(), 'test/json', async () => new Response('{sensitive-broken-token')), sanitized);
});

test('expired, near expiry, excessive lifetime or malformed installation tokens are rejected', async () => {
  const invalid = [
    {token: undefined}, {token: 'github_pat_personal-token-is-not-an-installation-token'}, {token: 'ghs_short'},
    {token: token() + '\n'}, {token: 'ghs_' + 'a'.repeat(16384)},
    {expires_at: undefined}, {expires_at: 'not-a-date'}, {expires_at: '2026-99-99T00:00:00Z'},
    {expires_at: new Date(Date.now() - 1000).toISOString()},
    {expires_at: new Date(Date.now() + 30000).toISOString()},
    {expires_at: new Date(Date.now() + 66 * 60000).toISOString()},
    {permissions: {contents: 'read'}}, {permissions: {contents: 'write', issues: 'write'}},
    {repository_selection: 'all'}, {repositories: [{full_name: 'wrong-owner/repo'}]}, {repositories: []}
  ];
  for (const overrides of invalid) await assert.rejects(githubInstallationToken(fixture(), 'test/repo', async () => Response.json(payload(overrides))), sanitized);
});

test('current stateless installation tokens remain opaque and accept the documented long JWT alphabet', async () => {
  const modern = 'ghs_12345_' + Buffer.from('{"alg":"RS256"}').toString('base64url') + '.' +
    Buffer.from(JSON.stringify({opaque: 'x'.repeat(350)})).toString('base64url') + '.signature_With-hyphen';
  assert.ok(modern.length > 520);
  assert.equal(await githubInstallationToken(fixture(), 'test/stateless', async () => Response.json(payload({token: modern}))), modern);
});

test('a failed exchange does not poison the cache or singleflight for a later retry', async () => {
  const env = fixture(); let count = 0;
  const fetchImpl = async () => {
    count++;
    if (count === 1) throw new Error('sensitive-network-body');
    return Response.json(payload({token: token(2)}));
  };
  const failures = await Promise.allSettled(Array.from({length: 5}, () => githubInstallationToken(env, 'test/retry', fetchImpl)));
  assert.ok(failures.every(result => result.status === 'rejected' && sanitized(result.reason)));
  assert.equal(count, 1);
  assert.equal(await githubInstallationToken(env, 'test/retry', fetchImpl), token(2));
  assert.equal(count, 2);
});

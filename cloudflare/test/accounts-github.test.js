import test from 'node:test';
import assert from 'node:assert/strict';
import {githubIdentity} from '../src/accounts-github.js';

const callback = 'https://tools.brclio.com/api/account/github/callback';
const env = {GITHUB_OAUTH_CLIENT_ID: 'test-client', GITHUB_OAUTH_CLIENT_SECRET: 'test-secret'};
const token = {access_token: 'test-access', token_type: 'bearer', refresh_token: 'test-refresh'};
const profile = {id: 42, login: 'mutable-name', email: 'public@example.com', avatar_url: 'https://avatars.githubusercontent.com/u/42'};
const email = {email: 'Private@Example.com', primary: true, verified: true};
function exchange(...replies) {
  const calls = [];
  const promise = githubIdentity('test-code', 'test-verifier', callback, env, async (url, options) => {
    calls.push({url, options});
    const reply = replies.shift();
    assert.notEqual(reply, undefined, 'unexpected GitHub request');
    return reply instanceof Response ? reply : Response.json(reply);
  });
  return {calls, promise};
}

test('exchanges the code with PKCE, reads the verified private primary email, and returns only the identity', async () => {
  const {calls, promise} = exchange(token, profile, Array(100).fill({...email, primary: false}), [email]);
  assert.deepEqual(await promise, {sub: '42', email: 'private@example.com', picture: profile.avatar_url});
  assert.deepEqual(calls.map(call => call.url), [
    'https://github.com/login/oauth/access_token', 'https://api.github.com/user',
    'https://api.github.com/user/emails?per_page=100&page=1', 'https://api.github.com/user/emails?per_page=100&page=2'
  ]);
  const start = calls[0].options;
  assert.equal(start.method, 'POST');
  assert.deepEqual(Object.fromEntries(start.body), {client_id: 'test-client', client_secret: 'test-secret',
    code: 'test-code', code_verifier: 'test-verifier', redirect_uri: callback});
  for (const {options} of calls) assert.equal(options.redirect, 'manual');
  for (const {options} of calls.slice(1)) assert.equal(options.headers.Authorization, 'Bearer test-access');
});

test('requires a positive numeric ID and a verified primary email even if the public profile supplies an email', async () => {
  await assert.rejects(exchange(token, {...profile, id: 0}).promise, /account ID/);
  for (const records of [[], [{...email, primary: false}], [{...email, verified: false}], [{...email, verified: 'true'}]]) {
    await assert.rejects(exchange(token, profile, records).promise, /verified primary email/);
  }
});

test('stops on a rejected exchange, provider redirect or invalid token without using a different host', async () => {
  const redirect = () => new Response(null, {status: 302, headers: {Location: 'https://other.example/path'}});
  for (const replies of [[redirect()], [{error: 'bad_verification_code'}], [token, redirect()], [token, profile, redirect()]]) {
    const {calls, promise} = exchange(...replies);
    await assert.rejects(promise, /GitHub/);
    assert.equal(calls.length, replies.length);
  }
});

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { downloadBaseline } = require('./windows-installer-smoke.cjs');

const bytes = Buffer.from('official baseline NSIS fixture');
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
const assetName = 'Brclio-0.1.2-windows-x64.exe';
const prefix = 'https://github.com/Brclio/Brclio/releases/download/v0.1.2/';
const release = { tag_name: 'v0.1.2', draft: false, prerelease: false, assets: [
  { name: assetName, size: bytes.length, browser_download_url: prefix + assetName, digest: `sha256:${digest}` },
  { name: 'SHA256SUMS.txt', browser_download_url: prefix + 'SHA256SUMS.txt' },
] };

test('baseline API retries transient failures and sends the Actions token only to the fixed API endpoint', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-baseline-download-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [];
  const pauses = [];
  let apiCalls = 0;
  const filename = await downloadBaseline('0.1.2', directory, { readToken: 'ephemeral-read-token', wait: async ms => pauses.push(ms),
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.startsWith('https://api.github.com/')) {
        apiCalls++;
        if (apiCalls === 1) return new Response('', { status: 429, headers: { 'x-github-request-id': 'retry-fixture' } });
        return new Response(JSON.stringify(release));
      }
      if (url.endsWith('SHA256SUMS.txt')) return new Response(`${digest}  ${assetName}\n`);
      const response = new Response(bytes);
      Object.defineProperty(response, 'url', { value: 'https://release-assets.githubusercontent.com/official-baseline' });
      return response;
    } });
  assert.deepEqual(await fs.readFile(filename), bytes);
  assert.deepEqual(pauses, [1000]);
  assert.equal(apiCalls, 2);
  for (const call of calls.filter(call => call.url.startsWith('https://api.github.com/'))) {
    assert.equal(call.options.headers.Authorization, 'Bearer ephemeral-read-token');
    assert.equal(call.options.redirect, 'manual');
    assert.ok(call.options.signal);
  }
  for (const call of calls.filter(call => !call.url.startsWith('https://api.github.com/'))) assert.equal(call.options, undefined);
});

test('missing official baseline fails immediately with HTTP status and request ID without exposing the token', async () => {
  let calls = 0;
  await assert.rejects(downloadBaseline('0.1.2', os.tmpdir(), { readToken: 'secret-sentinel', wait: async () => { throw new Error('404 must not retry'); },
    fetch: async () => { calls++; return new Response('', { status: 404, headers: { 'x-github-request-id': 'required-baseline-fixture' } }); } }),
  error => /HTTP 404/.test(error.message) && /required-baseline-fixture/.test(error.message) && !/secret-sentinel/.test(error.message));
  assert.equal(calls, 1);
});

test('baseline API retry is bounded and retains HTTP rate-limit diagnostics', async () => {
  let calls = 0;
  const pauses = [];
  await assert.rejects(downloadBaseline('0.1.2', os.tmpdir(), { readToken: null, wait: async ms => pauses.push(ms),
    fetch: async (url, options) => {
      calls++;
      assert.equal(options.headers.Authorization, undefined);
      return new Response('', { status: 403, headers: { 'x-github-request-id': 'rate-fixture', 'x-ratelimit-remaining': '0' } });
    } }), /HTTP 403, request ID rate-fixture, rate limit remaining 0/);
  assert.equal(calls, 3);
  assert.deepEqual(pauses, [1000, 2000]);
});

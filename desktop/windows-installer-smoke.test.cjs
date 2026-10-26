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
  for (const call of calls.filter(call => !call.url.startsWith('https://api.github.com/'))) {
    assert.equal(call.options.headers, undefined);
    assert.equal(call.options.redirect, 'follow');
    assert.ok(call.options.signal);
  }
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

function successfulResponse(url) {
  if (url.startsWith('https://api.github.com/')) return Response.json(release);
  if (url.endsWith('SHA256SUMS.txt')) return new Response(`${digest}  ${assetName}\n`);
  const response = new Response(bytes);
  Object.defineProperty(response, 'url', { value: 'https://release-assets.githubusercontent.com/official-baseline?fixture=signed' });
  return response;
}

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-baseline-download-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

for (const stage of ['manifest', 'installer']) test(`baseline ${stage} retries 503 and reopens the canonical URL without the API token`, async t => {
  const directory = await temporaryDirectory(t), calls = [], pauses = [];
  const target = prefix + (stage === 'manifest' ? 'SHA256SUMS.txt' : assetName);
  let attempts = 0, cancelled = 0;
  const filename = await downloadBaseline('0.1.2', directory, { readToken: 'secret-sentinel', wait: async ms => pauses.push(ms),
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url === target && ++attempts === 1) {
        const response = new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }, { highWaterMark: 0 }), { status: 503 });
        Object.defineProperty(response, 'url', { value: 'https://release-assets.githubusercontent.com/expired-signed-url?secret=private-fixture' });
        return response;
      }
      return successfulResponse(url);
    } });
  assert.deepEqual(await fs.readFile(filename), bytes);
  assert.equal(attempts, 2); assert.equal(cancelled, 1); assert.deepEqual(pauses, [1000]);
  assert.ok(calls.every(call => !call.url.includes('signed-url')));
  for (const call of calls.filter(call => !call.url.startsWith('https://api.github.com/'))) assert.equal(call.options.headers, undefined);
});

for (const stage of ['manifest', 'installer']) test(`baseline ${stage} HTTP retries stop after three safe, diagnosed attempts`, async () => {
  const target = prefix + (stage === 'manifest' ? 'SHA256SUMS.txt' : assetName), pauses = [];
  let attempts = 0;
  await assert.rejects(downloadBaseline('0.1.2', os.tmpdir(), { readToken: 'secret-sentinel', wait: async ms => pauses.push(ms),
    fetch: async url => {
      if (url !== target) return successfulResponse(url);
      attempts++;
      const response = new Response('private response body secret-sentinel', { status: 502,
        headers: { 'x-github-request-id': 'request-fixture', 'x-ratelimit-remaining': '12' } });
      Object.defineProperty(response, 'url', { value: 'https://objects.githubusercontent.com/private?token=secret-sentinel' });
      return response;
    } }), error => /HTTP 502, request ID request-fixture, rate limit remaining 12/.test(error.message)
      && !/secret-sentinel|private|objects\.githubusercontent/.test(error.stack));
  assert.equal(attempts, 3); assert.deepEqual(pauses, [1000, 2000]);
});

test('baseline asset transport errors are bounded and never expose exception messages or reflected credentials', async () => {
  for (const network of [true, false]) {
    let calls = 0;
    await assert.rejects(downloadBaseline('0.1.2', os.tmpdir(), { readToken: 'secret-sentinel', wait: async () => {},
      fetch: async url => {
        if (!url.endsWith(assetName)) return successfulResponse(url);
        calls++;
        if (network) throw Error('https://private.invalid/?token=secret-sentinel');
        return new Response('private body', { status: 503, headers: { 'x-github-request-id': 'secret-sentinel', 'x-ratelimit-remaining': 'private-value' } });
      } }), error => /baseline installer/.test(error.message) && !/secret-sentinel|private/.test(error.stack));
    assert.equal(calls, 3);
  }
});

for (const stage of ['manifest', 'installer']) test(`baseline ${stage} does not retry 404 or accept an untrusted final host`, async () => {
  const target = prefix + (stage === 'manifest' ? 'SHA256SUMS.txt' : assetName);
  for (const status of [404, 200]) {
    let attempts = 0;
    await assert.rejects(downloadBaseline('0.1.2', os.tmpdir(), { wait: async () => { throw Error('Permanent errors must not retry'); },
      fetch: async url => {
        if (url !== target) return successfulResponse(url);
        attempts++;
        const response = new Response('private response', { status });
        if (status === 200) Object.defineProperty(response, 'url', { value: 'https://foreign.invalid/private?secret=value' });
        return response;
      } }), status === 404 ? /HTTP 404/ : /outside the official download boundary/);
    assert.equal(attempts, 1);
  }
});

test('baseline certificate failures, size violations and SHA mismatches remain permanent', async () => {
  for (const invalid of ['certificate', 'oversized', 'short', 'hash']) {
    let attempts = 0;
    await assert.rejects(downloadBaseline('0.1.2', os.tmpdir(), { wait: async () => { throw Error('Validation errors must not retry'); },
      fetch: async url => {
        if (!url.endsWith(assetName)) return successfulResponse(url);
        attempts++;
        if (invalid === 'certificate') throw Object.assign(Error('private TLS detail'), { cause: Object.assign(Error('private certificate'), { code: 'CERT_HAS_EXPIRED' }) });
        const payload = invalid === 'oversized' ? Buffer.concat([bytes, Buffer.from('x')]) : invalid === 'short' ? bytes.subarray(0, -1) : Buffer.alloc(bytes.length);
        return new Response(payload);
      } }), error => /certificate verification failed|size limit|strictly equal|Baseline SHA256/.test(error.message) && !/private TLS|private certificate/.test(error.stack));
    assert.equal(attempts, 1);
  }
});

test('baseline header and body idle timeouts bound uncooperative transports and retain the retry limit', async () => {
  for (const stalled of ['headers', 'body']) {
    let attempts = 0, cancelled = 0;
    await assert.rejects(downloadBaseline('0.1.2', os.tmpdir(), { requestTimeoutMs: 10, idleTimeoutMs: 10, wait: async () => {},
      fetch: async url => {
        if (!url.endsWith(assetName)) return successfulResponse(url);
        attempts++;
        if (stalled === 'headers') return new Promise(() => {});
        return new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled++; return new Promise(() => {}); } }));
      } }), /request or body idle timeout/);
    assert.equal(attempts, 3);
    if (stalled === 'body') assert.equal(cancelled, 3);
  }
});

test('baseline external abort stops a stalled request or pending retry without another fetch', async () => {
  for (const during of ['headers', 'body', 'backoff', 'before']) {
    const controller = new AbortController(); let attempts = 0, cancelled = 0;
    if (during === 'before') controller.abort(Error('private abort reason'));
    await assert.rejects(downloadBaseline('0.1.2', os.tmpdir(), { signal: controller.signal,
      wait: async () => { controller.abort(Error('private abort reason')); },
      fetch: async url => {
        if (!url.endsWith(assetName)) return successfulResponse(url);
        attempts++;
        if (during === 'backoff') return new Response('', { status: 503 });
        if (during === 'headers') { queueMicrotask(() => controller.abort(Error('private abort reason'))); return new Promise(() => {}); }
        return new Response(new ReadableStream({ pull() { controller.abort(Error('private abort reason')); return new Promise(() => {}); },
          cancel() { cancelled++; return new Promise(() => {}); } }));
      } }), error => error.name === 'AbortError' && !/private/.test(error.stack));
    assert.equal(attempts, during === 'before' ? 0 : 1);
    if (during === 'body') assert.equal(cancelled, 1);
  }
});

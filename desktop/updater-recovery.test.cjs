'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createUpdater, API_URL } = require('./updater.cjs');

const payload = Buffer.from('complete verified recovery fixture installation bytes');
const digest = crypto.createHash('sha256').update(payload).digest('hex');
const assetName = 'Brclio-0.2.0-mac-arm64.dmg';
const prefix = 'https://github.com/Brclio/Brclio/releases/download/v0.2.0/';
const assetURL = prefix + assetName;
const manifestURL = prefix + 'SHA256SUMS.txt';
const release = { tag_name: 'v0.2.0', assets: [
  { name: assetName, size: payload.length, browser_download_url: assetURL, digest: `sha256:${digest}` },
  { name: 'SHA256SUMS.txt', browser_download_url: manifestURL },
] };
const abortError = () => Object.assign(new Error('fixture aborted'), { name: 'AbortError' });
const ioError = () => Object.assign(new Error('fixture disk failure'), { code: 'EIO' });

async function until(condition) {
  const deadline = performance.now() + 3000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('fixture condition not reached');
    await new Promise(setImmediate);
  }
}

function brokenBody({ error = new Error('fixture body connection interrupted'), onFailure = () => {} } = {}) {
  let first = true;
  return new Response(new ReadableStream({ pull(controller) {
    if (first) { first = false; controller.enqueue(payload.subarray(0, 7)); }
    else { onFailure(); controller.error(error); }
  } }, { highWaterMark: 0 }));
}

function pendingBody(signal, { prefixBytes = false, waiting = () => {} } = {}) {
  let first = prefixBytes;
  return new Response(new ReadableStream({ pull(controller) {
    if (first) { first = false; controller.enqueue(payload.subarray(0, 7)); return; }
    waiting();
    return new Promise(resolve => {
      const abort = () => { controller.error(abortError()); resolve(); };
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
  } }, { highWaterMark: 0 }));
}

async function fixture(t, asset, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-updater-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [], operations = [];
  let installs = 0;
  const updater = createUpdater({ currentVersion: '0.1.0', directory, platform: 'darwin', architecture: 'arm64',
    fetch: async (url, init) => {
      calls.push({ url, init });
      assert.equal(new Headers(init.headers).get('range'), null);
      if (url === API_URL) return new Response(JSON.stringify(release));
      if (url === manifestURL) return new Response(`${digest}  ${assetName}\n`);
      assert.equal(url, assetURL, 'recovery must retain the selected release URL');
      return asset(calls.filter(call => call.url === assetURL).length, init);
    },
    onOperation: (kind, active, targets) => operations.push({ kind, active, targets }),
    installPackage: async () => { installs++; return { installerStarted: true }; }, ...options,
  });
  return { updater, directory, calls, operations, assets: () => calls.filter(call => call.url === assetURL), installs: () => installs };
}

async function failedWithoutInstall(f, retryCount) {
  const result = await f.updater.download();
  assert.equal(result.status, 'error');
  assert.equal(result.retryCount, retryCount);
  assert.equal(result.canInstall, false);
  assert.equal((await f.updater.install()).status, 'error');
  assert.equal(f.installs(), 0);
  return result;
}

test('healthy concurrent downloads share one promise, one manifest and one installer GET', async t => {
  let deliver;
  const f = await fixture(t, () => new Promise(resolve => { deliver = () => resolve(new Response(payload)); }));
  await f.updater.check();
  const first = f.updater.download(), second = f.updater.download();
  assert.equal(first, second);
  await until(() => deliver);
  deliver();
  const result = await first;
  assert.equal(result.status, 'downloaded'); assert.equal(result.retryCount, 0);
  assert.equal(result.downloadedBytes, payload.length); assert.equal(result.canInstall, true);
  assert.deepEqual(await fs.readFile(path.join(f.directory, assetName)), payload);
  assert.equal(f.assets().length, 1);
  assert.equal(f.calls.filter(call => call.url === manifestURL).length, 1);
  assert.equal(f.installs(), 0);
});

test('one body read rejection restarts from zero with the pinned manifest and a fresh hash', async t => {
  let firstSignal, firstWasAborted = false;
  const f = await fixture(t, (attempt, init) => {
    if (attempt === 1) {
      firstSignal = init.signal;
      firstSignal.addEventListener('abort', () => { firstWasAborted = true; });
      return brokenBody();
    }
    assert.notEqual(init.signal, firstSignal, 'each attempt needs an independently disposable signal');
    assert.equal(firstWasAborted, true, 'dispose the first transport before starting the next');
    return new Response(payload);
  });
  await f.updater.check();
  const result = await f.updater.download();
  assert.equal(result.status, 'downloaded'); assert.equal(result.retryCount, 1);
  assert.equal(result.downloadedBytes, payload.length); assert.equal(result.canInstall, true);
  const actual = await fs.readFile(path.join(f.directory, assetName));
  assert.equal(crypto.createHash('sha256').update(actual).digest('hex'), digest);
  assert.deepEqual(actual, payload, 'the first attempt prefix must not remain in the final file');
  assert.deepEqual(await fs.readdir(f.directory), [assetName]);
  assert.equal(f.assets().length, 2);
  assert.equal(f.calls.filter(call => call.url === manifestURL).length, 1);
  assert.deepEqual(f.operations.map(({ kind, active }) => [kind, active]), [['check', true], ['check', false], ['download', true], ['download', false]]);
  assert.deepEqual(f.operations.find(value => value.kind === 'download' && value.active).targets, [manifestURL, assetURL]);
  assert.equal(f.installs(), 0);
});

test('two failing body attempts stop at two GETs and remove partial data without allowing installation', async t => {
  const f = await fixture(t, () => brokenBody());
  await f.updater.check();
  await failedWithoutInstall(f, 1);
  assert.equal(f.assets().length, 2);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('HTTP, clean EOF, integrity, limits, request, reader and disk failures never enter recovery', async t => {
  for (const mode of ['http-403', 'short-eof', 'bad-hash', 'size-overflow', 'request-error', 'request-abort', 'reader-abort', 'reader-timeout', 'reader-abort-code', 'sync-read', 'get-reader', 'open', 'write', 'close', 'remove']) {
    await t.test(mode, async t => {
      let readFailed = false;
      const f = await fixture(t, () => {
        if (mode === 'http-403') return new Response(null, { status: 403 });
        if (mode === 'short-eof') return new Response(payload.subarray(0, -1));
        if (mode === 'bad-hash') return new Response(Buffer.alloc(payload.length, 120));
        if (mode === 'size-overflow') return new Response(Buffer.concat([payload, Buffer.from('extra')]));
        if (mode === 'request-error') throw new Error('fixture header connection failure');
        if (mode === 'request-abort') throw abortError();
        if (mode === 'reader-abort') return brokenBody({ error: abortError() });
        if (mode === 'reader-timeout') return brokenBody({ error: Object.assign(new Error('fixture reader timeout'), { name: 'TimeoutError' }) });
        if (mode === 'reader-abort-code') return brokenBody({ error: Object.assign(new Error('fixture reader aborted'), { code: 'ABORT_ERR' }) });
        if (mode === 'sync-read') {
          const result = new Response(payload);
          Object.defineProperty(result, 'body', { value: { getReader() { return {
            read() { throw new Error('fixture synchronous reader failure'); }, cancel: async () => {}, releaseLock() {},
          }; } } });
          return result;
        }
        if (mode === 'remove') return brokenBody({ onFailure: () => { readFailed = true; } });
        if (mode === 'get-reader') {
          const result = new Response(payload);
          Object.defineProperty(result, 'body', { value: { getReader() { throw new Error('fixture cannot acquire reader'); }, cancel: async () => {} } });
          return result;
        }
        return new Response(payload);
      });
      if (['open', 'write', 'close'].includes(mode)) {
        const open = fs.open;
        t.mock.method(fs, 'open', async (filename, ...args) => {
          if (!filename.endsWith('.part')) return open(filename, ...args);
          if (mode === 'open') throw ioError();
          const handle = await open(filename, ...args);
          if (mode === 'write') t.mock.method(handle, 'writeFile', async () => { throw ioError(); });
          if (mode === 'close') {
            const close = handle.close.bind(handle);
            t.mock.method(handle, 'close', async () => { await close(); throw ioError(); });
          }
          return handle;
        });
      }
      if (mode === 'remove') {
        const remove = fs.rm;
        t.mock.method(fs, 'rm', async (filename, ...args) => {
          if (filename.endsWith('.part') && readFailed) throw ioError();
          return remove(filename, ...args);
        });
      }
      await f.updater.check();
      await failedWithoutInstall(f, 0);
      assert.equal(f.assets().length, 1);
      if (mode !== 'remove') assert.deepEqual(await fs.readdir(f.directory), []);
    });
  }
});

test('idle and total limits retain their original budgets through recovery and abort active children', async t => {
  for (const mode of ['idle-first-attempt', 'idle-during-retry', 'total-during-retry']) await t.test(mode, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let firstWaiting = false, secondWaiting = false, rejectFirst, secondSignal;
    const total = mode === 'total-during-retry' ? 100 : 400;
    const idle = mode === 'total-during-retry' ? 400 : 40;
    const f = await fixture(t, (attempt, init) => {
      if (mode === 'idle-first-attempt') return pendingBody(init.signal, { prefixBytes: true, waiting: () => { firstWaiting = true; } });
      if (attempt === 2) { secondSignal = init.signal; return pendingBody(init.signal, { waiting: () => { secondWaiting = true; } }); }
      let prefixPending = true;
      return new Response(new ReadableStream({ pull(controller) {
        if (prefixPending) { prefixPending = false; controller.enqueue(payload.subarray(0, 7)); return; }
        firstWaiting = true;
        return new Promise(resolve => { rejectFirst = () => { controller.error(new Error('fixture body interruption')); resolve(); }; });
      } }, { highWaterMark: 0 }));
    }, { downloadTimeout: total, idleTimeout: idle });
    await f.updater.check();
    const downloading = f.updater.download();
    await until(() => firstWaiting);
    if (mode === 'idle-first-attempt') {
      t.mock.timers.tick(idle);
      const failed = await downloading;
      assert.equal(failed.status, 'error'); assert.equal(failed.retryCount, 0); assert.equal(f.assets().length, 1);
    } else {
      const beforeFailure = mode === 'total-during-retry' ? 60 : 30;
      const deadline = mode === 'total-during-retry' ? total : idle;
      t.mock.timers.tick(beforeFailure); rejectFirst();
      await until(() => secondWaiting);
      t.mock.timers.tick(deadline - beforeFailure - 1);
      assert.equal(secondSignal.aborted, false);
      t.mock.timers.tick(1);
      assert.equal(secondSignal.aborted, true, 'recovery must not restart the original deadline');
      const failed = await downloading;
      assert.equal(failed.status, 'error'); assert.equal(failed.retryCount, 1); assert.equal(f.assets().length, 2);
    }
    assert.deepEqual(await fs.readdir(f.directory), []);
    assert.equal((await f.updater.install()).status, 'error'); assert.equal(f.installs(), 0);
  });
});

test('a hanging failed-reader cancellation is bounded by the master idle timer and cannot start recovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelCalls = 0, reads = 0;
  const f = await fixture(t, () => {
    const result = new Response(payload);
    Object.defineProperty(result, 'body', { value: { getReader() { return {
      async read() { if (++reads === 1) return { done: false, value: payload.subarray(0, 7) }; throw new Error('fixture read failure'); },
      cancel() { cancelCalls++; return new Promise(() => {}); }, releaseLock() {},
    }; } } });
    return result;
  }, { idleTimeout: 40, downloadTimeout: 120 });
  await f.updater.check();
  const downloading = f.updater.download();
  await until(() => cancelCalls > 0);
  t.mock.timers.tick(40);
  const result = await downloading;
  assert.equal(result.status, 'error'); assert.equal(result.retryCount, 0); assert.equal(result.canInstall, false);
  assert.equal(f.assets().length, 1); assert.equal(cancelCalls, 1);
  assert.deepEqual(await fs.readdir(f.directory), []);
  assert.equal((await f.updater.install()).status, 'error'); assert.equal(f.installs(), 0);
});

test('a hanging file-close receipt obeys the master deadline and its late failure cannot delete a later partial file', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let closing = false, rejectLateClose, partialRemovals = 0;
  const f = await fixture(t, () => brokenBody(), { idleTimeout: 40, downloadTimeout: 120 });
  const open = fs.open, remove = fs.rm;
  t.mock.method(fs, 'open', async (filename, ...args) => {
    const handle = await open(filename, ...args);
    if (filename.endsWith('.part')) {
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => {
        await close(); // The fixture never leaks a real descriptor while its receipt is delayed.
        closing = true;
        return new Promise((_resolve, reject) => { rejectLateClose = reject; });
      });
    }
    return handle;
  });
  t.mock.method(fs, 'rm', async (filename, ...args) => {
    if (filename.endsWith('.part')) partialRemovals++;
    return remove(filename, ...args);
  });
  await f.updater.check();
  const downloading = f.updater.download();
  await until(() => closing);
  t.mock.timers.tick(40);
  const result = await downloading;
  assert.equal(result.status, 'error'); assert.equal(result.retryCount, 0); assert.equal(result.canInstall, false);
  assert.match(result.error, /下载超时/);
  assert.equal(f.assets().length, 1); assert.deepEqual(await fs.readdir(f.directory), []);
  const partial = path.join(f.directory, assetName + '.part');
  await fs.writeFile(partial, 'later operation fixture');
  const removedBeforeLateFailure = partialRemovals;
  rejectLateClose(ioError());
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(await fs.readFile(partial, 'utf8'), 'later operation fixture');
  assert.equal(partialRemovals, removedBeforeLateFailure, 'late close cleanup must not remove a reused partial pathname');
  assert.equal((await f.updater.install()).status, 'error'); assert.equal(f.installs(), 0);
});

test('master cancellation stays authoritative when reader release also throws during cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reading = false, reads = 0;
  const f = await fixture(t, () => {
    const result = new Response(payload);
    Object.defineProperty(result, 'body', { value: { getReader() { return {
      read() {
        if (++reads === 1) return Promise.resolve({ done: false, value: payload.subarray(0, 7) });
        reading = true;
        return new Promise(() => {}); // Intentionally ignores child abort; the master still owns the deadline.
      },
      cancel: async () => {}, releaseLock() { throw new Error('fixture secondary release-lock failure'); },
    }; } } });
    return result;
  }, { idleTimeout: 40, downloadTimeout: 120 });
  await f.updater.check();
  const downloading = f.updater.download();
  await until(() => reading);
  t.mock.timers.tick(40);
  const result = await downloading;
  assert.equal(result.status, 'error'); assert.equal(result.retryCount, 0); assert.equal(result.canInstall, false);
  assert.match(result.error, /下载超时/); assert.doesNotMatch(result.error, /release-lock/);
  assert.equal(f.assets().length, 1); assert.deepEqual(await fs.readdir(f.directory), []);
  assert.equal((await f.updater.install()).status, 'error'); assert.equal(f.installs(), 0);
});

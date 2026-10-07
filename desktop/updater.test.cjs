'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createUpdater, compareVersions, parseRelease, checksumFor, API_URL } = require('./updater.cjs');

const bytes = Buffer.from('a verified Brclio installation package');
const digest = crypto.createHash('sha256').update(bytes).digest('hex');

function releaseFixture(version = '0.2.0') {
  const assetName = `Brclio-${version}-mac-arm64.dmg`;
  const prefix = `https://github.com/Brclio/Brclio/releases/download/v${version}/`;
  return { tag_name: `v${version}`, draft: false, prerelease: false, body: 'Improved copying.', assets: [
    { name: assetName, size: bytes.length, browser_download_url: prefix + assetName, digest: `sha256:${digest}` },
    { name: 'SHA256SUMS.txt', size: 100, browser_download_url: prefix + 'SHA256SUMS.txt' },
  ] };
}

async function setup(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-updater-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = []; const opened = []; const states = [];
  const latest = overrides.release || releaseFixture();
  const fetch = async (url, options) => {
    calls.push(url); assert.ok(options.signal);
    if (overrides.fetch) return overrides.fetch(url, options, latest);
    if (url === API_URL) return new Response(JSON.stringify(latest));
    if (url.endsWith('SHA256SUMS.txt')) return new Response(`${digest}  ${latest.assets[0].name}\n`);
    return new Response(bytes);
  };
  const updater = createUpdater({ currentVersion: '0.1.0', directory, platform: 'darwin', architecture: 'arm64', fetch,
    onState: state => states.push(state), installPackage: async descriptor => { opened.push(descriptor); return { installerStarted: true }; }, ...overrides.options });
  return { updater, directory, calls, opened, states, latest };
}

test('semantic version comparison is numeric and rejects prerelease text', () => {
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
  assert.throws(() => compareVersions('1.0.0-beta', '1.0.0'), /格式无效/);
});

test('release parser accepts only the official repo, stable tag and exact platform asset', () => {
  const fixture = releaseFixture();
  assert.equal(parseRelease(fixture, 'darwin', 'arm64').version, '0.2.0');
  assert.throws(() => parseRelease({ ...fixture, prerelease: true }, 'darwin', 'arm64'), /正式发布/);
  assert.throws(() => parseRelease(fixture, 'win32', 'x64'), /尚未发布完整/);
  assert.throws(() => parseRelease(fixture, 'linux', 'x64'), /此平台/);
  fixture.assets[0].browser_download_url = 'https://evil.example/Brclio-0.2.0-mac-arm64.dmg';
  assert.throws(() => parseRelease(fixture, 'darwin', 'arm64'), /官方仓库/);
});

test('checksum manifest requires exactly one matching asset', () => {
  assert.equal(checksumFor(`${digest} *Brclio.dmg\r\n`, 'Brclio.dmg'), digest);
  assert.throws(() => checksumFor(`${digest}  Other.dmg`, 'Brclio.dmg'), /唯一/);
  assert.throws(() => checksumFor(`${digest}  Brclio.dmg\n${digest}  Brclio.dmg`, 'Brclio.dmg'), /唯一/);
});

test('manual check fetches metadata only and reports current version accurately', async t => {
  const { updater, calls } = await setup(t);
  assert.equal(calls.length, 0);
  assert.equal((await updater.check()).status, 'available');
  assert.deepEqual(calls, [API_URL]);
  const current = await setup(t, { release: releaseFixture('0.1.0') });
  assert.equal((await current.updater.check()).status, 'up-to-date');
  assert.equal(current.opened.length, 0);
});

test('download verifies SHA256 and byte size before installer can open, then verifies again on install', async t => {
  const { updater, directory, opened, states } = await setup(t);
  await updater.check();
  const ready = await updater.download();
  assert.equal(ready.status, 'downloaded'); assert.equal(ready.progress, 100);
  assert.equal(ready.manualInstall, false);
  assert.equal(opened.length, 0);
  const filename = path.join(directory, 'Brclio-0.2.0-mac-arm64.dmg');
  assert.deepEqual(await fs.readFile(filename), bytes);
  assert.equal((await updater.install()).installerStarted, true);
  assert.deepEqual(opened, [{ filename, expected: digest, size: bytes.length, version: '0.2.0' }]);
  assert.equal((await updater.install()).status, 'restarting');
  assert.equal(opened.length, 1);
  assert.ok(states.some(state => state.status === 'preparing'));
});

test('tampered verified package cannot begin replacement', async t => {
  const { updater, directory, opened } = await setup(t);
  await updater.check(); await updater.download();
  const filename = path.join(directory, 'Brclio-0.2.0-mac-arm64.dmg');
  await fs.writeFile(filename, Buffer.from('changed'));
  const failed = await updater.install();
  assert.equal(failed.status, 'error'); assert.match(failed.error, /已变更/);
  assert.equal(opened.length, 0);
  assert.equal(failed.canInstall, false);
});

test('bad hash removes partial download, prevents installation and permits retry', async t => {
  let corrupted = true;
  const { updater, directory, opened } = await setup(t, { fetch: async (url, _options, latest) => {
    if (url === API_URL) return new Response(JSON.stringify(latest));
    if (url.endsWith('SHA256SUMS.txt')) return new Response(`${digest}  ${latest.assets[0].name}\n`);
    const payload = corrupted ? Buffer.alloc(bytes.length, 'x') : bytes;
    return new Response(payload);
  } });
  await updater.check();
  assert.equal((await updater.download()).status, 'error');
  assert.deepEqual(await fs.readdir(directory), []);
  assert.equal((await updater.install()).status, 'error'); assert.equal(opened.length, 0);
  corrupted = false;
  assert.equal((await updater.download()).status, 'downloaded');
});

test('download requires a check and can recover afterward', async t => {
  const { updater } = await setup(t);
  assert.equal((await updater.download()).status, 'error');
  await updater.check();
  assert.equal((await updater.download()).status, 'downloaded');
});

test('oversized streamed content is rejected and cleaned up', async t => {
  const { updater, directory } = await setup(t, { fetch: async (url, _options, latest) => {
    if (url === API_URL) return new Response(JSON.stringify(latest));
    if (url.endsWith('SHA256SUMS.txt')) return new Response(`${digest}  ${latest.assets[0].name}`);
    return new Response(Buffer.concat([bytes, Buffer.from('extra')]));
  } });
  await updater.check();
  assert.match((await updater.download()).error, /大小/);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('unexpected redirect host is rejected before download is trusted', async t => {
  const { updater } = await setup(t, { fetch: async () => {
    const response = new Response(JSON.stringify(releaseFixture()));
    Object.defineProperty(response, 'url', { value: 'https://evil.example/latest' });
    return response;
  } });
  assert.match((await updater.check()).error, /非官方/);
});

test('official GitHub digest and checksum file must agree', async t => {
  const release = releaseFixture(); release.assets[0].digest = `sha256:${'a'.repeat(64)}`;
  const { updater, directory } = await setup(t, { release });
  await updater.check();
  assert.match((await updater.download()).error, /不一致/);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('verified existing downloads are reused, without a second installer download', async t => {
  const { updater, calls } = await setup(t);
  await updater.check();
  await updater.download();
  await updater.download();
  assert.equal(calls.filter(url => url.endsWith('.dmg')).length, 1);
});

test('network failure is actionable and later check succeeds', async t => {
  let fail = true;
  const { updater } = await setup(t, { fetch: async () => {
    if (fail) throw new Error('connection reset');
    return new Response(JSON.stringify(releaseFixture()));
  } });
  assert.equal((await updater.check()).status, 'error');
  fail = false;
  assert.equal((await updater.check()).status, 'available');
});

test('concurrent install requests share verification and open the installer only once', async t => {
  const opened = [];
  const { updater } = await setup(t, { options: { installPackage: async descriptor => {
    opened.push(descriptor);
    await new Promise(resolve => setTimeout(resolve, 25));
    return { installerStarted: true };
  } } });
  await updater.check();
  await updater.download();
  const first = updater.install();
  const second = updater.install();
  assert.equal(first, second);
  const results = await Promise.all([first, second]);
  assert.equal(opened.length, 1);
  assert.ok(results.every(state => state.installerStarted === true));
});

test('preparation failure preserves verified download for retry and never quits', async t => {
  let fail = true; let quits = 0;
  const { updater, calls } = await setup(t, { options: {
    installPackage: async () => { if (fail) throw new Error('安装目录不可写'); return { installerStarted: true }; },
    afterStart: () => { quits++; },
  } });
  await updater.check(); await updater.download();
  assert.equal((await updater.install()).canInstall, true);
  assert.equal(updater.state().status, 'error'); assert.equal(quits, 0);
  const requests = calls.length; fail = false;
  assert.equal((await updater.install()).status, 'restarting');
  assert.equal(calls.length, requests); assert.equal(quits, 1);
  await updater.install(); await updater.check(); await updater.download();
  assert.equal(quits, 1); assert.equal(calls.length, requests);
});

test('startup result requires healthy-launch acknowledgement before displaying success', async t => {
  const { updater } = await setup(t);
  assert.equal(updater.restoreResult({ status: 'installed' }).status, 'idle');
  assert.equal(updater.restoreResult({ status: 'installed', launchAcknowledged: true }).status, 'installed');
  assert.equal(updater.restoreResult({ status: 'error', error: '已恢复旧版' }).error, '已恢复旧版');
});

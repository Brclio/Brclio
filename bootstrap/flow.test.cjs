'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { runDownloader } = require('./flow.cjs');
const { POINTER } = require('./self-update.cjs');
const { API_URL } = require('../desktop/updater.cjs');

const bytes = Buffer.from('verified fixture');
const digest = createHash('sha256').update(bytes).digest('hex');
function release(version, self) {
  const tag = self ? 'downloader-v' + version : 'v' + version;
  const base = 'https://github.com/Brclio/Brclio/releases/download/' + tag + '/';
  const name = (self ? 'Brclio-Downloader-' : 'Brclio-') + version + '-mac-arm64.dmg';
  const manifest = digest + '  ' + name + '\n';
  return {tag_name:tag, draft:false, prerelease:self, assets:[
    {name, size:bytes.length, digest:'sha256:' + digest, browser_download_url:base + name},
    {name:'SHA256SUMS.txt', size:manifest.length, browser_download_url:base + 'SHA256SUMS.txt'}
  ]};
}

async function fixture(t, {pointer = null, installed = null, corrupt = '', failSelf = false, handoff = false, selfUpdateSignal} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-flow-'));
  t.after(() => fs.rm(directory, {recursive:true, force:true}));
  const products = [], calls = [], events = [];
  let busy = false;
  const appRelease = release('4.5.6', false), selfRelease = release('1.9.0', true);
  const router = {
    setBusy(active) { busy = active; },
    async fetch(url) {
      assert.ok(busy); calls.push(url);
      if (url === POINTER) return pointer ? Response.json({assets:[{name:selfRelease.assets[0].name, size:bytes.length, sha256:digest}], ...pointer}) : new Response('', {status:404});
      if (url === API_URL) return Response.json(appRelease);
      const r = url.includes('downloader-v') ? selfRelease : appRelease;
      if (url === r.assets[1].browser_download_url) return new Response(digest + '  ' + r.assets[0].name);
      assert.equal(url, r.assets[0].browser_download_url);
      const altered = corrupt === (r === selfRelease ? 'downloader' : 'brclio');
      return new Response(altered ? Buffer.alloc(bytes.length) : bytes, {headers:{'content-length':String(bytes.length)}});
    }
  };
  const installer = { async getInstalled() { return installed; }, async openInstalled(product) { products.push('open ' + product); },
    async installAndOpen(desc) {
      assert.deepEqual(await fs.readFile(desc.filename), bytes);
      assert.equal(desc.expected, digest);
      if (desc.product === 'downloader' && failSelf) throw new Error('simulated handoff failure');
      products.push(desc.product);
      return {handoff};
    }};
  const run = (action = 'startup') => runDownloader({action, directory, currentVersion:'1.0.0', platform:'darwin', architecture:'arm64',
    router, installer, selfUpdateSignal, report:state => events.push(state)});
  return {run, products, calls, events};
}

test('first launch with unpublished self feed downloads, verifies and installs latest Brclio', async t => {
  const f = await fixture(t);
  await f.run();
  assert.deepEqual(f.products, ['brclio']);
  assert.ok(f.calls.includes(POINTER));
});
test('unchanged downloader opens a newer installed Brclio without a package download or downgrade', async t => {
  const f = await fixture(t, {pointer:{version:'1.0.0'}, installed:{version:'5.0.0'}});
  await f.run();
  assert.deepEqual(f.products, ['open brclio']);
  assert.deepEqual(f.calls, [POINTER, API_URL]);
});
test('new self release verifies before handoff and defers Brclio to the relaunched downloader', async t => {
  const f = await fixture(t, {pointer:{version:'1.9.0'}});
  await f.run();
  assert.deepEqual(f.products, ['downloader']);
  assert.ok(!f.calls.includes(API_URL));
});
for (const options of [{corrupt:'downloader'}, {failSelf:true}, {pointer:{version:'unexpected'}}]) {
  test('failed self update continues Brclio install: ' + JSON.stringify(options), async t => {
    const f = await fixture(t, {pointer:{version:'1.9.0'}, ...options});
    await f.run();
    assert.deepEqual(f.products, ['brclio']);
    assert.ok(f.events.some(event => event.warning));
  });
}
test('invalid Brclio checksum stops before install', async t => {
  const f = await fixture(t, {corrupt:'brclio'});
  await assert.rejects(f.run(), /SHA256/);
  assert.deepEqual(f.products, []);
});

test('self updates disabled: the old downloader still installs the newest Brclio', async t => {
  const f = await fixture(t, {pointer:{version:'1.9.0'}, selfUpdateSignal:AbortSignal.abort()});
  await f.run();
  assert.ok(!f.calls.includes(POINTER));
  assert.deepEqual(f.products, ['brclio']);
});

test('download button checks only Brclio, then leaves the window available after opening it', async t => {
  const f = await fixture(t, {pointer:{version:'1.9.0'}});
  assert.deepEqual(await f.run('brclio'), {quit:false});
  assert.equal(f.calls[0], API_URL);
  assert.ok(!f.calls.includes(POINTER));
  assert.deepEqual(f.products, ['brclio']);
});
test('existing Brclio upgrade quits the downloader when the installer requests handoff', async t => {
  const f = await fixture(t, {installed:{version:'1.0.0'}, handoff:true});
  assert.deepEqual(await f.run('brclio'), {quit:true});
});
test('upgrade button fetches the self channel even when automatic updates are disabled', async t => {
  const f = await fixture(t, {pointer:{version:'1.9.0'}, selfUpdateSignal:AbortSignal.abort()});
  assert.deepEqual(await f.run('self'), {quit:true});
  assert.ok(!f.calls.includes(API_URL));
  assert.deepEqual(f.products, ['downloader']);
});
test('repeated self checks re-read the release feed and leave an up-to-date downloader open', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.run('self'), {quit:false});
  assert.deepEqual(await f.run('self'), {quit:false});
  assert.deepEqual(f.calls, [POINTER, POINTER]);
  assert.deepEqual(f.products, []);
});
test('manual self-update errors can be retried without starting Brclio installation', async t => {
  const f = await fixture(t, {pointer:{version:'1.9.0'}, failSelf:true});
  await assert.rejects(f.run('self'), /handoff failure/);
  assert.ok(!f.calls.includes(API_URL));
});

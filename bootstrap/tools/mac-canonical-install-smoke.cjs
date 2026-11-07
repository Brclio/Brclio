'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.RUNNER_OS, 'macOS');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  const work = process.env.BRCLIO_CANONICAL_SMOKE_DIR;
  assert.equal(path.dirname(work), fs.realpathSync(process.env.RUNNER_TEMP));
  assert.ok(path.basename(work).startsWith('brclio-canonical-'));
  assert.equal(process.env.HOME, path.join(work, 'home'));

  // Use the installer and flow inside the signed, packaged Electron runtime.
  const archive = process.env.BRCLIO_CANONICAL_ASAR;
  const installer = require(path.join(archive, 'bootstrap/install.cjs'));
  const { runDownloader } = require(path.join(archive, 'bootstrap/flow.cjs'));
  const { API_URL } = require(path.join(archive, 'desktop/updater.cjs'));
  const phase = process.argv[2], legacy = path.join(process.env.HOME, 'Applications/Brclio.app');
  const canonical = '/Applications/Brclio.app';
  if (phase === 'blocked') {
    await assert.rejects(installer.getInstalled('brclio'), err => err.message.includes(legacy));
    return;
  }
  assert.ok(phase === 'fresh' || phase === 'current');
  const file = process.env.BRCLIO_TEST_OFFICIAL_DMG, name = path.basename(file);
  const version = process.env.BRCLIO_TEST_OFFICIAL_VERSION;
  const sha = process.env.BRCLIO_TEST_OFFICIAL_SHA;
  const tag = process.env.BRCLIO_CANONICAL_RELEASE_TAG;
  const base = 'https://github.com/Brclio/Brclio/releases/download/' + tag + '/';
  const manifest = sha + '  ' + name + '\n';
  const size = fs.statSync(file).size;
  const release = { tag_name:tag, prerelease:false, draft:false, assets:[
    {name, browser_download_url:base+name, size, digest:'sha256:'+sha},
    {name:'SHA256SUMS.txt', browser_download_url:base+'SHA256SUMS.txt', size:Buffer.byteLength(manifest)},
  ]};
  const calls = [];
  const router = { async setBusy() {}, async fetch(url) {
    calls.push(url);
    if (url === API_URL) return Response.json(release);
    if (phase === 'fresh' && url === base+'SHA256SUMS.txt') return new Response(manifest);
    if (phase === 'fresh' && url === base+name) return new Response(Readable.toWeb(fs.createReadStream(file)), {headers:{'content-length':String(size)}});
    throw Error('Unexpected release request in ' + phase);
  }};
  const before = await installer.getInstalled('brclio');
  if (phase === 'fresh') assert.equal(before, null);
  else assert.equal(before?.path, canonical);
  const outcome = await runDownloader({action:'brclio', currentVersion:'0.0.0', installer, router,
    directory:path.join(work,'packages'), report() {}});
  assert.equal(outcome.quit, false);
  assert.deepEqual(calls, phase === 'fresh' ? [API_URL,base+'SHA256SUMS.txt',base+name] : [API_URL]);
  const current = await installer.getInstalled('brclio');
  assert.equal(current?.path,canonical);
  assert.equal(current?.version,version);
}

main().catch(error => { console.error(error); process.exitCode = 1; });

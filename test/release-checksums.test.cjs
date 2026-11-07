'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

test('desktop release manifests require five desktop packages and exclude Android before and after upload', async t => {
  const { createManifest, verifyManifest } = await import('../scripts/checksums.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'brclio-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const version = '0.2.9';
  const desktop = { version, desktopOnly: true };
  const filename = suffix => path.join(directory, `Brclio-${version}-${suffix}`);
  const packages = ['windows-x64.exe', 'mac-arm64.dmg', 'mac-arm64.zip', 'mac-x64.dmg', 'mac-x64.zip'];
  for (const suffix of packages) await writeFile(filename(suffix), suffix);
  assert.equal((await createManifest(directory, desktop)).length, 5);
  assert.equal((await verifyManifest(directory, desktop)).length, 5);
  for (const suffix of ['android.apk', 'android.aab']) {
    await writeFile(filename(suffix), 'unexpected Android package');
    await assert.rejects(createManifest(directory, desktop), /Unexpected installers/);
    await assert.rejects(verifyManifest(directory, desktop), /Unexpected installers/);
    await rm(filename(suffix));
  }
  await rm(filename('windows-x64.exe'));
  await assert.rejects(verifyManifest(directory, desktop), /Missing: Brclio-0.2.9-windows-x64.exe/);
});

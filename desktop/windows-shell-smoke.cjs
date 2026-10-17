#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createWindowsShell, sameLocation } = require('./windows-shell.cjs');

async function main() {
  assert.equal(process.platform, 'win32', 'Windows shell query smoke requires Windows.');
  assert.equal(process.argv.length, 3, 'Usage: node desktop/windows-shell-smoke.cjs <install-root>');
  const root = await fs.realpath(path.resolve(process.argv[2]));
  const directory = path.join(root, 'resources', 'windows-shell');
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'shell-build.json'), 'utf8'));
  assert.match(metadata.packageVersion, /^\d+\.\d+\.\d+\.\d+$/, 'Fixture has no valid Windows package version.');
  assert.equal(metadata.dll, `${metadata.packageVersion}\\BrclioExplorerCommand.dll`, 'Fixture must use its versioned DLL path.');
  assert.equal(metadata.signed, true, 'Query smoke requires the signed shell fixture.');

  // status() is the only runtime operation exercised here. It reads the real
  // manifest, signatures, WinRT location API and current-user Appx inventory;
  // it never adds packages, certificates, registry ownership or menu entries.
  const shell = createWindowsShell({ launch: { packaged: true, executable: path.join(root, 'Brclio.exe') } });
  const state = await shell.status();
  assert.equal(state.error, undefined, state.description);
  assert.equal(state.available, true, state.description);
  assert.equal(state.installed, false, 'The unregistered smoke fixture must not be reported as installed.');
  assert.equal(sameLocation(state.location, path.join(directory, metadata.dll)), true,
    `Runtime must report the exact versioned fixture DLL, received: ${state.location}`);
  if (metadata.selfSigned) {
    assert.equal(state.needsTrust, true, 'TrustSmoke must remove its temporary leaf trust before the read-only query smoke.');
  } else {
    assert.notEqual(state.needsTrust, true, 'Production-signed fixture should already have a trusted signature.');
  }
  console.log('Windows shell query smoke passed (real PowerShell 5.1, signed versioned assets, Appx/WinRT query; no registration or trust changes).');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

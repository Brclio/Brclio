#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createWindowsShell, sameLocation } = require('./windows-shell.cjs');

// Small fixed, read-only script. It checks the exact fixture leaf and the
// application's ownership markers without changing a certificate or key.
const TRUST_QUERY_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$request = [Environment]::GetEnvironmentVariable('BRCLIO_WINDOWS_SHELL_SMOKE_REQUEST', 'Process') | ConvertFrom-Json
if ($request.thumbprint -notmatch '^[a-fA-F0-9]{40}$') { throw 'Invalid fixture certificate thumbprint.' }
function Read-StoreLeaf([string]$name, [string]$location) {
  $store = New-Object Security.Cryptography.X509Certificates.X509Store($name, $location)
  try {
    $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
    return @($store.Certificates.Find([Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $request.thumbprint, $false)).Count -gt 0
  } finally { $store.Close() }
}
function Read-OwnedMarkers([Microsoft.Win32.RegistryHive]$hive) {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, [Microsoft.Win32.RegistryView]::Registry64)
  $parent = $null
  try {
    $parent = $base.OpenSubKey('Software\Brclio\ShellCertificates')
    if ($null -eq $parent) { return }
    foreach ($name in $parent.GetSubKeyNames()) {
      $marker = $parent.OpenSubKey($name)
      try { if ($null -ne $marker -and $marker.GetValue('BrclioOwner') -ceq 'com.brclio.toolbox') { [string]$name } }
      finally { if ($null -ne $marker) { $marker.Dispose() } }
    }
  } finally { if ($null -ne $parent) { $parent.Dispose() }; $base.Dispose() }
}
$result = @{
  trustedLeaf = (Read-StoreLeaf 'TrustedPeople' 'CurrentUser')
  machineTrustedLeaf = (Read-StoreLeaf 'TrustedPeople' 'LocalMachine')
  ownedMarkers = @(Read-OwnedMarkers ([Microsoft.Win32.RegistryHive]::CurrentUser))
  machineOwnedMarkers = @(Read-OwnedMarkers ([Microsoft.Win32.RegistryHive]::LocalMachine))
  rootLeaf = ((Read-StoreLeaf 'Root' 'CurrentUser') -or (Read-StoreLeaf 'Root' 'LocalMachine'))
}
$bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $result -Compress))
$stdout = [Console]::OpenStandardOutput()
$stdout.Write($bytes, 0, $bytes.Length)
$stdout.Flush()
`;

async function readTrust(thumbprint) {
  const env = { ...process.env, BRCLIO_WINDOWS_SHELL_SMOKE_REQUEST: JSON.stringify({ thumbprint }) };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(TRUST_QUERY_SCRIPT, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024, env });
  const result = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  assert.equal(typeof result.trustedLeaf, 'boolean');
  assert.equal(typeof result.machineTrustedLeaf, 'boolean');
  assert.equal(typeof result.rootLeaf, 'boolean');
  assert.equal(Array.isArray(result.ownedMarkers), true);
  assert.equal(Array.isArray(result.machineOwnedMarkers), true);
  return result;
}

async function registrationSmoke(shell, metadata, expectedLocation, before, root) {
  const build = Number(os.release().split('.')[2]);
  assert.ok(Number.isInteger(build) && build >= 22000, 'Registration smoke requires Windows build 22000 or newer.');
  assert.equal(before.registered, false, 'Registration smoke must preserve a previously registered Brclio package.');
  assert.notEqual(before.conflict, true, 'Registration smoke must preserve a conflicting same-name package.');
  assert.match(metadata.certificateThumbprint, /^[a-fA-F0-9]{40}$/, 'Signed fixture must identify its public leaf.');
  const harness = process.env.BRCLIO_WINDOWS_SHELL_COM_HARNESS;
  assert.ok(typeof harness === 'string' && path.isAbsolute(harness), 'Registration smoke requires the compiled native COM activation harness.');
  assert.equal((await fs.stat(harness)).isFile(), true);
  const initialTrust = await readTrust(metadata.certificateThumbprint);
  assert.deepEqual(initialTrust.ownedMarkers, [], 'Registration smoke requires a disposable user without existing Brclio trust ownership.');
  assert.deepEqual(initialTrust.machineOwnedMarkers, [], 'Registration smoke requires a disposable machine without existing Brclio trust ownership.');
  if (metadata.selfSigned) {
    assert.equal(initialTrust.trustedLeaf, false, 'The fixture leaf must start untrusted.');
    assert.equal(initialTrust.machineTrustedLeaf, false, 'The machine fixture leaf must start untrusted.');
    assert.equal(initialTrust.rootLeaf, false, 'The fixture leaf must not be a trusted root.');
  }

  async function verifyCleanup(state) {
    assert.equal(state.error, undefined, state.description);
    assert.equal(state.installed, false, state.description);
    assert.equal(state.registered, false, state.description);
    if (metadata.selfSigned) assert.equal(state.needsTrust, true, 'Disabling must revoke the fixture leaf trust imported by this smoke.');
    const trust = await readTrust(metadata.certificateThumbprint);
    assert.deepEqual(trust.ownedMarkers, [], 'Disabling must remove Brclio certificate ownership markers.');
    assert.deepEqual(trust.machineOwnedMarkers, [], 'Disabling must remove machine certificate ownership markers through the native helper.');
    if (metadata.selfSigned) {
      assert.equal(trust.trustedLeaf, false, 'Disabling must remove the imported fixture certificate.');
      assert.equal(trust.machineTrustedLeaf, false, 'Disabling must remove the imported machine fixture certificate.');
      assert.equal(trust.rootLeaf, false, 'No phase may add the fixture certificate to a Root store.');
    }
  }

  let enableAttempted = false;
  let failure;
  try {
    enableAttempted = true;
    const enabled = await shell.set(true);
    assert.equal(enabled.error, undefined, enabled.description);
    assert.equal(enabled.installed, true, enabled.description);
    assert.equal(enabled.registered, true, enabled.description);
    assert.equal(sameLocation(enabled.location, expectedLocation), true, 'The registered extension must resolve to the fixture install root and version.');
    const activation = await promisify(execFile)(harness, ['--registered', root, metadata.packageVersion],
      { windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 });
    assert.match(activation.stdout, /Registered packaged COM surrogate activation and IExplorerCommand calls passed/);
    console.log(activation.stdout.trim());
    if (metadata.selfSigned) {
      const trust = await readTrust(metadata.certificateThumbprint);
      assert.equal(trust.trustedLeaf, true, 'Enabling must trust only the fixture public leaf.');
      assert.equal(trust.machineTrustedLeaf, true, 'Enabling must import the exact machine leaf required by Appx deployment.');
      assert.equal(trust.rootLeaf, false, 'Enabling must leave Root stores untouched.');
      assert.ok(trust.ownedMarkers.some(value => value.toUpperCase() === metadata.certificateThumbprint.toUpperCase()), 'Enabling must record ownership of the imported fixture certificate.');
      assert.ok(trust.machineOwnedMarkers.some(value => value.toUpperCase() === metadata.certificateThumbprint.toUpperCase()), 'Enabling must record native helper ownership of the imported machine certificate.');
    }
    await verifyCleanup(await shell.set(false));
  } catch (error) {
    failure = error;
  } finally {
    // Once enabling begins, always exercise idempotent removal, including
    // failures during trust import or Add-AppxPackage. Runtime ownership
    // validation preserves any unrelated registration.
    if (enableAttempted) {
      try { await verifyCleanup(await shell.set(false)); }
      catch (cleanupError) { failure = failure ? new AggregateError([failure, cleanupError], 'Registration smoke failed and cleanup did not fully complete.') : cleanupError; }
    }
  }
  if (failure) throw failure;
  console.log('Windows shell registration smoke passed (real Add-AppxPackage, packaged COM surrogate activation, external root/version readback, Remove-AppxPackage and owned leaf cleanup; Explorer appearance requires desktop verification).');
}

async function main() {
  assert.equal(process.platform, 'win32', 'Windows shell query smoke requires Windows.');
  assert.equal(process.argv.length, 3, 'Usage: node desktop/windows-shell-smoke.cjs <install-root>');
  const root = await fs.realpath(path.resolve(process.argv[2]));
  const directory = path.join(root, 'resources', 'windows-shell');
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'shell-build.json'), 'utf8'));
  assert.match(metadata.packageVersion, /^\d+\.\d+\.\d+\.\d+$/, 'Fixture has no valid Windows package version.');
  assert.equal(metadata.dll, `${metadata.packageVersion}\\BrclioExplorerCommand.dll`, 'Fixture must use its versioned DLL path.');
  assert.equal(metadata.signed, true, 'Query smoke requires the signed shell fixture.');

  // The default smoke only reads the real
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
  if (process.env.BRCLIO_ALLOW_SHELL_REGISTRATION_SMOKE === '1') {
    await registrationSmoke(shell, metadata, path.join(directory, metadata.dll), state, root);
  }
}

main().catch(error => {
  // Node also prints AggregateError.errors, keeping the original Appx failure
  // visible if cleanup independently reports a second failure.
  console.error(error);
  process.exitCode = 1;
});

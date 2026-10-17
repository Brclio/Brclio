#!/usr/bin/env node
'use strict';

// Inspect the actual electron-builder output. This script never imports a
// certificate, registers an Appx package, launches Brclio, or runs the helper.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');
const { compilerEnvironment, execute, manifestVersion, renderManifest } = require('./windows-build-shell.cjs');
const { POWERSHELL_SIGNATURE_FUNCTIONS } = require('../desktop/windows-shell-signature.cjs');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const privateName = /\.(?:pfx|p12|pem|key|jks|keystore)$/i;
const crtImport = /\b(?:vcruntime|msvcp|msvcr)[a-z0-9_]*\.dll\b|\bucrtbase(?:d)?\.dll\b/i;

function peInfo(filename) {
  const bytes = fs.readFileSync(filename);
  assert.ok(bytes.length >= 64 && bytes.toString('ascii', 0, 2) === 'MZ', `${filename} must be a PE file.`);
  const offset = bytes.readUInt32LE(0x3c);
  assert.ok(offset + 96 <= bytes.length && bytes.toString('ascii', offset, offset + 4) === 'PE\0\0', 'Invalid PE headers.');
  assert.equal(bytes.readUInt16LE(offset + 4), 0x8664, `${filename} must be x64.`);
  assert.equal(bytes.readUInt16LE(offset + 24), 0x20b, `${filename} must use PE32+.`);
  return { architecture: 'x64', dll: Boolean(bytes.readUInt16LE(offset + 22) & 0x2000),
    subsystem: bytes.readUInt16LE(offset + 24 + 68) };
}

function filesIn(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    assert.equal(item.isSymbolicLink(), false, `Unexpected package symlink: ${relative}`);
    return item.isDirectory() ? filesIn(path.join(directory, item.name), relative) : [relative];
  });
}

const VERIFY_SCRIPT = `${POWERSHELL_SIGNATURE_FUNCTIONS}\n` + String.raw`
$ErrorActionPreference = 'Stop'
$request = [Environment]::GetEnvironmentVariable('BRCLIO_WINDOWS_PACKAGE_VERIFY') | ConvertFrom-Json
$directory = Join-Path $request.root 'resources\windows-shell'
$metadata = [IO.File]::ReadAllText((Join-Path $directory 'shell-build.json')) | ConvertFrom-Json
$certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new((Join-Path $directory 'BrclioShell.cer'))
try {
  if ($certificate.HasPrivateKey) { throw 'The packaged public certificate contains a private key.' }
  if ($certificate.Subject -cne $metadata.publisher -or $certificate.Thumbprint -ine $metadata.certificateThumbprint -or (Get-BrclioShellCertificateHash $certificate) -ine $metadata.certificateSha256) { throw 'The packaged public certificate does not match its signing ledger.' }
  $checks = @()
  foreach ($relative in @($metadata.dll, 'BrclioShell.msix', 'BrclioShellTrust.exe')) {
    $file = Join-Path $directory $relative
    $policy = Test-BrclioShellSignature $file $metadata.publisher $directory
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($null -eq $signature.SignerCertificate -or [Convert]::ToBase64String($signature.SignerCertificate.RawData) -cne [Convert]::ToBase64String($certificate.RawData)) { throw 'A packaged native asset has a different signing certificate.' }
    $checks += @{ file=$relative; signatureStatus=[string]$signature.Status; winVerifyTrust=('0x{0:X8}' -f [uint32]$policy.statusCode); pinned=[bool]$policy.pinned; needsTrust=[bool]$policy.needsTrust }
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead((Join-Path $directory 'BrclioShell.msix'))
  try {
    $entry = $archive.GetEntry('AppxManifest.xml')
    if ($null -eq $entry -or $entry.Length -gt 262144) { throw 'The identity MSIX manifest is missing or oversized.' }
    $stream = $entry.Open()
    $settings = [Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $reader = [Xml.XmlReader]::Create($stream, $settings)
    try {
      $manifest = [Xml.XmlDocument]::new()
      $manifest.XmlResolver = $null
      $manifest.Load($reader)
    } finally { $reader.Dispose(); $stream.Dispose() }
    $ns = [Xml.XmlNamespaceManager]::new($manifest.NameTable)
    $ns.AddNamespace('f', 'http://schemas.microsoft.com/appx/manifest/foundation/windows10')
    $ns.AddNamespace('com', 'http://schemas.microsoft.com/appx/manifest/com/windows10')
    $ns.AddNamespace('d4', 'http://schemas.microsoft.com/appx/manifest/desktop/windows10/4')
    $ns.AddNamespace('d5', 'http://schemas.microsoft.com/appx/manifest/desktop/windows10/5')
    $identity = $manifest.SelectSingleNode('/f:Package/f:Identity', $ns)
    if ($null -eq $identity -or $identity.GetAttribute('Name') -cne 'Brclio.Toolbox.Shell' -or $identity.GetAttribute('Publisher') -cne $metadata.publisher -or $identity.GetAttribute('Version') -cne $request.packageVersion -or $identity.GetAttribute('ProcessorArchitecture') -cne 'x64') { throw 'The actual MSIX identity differs from the release.' }
    $application = $manifest.SelectSingleNode('/f:Package/f:Applications/f:Application[@Id="Brclio" and @Executable="Brclio.exe"]', $ns)
    if ($null -eq $application) { throw 'The actual MSIX application mapping differs.' }
    $classes = @($application.SelectNodes('f:Extensions/com:Extension/com:ComServer/com:SurrogateServer/com:Class', $ns))
    if ($classes.Count -ne 1 -or $classes[0].GetAttribute('Id') -ine 'CFD1E4D4-3973-45D3-8542-45A77E6C58C9' -or $classes[0].GetAttribute('Path') -cne ('resources\windows-shell\' + $metadata.dll) -or $classes[0].GetAttribute('ThreadingModel') -cne 'STA') { throw 'The actual MSIX COM surrogate mapping differs.' }
    foreach ($type in @('*', 'Directory', 'Directory\Background')) {
      $items = @($application.SelectNodes('f:Extensions/d4:Extension/d4:FileExplorerContextMenus/d5:ItemType', $ns) | Where-Object { $_.GetAttribute('Type') -ceq $type })
      if ($items.Count -ne 1) { throw 'The actual MSIX lacks an Explorer context.' }
      $verbs = @($items[0].SelectNodes('d5:Verb', $ns))
      if ($verbs.Count -ne 1 -or $verbs[0].GetAttribute('Id') -cne 'BrclioCopyPath' -or $verbs[0].GetAttribute('Clsid') -ine 'CFD1E4D4-3973-45D3-8542-45A77E6C58C9') { throw 'The actual MSIX context command differs.' }
    }
    $entries = @($archive.Entries | ForEach-Object { $_.FullName })
    if (@($entries | Where-Object { $_ -match '\.(pfx|p12|pem|key|jks|keystore)$' }).Count -gt 0) { throw 'The identity package contains a possible private key.' }
  } finally { $archive.Dispose() }
  $result = @{ publicCertificateOnly=$true; signatures=$checks; msixManifestMatches=$true; msixEntries=$entries }
  $encoded = [Text.Encoding]::UTF8.GetBytes(($result | ConvertTo-Json -Depth 10 -Compress))
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write($encoded, 0, $encoded.Length)
  $stdout.Flush()
} finally { $certificate.Dispose() }
`;

function verify({ directory, version, reportPath }) {
  assert.equal(process.platform, 'win32', 'Actual Windows package verification requires Windows.');
  const root = fs.realpathSync(directory);
  const packageVersion = manifestVersion(version);
  const shell = path.join(root, 'resources', 'windows-shell');
  const metadata = JSON.parse(fs.readFileSync(path.join(shell, 'shell-build.json'), 'utf8'));
  assert.equal(metadata.version, version);
  assert.equal(metadata.packageVersion, packageVersion);
  assert.equal(metadata.arch, 'x64');
  assert.equal(metadata.runtime, 'static');
  assert.equal(metadata.signed, true);
  assert.equal(metadata.packageName, 'Brclio.Toolbox.Shell');
  assert.equal(metadata.applicationId, 'Brclio');
  assert.equal(metadata.clsid, 'CFD1E4D4-3973-45D3-8542-45A77E6C58C9');
  assert.equal(metadata.dll, `${packageVersion}\\BrclioExplorerCommand.dll`);
  assert.equal(metadata.msix, 'BrclioShell.msix');
  assert.equal(metadata.trustHelper, 'BrclioShellTrust.exe');
  assert.equal(fs.readFileSync(path.join(shell, 'AppxManifest.xml'), 'utf8'), renderManifest(version, metadata.publisher));
  assert.equal(fs.readFileSync(path.join(shell, 'VerifyShellSignature.ps1'), 'utf8'), `\uFEFF${POWERSHELL_SIGNATURE_FUNCTIONS}`);
  const pe = { application: peInfo(path.join(root, 'Brclio.exe')),
    extension: peInfo(path.join(shell, metadata.dll)), helper: peInfo(path.join(shell, metadata.trustHelper)) };
  assert.equal(pe.application.dll, false);
  assert.equal(pe.extension.dll, true);
  assert.equal(pe.helper.dll, false);
  assert.equal(pe.helper.subsystem, 2, 'The trust helper must be a Windows GUI subsystem executable.');
  const hashes = {};
  for (const [relative, field] of [[metadata.dll, 'sha256'], [metadata.msix, 'msixSha256'],
    [metadata.trustHelper, 'trustHelperSha256'], ['BrclioShell.cer', 'certificateSha256']]) {
    assert.match(metadata[field], /^[a-fA-F0-9]{64}$/);
    const actual = hash(fs.readFileSync(path.join(shell, relative)));
    assert.equal(actual, metadata[field].toLowerCase(), `${relative} hash differs from the ledger.`);
    hashes[relative] = actual;
  }
  for (const [name, size] of [['StoreLogo', 50], ['Square44x44Logo', 44], ['Square150x150Logo', 150]]) {
    const bytes = fs.readFileSync(path.join(shell, 'Assets', `${name}.png`));
    assert.equal(bytes.toString('hex', 0, 8), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
  const files = filesIn(root);
  const asarFiles = asar.listPackage(path.join(root, 'resources', 'app.asar'));
  assert.deepEqual(files.filter(item => privateName.test(item)), [], 'The installed package contains a possible private key.');
  assert.deepEqual(asarFiles.filter(item => privateName.test(item)), [], 'app.asar contains a possible private key.');
  assert.equal(JSON.parse(asar.extractFile(path.join(root, 'resources', 'app.asar'), 'package.json').toString('utf8')).version, version);
  const env = compilerEnvironment();
  const imports = {};
  for (const relative of [metadata.dll, metadata.trustHelper]) {
    const output = execute('dumpbin.exe', ['/nologo', '/dependents', path.join(shell, relative)], { env });
    assert.doesNotMatch(output, crtImport, `${relative} must not require a Visual C++ runtime redistributable.`);
    imports[relative] = [...new Set(output.match(/\b[a-zA-Z0-9_.-]+\.dll\b/g) || [])]
      .filter(name => name.toLowerCase() !== path.basename(relative).toLowerCase());
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'brclio-windows-package-verify-'));
  let native;
  try {
    const script = path.join(temporary, 'verify.ps1');
    fs.writeFileSync(script, `\uFEFF${VERIFY_SCRIPT}`, 'utf8');
    const verificationEnv = { ...process.env,
      BRCLIO_WINDOWS_PACKAGE_VERIFY: JSON.stringify({ root, packageVersion }) };
    for (const key of Object.keys(verificationEnv)) if (key.toLowerCase() === 'psmodulepath') delete verificationEnv[key];
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    native = JSON.parse(execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { env: verificationEnv }));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  const report = { passed: true, version, packageVersion, directory: root, verifiedAt: new Date().toISOString(),
    trustChanges: false, packageRegistrationChanges: false, pe, imports, hashes,
    privateKeyNamesAbsent: true, installedFileCount: files.length, asarFileCount: asarFiles.length, ...native };
  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify({ passed: true, version, report: reportPath || null, imports, signatures: native.signatures }));
  return report;
}

if (require.main === module) {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index];
    assert.ok(['--dir', '--version', '--report'].includes(flag) && process.argv[index + 1],
      'Usage: node scripts/windows-verify-package.cjs --dir release/win-unpacked --version X.Y.Z [--report FILE]');
    options[{ '--dir': 'directory', '--version': 'version', '--report': 'reportPath' }[flag]] = process.argv[index + 1];
  }
  assert.ok(options.directory && options.version, '--dir and --version are required.');
  verify(options);
}

module.exports = { verify, peInfo, filesIn, VERIFY_SCRIPT };

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createWindowsShell, WINDOWS_SHELL_SCRIPT, PACKAGE_NAME, REQUEST_ENV, parseResult, sameLocation } = require('./windows-shell.cjs');
const { POWERSHELL_SIGNATURE_FUNCTIONS } = require('./windows-shell-signature.cjs');

const root = "C:\\用户's & folder\\Brclio";
const launch = { packaged: true, executable: `${root}\\Brclio.exe` };
const thumbprint = 'A'.repeat(40);
const assets = (overrides = {}) => ({ available: true, publisher: 'CN=Brclio', version: '0.1.7.0', error: null, needsTrust: false, certificateThumbprint: thumbprint, ...overrides });
const entry = (overrides = {}) => ({ name: PACKAGE_NAME, publisher: 'CN=Brclio', fullName: `${PACKAGE_NAME}_0.1.7.0_x64__family`, version: '0.1.7.0', externalLocation: root, owned: true, usable: true, healthy: true, rollbackAvailable: true, ...overrides });
const result = (packages = [], assetOverrides = {}, more = {}) => ({ ok: true, assets: assets(assetOverrides), packages, ...more });
function fake(handler) {
  const calls = [];
  const scriptPaths = [];
  const run = async (program, args, options) => {
    const request = JSON.parse(options.env[REQUEST_ENV]);
    calls.push(request);
    scriptPaths.push(args.at(-1));
    assert.equal(program, 'powershell.exe');
    assert.deepEqual(args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
    assert.equal(await fs.readFile(args.at(-1), 'utf8'), `\uFEFF${WINDOWS_SHELL_SCRIPT}`);
    assert.equal(Object.keys(options.env).some(key => key.toLowerCase() === 'psmodulepath'), false);
    return { stdout: JSON.stringify(await handler(request, calls)) };
  };
  return { shell: createWindowsShell({ launch, run, powershell: 'powershell.exe' }), calls, scriptPaths };
}

test('fixed PowerShell script uses safe environment data, UTF-8, official package identity and external-location APIs', async () => {
  const { shell, calls, scriptPaths } = fake(() => result([entry()]));
  const state = await shell.status();
  assert.equal(state.installed, true);
  assert.equal(state.location, `${root}\\resources\\windows-shell\\0.1.7.0\\BrclioExplorerCommand.dll`);
  assert.deepEqual(calls, [{ action: 'query', root, executableName: 'Brclio.exe' }]);
  await assert.rejects(fs.stat(scriptPaths[0]), { code: 'ENOENT' });
  assert.match(WINDOWS_SHELL_SCRIPT, /\[Text.Encoding\]::UTF8.GetBytes/);
  assert.match(WINDOWS_SHELL_SCRIPT, /OpenStandardOutput/);
  assert.match(WINDOWS_SHELL_SCRIPT, /Get-AppxPackageManifest -Package/);
  assert.match(WINDOWS_SHELL_SCRIPT, /EffectiveExternalLocation\.Path/);
  assert.match(WINDOWS_SHELL_SCRIPT, /Status.VerifyIsOK\(\)/);
  assert.match(WINDOWS_SHELL_SCRIPT, /Add-AppxPackage -Path \$candidate.packagePath -ExternalLocation \$root/);
  assert.match(WINDOWS_SHELL_SCRIPT, /Read-MsixManifest/);
  assert.ok(WINDOWS_SHELL_SCRIPT.includes("'resources\\windows-shell\\' + $version + '\\BrclioExplorerCommand.dll'"));
  assert.ok(WINDOWS_SHELL_SCRIPT.includes("'resources\\windows-shell\\' + $entry.version + '\\BrclioExplorerCommand.dll'"));
  assert.doesNotMatch(WINDOWS_SHELL_SCRIPT, /Add-AppxPackage[^\n]*-Register|AllowAllTrustedApps|AllowDevelopmentWithoutDevLicense|LocalMachine|Cert:\\.*Root|Import-PfxCertificate/);
  assert.doesNotMatch(WINDOWS_SHELL_SCRIPT, /用户's|folder/);
});

test('preview does not execute Windows commands and asks for installed assets', async () => {
  const shell = createWindowsShell({ launch: { ...launch, packaged: false }, run: () => assert.fail('preview must not launch PowerShell') });
  assert.equal((await shell.status()).requiresInstall, true);
  assert.equal((await shell.set(false)).registered, false);
  await assert.rejects(shell.set(true), /正式安装包/);
  await assert.rejects(shell.set('true'), TypeError);
});

test('registered menus require exact name, publisher, version, usable files, healthy state and current install root', async () => {
  for (const overrides of [{ name: 'Other' }, { publisher: 'CN=Other' }, { version: '0.1.6.0' }, { externalLocation: 'C:\\Old' }, { usable: false }, { healthy: false }, { owned: false }]) {
    const { shell } = fake(() => result([entry(overrides)]));
    assert.equal((await shell.status()).installed, false, JSON.stringify(overrides));
  }
  const custom = fake(() => result([entry({ publisher: 'CN=Company, O=Company' })], { publisher: 'CN=Company, O=Company' }));
  assert.equal((await custom.shell.status()).installed, true);
  assert.equal(sameLocation(root.toUpperCase() + '\\.', root), true);
});

test('missing, unsigned or untrusted source assets never claim installed and cannot enable', async () => {
  const { shell, calls } = fake(() => result([entry()], { available: false, error: '请安装已签名的正式安装包。' }));
  const state = await shell.status();
  assert.equal(state.available, false);
  assert.equal(state.installed, false);
  assert.equal(state.registered, true);
  assert.equal(state.requiresInstall, true);
  await assert.rejects(shell.set(true), /已签名/);
  assert.equal(calls.some(item => item.action === 'install'), false);
});

test('enable verifies readback; already installed package is unchanged', async () => {
  let installed = false;
  const { shell, calls } = fake(request => {
    if (request.action === 'install') installed = true;
    return result(installed ? [entry()] : []);
  });
  assert.equal((await shell.set(true)).installed, true);
  assert.deepEqual(calls.map(item => item.action), ['query', 'install']);
  calls.length = 0;
  assert.equal((await shell.set(true)).installed, true);
  assert.deepEqual(calls.map(item => item.action), ['query']);
  const failed = fake(() => result());
  await assert.rejects(failed.shell.set(true), /未确认/);
});

test('foreign same-name package is preserved during enable and disable', async () => {
  const foreign = entry({ publisher: 'CN=Foreign', owned: false });
  const { shell, calls } = fake(() => result([foreign]));
  await assert.rejects(shell.set(true), /不属于 Brclio/);
  assert.equal((await shell.set(false)).registered, false);
  assert.equal(calls.some(item => item.action === 'remove' || item.action === 'install'), false);
});

test('disable works without package assets, removes only owned registrations and cleans owned trust', async () => {
  let packages = [entry(), entry({ publisher: 'CN=Other', owned: false, fullName: 'foreign' })];
  const { shell, calls } = fake(request => {
    if (request.action === 'remove') packages = packages.filter(item => item.fullName !== request.fullName);
    return result(packages, { available: false, error: '安装包缺失' });
  });
  assert.equal((await shell.set(false)).registered, false);
  assert.deepEqual(calls.filter(item => item.action === 'remove').map(item => item.fullName), [entry().fullName]);
  assert.equal(calls.at(-1).action, 'removeTrust');
});

test('moved same-version extension removes old registration and verifies new location', async () => {
  let packages = [entry({ externalLocation: 'C:\\Old' })];
  const { shell, calls } = fake(request => {
    if (request.action === 'remove') packages = [];
    if (request.action === 'install') packages = [entry()];
    return result(packages);
  });
  assert.equal((await shell.status()).stale, true);
  calls.length = 0;
  assert.equal((await shell.set(true)).installed, true);
  assert.deepEqual(calls.map(item => item.action), ['query', 'remove', 'install']);
});

test('registration failure restores usable previous root; unrestorable old installs stay untouched', async () => {
  const old = entry({ externalLocation: 'C:\\Old' });
  let packages = [old];
  const { shell, calls } = fake(request => {
    if (request.action === 'remove') packages = [];
    if (request.action === 'install') throw new Error('模拟注册失败');
    if (request.action === 'restore') { assert.equal(request.restoreRoot, 'C:\\Old'); packages = [old]; }
    return result(packages);
  });
  await assert.rejects(shell.set(true), /模拟注册失败/);
  assert.deepEqual(calls.map(item => item.action), ['query', 'remove', 'install', 'query', 'restore']);
  assert.deepEqual(packages, [old]);
  const blocked = fake(() => result([entry({ externalLocation: 'C:\\Old', rollbackAvailable: false })]));
  await assert.rejects(blocked.shell.set(true), /保留当前菜单/);
  assert.deepEqual(blocked.calls.map(item => item.action), ['query']);
});

test('same-version stale nonexistent root can be replaced without a usable previous installation', async () => {
  let packages = [entry({ externalLocation: 'C:\\Missing', usable: false, rollbackAvailable: false })];
  const { shell } = fake(request => {
    if (request.action === 'remove') packages = [];
    if (request.action === 'install') packages = [entry()];
    return result(packages);
  });
  assert.equal((await shell.set(true)).installed, true);
});

test('pinned self-signed leaf is trusted before registration and trust is rolled back on failure', async () => {
  let trusted = false;
  const { shell, calls } = fake(request => {
    if (request.action === 'trust') { trusted = true; return result([], {}, { trustImported: true }); }
    if (request.action === 'install') throw new Error('注册失败');
    if (request.action === 'removeTrust') { assert.equal(request.thumbprint, thumbprint); trusted = false; }
    return result([], { needsTrust: !trusted });
  });
  const state = await shell.status();
  assert.equal(state.available, true);
  assert.equal(state.needsTrust, true);
  assert.equal(state.installed, false);
  calls.length = 0;
  await assert.rejects(shell.set(true), /注册失败/);
  assert.equal(trusted, false);
  assert.deepEqual(calls.map(item => item.action), ['query', 'trust', 'install', 'removeTrust']);
  assert.match(WINDOWS_SHELL_SCRIPT, /X509Store\('TrustedPeople', 'CurrentUser'\)/);
  assert.match(WINDOWS_SHELL_SCRIPT, /CertificateSha256/);
  assert.match(WINDOWS_SHELL_SCRIPT, /certificate\.HasPrivateKey/);
  assert.match(WINDOWS_SHELL_SCRIPT, /1\.3\.6\.1\.5\.5\.7\.3\.3/);
  assert.ok(WINDOWS_SHELL_SCRIPT.includes(POWERSHELL_SIGNATURE_FUNCTIONS));
  assert.match(WINDOWS_SHELL_SCRIPT, /!\$verified.trusted -or !\$verifiedDll.trusted/);
  assert.match(WINDOWS_SHELL_SCRIPT, /\$store.Remove\(\$certificate\)/);
  assert.match(WINDOWS_SHELL_SCRIPT, /\$_.Publisher -ceq \$values.Publisher/);
});

test('shared signature policy pins exact current-user leaf and rejects every WinVerifyTrust failure except explicit untrusted-root', () => {
  const source = POWERSHELL_SIGNATURE_FUNCTIONS;
  assert.match(source, /WinVerifyTrust\(new IntPtr\(-1\), ref action, ref data\)/);
  assert.match(source, /data.uiChoice = 2/);
  assert.match(source, /data.stateAction = 1/);
  assert.match(source, /data.stateAction = 2/);
  assert.match(source, /data.providerFlags = 0x1000/);
  assert.match(source, /00AAC56B-CD44-11D0-8CC2-00C04FC295EE/);
  assert.match(source, /\$code -ne \[uint32\]0 -and \$code -ne \[uint32\]2148204809/);
  assert.doesNotMatch(source, /\[uint32\]0x800B0109|UnknownError|NotTrusted|LocalMachine|Import-Certificate|ReadWrite/);
  assert.match(source, /X509Store\('TrustedPeople', 'CurrentUser'\)/);
  assert.match(source, /OpenFlags\]::ReadOnly/);
  assert.match(source, /\$certificate.Subject -cne \$Publisher/);
  assert.match(source, /\$certificate.Issuer -cne \$certificate.Subject/);
  assert.match(source, /CertificateAuthority/);
  assert.match(source, /DigitalSignature/);
  assert.match(source, /1\.3\.6\.1\.5\.5\.7\.3\.3/);
  assert.match(source, /\$certificate.NotBefore -gt \[DateTime\]::Now/);
  assert.match(source, /\$certificate.NotAfter -lt \[DateTime\]::Now/);
  assert.match(source, /ToBase64String\(\$certificate.RawData\) -cne \[Convert\]::ToBase64String\(\$signature.SignerCertificate.RawData\)/);
  assert.match(source, /ToBase64String\(\$_.RawData\) -ceq \[Convert\]::ToBase64String\(\$certificate.RawData\)/);
  assert.match(source, /Get-BrclioShellFileHash \$Path\) -ine \$expectedHash/);
  assert.match(source, /\$expectedHash = \$metadata.sha256/);
  assert.match(source, /\$expectedHash = \$metadata.msixSha256/);
  assert.match(source, /\$signature.Status -ne 'Valid'/);
});

test('preexisting trust is preserved after registration failure; existing registration can be fixed by trust only', async () => {
  const failed = fake(request => {
    if (request.action === 'trust') return result([], {}, { trustImported: false });
    if (request.action === 'install') throw new Error('注册失败');
    return result([], { needsTrust: true });
  });
  await assert.rejects(failed.shell.set(true), /注册失败/);
  assert.equal(failed.calls.some(item => item.action === 'removeTrust'), false);
  const fixed = fake(request => result([entry()], { needsTrust: request.action !== 'trust' }, { trustImported: request.action === 'trust' }));
  assert.equal((await fixed.shell.set(true)).installed, true);
  assert.deepEqual(fixed.calls.map(item => item.action), ['query', 'trust']);
});

test('malformed, oversized, or wrongly typed native output is rejected without claiming success', async () => {
  for (const value of ['not json', '[]', ' '.repeat(256 * 1024 + 1), JSON.stringify(result([entry({ healthy: 'true' })])), JSON.stringify(result([], { needsTrust: 'false' })), JSON.stringify(result([], { certificateThumbprint: 42 })), JSON.stringify(result([], {}, { trustImported: 'true' }))]) assert.throws(() => parseResult(value));
  const { shell } = fake(() => ({ ok: false, error: 'WinRT 查询失败' }));
  const state = await shell.status();
  assert.equal(state.installed, false);
  assert.equal(state.requiresInstall, false);
  assert.match(state.description, /WinRT 查询失败/);
  await assert.rejects(shell.set(true), /WinRT 查询失败/);
});

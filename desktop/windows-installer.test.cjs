'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createWindowsInstaller, HELPER, LAUNCHER, SHELL_PACKAGE_FUNCTIONS } = require('./windows-installer.cjs');
const { QUERY_SCRIPT } = require('./windows-registry.cjs');
const { POWERSHELL_SIGNATURE_FUNCTIONS } = require('./windows-shell-signature.cjs');

function extractUninstallScript(source) {
  return source.split(/\r?\n/).filter(line => line.startsWith('  FileWrite $R3 "'))
    .map(line => line.slice('  FileWrite $R3 "'.length, -1).replace(/\$\\r\$\\n$/, '').replaceAll('$\\"', '"').replaceAll('$$', '$')).join('\n') + '\n';
}

async function readUninstallScript() {
  return extractUninstallScript(await fs.readFile(path.join(__dirname, 'uninstall.nsh'), 'utf8'));
}

async function fixture(t, { readyError, spawnError, readyTimeout } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-windows-install-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const filename = path.join(temporary, 'Brclio-0.1.3-windows-x64.exe');
  const payload = Buffer.from('Verified NSIS fixture payload (not executable).');
  await fs.writeFile(filename, payload);
  const verified = { filename, expected: crypto.createHash('sha256').update(payload).digest('hex'), size: payload.length, version: '0.1.3' };
  const userData = path.join(temporary, 'user data 中文');
  const executable = 'C:\\Users\\中文 用户\\Brclio & Tools\\Brclio.exe';
  const calls = [];
  let configuration;
  let child;
  const installer = createWindowsInstaller({ platform: 'win32', userData, executable, parentPid: 1234, readyTimeout, showErrors: false,
    spawn: (program, args, options) => {
      calls.push({ program, args, options });
      child = new EventEmitter();
      child.unref = () => { child.unreferenced = true; };
      child.kill = () => { child.killed = true; };
      setImmediate(async () => {
        if (spawnError) { child.emit('error', new Error(spawnError)); return; }
        configuration = JSON.parse(await fs.readFile(args.at(-1), 'utf8'));
        if (!readyTimeout) {
          // Match Write-Report: publish only a complete receipt so the parent
          // cannot observe the empty file between open and write.
          const temporaryReady = `${configuration.readyPath}.tmp`;
          await fs.writeFile(temporaryReady, JSON.stringify(readyError ? { status: 'error', error: readyError } : { status: 'ready' }));
          await fs.rename(temporaryReady, configuration.readyPath);
        }
      });
      return child;
    } });
  return { installer, verified, calls, userData, executable, temporary, configuration: () => configuration, child: () => child };
}

test('Windows installation validates the official descriptor and hash before any helper runs', async t => {
  const { installer, verified, calls } = await fixture(t);
  for (const change of [{ version: '1.2.3-beta' }, { expected: 'a' }, { size: verified.size + 1 }, { filename: path.join(path.dirname(verified.filename), 'Other.exe') }]) {
    await assert.rejects(installer.start({ ...verified, ...change }), /官方|已变更/);
  }
  await fs.appendFile(verified.filename, 'tampered');
  await assert.rejects(installer.start(verified), /已变更/);
  assert.equal(calls.length, 0);
});

test('Windows installer handoff waits for helper readiness, guards concurrent requests, and never reports completion', async t => {
  const { installer, verified, calls, userData, executable, configuration, child } = await fixture(t);
  const first = installer.start(verified);
  assert.equal(installer.start(verified), first);
  const result = await first;
  assert.equal(calls.length, 1);
  assert.equal(result.installerStarted, true);
  assert.equal(result.automaticInstall, true);
  assert.equal(result.status, undefined);
  assert.equal(await installer.readResult(), null);
  const cfg = configuration();
  assert.equal(cfg.executable, executable);
  assert.equal(cfg.installDirectory, path.win32.dirname(executable));
  assert.equal(cfg.parentPid, 1234);
  assert.equal(path.dirname(path.dirname(cfg.readyPath)), path.join(userData, 'updates', 'install-jobs'));
  assert.match(cfg.token, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(await fs.readFile(cfg.commitPath, 'utf8')), { token: cfg.token });
  assert.equal(child().unreferenced, true);
  assert.equal(calls[0].options.detached, undefined);
  assert.equal(calls[0].options.stdio[0], 'ignore');
  assert.equal(typeof calls[0].options.stdio[1], 'number');
  assert.equal(calls[0].options.stdio[1], calls[0].options.stdio[2]);
  assert.equal(calls[0].options.shell, undefined);
  assert.equal(Object.keys(calls[0].options.env).some(name => name.toLowerCase() === 'psmodulepath'), false);
  assert.deepEqual(calls[0].args.slice(0, 7), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(path.dirname(cfg.readyPath), 'launch.ps1')]);
  assert.equal((await fs.readFile(calls[0].args[6], 'utf8')).charCodeAt(0), 0xfeff, 'Windows PowerShell 5.1 receives a UTF-8 BOM');
});

test('Windows updater requires the exact job token, installed executable, and running version for launch acknowledgement', async t => {
  const { installer, verified, configuration, userData, executable } = await fixture(t);
  await installer.start(verified);
  const cfg = configuration();
  const job = path.dirname(cfg.readyPath);
  const args = ['Brclio.exe', '--updated', '--brclio-update-job', job, '--brclio-update-token', cfg.token];
  await assert.rejects(installer.acknowledgeLaunch(args, '0.1.2'), /不匹配/);
  await assert.rejects(installer.acknowledgeLaunch([...args.slice(0, -1), 'a'.repeat(64)], verified.version), /不匹配/);
  const other = createWindowsInstaller({ executable: 'C:\\Other\\Brclio.exe', userData });
  await assert.rejects(other.acknowledgeLaunch(args, verified.version), /不匹配/);
  await assert.rejects(installer.acknowledgeLaunch([...args, '--brclio-update-job', job], verified.version), /参数无效/);
  assert.equal(await installer.acknowledgeLaunch(['Brclio.exe'], verified.version), null);
  assert.deepEqual(await installer.acknowledgeLaunch(args, verified.version), { acknowledged: true, version: verified.version });
  assert.deepEqual(JSON.parse(await fs.readFile(cfg.ackPath, 'utf8')), { token: cfg.token, version: verified.version, executable, pid: process.pid });
  assert.deepEqual(await installer.acknowledgeLaunch(args, verified.version), { acknowledged: true, version: verified.version });
});

test('Windows cancellation is limited to the private pending job and does not claim installer completion', async t => {
  const { installer, verified, configuration } = await fixture(t);
  assert.deepEqual(await installer.cancelPending(), { cancellationRequested: false });
  await installer.start(verified);
  const cfg = configuration();
  assert.deepEqual(await installer.cancelPending(), { cancellationRequested: true });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(path.dirname(cfg.readyPath), 'cancel.json'), 'utf8')), { token: cfg.token });
  assert.equal(await installer.readResult(), null);
});

test('Windows launch acknowledgement cannot write outside the private UUID job directory', async t => {
  const { installer, verified, userData, temporary } = await fixture(t);
  const args = job => ['--brclio-update-job', job, '--brclio-update-token', 'a'.repeat(64)];
  await assert.rejects(installer.acknowledgeLaunch(args(temporary), verified.version), /不属于/);
  await assert.rejects(installer.acknowledgeLaunch(args(path.join(userData, 'updates', 'install-jobs', '..', 'outside')), verified.version), /不属于/);
  const jobs = path.join(userData, 'updates', 'install-jobs');
  await fs.mkdir(jobs, { recursive: true });
  const symlink = path.join(jobs, crypto.randomUUID());
  try { await fs.symlink(temporary, symlink, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.diagnostic('Host does not permit directory links; outside-root checks still passed.'); return; } throw error; }
  await assert.rejects(installer.acknowledgeLaunch(args(symlink), verified.version), /位置无效/);
});

test('Windows helper startup errors and preparation failures keep the parent running and allow retry', async t => {
  const failed = await fixture(t, { readyError: 'Disk space is insufficient.' });
  await assert.rejects(failed.installer.start(failed.verified), /Disk space/);
  assert.equal(failed.child().killed, true);
  assert.equal(failed.child().unreferenced, undefined);
  const spawnFailed = await fixture(t, { spawnError: 'PowerShell is blocked.' });
  await assert.rejects(spawnFailed.installer.start(spawnFailed.verified), /PowerShell is blocked/);
  assert.equal(spawnFailed.child().killed, true);
  const timedOut = await fixture(t, { readyTimeout: 70 });
  await assert.rejects(timedOut.installer.start(timedOut.verified), /超时/);
  assert.equal(timedOut.child().killed, true);
});

test('A real helper spawn failure is caught before asynchronous log-handle cleanup', async t => {
  const { verified, userData, executable } = await fixture(t);
  const installer = createWindowsInstaller({ platform: 'win32', verified, userData, executable,
    systemRoot: `C:\\Brclio-missing-${crypto.randomUUID()}`, readyTimeout: 2000 });
  await assert.rejects(installer.start(verified), error => error.code === 'ENOENT' &&
    typeof error.jobDirectory === 'string' && typeof error.helperOutput === 'string');
});

test('Windows result API distinguishes authenticated completion from failure and consumes only on request', async t => {
  const { installer } = await fixture(t);
  await fs.mkdir(path.dirname(installer.resultPath), { recursive: true });
  await fs.writeFile(installer.resultPath, '{ damaged');
  assert.equal(await installer.readResult(), null);
  const error = { status: 'error', version: '0.1.3', error: 'The installer was cancelled.', rollbackSucceeded: true };
  await fs.writeFile(installer.resultPath, JSON.stringify(error));
  assert.deepEqual(await installer.readResult(), error);
  assert.deepEqual(await installer.readResult({ consume: true }), error);
  assert.equal(await installer.readResult(), null);
  const installed = { status: 'installed', version: '0.1.3', launchAcknowledged: true };
  await fs.writeFile(installer.resultPath, JSON.stringify(installed));
  assert.deepEqual(await installer.readResult(), installed);
});

test('Windows helper keeps NSIS directory argument last and guards all menu cleanup during updates', async () => {
  const templates = path.join(__dirname, '..', 'node_modules', 'app-builder-lib', 'templates', 'nsis');
  const multiUser = await fs.readFile(path.join(templates, 'multiUser.nsh'), 'utf8');
  const install = await fs.readFile(path.join(templates, 'installSection.nsh'), 'utf8');
  const uninstallTemplate = await fs.readFile(path.join(templates, 'uninstaller.nsh'), 'utf8');
  const hook = await fs.readFile(path.join(__dirname, 'uninstall.nsh'), 'utf8');
  assert.match(multiUser, /must be the last parameter and cannot have quotes/);
  assert.match(install, /\$\{if\} \$\{isForceRun\}[\s\S]*?\$\{andIf\} \$\{Silent\}/);
  assert.match(HELPER, /\$start\.Arguments = '\/S --updated --keep-shortcuts ' \+ \$installMode \+ ' \/D=' \+ \$cfg\.installDirectory/);
  assert.match(HELPER, /\$start\.UseShellExecute = \$false/);
  const uninstall = hook.slice(hook.indexOf('!macro customUnInstall'));
  assert.ok(uninstall.indexOf('${IfNot} ${isUpdated}') < uninstall.indexOf('!insertmacro BrclioRemoveModernMenu'));
  assert.ok(uninstall.indexOf('${IfNot} ${isUpdated}') < uninstall.indexOf('DeleteRegKey'));
  assert.match(hook, /!macro customCheckAppRunning/);
  assert.match(hook, /SetEnvironmentVariable\(t "BRCLIO_NSIS_EXECUTABLE", t "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"\)/);
  const modernCleanup = hook.slice(hook.indexOf('!macro BrclioRemoveModernMenu'), hook.indexOf('; Only remove integration keys'));
  assert.match(modernCleanup, /StrCpy \$R4 "\$WINDIR\\Sysnative\\WindowsPowerShell\\v1\.0\\powershell\.exe"/);
  assert.match(modernCleanup, /IfFileExists "\$R4" \+2 0\s+StrCpy \$R4 "\$PowerShellPath"/);
  assert.match(modernCleanup, /nsExec::ExecToStack `"\$R4"/);
  assert.doesNotMatch(modernCleanup, /StrCpy \$PowerShellPath/);
  assert.match(modernCleanup, /\$\{If\} \$R0 != 0[\s\S]*?SetErrorLevel 2\s+Quit/);
  assert.ok(uninstallTemplate.indexOf('!insertmacro customUnInstall') < uninstallTemplate.indexOf('# delete the installed files'));
  for (const command of hook.split('\n').filter(line => line.includes('nsExec::ExecToStack'))) {
    assert.doesNotMatch(command, /\$INSTDIR/);
    if (command.includes('-Command')) assert.match(command, /\$\$env:BRCLIO_NSIS_EXECUTABLE/);
    else assert.match(command, /-File "\$PLUGINSDIR\\brclio-shell-uninstall\.ps1"/);
  }
  assert.ok(HELPER.indexOf('Save-Menus\n  Save-Installation') < HELPER.indexOf("$phase = 'installing'"));
  assert.ok(HELPER.indexOf('if (-not $acknowledged)') < HELPER.indexOf("status = 'installed'"));
  assert.match(HELPER, /\$deadline = \[DateTime\]::UtcNow\.AddSeconds\(600\)/);
});

test('NSIS cleanup shares strict sparse-package ownership checks and preserves unrelated certificate trust', async () => {
  const hook = await fs.readFile(path.join(__dirname, 'uninstall.nsh'), 'utf8');
  for (const line of hook.split(/\r?\n/).filter(value => value.startsWith('  FileWrite $R3 "'))) {
    const encoded = line.slice('  FileWrite $R3 "'.length, -1);
    assert.doesNotMatch(encoded.replaceAll('$$', '').replaceAll('$\\"', '').replaceAll('$\\r$\\n', ''), /\$/,
      'All PowerShell dollars must be escaped for the NSIS compiler.');
  }
  const script = await readUninstallScript();
  assert.equal(extractUninstallScript(hook.replace(/\r?\n/g, '\r\n')), script, 'Windows CRLF checkout produces the same PowerShell script.');
  assert.ok(script.includes(SHELL_PACKAGE_FUNCTIONS.trim()));
  assert.match(script, /GetDirectoryName\(\$env:BRCLIO_NSIS_EXECUTABLE\)/);
  assert.match(SHELL_PACKAGE_FUNCTIONS, /\$package\.Name -cne \$identity\.Name -or \$package\.Publisher -cne \$identity\.Publisher/);
  assert.match(SHELL_PACKAGE_FUNCTIONS, /EffectiveExternalLocation\.Path/);
  assert.match(SHELL_PACKAGE_FUNCTIONS, /EntryPoint = "GetLongPathNameW"/);
  assert.match(SHELL_PACKAGE_FUNCTIONS, /\$relative = Get-BrclioShellDllRelativePath \(\[string\]\$node\.Version\)/);
  assert.match(SHELL_PACKAGE_FUNCTIONS, /return 'resources\\windows-shell\\' \+ \$version \+ '\\BrclioExplorerCommand\.dll'/);
  assert.doesNotMatch(SHELL_PACKAGE_FUNCTIONS, /\$package\.InstallLocation/);
  const currentUserQuery = SHELL_PACKAGE_FUNCTIONS.slice(SHELL_PACKAGE_FUNCTIONS.indexOf('function Get-BrclioShellPackages('), SHELL_PACKAGE_FUNCTIONS.indexOf('function Remove-BrclioShellPackages('));
  assert.doesNotMatch(currentUserQuery, /-AllUsers|-User /);
  assert.match(SHELL_PACKAGE_FUNCTIONS, /Get-AppxPackage -AllUsers -Name \$identity\.Name/);
  assert.match(SHELL_PACKAGE_FUNCTIONS, /Get-AppxPackageManifest -Package \$package\.PackageFullName -User \$package\.UserSid/);
  assert.match(SHELL_PACKAGE_FUNCTIONS, /FindPackageForUser\(\$userSid, \$package\.PackageFullName\)/);
  assert.doesNotMatch(SHELL_PACKAGE_FUNCTIONS, /^\s*Remove-AppxPackage[^\n]*-AllUsers/m);
  assert.match(script, /if \(\$scope -ceq 'all'\)[\s\S]*?Get-BrclioShellPackagesAllUsers[\s\S]*?elseif \(\$scope -ceq 'CurrentUser'\)/);
  assert.match(hook, /SetEnvironmentVariable\(t "BRCLIO_NSIS_INSTALL_MODE", t "\$installMode"\)/);
  assert.match(SHELL_PACKAGE_FUNCTIONS, /BrclioOwner/);
  assert.match(SHELL_PACKAGE_FUNCTIONS, /CertificateSha256/);
  assert.match(SHELL_PACKAGE_FUNCTIONS, /ComputeHash\(\$certificate\.RawData\)/);
  assert.match(SHELL_PACKAGE_FUNCTIONS, /X509Store\('TrustedPeople', 'CurrentUser'\)/);
  assert.match(SHELL_PACKAGE_FUNCTIONS, /RegistryHive\]::LocalMachine, \[Microsoft\.Win32\.RegistryView\]::Registry64/);
  assert.match(SHELL_PACKAGE_FUNCTIONS, /\$metadata\.trustHelperSha256/);
  assert.match(SHELL_PACKAGE_FUNCTIONS, /\$start\.Arguments = '--cleanup'/);
  assert.match(SHELL_PACKAGE_FUNCTIONS, /\$start\.Verb = 'runas'/);
  assert.doesNotMatch(SHELL_PACKAGE_FUNCTIONS, /Import-Certificate|TrustedRoot|Set-ExecutionPolicy/);
  assert.ok(script.includes(POWERSHELL_SIGNATURE_FUNCTIONS.trim()));
  assert.ok(script.indexOf('Remove-BrclioShellPackages $directory $identity $packages') < script.indexOf('  Remove-BrclioShellCertificateTrust\n'));
  assert.ok(script.indexOf('  Remove-BrclioShellMachineCertificateTrust $directory $identity\n') < script.indexOf('  Remove-BrclioShellCertificateTrust\n'));
});

test('Windows updater snapshots trusted opt-in shell registration before ready and restores it during rollback', () => {
  assert.ok(HELPER.includes(POWERSHELL_SIGNATURE_FUNCTIONS));
  assert.ok(HELPER.indexOf('  Save-ShellIntegration\n') < HELPER.indexOf('  Write-Report $cfg.readyPath'));
  assert.match(HELPER, /enabled = \(\$packages\.Count -gt 0\)/);
  assert.match(HELPER, /if \(\$script:installMode -ceq '\/allusers'\) \{ \$packages = @\(Get-BrclioShellPackagesAllUsers/);
  assert.match(HELPER, /restoreEnabled = \(\$currentPackages\.Count -gt 0\)/);
  assert.match(HELPER, /if \(-not \$script:shellSnapshot.enabled\) \{ return \}/);
  assert.equal((HELPER.match(/Test-BrclioShellSignature \$payload \$identity\.Publisher \(Join-Path \$cfg\.installDirectory 'resources\\windows-shell'\)/g) || []).length, 2);
  assert.equal((HELPER.match(/if \(-not \$signature\.trusted -or \$signature\.needsTrust\)/g) || []).length, 2);
  assert.match(HELPER, /if \(-not \$dllSignature\.trusted -or \$dllSignature\.needsTrust\)/);
  assert.ok(HELPER.indexOf('  Preserve-PreviousShellDll\n') < HELPER.indexOf('  $newProcess = Start-Process'));
  const restore = HELPER.slice(HELPER.indexOf('function Restore-ShellIntegration'), HELPER.indexOf('function Save-Installation'));
  assert.ok(restore.indexOf('Remove-BrclioShellPackages') < restore.indexOf('Add-AppxPackage'));
  assert.ok(restore.indexOf('$signature.trusted') < restore.indexOf('Add-AppxPackage'));
  assert.match(restore, /-ExternalLocation \$cfg.installDirectory -ForceUpdateFromAnyVersion/);
  assert.ok(HELPER.indexOf('try { Restore-Installation }') < HELPER.indexOf('try { Restore-ShellIntegration }'));
  assert.doesNotMatch(HELPER, /\n  Remove-BrclioShellCertificateTrust\n/);
});

test('Windows PowerShell parser accepts the complete helper without executing installation', { skip: process.platform !== 'win32' }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-powershell-parse-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const helper = path.join(temporary, 'helper.ps1');
  const launcher = path.join(temporary, 'launcher.ps1');
  const registry = path.join(temporary, 'registry.ps1');
  const uninstall = path.join(temporary, 'uninstall.ps1');
  const parser = path.join(temporary, 'parse.ps1');
  await fs.writeFile(helper, '\uFEFF' + HELPER);
  await fs.writeFile(launcher, '\uFEFF' + LAUNCHER);
  await fs.writeFile(registry, '\uFEFF' + QUERY_SCRIPT);
  await fs.writeFile(uninstall, '\uFEFF' + await readUninstallScript());
  await fs.writeFile(parser, 'param([string]$Source)\n$tokens=$null; $errors=$null\n[System.Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors) | Out-Null\nif ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }\n');
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-File', parser, helper], { timeout: 30000 });
  await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-File', parser, launcher], { timeout: 30000 });
  await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-File', parser, registry], { timeout: 30000 });
  await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-File', parser, uninstall], { timeout: 30000 });
});

test('Windows sparse-package cleanup rejects other publishers, COM classes, installations and changed ownership', { skip: process.platform !== 'win32' }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "Brclio package ownership 中文 & user's "));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const filename = path.join(temporary, 'ownership.ps1');
  await fs.writeFile(filename, '\uFEFF' + `param([string]$Directory)\n$ErrorActionPreference = 'Stop'\n${SHELL_PACKAGE_FUNCTIONS}\n` + String.raw`
$identity = @{ Name = 'Brclio.Toolbox.Shell'; Publisher = 'CN=Brclio' }
$script:package = [pscustomobject]@{ Name = $identity.Name; Publisher = $identity.Publisher; PackageFullName = 'Brclio.Toolbox.Shell_1.0.0.0_x64__fixture' }
$script:external = $Directory
$script:classPath = 'resources\windows-shell\1.0.0.0\BrclioExplorerCommand.dll'
$script:classId = 'CFD1E4D4-3973-45D3-8542-45A77E6C58C9'
$script:removed = @()
function Get-BrclioShellExternalLocation($package) { return $script:external }
function Get-AppxPackage { param([string]$Name) return $script:package }
function Get-AppxPackageManifest {
  param([string]$Package)
  return [xml]('<Package><Identity Name="Brclio.Toolbox.Shell" Publisher="CN=Brclio" Version="1.0.0.0"/><Applications><Application Id="Brclio"><Class Id="' + $script:classId + '" Path="' + [Security.SecurityElement]::Escape($script:classPath) + '"/></Application></Applications></Package>')
}
function Remove-AppxPackage { param([string]$Package) $script:removed += $Package }
if (-not (Test-BrclioShellPackage $script:package $Directory $identity)) { throw 'The matching sparse package was rejected.' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class BrclioLifecycleShortPathTest {
  [DllImport("kernel32.dll", EntryPoint="GetShortPathNameW", CharSet=CharSet.Unicode, ExactSpelling=true)]
  public static extern UInt32 GetShortPathName(string path, StringBuilder result, UInt32 capacity);
}
'@
$shortBuffer = New-Object Text.StringBuilder(32768)
$shortLength = [BrclioLifecycleShortPathTest]::GetShortPathName($Directory, $shortBuffer, [uint32]$shortBuffer.Capacity)
if ($shortLength -gt 0 -and $shortLength -lt $shortBuffer.Capacity) {
  $script:external = Resolve-BrclioShellPath $Directory
  if (-not (Test-BrclioShellPackage $script:package ($shortBuffer.ToString()) $identity)) { throw 'An 8.3 alias of the registered installation was rejected.' }
} else { Write-Output '8.3 aliases are disabled on this test volume; ordinary ownership checks remain active.' }
$script:external = $Directory
$script:package.Publisher = 'CN=Other App'
if (Test-BrclioShellPackage $script:package $Directory $identity) { throw 'Another publisher was accepted.' }
$script:package.Publisher = $identity.Publisher
$script:external = $Directory + '-other'
if (Test-BrclioShellPackage $script:package $Directory $identity) { throw 'Another installation was accepted.' }
$saved = @(Get-BrclioShellPackages $Directory $identity)
if ($saved.Count -ne 0) { throw 'Another installation was selected for removal.' }
$script:external = $Directory
$saved = @(Get-BrclioShellPackages $Directory $identity)
$script:external = $Directory + '-moved'
Remove-BrclioShellPackages $Directory $identity $saved
if ($script:removed.Count -ne 0) { throw 'A package moved after discovery was removed.' }
$script:external = $Directory
$script:classId = '00000000-0000-0000-0000-000000000000'
if (Test-BrclioShellPackage $script:package $Directory $identity) { throw 'Another COM class was accepted.' }
$script:classId = 'CFD1E4D4-3973-45D3-8542-45A77E6C58C9'
$script:classPath = '..\Other App\BrclioExplorerCommand.dll'
if (Test-BrclioShellPackage $script:package $Directory $identity) { throw 'An unexpected COM path was accepted.' }
$script:classPath = 'resources\windows-shell\2.0.0.0\BrclioExplorerCommand.dll'
if (Test-BrclioShellPackage $script:package $Directory $identity) { throw 'Another package version DLL path was accepted.' }
$script:classPath = Join-Path $Directory 'resources\windows-shell\1.0.0.0\BrclioExplorerCommand.dll'
if (-not (Test-BrclioShellPackage $script:package $Directory $identity)) { throw 'The matching absolute COM path was rejected.' }
Remove-BrclioShellPackages $Directory $identity $saved
if ($script:removed.Count -ne 1) { throw 'The owned sparse package was not removed exactly once.' }
`);
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-File', filename, temporary], { timeout: 30000 });
});

test('Windows shell update backup and rollback require the shared verifier to confirm trusted integrity', { skip: process.platform !== 'win32' }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-shell-update-trust-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const filename = path.join(temporary, 'shell-update.ps1');
  const lifecycle = HELPER.slice(HELPER.indexOf('function Save-ShellIntegration'), HELPER.indexOf('function Save-Installation'));
  await fs.writeFile(filename, '\uFEFF' + `param([string]$Directory)\n$ErrorActionPreference = 'Stop'\n${lifecycle}\n` + String.raw`
$cfg = @{ installDirectory = $Directory; backupDirectory = (Join-Path $Directory 'previous-app') }
$backupReady = $true
$installerStarted = $true
$rollbackShellIdentity = $null
$rollbackShellError = $null
$script:trusted = $false
$script:needsTrust = $true
$script:registered = 0
$script:registeredVersion = '1.0.0.0'
$script:currentUserEnabled = $true
$script:checks = @()
function Read-BrclioShellIdentity { param([string]$directory) return @{ Name='Brclio.Toolbox.Shell'; Publisher='CN=Brclio'; Version='1.0.0.0' } }
function Get-BrclioShellDllRelativePath { param([string]$version) return ('resources\windows-shell\' + $version + '\BrclioExplorerCommand.dll') }
function Get-BrclioShellFileHash { param([string]$Path) return ('A' * 64) }
function Get-BrclioShellPackages { param([string]$directory, $identity) if ($script:currentUserEnabled) { return [pscustomobject]@{ PackageFullName='owned-package'; Version=$script:registeredVersion } } }
function Get-BrclioShellPackagesAllUsers { param([string]$directory, $identity) return [pscustomobject]@{ PackageFullName='other-user-package'; Version=$script:registeredVersion; UserSid='S-1-5-21-2002' } }
function Remove-BrclioShellPackages { param([string]$directory, $identity, $packages) }
function Test-BrclioShellSignature {
  param([string]$Path, [string]$Publisher, [string]$Directory)
  $script:checks += @{ Path=$Path; Publisher=$Publisher; Directory=$Directory }
  return @{ trusted=$script:trusted; needsTrust=$script:needsTrust }
}
function Add-AppxPackage {
  param([string]$Path, [string]$ExternalLocation, [switch]$ForceUpdateFromAnyVersion)
  if ($ExternalLocation -cne $cfg.installDirectory) { throw 'Rollback external location differs.' }
  $script:registered += 1
}
$rejected = $false
try { Save-ShellIntegration } catch { $rejected = $true }
if (-not $rejected) { throw 'An untrusted shell snapshot was accepted.' }
$script:trusted = $true
$rejected = $false
try { Save-ShellIntegration } catch { $rejected = $true }
if (-not $rejected) { throw 'A CurrentUser-only peer was accepted for Appx rollback deployment.' }
$script:needsTrust = $false
$script:registeredVersion = '0.9.0.0'
$rejected = $false
try { Save-ShellIntegration } catch { $rejected = $true }
if (-not $rejected) { throw 'A registered shell version with no matching rollback assets was accepted.' }
$script:registeredVersion = '1.0.0.0'
Save-ShellIntegration
if (-not $script:shellSnapshot.enabled) { throw 'An enabled shell snapshot was lost.' }
$script:trusted = $false
$rejected = $false
try { Restore-ShellIntegration } catch { $rejected = $true }
if (-not $rejected -or $script:registered -ne 0) { throw 'An untrusted rollback package was registered.' }
$script:trusted = $true
Restore-ShellIntegration
if ($script:registered -ne 1) { throw 'A trusted rollback package was not registered.' }
$installMode = '/allusers'
$script:currentUserEnabled = $false
Save-ShellIntegration
if (-not $script:shellSnapshot.enabled -or $script:shellSnapshot.restoreEnabled) { throw 'Another account menu was not retained independently from the admin preference.' }
Restore-ShellIntegration
if ($script:registered -ne 1) { throw 'Shared-install rollback enabled a menu for an administrator who never opted in.' }
foreach ($check in $script:checks) {
  if ($check.Path -cnotin @((Join-Path $cfg.installDirectory 'resources\windows-shell\BrclioShell.msix'), (Join-Path $cfg.installDirectory 'resources\windows-shell\1.0.0.0\BrclioExplorerCommand.dll')) -or $check.Publisher -cne 'CN=Brclio' -or $check.Directory -cne (Join-Path $cfg.installDirectory 'resources\windows-shell')) {
    throw 'The shared verifier did not receive the saved package identity and installation assets.'
  }
}
`);
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-File', filename, temporary], { timeout: 30000 });
});

test('all-user uninstall validates each account and preserves another root sharing the same package full name', { skip: process.platform !== 'win32' }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-all-user-cleanup-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const filename = path.join(temporary, 'all-users.ps1');
  await fs.writeFile(filename, '\uFEFF' + `param([string]$Directory)\n$ErrorActionPreference = 'Stop'\n${SHELL_PACKAGE_FUNCTIONS}\n` + String.raw`
$identity = @{ Name='Brclio.Toolbox.Shell'; Publisher='CN=Brclio' }
$script:alice = 'S-1-5-21-1001'
$script:bob = 'S-1-5-21-1002'
$script:users = @(
  [pscustomobject]@{ UserSecurityId=$script:alice; InstallState='Installed' },
  [pscustomobject]@{ UserSecurityId=$script:bob; InstallState='Installed' },
  [pscustomobject]@{ UserSecurityId='S-1-5-18'; InstallState='Staged' }
)
$script:roots = @{ $script:alice=$Directory; $script:bob=($Directory + '-other') }
$script:failedUser = $null
$script:manifestUsers = @()
$script:removed = @()
function Get-AppxPackage {
  param([switch]$AllUsers, [string]$Name)
  if (-not $AllUsers) { throw 'All-user uninstall did not enumerate all accounts.' }
  return @(
    [pscustomobject]@{ Name='Brclio.Toolbox.Shell'; Publisher='CN=Brclio'; PackageFullName='same-package-full-name'; Version='1.0.0.0'; PackageUserInformation=$script:users },
    [pscustomobject]@{ Name='Brclio.Toolbox.Shell'; Publisher='CN=Another App'; PackageFullName='foreign-package-full-name' }
  )
}
function Get-AppxPackageManifest {
  param([string]$Package, [string]$User)
  if (-not $User) { throw 'Other-user manifest was queried without a user SID.' }
  if ($User -ceq $script:failedUser) { throw 'Other-user manifest is unreadable.' }
  $script:manifestUsers += $User
  return [xml]'<Package><Identity Name="Brclio.Toolbox.Shell" Publisher="CN=Brclio" Version="1.0.0.0"/><Applications><Application Id="Brclio"><Class Id="CFD1E4D4-3973-45D3-8542-45A77E6C58C9" Path="resources\windows-shell\1.0.0.0\BrclioExplorerCommand.dll"/></Application></Applications></Package>'
}
function Get-BrclioShellExternalLocation($package) { return $script:roots[$package.UserSid] }
function Remove-AppxPackage {
  param([string]$Package, [string]$User, [switch]$AllUsers)
  if ($AllUsers -or $User -cne $script:alice -or $Package -cne 'same-package-full-name') { throw 'Removal reached a different installation or all users indiscriminately.' }
  $script:removed += $User
  $script:users = @($script:users | Where-Object { [string]$_.UserSecurityId -cne $User })
}
$selected = @(Get-BrclioShellPackagesAllUsers $Directory $identity)
if ($selected.Count -ne 1 -or $selected[0].UserSid -cne $script:alice) { throw 'The matching account was not isolated from another installation.' }
if ($script:manifestUsers -cnotcontains $script:alice -or $script:manifestUsers -cnotcontains $script:bob) { throw 'Both installed user registrations were not inspected.' }
$script:failedUser = $script:bob
$rejected = $false
try { $null = @(Get-BrclioShellPackagesAllUsers $Directory $identity) } catch { $rejected = $true }
if (-not $rejected -or $script:removed.Count -ne 0) { throw 'An unreadable account state was ignored or removal began before validation.' }
$script:failedUser = $null
$script:users[1].InstallState = 'Unknown'
$rejected = $false
try { $null = @(Get-BrclioShellPackagesAllUsers $Directory $identity) } catch { $rejected = $true }
if (-not $rejected -or $script:removed.Count -ne 0) { throw 'An unknown account state was ignored.' }
$script:users[1].InstallState = 'Installed'
$script:roots[$script:alice] = $Directory + '-moved'
Remove-BrclioShellPackagesAllUsers $Directory $identity $selected
if ($script:removed.Count -ne 0) { throw 'An account that moved after discovery was removed.' }
$script:roots[$script:alice] = $Directory
Remove-BrclioShellPackagesAllUsers $Directory $identity $selected
if ($script:removed.Count -ne 1 -or @(Get-BrclioShellPackagesAllUsers $Directory $identity).Count -ne 0) { throw 'The matching account registration was not cleaned up.' }
if (@($script:users | Where-Object { $_.UserSecurityId -ceq $script:bob -and $_.InstallState -ceq 'Installed' }).Count -ne 1) { throw 'The separate installation was not preserved.' }
`);
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-File', filename, temporary], { timeout: 30000 });
});

test('Windows update preserves only the verified previous version DLL and rejects a conflicting file', { skip: process.platform !== 'win32' }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-previous-shell-dll-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const install = path.join(temporary, 'install');
  const backup = path.join(temporary, 'backup');
  const oldRelative = path.join('resources', 'windows-shell', '1.0.0.0', 'BrclioExplorerCommand.dll');
  const currentRelative = path.join('resources', 'windows-shell', '2.0.0.0', 'BrclioExplorerCommand.dll');
  await fs.mkdir(path.dirname(path.join(backup, oldRelative)), { recursive: true });
  await fs.mkdir(path.dirname(path.join(install, currentRelative)), { recursive: true });
  await fs.writeFile(path.join(backup, oldRelative), 'verified previous DLL');
  await fs.writeFile(path.join(install, currentRelative), 'new DLL');
  await fs.writeFile(path.join(install, 'resources', 'windows-shell', 'AppxManifest.xml'), 'new manifest');
  const filename = path.join(temporary, 'preserve.ps1');
  const preserve = HELPER.slice(HELPER.indexOf('function Preserve-PreviousShellDll'), HELPER.indexOf('function Restore-ShellIntegration'));
  const hash = POWERSHELL_SIGNATURE_FUNCTIONS.slice(POWERSHELL_SIGNATURE_FUNCTIONS.indexOf('function Get-BrclioShellFileHash'), POWERSHELL_SIGNATURE_FUNCTIONS.indexOf('function Test-BrclioShellSignature'));
  await fs.writeFile(filename, '\uFEFF' + `param([string]$Directory,[string]$Backup)\n$ErrorActionPreference = 'Stop'\n${hash}\n${preserve}\n` + String.raw`
$cfg = @{ installDirectory=$Directory; backupDirectory=$Backup }
$relative = 'resources\windows-shell\1.0.0.0\BrclioExplorerCommand.dll'
$source = Join-Path $Backup $relative
$destination = Join-Path $Directory $relative
$script:currentVersion = '2.0.0.0'
$shellSnapshot = @{ enabled=$true; restoreEnabled=$false; version='1.0.0.0'; dllHash=(Get-BrclioShellFileHash $source) }
function Read-BrclioShellIdentity { param([string]$directory) return @{ Version=$script:currentVersion } }
function Get-BrclioShellDllRelativePath { param([string]$version) return ('resources\windows-shell\' + $version + '\BrclioExplorerCommand.dll') }
Preserve-PreviousShellDll
if ([IO.File]::ReadAllText($destination) -cne 'verified previous DLL') { throw 'The previous DLL was not preserved.' }
if ([IO.File]::ReadAllText((Join-Path $Directory 'resources\windows-shell\AppxManifest.xml')) -cne 'new manifest') { throw 'New metadata was overwritten.' }
if ([IO.File]::ReadAllText((Join-Path $Directory 'resources\windows-shell\2.0.0.0\BrclioExplorerCommand.dll')) -cne 'new DLL') { throw 'The new DLL was overwritten.' }
Preserve-PreviousShellDll
[IO.File]::WriteAllText($destination, 'conflicting file')
$rejected = $false
try { Preserve-PreviousShellDll } catch { $rejected = $true }
if (-not $rejected -or [IO.File]::ReadAllText($destination) -cne 'conflicting file') { throw 'A conflicting existing DLL was overwritten.' }
$script:currentVersion = '1.0.0.0'
Preserve-PreviousShellDll
if ([IO.File]::ReadAllText($destination) -cne 'conflicting file') { throw 'A same-version installation DLL was overwritten.' }
[IO.File]::Delete($destination)
$shellSnapshot.enabled = $false
Preserve-PreviousShellDll
if ([IO.File]::Exists($destination)) { throw 'A disabled shell integration restored files.' }
`);
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-File', filename, install, backup], { timeout: 30000 });
});

test('The real hidden PowerShell helper survives its Node parent exiting', { skip: process.platform !== 'win32' }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "Brclio launcher 中文 & user's "));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const launcher = path.join(temporary, 'launch.ps1');
  const marker = path.join(temporary, 'survived.txt');
  const parent = path.join(temporary, 'parent.cjs');
  await fs.writeFile(launcher, '\uFEFF' + LAUNCHER);
  await fs.writeFile(path.join(temporary, 'install.ps1'), '\uFEFF' + 'param([string]$Configuration)\nStart-Sleep -Milliseconds 1000\n[IO.File]::WriteAllText($Configuration, "survived")\n');
  await fs.writeFile(parent, 'const {spawn}=require("node:child_process"); const [ps,launcher,marker]=process.argv.slice(2); const child=spawn(ps,["-NoLogo","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",launcher,"-Configuration",marker],{windowsHide:true,stdio:"ignore"}); child.once("error",()=>process.exit(1)); child.once("exit",code=>process.exit(code));\n');
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await promisify(execFile)(process.execPath, [parent, powershell, launcher, marker], { timeout: 15000 });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !await fs.readFile(marker, 'utf8').catch(() => '')) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await fs.readFile(marker, 'utf8'), 'survived');
});

test('Real Windows native command checks accept success stderr and preserve failure exit codes', { skip: process.platform !== 'win32' }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-native-exit-codes-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const filename = path.join(temporary, 'verify.ps1');
  const implementation = HELPER.slice(HELPER.indexOf('function Invoke-Native'), HELPER.indexOf('function Save-Menus'));
  await fs.writeFile(filename, '\uFEFF' + `param([string]$Command)\n$ErrorActionPreference = 'Stop'\n${implementation}\n` +
    "$success = Invoke-Native $Command @('/d', '/c', 'echo native successful 1>&2 & exit /b 0')\nif ($success -ne 0) { throw 'Native success stderr was incorrectly rejected.' }\n" +
    "$failure = Invoke-Native $Command @('/d', '/c', 'echo native failed 1>&2 & exit /b 7')\nif ($failure -ne 7) { throw 'Native failure exit code was lost.' }\n" +
    "$caught = $false\ntry { Invoke-Native ($Command + '.missing') @() | Out-Null } catch { $caught = $true }\nif (-not $caught) { throw 'A missing native executable was incorrectly accepted.' }\nif ($ErrorActionPreference -ne 'Stop') { throw 'Native call changed the outer error policy.' }\n");
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-File', filename, path.join(process.env.SystemRoot, 'System32', 'cmd.exe')], { timeout: 15000 });
});

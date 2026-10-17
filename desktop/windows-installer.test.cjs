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

async function readUninstallScript() {
  const source = await fs.readFile(path.join(__dirname, 'uninstall.nsh'), 'utf8');
  return source.split('\n').filter(line => line.startsWith('  FileWrite $R3 "'))
    .map(line => line.slice('  FileWrite $R3 "'.length, -1).replace(/\$\\r\$\\n$/, '').replaceAll('$\\"', '"').replaceAll('$$', '$')).join('\n') + '\n';
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
        if (!readyTimeout) await fs.writeFile(configuration.readyPath, JSON.stringify(readyError ? { status: 'error', error: readyError } : { status: 'ready' }));
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
  for (const line of hook.split('\n').filter(value => value.startsWith('  FileWrite $R3 "'))) {
    const encoded = line.slice('  FileWrite $R3 "'.length, -1);
    assert.doesNotMatch(encoded.replaceAll('$$', '').replaceAll('$\\"', '').replaceAll('$\\r$\\n', ''), /\$/,
      'All PowerShell dollars must be escaped for the NSIS compiler.');
  }
  const script = await readUninstallScript();
  assert.ok(script.includes(SHELL_PACKAGE_FUNCTIONS.trim()));
  assert.match(script, /GetDirectoryName\(\$env:BRCLIO_NSIS_EXECUTABLE\)/);
  assert.match(SHELL_PACKAGE_FUNCTIONS, /\$package\.Name -cne \$identity\.Name -or \$package\.Publisher -cne \$identity\.Publisher/);
  assert.match(SHELL_PACKAGE_FUNCTIONS, /EffectiveExternalLocation\.Path/);
  assert.match(SHELL_PACKAGE_FUNCTIONS, /\$relative = Get-BrclioShellDllRelativePath \(\[string\]\$node\.Version\)/);
  assert.match(SHELL_PACKAGE_FUNCTIONS, /return 'resources\\windows-shell\\' \+ \$version \+ '\\BrclioExplorerCommand\.dll'/);
  assert.doesNotMatch(SHELL_PACKAGE_FUNCTIONS, /\$package\.InstallLocation|Get-AppxPackage[^\n]*-AllUsers/);
  assert.match(SHELL_PACKAGE_FUNCTIONS, /BrclioOwner/);
  assert.match(SHELL_PACKAGE_FUNCTIONS, /CertificateSha256/);
  assert.match(SHELL_PACKAGE_FUNCTIONS, /ComputeHash\(\$certificate\.RawData\)/);
  assert.match(SHELL_PACKAGE_FUNCTIONS, /X509Store\('TrustedPeople', 'CurrentUser'\)/);
  assert.doesNotMatch(SHELL_PACKAGE_FUNCTIONS, /LocalMachine|Import-Certificate|TrustedRoot|Set-ExecutionPolicy/);
  assert.ok(script.indexOf('Remove-BrclioShellPackages $directory $identity $packages') < script.indexOf('  Remove-BrclioShellCertificateTrust\n'));
});

test('Windows updater snapshots trusted opt-in shell registration before ready and restores it during rollback', () => {
  assert.ok(HELPER.includes(POWERSHELL_SIGNATURE_FUNCTIONS));
  assert.ok(HELPER.indexOf('  Save-ShellIntegration\n') < HELPER.indexOf('  Write-Report $cfg.readyPath'));
  assert.match(HELPER, /enabled = \(\$packages\.Count -gt 0\)/);
  assert.match(HELPER, /if \(-not \$script:shellSnapshot.enabled\) \{ return \}/);
  assert.equal((HELPER.match(/Test-BrclioShellSignature \$payload \$identity\.Publisher \(Join-Path \$cfg\.installDirectory 'resources\\windows-shell'\)/g) || []).length, 2);
  assert.equal((HELPER.match(/if \(-not \$signature\.trusted\)/g) || []).length, 2);
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
$cfg = @{ installDirectory = $Directory }
$backupReady = $true
$installerStarted = $true
$rollbackShellIdentity = $null
$rollbackShellError = $null
$script:trusted = $false
$script:registered = 0
$script:checks = @()
function Read-BrclioShellIdentity { param([string]$directory) return @{ Name='Brclio.Toolbox.Shell'; Publisher='CN=Brclio' } }
function Get-BrclioShellPackages { param([string]$directory, $identity) return [pscustomobject]@{ PackageFullName='owned-package' } }
function Remove-BrclioShellPackages { param([string]$directory, $identity, $packages) }
function Test-BrclioShellSignature {
  param([string]$Path, [string]$Publisher, [string]$Directory)
  $script:checks += @{ Path=$Path; Publisher=$Publisher; Directory=$Directory }
  return @{ trusted=$script:trusted; needsTrust=(-not $script:trusted) }
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
Save-ShellIntegration
if (-not $script:shellSnapshot.enabled) { throw 'An enabled shell snapshot was lost.' }
$script:trusted = $false
$rejected = $false
try { Restore-ShellIntegration } catch { $rejected = $true }
if (-not $rejected -or $script:registered -ne 0) { throw 'An untrusted rollback package was registered.' }
$script:trusted = $true
Restore-ShellIntegration
if ($script:registered -ne 1) { throw 'A trusted rollback package was not registered.' }
foreach ($check in $script:checks) {
  if ($check.Path -cne (Join-Path $cfg.installDirectory 'resources\windows-shell\BrclioShell.msix') -or $check.Publisher -cne 'CN=Brclio' -or $check.Directory -cne (Join-Path $cfg.installDirectory 'resources\windows-shell')) {
    throw 'The shared verifier did not receive the saved package identity and installation assets.'
  }
}
`);
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-File', filename, temporary], { timeout: 30000 });
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

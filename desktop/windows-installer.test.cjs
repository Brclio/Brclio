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
const { createWindowsInstaller, HELPER } = require('./windows-installer.cjs');
const { QUERY_SCRIPT } = require('./windows-registry.cjs');

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
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio[0], 'ignore');
  assert.equal(typeof calls[0].options.stdio[1], 'number');
  assert.equal(calls[0].options.stdio[1], calls[0].options.stdio[2]);
  assert.equal(calls[0].options.shell, undefined);
  assert.deepEqual(calls[0].args.slice(0, 7), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(path.dirname(cfg.readyPath), 'install.ps1')]);
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

test('Windows helper keeps NSIS directory argument last and guards legacy menu cleanup during updates', async () => {
  const templates = path.join(__dirname, '..', 'node_modules', 'app-builder-lib', 'templates', 'nsis');
  const multiUser = await fs.readFile(path.join(templates, 'multiUser.nsh'), 'utf8');
  const install = await fs.readFile(path.join(templates, 'installSection.nsh'), 'utf8');
  const hook = await fs.readFile(path.join(__dirname, 'uninstall.nsh'), 'utf8');
  assert.match(multiUser, /must be the last parameter and cannot have quotes/);
  assert.match(install, /\$\{if\} \$\{isForceRun\}[\s\S]*?\$\{andIf\} \$\{Silent\}/);
  assert.match(HELPER, /\$start\.Arguments = '\/S --updated --keep-shortcuts ' \+ \$installMode \+ ' \/D=' \+ \$cfg\.installDirectory/);
  assert.match(HELPER, /\$start\.UseShellExecute = \$false/);
  assert.ok(hook.indexOf('${IfNot} ${isUpdated}') < hook.indexOf('DeleteRegKey'));
  assert.match(hook, /!macro customCheckAppRunning/);
  assert.match(hook, /SetEnvironmentVariable\(t "BRCLIO_NSIS_EXECUTABLE", t "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"\)/);
  for (const command of hook.split('\n').filter(line => line.includes('nsExec::ExecToStack'))) {
    assert.doesNotMatch(command, /\$INSTDIR/);
    assert.match(command, /\$\$env:BRCLIO_NSIS_EXECUTABLE/);
  }
  assert.ok(HELPER.indexOf('Save-Menus\n  Save-Installation') < HELPER.indexOf("$phase = 'installing'"));
  assert.ok(HELPER.indexOf('if (-not $acknowledged)') < HELPER.indexOf("status = 'installed'"));
});

test('Windows PowerShell parser accepts the complete helper without executing installation', { skip: process.platform !== 'win32' }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-powershell-parse-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const helper = path.join(temporary, 'helper.ps1');
  const registry = path.join(temporary, 'registry.ps1');
  const parser = path.join(temporary, 'parse.ps1');
  await fs.writeFile(helper, '\uFEFF' + HELPER);
  await fs.writeFile(registry, '\uFEFF' + QUERY_SCRIPT);
  await fs.writeFile(parser, 'param([string]$Source)\n$tokens=$null; $errors=$null\n[System.Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors) | Out-Null\nif ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }\n');
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-File', parser, helper], { timeout: 30000 });
  await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-File', parser, registry], { timeout: 30000 });
});

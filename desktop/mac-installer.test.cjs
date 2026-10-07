'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createMacInstaller } = require('./mac-installer.cjs');
const { APP_ID, EXTENSION_ID, atomicJSON, guiEnvironment, runHelper, verifyBundle } = require('./mac-installer-helper.cjs');

async function writeBundle(application, version) {
  const extension = path.join(application, 'Contents', 'PlugIns', 'BrclioFinderSync.appex');
  await fs.mkdir(path.join(application, 'Contents', 'MacOS'), { recursive: true });
  await fs.mkdir(path.join(extension, 'Contents', 'MacOS'), { recursive: true });
  await fs.writeFile(path.join(application, 'Contents', 'Info.plist'), JSON.stringify({ CFBundleIdentifier: APP_ID,
    CFBundlePackageType: 'APPL', CFBundleExecutable: 'Brclio', CFBundleShortVersionString: version, CFBundleVersion: version }));
  await fs.writeFile(path.join(application, 'Contents', 'MacOS', 'Brclio'), `application ${version}`, { mode: 0o755 });
  await fs.writeFile(path.join(extension, 'Contents', 'Info.plist'), JSON.stringify({ CFBundleIdentifier: EXTENSION_ID,
    CFBundlePackageType: 'XPC!', CFBundleExecutable: 'BrclioFinderSync', CFBundleShortVersionString: version, CFBundleVersion: version,
    NSExtension: { NSExtensionPointIdentifier: 'com.apple.FinderSync', NSExtensionPrincipalClass: 'BrclioFinderSync.FinderSync' } }));
  await fs.writeFile(path.join(extension, 'Contents', 'MacOS', 'BrclioFinderSync'), `extension ${version}`, { mode: 0o755 });
}

async function fixture(t, settings = {}) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-mac-install-test-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const application = path.join(temporary, "应用 空格 & ' Brclio.app");
  await writeBundle(application, settings.currentVersion || '0.1.2');
  const executable = path.join(application, 'Contents', 'MacOS', 'Brclio');
  const userData = path.join(temporary, '用户 data');
  const filename = path.join(temporary, 'Brclio-0.1.3-mac-arm64.dmg');
  const payload = Buffer.from('Official verified DMG fixture; native tools are injected.');
  await fs.writeFile(filename, payload, { mode: 0o600 });
  const verified = { filename, size: payload.length, version: '0.1.3', expected: crypto.createHash('sha256').update(payload).digest('hex') };
  const calls = []; let configuration; let child; let mountpoint;
  const run = async (program, args, options) => {
    calls.push({ program, args, options });
    if (settings.run) { const response = await settings.run(program, args, options); if (response !== undefined) return response; }
    if (program === '/usr/bin/hdiutil' && args[0] === 'attach') {
      mountpoint = args[args.indexOf('-mountpoint') + 1];
      await writeBundle(path.join(mountpoint, 'Brclio.app'), settings.candidateVersion || verified.version);
      return { stdout: JSON.stringify({ 'system-entities': [{ 'mount-point': mountpoint }] }) };
    }
    if (program === '/usr/bin/hdiutil') return { stdout: '' };
    if (program === '/usr/bin/plutil') {
      const contents = await fs.readFile(args.at(-1), 'utf8');
      if (path.basename(args.at(-1)).startsWith('entitlements-')) return { stdout: JSON.stringify(settings.entitlements || { 'com.apple.security.app-sandbox': true, 'com.apple.security.files.user-selected.read-only': true }) };
      return { stdout: contents };
    }
    if (program === '/usr/bin/lipo') return { stdout: settings.architectureOutput || 'arm64\n' };
    if (program === '/usr/bin/codesign') {
      if (settings.signatureFailure && args[0] === '--verify') throw new Error('code or signature modified');
      if (args.includes('--verbose=4')) return { stderr: `Identifier=${args.at(-1).endsWith('.appex') ? EXTENSION_ID : APP_ID}\nSignature=adhoc\nTeamIdentifier=not set\nInfo.plist entries=12\nSealed Resources version=2 rules=13 files=1\n` };
      return { stdout: args[0] === '-d' ? '<plist>fixture entitlements</plist>' : '' };
    }
    if (program === '/usr/bin/ditto') { await fs.cp(args.at(-2), args.at(-1), { recursive: true, dereference: false }); return { stdout: '' }; }
    if (program === '/usr/bin/pluginkit') {
      return { stdout: args[0] === '-m' && settings.finderElection ? `${settings.finderElection} ${EXTENSION_ID}(0.1.2)\tunknown\tunknown\t${path.join(application, 'Contents', 'PlugIns', 'BrclioFinderSync.appex')}\n` : '' };
    }
    if (program === '/bin/ps') return { stdout: args[0] === '-p' ? executable + '\n' : '' };
    if (program === '/usr/bin/open') return { stdout: '' };
    throw new Error('Unexpected native command: ' + program);
  };
  const installer = createMacInstaller({ platform: 'darwin', architecture: 'arm64', executable, userData, parentPid: 1234,
    run, readyTimeout: settings.readyTimeout || 300, startupTimeout: 200, parentTimeout: 200,
    spawn: (program, args, options) => {
      calls.push({ program, args, options, spawn: true });
      child = new EventEmitter(); child.unref = () => { child.unreferenced = true; };
      child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('exit', 1)); return true; };
      setImmediate(async () => {
        if (settings.spawnError) { child.emit('error', new Error(settings.spawnError)); return; }
        configuration = JSON.parse(await fs.readFile(args[1], 'utf8'));
        child.emit('spawn');
        if (!settings.noReady) await atomicJSON(configuration.readyPath, settings.readyError
          ? { status: 'error', error: settings.readyError, token: configuration.token }
          : { status: 'ready', token: configuration.token });
      });
      return child;
    } });
  return { installer, verified, temporary, application, executable, userData, calls, run, configuration: () => configuration, child: () => child, mountpoint: () => mountpoint };
}

async function helperFixture(t, overrides = {}) {
  const setup = await fixture(t, overrides);
  await setup.installer.start(setup.verified);
  const cfg = setup.configuration();
  let clock = 0;
  const opens = [];
  const run = async (program, args, options) => {
    if (program === '/usr/bin/open') {
      opens.push({ program, args, options });
      if (args.includes('--brclio-update-job') && overrides.openFailure) throw new Error('LaunchServices refused launch');
      if (args.includes('--brclio-update-job') && !overrides.noAck) await atomicJSON(cfg.ackPath, { token: cfg.token, version: cfg.version,
        executable: setup.executable, pid: 4321, ...overrides.ack });
      return { stdout: '' };
    }
    return setup.run(program, args, options);
  };
  const dependencies = { run, alive: pid => pid === 4321 || (overrides.parentAlive && pid === cfg.parentPid),
    now: () => clock, delay: async milliseconds => { clock += milliseconds; }, ...overrides.dependencies };
  return { ...setup, cfg, opens, dependencies, execute: () => runHelper(path.join(cfg.job, 'configuration.json'), dependencies) };
}

test('mac preparation rejects tampered downloads, old versions, wrong architecture and invalid signed bundles before spawning', async t => {
  const setup = await fixture(t);
  await fs.appendFile(setup.verified.filename, 'changed');
  await assert.rejects(setup.installer.start(setup.verified), /已变更/);
  assert.equal(setup.calls.some(call => call.spawn), false);
  const sameVersion = await fixture(t, { currentVersion: '0.1.3' });
  await assert.rejects(sameVersion.installer.start(sameVersion.verified), /无需覆盖/);
  assert.equal(sameVersion.calls.some(call => call.spawn), false);
  const wrongVersion = await fixture(t, { candidateVersion: '9.9.9' });
  await assert.rejects(wrongVersion.installer.start(wrongVersion.verified), /版本/);
  const wrongArch = await fixture(t, { architectureOutput: 'x86_64' });
  await assert.rejects(wrongArch.installer.start(wrongArch.verified), /架构/);
  const badSignature = await fixture(t, { signatureFailure: true });
  await assert.rejects(badSignature.installer.start(badSignature.verified), /signature/);
  const badSandbox = await fixture(t, { entitlements: { 'com.apple.security.inherit': true } });
  await assert.rejects(badSandbox.installer.start(badSandbox.verified), /沙盒/);
  for (const item of [wrongVersion, wrongArch, badSignature, badSandbox]) assert.equal(item.calls.some(call => call.spawn), false);
});

test('mac handoff preserves literal paths, mounts read-only, verifies copy, and commits only after helper readiness', async t => {
  const setup = await fixture(t, { finderElection: '+' });
  const original = await fs.lstat(setup.application);
  const first = setup.installer.start(setup.verified);
  assert.equal(setup.installer.start(setup.verified), first);
  assert.deepEqual(await first, { installerStarted: true, automaticInstall: true });
  const cfg = setup.configuration();
  assert.equal((await fs.lstat(setup.application)).ino, original.ino, 'parent preparation never replaces the running application');
  assert.equal(cfg.finderRegistered, true); assert.equal(cfg.finderEnabled, true);
  assert.equal((await fs.lstat(cfg.staged)).dev, original.dev);
  assert.notEqual((await fs.lstat(cfg.staged)).ino, original.ino);
  assert.deepEqual(JSON.parse(await fs.readFile(cfg.commitPath, 'utf8')), { token: cfg.token });
  assert.equal(setup.child().unreferenced, true);
  const attached = setup.calls.find(call => call.program === '/usr/bin/hdiutil' && call.args[0] === 'attach');
  assert.ok(attached.args.includes('-readonly')); assert.ok(attached.args.includes('-noautoopen'));
  assert.equal(attached.args.at(-1), setup.verified.filename);
  const spawned = setup.calls.find(call => call.spawn);
  assert.equal(spawned.options.detached, true); assert.equal(spawned.options.shell, undefined);
  assert.equal(spawned.options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(await setup.installer.readResult(), null, 'handoff is not installation success');
});

test('helper preparation failure, spawn failure and readiness timeout leave the old bundle untouched', async t => {
  for (const settings of [{ readyError: 'Not enough free space' }, { spawnError: 'Helper blocked' }, { noReady: true, readyTimeout: 60 }]) {
    const setup = await fixture(t, settings);
    const inode = (await fs.lstat(setup.application)).ino;
    await assert.rejects(setup.installer.start(setup.verified), /space|blocked|超时/);
    assert.equal((await fs.lstat(setup.application)).ino, inode);
    assert.equal(setup.child().unreferenced, undefined);
    if (!settings.spawnError) assert.equal(setup.child().killed, true);
    assert.deepEqual((await fs.readdir(setup.temporary)).filter(name => name.startsWith('.brclio-update-')), []);
  }
});

test('real filesystem transaction replaces the entire bundle, waits for healthy ACK and preserves disabled Finder election', async t => {
  const setup = await helperFixture(t, { finderElection: '-' });
  const result = await setup.execute();
  assert.equal(result.status, 'installed'); assert.equal(result.launchAcknowledged, true);
  assert.equal((await fs.lstat(setup.application)).ino.toString(), setup.cfg.stagedIdentity.split(':')[1]);
  assert.equal(JSON.parse(await fs.readFile(path.join(setup.application, 'Contents', 'Info.plist'), 'utf8')).CFBundleShortVersionString, '0.1.3');
  await assert.rejects(fs.lstat(setup.cfg.backup), { code: 'ENOENT' });
  assert.equal(setup.opens.length, 1);
  const opened = setup.opens[0];
  assert.deepEqual(opened.args.slice(0, 4), ['-n', '-a', setup.application, '--args']);
  assert.equal(opened.options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.ok(setup.calls.some(call => call.program === '/usr/bin/pluginkit' && call.args[0] === '-e' && call.args[1] === 'ignore'));
  const reported = await setup.installer.readResult(); assert.equal(reported.status, 'installed');
  assert.deepEqual(await setup.installer.readResult({ consume: true }), reported);
  assert.equal(await setup.installer.readResult(), null);
});

test('open returning success without an ACK rolls back and automatically requests the old application again', async t => {
  const setup = await helperFixture(t, { noAck: true });
  const result = await setup.execute();
  assert.equal(result.status, 'error'); assert.equal(result.rollbackSucceeded, true);
  assert.equal((await fs.lstat(setup.application)).ino.toString(), setup.cfg.currentIdentity.split(':')[1]);
  assert.equal(JSON.parse(await fs.readFile(path.join(setup.application, 'Contents', 'Info.plist'), 'utf8')).CFBundleShortVersionString, '0.1.2');
  assert.equal(setup.opens.length, 2); assert.ok(setup.opens[1].args.includes('--brclio-update-failed'));
  assert.ok((await fs.lstat(setup.cfg.failed)).isDirectory());
});

test('launch failure and a wrong-version ACK both restore the original application', async t => {
  for (const settings of [{ openFailure: true }, { ack: { version: '0.1.2' } }]) {
    const setup = await helperFixture(t, settings);
    const result = await setup.execute();
    assert.equal(result.status, 'error'); assert.equal(result.rollbackSucceeded, true);
    assert.equal((await fs.lstat(setup.application)).ino.toString(), setup.cfg.currentIdentity.split(':')[1]);
  }
});

test('parent that has not exited prevents replacement, and a missing commit cancels when the parent exits', async t => {
  const waiting = await helperFixture(t, { parentAlive: true });
  assert.equal((await waiting.execute()).status, 'error');
  assert.equal((await fs.lstat(waiting.application)).ino.toString(), waiting.cfg.currentIdentity.split(':')[1]);
  assert.equal(waiting.opens.length, 0);
  const cancelled = await helperFixture(t);
  await fs.rm(cancelled.cfg.commitPath);
  assert.deepEqual(await cancelled.execute(), { status: 'cancelled' });
  assert.equal((await fs.lstat(cancelled.application)).ino.toString(), cancelled.cfg.currentIdentity.split(':')[1]);
  assert.equal(cancelled.opens.length, 0);
});

test('cleanup failure is a successful update with a warning and does not reopen the old version', async t => {
  const setup = await helperFixture(t);
  setup.dependencies.fs = { ...fs, rm: async (filename, options) => {
    if (filename === setup.cfg.backup) throw Object.assign(new Error('backup is not writable'), { code: 'EACCES' });
    return fs.rm(filename, options);
  } };
  const result = await setup.execute();
  assert.equal(result.status, 'installed'); assert.equal(result.launchAcknowledged, true); assert.match(result.warning, /备份/);
  assert.ok((await fs.lstat(setup.cfg.backup)).isDirectory());
  assert.equal(setup.opens.length, 1);
  assert.equal((await setup.installer.readResult()).status, 'installed');
});

test('replacement failure still restores the old bundle when recovery journal writes fail', async t => {
  const setup = await helperFixture(t);
  let moved = false;
  setup.dependencies.fs = { ...fs, rename: async (from, to) => {
    if (from === setup.cfg.staged && to === setup.application) { moved = true; throw Object.assign(new Error('disk became full'), { code: 'ENOSPC' }); }
    return fs.rename(from, to);
  }, writeFile: async (filename, ...args) => {
    if (moved && filename.includes('state.json.')) throw Object.assign(new Error('journal disk full'), { code: 'ENOSPC' });
    return fs.writeFile(filename, ...args);
  } };
  const result = await setup.execute();
  assert.equal(result.rollbackSucceeded, true);
  assert.equal((await fs.lstat(setup.application)).ino.toString(), setup.cfg.currentIdentity.split(':')[1]);
  assert.equal(setup.opens.length, 1); assert.ok(setup.opens[0].args.includes('--brclio-update-failed'));
});

test('concurrent application replacement is not overwritten during rollback and the original backup is retained', async t => {
  const setup = await helperFixture(t);
  setup.dependencies.fs = { ...fs, rename: async (from, to) => {
    if (from === setup.cfg.staged && to === setup.application) {
      await fs.mkdir(setup.application); await fs.writeFile(path.join(setup.application, 'unrelated'), 'Do not remove');
      throw new Error('Concurrent application replacement');
    }
    return fs.rename(from, to);
  } };
  const result = await setup.execute();
  assert.equal(result.rollbackSucceeded, false);
  assert.equal(await fs.readFile(path.join(setup.application, 'unrelated'), 'utf8'), 'Do not remove');
  assert.ok((await fs.lstat(setup.cfg.backup)).isDirectory());
  assert.equal(setup.opens.length, 0);
});

test('ACK requires the exact private job, token, new bundle inode and running version', async t => {
  const setup = await helperFixture(t);
  const args = ['Brclio', '--brclio-update-job', setup.cfg.job, '--brclio-update-token', setup.cfg.token];
  await assert.rejects(setup.installer.acknowledgeLaunch(args, '0.1.2'), /不匹配/);
  await assert.rejects(setup.installer.acknowledgeLaunch(args, '0.1.3'), /不匹配/, 'the old bundle cannot acknowledge the future update');
  await fs.rename(setup.application, setup.cfg.backup); await fs.rename(setup.cfg.staged, setup.application);
  await assert.rejects(setup.installer.acknowledgeLaunch([...args, '--brclio-update-job', setup.cfg.job], '0.1.3'), /参数/);
  await assert.rejects(setup.installer.acknowledgeLaunch([...args.slice(0, -1), 'a'.repeat(64)], '0.1.3'), /不匹配/);
  assert.deepEqual(await setup.installer.acknowledgeLaunch(args, '0.1.3'), { acknowledged: true, version: '0.1.3' });
  assert.equal(JSON.parse(await fs.readFile(setup.cfg.ackPath, 'utf8')).pid, process.pid);
  assert.equal(await setup.installer.acknowledgeLaunch(['Brclio'], '0.1.3'), null);
  const outside = ['--brclio-update-job', setup.temporary, '--brclio-update-token', setup.cfg.token];
  await assert.rejects(setup.installer.acknowledgeLaunch(outside, '0.1.3'), /不属于/);
});

test('a changed staging bundle never replaces the installed application and the old client is reopened', async t => {
  const setup = await helperFixture(t);
  const extensionPlist = path.join(setup.cfg.staged, 'Contents', 'PlugIns', 'BrclioFinderSync.appex', 'Contents', 'Info.plist');
  const info = JSON.parse(await fs.readFile(extensionPlist, 'utf8'));
  info.CFBundleIdentifier = 'com.unrelated.extension';
  await fs.writeFile(extensionPlist, JSON.stringify(info));
  const result = await setup.execute();
  assert.equal(result.status, 'error'); assert.equal(result.rollbackSucceeded, true);
  assert.equal((await fs.lstat(setup.application)).ino.toString(), setup.cfg.currentIdentity.split(':')[1]);
  assert.ok(setup.opens[0].args.includes('--brclio-update-failed'));
});

test('Finder maintenance failure remains an acknowledged update and never enables a previously unregistered extension', async t => {
  const unregistered = await helperFixture(t);
  assert.equal((await unregistered.execute()).status, 'installed');
  assert.equal(unregistered.calls.some(call => call.program === '/usr/bin/pluginkit' && call.args[0] === '-e'), false);
  const registered = await helperFixture(t, { finderElection: '+' });
  const originalRun = registered.dependencies.run;
  registered.dependencies.run = async (program, args, options) => {
    if (program === '/usr/bin/pluginkit' && args[0] !== '-m') throw new Error('pluginkit unavailable');
    return originalRun(program, args, options);
  };
  const result = await registered.execute();
  assert.equal(result.status, 'installed'); assert.match(result.warning, /Finder/);
  assert.equal(registered.opens.length, 1);
});

test('isolated native launch explicitly forwards only the recorded Brclio data directory through open --env', async t => {
  const setup = await helperFixture(t);
  setup.cfg.guiUserData = setup.userData;
  await atomicJSON(path.join(setup.cfg.job, 'configuration.json'), setup.cfg);
  assert.equal((await setup.execute()).status, 'installed');
  const args = setup.opens[0].args;
  assert.deepEqual(args.slice(3, 6), ['--env', 'BRCLIO_USER_DATA=' + setup.userData, '--args']);
});

test('GUI launch environment never inherits Node mode or injected loader settings', () => {
  assert.deepEqual(guiEnvironment({ ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1', NODE_OPTIONS: '--require bad', NODE_PATH: '/bad',
    DYLD_INSERT_LIBRARIES: '/bad', LD_PRELOAD: '/bad', HOME: '/Users/test', BRCLIO_USER_DATA: '/tmp/fixture' }), { HOME: '/Users/test', BRCLIO_USER_DATA: '/tmp/fixture' });
});

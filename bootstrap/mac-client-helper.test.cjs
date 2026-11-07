'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { installAndOpen } = require('./install.cjs');
const { checkMacBrclioProcesses } = require('./mac-client-helper.cjs');
const { APP_ID, EXTENSION_ID, atomicJSON } = require('../desktop/mac-installer-helper.cjs');

function processSnapshots(snapshots) {
  const url = filename => ({ path: { js: filename }, URLByResolvingSymlinksInPath: { path: { js: filename } } });
  return async (_program, args) => {
    const context = { ObjC: { import() {} }, $: { NSURL: { fileURLWithPath: url },
      NSRunningApplication: { runningApplicationsWithBundleIdentifier(id) {
        assert.equal(id, APP_ID);
        assert.ok(snapshots.length, 'unexpected process probe');
        return { js: snapshots.shift() };
      } } }, argv: args.slice(4) };
    return { stdout: vm.runInNewContext(args[3] + '\nrun(argv)', context) };
  };
}

const target = '/Applications/Brclio.app', other = '/Users/test/Applications/Brclio.app';
function runningApp(pid, filename, stopped) {
  return { processIdentifier: pid, bundleURL: { path: { js: filename }, URLByResolvingSymlinksInPath: { path: { js: filename } } },
    terminated: false, get terminate() { this.terminated = true; stopped.push(pid); } };
}

test('quit requests only reach the canonical instance and recheck once it exits', async () => {
  const stopped = [];
  const canonical = () => runningApp(20, target, stopped), foreign = () => runningApp(21, other, stopped);
  await assert.rejects(checkMacBrclioProcesses(target, processSnapshots([[canonical(), foreign()]]), true), error => error.message.includes(other));
  assert.deepEqual(stopped, []);
  await assert.rejects(checkMacBrclioProcesses(target, processSnapshots([[canonical()], [foreign()]]), true), error => error.message.includes(other));
  assert.deepEqual(stopped, [20]);
  await assert.rejects(checkMacBrclioProcesses(target, processSnapshots([[canonical()], [runningApp(22, target, stopped)]]), true), /退出正在运行的 Brclio/);
  assert.deepEqual(stopped, [20, 20]);
});

test('explicitly terminated records and nil paths of exited PIDs are ignored during exit', async t => {
  const stopped = [];
  t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, 20); assert.equal(signal, 0);
    throw Object.assign(new Error('exited'), { code: 'ESRCH' });
  });
  const gone = { processIdentifier: 20, bundleURL: undefined, terminated: false };
  const stale = { terminated: true, get bundleURL() { assert.fail('terminated record was inspected'); } };
  let reads = 0;
  const exiting = { processIdentifier: 31, bundleURL: null, get terminated() { return ++reads === 2; } };
  await checkMacBrclioProcesses(target, processSnapshots([[runningApp(20, target, stopped)], [gone, stale, exiting]]), true);
  assert.deepEqual(stopped, [20]);
});

test('live nil paths block the whole quit snapshot until all identities are known', async t => {
  const stopped = [];
  t.mock.method(process, 'kill', (pid, signal) => { assert.equal(pid, 21); assert.equal(signal, 0); });
  const canonical = () => runningApp(20, target, stopped);
  const hidden = { processIdentifier: 21, terminated: false, bundleURL: { URLByResolvingSymlinksInPath: null } };
  await assert.rejects(checkMacBrclioProcesses(target, processSnapshots([[canonical(), hidden], [canonical(), runningApp(21, other, stopped)]]), true),
    error => error.message.includes(other));
  assert.deepEqual(stopped, []);
  await assert.rejects(checkMacBrclioProcesses(target, processSnapshots([[hidden], [runningApp(22, target, stopped)]]), true), /退出正在运行的 Brclio/);
  assert.deepEqual(stopped, []);
  await checkMacBrclioProcesses(target, processSnapshots([[canonical(), hidden], [canonical(), runningApp(21, target, stopped)], []]), true);
  assert.deepEqual(stopped, [20, 21]);
});

test('persistent unavailable paths are bounded, include their PID, and never terminate a process', async t => {
  t.mock.method(process, 'kill', (_pid, signal) => {
    assert.equal(signal, 0);
    throw Object.assign(new Error('alive, permission denied'), { code: 'EPERM' });
  });
  const stopped = [];
  const live = { processIdentifier: 23, get bundleURL() { throw Error('stale bridge'); } };
  const snapshots = Array.from({ length: 5 }, () => [runningApp(20, target, stopped), live]);
  await assert.rejects(checkMacBrclioProcesses(target, processSnapshots(snapshots), true), /PID 23.*应用路径/);
  assert.equal(snapshots.length, 0);
  assert.deepEqual(stopped, []);
});

async function writeBundle(bundle, version) {
  for (const [directory, id, executable, type] of [
    [bundle, APP_ID, 'Brclio', 'APPL'],
    [path.join(bundle, 'Contents', 'PlugIns', 'BrclioFinderSync.appex'), EXTENSION_ID, 'BrclioFinderSync', 'XPC!'],
  ]) {
    const contents = path.join(directory, 'Contents');
    await fs.mkdir(path.join(contents, 'MacOS'), { recursive: true });
    await fs.writeFile(path.join(contents, 'MacOS', executable), id);
    const info = { CFBundleIdentifier: id, CFBundleExecutable: executable, CFBundlePackageType: type,
      CFBundleShortVersionString: version, CFBundleVersion: version };
    if (type === 'XPC!') info.NSExtension = { NSExtensionPointIdentifier: 'com.apple.FinderSync', NSExtensionPrincipalClass: 'BrclioFinderSync.FinderSync' };
    await fs.writeFile(path.join(contents, 'Info.plist'), JSON.stringify(info));
  }
}

async function transaction(t, conflict) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-helper-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const system = path.join(root, 'Applications'), target = path.join(system, 'Brclio.app');
  const legacy = path.join(root, 'user', 'Applications', 'Brclio.app');
  const profile = path.join(root, 'custom profile'), unused = path.join(root, 'default-data');
  const oldProfile = process.env.BRCLIO_USER_DATA;
  process.env.BRCLIO_USER_DATA = path.relative(process.cwd(), profile);
  t.after(() => {
    if (oldProfile === undefined) delete process.env.BRCLIO_USER_DATA;
    else process.env.BRCLIO_USER_DATA = oldProfile;
  });

  await Promise.all([writeBundle(target, '0.2.7'), writeBundle(legacy, '0.2.7')]);
  const original = await fs.lstat(target), originalLegacy = await fs.lstat(legacy);
  const version = '0.2.8', filename = path.join(root, 'Brclio-0.2.8-mac-arm64.dmg');
  const bytes = Buffer.from('isolated official package fixture');
  await fs.writeFile(filename, bytes);
  const descriptor = { product: 'brclio', version, filename, size: bytes.length, expected: crypto.createHash('sha256').update(bytes).digest('hex') };
  const opened = [], checks = [];
  let cfg, completion, parentAlive = true;
  async function run(command, args) {
    if (command === '/usr/bin/osascript') {
      assert.deepEqual(args.slice(-2, -1), [target]);
      const action = args.at(-1);
      if (cfg) checks.push(action);
      const blocked = cfg && (conflict === 'swap' || (conflict === 'launch' && action === 'check'));
      return { stdout: JSON.stringify(blocked ? {other:legacy} : {pids:[], unknown:[]}) };
    }
    if (command === '/usr/bin/hdiutil') {
      if (args[0] !== 'attach') return { stdout: '' };
      const mount = args[args.indexOf('-mountpoint') + 1];
      await writeBundle(path.join(mount, 'Brclio.app'), version);
      return { stdout: JSON.stringify({ 'system-entities': [{ 'mount-point': mount }] }) };
    }
    if (command === '/usr/bin/plutil') return { stdout: await fs.readFile(args.at(-1), 'utf8') };
    if (command === '/usr/bin/lipo') return { stdout: 'arm64' };
    if (command === '/usr/bin/codesign') {
      const id = args.at(-1).endsWith('.appex') ? EXTENSION_ID : APP_ID;
      if (args.includes('--verbose=4')) return { stderr: `Identifier=${id}\nSignature=adhoc\nTeamIdentifier=not set\nInfo.plist entries=12\nSealed Resources version=2 rules=13 files=1\n` };
      return { stdout: JSON.stringify({ 'com.apple.security.app-sandbox': true, 'com.apple.security.files.user-selected.read-only': true }) };
    }
    if (command === '/usr/bin/ditto') { await fs.cp(args.at(-2), args.at(-1), { recursive: true }); return { stdout: '' }; }
    if (command === '/usr/bin/pluginkit') return { stdout: '' };
    if (command === '/bin/ps') return { stdout: args[0] === '-p' ? path.join(target, 'Contents', 'MacOS', 'Brclio')
      : '20302 ' + path.join(legacy, 'Contents', 'MacOS', 'Brclio') };
    if (command === '/usr/bin/open') {
      assert.equal(args[args.indexOf('-a') + 1], target);
      assert.ok(args.includes('BRCLIO_USER_DATA=' + profile));
      opened.push(args);
      if (args.includes('--updated')) await atomicJSON(cfg.ackPath, { token: cfg.token, version, pid: 20301,
        executable: path.join(target, 'Contents', 'MacOS', 'Brclio') });
      return { stdout: '' };
    }
    assert.fail('Unexpected native command: ' + command);
  }

  function spawn(program, [wrapper, helper, configuration, selected], opts) {
    assert.equal(program, process.execPath);
    assert.equal(selected, target);
    assert.equal(opts.detached, true);
    assert.equal(opts.env.ELECTRON_RUN_AS_NODE, '1');
    const child = new EventEmitter();
    child.unref = () => {};
    child.kill = () => assert.fail('unexpected helper termination');
    setImmediate(async () => {
      try {
        cfg = JSON.parse(await fs.readFile(configuration, 'utf8'));
        assert.equal(cfg.guiUserData, profile);
        assert.equal(path.dirname(path.dirname(path.dirname(cfg.job))), profile);
        assert.equal(path.dirname(wrapper), cfg.job);
        assert.equal(path.dirname(helper), cfg.job);
        assert.deepEqual(await fs.readFile(wrapper), await fs.readFile(path.join(__dirname, 'mac-client-helper.cjs')));
        completion = require(wrapper).runMacClientHelper(helper, configuration, selected, {
          run, alive: pid => (pid === cfg.parentPid && parentAlive) || pid === 20301,
          signal: () => assert.fail('the other client process must never be signalled'),
        });
        child.emit('spawn');
      } catch (error) { child.emit('error', error); }
    });
    return child;
  }

  assert.deepEqual(await installAndOpen(descriptor, { platform: 'darwin', arch: 'arm64', macDirectories: [system], appData: unused, run, spawn }), { handoff: true });
  parentAlive = false;
  const result = await completion;
  const receipt = JSON.parse(await fs.readFile(path.join(cfg.job, 'result.json'), 'utf8'));
  assert.equal(receipt.status, result.status);
  assert.equal(receipt.current, target);
  assert.equal(receipt.version, version);
  assert.equal((await fs.lstat(legacy)).ino, originalLegacy.ino);
  await assert.rejects(fs.lstat(unused), { code: 'ENOENT' });
  if (conflict) {
    assert.equal(result.status, 'error');
    assert.ok(result.error.includes(legacy));
    assert.equal(result.rollbackSucceeded, true);
    assert.equal((await fs.lstat(target)).ino, original.ino);
    assert.equal(opened.length, 0);
    if (conflict === 'swap') {
      assert.deepEqual(checks, ['quit', 'check']);
      await assert.rejects(fs.lstat(cfg.backup), { code: 'ENOENT' });
      assert.equal(result.phase, 'installing');
    } else {
      assert.deepEqual(checks, ['quit', 'check', 'check']);
      assert.equal((await fs.lstat(cfg.failed)).ino.toString(), cfg.stagedIdentity.split(':')[1]);
      assert.equal(result.phase, 'restarting');
    }
  } else {
    assert.equal(result.launchAcknowledged, true);
    assert.equal((await fs.lstat(target)).ino.toString(), cfg.stagedIdentity.split(':')[1]);
    assert.deepEqual(checks, ['quit', 'check']);
    assert.equal(opened.length, 1);
  }
}

for (const [scenario, conflict] of [
  ['successful canonical upgrade validates the actual launch receipt in the explicit client profile', null],
  ['a late non-target instance blocks the first rename and recovery open', 'swap'],
  ['a newly running non-target instance blocks candidate and recovery opens while rollback restores the old inode', 'launch'],
]) {
  test(scenario, { skip: process.platform === 'win32' }, t => transaction(t, conflict));
}

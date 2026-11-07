'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { getInstalled, openInstalled, installAndOpen } = require('./install.cjs');

async function packageFixture(t, { product = 'brclio', suffix = 'windows-x64.exe' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-bootstrap-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const prefix = product === 'downloader' ? 'Brclio-Downloader' : 'Brclio';
  const filename = path.join(root, prefix + '-1.2.3-' + suffix);
  const bytes = Buffer.from('test release package');
  await fs.writeFile(filename, bytes);
  const descriptor = { product, version:'1.2.3', filename, size:bytes.length, expected:createHash('sha256').update(bytes).digest('hex') };
  return { root, descriptor };
}

test('a same-sized file with the wrong checksum never reaches a system command', async t => {
  const { descriptor } = await packageFixture(t);
  await fs.writeFile(descriptor.filename, Buffer.alloc(descriptor.size, 0xaa));
  let commands = 0;
  const forbid = () => { commands++; throw new Error('unexpected system command'); };
  await assert.rejects(installAndOpen(descriptor, { platform:'win32', arch:'x64', run:forbid, spawn:forbid }), /SHA-256/);
  assert.equal(commands, 0);
});

test('a Brclio release cannot be installed as the downloader or on another architecture', async t => {
  const { descriptor } = await packageFixture(t);
  await assert.rejects(installAndOpen({ ...descriptor, product:'downloader' }, { platform:'win32', arch:'x64' }), /产品、版本或架构/);
  await assert.rejects(installAndOpen(descriptor, { platform:'darwin', arch:'arm64' }), /产品、版本或架构/);
});

test('a differently identified application occupying Brclio.app is never replaced or launched', async t => {
  const { root, descriptor } = await packageFixture(t, { suffix:'mac-arm64.dmg' });
  const occupied = path.join(root, 'Brclio.app');
  await fs.mkdir(occupied);
  const marker = path.join(occupied, 'other-application');
  await fs.writeFile(marker, 'preserve me');
  const calls = [];
  const opts = { platform:'darwin', arch:'arm64', macDirectories:[root], run:async (command, args) => {
    calls.push(command);
    assert.equal(args.at(-1), path.join(occupied, 'Contents', 'Info.plist'));
    return { stdout: JSON.stringify({ CFBundleIdentifier:'org.example.other', CFBundlePackageType:'APPL',
      CFBundleExecutable:'Brclio', CFBundleShortVersionString:'1.0.0' }) };
  } };
  await assert.rejects(installAndOpen(descriptor, opts), /应用身份/);
  assert.deepEqual(calls, ['/usr/bin/plutil']);
  assert.equal(await fs.readFile(marker, 'utf8'), 'preserve me');
});

test('each Windows product uses its electron-builder NSIS registry identity', async () => {
  for (const [product, name, guid] of [
    ['brclio', 'Brclio', 'c8f079c5-a346-5aee-a72f-5280717e7b26'],
    ['downloader', 'Brclio Downloader', '6aae18b5-b2c5-5fd1-9b91-8184c8766ad1'],
  ]) {
    let queried = false;
    const result = await getInstalled(product, { platform:'win32', run:async (command, args, { env }) => {
      assert.equal(path.win32.basename(command), 'powershell.exe');
      assert.equal(env.BRCLIO_INSTALL_GUID, guid);
      assert.equal(env.BRCLIO_INSTALL_NAME, name);
      assert.ok(args.includes('-NonInteractive'));
      queried = true;
      return { stdout:'' };
    } });
    assert.equal(queried, true);
    assert.equal(result, null);
  }
});

test('the downloader self-update detects a registered downloader bundle in a custom folder and rejects transient images', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-moved-app-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const bundle = path.join(root, 'Moved Tools', 'Renamed.app');
  const executable = path.join(bundle, 'Contents', 'MacOS', 'Brclio Downloader');
  await fs.mkdir(path.dirname(executable), {recursive:true});
  await fs.writeFile(executable, 'fixture');
  let registered = bundle, id = 'com.brclio.downloader';
  const options = {platform:'darwin', executable:path.join(root, 'Development', 'Electron'), macDirectories:[path.join(root, 'Empty')],
    registeredMacApplication:async requested => { assert.equal(requested, 'com.brclio.downloader'); return registered; },
    run:async (command, args) => {
      assert.equal(command, '/usr/bin/plutil');
      assert.equal(args.at(-1), path.join(bundle, 'Contents', 'Info.plist'));
      return {stdout:JSON.stringify({CFBundleIdentifier:id, CFBundlePackageType:'APPL', CFBundleExecutable:'Brclio Downloader', CFBundleShortVersionString:'0.2.8'})};
    }};
  assert.deepEqual(await getInstalled('downloader', options), {path:bundle, executable, version:'0.2.8'});
  id = 'org.example.other';
  await assert.rejects(getInstalled('downloader', options), /身份/);
  for (registered of ['/Volumes/Installer/Brclio.app', '/private/var/AppTranslocation/job/Brclio.app', path.join(root, 'Deleted.app')]) {
    assert.equal(await getInstalled('downloader', options), null);
  }
});

test('fresh Brclio detection uses only the system Applications folder by default', async t => {
  const locations = [];
  t.mock.method(fs, 'lstat', async name => {
    locations.push(name);
    throw Object.assign(new Error('Fixture path is absent'), {code:'ENOENT'});
  });
  const result = await getInstalled('brclio', {platform:'darwin',
    registeredMacApplication:() => assert.fail('Custom locations must not redirect the client'),
    run:async (command, args) => {
      assert.equal(command, '/usr/bin/osascript');
      assert.equal(args.at(-1), 'check');
      return {stdout:''};
    }});
  assert.equal(result, null);
  assert.deepEqual(locations, [path.join('/Applications', 'Brclio.app')]);
  for (const macDirectories of [[], ['relative-path']]) {
    await assert.rejects(getInstalled('brclio', {platform:'darwin', macDirectories}), /绝对安装目录/);
  }
  assert.equal(locations.length, 1, 'Invalid test roots must not fall back to a real Applications folder');
});

async function macFixture(t) {
  const {root, descriptor} = await packageFixture(t, {suffix:'mac-arm64.dmg'});
  const system = path.join(root, 'system', 'Applications'), user = path.join(root, 'home', 'Applications');
  const bundle = path.join(system, 'Brclio.app'), legacy = path.join(user, 'Brclio.app');
  const opened = [];
  const options = {platform:'darwin', arch:'arm64', macDirectories:[system, user],
    registeredMacApplication:() => assert.fail('Launch Services must not redirect the client'),
    run:async (command, args) => {
      if (command === '/usr/bin/osascript') {
        assert.deepEqual(args.slice(-2), [bundle, 'check']);
        return {stdout:''};
      }
      if (command === '/usr/bin/plutil') {
        assert.equal(args.at(-1), path.join(bundle, 'Contents', 'Info.plist'));
        return {stdout:JSON.stringify({CFBundleIdentifier:'com.brclio.toolbox', CFBundlePackageType:'APPL',
          CFBundleExecutable:'Brclio', CFBundleShortVersionString:descriptor.version})};
      }
      if (command === '/usr/bin/open') {
        opened.push(args);
        return {};
      }
      assert.fail('Unexpected native command: ' + command);
    }};
  async function addApp(dest) {
    const binary = path.join(dest, 'Contents', 'MacOS', 'Brclio');
    await fs.mkdir(path.dirname(binary), {recursive:true});
    await fs.writeFile(binary, 'fixture');
  }
  return {descriptor, system, bundle, legacy, options, addApp, opened};
}

test('an existing user copy does not redirect a fresh client installation', async t => {
  const {descriptor, bundle, legacy, system, addApp, options} = await macFixture(t);
  await addApp(legacy);
  const previous = await fs.lstat(legacy);
  assert.equal(await getInstalled('brclio', options), null);
  const run = options.run;
  let mountAttempted = false;
  options.run = async (command, args) => {
    if (command !== '/usr/bin/hdiutil') return run(command, args);
    assert.equal(args[0], 'attach');
    assert.equal(path.dirname(path.dirname(args[args.indexOf('-mountpoint') + 1])), system);
    mountAttempted = true;
    throw new Error('Fixture stops before mounting');
  };
  await assert.rejects(installAndOpen(descriptor, options), /Fixture stops/);
  assert.ok(mountAttempted);
  assert.deepEqual(await fs.readdir(system), []);
  assert.equal((await fs.lstat(legacy)).ino, previous.ino);
  await assert.rejects(fs.lstat(bundle), {code:'ENOENT'});
});

test('when both copies exist, only the canonical bundle is inspected and opened', async t => {
  const {descriptor, bundle, legacy, addApp, options, opened} = await macFixture(t);
  await Promise.all([addApp(bundle), addApp(legacy)]);
  assert.equal((await getInstalled('brclio', options)).path, bundle);
  assert.deepEqual(await installAndOpen(descriptor, options), {handoff:false});
  assert.deepEqual(opened, [['-a', bundle]]);
  assert.equal(await fs.readFile(path.join(legacy,'Contents','MacOS','Brclio'), 'utf8'), 'fixture');
});

test('an active noncanonical Brclio prevents installation and cannot receive a canonical open', async t => {
  const {descriptor, bundle, legacy, addApp, options, opened} = await macFixture(t);
  const run = options.run;
  options.run = async (command, args) => command === '/usr/bin/osascript' ? {stdout:legacy} : run(command, args);
  await assert.rejects(installAndOpen(descriptor, options), error => error.message.includes(legacy));
  await assert.rejects(fs.lstat(bundle), {code:'ENOENT'});

  await addApp(bundle);
  let checks = 0;
  options.run = async (command, args) => command === '/usr/bin/osascript'
    ? {stdout:++checks === 1 ? '' : legacy} : run(command, args);
  await assert.rejects(openInstalled('brclio', options), error => error.message.includes(legacy));
  assert.deepEqual(opened, []);
});

test('a read-only system target explains the permission error and does not try a user install', async t => {
  const {descriptor, system, legacy, options} = await macFixture(t);
  await fs.mkdir(system, {recursive:true});
  t.mock.method(fs, 'mkdtemp', async prefix => {
    assert.equal(path.dirname(prefix), system);
    throw Object.assign(new Error('read-only fixture'), {code:'EACCES'});
  });
  await assert.rejects(installAndOpen(descriptor, options), /没有写入.*Brclio\.app.*权限/);
  await assert.rejects(fs.lstat(legacy), {code:'ENOENT'});
});

test('a fresh Windows install runs per-user silently and launches the verified registry path', async t => {
  const { descriptor } = await packageFixture(t);
  const found = { path:'D:\\Custom Location\\Brclio.exe', version:descriptor.version };
  const events = [];
  const result = await installAndOpen(descriptor, {
    platform:'win32', arch:'x64',
    async run(command, args) {
      if (command === descriptor.filename) {
        assert.deepEqual(args, ['/S', '/currentuser']);
        events.push('install');
        return { stdout:'' };
      }
      assert.equal(path.win32.basename(command), 'powershell.exe');
      const installed = events.includes('install');
      events.push('lookup');
      return { stdout:installed ? JSON.stringify(found) : '' };
    },
    spawn(file, args, options) {
      assert.equal(file, found.path);
      assert.deepEqual(args, []);
      assert.equal(options.detached, true);
      events.push('open');
      const child = new EventEmitter();
      child.unref = () => events.push('released');
      process.nextTick(() => child.emit('spawn'));
      return child;
    },
  });
  assert.deepEqual(result, { handoff:false });
  assert.deepEqual(events, ['lookup', 'install', 'lookup', 'open', 'released']);
});

test('successful NSIS exit with a mismatched installed version cannot launch the application', async t => {
  const { descriptor } = await packageFixture(t);
  let installed = false;
  await assert.rejects(installAndOpen(descriptor, { platform:'win32', arch:'x64',
    async run(command) {
      if (command === descriptor.filename) { installed = true; return { stdout:'' }; }
      return { stdout: installed ? JSON.stringify({ path:'D:\\Brclio.exe', version:'1.2.2' }) : '' };
    },
    spawn:() => assert.fail('Wrong-version app was launched'),
  }), /未找到目标版本/);
  assert.equal(installed, true);
});

test('Windows self-upgrade hands a verified release to the detached launcher before returning', async t => {
  const { descriptor } = await packageFixture(t, { product:'downloader' });
  let job, cfg, released = false;
  const result = await installAndOpen(descriptor, { platform:'win32', arch:'x64',
    async run(_command, args) {
      assert.ok(args.includes('-Command'));
      return {stdout:''};
    },
    spawn(command, args, opts) {
      assert.equal(path.win32.basename(command), 'powershell.exe');
      assert.equal(opts.stdio[0], 'ignore');
      assert.ok(Number.isInteger(opts.stdio[1]));
      assert.equal(opts.stdio[1], opts.stdio[2]);
      assert.ok(!Object.keys(opts.env).some(name => name.toLowerCase() === 'psmodulepath'));
      const config = args[args.indexOf('-Configuration') + 1];
      job = path.dirname(config);
      t.after(() => fs.rm(job, { recursive:true, force:true }));
      assert.equal(args[args.indexOf('-File') + 1], path.join(job, 'launch.ps1'));
      const child = new EventEmitter();
      child.unref = () => { released = true; };
      child.kill = () => {};
      (async () => {
        cfg = JSON.parse(await fs.readFile(config, 'utf8'));
        await fs.writeFile(path.join(job, 'ready'), cfg.token);
      })().catch(error => child.emit('error', error));
      return child;
    },
  });
  assert.ok(job);
  assert.equal(released, true);
  assert.equal(cfg.filename, descriptor.filename);
  assert.equal(cfg.expected, descriptor.expected);
  assert.equal(cfg.parentPid, process.pid);
  assert.equal(cfg.guid, '6aae18b5-b2c5-5fd1-9b91-8184c8766ad1');
  assert.equal(await fs.readFile(path.join(job, 'install.ps1'), 'utf8'), await fs.readFile(path.join(__dirname, 'replace-win.ps1'), 'utf8'));
  assert.equal(await fs.readFile(path.join(job, 'commit'), 'utf8'), cfg.token);
  assert.deepEqual(result, { handoff:true });
});

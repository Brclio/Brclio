'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { getInstalled, installAndOpen } = require('./install.cjs');

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
  let job;
  const result = await installAndOpen(descriptor, { platform:'win32', arch:'x64',
    async run(command, args) {
      assert.equal(path.win32.basename(command), 'powershell.exe');
      if (args.includes('-Command')) return { stdout:'' };
      const config = args[args.indexOf('-Configuration') + 1];
      job = path.dirname(config);
      t.after(() => fs.rm(job, { recursive:true, force:true }));
      const cfg = JSON.parse(await fs.readFile(config, 'utf8'));
      assert.equal(cfg.filename, descriptor.filename);
      assert.equal(cfg.expected, descriptor.expected);
      assert.equal(cfg.parentPid, process.pid);
      assert.equal(cfg.guid, '6aae18b5-b2c5-5fd1-9b91-8184c8766ad1');
      assert.equal(args[args.indexOf('-File') + 1], path.join(job, 'launch.ps1'));
      assert.equal(await fs.readFile(path.join(job, 'install.ps1'), 'utf8'), await fs.readFile(path.join(__dirname, 'replace-win.ps1'), 'utf8'));
      await fs.writeFile(path.join(job, 'ready'), 'ready');
      return { stdout:'' };
    },
  });
  assert.ok(job);
  assert.deepEqual(result, { handoff:true });
});

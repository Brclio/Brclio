'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createIntegration, macWorkflow, windowsEntries, OWNER, REGISTRY_KEYS } = require('./integration.cjs');
const { getCopyPaths, windowsArgument, shellArgument } = require('./arguments.cjs');
const { createSettingsStore } = require('./settings.cjs');

const launch = { executable: 'C:\\Users\\中文 用户\\Brclio 工具箱.exe', packaged: true };

function registryMock() {
  const values = new Map();
  let fail;
  const calls = [];
  async function run(executable, args) {
    calls.push({ executable, args });
    if (fail?.(args)) { fail = null; throw Object.assign(new Error('Registry write failed'), { code: 5 }); }
    const [operation, key] = args;
    const selector = args.indexOf('/v');
    const name = selector >= 0 ? args[selector + 1] : '';
    if (operation === 'query') {
      if (!values.has(key) || (args.length > 2 && !values.get(key).has(name))) throw Object.assign(new Error('Missing key'), { code: 1 });
      const entries = args.length === 2 ? [...values.get(key)] : [[name, values.get(key).get(name)]];
      return { stdout: `${key}\r\n${entries.map(([entry, value]) => `    ${entry || '(Default)'}    REG_SZ    ${value}`).join('\r\n')}` };
    }
    if (operation === 'add') {
      if (!values.has(key)) values.set(key, new Map());
      values.get(key).set(name, args[args.indexOf('/d') + 1]);
    } else if (operation === 'delete') {
      if (args.includes('/v') || args.includes('/ve')) values.get(key)?.delete(name);
      else for (const existing of values.keys()) if (existing === key || existing.startsWith(`${key}\\`)) values.delete(existing);
    }
    return { stdout: '' };
  }
  return { values, calls, run, failOnce: predicate => { fail = predicate; } };
}

test('copy-path command retains exact filenames, including flag-like targets', () => {
  const targets = ['/tmp/你好 & $(whoami).txt', '/tmp/--inspect', '/tmp/a\'b"c'];
  assert.deepEqual(getCopyPaths(['electron', '.', '--copy-path', '--', ...targets]), targets);
  assert.equal(getCopyPaths(['electron', '.']), null);
  assert.throws(() => getCopyPaths(['app', '--copy-path', '--']), /没有收到/);
  assert.throws(() => getCopyPaths(['app', '--copy-path', 'a\0b']), /无效/);
});

test('Windows commands quote executable and do not use a command shell', () => {
  const entries = windowsEntries(launch);
  assert.equal(entries[0].command, '"C:\\Users\\中文 用户\\Brclio 工具箱.exe" --copy-path -- "%1"');
  assert.match(entries[1].command, /"%1\\\."$/);
  assert.match(entries[2].command, /"%V\\\."$/);
  assert.equal(windowsArgument('C:\\'), '"C:\\\\"');
  const development = windowsEntries({ executable: 'C:\\Electron.exe', appPath: 'C:\\My App', packaged: false });
  assert.match(development[0].command, /^"C:\\Electron.exe" "C:\\My App"/);
});

test('Windows integration is per-user, status verifies commands, removal preserves other keys', async () => {
  const registry = registryMock();
  registry.values.set('HKCU\\Software\\Classes\\*\\shell\\OtherTool', new Map([['', 'Other Tool']]));
  const integration = createIntegration({ platform: 'win32', launch, run: registry.run });
  assert.equal((await integration.status()).installed, false);
  assert.equal((await integration.set(true)).installed, true);
  for (const entry of REGISTRY_KEYS) assert.equal(registry.values.get(entry.key).get('BrclioOwner'), OWNER);
  assert.ok(registry.calls.every(call => call.args[1].startsWith('HKCU\\')));
  registry.values.get(`${REGISTRY_KEYS[0].key}\\command`).set('', 'old location');
  assert.equal((await integration.status()).stale, true);
  assert.equal((await integration.set(false)).installed, false);
  assert.equal(registry.values.size, 1);
});

test('Windows integration preserves an unowned same-name registry key even without a default value', async () => {
  const registry = registryMock();
  registry.values.set(REGISTRY_KEYS[1].key, new Map([['Icon', 'other.exe']]));
  const integration = createIntegration({ platform: 'win32', launch, run: registry.run });
  await assert.rejects(integration.set(true), /不属于 Brclio/);
  await assert.rejects(integration.set(false), /不属于 Brclio/);
  assert.equal(registry.values.size, 1);
  assert.equal(registry.values.get(REGISTRY_KEYS[1].key).get('Icon'), 'other.exe');
});

test('Windows failed installation rolls back newly created menu keys', async () => {
  const registry = registryMock();
  registry.failOnce(args => args[0] === 'add' && args[1] === `${REGISTRY_KEYS[1].key}\\command`);
  const integration = createIntegration({ platform: 'win32', launch, run: registry.run });
  await assert.rejects(integration.set(true), /Registry write failed/);
  assert.equal(registry.values.size, 0);
});

test('Windows failed relocation restores prior owned menu values', async () => {
  const registry = registryMock();
  const original = createIntegration({ platform: 'win32', launch, run: registry.run });
  await original.set(true);
  const moved = createIntegration({ platform: 'win32', launch: { ...launch, executable: 'C:\\Moved.exe' }, run: registry.run });
  registry.failOnce(args => args[0] === 'add' && args[1] === `${REGISTRY_KEYS[1].key}\\command`);
  await assert.rejects(moved.set(true));
  assert.equal((await original.status()).installed, true);
});

test('macOS install, relocation detection and uninstall stay within an isolated user Services directory', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-service-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const macLaunch = { executable: '/Applications/Brclio 工具箱.app/Contents/MacOS/Brclio 工具箱', packaged: true };
  const calls = [];
  const integration = createIntegration({ platform: 'darwin', home, launch: macLaunch, run: async (...args) => { calls.push(args); return { stdout: '' }; } });
  assert.equal((await integration.status()).installed, false);
  const installed = await integration.set(true);
  assert.equal(installed.installed, true);
  const moved = createIntegration({ platform: 'darwin', home, launch: { ...macLaunch, executable: '/Applications/Moved.app/Contents/MacOS/Moved' }, run: async () => ({ stdout: '' }) });
  assert.equal((await moved.status()).stale, true);
  assert.equal((await moved.set(true)).installed, true);
  const sentinel = path.join(home, 'Library', 'Services', 'Other.workflow');
  await fs.writeFile(sentinel, 'keep');
  await moved.set(false);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep');
  assert.ok(calls.every(call => call[0] === '/usr/bin/osascript'));
});

test('macOS preserves unowned workflows', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-collision-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const integration = createIntegration({ platform: 'darwin', home, launch, run: async () => ({ stdout: '' }) });
  const location = (await integration.status()).location;
  await fs.mkdir(location, { recursive: true });
  await fs.writeFile(path.join(location, 'keep.txt'), 'keep');
  await assert.rejects(integration.set(true), /不属于 Brclio/);
  await assert.rejects(integration.set(false), /不属于 Brclio/);
  assert.equal(await fs.readFile(path.join(location, 'keep.txt'), 'utf8'), 'keep');
});

test('macOS workflow is valid and passes a selected filename literally through the real Automator runtime', { skip: process.platform !== 'darwin', timeout: 20000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-automator-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const helper = path.join(directory, "helper ' 中文");
  const output = path.join(directory, 'args.txt');
  await fs.writeFile(helper, `#!/bin/sh\nprintf '%s\\n' "$@" > ${shellArgument(output)}\n`, { mode: 0o700 });
  const generated = macWorkflow({ executable: helper, packaged: true });
  const bundle = path.join(directory, 'Test.workflow', 'Contents');
  await fs.mkdir(bundle, { recursive: true });
  await fs.writeFile(path.join(bundle, 'document.wflow'), generated.document);
  await fs.writeFile(path.join(bundle, 'Info.plist'), generated.info);
  const input = path.join(directory, '你好 & $(bad).txt');
  await fs.writeFile(input, 'test');
  await promisify(execFile)('/usr/bin/plutil', ['-lint', path.join(bundle, 'document.wflow'), path.join(bundle, 'Info.plist')]);
  await promisify(execFile)('/usr/bin/automator', ['-i', input, path.dirname(bundle)], { timeout: 15000 });
  assert.deepEqual((await fs.readFile(output, 'utf8')).trimEnd().split('\n'), ['--copy-path', '--', input]);
});

test('settings survive relaunches and concurrent saves atomically', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-settings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createSettingsStore(directory);
  assert.equal((await store.read()).pathMode, 'absolute');
  await Promise.all([store.write({ quoteMode: 'single' }), store.write({ quoteMode: 'double', pathMode: 'relative', basePath: '/work' })]);
  const relaunched = createSettingsStore(directory);
  assert.equal((await relaunched.read()).quoteMode, 'double');
  assert.equal((await relaunched.read()).basePath, '/work');
  assert.deepEqual((await fs.readdir(directory)), ['settings.json']);
});

test('a damaged settings file is retained for recovery', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-damaged-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createSettingsStore(directory);
  await fs.writeFile(store.filename, '{ invalid');
  assert.equal((await store.read()).pathMode, 'absolute');
  assert.ok((await fs.readdir(directory)).some(name => name.startsWith('settings.json.corrupt-')));
});

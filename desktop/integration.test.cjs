'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createIntegration, macWorkflow, windowsEntries, OWNER, WORKFLOW_NAME, REGISTRY_KEYS } = require('./integration.cjs');
const { registrations, IDENTIFIER, BUNDLE_NAME } = require('./finder-extension.cjs');
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

function finderMock({ approve = true, ignoreErrorCode } = {}) {
  const entries = new Map();
  const calls = [];
  let current;
  async function run(executable, args) {
    calls.push({ executable, args });
    if (executable === '/usr/bin/osascript') return { stdout: '' };
    assert.equal(executable, '/usr/bin/pluginkit', 'tests must never execute host integration tools');
    if (args[0] === '-m') return { stdout: [...entries].map(([location, entry]) => `${entry.election} ${IDENTIFIER}(${entry.version})\tUUID\t2026-10-07\t${location}`).join('\n') };
    if (args[0] === '-a') {
      current = args[1];
      entries.set(current, { version: '0.1.2', election: ' ' });
    } else if (args[0] === '-e') {
      assert.deepEqual(args.slice(2), ['-i', IDENTIFIER]);
      if (args[1] === 'ignore' && ignoreErrorCode !== undefined) throw Object.assign(new Error('Mock pluginkit ignore failed'), { code: ignoreErrorCode });
      for (const [location, entry] of entries) entry.election = args[1] === 'use' && location === current && approve ? '+' : '-';
    } else assert.fail(`Unexpected pluginkit arguments: ${args}`);
    return { stdout: '' };
  }
  return { entries, calls, run };
}

async function macFixture(t, { available = true, approve = true, ignoreErrorCode } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-finder-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const application = path.join(home, '应用 Brclio.app');
  const launch = { executable: path.join(application, 'Contents', 'MacOS', 'Brclio'), packaged: true };
  const location = path.join(application, 'Contents', 'PlugIns', BUNDLE_NAME);
  if (available) await fs.mkdir(location, { recursive: true });
  const mock = finderMock({ approve, ignoreErrorCode });
  const integration = createIntegration({ platform: 'darwin', home, launch, run: mock.run });
  const legacy = path.join(home, 'Library', 'Services', WORKFLOW_NAME);
  async function createLegacy(owner) {
    await fs.mkdir(path.join(legacy, 'Contents'), { recursive: true });
    await fs.writeFile(path.join(legacy, 'Contents', 'keep.txt'), 'legacy sentinel');
    if (owner !== undefined) await fs.writeFile(path.join(legacy, 'Contents', 'brclio-owner.json'), JSON.stringify({ owner }));
  }
  return { home, location, launch, legacy, mock, integration, createLegacy };
}

test('Finder registrations distinguish use, ignore, default, and unrelated bundle locations', () => {
  assert.deepEqual(registrations([
    `+ ${IDENTIFIER}(0.1.2)\tUUID\tdate\t/Applications/Brclio.app/Contents/PlugIns/${BUNDLE_NAME}`,
    `- ${IDENTIFIER}(0.1.1)\tUUID\tdate\t/tmp/old app/${BUNDLE_NAME}`,
    `  ${IDENTIFIER}(0.1.2)\tUUID\tdate\t/tmp/default/${BUNDLE_NAME}`,
    '+ com.other.finder(1.0)\tUUID\tdate\t/tmp/other.appex',
    `+ ${IDENTIFIER}(0.1.2)`,
  ].join('\r\n')), [
    { election: '+', version: '0.1.2', location: `/Applications/Brclio.app/Contents/PlugIns/${BUNDLE_NAME}` },
    { election: '-', version: '0.1.1', location: `/tmp/old app/${BUNDLE_NAME}` },
    { election: ' ', version: '0.1.2', location: `/tmp/default/${BUNDLE_NAME}` },
  ]);
});

test('macOS registers the exact containing Finder bundle, verifies election, and disables it', async t => {
  const { integration, location, mock } = await macFixture(t);
  const before = await integration.status();
  assert.equal(before.available, true);
  assert.equal(before.registered, false);
  assert.equal(before.installed, false);
  const installed = await integration.set(true);
  assert.equal(installed.kind, 'finder-extension');
  assert.equal(installed.registered, true);
  assert.equal(installed.installed, true);
  assert.equal(installed.awaitingApproval, false);
  assert.ok(mock.calls.some(call => JSON.stringify(call.args) === JSON.stringify(['-a', location])));
  assert.ok(mock.calls.some(call => JSON.stringify(call.args) === JSON.stringify(['-e', 'use', '-i', IDENTIFIER])));
  const disabled = await integration.set(false);
  assert.equal(disabled.installed, false);
  assert.equal(mock.entries.get(location).election, '-');
  assert.ok(mock.calls.some(call => JSON.stringify(call.args) === JSON.stringify(['-e', 'ignore', '-i', IDENTIFIER])));
  assert.ok(mock.calls.every(call => call.executable === '/usr/bin/pluginkit'));
});

test('macOS rejects enabling a missing Finder bundle without registering or deleting legacy files', async t => {
  const { integration, mock, legacy, createLegacy } = await macFixture(t, { available: false });
  await createLegacy(OWNER);
  const status = await integration.status();
  assert.equal(status.available, false);
  assert.equal(status.requiresInstall, true);
  assert.equal(status.legacyServiceInstalled, true);
  await assert.rejects(integration.set(true), /请先安装/);
  assert.equal(mock.calls.length, 0);
  assert.equal(await fs.readFile(path.join(legacy, 'Contents', 'keep.txt'), 'utf8'), 'legacy sentinel');
});

test('macOS status does not accept an enabled Finder bundle at an old application location', async t => {
  const { integration, location, mock } = await macFixture(t);
  const old = path.join(path.dirname(location), 'old app', BUNDLE_NAME);
  mock.entries.set(old, { version: '0.1.1', election: '+' });
  const before = await integration.status();
  assert.equal(before.installed, false);
  assert.equal(before.stale, true);
  assert.equal(before.registered, false);
  assert.equal((await integration.set(true)).installed, true);
  assert.equal(mock.entries.get(location).election, '+');
});

test('macOS disabling an unregistered Finder extension tolerates pluginkit code 1 and removes owned Services', async t => {
  const { integration, legacy, createLegacy, mock } = await macFixture(t, { available: false, ignoreErrorCode: 1 });
  await createLegacy(OWNER);
  const status = await integration.set(false);
  assert.equal(status.installed, false);
  assert.equal(status.available, false);
  assert.equal(status.legacyServiceInstalled, false);
  await assert.rejects(fs.stat(legacy), { code: 'ENOENT' });
  assert.ok(mock.calls.some(call => JSON.stringify(call.args) === JSON.stringify(['-e', 'ignore', '-i', IDENTIFIER])));
});

test('macOS disabling Finder integration surfaces other pluginkit failures and preserves legacy Services', async t => {
  const { integration, legacy, createLegacy } = await macFixture(t, { ignoreErrorCode: 5 });
  await createLegacy(OWNER);
  await assert.rejects(integration.set(false), { code: 5 });
  assert.equal(await fs.readFile(path.join(legacy, 'Contents', 'keep.txt'), 'utf8'), 'legacy sentinel');
});

test('macOS preserves owned Services until Finder election is confirmed, then removes only owned legacy files', async t => {
  const pending = await macFixture(t, { approve: false });
  await pending.createLegacy(OWNER);
  const waiting = await pending.integration.set(true);
  assert.equal(waiting.installed, false);
  assert.equal(waiting.registered, true);
  assert.equal(waiting.awaitingApproval, true);
  assert.equal(waiting.legacyServiceInstalled, true);
  assert.equal(await fs.readFile(path.join(pending.legacy, 'Contents', 'keep.txt'), 'utf8'), 'legacy sentinel');
  await pending.integration.set(false);
  await assert.rejects(fs.stat(pending.legacy), { code: 'ENOENT' });

  const enabled = await macFixture(t);
  await enabled.createLegacy(OWNER);
  const unrelated = path.join(enabled.home, 'Library', 'Services', 'Other.workflow');
  await fs.writeFile(unrelated, 'other sentinel');
  const status = await enabled.integration.set(true);
  assert.equal(status.installed, true);
  assert.equal(status.legacyServiceInstalled, false);
  await assert.rejects(fs.stat(enabled.legacy), { code: 'ENOENT' });
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'other sentinel');
  assert.equal(enabled.mock.calls.filter(call => call.executable === '/usr/bin/osascript').length, 1);
});

test('macOS enabling and disabling Finder integration preserves unowned same-name Services', async t => {
  for (const owner of [undefined, 'com.other.utility']) {
    const { integration, legacy, createLegacy, mock } = await macFixture(t);
    await createLegacy(owner);
    assert.equal((await integration.set(true)).installed, true);
    assert.equal((await integration.set(false)).installed, false);
    assert.equal(await fs.readFile(path.join(legacy, 'Contents', 'keep.txt'), 'utf8'), 'legacy sentinel');
    assert.ok(mock.calls.every(call => call.executable === '/usr/bin/pluginkit'));
  }
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

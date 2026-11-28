'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { connectProtocol } = require('./terminal/sftp-protocol.cjs');
const { createBrowser, startConnection } = require('./terminal/sftp-host.cjs');
const { prepareAskpass } = require('./terminal/sftp-askpass.cjs');

const id = 'brclio-sftp-fixture';
const daemon = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'OpenSSH', 'sftp-server.exe') :
  process.platform === 'darwin' ? '/usr/libexec/sftp-server' : '/usr/lib/openssh/sftp-server';

test('real SFTP subsystem browses, uploads, downloads and modifies only selected files', async t => {
  try { await fs.access(daemon); } catch { t.skip('OpenSSH server component unavailable'); return; }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-sftp-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const local = path.join(dir, 'local'), remote = path.join(dir, 'remote');
  await fs.mkdir(local); await fs.mkdir(remote);
  const data = randomBytes(235111);
  const filename = '项目 [01] $ & space.bin';
  await fs.writeFile(path.join(local, filename), data);
  const browser = createBrowser({
    chooseLocal: async () => local,
    start: () => connectProtocol(spawn(daemon, [], { cwd: remote, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })),
  });
  t.after(() => browser.close());
  const call = (op, args = {}) => browser.action(op, { id, ...args });
  assert.equal((await call('open')).entries.length, 0);
  const localList = await call('choose');
  assert.ok(localList.entries.some(item => item.name === filename && item.kind === 'file'));
  await assert.rejects(browser.action('list', { id: 'different-session', side: 'remote' }), /已结束/);
  const uploaded = await call('transfer', { side: 'local', name: filename });
  assert.equal(uploaded.entries[0].name, filename);
  assert.equal(uploaded.entries[0].size, data.length);
  assert.deepEqual(await fs.readFile(path.join(remote, filename)), data);
  await assert.rejects(call('transfer', { side: 'local', name: filename }), /已存在/);
  await assert.rejects(call('transfer', { side: 'remote', name: filename }), /已存在/);
  assert.equal((await call('mkdir', { side: 'remote', name: '数据' })).entries[0].name, '数据');
  assert.equal((await call('enter', { side: 'remote', name: '数据' })).entries.length, 0);
  await call('parent', { side: 'remote' });
  await call('rename', { side: 'remote', name: filename, newName: '下载.bin' });
  await call('transfer', { side: 'remote', name: '下载.bin' });
  assert.deepEqual(await fs.readFile(path.join(local, '下载.bin')), data);
  await fs.writeFile(path.join(local, 'race.bin'), 'preserve');
  await fs.writeFile(path.join(remote, 'race.bin'), 'other');
  await call('list', { side: 'remote' });
  await assert.rejects(call('transfer', { side: 'remote', name: 'race.bin' }));
  assert.equal(await fs.readFile(path.join(local, 'race.bin'), 'utf8'), 'preserve');
  await assert.rejects(call('mkdir', { side: 'remote', name: '../escape' }), /文件名无效/);
  await call('remove', { side: 'remote', name: '数据' });
  await call('remove', { side: 'remote', name: '下载.bin' });
  assert.equal((await call('parent', { side: 'local' })).dir, await fs.realpath(local));
  await call('close');
  await assert.rejects(call('list', { side: 'remote' }), /已结束/);
});

test('native credential helper is prepared from packaged source', { skip: !['darwin', 'win32'].includes(process.platform) }, async () => {
  const helper = await prepareAskpass();
  try { await fs.access(helper.file, fs.constants.X_OK); }
  finally { await helper.cleanup(); }
  await assert.rejects(fs.access(helper.file));
});

test('real SSH exchanges prompted private key passphrase and host fingerprint, rejects changed host key', { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-sftp-ssh-'));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  const hostKey = path.join(d, 'host'), key = path.join(d, 'id'), known = path.join(d, 'known');
  for (const file of [hostKey, key]) execFileSync('/usr/bin/ssh-keygen', ['-q', '-N', file === key ? 'fixture-passphrase' : '', '-t', 'ed25519', '-f', file]);
  const bound = net.createServer();
  bound.listen(0, '127.0.0.1'); await once(bound, 'listening');
  const port = bound.address().port;
  await new Promise(resolve => bound.close(resolve));
  const serverConfig = path.join(d, 'sshd_config');
  const clientConfig = path.join(d, 'ssh_config');
  const sshQuote = value => '"' + value.replace(/["\\]/g, '\\$&') + '"';
  await fs.writeFile(serverConfig, [
    'Port ' + port, 'ListenAddress 127.0.0.1', 'HostKey ' + sshQuote(hostKey), 'PidFile ' + sshQuote(path.join(d, 'sshd.pid')),
    'UsePAM no', 'AuthorizedKeysFile ' + sshQuote(key + '.pub'), 'StrictModes no', 'PasswordAuthentication no',
    'KbdInteractiveAuthentication no', 'Subsystem sftp internal-sftp -d ' + sshQuote(d), 'LogLevel ERROR',
  ].join('\n') + '\n');
  await fs.writeFile(clientConfig, ['Host fixture', 'HostName 127.0.0.1', 'Port ' + port, 'User ' + os.userInfo().username,
    'GlobalKnownHostsFile /dev/null', 'UserKnownHostsFile ' + sshQuote(known), 'IdentityFile ' + sshQuote(key), 'IdentitiesOnly yes',
    'IdentityAgent none'].join('\n') + '\n');
  const server = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', serverConfig], { stdio: 'ignore' });
  const closed = once(server, 'close');
  t.after(async () => { server.kill(); await closed; });
  let ready = false;
  for (let n = 0; n < 80 && !ready; n++) {
    const socket = net.connect(port, '127.0.0.1');
    try { await once(socket, 'connect'); ready = true; } catch { await new Promise(resolve => setTimeout(resolve, 25)); }
    finally { socket.destroy(); }
  }
  assert.ok(ready, 'isolated sshd is listening');
  const helper = path.join(d, 'askpass');
  const prompts = path.join(d, 'prompts');
  const shQuote = v => "'" + v.replaceAll("'", "'\\''") + "'";
  await fs.writeFile(helper, ['#!/bin/sh', 'case "$1" in', '*yes/no*) echo host >> ' + shQuote(prompts) + '; echo yes;;',
    '*passphrase*) echo key >> ' + shQuote(prompts) + '; echo fixture-passphrase;;', '*) exit 1;;', 'esac'].join('\n') + '\n', { mode: 0o700 });
  const options = { configFile: clientConfig, askpass: async () => ({ file: helper, cleanup() {} }) };
  const protocol = await startConnection({ host: 'fixture' }, options);
  try { await protocol.ready; assert.ok((await protocol.list('.')).some(entry => entry.name === 'ssh_config')); }
  finally { protocol.stop(); }
  const output = await fs.readFile(prompts, 'utf8');
  assert.match(output, /host/); assert.match(output, /key/);
  const fake = (await fs.readFile(key + '.pub', 'utf8')).trim().split(' ').slice(0, 2).join(' ');
  await fs.writeFile(known, '[127.0.0.1]:' + port + ' ' + fake + '\n');
  const rejected = await startConnection({ host: 'fixture' }, options);
  try { await assert.rejects(rejected.ready, /CHANGED|verification failed/i); } finally { rejected.stop(); }
});

test('two independent SFTP servers transfer nested directories and never overwrite existing entries', async t => {
  try { await fs.access(daemon); } catch { t.skip('OpenSSH server component unavailable'); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-two-sftp-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const remoteA = path.join(root, 'server-a'), remoteB = path.join(root, 'server-b'), local = path.join(root, 'local');
  await Promise.all([remoteA, remoteB, local].map(dir => fs.mkdir(dir)));
  const label = '两端 [files]';
  const src = path.join(remoteA, label);
  await fs.mkdir(path.join(src, 'assets', 'empty'), { recursive: true });
  const bytes = randomBytes(100003);
  await fs.writeFile(path.join(src, 'assets', 'binary'), bytes);
  await fs.writeFile(path.join(src, '.hidden'), 'dot');
  const service = createBrowser({
    chooseLocal: () => local,
    start: dest => connectProtocol(spawn(daemon, [], { cwd: dest.host === 'first' ? remoteA : remoteB, windowsHide: true })),
  });
  t.after(() => service.close());
  const call = (op, args = {}) => service.action(op, { id, ...args });
  await call('open', { target: { host: 'first' } });
  await call('connect', { side: 'local', target: { host: 'second' } });
  async function contents(base) {
    assert.deepEqual(await fs.readFile(path.join(base, label, 'assets', 'binary')), bytes);
    assert.deepEqual(await fs.readdir(path.join(base, label, 'assets', 'empty')), []);
    assert.equal(await fs.readFile(path.join(base, label, '.hidden'), 'utf8'), 'dot');
  }
  await call('transfer', { side: 'remote', name: label });
  await contents(remoteB);
  await assert.rejects(call('transfer', { side: 'remote', name: label }), /已存在/);
  await call('choose', { side: 'remote' });
  await call('transfer', { side: 'local', name: label });
  await contents(local);
  await assert.rejects(call('goto', { side: 'remote', path: root }), /根目录/);
  const listed = await call('goto', { side: 'remote', path: path.join(local, label, 'assets') });
  assert.ok(listed.entries.some(item => item.name === 'binary'));
  await call('goto', { side: 'remote', path: local });
  await call('rename', { side: 'local', name: label, newName: 'saved' });
  await call('transfer', { side: 'remote', name: label });
  await contents(remoteB);
  if (process.platform !== 'win32') {
    await fs.symlink(root, path.join(src, 'linked-root'));
    await call('connect', { side: 'remote', target: { host: 'first' } });
    await call('rename', { side: 'local', name: label, newName: 'previous' });
    await assert.rejects(call('transfer', { side: 'remote', name: label }), /链接/);
    assert.deepEqual((await fs.readdir(remoteB)).sort(), ['previous', 'saved']);
  }
});

test('canceling a real inter-server transfer removes partial data and leaves both browsers usable', async t => {
  try { await fs.access(daemon); } catch { t.skip('OpenSSH server component unavailable'); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-sftp-cancel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'src'), destination = path.join(root, 'dest');
  await fs.mkdir(source); await fs.mkdir(destination);
  await fs.mkdir(path.join(source, 'tree'));
  await fs.writeFile(path.join(source, 'tree', 'large'), randomBytes(100000));
  let signal, resume;
  const writing = new Promise(resolve => { signal = resolve; });
  const proceed = new Promise(resolve => { resume = resolve; });
  const service = createBrowser({ start: dest => {
    const client = connectProtocol(spawn(daemon, [], {cwd: dest.host === 'first' ? source : destination, windowsHide: true}));
    if (dest.host !== 'first') {
      const original = client.withFile;
      client.withFile = (file, mode, fn) => original(file, mode, writer => fn({
        async write(...args) {
          const result = await writer.write(...args);
          signal(); await proceed;
          return result;
        },
      }));
    }
    return client;
  } });
  t.after(() => { resume(); service.close(); });
  const call = (op, args = {}) => service.action(op, {id, ...args});
  await call('open', { target: { host: 'first' } });
  await call('connect', { side: 'local', target: { host: 'second' } });
  const copying = call('transfer', { side: 'remote', name: 'tree' });
  await writing;
  assert.equal((await call('progress')).size, 100000);
  assert.equal((await call('progress')).current, 'tree/large');
  await call('cancel');
  resume();
  await assert.rejects(copying, /取消/);
  assert.deepEqual(await fs.readdir(destination), []);
  assert.ok((await call('list', {side: 'remote'})).entries.some(item => item.name === 'tree'));
  assert.deepEqual((await call('list', {side: 'local'})).entries, []);
});

test('external editor changes require confirmation, reject stale remote versions, retain file mode, and remove local drafts', async t => {
  try { await fs.access(daemon); } catch { t.skip('OpenSSH server component unavailable'); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-sftp-editor-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'note.txt');
  await fs.writeFile(remote, 'original', { mode: 0o640 });
  const originalMode = (await fs.stat(remote)).mode & 0o777;
  let edited, chosen;
  const service = createBrowser({
    start: () => connectProtocol(spawn(daemon, [], { cwd: root, windowsHide: true })),
    chooseEditor: async () => 'fixture-editor', launchEditor: (file, application) => { edited = file; chosen = application; },
  });
  t.after(() => service.close());
  const call = (op, args = {}) => service.action(op, { id, ...args });
  await call('open');
  await call('edit-file', { side: 'remote', name: 'note.txt', choose: true });
  assert.equal(chosen, 'fixture-editor');
  assert.equal(await call('edit-status'), false);
  await fs.writeFile(edited, 'revised');
  assert.ok(await call('edit-status'));
  assert.equal(await fs.readFile(remote, 'utf8'), 'original');
  assert.ok(await call('edit-save'));
  assert.equal(await fs.readFile(remote, 'utf8'), 'revised');
  assert.equal((await fs.stat(remote)).mode & 0o777, originalMode);
  await assert.rejects(fs.access(edited));
  chosen = null;
  await call('edit-file', { side: 'remote', name: 'note.txt' });
  assert.equal(chosen, 'fixture-editor');
  await fs.writeFile(edited, 'local draft');
  await fs.writeFile(remote, 'concurrent remote revision');
  await assert.rejects(call('edit-save'), /其他程序修改/);
  assert.equal(await fs.readFile(remote, 'utf8'), 'concurrent remote revision');
  assert.equal(await fs.readFile(edited, 'utf8'), 'local draft');
  await call('edit-discard');
  assert.deepEqual(await fs.readdir(root), ['note.txt']);
  await assert.rejects(fs.access(edited));
});

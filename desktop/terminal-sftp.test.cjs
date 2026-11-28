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

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { endpoint, store } = require('./terminal/connection.js');
const openSSH = require('./terminal/remote-launch.cjs');
const { createPtySessions } = require('./terminal/pty.cjs');

test('SSH uses native argv and both clients inherit unspecified OpenSSH configuration', () => {
  assert.deepEqual(openSSH.argumentsFor('ssh', { host: 'build-host' }), ['-a', '--', 'build-host']);
  const value = { host: '[fe80::1%en0]', user: 'dev@example.org', port: 42817 };
  assert.deepEqual(openSSH.argumentsFor('ssh', value), ['-a', '-p', '42817', '-l', 'dev@example.org', '--', 'fe80::1%en0']);
  assert.deepEqual(openSSH.argumentsFor('sftp', value), ['-P', '42817', '-o', 'User=dev@example.org', '--', '[fe80::1%en0]']);
  assert.deepEqual(openSSH.argumentsFor('sftp', { host: 'dev' }), ['--', 'dev']);
  for (const host of ['-o', 'name:/path', 'user@name', 'bad host', 'host/dir', 'label;next', '\n-x', 'abc::::1']) {
    assert.throws(() => openSSH.argumentsFor('ssh', { host }));
  }
  for (const value of [{ user: 'name\nother' }, { user: '-o' }, { port: 0 }, { port: '22x' }, { port: 65536 }]) {
    assert.throws(() => endpoint({ host: 'sample', ...value }));
  }
});

test('named connections retain only host, user and port without shell, key or password material', () => {
  const memory = new Map();
  const storage = store({ getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) });
  storage.save({ name: '  开发机 ', host: 'dev-alias', password: 'not-saved', keyFile: '/private/key', command: 'arbitrary' });
  assert.deepEqual(storage.all(), [{ name: '开发机', host: 'dev-alias', user: '', port: null }]);
  storage.save({ name: '开发机', host: 'other', user: 'me', port: '22' });
  assert.deepEqual(storage.all(), [{ name: '开发机', host: 'other', user: 'me', port: 22 }]);
  storage.remove('开发机');
  assert.deepEqual(storage.all(), []);
});

test('a remote tab starts the system client directly with its own local PTY', t => {
  const home = os.tmpdir();
  const calls = [];
  const noOp = () => ({ dispose() {} });
  const sessions = createPtySessions({ home, send() {}, load: () => ({
    spawn(file, args, options) {
      calls.push({ file, args, options });
      return { pid: 123, onData: noOp, onExit: noOp, kill() {} };
    },
  }) });
  for (const kind of ['ssh', 'sftp']) {
    const file = openSSH.program(kind);
    const id = randomUUID();
    if (!file) {
      assert.throws(() => sessions.create({ id, profile: kind, connection: { host: 'workstation' } }), /OpenSSH/);
      continue;
    }
    const info = sessions.create({ id, profile: kind, connection: { host: 'workstation' }, shellIntegration: true });
    assert.equal(info.shell, file);
    const { file: executable, args, options } = calls.at(-1);
    assert.equal(executable, file);
    assert.deepEqual(args, kind === 'ssh' ? ['-a', '--', 'workstation'] : ['--', 'workstation']);
    assert.equal(options.cwd, home);
    assert.equal(options.env.TERM_PROGRAM, 'Brclio');
    assert.equal(options.env.SSH_AUTH_SOCK, process.env.SSH_AUTH_SOCK);
    if (process.platform !== 'win32') assert.notEqual(options.env.SHELL, file);
  }
  t.after(() => sessions.closeAll());
});

test('installed system SSH and SFTP clients connect to a loopback SSH configuration alias', { timeout: 20000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-ssh-client-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const received = [];
  const server = net.createServer(socket => {
    let line = '';
    socket.setTimeout(4000, () => socket.destroy());
    socket.on('error', () => {});
    socket.write('SSH-2.0-BrclioTest\r\n');
    socket.on('data', chunk => {
      line += chunk.toString('ascii');
      if (!line.includes('\n')) return;
      received.push(line.slice(0, line.indexOf('\n')).trim());
      // Stop at the protocol banner, before host keys or authentication.
      socket.destroy();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = path.join(directory, 'config');
  await fs.writeFile(config, [
    'Host brclio-loopback-fixture', '  HostName 127.0.0.1', '  User test',
    '  Port ' + server.address().port, '  ConnectTimeout 3', '  BatchMode yes', '',
  ].join('\n'));
  for (const kind of ['ssh', 'sftp']) {
    const client = openSSH.program(kind);
    if (!client) { t.diagnostic(kind + ' is not installed'); continue; }
    const count = received.length;
    await assert.rejects(promisify(execFile)(client, ['-F', config, ...openSSH.argumentsFor(kind, { host: 'brclio-loopback-fixture' })],
      { timeout: 6000, windowsHide: true }));
    assert.equal(received.length, count + 1, kind + ' reached the configured loopback endpoint');
    assert.match(received.at(-1), /^SSH-2\.0-OpenSSH/);
  }
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const model = require('./terminal/forward-model.js');
const { program, argumentsFor } = require('./terminal/remote-launch.cjs');
const { createPtySessions } = require('./terminal/pty.cjs');
const run = promisify(execFile);

const value = { name: 'Database', type: 'local', listenPort: 18818, destinationHost: '::1', destinationPort: 3306, connection: { host: 'build-box' } };

test('forward rules preserve destinations and validate before passing separate native arguments', async () => {
  const item = model.rule({ ...value, connection: { ...value.connection, jump: 'gateway', password: 'discard', executable: 'discard' } });
  assert.deepEqual(item.connection, { host: 'build-box', user: '', port: null, jump: 'gateway' });
  assert.equal(item.listenHost, '127.0.0.1');
  for (const [type, switchName, spec] of [
    ['local', '-L', '127.0.0.1:18818:[::1]:3306'], ['remote', '-R', '127.0.0.1:18818:[::1]:3306'],
    ['dynamic', '-D', '127.0.0.1:18818'],
  ]) {
    const args = model.argumentsFor({ ...value, type });
    assert.equal(args[args.indexOf(switchName) + 1], spec);
    assert.deepEqual(args.slice(-2), ['--','build-box']);
    if (program('ssh')) {
      const config = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-forward-options-'));
      try {
        const empty = path.join(config, 'config');
        await fs.writeFile(empty, '');
        const { stdout } = await run(program('ssh'), ['-F', empty, '-G', ...args], { timeout: 3000, windowsHide: true });
        assert.match(stdout, /exitonforwardfailure (?:yes|true)/i);
      } finally { await fs.rm(config, { recursive: true, force: true }); }
    }
  }
  for (const change of [{ listenHost: '*:12' }, { listenPort: '22:42' }, { destinationHost: '-oBad' }, { destinationPort: 0 },
    { type: '' }, { type: 'exec' }, { name: '\u202Ebad' }]) assert.throws(() => model.rule({ ...value, ...change }));
});

test('saved forwarding templates validate imports before replacing and keep secrets out of storage', () => {
  const memory = new Map();
  const recipes = model.store({ getItem: key => memory.get(key), setItem: (key,v) => memory.set(key,v) });
  recipes.save(value);
  assert.throws(() => recipes.save(value));
  assert.throws(() => recipes.replace([value, value]));
  assert.throws(() => recipes.replace([value, { ...value, type: 'unknown' }]));
  assert.equal(recipes.all().length, 1);
  recipes.save({ ...value, name: 'Other' }, value.name);
  assert.equal(recipes.all()[0].name, 'Other');
  recipes.replace([{ ...value, type: 'dynamic', connection: { host: 'example', password: 'secret' } }]);
  assert.equal(recipes.all()[0].destinationHost, undefined);
  assert.doesNotMatch([...memory.values()].join(''), /secret/);
  recipes.remove(value.name);
  assert.deepEqual(recipes.all(), []);
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function freePort() {
  const s = net.createServer();
  const port = await listen(s);
  await new Promise(resolve => s.close(resolve));
  return port;
}

async function connect(port) {
  const socket = net.connect({ host: '127.0.0.1', port });
  await once(socket, 'connect');
  return socket;
}

async function waitForPort(port, wanted) {
  const until = Date.now() + 5000;
  do {
    try {
      const listener = await connect(port);
      listener.destroy();
      if (wanted) return;
    } catch (error) { if (!wanted && error.code === 'ECONNREFUSED') return; }
    await delay(35);
  } while (Date.now() < until);
  assert.fail('Forwarding port did not reach its expected state.');
}

async function bytes(socket, count) {
  for (;;) {
    const data = socket.read(count);
    if (data) return data;
    if (socket.readableEnded || socket.destroyed) throw new Error('Unexpected socket closure');
    await Promise.race([
      once(socket, 'readable'), once(socket, 'end').then(() => { throw new Error('Unexpected end'); }),
    ]);
  }
}

test('native PTYs forward real loopback traffic through local, remote and dynamic SSH and release each port when closed',
  { skip: process.platform !== 'darwin', timeout: 35000 }, async t => {
    try { await fs.access('/usr/sbin/sshd'); } catch { return t.skip('Local OpenSSH server unavailable'); }
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-forward-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const hostKey = path.join(directory, 'host-key');
    const userKey = path.join(directory, 'user-key');
    const ca = path.join(directory, 'temporary-ca');
    const principalKey = path.join(directory, 'temporary-principal');
    for (const key of [hostKey,userKey,ca,principalKey]) await run('ssh-keygen', ['-q','-t','ed25519','-N','','-f', key]);
    const port = await freePort();
    const serverConfig = path.join(directory, 'sshd.conf');
    await fs.writeFile(serverConfig, [
      'ListenAddress 127.0.0.1', 'Port ' + port, 'HostKey "' + hostKey + '"', 'AuthorizedKeysFile "' + userKey + '.pub"',
      'AcceptEnv BRCLIO_LITERAL_FIXTURE',
      'TrustedUserCAKeys "' + ca + '.pub"', 'PidFile "' + path.join(directory, 'pid') + '"', 'UsePAM no', 'StrictModes no', 'PasswordAuthentication no', 'AllowTcpForwarding yes', '',
    ].join('\n'));
    const daemon = spawn('/usr/sbin/sshd', ['-D','-e','-f',serverConfig], { stdio: 'ignore' });
    t.after(() => { daemon.kill(); });
    await waitForPort(port, true);
    const known = path.join(directory, 'known_hosts');
    await fs.writeFile(known, '[127.0.0.1]:' + port + ' ' + await fs.readFile(hostKey + '.pub','utf8'));
    const config = path.join(directory, 'ssh.conf');
    await fs.writeFile(config, ['Host *', ' BatchMode yes', ' StrictHostKeyChecking yes', ' IdentitiesOnly yes',
      ' GlobalKnownHostsFile none', ' UserKnownHostsFile "' + known + '"', ' IdentityAgent none', ''].join('\n'));
    await run('ssh-keygen', ['-q','-s',ca,'-I','localhost-only-fixture','-n',os.userInfo().username,principalKey + '.pub']);
    const certificateFile = path.join(directory, 'selected "user" certificate.pub');
    await fs.rename(principalKey + '-cert.pub', certificateFile);
    const { verifyCertificate } = require('./terminal/identity-host.cjs');
    await verifyCertificate(certificateFile);
    await assert.rejects(verifyCertificate(principalKey + '.pub'), /用户证书/);
    const address = { host: '127.0.0.1', user: os.userInfo().username, port, identityFile: principalKey };
    const agentSocket = path.join(directory, 'agent');
    const agent = spawn('/usr/bin/ssh-agent', ['-D', '-a',agentSocket], { stdio:'ignore' });
    t.after(() => { agent.kill(); });
    const agentReady = Date.now() + 3000;
    while (!(await fs.stat(agentSocket).catch(() => null))?.isSocket()) {
      if (Date.now() >= agentReady) assert.fail('Temporary ssh-agent failed to start');
      await delay(25);
    }
    const command = (target, script) => run(program('ssh'), ['-F',config,'-o','IdentityAgent=SSH_AUTH_SOCK', ...argumentsFor('ssh',target),script], {
      env: { ...process.env, SSH_AUTH_SOCK: agentSocket }, timeout: 5000,
    });
    await assert.rejects(command(address, 'true'), /Permission denied/);
    await command({ ...address, certificateFile }, 'test -z "$SSH_AUTH_SOCK"');
    await command({ ...address, certificateFile, agentForwarding: true }, 'test -S "$SSH_AUTH_SOCK"');
    const file = program('ssh');
    const env = { ...process.env };
    const literal = 'host %h ${HOME} "$HOME" # literal';
    const withEnvironment = { ...address, certificateFile, environment: [{ name: 'BRCLIO_LITERAL_FIXTURE', value: literal }] };
    const args = argumentsFor('ssh', withEnvironment, true, { file, env });
    const delivered = await run(file, ['-F', config, ...args, 'printenv BRCLIO_LITERAL_FIXTURE'], { env, timeout: 5000 });
    assert.equal(delivered.stdout.trimEnd(), literal);

    const echo = net.createServer(socket => { socket.on('error', () => {}); socket.pipe(socket); });
    const echoPort = await listen(echo);
    t.after(() => new Promise(resolve => echo.close(resolve)));
    const driver = require('node-pty');
    const sessions = createPtySessions({ home: directory, send() {}, load: () => ({
      spawn(file, args, options) { return driver.spawn(file, ['-F', config, ...args], options); },
    }) });
    t.after(() => sessions.closeAll());
    for (const type of ['local', 'remote', 'dynamic']) {
      const id = randomUUID();
      const listenPort = await freePort();
      const item = { ...value, type, listenPort, destinationHost: '127.0.0.1', destinationPort: echoPort,
        connection: { host: '127.0.0.1', port, user: os.userInfo().username, identityFile: userKey } };
      sessions.create({ id, profile: 'ssh-forward', connection: item });
      let socket;
      try {
        await waitForPort(listenPort, true);
        socket = await connect(listenPort);
        socket.setTimeout(2500, () => socket.destroy(new Error('Timed out waiting for forwarded data')));
        if (type === 'dynamic') {
          socket.write(Buffer.from([5, 1, 0]));
          assert.deepEqual(await bytes(socket, 2), Buffer.from([5, 0]));
          socket.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, echoPort >> 8, echoPort & 255]));
          const response = await bytes(socket, 10);
          assert.equal(response[1], 0);
        }
        const data = Buffer.from('private-loopback-' + type);
        socket.write(data);
        assert.deepEqual(await bytes(socket, data.length), data);
      } finally { socket?.destroy(); sessions.close(id); }
      await waitForPort(listenPort, false);
    }
  });

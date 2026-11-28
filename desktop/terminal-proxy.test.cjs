'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { argumentsFor, program } = require('./terminal/remote-launch.cjs');
const { endpoint } = require('./terminal/connection.js');
const { tunnel } = require('./terminal/ssh-proxy-client.cjs');

async function fixture(t, onConnect) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    onConnect(socket);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { for (const s of sockets) s.destroy(); server.close(); });
  return server.address().port;
}

for (const kind of ['ssh', 'sftp']) for (const protocol of ['http', 'socks5']) {
  test(kind + ' via ' + protocol + ' uses the actual system client and only the resolved target', {timeout: 15000}, async t => {
    const bin = program(kind);
    if (!bin) { t.skip('OpenSSH unavailable'); return; }
    let destination, sendGreeting = false, clientBanner = '';
    const port = await fixture(t, socket => {
      let state = protocol === 'http' ? 'http' : 'method';
      socket.on('data', data => {
        if (state === 'http') {
          destination = /^CONNECT ([^ ]+) HTTP\/1.1/.exec(data.toString())?.[1];
          socket.write('HTTP/1.1 200 OK\r\n\r\nSSH-2.0-Fixture\r\n');
          state = 'pass'; sendGreeting = true;
        } else if (state === 'method') {
          assert.deepEqual(data, Buffer.from([5, 1, 0]));
          socket.write(Buffer.from([5, 0])); state = 'connect';
        } else if (state === 'connect') {
          assert.deepEqual(data.subarray(0, 4), Buffer.from([5, 1, 0, 3]));
          destination = data.subarray(5, 5 + data[4]).toString() + ':' + data.readUInt16BE(5 + data[4]);
          socket.write(Buffer.concat([Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 22]), Buffer.from('SSH-2.0-Fixture\r\n')]));
          state = 'pass'; sendGreeting = true;
        } else {
          clientBanner += data.toString('latin1');
          if (clientBanner.includes('\n')) socket.end();
        }
      });
    });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-proxy-'));
    t.after(() => fs.rm(dir, {recursive:true,force:true}));
    const configFile = path.join(dir, 'config');
    await fs.writeFile(configFile, 'Host fixture\n  Hostname upstream.test\n  Port 2222\n');
    const env = { ...process.env };
    const args = argumentsFor(kind, {host: 'fixture', proxy: protocol + '://127.0.0.1:' + port}, kind === 'ssh',
      {file: bin, env, configFile});
    assert.ok(!args.join(' ').includes('upstream.test'));
    const child = spawn(bin, ['-F', configFile, '-o', 'BatchMode=yes', ...args], {env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide:true});
    t.after(() => child.kill());
    let err = '';
    child.stderr.on('data', text => { err = (err + text).slice(-3000); });
    await once(child, 'close');
    assert.equal(destination, 'upstream.test:2222', err);
    assert.ok(sendGreeting);
    assert.match(clientBanner, /^SSH-2.0-OpenSSH/i, err);
  });
}

test('HTTP rejection and invalid route data fail without direct fallback', async t => {
  const port = await fixture(t, socket => socket.once('data', () => socket.end('HTTP/1.1 407 Authentication Required\r\n\r\n')));
  await assert.rejects(tunnel({proxyHost:'127.0.0.1',proxyPort:port,host:'only.test',port:22,protocol:'http:'}), /拒绝/);
  for (const proxy of ['http://host/path', 'socks5://name:pass@host', 'https://host', 'http://bad;whoami', 'http://host:0']) {
    assert.throws(() => endpoint({host:'selected',proxy}));
  }
});

for (const protocol of ['http:', 'socks5:']) {
  test(protocol + ' authenticates with a one-session password only after selecting a user', async t => {
    const user = 'fixture', secret = 'synthetic-password';
    let state = protocol === 'http:' ? 'http' : 'method';
    const port = await fixture(t, socket => socket.on('data', data => {
      if (state === 'http') {
        assert.ok(data.toString().includes('Proxy-Authorization: Basic ' + Buffer.from(user + ':' + secret).toString('base64')));
        socket.write('HTTP/1.1 200 OK\r\n\r\n');
      } else if (state === 'method') {
        assert.deepEqual(data, Buffer.from([5,1,2])); state = 'auth';
        socket.write(Buffer.from([5,2]));
      } else if (state === 'auth') {
        assert.deepEqual(data, Buffer.concat([Buffer.from([1,user.length]),Buffer.from(user),Buffer.from([secret.length]),Buffer.from(secret)]));
        state = 'target'; socket.write(Buffer.from([1,0]));
      } else {
        assert.deepEqual(data.subarray(0,4), Buffer.from([5,1,0,4])); // IPv6 target
        socket.write(Buffer.from([5,0,0,1,0,0,0,0,0,22]));
      }
    }));
    const socket = await tunnel({protocol, proxyHost:'127.0.0.1', proxyPort:port, host:'::1', port:22, user}, () => secret);
    socket.destroy();
  });
}

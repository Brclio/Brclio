'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const os = require('node:os');
const { once } = require('node:events');
const { setTimeout } = require('node:timers/promises');
const { serialOptions } = require('./terminal/device-session.cjs');
const { createPtySessions } = require('./terminal/pty.cjs');

test('Telnet tab negotiates split frames, UTF-8 output, NAWS resize and NVT keyboard input against a loopback server', {timeout:10000}, async () => {
  const server = net.createServer();
  const onClient = once(server, 'connection');
  server.listen(0, '127.0.0.1');
  await once(server,'listening');
  let out = '', received = Buffer.alloc(0);
  const id = randomUUID();
  const sessions = createPtySessions({home:os.homedir(),send(type, payload) { if(type === 'data') out += payload.data; }});
  let client;
  async function until(check) {
    for(let i=0; i<150 && !check(); i++) await setTimeout(10);
    assert.ok(check());
  }
  try {
    sessions.create({id, profile:'telnet', connection:{host:'127.0.0.1',port:server.address().port},cols:80,rows:24});
    [client] = await onClient;
    client.on('data', bytes => { received = Buffer.concat([received, bytes]); });
    client.write(Buffer.from([255,251]));
    await setTimeout(10);
    client.write(Buffer.from([1,255,253,31,255,253,24,255,250,24,1,255,240]));
    const utf8 = Buffer.from('终端\r\u0000');
    client.write(utf8.subarray(0,1));
    await setTimeout(10);
    client.write(utf8.subarray(1));
    await until(() => out === '终端\r' && received.includes(Buffer.from('xterm-256color')));
    assert.ok(received.includes(Buffer.from([255,250,31,0,80,0,24,255,240])));
    sessions.resize(id,255,32);
    sessions.write(id,'check\r');
    await until(() => received.includes(Buffer.from('check\r\n')));
    assert.ok(received.includes(Buffer.from([255,250,31,0,255,255,0,32,255,240])));
    assert.equal(out,'终端\r');
  } finally { sessions.closeAll(); client?.destroy(); await new Promise(resolve => server.close(resolve)); }
});

test('serial settings allow only local serial device names on the selected OS', () => {
  assert.equal(serialOptions({device:'COM10', parity:'even'},'win32').baudRate,115200);
  assert.equal(serialOptions({device:'/dev/cu.usbserial-14', dataBits:7},'darwin').dataBits,7);
  for (const device of ['/dev/null', '/dev/tty.x/../../etc/passwd', 'COM1/..', 'C:\\test']) {
    for (const os of ['darwin','win32']) assert.throws(() => serialOptions({device},os));
  }
  assert.throws(() => serialOptions({device:'COM1',baudRate:0},'win32'));
});

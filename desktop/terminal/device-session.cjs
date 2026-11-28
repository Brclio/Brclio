'use strict';

const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const fs = require('node:fs');
const path = require('node:path');
const { endpoint } = require('./connection.js');

function serialOptions(input, platform) {
  const device = input?.device;
  const valid = platform === 'win32' ? /^COM[1-9]\d{0,4}$/i : /^\/dev\/(cu|tty)\.[\w.-]+$/;
  if (typeof device !== 'string' || !valid.test(device)) throw new Error('请选择有效的串口设备。');
  const { baudRate = 115200, dataBits = 8, stopBits = 1, parity = 'none', rtscts = false } = input;
  if (!Number.isSafeInteger(baudRate) || baudRate < 50 || baudRate > 4000000 ||
      ![5,6,7,8].includes(dataBits) || ![1,2].includes(stopBits) ||
      !['none','even','odd'].includes(parity) || typeof rtscts !== 'boolean') throw new Error('串口参数无效。');
  return { path: device, baudRate, dataBits, stopBits, parity, rtscts };
}
function binding() { return require('@serialport/bindings-cpp').autoDetect(); }
async function serialPorts() { return (await binding().list()).map(port => port.path); }
function serial(connection, platform, emit) {
  const options = serialOptions(connection, platform);
  const { SerialPortStream } = require('@serialport/stream');
  const stream = new SerialPortStream({ ...options, binding: binding() });
  stream.on('data', emit);
  return { stream, write: bytes => stream.write(bytes), resize() {},
    close() { if (stream.opening) stream.once('open', () => stream.close()); else if (stream.isOpen) stream.close(); } };
}
function streamSession(profile, connection, size, platform) {
  const events = new EventEmitter(), decoder = new StringDecoder('utf8');
  const emit = bytes => { const data = decoder.write(bytes); if (data) events.emit('data', data); };
  const device = profile === 'telnet' ? require('./telnet.cjs').telnet(connection, size, emit) : serial(connection, platform, emit);
  let ended = false;
  function finish(error) {
    if (ended) return;
    ended = true;
    const tail = decoder.end();
    if (tail) events.emit('data', tail);
    if (error) events.emit('data', '\r\n' + String(error.message).replace(/[\x00-\x1f\x7f]/g, ' ') + '\r\n');
    events.emit('exit', { exitCode: error ? 1 : 0 });
  }
  device.stream.once('error', finish);
  device.stream.once('close', () => finish());
  const on = (event, fn) => { events.on(event, fn); return { dispose: () => events.off(event, fn) }; };
  return { pid: 0, onData: fn => on('data', fn), onExit: fn => on('exit', fn),
    write(input) {
      if (device.stream.writableLength > 1024 * 1024) throw new Error('连接正在等待写入，请稍后重试。');
      device.write(input);
    }, resize: device.resize, kill: device.close,
    pause: () => device.stream.pause(), resume: () => device.stream.resume() };
}
function mosh(connection, platform, env) {
  const { host, user, port } = endpoint(connection);
  const windows = platform === 'win32';
  const file = windows ? path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe') :
    [...(env.PATH || '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].filter(dir => path.isAbsolute(dir))
      .map(dir => path.join(dir, 'mosh')).find(file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } });
  if (!file || (windows && !fs.existsSync(file))) throw new Error(windows ? '请先在默认 WSL 发行版安装 mosh。' : '请先安装 Mosh 客户端。');
  return { file, args: [...(windows ? ['--exec','mosh'] : []), ...(port ? ['--ssh=ssh -p ' + port] : []), '--', (user ? user + '@' : '') + host] };
}
module.exports = { serialPorts, serialOptions, streamSession, mosh };

'use strict';

const net = require('node:net');
const { endpoint } = require('./connection.js');

// Telnet commands and subnegotiations may span arbitrary TCP chunks (RFC 854).
const IAC = 255, WILL = 251, WONT = 252, DO = 253, DONT = 254, SB = 250, SE = 240;
const ECHO = 1, SGA = 3, TTYPE = 24, NAWS = 31;
function escape(bytes) {
  const out = [];
  for (const byte of bytes) { out.push(byte); if (byte === IAC) out.push(IAC); }
  return out;
}

function telnet(connection, size, emit) {
  const { host, port } = endpoint(connection);
  const socket = net.createConnection({ host, port: port || 23 });
  socket.setNoDelay(true);
  let state = 'text', command, sub = [], cr = false, overflow = false;
  const local = new Set(), remote = new Set();
  const send = bytes => { if (!socket.destroyed) socket.write(Buffer.from(bytes)); };
  function resize(cols, rows) {
    size = { cols, rows };
    if (local.has(NAWS)) send([IAC, SB, NAWS, ...escape([cols >> 8, cols & 255, rows >> 8, rows & 255]), IAC, SE]);
  }
  function option(option) {
    if (command === DO || command === WILL) {
      const ours = command === DO;
      const enabled = ours ? local : remote;
      if (!(ours ? [SGA, TTYPE, NAWS] : [SGA, ECHO]).includes(option)) send([IAC, ours ? WONT : DONT, option]);
      else if (!enabled.has(option)) {
        enabled.add(option);
        send([IAC, ours ? WILL : DO, option]);
        if (ours && option === NAWS) resize(size.cols, size.rows);
      }
    } else {
      const ours = command === DONT;
      if ((ours ? local : remote).delete(option)) send([IAC, ours ? WONT : DONT, option]);
    }
  }
  socket.on('data', bytes => {
    const text = [];
    for (const byte of bytes) {
      switch (state) {
        case 'text':
          if (byte === IAC) { state = 'command'; break; }
          if (!(cr && byte === 0)) text.push(byte);
          cr = byte === 13;
          break;
        case 'command':
          if (byte === SB) { sub = []; overflow = false; state = 'sub'; }
          else if ([WILL, WONT, DO, DONT].includes(byte)) { command = byte; state = 'option'; }
          else { if (byte === IAC) text.push(byte); state = 'text'; }
          break;
        case 'option': option(byte); state = 'text'; break;
        case 'sub':
          if (byte === IAC) state = 'sub-command';
          else if (sub.length < 64) sub.push(byte);
          else overflow = true;
          break;
        case 'sub-command':
          if (byte === SE) {
            if (!overflow && local.has(TTYPE) && sub.length === 2 && sub[0] === TTYPE && sub[1] === 1)
              send([IAC, SB, TTYPE, 0, ...Buffer.from('xterm-256color'), IAC, SE]);
            state = 'text';
          } else {
            if (byte === IAC && sub.length < 64) sub.push(byte);
            else overflow = true;
            state = 'sub';
          }
          break;
      }
    }
    if (text.length) emit(Buffer.from(text));
  });
  return { stream: socket, resize, close: () => socket.destroy(), write(input) {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input.replace(/\r\n|\r|\n/g, '\r\n'));
    if (!remote.has(ECHO) && !Buffer.isBuffer(input)) emit(bytes);
    send(escape(bytes));
  } };
}

module.exports = { telnet };

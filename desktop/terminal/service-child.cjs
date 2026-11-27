'use strict';

const { createPtySessions } = require('./pty.cjs');

// Only the parent that created this private IPC pipe can send requests.
const sessions = createPtySessions({ home: process.argv[2], send(channel, payload) {
  reply({ channel, payload });
} });

function reply(message) {
  if (process.connected) process.send(message, error => { if (error) shutdown(); });
}

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  try { sessions.closeAll(); }
  finally {
    if (process.connected) process.disconnect();
    // Allow PTY hangup, forced POSIX shell termination, and Windows ConPTY
    // cleanup to finish. A stuck native handle must not retain this service.
    setTimeout(() => process.exit(0), 6000).unref();
  }
}

process.once('disconnect', shutdown);
process.on('message', ({ serial, method, args }) => {
  if (stopping) return;
  if (method === 'ack') { sessions.ack(...args); return; }
  try {
    if (!['profiles', 'create', 'write', 'resize', 'close'].includes(method)) throw new Error('未知的终端操作。');
    const result = sessions[method](...args);
    reply({ serial, result });
  } catch (error) {
    reply({ serial, error: error.message || '终端操作失败。' });
  }
});

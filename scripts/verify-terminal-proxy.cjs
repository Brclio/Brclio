'use strict';
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');

async function verifyProxyHelper(app) {
  let requested, banner = '';
  const clients = new Set();
  const proxy = net.createServer(socket => {
    clients.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => clients.delete(socket));
    socket.once('data', headers => {
      requested = headers.toString().split('\r\n')[0];
      socket.write('HTTP/1.1 200 OK\r\n\r\nSSH-2.0-Fixture\r\n');
      socket.on('data', data => {
        banner += data.toString('latin1');
        if (banner.includes('\n')) socket.end();
      });
    });
  });
  try {
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    const diagnostic = await app.evaluate(async ({app}, proxyPort) => {
      const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const {program, argumentsFor} = load('./desktop/terminal/remote-launch.cjs');
      const file = program('ssh'), env = {...process.env};
      const args = argumentsFor('ssh', {host:'upstream.test',port:2222,proxy:'http://127.0.0.1:' + proxyPort}, true,
        {file,env,configFile:'none'});
      const child = load('node:child_process').spawn(file, ['-F','none','-o','BatchMode=yes',...args], {env,windowsHide:true});
      child.stdin.end();
      let message = '';
      child.stderr.on('data', part => { message = (message + part).slice(-2000); });
      const timer = setTimeout(() => child.kill(), 15000);
      try { await load('node:events').once(child, 'close'); }
      finally { clearTimeout(timer); }
      return message;
    }, proxy.address().port);
    assert.equal(requested, 'CONNECT upstream.test:2222 HTTP/1.1', diagnostic);
    assert.match(banner, /^SSH-2.0-OpenSSH/i, diagnostic);
  } finally {
    for (const socket of clients) socket.destroy();
    proxy.close();
  }
}
module.exports = { verifyProxyHelper };

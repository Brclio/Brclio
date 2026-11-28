'use strict';

// This OpenSSH ProxyCommand transports one requested SSH connection over its standard streams.
// It does not listen for connections, parse shell commands, or accept a destination from the peer.
const net = require('node:net');
const { once } = require('node:events');

function checkAddress(host, port) {
  if (typeof host !== 'string' || host.length > 255 || !(net.isIP(host) || /^[a-z0-9_][a-z0-9._-]*$/i.test(host)) ||
      !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('代理连接地址无效。');
}

async function promptPassword(value) {
  const { execFile } = require('node:child_process');
  const run = require('node:util').promisify(execFile);
  const title = 'Brclio 代理 ' + value.user + '@' + value.proxyHost + ':' + value.proxyPort;
  if (process.platform === 'darwin') {
    const script = 'on run argv\nset reply to display dialog (item 1 of argv) with title "代理密码" default answer "" with hidden answer buttons {"取消", "连接"} default button "连接" cancel button "取消" giving up after 120\nif gave up of reply then error number -128\nreturn text returned of reply\nend run';
    const {stdout} = await run('/usr/bin/osascript', ['-e', script, title], {timeout: 125000});
    return stdout.replace(/\r?\n$/, '');
  }
  if (process.platform === 'win32') {
    const exe = require('node:path').join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = [
      '$ErrorActionPreference="Stop"', 'Add-Type -AssemblyName System.Windows.Forms',
      '$form=New-Object Windows.Forms.Form', '$form.Text=$env:BRCLIO_PROXY_PROMPT', '$form.TopMost=$true',
      '$form.Width=480', '$form.Height=145', '$form.StartPosition="CenterScreen"',
      '$inputBox=New-Object Windows.Forms.TextBox', '$inputBox.UseSystemPasswordChar=$true', '$inputBox.Dock="Top"',
      '$label=New-Object Windows.Forms.Label', '$label.Text="代理密码"', '$label.Dock="Top"',
      '$ok=New-Object Windows.Forms.Button', '$ok.Text="连接"', '$ok.Dock="Bottom"', '$ok.DialogResult="OK"',
      '$form.Controls.AddRange(@($inputBox,$label,$ok))', '$form.AcceptButton=$ok',
      'if($form.ShowDialog() -ne "OK"){exit 1}',
      '[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)', '[Console]::Write($inputBox.Text)', '$form.Dispose()',
    ].join('\n');
    const {stdout} = await run(exe, ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script,'utf16le').toString('base64')],
      {timeout: 125000, windowsHide:true, env:{...process.env,BRCLIO_PROXY_PROMPT:title}});
    return stdout;
  }
  throw new Error('当前平台无法显示代理密码窗口。');
}

async function tunnel(value, requestPassword = promptPassword) {
  const { proxyHost, proxyPort, host, port, protocol } = value;
  checkAddress(proxyHost, proxyPort); checkAddress(host, port);
  if (!['socks5:', 'http:'].includes(protocol)) throw new Error('不支持的代理类型。');
  let password;
  if (value.user) {
    if (typeof value.user !== 'string' || /[:\x00-\x1f\x7f]/.test(value.user) || Buffer.byteLength(value.user) > 255) throw new Error('代理用户名无效。');
    try { password = await requestPassword(value); }
    catch { throw new Error('未输入代理密码。'); }
    if (typeof password !== 'string' || !Buffer.byteLength(password) || Buffer.byteLength(password) > 255 ||
        /[\r\n\0]/.test(password)) throw new Error('代理密码无效。');
  }
  const socket = net.connect(proxyPort, proxyHost);
  const timeout = setTimeout(() => socket.destroy(new Error('上游代理握手超时。')), 15000);
  let buffered = Buffer.alloc(0);
  const ended = new Promise((_, reject) => {
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('上游代理已关闭连接。')));
  });
  ended.catch(() => {});
  async function more() {
    let data;
    while (!(data = socket.read())) await Promise.race([once(socket, 'readable'), ended]);
    buffered = Buffer.concat([buffered, data]);
    if (buffered.length > 128 * 1024) throw new Error('上游代理响应过长。');
  }
  async function take(length) {
    while (buffered.length < length) await more();
    const result = buffered.subarray(0, length);
    buffered = buffered.subarray(length);
    return result;
  }
  try {
    await Promise.race([once(socket, 'connect'), ended]);
    if (protocol === 'http:') {
      const dest = (net.isIPv6(host) ? '[' + host + ']' : host) + ':' + port;
      const authorization = value.user ? 'Proxy-Authorization: Basic ' + Buffer.from(value.user + ':' + password).toString('base64') + '\r\n' : '';
      socket.write('CONNECT ' + dest + ' HTTP/1.1\r\nHost: ' + dest + '\r\n' + authorization + '\r\n');
      while (buffered.indexOf('\r\n\r\n') < 0) {
        if (buffered.length > 16384) throw new Error('HTTP 代理响应头过长。');
        await more();
      }
      const end = buffered.indexOf('\r\n\r\n') + 4;
      if (end > 16384 || !/^HTTP\/1\.[01] 2\d\d(?: |\r)/.test(buffered.subarray(0, end).toString('latin1'))) throw new Error('HTTP 代理拒绝了 CONNECT 请求。');
      buffered = buffered.subarray(end);
    } else {
      socket.write(Buffer.from([5, 1, value.user ? 2 : 0]));
      const method = await take(2);
      if (method[0] !== 5 || method[1] !== (value.user ? 2 : 0)) throw new Error('SOCKS5 代理未接受所选认证方式。');
      if (value.user) {
        const user = Buffer.from(value.user), secret = Buffer.from(password);
        socket.write(Buffer.concat([Buffer.from([1,user.length]),user,Buffer.from([secret.length]),secret]));
        const auth = await take(2);
        if (auth[0] !== 1 || auth[1] !== 0) throw new Error('SOCKS5 用户名或密码被拒绝。');
      }
      let type = 3, address;
      if (net.isIPv4(host)) {
        type = 1;
        address = Buffer.from(host.split('.').map(Number));
      } else if (net.isIPv6(host)) {
        if (host.includes('%')) throw new Error('SOCKS5 不支持带接口标识的 IPv6 目的地址。');
        type = 4;
        const canonical = new URL('http://[' + host + ']/').hostname.slice(1, -1);
        const [before, after] = canonical.split('::').map(s => s ? s.split(':') : []);
        const words = after ? [...before, ...Array(8 - before.length - after.length).fill('0'), ...after] : before;
        address = Buffer.alloc(16);
        words.forEach((w, i) => address.writeUInt16BE(parseInt(w, 16), i * 2));
      } else {
        const name = Buffer.from(host, 'ascii');
        address = Buffer.concat([Buffer.from([name.length]), name]);
      }
      socket.write(Buffer.concat([Buffer.from([5, 1, 0, type]), address, Buffer.from([port >> 8, port & 255])]));
      const head = await take(4);
      if (head[0] !== 5 || head[1] !== 0 || head[2] !== 0) throw new Error('SOCKS5 代理拒绝了连接。');
      const size = head[3] === 1 ? 4 : head[3] === 4 ? 16 : head[3] === 3 ? (await take(1))[0] : 0;
      if (!size) throw new Error('SOCKS5 代理响应无效。');
      await take(size + 2);
    }
    if (buffered.length) socket.unshift(buffered);
    return socket;
  } catch (error) { socket.destroy(); throw error; }
  finally { clearTimeout(timeout); }
}

if (require.main === module) {
  (async () => {
    const connection = JSON.parse(process.env.BRCLIO_SSH_PROXY);
    const socket = await tunnel(connection);
    socket.on('error', err => { process.stderr.write(err.message + '\n'); process.exitCode = 1; });
    socket.on('end', () => { process.stdin.destroy(); socket.end(); process.stdout.end(); });
    socket.on('close', () => { process.stdin.destroy(); });
    process.stdout.on('error', () => socket.destroy());
    process.stdin.on('error', () => socket.destroy());
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  })().catch(err => { process.stderr.write(err.message + '\n'); process.exitCode = 1; });
}
module.exports = { tunnel, checkAddress };

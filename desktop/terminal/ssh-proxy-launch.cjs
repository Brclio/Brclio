'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkAddress } = require('./ssh-proxy-client.cjs');

function options(target, session, ssh) {
  if (!session || !ssh) throw new Error('上游代理需要本机 OpenSSH 会话。');
  if (target.jump) throw new Error('当前连接同时选择了上游代理和 SSH 跳板，请选择一种路由。');
  const config = session.configFile ? ['-F', session.configFile] : [];
  if (target.port) config.push('-p', String(target.port));
  if (target.user) config.push('-l', target.user);
  const evaluated = spawnSync(ssh, ['-G', ...config, '--', target.host],
    { encoding: 'utf8', timeout: 5000, windowsHide: true, env: session.env });
  if (evaluated.status !== 0) throw new Error('无法解析上游代理的 OpenSSH 目的地址。');
  const dest = /^hostname (\S+)\r?$/im.exec(evaluated.stdout)?.[1];
  const port = Number(/^port (\d+)\r?$/im.exec(evaluated.stdout)?.[1]);
  checkAddress(dest, port);
  const proxy = new URL(target.proxy);
  const host = proxy.hostname.replace(/^\[|\]$/g, '');
  const proxyPort = Number(proxy.port || (proxy.protocol === 'http:' ? 80 : 1080));
  checkAddress(host, proxyPort);
  const file = path.join(__dirname, 'ssh-proxy-client.cjs').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  fs.accessSync(file, fs.constants.R_OK);
  const exe = process.execPath;
  session.env.BRCLIO_SSH_PROXY = JSON.stringify({ protocol: proxy.protocol, proxyHost: host, proxyPort, user: target.proxyUser, host: dest, port });
  // The only command words are two installation-controlled filesystem paths. No OpenSSH
  // host/port interpolation or proxy/user content enters a shell or command string.
  if (process.versions.electron) session.env.ELECTRON_RUN_AS_NODE = '1';
  function quote(p) {
    if (process.platform === 'win32') {
      if (/["\r\n%]/.test(p)) throw new Error('此安装路径无法用于 OpenSSH 代理，请使用不含百分号的路径。');
      return '"' + p.replaceAll('\\', '/') + '"';
    }
    if (/[\r\n]/.test(p)) throw new Error('代理程序路径无效。');
    return "'" + p.replaceAll('%', '%%').replaceAll("'", "'\\''") + "'";
  }
  // Disable reuse of a master connection made through a different route.
  return ['-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ProxyCommand=' + quote(exe) + ' ' + quote(file)];
}
module.exports = { options };

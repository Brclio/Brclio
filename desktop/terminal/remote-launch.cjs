'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { endpoint } = require('./connection.js');

function program(kind, platform = process.platform, env = process.env) {
  if (!['ssh', 'sftp'].includes(kind)) throw new Error('请选择 SSH 或 SFTP。');
  const windows = platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  const roots = windows ? [paths.join(env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH'),
    paths.join(env.ProgramFiles || 'C:\\Program Files', 'OpenSSH')] : ['/usr/bin'];
  const locations = [...roots, ...(env.PATH || env.Path || '').split(paths.delimiter)];
  const name = kind + (windows ? '.exe' : '');
  for (const directory of locations) {
    if (!paths.isAbsolute(directory)) continue;
    const file = paths.join(directory, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch { /* OpenSSH is an optional Windows component. */ }
  }
  return null;
}

function argumentsFor(kind, value, interactive = kind === 'ssh') {
  const { host, port, user, jump, identityFile, certificateFile, agentForwarding } = endpoint(value);
  const args = [];
  if (jump) args.push('-J', jump);
  if (identityFile) args.push('-i', identityFile);
  if (kind === 'ssh') {
    // Do not inherit a wildcard ForwardAgent directive for a different host or a background tunnel.
    args.push(interactive && agentForwarding ? '-A' : '-a');
    if (interactive && certificateFile) {
      const file = /^[a-z]:[\\/]/i.test(certificateFile) ? certificateFile.replaceAll('\\', '/') : certificateFile;
      // -o parses an ssh_config token even when passed directly through native argv.
      const quoted = file.replaceAll('%', '%%').replace(/["\\]/g, '\\$&');
      args.push('-o', 'CertificateFile="' + quoted + '"');
    }
    if (port) args.push('-p', String(port));
    if (user) args.push('-l', user);
    return [...args, '--', host];
  }
  if (kind !== 'sftp') throw new Error('请选择 SSH 或 SFTP。');
  if (port) args.push('-P', String(port));
  if (user) args.push('-o', 'User=' + user);
  return [...args, '--', host.includes(':') ? '[' + host + ']' : host];
}

module.exports = { program, argumentsFor };

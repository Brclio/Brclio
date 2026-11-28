'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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

const syntaxByClient = new Map();
function setEnvSyntax(file) {
  if (syntaxByClient.has(file)) return syntaxByClient.get(file);
  // Different system OpenSSH versions expand different tokens in SetEnv. Probe
  // the actual client using its offline config dump and no user configuration.
  const result = spawnSync(file, ['-G', '-F', 'none', '-o',
    'SetEnv=BRCLIO_TEST=%h:${BRCLIO_SSH_ENV_PROBE}', '--', 'probe.invalid'],
  { env: { ...process.env, BRCLIO_SSH_ENV_PROBE: 'expanded' }, encoding: 'utf8', timeout: 3000, windowsHide: true });
  const match = /BRCLIO_TEST=(%h|probe\.invalid):(\$\{BRCLIO_SSH_ENV_PROBE\}|expanded)(?:\s|$)/.exec(result.stdout || '');
  if (result.status !== 0 || !match) throw new Error('无法确认本机 OpenSSH 对环境变量特殊字符的支持。');
  const syntax = { percent: match[1] !== '%h', dollar: match[2] === 'expanded' };
  syntaxByClient.set(file, syntax);
  return syntax;
}

function setEnvOption(items, session) {
  const special = items.some(item => /%|\$\{/.test(item.value));
  if (special && !session) throw new Error('包含特殊字符的 SSH 环境变量需要本机客户端。');
  const syntax = special && setEnvSyntax(session.file);
  const tokens = items.map(item => {
    let value = item.value;
    if (syntax?.percent) value = value.replaceAll('%', '%%');
    if (syntax?.dollar && value.includes('${')) {
      // Only this fixed, non-secret marker enters the local process environment.
      // OpenSSH expands it once, leaving a literal dollar before the brace.
      session.env.BRCLIO_SSH_LITERAL_DOLLAR = '$';
      value = value.replaceAll('${', () => '${BRCLIO_SSH_LITERAL_DOLLAR}{');
    }
    return '"' + item.name + '=' + value.replace(/["\\]/g, '\\$&') + '"';
  });
  return 'SetEnv=' + tokens.join(' ');
}

function argumentsFor(kind, value, interactive = kind === 'ssh', session) {
  const { host, port, user, jump, identityFile, certificateFile, agentForwarding, environment } = endpoint(value);
  const args = [];
  if (jump) args.push('-J', jump);
  if (identityFile) args.push('-i', identityFile);
  if (kind === 'ssh') {
    // Do not inherit a wildcard ForwardAgent directive for a different host or a background tunnel.
    args.push(interactive && agentForwarding ? '-A' : '-a');
    if (interactive && environment) args.push('-o', setEnvOption(environment, session));
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

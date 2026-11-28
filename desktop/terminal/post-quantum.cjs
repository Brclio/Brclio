'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {execFile,spawnSync} = require('node:child_process');
const run = require('node:util').promisify(execFile);
// Protocol identifiers implemented by OpenSSH, in the preferred order used by
// this host setting. A traditional algorithm must never enter a required list.
const hybrids = ['mlkem768x25519-sha256','mlkem768nistp256-sha256','sntrup761x25519-sha512','sntrup761x25519-sha512@openssh.com'];
const options = {encoding:'utf8',timeout:2500,maxBuffer:65536,windowsHide:true};
function supported(text) {
  const available = new Set(text.split(/\r?\n/).map(line => line.trim()));
  return hybrids.filter(kex => available.has(kex));
}
function candidates(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return ['/usr/bin/ssh'];
  const system = env.SystemRoot || 'C:\\Windows', programs = env.ProgramFiles || 'C:\\Program Files';
  return [path.win32.join(system, 'System32', 'OpenSSH', 'ssh.exe'),
    path.win32.join(programs, 'OpenSSH', 'ssh.exe')].filter(file => /^[a-z]:\\/i.test(file));
}
async function capabilities(file) {
  if (!file) throw new Error('未找到系统 OpenSSH 客户端。');
  try {return {algorithms:supported((await run(file,['-Q','kex'],options)).stdout)};}
  catch {throw new Error('系统 OpenSSH 无法列出密钥交换算法。');}
}
async function installedCapabilities(files = candidates()) {
  const installed = files.filter(file => fs.statSync(file,{throwIfNoEntry:false})?.isFile());
  if (!installed.length) throw new Error('未找到系统安装目录中的 OpenSSH 客户端。');
  const checked = await Promise.all(installed.map(async file => {
    try {return {file,...await capabilities(file)};}
    catch {return {file,algorithms:[],failed:true};}
  }));
  if (checked.every(item => item.failed)) throw new Error('本机 OpenSSH 无法列出密钥交换算法。');
  const chosen = checked.find(item => item.algorithms.length);
  return {file:chosen?.file || null,algorithms:chosen?.algorithms || [],checked:installed};
}
function required(file, probe = spawnSync) {
  if (!file) throw new Error('需要安装支持后量子密钥交换的 OpenSSH 客户端。');
  const result = probe(file,['-Q','kex'],options);
  if (result.status !== 0) throw new Error('系统 OpenSSH 无法验证后量子算法，未建立连接。');
  const algorithms = supported(result.stdout || '');
  if (!algorithms.length) throw Object.assign(new Error('本机 OpenSSH 未列出支持的后量子混合算法，未建立连接。'),{code:'NO_HYBRID_KEX'});
  // An existing ControlMaster may have negotiated a classical KEX. Require a
  // fresh handshake on this destination even if ~/.ssh/config enables reuse.
  return ['-o','KexAlgorithms='+algorithms.join(','),'-o','ControlMaster=no','-o','ControlPath=none'];
}
function strictClient(kind, platform = process.platform, env = process.env, probe = spawnSync) {
  const windows = platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  let failure;
  for (const sshFile of candidates(platform,env)) {
    let kex;
    try {kex = required(sshFile,probe);}
    catch (error) {
      if (!failure || error.code === 'NO_HYBRID_KEX') failure = error;
      continue;
    }
    const file = kind === 'sftp' ? paths.join(paths.dirname(sshFile),windows ? 'sftp.exe' : 'sftp') : sshFile;
    if (kind === 'sftp' && !fs.statSync(file,{throwIfNoEntry:false})?.isFile())
      throw new Error('支持后量子算法的 OpenSSH 安装目录缺少 SFTP 客户端。');
    return {file,sshFile,kex};
  }
  throw failure || new Error('未找到支持后量子密钥交换的 OpenSSH 客户端。');
}
module.exports = {capabilities,installedCapabilities,candidates,strictClient,required,supported};

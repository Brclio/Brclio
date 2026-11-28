'use strict';
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
async function capabilities(file) {
  if (!file) throw new Error('未找到系统 OpenSSH 客户端。');
  try {return {algorithms:supported((await run(file,['-Q','kex'],options)).stdout)};}
  catch {throw new Error('系统 OpenSSH 无法列出密钥交换算法。');}
}
function required(file, probe = spawnSync) {
  if (!file) throw new Error('需要安装支持后量子密钥交换的 OpenSSH 客户端。');
  const result = probe(file,['-Q','kex'],options);
  if (result.status !== 0) throw new Error('系统 OpenSSH 无法验证后量子算法，未建立连接。');
  const algorithms = supported(result.stdout || '');
  if (!algorithms.length) throw new Error('本机 OpenSSH 未列出支持的后量子混合算法，未建立连接。');
  // An existing ControlMaster may have negotiated a classical KEX. Require a
  // fresh handshake on this destination even if ~/.ssh/config enables reuse.
  return ['-o','KexAlgorithms='+algorithms.join(','),'-o','ControlMaster=no','-o','ControlPath=none'];
}
module.exports = {capabilities,required,supported};

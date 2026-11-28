'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { program } = require('./remote-launch.cjs');

function target(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.length > 1024 ||
      /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(file)) throw new Error('请选择有效的本地密钥路径。');
  return file;
}
function newPath(file) {
  target(file);
  if (/\.pub$/i.test(file)) throw new Error('请选择私钥文件名，公钥会使用同名 .pub 文件。');
  for (const name of [file, file + '.pub']) {
    if (fs.lstatSync(name, { throwIfNoEntry: false })) throw new Error('目标密钥文件已存在，请选用新的文件名。');
  }
  return file;
}

function keygenProgram(platform, env) {
  const ssh = program('ssh', platform, env);
  const file = ssh && path.join(path.dirname(ssh), platform === 'win32' ? 'ssh-keygen.exe' : 'ssh-keygen');
  if (!file || !fs.existsSync(file)) throw new Error('未找到系统 ssh-keygen，请安装 OpenSSH 客户端。');
  return file;
}

const algorithms = new Map([
  ['ed25519', []], ['rsa', ['-b', '4096']], ['ecdsa', ['-b', '521']],
  ['ecdsa-sk', []], ['ed25519-sk', []],
]);

function algorithm(value = 'ed25519') {
  if (!algorithms.has(value)) throw new Error('不支持的 SSH 密钥类型。');
  return value;
}

async function securityKeyAlgorithms() {
  const ssh = program('ssh', process.platform, process.env);
  if (!ssh) return [];
  keygenProgram(process.platform, process.env);
  // Query compiled key formats only. This does not enumerate resident keys,
  // invoke a security token, or perform an enrollment.
  const { stdout } = await require('node:util').promisify(execFile)(ssh, ['-Q', 'key'], {
    timeout: 4000, maxBuffer: 65536, windowsHide: true,
  });
  const supported = new Set(stdout.split(/\s+/));
  return [['ed25519-sk', 'sk-ssh-ed25519@openssh.com'], ['ecdsa-sk', 'sk-ecdsa-sha2-nistp256@openssh.com']]
    .filter(([, key]) => supported.has(key)).map(([type]) => type);
}

function keygen(value, platform, env) {
  const type = algorithm(value?.algorithm);
  return { file: keygenProgram(platform, env), args: ['-t', type, ...algorithms.get(type), '-a', '64', '-f', newPath(value?.keyPath)] };
}

async function publicPart(file) {
  const name = target(file) + '.pub';
  // Only open the companion public-key file. Refuse directories, devices, and links.
  const stat = await fs.promises.lstat(name).catch(error => {
    if (error.code === 'ENOENT') throw new Error('未找到同名 .pub 公钥文件。');
    throw error;
  });
  if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('公钥文件格式无效。');
  const handle = await fs.promises.open(name, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > 256 * 1024 || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('公钥文件已更改，请重试。');
    const content = (await handle.readFile('utf8')).trim();
    const match = /^((?:ssh-|ecdsa-|sk-)[A-Za-z0-9@._-]+) ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$/.exec(content);
    if (!match) throw new Error('没有识别到 OpenSSH 公钥。');
    const key = Buffer.from(match[2], 'base64');
    if (key.length < 5 || key.readUInt32BE() !== match[1].length || key.toString('ascii',4,4 + match[1].length) !== match[1]) throw new Error('公钥数据格式无效。');
    return { text: match[1] + ' ' + match[2], fingerprint: 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '') };
  } finally { await handle.close(); }
}

async function verifyCertificate(file) {
  const opened = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  let content;
  try {
    const info = await opened.stat();
    if (!info.isFile() || info.size > 256 * 1024) throw new Error('请选择 OpenSSH 用户证书文件。');
    const prefix = Buffer.alloc(160);
    const { bytesRead } = await opened.read(prefix, 0, prefix.length, 0);
    if (!/^[a-z0-9@._-]+-cert-v01@openssh\.com[ \t]/i.test(prefix.toString('ascii', 0, bytesRead))) {
      throw new Error('请选择已签名的 OpenSSH 用户证书（通常为 -cert.pub）。');
    }
    content = await opened.readFile();
  } finally { await opened.close(); }
  const program = keygenProgram(process.platform, process.env);
  await new Promise((resolve, reject) => {
    const child = execFile(program, ['-L', '-f', '-'], { timeout: 4000, maxBuffer: 512 * 1024, windowsHide: true,
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' } }, (error, stdout) => {
      if (error || !/Type:\s+[^\r\n]*\buser certificate\b/i.test(stdout)) reject(new Error('文件不是有效的 OpenSSH 用户证书。'));
      else resolve();
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(content);
  });
}

function register({ handle, dialog, getOwner, home }) {
  const grants = new Map();
  handle('identity-security-key-algorithms', securityKeyAlgorithms);
  handle('identity-public', publicPart);
  handle('identity-choose', async mode => {
    if (mode === 'existing' || mode === 'certificate') {
      const result = await dialog.showOpenDialog(getOwner(), {
        title: mode === 'certificate' ? '选择 OpenSSH 用户证书' : '选择现有的 SSH 私钥',
        properties: ['openFile', 'showHiddenFiles'],
      });
      if (result.canceled || !result.filePaths.length) return null;
      const file = target(result.filePaths[0]);
      if (mode === 'certificate') await verifyCertificate(file);
      if (mode === 'existing' && /\.pub$/i.test(file)) throw new Error('请选择私钥本身。');
      return { path: file };
    }
    const type = algorithm(typeof mode === 'object' && mode !== null ? mode.algorithm : undefined);
    if (mode !== 'generate' && mode?.action !== 'generate') throw new Error('未知的密钥选择方式。');
    const result = await dialog.showSaveDialog(getOwner(), { title: '保存新 SSH 密钥 · ' + type, defaultPath: path.join(home, 'brclio_' + type), properties: ['showHiddenFiles'] });
    if (result.canceled || !result.filePath) return null;
    const file = newPath(result.filePath);
    for (const [token, grant] of grants) if (grant.expires < Date.now()) grants.delete(token);
    if (grants.size >= 16) throw new Error('密钥生成窗口过多，请稍后再试。');
    const token = randomUUID();
    grants.set(token, { file, type, expires: Date.now() + 60000 });
    return { path: file, token };
  });
  return { prepare(options) {
    if (options?.profile !== 'ssh-keygen') return options;
    const token = options.connection?.token;
    const grant = grants.get(token);
    grants.delete(token);
    if (!grant || grant.expires < Date.now()) throw new Error('请重新选择新密钥的保存位置。');
    return { ...options, connection: { keyPath: newPath(grant.file), ...(grant.type !== 'ed25519' && { algorithm: grant.type }) } };
  } };
}

module.exports = { register, keygen, publicPart, verifyCertificate, securityKeyAlgorithms };

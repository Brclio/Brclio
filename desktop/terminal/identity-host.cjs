'use strict';

const fs = require('node:fs');
const path = require('node:path');
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

function keygen(value, platform, env) {
  const ssh = program('ssh', platform, env);
  const file = ssh && path.join(path.dirname(ssh), platform === 'win32' ? 'ssh-keygen.exe' : 'ssh-keygen');
  if (!file || !fs.existsSync(file)) throw new Error('未找到系统 ssh-keygen，请安装 OpenSSH 客户端。');
  return { file, args: ['-t', 'ed25519', '-a', '64', '-f', newPath(value?.keyPath)] };
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

function register({ handle, dialog, getOwner, home }) {
  const grants = new Map();
  handle('identity-public', publicPart);
  handle('identity-choose', async mode => {
    if (mode === 'existing') {
      const result = await dialog.showOpenDialog(getOwner(), { title: '选择现有的 SSH 私钥', properties: ['openFile', 'showHiddenFiles'] });
      if (result.canceled || !result.filePaths.length) return null;
      const file = target(result.filePaths[0]);
      if (/\.pub$/i.test(file)) throw new Error('请选择私钥本身。');
      return { path: file };
    }
    if (mode !== 'generate') throw new Error('未知的密钥选择方式。');
    const result = await dialog.showSaveDialog(getOwner(), { title: '保存新 Ed25519 密钥', defaultPath: path.join(home, 'brclio_ed25519'), properties: ['showHiddenFiles'] });
    if (result.canceled || !result.filePath) return null;
    const file = newPath(result.filePath);
    for (const [token, grant] of grants) if (grant.expires < Date.now()) grants.delete(token);
    if (grants.size >= 16) throw new Error('密钥生成窗口过多，请稍后再试。');
    const token = randomUUID();
    grants.set(token, { file, expires: Date.now() + 60000 });
    return { path: file, token };
  });
  return { prepare(options) {
    if (options?.profile !== 'ssh-keygen') return options;
    const token = options.connection?.token;
    const grant = grants.get(token);
    grants.delete(token);
    if (!grant || grant.expires < Date.now()) throw new Error('请重新选择新密钥的保存位置。');
    return { ...options, connection: { keyPath: newPath(grant.file) } };
  } };
}

module.exports = { register, keygen, publicPart };

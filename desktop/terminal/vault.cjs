'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const validId = value => typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
function nameFor(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(value)) throw new Error('请输入有效的密码条目名称。');
  return value.trim();
}
function secretFor(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 4096 || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(value)) throw new Error('密码应为单行文本，最多 4096 字节。');
  return value;
}

function createTerminalVault({ directory, storage, platform = process.platform }) {
  const file = path.join(directory, 'terminal-passwords.v1.json');
  let queue = Promise.resolve();
  function transaction(operation) {
    const result = queue.then(async () => {
      if (!['darwin', 'win32'].includes(platform) || !await storage.isAsyncEncryptionAvailable()) {
        throw new Error('系统密钥保护不可用，无法打开终端密码库。');
      }
      let data;
      try {
        if ((await fs.stat(file)).size > 2 * 1024 * 1024) throw new Error();
        data = JSON.parse(await fs.readFile(file, 'utf8'));
        if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 128 ||
            !data.entries.every(entry => validId(entry.id) && typeof entry.name === 'string' && typeof entry.secret === 'string')) throw new Error();
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('密码库不可读取，原文件已保留。');
        data = { version: 1, entries: [] };
      }
      return operation(data);
    });
    queue = result.then(() => {}, () => {});
    return result;
  }
  async function persist(data) {
    await fs.mkdir(directory, { recursive: true });
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async function encrypt(value) {
    try { return (await storage.encryptStringAsync(value)).toString('base64'); }
    catch { throw new Error('系统未能加密此条目。'); }
  }
  async function decrypt(value) {
    try { return (await storage.decryptStringAsync(Buffer.from(value, 'base64'))).result; }
    catch { throw new Error('系统未能解锁此条目。'); }
  }
  function selected(data, id) {
    const item = data.entries.find(candidate => candidate.id === id);
    if (!item) throw new Error('请选择已保存的终端条目。');
    return item;
  }
  return {
    list: () => transaction(data => Promise.all(data.entries.map(async item => ({ id: item.id, name: nameFor(await decrypt(item.name)) })))),
    add(name, value) {
      return transaction(async data => {
        if (data.entries.length >= 128) throw new Error('最多可保存 128 个终端条目。');
        name = nameFor(name);
        value = secretFor(value);
        const item = { id: randomUUID(), name: await encrypt(name), secret: await encrypt(value) };
        data.entries.push(item);
        await persist(data);
        return { id: item.id, name };
      });
    },
    update(id, name, value) {
      return transaction(async data => {
        const item = selected(data, id);
        if (!name && !value) throw new Error('请填写新名称或新密码。');
        if (name) item.name = await encrypt(nameFor(name));
        if (value) item.secret = await encrypt(secretFor(value));
        await persist(data);
      });
    },
    remove(id) {
      return transaction(async data => {
        const item = selected(data, id);
        data.entries = data.entries.filter(entry => entry !== item);
        await persist(data);
      });
    },
    fill(id, confirm, send) {
      return transaction(async data => {
        const item = selected(data, id);
        if (!await confirm(nameFor(await decrypt(item.name)))) return { filled: false };
        // Decryption stays in the main process. The caller rechecks the active
        // session after OS key access, then writes directly to one PTY.
        await send(secretFor(await decrypt(item.secret)));
        return { filled: true };
      });
    },
  };
}

module.exports = { createTerminalVault };

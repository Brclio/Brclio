'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, createHmac, randomUUID } = require('node:crypto');
const { endpoint } = require('./connection.js');

const hash = value => createHash('sha256').update(value).digest('base64').replace(/=+$/, '');

function lookupName(value) {
  const { host, port } = endpoint(value);
  return (port && port !== 22 ? '[' + host + ']:' + port : host).toLowerCase();
}

function matches(pattern, name) {
  if (pattern.startsWith('|1|')) {
    const parts = pattern.split('|');
    if (parts.length !== 4) return false;
    const salt = Buffer.from(parts[2], 'base64');
    return salt.length === 20 && createHmac('sha1', salt).update(name).digest('base64') === parts[3];
  }
  const glob = pattern.toLowerCase();
  let p = 0, n = 0, star = -1, back = 0;
  while (n < name.length) {
    if (glob[p] === '?' || glob[p] === name[n]) { p++; n++; }
    else if (glob[p] === '*') { star = p++; back = n; }
    else if (star >= 0) { p = star + 1; n = ++back; }
    else return false;
  }
  while (glob[p] === '*') p++;
  return p === glob.length;
}

function entry(line, name) {
  // The key, host and marker fields are ASCII. Leave optional comments and all unmatched bytes intact.
  const columns = line.trim().split(/\s+/, 5);
  if (!columns[0] || columns[0].startsWith('#')) return null;
  const marker = columns[0].startsWith('@') ? columns.shift() : '';
  const [hosts, type, key] = columns;
  if (!hosts || !type || !key || !/^[A-Za-z0-9+/]+=*$/.test(key)) return null;
  const patterns = hosts.split(',');
  if (patterns.some(p => p[0] === '!' && matches(p.slice(1), name)) || !patterns.some(p => p[0] !== '!' && matches(p, name))) return null;
  const standalone = hosts.toLowerCase() === name || hosts.startsWith('|1|') && patterns.length === 1;
  return { id: hash(Buffer.from(line, 'latin1')), type, marker, fingerprint: 'SHA256:' + hash(Buffer.from(key, 'base64')), removable: !marker && standalone };
}

function createKnownHosts({ home, confirm }) {
  const file = path.join(home, '.ssh', 'known_hosts');
  let pending = Promise.resolve();

  async function snapshot() {
    let handle;
    try {
      handle = await fs.open(file, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('known_hosts 应为 16 MiB 以内的普通文件。');
      const content = await handle.readFile();
      return { stat, content, lines: content.toString('latin1').match(/[^\n]*\n|[^\n]+$/g) || [] };
    } finally { await handle.close(); }
  }

  async function list(target) {
    const name = lookupName(target);
    const snapshotFile = await snapshot();
    if (!snapshotFile) return [];
    const stat = await fs.lstat(file);
    const editable = stat.isFile() && stat.nlink === 1;
    return snapshotFile.lines.map(line => entry(line, name)).filter(Boolean).map(item => ({ ...item, removable: editable && item.removable }));
  }

  async function remove(target, id) {
    const name = lookupName(target);
    if (typeof id !== 'string' || !/^[a-zA-Z0-9+/]{43}$/.test(id)) throw new Error('请选择一项主机指纹。');
    const found = (await list(target)).find(item => item.id === id && item.removable);
    if (!found) throw new Error('记录已更改，或此行包含共享、撤销或证书规则。');
    const accepted = await confirm('移除 ' + name + ' 的已知主机指纹？',
      found.type + ' · ' + found.fingerprint + '\n将从 ~/.ssh/known_hosts 移除这一条记录。下次连接时需要重新核验主机。');
    if (!accepted) return false;

    const write = async () => {
      const before = await snapshot();
      if (!before) throw new Error('记录已更改，请重新查询。');
      const index = before.lines.findIndex(line => {
        const item = entry(line, name);
        return item?.id === id && item.removable;
      });
      if (index < 0) throw new Error('记录已更改，请重新查询。');
      const temp = path.join(path.dirname(file), '.brclio-known-hosts-' + randomUUID());
      before.lines.splice(index, 1);
      try {
        await fs.writeFile(temp, Buffer.from(before.lines.join(''), 'latin1'), { flag: 'wx', mode: 0o600 });
        await fs.chmod(temp, before.stat.mode & 0o777);
        const current = await fs.lstat(file);
        if (!current.isFile() || current.nlink !== 1 || current.ino !== before.stat.ino || current.dev !== before.stat.dev ||
            current.size !== before.stat.size || current.mtimeMs !== before.stat.mtimeMs || !(await fs.readFile(file)).equals(before.content)) {
          throw new Error('known_hosts 已更改，请重新查询。');
        }
        await fs.rename(temp, file);
      } finally { await fs.rm(temp, { force: true }); }
      return true;
    };
    const run = pending.then(write);
    pending = run.catch(() => {});
    return run;
  }
  return { list, remove };
}

function register({ handle, home, confirm }) {
  const known = createKnownHosts({ home, confirm });
  handle('known-hosts', known.list);
  handle('known-hosts-forget', known.remove);
}

module.exports = { createKnownHosts, lookupName, register };

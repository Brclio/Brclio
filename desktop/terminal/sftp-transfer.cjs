'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { copyBytes } = require('./sftp-protocol.cjs');

function validateName(value, local = false) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\/\0]/u.test(value) ||
      Buffer.byteLength(value) > 1024) throw new Error('文件名无效。');
  if (local && process.platform === 'win32' && (/[\\:*?"<>|\x00-\x1f]|[ .]$/u.test(value) ||
      /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(value))) throw new Error('Windows 不支持这个文件名。');
  return value;
}

function classify(mode) {
  return ({ 0o040000: 'directory', 0o100000: 'file', 0o120000: 'link' })[mode & 0o170000] || 'other';
}

async function withLocalFile(file, writing, fn) {
  const flags = writing ? 'wx' : fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const handle = await fs.open(file, flags, 0o600);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('请选择普通文件。');
    return await fn(handle);
  } finally { await handle.close(); }
}

const local = {
  paths: path, realpath: fs.realpath, stat: fs.lstat,
  list: async dir => (await fs.readdir(dir, { withFileTypes: true })).map(item => ({
    name: item.name, kind: item.isFile() ? 'file' : item.isDirectory() ? 'directory' : item.isSymbolicLink() ? 'link' : 'other',
  })),
  withFile: withLocalFile,
  mkdir: p => fs.mkdir(p, { mode: 0o700 }),
  remove: (p, directory) => directory ? fs.rmdir(p) : fs.unlink(p),
  async publish(temp, file) {
    try { await fs.link(temp, file); }
    catch (e) {
      if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS'].includes(e.code)) throw e;
      await fs.copyFile(temp, file, fs.constants.COPYFILE_EXCL);
    }
    await fs.unlink(temp);
  },
};

function endpointIO(net) {
  if (!net) return local;
  return {
    ...net, paths: path.posix, publish: net.rename,
    list: async dir => (await net.list(dir)).filter(item => item.name !== '.' && item.name !== '..').map(item => ({
      name: item.name, kind: classify(item.mode), size: item.size ?? null, mode:item.mode, mtime:item.mtime,
    })),
  };
}

async function checkDir(io, dir) {
  if (await io.realpath(dir) !== dir) throw new Error('目录已改变，请刷新。');
}

// Inventory the selected tree before creating destinations. This also bounds recursive copying
// when two views happen to refer to the same server through different SSH aliases.
async function transferTree(from, to, name, state, check) {
  const src = endpointIO(from.net), dst = endpointIO(to.net);
  const selected = from.entries.find(item => item.name === name);
  if (!selected || !['file', 'directory'].includes(selected.kind)) throw new Error('请选择普通文件或文件夹。');
  if (to.entries.some(item => item.name === name)) throw new Error('目标目录已存在同名项目。');
  await checkDir(src, from.dir);
  await checkDir(dst, to.dir);
  const inventory = [];
  async function scan(parts, expected) {
    check();
    if (parts.length > 64 || inventory.length >= 50000) throw new Error('目录层级或项目数量超过传输上限。');
    const part = parts.at(-1);
    validateName(part, !from.net || !to.net);
    const file = src.paths.join(from.dir, ...parts);
    await checkDir(src, src.paths.dirname(file));
    const attrs = await src.stat(file);
    const kind = classify(attrs.mode);
    if (kind !== expected || !['directory', 'file'].includes(kind)) throw new Error('目录包含链接、特殊文件或已更改的项目：' + part);
    inventory.push({ parts, kind });
    if (kind === 'file') {
      if (state.size !== null) state.size = Number.isSafeInteger(attrs.size) ? state.size + attrs.size : null;
    } else {
      await checkDir(src, file);
      for (const child of await src.list(file)) await scan([...parts, child.name], child.kind);
    }
  }
  state.size = 0;
  await scan([name], selected.kind);
  const owned = [];
  const tempName = '.brclio-transfer-' + randomUUID() + '.tmp';
  const staged = selected.kind === 'file' || !!to.net;
  const temp = dst.paths.join(to.dir, tempName);
  const destination = dst.paths.join(to.dir, name);
  try {
    for (const { parts, kind } of inventory) {
      check();
      const source = src.paths.join(from.dir, ...parts);
      const file = dst.paths.join(to.dir, staged ? tempName : name, ...parts.slice(1));
      await checkDir(src, src.paths.dirname(source));
      await checkDir(dst, dst.paths.dirname(file));
      if (classify((await src.stat(source)).mode) !== kind) throw new Error('源项目已改变，请刷新。');
      if (kind === 'directory') {
        await dst.mkdir(file);
        owned.push({ file, directory: true });
        continue;
      }
      const base = state.bytes;
      state.current = parts.join('/');
      await src.withFile(source, false, reader => dst.withFile(file, true, async writer => {
        owned.push({ file, directory: false });
        await copyBytes(reader, writer, written => { state.bytes = base + written; }, check);
      }));
      state.files++;
    }
    check();
    if (staged) {
      await checkDir(dst, to.dir);
      await dst.publish(temp, destination);
    }
  } catch (error) {
    // Remove only entries created by this transfer, never a whole arbitrary directory tree.
    for (const item of owned.reverse()) {
      try { await checkDir(dst, dst.paths.dirname(item.file)); await dst.remove(item.file, item.directory); }
      catch { /* A disconnected endpoint or a moved directory may require manual cleanup. */ }
    }
    throw error;
  }
}

module.exports = { transferTree, endpointIO, validateName };

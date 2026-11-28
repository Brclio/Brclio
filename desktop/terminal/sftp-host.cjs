'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { endpoint } = require('./connection.js');
const { program, argumentsFor } = require('./remote-launch.cjs');
const { connectProtocol } = require('./sftp-protocol.cjs');
const { prepareAskpass } = require('./sftp-askpass.cjs');

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

async function startConnection(value, { configFile, askpass = prepareAskpass } = {}) {
  const target = endpoint(value);
  const executable = program('ssh');
  if (!executable) throw new Error('请安装系统 OpenSSH 客户端。');
  const auth = await askpass();
  try {
    const args = ['-T', '-o', 'StrictHostKeyChecking=ask', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectionAttempts=1',
      '-o', 'ConnectTimeout=15', '-o', 'NumberOfPasswordPrompts=2', '-s', ...argumentsFor('ssh', target), 'sftp'];
    if (configFile) args.unshift('-F', configFile);
    const child = spawn(executable, args, { shell: false, windowsHide: true, detached: process.platform !== 'win32',
      env: { ...process.env, SSH_ASKPASS_REQUIRE: 'force', SSH_ASKPASS: auth.file,
        DISPLAY: process.env.DISPLAY || 'brclio', BRCLIO_SFTP_TARGET: target.host }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.once('close', auth.cleanup);
    return connectProtocol(child, () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
      } else {
        const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
        spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          .on('error', () => child.kill());
      }
    });
  } catch (error) { await auth.cleanup(); throw error; }
}

function createBrowser({ start = startConnection, chooseLocal }) {
  let active = null;
  const current = id => {
    if (!active || active.id !== id) throw new Error('SFTP 会话已结束，请重新连接。');
    return active;
  };
  function close(id) {
    if (!active || (id && active.id !== id)) return;
    active.net?.stop();
    active = null;
  }

  async function list(s, side, dir, root = s.root) {
    const entries = [];
    if (side === 'remote') {
      const real = await s.net.realpath(dir);
      if (!real || !real.startsWith('/') || real.includes('\0')) throw new Error('无效的远端目录。');
      for (const item of await s.net.list(real)) {
        if (!item.name || item.name === '.' || item.name === '..' || /[\/\0]/u.test(item.name)) continue;
        entries.push({ name: item.name, kind: classify(item.mode), size: item.size ?? null });
      }
      dir = real;
    } else {
      const actual = await fs.realpath(dir);
      const relative = path.relative(root, actual);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('请重新选择本地根目录。');
      const items = await fs.readdir(actual, { withFileTypes: true });
      for (const item of items) {
        entries.push({ name: item.name, kind: item.isDirectory() ? 'directory' : item.isFile() ? 'file' : item.isSymbolicLink() ? 'link' : 'other' });
      }
      dir = actual;
    }
    entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    if (active !== s) throw new Error('SFTP 会话已关闭。');
    s[side] = { dir, entries, parent: side === 'local' ? dir !== root : path.posix.dirname(dir) !== dir };
    return s[side];
  }

  async function transfer(s, side, name) {
    if (!s.local) throw new Error('请先选择本地文件夹。');
    validateName(name, true);
    const entry = s[side].entries.find(item => item.name === name && item.kind === 'file');
    if (!entry) throw new Error('请选择一个普通文件。');
    const local = path.join(s.local.dir, name);
    const remote = path.posix.join(s.remote.dir, name);
    const tempName = '.brclio-transfer-' + randomUUID() + '.tmp';
    const state = { bytes: 0, size: null, canceled: false };
    s.transfer = state;
    const assertActive = () => {
      if (active !== s) throw new Error('SFTP 会话已关闭。');
      if (state.canceled) throw new Error('已取消传输。');
    };
    const progress = bytes => { state.bytes = bytes; };
    try {
      // Check the directory identity again: a user may replace or rename it while the browser is open.
      if (await fs.realpath(s.local.dir) !== s.local.dir) throw new Error('本地目录已改变，请重新选择。');
      if (side === 'local') {
        if (s.remote.entries.some(item => item.name === name)) throw new Error('远端已存在同名项目。');
        if (!(await fs.lstat(local)).isFile()) throw new Error('源文件已改变，请刷新。');
        const file = await fs.open(local, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const temp = path.posix.join(s.remote.dir, tempName);
        try {
          const stat = await file.stat();
          if (!stat.isFile()) throw new Error('请选择普通文件。');
          state.size = stat.size;
          await s.net.upload(temp, file, progress, assertActive);
          assertActive();
          await s.net.rename(temp, remote);
        } catch (error) {
          await s.net.remove(temp).catch(() => {});
          throw error;
        } finally { await file.close(); }
      } else {
        if (s.local.entries.some(item => item.name === name)) throw new Error('本地已存在同名项目。');
        const stat = await s.net.stat(remote);
        if (classify(stat.mode) !== 'file') throw new Error('源文件已改变，请刷新。');
        state.size = stat.size;
        const temp = path.join(s.local.dir, tempName);
        const file = await fs.open(temp, 'wx', 0o600);
        try {
          try { await s.net.download(remote, file, progress, assertActive); }
          finally { await file.close(); }
          assertActive();
          // link publishes the finished file atomically and refuses replacement. FAT volumes lack hard links.
          try { await fs.link(temp, local); }
          catch (error) {
            if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS'].includes(error.code)) throw error;
            await fs.copyFile(temp, local, fs.constants.COPYFILE_EXCL);
          }
        } finally { await fs.rm(temp, { force: true }); }
      }
      return await list(s, side === 'local' ? 'remote' : 'local', side === 'local' ? s.remote.dir : s.local.dir);
    } finally { s.transfer = null; }
  }

  async function action(op, p = {}) {
    if (!p || typeof p.id !== 'string' || !/^[a-z0-9-]{12,64}$/i.test(p.id)) throw new Error('SFTP 会话编号无效。');
    if (op === 'close') { close(p.id); return; }
    if (op === 'open') {
      if (active) throw new Error('请先关闭当前 SFTP 连接。');
      const s = { id: p.id, busy: true };
      active = s;
      try {
        const net = await start(p.target);
        if (active !== s) { net.ready.catch(() => {}); net.stop(); throw new Error('连接已取消。'); }
        s.net = net;
        await net.ready;
        return await list(s, 'remote', '.');
      } catch (error) { if (active === s) close(s.id); throw error; }
      finally { s.busy = false; }
    }
    const s = current(p.id);
    if (op === 'progress') return s.transfer && { bytes: s.transfer.bytes, size: s.transfer.size };
    if (op === 'cancel') { if (s.transfer) s.transfer.canceled = true; return; }
    if (s.busy) throw new Error('请等待当前操作完成。');
    s.busy = true;
    try {
      if (op === 'choose') {
        const directory = await chooseLocal();
        if (!directory) return null;
        const root = await fs.realpath(directory);
        const result = await list(s, 'local', root, root);
        s.root = root;
        return result;
      }
      const side = p.side;
      if (!['local', 'remote'].includes(side) || !s[side]) throw new Error('请先选择目录。');
      const directory = s[side];
      const paths = side === 'local' ? path : path.posix;
      if (op === 'list') return await list(s, side, directory.dir);
      if (op === 'parent') return await list(s, side, directory.parent ? paths.dirname(directory.dir) : directory.dir);
      const name = validateName(p.name, side === 'local');
      if (op === 'enter') {
        if (!directory.entries.some(item => item.name === name && (item.kind === 'directory' || item.kind === 'link'))) throw new Error('请选择目录。');
        return await list(s, side, paths.join(directory.dir, name));
      }
      if (op === 'transfer') return await transfer(s, side, name);
      if (side === 'remote') {
        const file = paths.join(directory.dir, name);
        if (op === 'mkdir') await s.net.mkdir(file);
        else if (op === 'rename') await s.net.rename(file, paths.join(directory.dir, validateName(p.newName)));
        else if (op === 'remove') {
          const item = directory.entries.find(item => item.name === name);
          if (!item) throw new Error('请重新选择远端项目。');
          await s.net.remove(file, item.kind === 'directory');
        } else throw new Error('不支持此操作。');
        return await list(s, side, directory.dir);
      }
      throw new Error('不支持此操作。');
    } finally { s.busy = false; }
  }
  return { action, close };
}

function registerSftp({ handle, dialog, getOwner }) {
  const browser = createBrowser({ chooseLocal: async () => {
    const result = await dialog.showOpenDialog(getOwner(), { title: '选择 SFTP 本地目录', properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  } });
  handle('sftp', browser.action);
  return browser;
}
module.exports = { createBrowser, registerSftp, validateName, startConnection };

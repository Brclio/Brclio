'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { endpoint } = require('./connection.js');
const { clientFor, argumentsFor } = require('./remote-launch.cjs');
const { connectProtocol } = require('./sftp-protocol.cjs');
const { prepareAskpass } = require('./sftp-askpass.cjs');

const { transferTree, endpointIO, validateName } = require('./sftp-transfer.cjs');

async function startConnection(value, { configFile, askpass = prepareAskpass } = {}) {
  const target = endpoint(value);
  const client = clientFor('ssh',target);
  const executable = client.file;
  if (!executable) throw new Error('请安装系统 OpenSSH 客户端。');
  const auth = await askpass();
  try {
    const env = { ...process.env, SSH_ASKPASS_REQUIRE: 'force', SSH_ASKPASS: auth.file,
      DISPLAY: process.env.DISPLAY || 'brclio', BRCLIO_SFTP_TARGET: target.host };
    const args = ['-T', '-o', 'StrictHostKeyChecking=ask', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectionAttempts=1',
      '-o', 'ConnectTimeout=15', '-o', 'NumberOfPasswordPrompts=2', '-s', ...argumentsFor('ssh', target, false, {...client, env, configFile}), 'sftp'];
    if (configFile) args.unshift('-F', configFile);
    const child = spawn(executable, args, { shell: false, windowsHide: true, detached: process.platform !== 'win32',
      env, stdio: ['pipe', 'pipe', 'pipe'] });
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

const editor = require('./sftp-editor.cjs');
function createBrowser({ start = startConnection, chooseLocal, launchEditor = editor.launchEditor, chooseEditor, editorDirectory = () => null }) {
  let active = null;
  const current = id => {
    if (!active || active.id !== id) throw new Error('SFTP 会话已结束，请重新连接。');
    return active;
  };
  function close(id) {
    if (!active || (id && active.id !== id)) return;
    if (active.draft) void editor.discard(active.draft).catch(() => {});
    active.pending?.stop();
    for (const pane of Object.values(active.panes)) pane?.net?.stop();
    active = null;
  }

  async function list(s, pane, directory) {
    const io = endpointIO(pane.net);
    const dir = await io.realpath(directory);
    if (pane.net) {
      if (!dir || !dir.startsWith('/') || dir.includes('\0')) throw new Error('无效的远端目录。');
    } else {
      const rel = path.relative(pane.root, dir);
      if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('请重新选择本地根目录。');
    }
    const entries = (await io.list(dir)).filter(item => item.name && !/[\/\0]/u.test(item.name));
    entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    if (active !== s) throw new Error('SFTP 会话已关闭。');
    const view = { dir, entries, parent: pane.net ? path.posix.dirname(dir) !== dir : dir !== pane.root };
    Object.assign(pane, view);
    return view;
  }

  async function connect(s, side, target) {
    const net = await start(target);
    net.ready.catch(() => {});
    try {
      if (active !== s) throw new Error('连接已取消。');
      s.pending = net;
      await net.ready;
      const pane = { net };
      const view = await list(s, pane, '.');
      s.panes[side]?.net?.stop();
      s.panes[side] = pane;
      return view;
    } catch (error) { net.stop(); throw error; }
    finally { s.pending = null; }
  }

  async function action(op, p = {}) {
    if (!p || typeof p.id !== 'string' || !/^[a-z0-9-]{12,64}$/i.test(p.id)) throw new Error('SFTP 会话编号无效。');
    if (op === 'close') { close(p.id); return; }
    if (op === 'open' || op === 'start-local') {
      if (active) throw new Error('请先关闭当前 SFTP 连接。');
      const s = { id: p.id, busy: true, panes: {}, applications: require('./sftp-editor-preferences.cjs').preferences(editorDirectory()) };
      active = s;
      try {
        if (op === 'start-local') return;
        return await connect(s, 'remote', p.target);
      }
      catch (error) { if (active === s) close(s.id); throw error; }
      finally { s.busy = false; }
    }
    const s = current(p.id);
    if (op === 'progress') {
      if (!s.transfer) return null;
      const { bytes, size, current, files } = s.transfer;
      return { bytes, size, current, files };
    }
    if (op === 'cancel') { if (s.transfer) s.transfer.canceled = true; return; }
    if (s.busy) throw new Error('请等待当前操作完成。');
    s.busy = true;
    try {
      const check = () => { if (active !== s) throw new Error('SFTP 会话已关闭。'); };
      if (s.draft) {
        if (op === 'edit-status') return await editor.draftStamp(s.draft) !== s.draft.initialStamp;
        if (!['edit-discard', 'edit-save'].includes(op)) throw new Error('请先结束当前文件编辑。');
        const saved = op === 'edit-save' && await editor.saveDraft(s.draft, check);
        await editor.discard(s.draft);
        s.draft = null;
        return saved;
      }
      if (op === 'editor-list') return await s.applications.list();
      if (op === 'editor-forget') {
        await s.applications.set(p.extension,null);
        return await s.applications.list();
      }
      const side = p.side ?? (op === 'choose' ? 'local' : null);
      if (!['local', 'remote'].includes(side)) throw new Error('请先选择目录。');
      if (op === 'connect') return await connect(s, side, p.target);
      if (op === 'choose') {
        const directory = await chooseLocal();
        if (!directory) return null;
        const pane = { root: await fs.realpath(directory) };
        const result = await list(s, pane, pane.root);
        s.panes[side]?.net?.stop();
        s.panes[side] = pane;
        return result;
      }
      const pane = s.panes[side];
      if (!pane) throw new Error('请先选择目录。');
      const paths = pane.net ? path.posix : path;
      if (op === 'list') return await list(s, pane, pane.dir);
      if (op === 'parent') return await list(s, pane, pane.parent ? paths.dirname(pane.dir) : pane.dir);
      if (op === 'goto') {
        if (typeof p.path !== 'string' || !paths.isAbsolute(p.path) || p.path.includes('\0') || p.path.length > 4096) throw new Error('请输入完整的目录路径。');
        return await list(s, pane, p.path);
      }
      if (op === 'transfer' || op === 'native-drop') {
        let source = pane, destination = s.panes[side === 'local' ? 'remote' : 'local'], name = p.name;
        if (op === 'native-drop') {
          if (typeof p.nativePath !== 'string' || !path.isAbsolute(p.nativePath)) throw new Error('未读取到拖入的项目。');
          name = path.basename(p.nativePath);
          const dir = await fs.realpath(path.dirname(p.nativePath));
          const info = await fs.lstat(path.join(dir, name));
          const kind = info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other';
          source = { dir, entries: [{ name, kind }] };
          destination = pane;
        }
        if (!destination) throw new Error('请先选择目标目录。');
        validateName(name, !source.net || !destination.net);
        const state = { bytes: 0, files: 0, size: null, current: '', canceled: false };
        s.transfer = state;
        try {
          await transferTree(source, destination, name, state, () => {
            if (active !== s || state.canceled) throw new Error('已取消传输。');
          });
          return await list(s, destination, destination.dir);
        } finally { s.transfer = null; }
      }
      const name = validateName(p.name, !pane.net);
      if (op === 'path') {
        if (!pane.entries.some(item=>item.name===name)) throw new Error('请重新选择项目。');
        return paths.join(pane.dir,name);
      }
      if (op === 'permissions') {
        const item=pane.entries.find(item=>item.name===name);
        if (!pane.net || !['file','directory'].includes(item?.kind) || !Number.isInteger(item.mode) ||
            !Number.isInteger(p.mode) || p.mode<0 || p.mode>0o777 || p.previous!==item.mode)
          throw new Error('请选择远端文件或目录，并输入三位八进制权限。');
        const file=paths.join(pane.dir,name), attrs=await pane.net.stat(file);
        if (attrs.mode!==p.previous || await pane.net.realpath(file)!==file) throw new Error('项目或权限已变更，请刷新。');
        const mode=(attrs.mode & 0o7000) | p.mode;
        if ((attrs.mode & 0o7777)!==mode) {
          try { await pane.net.chmodNoFollow(file,mode); }
          catch (e) { if (e.sftpCode===8) throw new Error('此 SFTP 服务器不支持安全修改权限。'); throw e; }
          const actual=await pane.net.stat(file);
          if ((actual.mode & 0o7777)!==mode) throw new Error('服务器返回的权限与请求不同，请刷新查看。');
        }
        return await list(s,pane,pane.dir);
      }
      if (op === 'edit-file') {
        const ext = path.posix.extname(name).toLowerCase();
        let app = await s.applications.get(ext);
        if (p.choose === true) {
          app = await chooseEditor();
          if (!app) return false;
        }
        const draft = await editor.openDraft(pane, name, async file => {
          check(); await launchEditor(file, app);
        }, check);
        try {
          check();
          if (p.choose && app) await s.applications.set(ext, app);
          check();
          s.draft = draft;
          return true;
        } catch (error) { await editor.discard(draft); throw error; }
      }
      if (op === 'enter') {
        if (!pane.entries.some(item => item.name === name && ['directory', 'link'].includes(item.kind))) throw new Error('请选择目录。');
        return await list(s, pane, paths.join(pane.dir, name));
      }
      if (pane.net) {
        const file = paths.join(pane.dir, name);
        if (op === 'mkdir') await pane.net.mkdir(file);
        else if (op === 'rename') await pane.net.rename(file, paths.join(pane.dir, validateName(p.newName)));
        else if (op === 'remove') {
          const item = pane.entries.find(item => item.name === name);
          if (!item) throw new Error('请重新选择远端项目。');
          await pane.net.remove(file, item.kind === 'directory');
        } else throw new Error('不支持此操作。');
        return await list(s, pane, pane.dir);
      }
      throw new Error('不支持此操作。');
    } finally { s.busy = false; }
  }
  return { action, close };
}

function registerSftp({ handle, dialog, getOwner, editorDirectory }) {
  const browser = createBrowser({ editorDirectory, chooseEditor: async () => {
    const mac = process.platform === 'darwin';
    const result = await dialog.showOpenDialog(getOwner(), { title: '选择用于编辑远端文件的应用',
      ...(mac ? { defaultPath: '/Applications' } : {}), properties: ['openFile'],
      filters: [{ name: '编辑器', extensions: [mac ? 'app' : 'exe'] }] });
    if (result.canceled) return null;
    const app = result.filePaths[0];
    if (!app || !path.isAbsolute(app) || path.extname(app).toLowerCase() !== (mac ? '.app' : '.exe')) throw new Error('请选择编辑器应用。');
    return app;
  }, chooseLocal: async () => {
    const result = await dialog.showOpenDialog(getOwner(), { title: '选择 SFTP 本地目录', properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  } });
  handle('sftp', (op, payload) => {
    if (op === 'native-drop') throw new Error('请从系统文件管理器拖入项目。');
    return browser.action(op, payload);
  });
  handle('sftp-drop', payload => browser.action('native-drop', payload));
  return browser;
}
module.exports = { createBrowser, registerSftp, validateName, startConnection };

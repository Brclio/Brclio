'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const IDENTIFIER = 'com.brclio.toolbox.finder-sync';
const BUNDLE_NAME = 'BrclioFinderSync.appex';
const PLUGINKIT = '/usr/bin/pluginkit';

function registrations(stdout) {
  return String(stdout || '').split(/\r?\n/).flatMap(line => {
    const fields = line.split('\t');
    const entry = fields[0].match(/^([+!\- ])\s*com\.brclio\.toolbox\.finder-sync\(([^)]+)\)/);
    return entry && fields.length >= 4 ? [{ election: entry[1], version: entry[2], location: fields[fields.length - 1] }] : [];
  });
}

function createFinderExtension({ launch, run }) {
  const application = launch.packaged && path.basename(path.dirname(launch.executable)) === 'MacOS'
    ? path.resolve(path.dirname(launch.executable), '..', '..') : null;
  const location = application?.endsWith('.app') ? path.join(application, 'Contents', 'PlugIns', BUNDLE_NAME) : null;
  async function status() {
    const available = Boolean(location && await fs.stat(location).then(stats => stats.isDirectory(), () => false));
    if (!available) return { installed: false, supported: true, available: false, requiresInstall: true,
      menuLabel: '复制路径 · Brclio', kind: 'finder-extension', location,
      description: '请先安装包含 Finder 扩展的 Brclio 新版，再启用右键菜单。' };
    let found = [];
    let queryError = false;
    try { found = registrations((await run(PLUGINKIT, ['-m', '-A', '-D', '-v', '-i', IDENTIFIER])).stdout); }
    catch (error) { queryError = error.code !== 1; }
    const own = found.find(entry => path.resolve(entry.location) === location);
    const installed = own?.election === '+';
    return { installed, supported: true, available: true, kind: 'finder-extension', location,
      registered: Boolean(own), stale: !own && found.some(entry => entry.election === '+'),
      awaitingApproval: Boolean(own && !installed), menuLabel: '复制路径 · Brclio',
      description: installed ? '在 Finder 右键菜单中直接选择“复制路径 · Brclio”；文件夹空白处可复制当前文件夹路径。'
        : queryError ? '暂时无法读取 Finder 扩展状态，请重新启用。'
        : '启用 Finder 扩展后，右键菜单会直接显示“复制路径 · Brclio”。如未生效，请在系统设置的 Finder 扩展中允许 Brclio。' };
  }
  async function set(enabled) {
    if (!enabled) {
      try { await run(PLUGINKIT, ['-e', 'ignore', '-i', IDENTIFIER]); }
      catch (error) { if (error.code !== 1) throw error; }
      return status();
    }
    const before = await status();
    if (!before.available) throw new Error('请先安装包含 Finder 扩展的 Brclio 新版，开发预览无法添加系统菜单。');
    await run(PLUGINKIT, ['-a', location]);
    await run(PLUGINKIT, ['-e', 'use', '-i', IDENTIFIER]);
    return status();
  }
  return { status, set };
}

module.exports = { createFinderExtension, registrations, IDENTIFIER, BUNDLE_NAME };

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { launchCommand } = require('./arguments.cjs');
const { createFinderExtension } = require('./finder-extension.cjs');

const OWNER = 'com.brclio.toolbox';
const MENU_LABEL = '复制路径 · Brclio';
const WORKFLOW_NAME = 'Brclio Copy Path.workflow';
const REGISTRY_KEYS = [
  { key: 'HKCU\\Software\\Classes\\*\\shell\\Brclio.CopyPath', argument: '%1' },
  // Append \\. so a drive root never ends in a backslash before the closing quote.
  { key: 'HKCU\\Software\\Classes\\Directory\\shell\\Brclio.CopyPath', argument: '%1\\.' },
  { key: 'HKCU\\Software\\Classes\\Directory\\Background\\shell\\Brclio.CopyPath', argument: '%V\\.' },
];

function xml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
}

function plist(value) {
  function encode(item) {
    if (typeof item === 'boolean') return item ? '<true/>' : '<false/>';
    if (typeof item === 'number') return `<integer>${item}</integer>`;
    if (Array.isArray(item)) return `<array>${item.map(encode).join('')}</array>`;
    if (item && typeof item === 'object') return `<dict>${Object.entries(item).map(([key, val]) => `<key>${xml(key)}</key>${encode(val)}`).join('')}</dict>`;
    return `<string>${xml(item)}</string>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${encode(value)}</plist>\n`;
}

function macWorkflow(launch) {
  const command = `exec ${launchCommand(launch, 'darwin')} --copy-path -- "$@"`;
  const document = plist({
    AMApplicationBuild: '523', AMApplicationVersion: '2.10', AMDocumentVersion: '2',
    actions: [{ action: {
      ActionBundlePath: '/System/Library/Automator/Run Shell Script.action',
      ActionName: 'Run Shell Script',
      ActionParameters: { CheckedForUserDefaultShell: true, COMMAND_STRING: command, inputMethod: 1, shell: '/bin/sh', source: command },
      AMAccepts: { Container: 'List', Optional: true, Types: ['com.apple.cocoa.string'] },
      AMActionVersion: '2.0.3', AMParameterProperties: {},
      AMProvides: { Container: 'List', Types: ['com.apple.cocoa.string'] },
      Application: ['Automator'], arguments: {}, BundleIdentifier: 'com.apple.RunShellScript',
      CanShowSelectedItemsWhenRun: false, CanShowWhenRun: true, Category: ['AMCategoryUtilities'],
      CFBundleVersion: '2.0.3', 'Class Name': 'RunShellScriptAction',
      InputUUID: '0B93C6D2-D0CC-4D3C-B94E-CCB0B92CC9BC',
      OutputUUID: '9DC82C48-4C5B-43F7-A1F8-A429ED410E0F',
      UUID: '94D0EDAB-246B-4397-8DEE-6A40C113B05A', isViewVisible: true,
    } }],
    connectors: {}, workflowMetaData: {
      serviceApplicationBundleID: 'com.apple.finder',
      serviceApplicationPath: '/System/Library/CoreServices/Finder.app',
      serviceInputTypeIdentifier: 'com.apple.Automator.fileSystemObject',
      serviceOutputTypeIdentifier: 'com.apple.Automator.nothing', serviceProcessesInput: 0,
      workflowTypeIdentifier: 'com.apple.Automator.servicesMenu',
    },
  });
  const info = plist({
    CFBundleDevelopmentRegion: 'zh_CN', CFBundleIdentifier: `${OWNER}.copy-path-service`,
    CFBundleName: WORKFLOW_NAME.replace('.workflow', ''), CFBundleShortVersionString: '1.0',
    NSServices: [{ NSMenuItem: { default: MENU_LABEL }, NSMessage: 'runWorkflowAsService',
      NSRequiredContext: { NSApplicationIdentifier: 'com.apple.finder' }, NSSendFileTypes: ['public.item'] }],
  });
  return { command, document, info };
}

function windowsEntries(launch) {
  const command = launchCommand(launch, 'win32');
  return REGISTRY_KEYS.map(entry => ({ ...entry, command: `${command} --copy-path -- "${entry.argument}"` }));
}

function createIntegration(options) {
  const platform = options.platform || process.platform;
  const home = options.home || os.homedir();
  const launch = options.launch;
  const run = options.run || ((executable, args) => promisify(execFile)(executable, args, { windowsHide: true, timeout: 15000, maxBuffer: 256 * 1024 }));
  const registry = options.registry || path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const workflowPath = path.join(home, 'Library', 'Services', WORKFLOW_NAME);
  const markerPath = path.join(workflowPath, 'Contents', 'brclio-owner.json');
  const entries = windowsEntries(launch);
  let pending = Promise.resolve();
  const finder = platform === 'darwin' ? createFinderExtension({ launch, run }) : null;

  async function query(key, name) {
    try {
      const result = await run(registry, ['query', key, ...(name ? ['/v', name] : ['/ve'])]);
      return result.stdout.match(/REG_SZ\s+(.*)/)?.[1]?.trim() ?? null;
    } catch (error) {
      if (error.code === 1) return null;
      throw error;
    }
  }
  async function keyExists(key) {
    try { await run(registry, ['query', key]); return true; }
    catch (error) { if (error.code === 1) return false; throw error; }
  }
  async function readMarker() {
    try { return JSON.parse(await fs.readFile(markerPath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  }
  async function status() {
    if (platform === 'win32') {
      const found = await Promise.all(entries.map(async entry => ({
        owner: await query(entry.key, 'BrclioOwner'), command: await query(`${entry.key}\\command`),
      })));
      const owned = found.every(item => item.owner === OWNER);
      const installed = owned && found.every((item, index) => item.command === entries[index].command);
      return { installed, supported: true, stale: owned && !installed, menuLabel: MENU_LABEL,
        description: installed ? '已添加文件、文件夹和文件夹空白处菜单。Windows 11 请在“显示更多选项”中使用。' : '启用后可在资源管理器右键复制路径；Windows 11 位于“显示更多选项”。' };
    }
    if (platform === 'darwin') {
      const marker = await readMarker();
      return { ...await finder.status(), legacyServiceInstalled: marker?.owner === OWNER };
    }
    return { installed: false, supported: false, description: '此平台暂无系统右键集成，可在软件中选择路径并复制。' };
  }

  async function updateMacServices() {
    try {
      // Public AppKit API; no Finder restart or Apple Events automation permission.
      await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', "ObjC.import('AppKit'); $.NSUpdateDynamicServices();"]);
    } catch { /* macOS also discovers ~/Library/Services when its menus refresh. */ }
  }

  async function setWindows(enabled) {
    // Refuse to replace or remove a key that belongs to another application.
    const snapshots = [];
    for (const entry of entries) {
      const exists = await keyExists(entry.key);
      const owner = await query(entry.key, 'BrclioOwner');
      if (exists && owner !== OWNER) {
        throw new Error('发现不属于 Brclio 的同名右键菜单，已保留原有设置。');
      }
      snapshots.push({ exists, owner, label: await query(entry.key), icon: await query(entry.key, 'Icon'),
        model: await query(entry.key, 'MultiSelectModel'), command: await query(`${entry.key}\\command`) });
    }
    if (!enabled) {
      for (const entry of entries) if (await query(entry.key, 'BrclioOwner') === OWNER) await run(registry, ['delete', entry.key, '/f']);
      return status();
    }
    try {
      for (const entry of entries) {
        await run(registry, ['add', entry.key, '/v', 'BrclioOwner', '/t', 'REG_SZ', '/d', OWNER, '/f']);
        await run(registry, ['add', entry.key, '/ve', '/t', 'REG_SZ', '/d', MENU_LABEL, '/f']);
        await run(registry, ['add', entry.key, '/v', 'Icon', '/t', 'REG_SZ', '/d', launch.executable, '/f']);
        // Avoid multiple independent launches racing to overwrite the clipboard.
        await run(registry, ['add', entry.key, '/v', 'MultiSelectModel', '/t', 'REG_SZ', '/d', 'Single', '/f']);
        await run(registry, ['add', `${entry.key}\\command`, '/ve', '/t', 'REG_SZ', '/d', entry.command, '/f']);
      }
    } catch (error) {
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]; const previous = snapshots[index];
        if (await query(entry.key, 'BrclioOwner') !== OWNER) continue;
        if (!previous.exists) { await run(registry, ['delete', entry.key, '/f']).catch(() => {}); continue; }
        for (const [key, name, value] of [
          [entry.key, null, previous.label], [entry.key, 'Icon', previous.icon],
          [entry.key, 'MultiSelectModel', previous.model], [`${entry.key}\\command`, null, previous.command],
        ]) {
          const selector = name ? ['/v', name] : ['/ve'];
          await run(registry, value === null ? ['delete', key, ...selector, '/f'] : ['add', key, ...selector, '/t', 'REG_SZ', '/d', value, '/f']).catch(() => {});
        }
      }
      throw error;
    }
    return status();
  }

  async function setMacService(enabled) {
    const marker = await readMarker();
    const exists = await fs.lstat(workflowPath).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (exists && marker?.owner !== OWNER) throw new Error('发现不属于 Brclio 的同名快速操作，已保留原文件。');
    if (!enabled) {
      if (marker?.owner === OWNER) await fs.rm(workflowPath, { recursive: true, force: true });
      await updateMacServices();
      return status();
    }
    const workflow = macWorkflow(launch);
    const staging = `${workflowPath}.install-${process.pid}`;
    const backup = `${workflowPath}.backup-${process.pid}`;
    await fs.mkdir(path.dirname(workflowPath), { recursive: true });
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(path.join(staging, 'Contents'), { recursive: true });
    await fs.writeFile(path.join(staging, 'Contents', 'document.wflow'), workflow.document);
    await fs.writeFile(path.join(staging, 'Contents', 'Info.plist'), workflow.info);
    await fs.writeFile(path.join(staging, 'Contents', 'brclio-owner.json'), JSON.stringify({ owner: OWNER, version: 1 }));
    try {
      if (exists) await fs.rename(workflowPath, backup);
      await fs.rename(staging, workflowPath);
      await fs.rm(backup, { recursive: true, force: true });
    } catch (error) {
      if (exists) await fs.rename(backup, workflowPath).catch(() => {});
      throw error;
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
    await updateMacServices();
    return status();
  }

  async function setMac(enabled) {
    const result = await finder.set(enabled);
    // Only remove our marked legacy workflow after enabling the direct menu,
    // or when the user disables integration. Other Services are preserved.
    if (!enabled || result.installed) {
      if ((await readMarker())?.owner === OWNER) await setMacService(false);
    }
    return status();
  }

  function set(enabled) {
    if (typeof enabled !== 'boolean') return Promise.reject(new TypeError('右键集成开关必须为布尔值。'));
    const operation = pending.then(() => platform === 'win32' ? setWindows(enabled) : platform === 'darwin' ? setMac(enabled) : status());
    pending = operation.catch(() => {});
    return operation;
  }
  return { status, set };
}

module.exports = { createIntegration, macWorkflow, windowsEntries, OWNER, WORKFLOW_NAME, REGISTRY_KEYS };

'use strict';

const nativeFS = process.versions.electron ? require('original-fs') : require('node:fs');
const fs = nativeFS.promises;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { VERSION, defaultRun, verifyBundle, guiEnvironment, identity } = require('../desktop/mac-installer-helper.cjs');
const { createMacInstaller } = require('../desktop/mac-installer.cjs');
const { createWindowsInstaller, LAUNCHER } = require('../desktop/windows-installer.cjs');
const { compareVersions } = require('../desktop/updater.cjs');

const products = Object.freeze({
  brclio: { name: 'Brclio', prefix: 'Brclio', id: 'com.brclio.toolbox', guid: 'c8f079c5-a346-5aee-a72f-5280717e7b26' },
  downloader: { name: 'Brclio Downloader', prefix: 'Brclio-Downloader', id: 'com.brclio.downloader', guid: '6aae18b5-b2c5-5fd1-9b91-8184c8766ad1' },
});
function productInfo(product) {
  if (!Object.hasOwn(products, product)) throw new Error('未知的安装产品。');
  return products[product];
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const powershell = () => path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

async function verifyPackage(descriptor, platform, arch) {
  const { filename, size, version, expected, product } = descriptor;
  const info = productInfo(product);
  const suffix = platform === 'darwin' && ['arm64','x64'].includes(arch) ? 'mac-' + arch + '.dmg'
    : platform === 'win32' && arch === 'x64' ? 'windows-x64.exe' : '';
  if (!suffix || !VERSION.test(version || '') || !/^[a-f0-9]{64}$/.test(expected || '') ||
      !Number.isSafeInteger(size) || size < 1 || !path.isAbsolute(filename) ||
      path.basename(filename) !== info.prefix + '-' + version + '-' + suffix) throw new Error('安装包与当前产品、版本或架构不符。');
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.size !== size) throw new Error('安装包大小或文件类型已改变。');
  const hash = crypto.createHash('sha256');
  for await (const chunk of nativeFS.createReadStream(filename)) hash.update(chunk);
  if (hash.digest('hex') !== expected) throw new Error('安装包 SHA-256 不匹配，请重新下载。');
}

function macDirs(options) {
  return options.macDirectories || [path.join(os.homedir(), 'Applications'), '/Applications'];
}

async function registeredMacApplication(id, run) {
  const script = `ObjC.import('AppKit'); function run(args) {
    const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(args[0]);
    return url && !url.isNil() ? url.path.js : '';
  }`;
  const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, id]);
  return stdout.trim();
}

async function macInfo(bundle, info, run) {
  if (!(await fs.lstat(bundle)).isDirectory()) throw new Error('应用程序目录无效。');
  const plist = path.join(bundle, 'Contents', 'Info.plist');
  const { stdout } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]);
  const data = JSON.parse(stdout);
  if (data.CFBundleIdentifier !== info.id || data.CFBundlePackageType !== 'APPL' ||
      !VERSION.test(data.CFBundleShortVersionString || '') || typeof data.CFBundleExecutable !== 'string' ||
      !data.CFBundleExecutable || /[\/\\\x00-\x1f]/.test(data.CFBundleExecutable) || ['.', '..'].includes(data.CFBundleExecutable)) {
    throw new Error('应用身份与 ' + info.name + ' 不符，已停止安装。');
  }
  const executable = path.join(bundle, 'Contents', 'MacOS', data.CFBundleExecutable);
  if (!(await fs.lstat(executable)).isFile() ||
      !(await fs.realpath(executable)).startsWith((await fs.realpath(bundle)) + path.sep)) throw new Error('应用可执行文件无效。');
  return { path: bundle, version: data.CFBundleShortVersionString, executable };
}

// The registry includes the installation chosen in the NSIS directory picker.
const REGISTRY_QUERY = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$result = @()
foreach ($base in @([Microsoft.Win32.Registry]::CurrentUser, [Microsoft.Win32.Registry]::LocalMachine)) {
  $key = $base.OpenSubKey('Software\' + $env:BRCLIO_INSTALL_GUID)
  if ($null -eq $key) { continue }
  try { $location = $key.GetValue('InstallLocation') } finally { $key.Dispose() }
  if ([string]::IsNullOrWhiteSpace($location)) { continue }
  $exe = Join-Path $location ($env:BRCLIO_INSTALL_NAME + '.exe')
  $file = Get-Item -LiteralPath $exe
  if ($file.VersionInfo.ProductName -cne $env:BRCLIO_INSTALL_NAME) { throw 'Unexpected installed application identity.' }
  $version = $file.VersionInfo.ProductVersion
  if ($version -notmatch '^(\d+\.\d+\.\d+)(?:\.0)?$') { throw 'Unexpected installed application version.' }
  $result += @{ path=$file.FullName; version=$Matches[1] }
}
if ($result.Count -gt 1) { throw 'Multiple NSIS installations exist. Keep one installation and retry.' }
if ($result.Count -eq 1) { ConvertTo-Json -Compress $result[0] }
`;

async function getInstalled(product, options = {}) {
  const info = productInfo(product);
  const run = options.run || defaultRun;
  const platform = options.platform || process.platform;
  if (platform === 'darwin') {
    const candidates = macDirs(options).map(dir => path.join(dir, info.name + '.app'));
    if (product === 'downloader') {
      const executable = options.executable || process.execPath;
      const running = path.resolve(executable, '..', '..', '..');
      if (path.basename(running) === info.name + '.app' && !running.startsWith('/Volumes/') && !running.includes('/AppTranslocation/')) candidates.unshift(running);
    }
    for (const bundle of new Set(candidates)) {
      try { await fs.lstat(bundle); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      return macInfo(bundle, info, run);
    }
    // Explicit directories scope isolated installs. On a user's Mac, the
    // Launch Services registry also includes bundles moved outside Applications.
    if (options.macDirectories && !options.registeredMacApplication) return null;
    const locate = options.registeredMacApplication || registeredMacApplication;
    const bundle = await locate(info.id, run);
    if (!path.isAbsolute(bundle) || !bundle.endsWith('.app') || bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) return null;
    try { await fs.lstat(bundle); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    return macInfo(bundle, info, run);
  }
  if (platform === 'win32') {
    const { stdout } = await run(powershell(), ['-NoProfile', '-NonInteractive', '-Command', REGISTRY_QUERY], {
      env: { ...process.env, BRCLIO_INSTALL_GUID: info.guid, BRCLIO_INSTALL_NAME: info.name }, windowsHide: true,
    });
    return stdout.trim() ? JSON.parse(stdout.trim()) : null;
  }
  throw new Error('目前仅支持 macOS 和 Windows 桌面安装包。');
}

async function launch(installed, options) {
  const platform = options.platform || process.platform;
  if (platform === 'darwin') await (options.run || defaultRun)('/usr/bin/open', ['-a', installed.path], { env: guiEnvironment() });
  else {
    const child = (options.spawn || spawn)(installed.path, [], { detached: true, stdio: 'ignore', env: guiEnvironment() });
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
    child.unref();
  }
}

async function openInstalled(product, options = {}) {
  const installed = await getInstalled(product, options);
  if (!installed) throw new Error('尚未找到已安装的应用。');
  await launch(installed, options);
  return installed;
}

async function quitBrclio(installed, options) {
  const run = options.run || defaultRun;
  if ((options.platform || process.platform) === 'darwin') {
    const script = `ObjC.import('AppKit'); function run(argv) {
      const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.brclio.toolbox').js.filter(a => a.bundleURL.path.js === argv[0]);
      apps.forEach(a => a.terminate);
      for (let n = 0; n < 300 && apps.some(a => !a.terminated); n++) delay(0.1);
      if (apps.some(a => !a.terminated)) throw Error('请退出正在运行的 Brclio 后重试。');
    }`;
    await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, installed.path], { timeout: 40000 });
  } else {
    const script = `$ErrorActionPreference='Stop'
    foreach ($p in @(Get-Process -Name Brclio -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $env:BRCLIO_TARGET_EXE -and $_.MainWindowHandle -ne 0 })) {
      [void]$p.CloseMainWindow()
      if (-not $p.WaitForExit(30000)) { throw 'Please close Brclio and retry.' }
    }`;
    await run(powershell(), ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 40000, windowsHide: true, env: { ...process.env, BRCLIO_TARGET_EXE: installed.path },
    });
  }
}

async function upgradeBrclio(installed, descriptor, options) {
  const mac = (options.platform || process.platform) === 'darwin';
  const appData = options.appData || (mac ? path.join(os.homedir(), 'Library', 'Application Support') : process.env.APPDATA);
  const settings = { executable: installed.executable || installed.path, userData: path.join(appData, products.brclio.id), helperExecutable: process.execPath };
  await quitBrclio(installed, options);
  try {
    const installer = mac ? createMacInstaller(settings) : createWindowsInstaller(settings);
    await installer.start(descriptor);
    return { handoff: true };
  } catch (error) {
    await launch(installed, options).catch(() => {});
    throw error;
  }
}

async function verifyMacCandidate(bundle, descriptor, job, options) {
  const run = options.run || defaultRun;
  const arch = options.arch || process.arch;
  const cfg = { job, version: descriptor.version, architecture: arch };
  if (descriptor.product === 'brclio') return verifyBundle(bundle, cfg, run);
  const installed = await macInfo(bundle, products.downloader, run);
  if (installed.version !== descriptor.version) throw new Error('下载器应用版本与发布文件不符。');
  const architectures = (await run('/usr/bin/lipo', ['-archs', installed.executable])).stdout.trim().split(/\s+/);
  if (!architectures.includes(arch === 'arm64' ? 'arm64' : 'x86_64')) throw new Error('下载器架构不符。');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
}

async function installMac(descriptor, installed, options) {
  const info = productInfo(descriptor.product);
  const target = installed?.path || path.join(macDirs(options)[0], info.name + '.app');
  const run = options.run || defaultRun;
  await fs.mkdir(path.dirname(target), { recursive: true });
  const stage = await fs.mkdtemp(path.join(path.dirname(target), '.brclio-bootstrap-'));
  const mounted = path.join(stage, 'mount');
  const next = path.join(stage, 'next.app');
  let attached = false, keep = false;
  try {
    await fs.mkdir(mounted, { mode: 0o700 });
    await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-noautoopen', '-readonly', '-mountpoint', mounted, descriptor.filename], { timeout: 120000 });
    attached = true;
    const apps = (await fs.readdir(mounted, { withFileTypes: true })).filter(file => file.name.endsWith('.app'));
    if (apps.length !== 1 || apps[0].name !== info.name + '.app' || !apps[0].isDirectory()) throw new Error('安装包中没有唯一匹配的应用。');
    await run('/usr/bin/ditto', ['--rsrc', '--extattr', '--acl', path.join(mounted, apps[0].name), next], { timeout: 300000 });
    await verifyMacCandidate(next, descriptor, stage, options);
    await run('/usr/bin/hdiutil', ['detach', mounted]);
    attached = false;
    if (descriptor.product === 'downloader') {
      const oldId = installed ? identity(await fs.lstat(target)) : '-';
      const script = path.join(stage, 'replace.sh');
      await fs.writeFile(script, await require('node:fs/promises').readFile(path.join(__dirname, 'replace-mac.sh')), { mode: 0o600 });
      const log = await fs.open(path.join(stage, 'replace.log'), 'a', 0o600);
      try {
        const child = spawn('/bin/sh', [script, String(process.pid), stage, target, oldId], { detached: true, stdio: ['ignore', log.fd, log.fd] });
        await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
        child.unref(); keep = true;
      } finally { await log.close(); }
      return { handoff: true };
    }
    // Reserve the destination before replacing the empty directory. Never
    // overwrite a bundle created by another installer while mounting the DMG.
    await fs.mkdir(target, { mode: 0o755 });
    try { await fs.rename(next, target); }
    catch (error) { await fs.rmdir(target).catch(() => {}); throw error; }
    await launch({ path: target }, options);
    return { handoff: false };
  } finally {
    if (attached) {
      try { await run('/usr/bin/hdiutil', ['detach', mounted]); attached = false; } catch {}
    }
    if (!attached && !keep) await fs.rm(stage, { recursive: true, force: true });
  }
}

async function windowsSelfUpgrade(descriptor, options, existingVersion) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-bootstrap-'));
  const config = path.join(work, 'config.json');
  const ready = path.join(work, 'ready');
  let transferred = false;
  try {
    const file = await require('node:fs/promises').readFile(path.join(__dirname, 'replace-win.ps1'));
    await fs.writeFile(path.join(work, 'install.ps1'), file);
    await fs.writeFile(path.join(work, 'launch.ps1'), LAUNCHER);
    await fs.writeFile(config, JSON.stringify({ ...descriptor, parentPid: process.pid, guid: products.downloader.guid, existingVersion }));
    await (options.run || defaultRun)(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(work, 'launch.ps1'), '-Configuration', config], { windowsHide: true });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try { await fs.access(ready); transferred = true; return { handoff: true }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await pause(100);
    }
    throw new Error('下载器升级助手启动超时。');
  } finally { if (!transferred) await fs.rm(work, { recursive: true, force: true }); }
}

async function installAndOpen(descriptor, options = {}) {
  const { product, version } = descriptor;
  const platform = options.platform || process.platform;
  await verifyPackage(descriptor, platform, options.arch || process.arch);
  const installed = await getInstalled(product, options);
  if (installed && compareVersions(installed.version, version) >= 0) {
    // An older copy opened from a DMG/Downloads may discover a newer installed
    // downloader. Release its single-instance lock before opening that copy.
    if (product === 'downloader') {
      if (platform === 'win32') return windowsSelfUpgrade(descriptor, options, installed.version);
      const waitAndOpen = 'while /bin/kill -0 "$1" 2>/dev/null; do /bin/sleep 1; done; exec /usr/bin/open -a "$2"';
      const child = spawn('/bin/sh', ['-c', waitAndOpen, 'brclio', String(process.pid), installed.path], { detached:true, stdio:'ignore' });
      await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
      child.unref();
      return { handoff:true };
    }
    await launch(installed, options);
    return { handoff: false };
  }
  if (installed && product === 'brclio') return upgradeBrclio(installed, descriptor, options);
  if (platform === 'darwin') return installMac(descriptor, installed, options);
  if (product === 'downloader') return windowsSelfUpgrade(descriptor, options);
  await (options.run || defaultRun)(descriptor.filename, ['/S', '/currentuser'], { timeout: 900000, windowsHide: true });
  const result = await getInstalled(product, options);
  if (!result || result.version !== version) throw new Error('安装程序退出后未找到目标版本的 Brclio。');
  await launch(result, options);
  return { handoff: false };
}

module.exports = { getInstalled, openInstalled, installAndOpen };

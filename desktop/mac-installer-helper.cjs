'use strict';

// This file is copied outside the application before it starts. Load every
// dependency before the old bundle moves, and never load code from it later.
const nativeFS = process.versions.electron ? require('original-fs') : require('node:fs');
const fs = nativeFS.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const APP_ID = 'com.brclio.toolbox';
const EXTENSION_ID = APP_ID + '.finder-sync';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const identity = stat => `${stat.dev}:${stat.ino}`;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const defaultRun = (command, args, options = {}) => execute(command, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...options });
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !/[\0\r\n]/.test(value);

function guiEnvironment(source = process.env) {
  const result = { ...source };
  for (const key of Object.keys(result)) {
    if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD'].includes(key) || key.startsWith('DYLD_')) delete result[key];
  }
  return result;
}

async function atomicJSON(filename, value, fileSystem = fs) {
  const temporary = `${filename}.${crypto.randomBytes(8).toString('hex')}.next`;
  try {
    await fileSystem.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await fileSystem.rename(temporary, filename);
  } finally { await fileSystem.rm(temporary, { force: true }).catch(() => {}); }
}

async function privateJSON(filename, fileSystem = fs, limit = 32768) {
  const stat = await fileSystem.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit
      || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('更新记录的类型或权限无效。');
  const handle = await fileSystem.open(filename, nativeFS.constants.O_RDONLY | (nativeFS.constants.O_NOFOLLOW || 0));
  try {
    if (identity(await handle.stat()) !== identity(stat)) throw new Error('更新记录已被替换。');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}

async function bundleInfo(bundle, run = defaultRun) {
  const info = JSON.parse((await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(bundle, 'Contents', 'Info.plist')])).stdout);
  if (info.CFBundleIdentifier !== APP_ID || info.CFBundlePackageType !== 'APPL' || !VERSION.test(info.CFBundleShortVersionString || '')
      || typeof info.CFBundleExecutable !== 'string' || !info.CFBundleExecutable || /[\/\\\0\r\n]/.test(info.CFBundleExecutable)
      || ['.', '..'].includes(info.CFBundleExecutable)) throw new Error('应用身份或版本无效，已停止覆盖安装。');
  return info;
}

async function verifyBundle(bundle, configuration, run = defaultRun, fileSystem = fs, scratch = configuration.job) {
  const stat = await fileSystem.lstat(bundle);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('安装包中的应用目录无效。');
  const info = await bundleInfo(bundle, run);
  if (info.CFBundleShortVersionString !== configuration.version) throw new Error('安装包中的版本与更新版本不一致。');
  const executable = path.join(bundle, 'Contents', 'MacOS', info.CFBundleExecutable);
  const executableStat = await fileSystem.lstat(executable);
  if (!executableStat.isFile() || executableStat.isSymbolicLink() || !(await fileSystem.realpath(executable)).startsWith((await fileSystem.realpath(bundle)) + path.sep)) throw new Error('应用可执行文件位置无效。');
  const expectedArch = configuration.architecture === 'x64' ? 'x86_64' : 'arm64';
  const architectures = (await run('/usr/bin/lipo', ['-archs', executable])).stdout.trim().split(/\s+/);
  if (!architectures.includes(expectedArch)) throw new Error('安装包处理器架构不匹配。');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle]);
  const applicationSignature = await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle]);
  const applicationDescription = (applicationSignature.stderr || '') + (applicationSignature.stdout || '');
  if (!/^Identifier=com\.brclio\.toolbox$/m.test(applicationDescription) || !/^Sealed Resources version=2\b/m.test(applicationDescription)
      || !/^Info\.plist entries=\d+/m.test(applicationDescription)) throw new Error('应用签名身份或完整资源封印无效。');
  const extension = path.join(bundle, 'Contents', 'PlugIns', 'BrclioFinderSync.appex');
  const extensionStat = await fileSystem.lstat(extension);
  if (!extensionStat.isDirectory() || extensionStat.isSymbolicLink()) throw new Error('Finder 扩展目录无效。');
  const extensionInfo = JSON.parse((await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(extension, 'Contents', 'Info.plist')])).stdout);
  if (extensionInfo.CFBundleIdentifier !== EXTENSION_ID || extensionInfo.CFBundlePackageType !== 'XPC!'
      || extensionInfo.CFBundleShortVersionString !== configuration.version || extensionInfo.CFBundleVersion !== info.CFBundleVersion
      || extensionInfo.CFBundleExecutable !== 'BrclioFinderSync' || extensionInfo.NSExtension?.NSExtensionPointIdentifier !== 'com.apple.FinderSync'
      || extensionInfo.NSExtension?.NSExtensionPrincipalClass !== 'BrclioFinderSync.FinderSync') throw new Error('Finder 扩展身份或版本不匹配。');
  const extensionExecutable = path.join(extension, 'Contents', 'MacOS', 'BrclioFinderSync');
  const extensionExecutableStat = await fileSystem.lstat(extensionExecutable);
  if (!extensionExecutableStat.isFile() || extensionExecutableStat.isSymbolicLink()) throw new Error('Finder 扩展可执行文件无效。');
  if (!(await run('/usr/bin/lipo', ['-archs', extensionExecutable])).stdout.trim().split(/\s+/).includes(expectedArch)) throw new Error('Finder 扩展处理器架构不匹配。');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', extension]);
  const extensionSignature = await run('/usr/bin/codesign', ['-d', '--verbose=4', extension]);
  const extensionDescription = (extensionSignature.stderr || '') + (extensionSignature.stdout || '');
  const team = description => /^TeamIdentifier=(.+)$/m.exec(description)?.[1];
  if (!/^Identifier=com\.brclio\.toolbox\.finder-sync$/m.test(extensionDescription) || !/^Sealed Resources version=2\b/m.test(extensionDescription)
      || !/^Info\.plist entries=\d+/m.test(extensionDescription) || !team(applicationDescription) || team(applicationDescription) !== team(extensionDescription)
      || /^Signature=adhoc$/m.test(applicationDescription) !== /^Signature=adhoc$/m.test(extensionDescription)) throw new Error('Finder 扩展签名身份或签名方式不匹配。');
  const signed = await run('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', extension]);
  const entitlementFile = path.join(scratch, `entitlements-${crypto.randomBytes(8).toString('hex')}.plist`);
  try {
    await fileSystem.writeFile(entitlementFile, signed.stdout, { flag: 'wx', mode: 0o600 });
    const entitlements = JSON.parse((await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', entitlementFile])).stdout);
    if (entitlements['com.apple.security.app-sandbox'] !== true || entitlements['com.apple.security.files.user-selected.read-only'] !== true
        || entitlements['com.apple.security.inherit'] === true) throw new Error('Finder 扩展沙盒签名无效。');
  } finally { await fileSystem.rm(entitlementFile, { force: true }).catch(() => {}); }
  return { info, executable, identity: identity(stat) };
}

function validateConfiguration(value, job) {
  if (!value || value.schemaVersion !== 1 || value.appId !== APP_ID || !VERSION.test(value.version || '')
      || !['arm64', 'x64'].includes(value.architecture) || !/^[a-f0-9]{64}$/.test(value.token || '')
      || !Number.isSafeInteger(value.parentPid) || value.parentPid <= 1 || !absolute(value.current) || !value.current.endsWith('.app')
      || !absolute(value.job) || value.job !== job || !/^mac-[a-f0-9-]{36}$/.test(path.basename(job))) throw new Error('更新任务配置无效。');
  const parent = path.dirname(value.current);
  if (!absolute(value.stageDirectory) || path.dirname(value.stageDirectory) !== parent || !/^\.brclio-update-[a-zA-Z0-9]{6}$/.test(path.basename(value.stageDirectory))) throw new Error('更新暂存位置无效。');
  const expected = {
    staged: path.join(value.stageDirectory, 'next.app'), backup: path.join(value.stageDirectory, 'previous-bundle'), failed: path.join(value.stageDirectory, 'failed-bundle'),
    readyPath: path.join(job, 'ready.json'), commitPath: path.join(job, 'commit.json'), cancelPath: path.join(job, 'cancel'), ackPath: path.join(job, 'launch-ack.json'),
    resultPath: path.join(path.dirname(path.dirname(job)), 'mac-install-result.json'),
    lockPath: path.join(parent, `.brclio-update-${crypto.createHash('sha256').update(value.current).digest('hex').slice(0, 16)}.lock`),
  };
  if (Object.entries(expected).some(([key, filename]) => value[key] !== filename)
      || ![value.currentIdentity, value.stagedIdentity, value.stageIdentity].every(item => /^\d+:\d+$/.test(item || ''))
      || !/^[a-f0-9]{64}$/.test(value.currentInfoHash || '')) throw new Error('更新任务路径或文件身份无效。');
  if (value.guiUserData !== undefined && (!absolute(value.guiUserData) || path.join(value.guiUserData, 'updates', 'install-jobs') !== path.dirname(job))) throw new Error('更新客户端资料目录无效。');
  for (const key of ['startupTimeout', 'parentTimeout', 'commitTimeout']) if (!Number.isSafeInteger(value[key]) || value[key] < 50 || value[key] > 300000) throw new Error('更新等待时间无效。');
  return value;
}

async function runHelper(configurationPath, dependencies = {}) {
  const fileSystem = dependencies.fs || fs;
  const run = dependencies.run || defaultRun;
  const pause = dependencies.delay || delay;
  const alive = dependencies.alive || (pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } });
  const signal = dependencies.signal || ((pid, name) => process.kill(pid, name));
  const now = dependencies.now || Date.now;
  const job = path.dirname(configurationPath);
  const cfg = validateConfiguration(await privateJSON(configurationPath, fileSystem), job);
  const jobStat = await fileSystem.lstat(job);
  if (!jobStat.isDirectory() || jobStat.isSymbolicLink() || (jobStat.mode & 0o077)
      || (process.getuid && jobStat.uid !== process.getuid()) || await fileSystem.realpath(job) !== job) throw new Error('更新任务目录无效。');
  const exists = async filename => { try { await fileSystem.lstat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  const inode = async filename => identity(await fileSystem.lstat(filename));
  const report = async value => {
    const result = { ...value, version: cfg.version, appId: APP_ID, current: cfg.current, completedAt: new Date().toISOString() };
    // Retain a transaction receipt even after the GUI consumes its notification.
    await atomicJSON(path.join(job, 'result.json'), result, fileSystem);
    await atomicJSON(cfg.resultPath, result, fileSystem);
  };
  const journal = phase => atomicJSON(path.join(job, 'state.json'), { phase, version: cfg.version }, fileSystem);
  const bestJournal = phase => journal(phase).catch(error => console.error('Update journal failed:', phase, error.code || error.name));
  let ownsLock = false, replaced = false, acknowledged = false, parentExited = false, candidateExecutable;
  let phase = 'preparing';
  const launch = (application, extraArgs = []) => run('/usr/bin/open', ['-n', '-a', application,
    ...(cfg.guiUserData ? ['--env', `BRCLIO_USER_DATA=${cfg.guiUserData}`] : []), '--args', ...extraArgs], { env: guiEnvironment(), timeout: 30000 });
  async function candidatePids() {
    if (!await exists(cfg.current)) return [];
    if (await inode(cfg.current) !== cfg.stagedIdentity) throw new Error('安装目标已被其他操作替换，已保留旧版备份。');
    const executable = path.join(cfg.current, 'Contents', 'MacOS', candidateExecutable);
    const listing = (await run('/bin/ps', ['-axo', 'pid=,comm='], { timeout: 10000 })).stdout;
    return listing.split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      const pid = Number(match?.[1]);
      return match?.[2] === executable && pid > 1 && pid !== process.pid && pid !== cfg.parentPid ? [pid] : [];
    });
  }
  async function stopCandidate() {
    for (const name of ['SIGTERM', 'SIGKILL']) {
      for (const pid of await candidatePids()) { try { signal(pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
      const deadline = now() + (name === 'SIGTERM' ? 5000 : 2000);
      do { if (!(await candidatePids()).length) return; await pause(100); } while (now() < deadline);
    }
    throw new Error('新版进程尚未退出，旧版备份已保留，未覆盖运行中的应用。');
  }
  async function restoreFinder(application) {
    if (!cfg.finderRegistered) return;
    const extension = path.join(application, 'Contents', 'PlugIns', 'BrclioFinderSync.appex');
    await run('/usr/bin/pluginkit', ['-a', extension], { timeout: 10000 });
    await run('/usr/bin/pluginkit', ['-e', cfg.finderEnabled ? 'use' : 'ignore', '-i', EXTENSION_ID], { timeout: 10000 });
  }
  async function rollback(error) {
    await bestJournal('rolling-back');
    let rollbackSucceeded = false;
    let failure = error.message;
    try {
      if (await inode(cfg.backup) !== cfg.currentIdentity) throw new Error('旧版备份已被替换，未执行自动恢复。');
      if (await exists(cfg.current)) {
        if ((await fileSystem.lstat(cfg.current)).isSymbolicLink() || await inode(cfg.current) !== cfg.stagedIdentity) throw new Error('安装目标已被其他操作替换，旧版备份已保留。');
        await stopCandidate();
        if (await exists(cfg.failed)) throw new Error('失败应用保存位置已被占用。');
        await fileSystem.rename(cfg.current, cfg.failed);
      }
      await fileSystem.rename(cfg.backup, cfg.current);
      if (await inode(cfg.current) !== cfg.currentIdentity) throw new Error('旧版恢复后的文件身份不匹配。');
      rollbackSucceeded = true;
      await restoreFinder(cfg.current).catch(() => {});
      await launch(cfg.current, ['--brclio-update-failed']).catch(() => {});
    } catch (recoveryError) { failure += ' ' + recoveryError.message; }
    const result = { status: 'error', error: failure, phase, rollbackSucceeded, backupPath: rollbackSucceeded ? null : cfg.backup };
    await report(result).catch(() => {});
    return result;
  }
  try {
    await fileSystem.mkdir(cfg.lockPath, { mode: 0o700 }); ownsLock = true;
    await atomicJSON(cfg.readyPath, { status: 'ready', token: cfg.token }, fileSystem);
    const commitDeadline = now() + cfg.commitTimeout;
    while (!await exists(cfg.commitPath)) {
      if (await exists(cfg.cancelPath) || !alive(cfg.parentPid)) return { status: 'cancelled' };
      if (now() >= commitDeadline) throw new Error('覆盖安装未获确认，当前应用未修改。');
      await pause(50);
    }
    const commit = await privateJSON(cfg.commitPath, fileSystem);
    if (commit.token !== cfg.token) throw new Error('安装授权标识无效。');
    phase = 'waiting-for-exit'; await journal(phase);
    const parentDeadline = now() + cfg.parentTimeout;
    while (alive(cfg.parentPid)) {
      if (now() >= parentDeadline) throw new Error('Brclio 尚未退出，未开始覆盖安装。');
      await pause(100);
    }
    parentExited = true;
    phase = 'verifying'; await journal(phase);
    const currentStat = await fileSystem.lstat(cfg.current);
    const infoHash = crypto.createHash('sha256').update(await fileSystem.readFile(path.join(cfg.current, 'Contents', 'Info.plist'))).digest('hex');
    if (!currentStat.isDirectory() || currentStat.isSymbolicLink() || identity(currentStat) !== cfg.currentIdentity || infoHash !== cfg.currentInfoHash
        || await inode(cfg.stageDirectory) !== cfg.stageIdentity || await inode(cfg.staged) !== cfg.stagedIdentity) throw new Error('应用或更新暂存文件已变更，未执行覆盖。');
    candidateExecutable = (await verifyBundle(cfg.staged, cfg, run, fileSystem)).info.CFBundleExecutable;
    if (await exists(cfg.backup) || await exists(cfg.failed)) throw new Error('恢复备份位置已被占用，未执行覆盖。');
    phase = 'installing'; await journal(phase);
    await fileSystem.rename(cfg.current, cfg.backup); replaced = true;
    if (await inode(cfg.backup) !== cfg.currentIdentity || await exists(cfg.current)) throw new Error('应用在安装期间被其他操作更改。');
    await fileSystem.rename(cfg.staged, cfg.current);
    if (await inode(cfg.current) !== cfg.stagedIdentity) throw new Error('新版应用文件身份不匹配。');
    await verifyBundle(cfg.current, cfg, run, fileSystem);
    phase = 'restarting'; await journal(phase);
    await launch(cfg.current, ['--updated', '--brclio-update-job', cfg.job, '--brclio-update-token', cfg.token]);
    phase = 'awaiting-startup'; await journal(phase);
    const startupDeadline = now() + cfg.startupTimeout;
    while (now() < startupDeadline) {
      try {
        const ack = await privateJSON(cfg.ackPath, fileSystem, 4096);
        const expectedExecutable = path.join(cfg.current, 'Contents', 'MacOS', candidateExecutable);
        if (ack.token !== cfg.token || ack.version !== cfg.version || ack.executable !== expectedExecutable || !Number.isSafeInteger(ack.pid)
            || ack.pid <= 1 || ack.pid === cfg.parentPid || ack.pid === process.pid || !alive(ack.pid)) throw new Error('新版启动确认信息不匹配。');
        const actualExecutable = (await run('/bin/ps', ['-p', String(ack.pid), '-o', 'comm='], { timeout: 10000 })).stdout.trim();
        if (actualExecutable !== expectedExecutable || await inode(cfg.current) !== cfg.stagedIdentity) throw new Error('新版启动进程或文件身份不匹配。');
        acknowledged = true; break;
      } catch (error) { if (error.code !== 'ENOENT') console.error('Waiting for startup acknowledgement:', error.message); }
      await pause(100);
    }
    if (!acknowledged) throw new Error('新版客户端未确认启动成功，已请求恢复旧版。系统安全提示也可能阻止启动，请手动允许后重试。');
    phase = 'complete';
    const warnings = [];
    try {
      await restoreFinder(cfg.current);
      if (cfg.finderRegistered) await run('/usr/bin/pluginkit', ['-r', path.join(cfg.backup, 'Contents', 'PlugIns', 'BrclioFinderSync.appex')], { timeout: 10000 }).catch(error => { if (error.code !== 1) throw error; });
    } catch { warnings.push('新版已启动，Finder 扩展登记未完成，可在设置中重新启用。'); }
    try {
      if (await inode(cfg.current) !== cfg.stagedIdentity || await inode(cfg.stageDirectory) !== cfg.stageIdentity
          || await inode(cfg.backup) !== cfg.currentIdentity) throw new Error('备份文件身份已变化。');
      await fileSystem.rm(cfg.backup, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
      await fileSystem.rmdir(cfg.stageDirectory);
    } catch { warnings.push('更新成功，但旧版备份未能清理，已保留恢复文件。'); }
    const result = { status: 'installed', launchAcknowledged: true, ...(warnings.length ? { warning: warnings.join(' ') } : {}) };
    await report(result); return result;
  } catch (error) {
    if (acknowledged) {
      const result = { status: 'installed', launchAcknowledged: true, warning: '新版已启动，但安装结果或临时文件清理未完成。' };
      await report(result).catch(() => {}); return result;
    }
    if (replaced) return await rollback(error);
    const result = { status: 'error', error: error.message, phase, rollbackSucceeded: true };
    await report(result).catch(() => {});
    await atomicJSON(cfg.readyPath, { status: 'error', error: error.message, token: cfg.token }, fileSystem).catch(() => {});
    if (parentExited && await exists(cfg.current) && await inode(cfg.current) === cfg.currentIdentity) await launch(cfg.current, ['--brclio-update-failed']).catch(() => {});
    return result;
  } finally { if (ownsLock) await fileSystem.rmdir(cfg.lockPath).catch(() => {}); }
}

if (require.main === module) runHelper(process.argv[2]).then(result => { if (result.status === 'error') process.exitCode = 1; }).catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { APP_ID, EXTENSION_ID, VERSION, identity, defaultRun, guiEnvironment, atomicJSON, privateJSON, bundleInfo, verifyBundle, validateConfiguration, runHelper };

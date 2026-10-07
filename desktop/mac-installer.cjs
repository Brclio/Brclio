'use strict';

const nativeFS = process.versions.electron ? require('original-fs') : require('node:fs');
const fs = nativeFS.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { APP_ID, EXTENSION_ID, VERSION, identity, defaultRun, guiEnvironment, atomicJSON, privateJSON, bundleInfo, verifyBundle } = require('./mac-installer-helper.cjs');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const uuid = /^mac-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !/[\0\r\n]/.test(value);

async function digest(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of nativeFS.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

function createMacInstaller(options) {
  const platform = options.platform || process.platform;
  const architecture = options.architecture || process.arch;
  const run = options.run || defaultRun;
  const execute = options.spawn || spawn;
  const executable = options.executable;
  const userData = path.resolve(options.userData);
  let updatesDirectory = path.join(userData, 'updates');
  let jobsDirectory = path.join(updatesDirectory, 'install-jobs');
  let resultPath = path.join(updatesDirectory, 'mac-install-result.json');
  let application = absolute(executable) && path.basename(path.dirname(executable)) === 'MacOS' ? path.resolve(executable, '..', '..', '..') : null;
  let pending;

  async function resolveLocations() {
    const canonicalUserData = await fs.realpath(userData).catch(error => { if (error.code === 'ENOENT') return userData; throw error; });
    updatesDirectory = path.join(canonicalUserData, 'updates');
    jobsDirectory = path.join(updatesDirectory, 'install-jobs');
    resultPath = path.join(updatesDirectory, 'mac-install-result.json');
    if (application) {
      if ((await fs.lstat(application)).isSymbolicLink()) throw new Error('应用目录不能是符号链接。');
      application = await fs.realpath(application);
    }
  }

  async function readResult({ consume = false } = {}) {
    await resolveLocations();
    let result;
    try { result = await privateJSON(resultPath); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
    if (!['installed', 'error'].includes(result.status) || !VERSION.test(result.version || '') || result.appId !== APP_ID
        || result.current !== application || (result.status === 'installed' && result.launchAcknowledged !== true)) return null;
    if (consume) await fs.rm(resultPath, { force: true });
    return result;
  }

  async function acknowledgeLaunch(argv, actualVersion) {
    const jobIndex = argv.indexOf('--brclio-update-job'); const tokenIndex = argv.indexOf('--brclio-update-token');
    if (jobIndex < 0 && tokenIndex < 0) return null;
    await resolveLocations();
    if (argv.filter(value => value === '--brclio-update-job').length !== 1 || argv.filter(value => value === '--brclio-update-token').length !== 1) throw new Error('更新启动参数无效。');
    const job = argv[jobIndex + 1]; const token = argv[tokenIndex + 1];
    if (!absolute(job) || !/^[a-f0-9]{64}$/.test(token || '') || !VERSION.test(actualVersion || '')
        || path.dirname(job) !== jobsDirectory || !uuid.test(path.basename(job))) throw new Error('更新任务不属于当前用户。');
    const stats = await fs.lstat(job);
    if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) || (process.getuid && stats.uid !== process.getuid())
        || await fs.realpath(job) !== job) throw new Error('更新任务位置或权限无效。');
    const cfg = await privateJSON(path.join(job, 'configuration.json'));
    if (cfg.appId !== APP_ID || cfg.token !== token || cfg.version !== actualVersion || cfg.current !== application
        || cfg.ackPath !== path.join(job, 'launch-ack.json') || !application
        || identity(await fs.lstat(application)) !== cfg.stagedIdentity) throw new Error('当前客户端与更新任务不匹配。');
    const canonicalExecutable = await fs.realpath(executable);
    if (!canonicalExecutable.startsWith(application + path.sep)) throw new Error('当前客户端可执行文件位置无效。');
    await atomicJSON(cfg.ackPath, { token, version: actualVersion, executable: canonicalExecutable, pid: process.pid });
    return { acknowledged: true, version: actualVersion };
  }

  function start(verified) {
    if (pending) return pending;
    const operation = (async () => {
      await resolveLocations();
      if (platform !== 'darwin' || !['arm64', 'x64'].includes(architecture) || !application?.endsWith('.app')
          || !absolute(verified?.filename) || !VERSION.test(verified.version || '') || !/^[a-f0-9]{64}$/.test(verified.expected || '')
          || !Number.isSafeInteger(verified.size) || verified.size < 1 || path.basename(verified.filename) !== `Brclio-${verified.version}-mac-${architecture}.dmg`) throw new Error('请使用官方 macOS 安装版和已校验的更新安装包。');
      if (application.startsWith('/Volumes/') || application.includes('/AppTranslocation/')) throw new Error('请先将 Brclio 移到可写的应用程序文件夹并从那里打开，再覆盖更新。');
      if ((await fs.lstat(application)).isSymbolicLink() || !(await fs.lstat(application)).isDirectory()) throw new Error('应用目录无效，符号链接安装请手动更新。');
      const current = await fs.realpath(application);
      const installedExecutable = await fs.realpath(executable);
      if (!installedExecutable.startsWith(current + path.sep)) throw new Error('当前客户端可执行文件位置无效。');
      if (updatesDirectory === current || updatesDirectory.startsWith(current + path.sep)) throw new Error('更新缓存不能放在待替换的应用内部。');
      const downloaded = await fs.lstat(verified.filename);
      if (!downloaded.isFile() || downloaded.isSymbolicLink() || downloaded.size !== verified.size || await digest(verified.filename) !== verified.expected) throw new Error('安装包已变更，请重新下载。');
      const previous = await bundleInfo(current, run);
      const compare = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return x[index] - y[index]; return 0; };
      if (compare(verified.version, previous.CFBundleShortVersionString) <= 0) throw new Error('当前已是此版本或更新版本，无需覆盖安装。');
      await fs.mkdir(jobsDirectory, { recursive: true, mode: 0o700 });
      await resolveLocations();
      const realUpdates = await fs.realpath(updatesDirectory);
      if (realUpdates === current || realUpdates.startsWith(current + path.sep)) throw new Error('更新缓存不能放在待替换的应用内部。');
      let stageDirectory, job, mountpoint, mounted = false, child, committed = false, childStopped = true, childExit;
      const detach = async () => { if (mounted) { await run('/usr/bin/hdiutil', ['detach', mountpoint], { timeout: 30000 }); mounted = false; } };
      async function stopHelper() {
        if (!child || childStopped) return true;
        child.kill('SIGTERM');
        if (await Promise.race([childExit.then(() => true), delay(2000).then(() => false)])) return true;
        child.kill('SIGKILL');
        return Promise.race([childExit.then(() => true), delay(2000).then(() => false)]);
      }
      try {
        try { stageDirectory = await fs.mkdtemp(path.join(path.dirname(current), '.brclio-update-')); await fs.chmod(stageDirectory, 0o700); }
        catch { throw new Error('当前应用所在文件夹不可写或空间不足。请手动安装；应用不会请求管理员密码。'); }
        job = path.join(jobsDirectory, `mac-${crypto.randomUUID()}`); await fs.mkdir(job, { mode: 0o700 });
        mountpoint = path.join(job, 'mount'); await fs.mkdir(mountpoint, { mode: 0o700 });
        const cfg = { schemaVersion: 1, appId: APP_ID, version: verified.version, architecture, current, job, stageDirectory,
          staged: path.join(stageDirectory, 'next.app'), backup: path.join(stageDirectory, 'previous-bundle'), failed: path.join(stageDirectory, 'failed-bundle'),
          readyPath: path.join(job, 'ready.json'), commitPath: path.join(job, 'commit.json'), cancelPath: path.join(job, 'cancel'), ackPath: path.join(job, 'launch-ack.json'), resultPath,
          parentPid: options.parentPid || process.pid, token: crypto.randomBytes(32).toString('hex'),
          startupTimeout: options.startupTimeout || 120000, parentTimeout: options.parentTimeout || 60000, commitTimeout: options.commitTimeout || 30000,
          lockPath: path.join(path.dirname(current), `.brclio-update-${crypto.createHash('sha256').update(current).digest('hex').slice(0, 16)}.lock`),
          finderRegistered: false, finderEnabled: false };
        if (process.env.BRCLIO_USER_DATA) cfg.guiUserData = path.dirname(updatesDirectory);
        mounted = true;
        const attached = await run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountpoint, '-plist', verified.filename]);
        const plist = path.join(job, 'attach.plist'); await fs.writeFile(plist, attached.stdout, { mode: 0o600 });
        const entities = JSON.parse((await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist])).stdout)['system-entities']?.filter(item => item['mount-point']);
        if (!Array.isArray(entities) || entities.length !== 1 || path.resolve(entities[0]['mount-point']) !== mountpoint) throw new Error('安装包挂载了意外的卷，已停止安装。');
        const applications = (await fs.readdir(mountpoint, { withFileTypes: true })).filter(item => item.name.endsWith('.app'));
        if (applications.length !== 1 || !applications[0].isDirectory() || applications[0].isSymbolicLink()) throw new Error('DMG 必须包含唯一完整的 Brclio 应用。');
        const source = path.join(mountpoint, applications[0].name); await verifyBundle(source, cfg, run);
        await run('/usr/bin/ditto', ['--rsrc', '--extattr', '--acl', source, cfg.staged], { timeout: 300000 });
        await verifyBundle(cfg.staged, cfg, run); await detach();
        const currentStat = await fs.lstat(current), stagedStat = await fs.lstat(cfg.staged);
        if (currentStat.dev !== stagedStat.dev) throw new Error('更新暂存文件与应用不在同一磁盘。');
        cfg.currentIdentity = identity(currentStat); cfg.stagedIdentity = identity(stagedStat); cfg.stageIdentity = identity(await fs.lstat(stageDirectory));
        cfg.currentInfoHash = crypto.createHash('sha256').update(await fs.readFile(path.join(current, 'Contents', 'Info.plist'))).digest('hex');
        try {
          const extension = path.join(current, 'Contents', 'PlugIns', 'BrclioFinderSync.appex');
          const listing = (await run('/usr/bin/pluginkit', ['-m', '-A', '-D', '-v', '-i', EXTENSION_ID])).stdout;
          for (const line of listing.split(/\r?\n/)) {
            const fields = line.split('\t'); const match = /^([+!\- ])\s*com\.brclio\.toolbox\.finder-sync\([^)]+\)/.exec(fields[0]);
            if (match && fields.length >= 4 && path.resolve(fields.at(-1)) === extension) { cfg.finderRegistered = true; cfg.finderEnabled = match[1] === '+'; break; }
          }
        } catch (error) { if (error.code !== 1) throw new Error('无法读取现有 Finder 扩展状态，尚未开始覆盖安装。'); }
        const configurationPath = path.join(job, 'configuration.json'); await atomicJSON(configurationPath, cfg);
        // Read through Electron's ASAR-aware fs, then write the physical helper
        // with native fs. original-fs cannot read app.asar as a directory.
        const helperPath = path.join(job, 'install.cjs');
        await fs.writeFile(helperPath, await require('node:fs').promises.readFile(path.join(__dirname, 'mac-installer-helper.cjs')), { flag: 'wx', mode: 0o700 });
        const log = await fs.open(path.join(job, 'helper.log'), 'a', 0o600);
        try {
          child = execute(options.helperExecutable || executable, [helperPath, configurationPath], { detached: true, cwd: job,
            env: { ...guiEnvironment(), ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', log.fd, log.fd] });
          childStopped = false;
          childExit = new Promise(resolve => { child.once('exit', () => { childStopped = true; resolve(); }); child.once('error', () => { childStopped = true; resolve(); }); });
          await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        } finally { await log.close(); }
        const deadline = Date.now() + (options.readyTimeout || 10000);
        while (Date.now() < deadline) {
          if (childStopped) throw new Error('安装助手提前退出，当前应用未修改。');
          const ready = await privateJSON(cfg.readyPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (ready?.token !== undefined && ready.token !== cfg.token) throw new Error('安装助手身份不匹配。');
          if (ready?.status === 'error') throw new Error(ready.error || '安装助手准备失败。');
          if (ready?.status === 'ready' && ready.token === cfg.token) {
            await fs.rm(resultPath, { force: true });
            await atomicJSON(cfg.commitPath, { token: cfg.token });
            committed = true; child.unref();
            return { installerStarted: true, automaticInstall: true };
          }
          await delay(25);
        }
        throw new Error('安装助手准备超时，当前应用未修改。');
      } catch (error) {
        let stopped = true;
        if (!committed) {
          if (job) await fs.writeFile(path.join(job, 'cancel'), 'cancel\n', { mode: 0o600 }).catch(() => {});
          stopped = await stopHelper();
        }
        let detached = !mounted;
        try { await detach(); detached = true; } catch { /* Keep its mount directory for safe manual recovery. */ }
        if (!committed && stopped) {
          if (stageDirectory) await fs.rm(stageDirectory, { recursive: true, force: true }).catch(() => {});
          if (job && detached) await fs.rm(job, { recursive: true, force: true }).catch(() => {});
        }
        if (!stopped) throw new Error('安装助手尚未停止，未授权替换，临时文件已保留。请保持当前应用打开。');
        throw error;
      }
    })();
    pending = operation;
    operation.finally(() => { if (pending === operation) pending = null; }).catch(() => {});
    return operation;
  }
  return { start, acknowledgeLaunch, readResult, get resultPath() { return resultPath; } };
}

module.exports = { createMacInstaller };

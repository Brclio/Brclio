'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { createUpdater, compareVersions } = require('../desktop/updater.cjs');
const { checkSelfUpdate } = require('./self-update.cjs');

// The downloader and Brclio use independent release channels and version numbers.
async function runDownloader({currentVersion, directory, router, installer, report, platform, architecture, selfUpdateSignal, action = 'startup'}) {
  if (!['startup', 'brclio', 'self'].includes(action)) throw new Error('未知的下载器操作。');
  const manualSelf = action === 'self';
  let warning = '';
  const show = patch => report({warning, ...patch});
  if (manualSelf || (action === 'startup' && !selfUpdateSignal?.aborted)) {
    show({title:'检查下载器版本', detail:'正在读取下载器发布信息。', progress:null});
    // The automatic-update preference only applies to startup checks.
    const signal = manualSelf ? undefined : selfUpdateSignal;
    let selfProgress = -1;
    let self;
    let selfHandedOff = false;
    try {
      self = await checkSelfUpdate({router, signal, currentVersion, directory, platform, arch:architecture,
        onProgress(version, progress) {
          if (progress === selfProgress) return;
          selfProgress = progress;
          show({title:'更新下载器', detail:`正在下载 Brclio Downloader ${version}。`, progress});
        }});
      if (self && !signal?.aborted) {
        show({title:'安装新版下载器', detail:`安装 ${self.version} 后将自动打开并继续。`, progress:100, installing:true});
        await installer.installAndOpen(self);
        selfHandedOff = true;
        return {quit:true};
      }
      if (manualSelf) {
        show({title:'暂无下载器更新', detail:`当前下载器版本为 ${currentVersion}。`, progress:null});
        return {quit:false};
      }
    } catch (error) {
      if (manualSelf) throw error;
      if (!signal?.aborted) warning = `下载器升级暂未完成（${error.message}）。继续检查 Brclio。`;
    } finally {
      // A detached installer may still be reading the verified package.
      if (self && !selfHandedOff) await fs.rm(path.dirname(self.filename), {recursive:true, force:true}).catch(() => {});
    }
  }
  show({title:'检查 Brclio 最新版', detail:'正在读取 Brclio 官方稳定版。', progress:null, installing:false});
  const installed = await installer.getInstalled('brclio');
  let handoff = false;
  const updater = createUpdater({
    currentVersion:installed?.version || '0.0.0', directory:path.join(directory, 'brclio'), platform, architecture,
    fetch:(url, init) => router.fetch(url, init),
    onOperation:(_kind, active, targets) => router.setBusy(active, targets),
    onState(state) {
      if (state.status === 'downloading') show({title:'下载 Brclio ' + state.version,
        detail:state.message || `${(state.downloadedBytes / 1048576).toFixed(1)} / ${(state.totalBytes / 1048576).toFixed(1)} MB`,
        progress:state.progress});
      else if (state.status === 'checking' && state.message) show({detail:state.message});
    },
    async installPackage(descriptor) {
      show({title:'安装并打开 Brclio', detail:`正在安装 Brclio ${descriptor.version}。`, progress:100, installing:true});
      const result = await installer.installAndOpen({...descriptor, product:'brclio'});
      handoff = result.handoff;
      return {installerStarted:true};
    }
  });
  const checked = await updater.check();
  if (checked.status === 'error') throw new Error(checked.error);
  const installedOrder = installed ? compareVersions(installed.version, checked.version) : -1;
  if (installedOrder >= 0) {
    const detail = installedOrder === 0 ? `本机 Brclio ${installed.version} 已是最新版。`
      : `本机 Brclio ${installed.version} 高于最新正式版 ${checked.version}。`;
    show({title:'打开 Brclio', detail, progress:100});
    await installer.openInstalled('brclio');
    show({title:'Brclio 已打开', detail, progress:100});
    return {quit:false};
  }
  const downloaded = await updater.download();
  if (downloaded.status !== 'downloaded') throw new Error(downloaded.error || '安装包下载未完成。');
  const started = await updater.install();
  if (!started.installerStarted) throw new Error(started.error || '安装未完成。');
  if (!handoff) show({title:'Brclio 已打开', detail:`已安装 Brclio ${checked.version}。`, progress:100, installing:false});
  return {quit:handoff};
}

module.exports = {runDownloader};

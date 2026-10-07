'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPOSITORY = 'Brclio/Brclio';
const API_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const RELEASE_URL = `https://github.com/${REPOSITORY}/releases/latest`;
const MAX_DOWNLOAD = 1536 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(['github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

function versionParts(version) {
  const result = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!result) throw new Error('发布版本号格式无效。');
  return result.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = versionParts(left); const b = versionParts(right);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

function assetURL(value, tag, filename) {
  const url = new URL(value);
  const expected = `/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(filename)}`;
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.pathname.toLowerCase() !== expected.toLowerCase() || url.username || url.password || url.search || url.hash) {
    throw new Error('发布文件地址不属于 Brclio 官方仓库。');
  }
  return url.href;
}

function parseRelease(release, platform, architecture) {
  if (!release || release.draft || release.prerelease || !Array.isArray(release.assets)) throw new Error('暂无可用的正式发布版本。');
  versionParts(release.tag_name);
  const version = release.tag_name.replace(/^v/, '');
  const suffix = platform === 'darwin' && ['arm64', 'x64'].includes(architecture) ? `mac-${architecture}.dmg`
    : platform === 'win32' && architecture === 'x64' ? 'windows-x64.exe' : null;
  if (!suffix) throw new Error('此平台或处理器暂未提供在线安装包。');
  const assetName = `Brclio-${version}-${suffix}`;
  const asset = release.assets.find(item => item.name === assetName);
  const checksums = release.assets.find(item => item.name === 'SHA256SUMS.txt');
  if (!asset || !checksums) throw new Error('此版本的安装包或 SHA256 校验文件尚未发布完整，请稍后再试。');
  if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_DOWNLOAD) throw new Error('安装包大小无效。');
  return { version, tag: release.tag_name, notes: typeof release.body === 'string' ? release.body.slice(0, 100000) : '',
    assetName, size: asset.size, downloadURL: assetURL(asset.browser_download_url, release.tag_name, assetName),
    checksumURL: assetURL(checksums.browser_download_url, release.tag_name, checksums.name),
    digest: typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(asset.digest) ? asset.digest.slice(7).toLowerCase() : null };
}

function checksumFor(text, filename) {
  if (typeof text !== 'string' || text.length > 128 * 1024) throw new Error('SHA256 校验文件格式无效。');
  const matches = text.split(/\r?\n/).map(line => /^([a-f0-9]{64})[ \t]+\*?(.+)$/i.exec(line)).filter(match => match && match[2] === filename);
  if (matches.length !== 1) throw new Error('安装包缺少唯一的 SHA256 校验值。');
  return matches[0][1].toLowerCase();
}

async function fileDigest(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

function createUpdater(options) {
  const { currentVersion, directory, fetch: fetchURL, openPath } = options;
  const platform = options.platform || process.platform;
  const architecture = options.architecture || process.arch;
  const publish = options.onState || (() => {});
  let state = { status: 'idle', currentVersion, version: null, notes: '', progress: 0,
    downloadedBytes: 0, totalBytes: 0, error: null, assetName: null, manualInstall: platform === 'darwin', releaseURL: RELEASE_URL };
  let release = null; let verified = null; let checking = null; let downloading = null; let installing = null;
  function snapshot() { return { ...state }; }
  function change(patch) { state = { ...state, ...patch }; publish(snapshot()); return snapshot(); }
  function failure(error) { return change({ status: 'error', error: error.message || '操作失败，请重试。' }); }

  async function request(url, signal) {
    const response = await fetchURL(url, { signal, redirect: 'follow', headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Brclio/${currentVersion}` } });
    if (!response.ok) {
      if (response.status === 404) throw new Error('正式版本尚未发布，请稍后检查。');
      if (response.status === 403 || response.status === 429) throw new Error('GitHub 暂时限制请求，请稍后重试。');
      throw new Error(`下载服务返回 HTTP ${response.status}，请稍后重试。`);
    }
    if (response.url) {
      const finalURL = new URL(response.url);
      if (finalURL.protocol !== 'https:' || !ALLOWED_HOSTS.has(finalURL.hostname)) {
        await response.body?.cancel().catch(() => {});
        throw new Error('下载重定向至非官方地址，已停止。');
      }
    }
    return response;
  }

  function check() {
    if (checking) return checking;
    if (downloading || installing) return Promise.resolve(snapshot());
    checking = (async () => {
      change({ status: 'checking', error: null, progress: 0, downloadedBytes: 0, installerOpened: false });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.requestTimeout || 20000);
      try {
        const response = await request(API_URL, controller.signal);
        const body = await response.text();
        if (body.length > 1024 * 1024) throw new Error('发布信息过大，无法读取。');
        const candidate = parseRelease(JSON.parse(body), platform, architecture);
        release = candidate; verified = null;
        return change({ status: compareVersions(candidate.version, currentVersion) > 0 ? 'available' : 'up-to-date',
          version: candidate.version, notes: candidate.notes, assetName: candidate.assetName, totalBytes: candidate.size });
      } catch (error) { release = null; verified = null; return failure(error.name === 'AbortError' ? new Error('检查更新超时，请重试。') : error); }
      finally { clearTimeout(timer); checking = null; }
    })();
    return checking;
  }

  function download() {
    if (downloading) return downloading;
    if (installing) return Promise.resolve(snapshot());
    const operation = (async () => {
      if (checking) await checking;
      if (!release || compareVersions(release.version, currentVersion) <= 0) return failure(new Error('请先检查更新，确认有可用的新版本。'));
      const selected = release;
      const destination = path.join(directory, selected.assetName);
      const partial = `${destination}.part`;
      const controller = new AbortController();
      let idleTimer; let manifestTimer;
      const totalTimer = setTimeout(() => controller.abort(), options.downloadTimeout || 10 * 60 * 1000);
      const refreshIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => controller.abort(), options.idleTimeout || 45000); };
      change({ status: 'downloading', error: null, progress: 0, downloadedBytes: 0, totalBytes: selected.size, installerOpened: false });
      try {
        verified = null;
        await fs.mkdir(directory, { recursive: true });
        await fs.rm(partial, { force: true });
        refreshIdle();
        manifestTimer = setTimeout(() => controller.abort(), options.requestTimeout || 20000);
        const manifest = await request(selected.checksumURL, controller.signal);
        const expected = checksumFor(await manifest.text(), selected.assetName);
        clearTimeout(manifestTimer);
        if (selected.digest && selected.digest !== expected) throw new Error('GitHub 发布校验值与 SHA256SUMS 不一致，已停止。');
        const existing = await fs.stat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (existing?.size === selected.size && await fileDigest(destination) === expected) {
          verified = { filename: destination, expected, size: selected.size };
          return change({ status: 'downloaded', progress: 100, downloadedBytes: selected.size });
        }
        const response = await request(selected.downloadURL, controller.signal);
        if (!response.body) throw new Error('安装包下载内容为空。');
        const hash = crypto.createHash('sha256');
        const output = await fs.open(partial, 'wx', 0o600);
        let count = 0; let lastUpdate = 0;
        try {
          for await (const chunk of response.body) {
            refreshIdle();
            count += chunk.length;
            if (count > selected.size || count > MAX_DOWNLOAD) throw new Error('安装包大小与发布信息不一致，已停止。');
            hash.update(chunk);
            await output.writeFile(chunk);
            if (Date.now() - lastUpdate >= 100) {
              change({ downloadedBytes: count, progress: Math.min(99, Math.floor(count * 100 / selected.size)) });
              lastUpdate = Date.now();
            }
          }
        } finally { await output.close(); }
        if (count !== selected.size || hash.digest('hex') !== expected) throw new Error('安装包 SHA256 校验失败，请重新下载。');
        await fs.rename(partial, destination);
        verified = { filename: destination, expected, size: selected.size };
        return change({ status: 'downloaded', progress: 100, downloadedBytes: count });
      } catch (error) {
        controller.abort();
        await fs.rm(partial, { force: true }).catch(() => {});
        return failure(error.name === 'AbortError' ? new Error('下载超时或连接中断，请重新下载。') : error);
      } finally { clearTimeout(totalTimer); clearTimeout(idleTimer); clearTimeout(manifestTimer); }
    })();
    downloading = operation;
    operation.finally(() => { if (downloading === operation) downloading = null; });
    return operation;
  }

  function install() {
    if (installing) return installing;
    if (state.status !== 'downloaded' || !verified) return Promise.resolve(failure(new Error('请先下载并校验安装包。')));
    const selected = verified;
    const operation = (async () => {
      try {
        const stats = await fs.stat(selected.filename);
        if (stats.size !== selected.size || await fileDigest(selected.filename) !== selected.expected) {
          verified = null; throw new Error('安装包已变更，请重新下载。');
        }
        const error = await openPath(selected.filename);
        if (error) throw new Error(`无法打开安装包：${error}`);
        options.afterOpen?.();
        return change({ installerOpened: true });
      } catch (error) { return failure(error); }
    })();
    installing = operation;
    operation.finally(() => { if (installing === operation) installing = null; });
    return operation;
  }
  return { state: snapshot, check, download, install };
}

module.exports = { createUpdater, parseRelease, compareVersions, checksumFor, API_URL };

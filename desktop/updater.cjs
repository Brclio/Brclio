'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {createResumeStore,responsePlan} = require('./update-resume.cjs');

const REPOSITORY = 'Brclio/Brclio';
const API_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const RELEASE_URL = `https://github.com/${REPOSITORY}/releases/latest`;
const MAX_DOWNLOAD = 1536 * 1024 * 1024;
const RETRY_LIMIT = 10;
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

function requestBlockMessage(response, builtin = false) {
  if (response.headers.get('cf-mitigated')?.trim().toLowerCase() === 'challenge') {
    return '更新请求被 Cloudflare 安全验证拦截，请稍后重试或切换更新网络。';
  }
  if (builtin && response.status === 403) return '内置更新服务拒绝请求（HTTP 403），可关闭内置代理或稍后重试。';
  if (builtin && response.status === 429) return '内置更新服务暂时限制请求（HTTP 429），可关闭内置代理或稍后重试。';
  return null;
}

async function fileDigest(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

function abortable(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('更新请求已取消。'), { name: 'AbortError' })); };
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

function updateError(message, code, name = 'Error') { return Object.assign(new Error(message), { code, name }); }
function retryable(error) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return false;
  return error?.code === 'BRCLIO_UPDATE_NETWORK' || error?.name === 'TimeoutError' && !error.code;
}
function resumableFailure(error) {
  return retryable(error) || error?.name === 'AbortError' || error?.code === 'ABORT_ERR' ||
    error?.code === 'BRCLIO_UPDATE_RETRY_EXHAUSTED';
}
function delay(milliseconds, signal) {
  if (milliseconds === 0) return abortable(Promise.resolve(), signal);
  let timer;
  return abortable(new Promise(resolve => { timer = setTimeout(resolve, milliseconds); }), signal).finally(() => clearTimeout(timer));
}

function createUpdater(options) {
  const { currentVersion, directory, fetch: fetchURL, installPackage } = options;
  const platform = options.platform || process.platform;
  const architecture = options.architecture || process.arch;
  const publish = options.onState || (() => {});
  let state = { status: 'idle', currentVersion, version: null, notes: '', progress: 0,
    downloadedBytes: 0, totalBytes: 0, resumable: false, resumedBytes: 0, retryLimit: RETRY_LIMIT, retryCount: 0, retrying: false, retryExhausted: false, retryStage: null,
    error: null, assetName: null, manualInstall: false, canInstall: false, releaseURL: RELEASE_URL };
  let release = null; let verified = null; let checking = null; let downloading = null; let installing = null;
  function snapshot() { return { ...state }; }
  function change(patch) { state = { ...state, ...patch }; publish(snapshot()); return snapshot(); }
  function failure(error) { return change({ status: 'error', error: error?.message || '操作失败，请重试。', retrying: false, retryExhausted: error?.retryExhausted === true, message: undefined }); }
  const requestTimeout = options.requestTimeout || 20000;
  const retryDelay = attempt => Number.isFinite(options.retryDelay) && options.retryDelay >= 0 ? options.retryDelay : Math.min(1000 * 2 ** attempt, 5000);
  async function attempts(kind, run, signal) {
    for (let attempt = 0; attempt <= RETRY_LIMIT; attempt++) {
      signal?.throwIfAborted();
      change({ retryCount: attempt, retrying: attempt > 0, retryExhausted: false, retryStage: kind,
        message: attempt > 0 ? `正在自动重试 ${attempt}/${RETRY_LIMIT}，请稍候。` : undefined });
      try { return await run(); }
      catch (error) {
        signal?.throwIfAborted();
        if (!retryable(error)) throw error;
        if (attempt === RETRY_LIMIT) {
          const exhausted = updateError(`${error.message || '更新连接未成功。'} 已自动重试 ${RETRY_LIMIT} 次，请手动重试。`, 'BRCLIO_UPDATE_RETRY_EXHAUSTED');
          exhausted.retryExhausted = true; throw exhausted;
        }
        change({ retrying: true, message: `连接未成功，稍后自动重试 ${attempt + 1}/${RETRY_LIMIT}。` });
        await delay(retryDelay(attempt), signal);
      }
    }
  }

  async function request(url, signal, extra = {}) {
    const response = await abortable(Promise.resolve().then(() => fetchURL(url, { signal, redirect: 'follow', headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Brclio/${currentVersion}`, 'Accept-Encoding':'identity', ...extra.headers } })), signal);
    const blocked = requestBlockMessage(response);
    if (blocked) {
      void Promise.resolve().then(() => response.body?.cancel()).catch(() => {});
      throw updateError(blocked, 'BRCLIO_UPDATE_SECURITY');
    }
    if (response.status===206 && !new Headers(extra.headers).has('range')) {
      void Promise.resolve().then(() => response.body?.cancel()).catch(() => {});
      throw updateError('服务器返回了未请求的续传范围，已停止。','BRCLIO_UPDATE_SECURITY');
    }
    if (!response.ok && !(extra.allow416 && response.status === 416)) {
      void Promise.resolve().then(() => response.body?.cancel()).catch(() => {});
      if (response.status === 404) throw updateError('正式版本尚未发布，请稍后检查。', 'BRCLIO_UPDATE_ROUTE');
      if (response.status === 403 || response.status === 429) throw updateError('GitHub 暂时限制请求，请稍后重试。', 'BRCLIO_UPDATE_SECURITY');
      throw updateError(`下载服务返回 HTTP ${response.status}，请稍后重试。`, [408, 500, 502, 503, 504].includes(response.status) ? 'BRCLIO_UPDATE_NETWORK' : 'BRCLIO_UPDATE_ROUTE');
    }
    if (response.url) {
      const finalURL = new URL(response.url);
      if (finalURL.protocol !== 'https:' || !ALLOWED_HOSTS.has(finalURL.hostname)) {
        void Promise.resolve().then(() => response.body?.cancel()).catch(() => {});
        throw updateError('下载重定向至非官方地址，已停止。', 'BRCLIO_UPDATE_SECURITY');
      }
    }
    return response;
  }

  function check() {
    if (checking) return checking;
    if (state.installerStarted) return Promise.resolve(snapshot());
    if (downloading || installing) return Promise.resolve(snapshot());
    const operation = (async () => {
      change({ status: 'checking', error: null, progress: 0, downloadedBytes: 0, retryCount: 0, retrying: false, retryExhausted: false,
        retryStage: 'check', message: undefined, installerStarted: false, canInstall: false });
      try {
        const candidate = await attempts('check', async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(updateError('检查更新连接超时。', 'BRCLIO_UPDATE_NETWORK', 'TimeoutError')), requestTimeout);
          try {
            await abortable(Promise.resolve().then(() => options.onOperation?.('check', true, [API_URL])), controller.signal);
            const response = await request(API_URL, controller.signal);
            const body = await abortable(response.text(), controller.signal);
            if (body.length > 1024 * 1024) throw new Error('发布信息过大，无法读取。');
            return parseRelease(JSON.parse(body), platform, architecture);
          } finally { clearTimeout(timer); controller.abort(); }
        });
        release = candidate; verified = null;
        return change({ status: compareVersions(candidate.version, currentVersion) > 0 ? 'available' : 'up-to-date',
          version: candidate.version, notes: candidate.notes, assetName: candidate.assetName, totalBytes: candidate.size,
          retrying: false, retryExhausted: false, message: undefined });
      } catch (error) { release = null; verified = null; return failure(error); }
      finally { await options.onOperation?.('check', false); }
    })();
    checking = operation;
    operation.then(() => { if (checking === operation) checking = null; }, () => { if (checking === operation) checking = null; });
    return operation;
  }

  function download() {
    if (downloading) return downloading;
    if (state.installerStarted) return Promise.resolve(snapshot());
    if (installing) return Promise.resolve(snapshot());
    const operation = (async () => {
      if (checking) await checking;
      if (!release || compareVersions(release.version, currentVersion) <= 0) return failure(new Error('请先检查更新，确认有可用的新版本。'));
      const selected = release;
      const destination = path.join(directory, selected.assetName);
      const resume = createResumeStore(directory,selected);
      const controller = new AbortController();
      change({ status: 'downloading', error: null, totalBytes: selected.size, retryCount: 0,
        retrying: false, retryExhausted: false, retryStage: 'download', message: undefined, canInstall: false });
      const progress = (count, extra = {}) => change({downloadedBytes:count, progress:Math.min(99,Math.floor(count*100/selected.size)), resumable:count>0, ...extra});
      try {
        verified = null;
        await abortable(fs.mkdir(directory, { recursive: true }), controller.signal);
        progress(await resume.preview(),{resumedBytes:0});
        return await attempts('download', async () => {
          controller.signal.throwIfAborted();
          const child = new AbortController();
          const abortChild = () => child.abort(controller.signal.reason);
          controller.signal.addEventListener('abort', abortChild, { once: true });
          let idleTimer, progressTimer, response, reader, output, expected, attemptError, reused = false, metadata, plan;
          let count = 0; let lastUpdate = 0;
          let hash;
          const refreshIdle = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => child.abort(updateError('安装包传输连接超时。', 'BRCLIO_UPDATE_NETWORK', 'TimeoutError')), options.idleTimeout || 45000);
          };
          const network = async run => {
            child.signal.throwIfAborted();
            const timer = setTimeout(() => child.abort(updateError('下载更新连接超时。', 'BRCLIO_UPDATE_NETWORK', 'TimeoutError')), requestTimeout);
            try { return await abortable(Promise.resolve().then(run), child.signal); }
            finally { clearTimeout(timer); }
          };
          try {
            await network(() => options.onOperation?.('download', true, [selected.checksumURL, selected.downloadURL]));
            expected = await network(async () => {
              const manifest = await request(selected.checksumURL, child.signal);
              return checksumFor(await abortable(manifest.text(), child.signal), selected.assetName);
            });
            if (selected.digest && selected.digest !== expected) throw new Error('GitHub 发布校验值与 SHA256SUMS 不一致，已停止。');
            const existing = await abortable(fs.lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; }), controller.signal);
            if (existing && (!existing.isFile() || existing.nlink!==1)) throw updateError('更新安装包缓存不是独立的普通文件，已停止。','BRCLIO_UPDATE_SECURITY');
            if (existing?.size === selected.size && await abortable(fileDigest(destination), controller.signal) === expected) {
              reused = true; count = selected.size; await resume.clear();
            } else {
              const prefix = await abortable(resume.prepare(expected,controller.signal),controller.signal);
              output = prefix.handle; hash = prefix.hash; count = prefix.count; metadata = prefix.metadata;
              progress(count,{resumedBytes:count});
              const headers = count ? {Range:`bytes=${count}-`,...(metadata.etag?{'If-Range':metadata.etag}:{})} : {};
              response = await network(() => request(selected.downloadURL, child.signal,{headers,allow416:true}));
              plan = responsePlan(response,count,selected,metadata);
              if (response.status === 416) {
                if (!plan.complete) throw updateError('服务器拒绝续传范围，请手动重新下载。','BRCLIO_UPDATE_SECURITY');
              } else {
                if (plan.restarted) {
                  await output.truncate(0); hash = crypto.createHash('sha256'); count = 0;
                  progress(0,{resumedBytes:0,message:'服务器未接受续传，正在重新下载。'});
                }
                metadata = {...metadata,etag:plan.etag}; await resume.save(metadata);
                if (!response.body) throw new Error('安装包下载内容为空。');
                reader = response.body.getReader();
                let received = 0;
                refreshIdle();
                while (true) {
                  const item = await abortable(reader.read(), child.signal);
                  child.signal.throwIfAborted();
                  if (item.done) break;
                  const chunk = item.value;
                  if (chunk.length) refreshIdle();
                  if (received+chunk.length>plan.bytes || count+chunk.length>selected.size || count+chunk.length>MAX_DOWNLOAD)
                    throw updateError('安装包大小或续传范围与发布信息不一致，已停止。','BRCLIO_UPDATE_SECURITY');
                  let written=0;
                  while(written<chunk.length){
                    const result=await abortable(output.write(chunk,written,chunk.length-written,count+written),controller.signal);
                    if(!result.bytesWritten)throw updateError('无法写入更新文件。','BRCLIO_UPDATE_LOCAL');
                    written+=result.bytesWritten;
                  }
                  hash.update(chunk); count += chunk.length; received += chunk.length;
                  if (Date.now() - lastUpdate >= 100) {
                    clearTimeout(progressTimer); progressTimer = null;
                    progress(count);
                    lastUpdate = Date.now();
                  } else if (!progressTimer) progressTimer = setTimeout(() => {progressTimer=null;progress(count);lastUpdate=Date.now();},100-(Date.now()-lastUpdate));
                }
              }
            }
          } catch (error) { attemptError = child.signal.aborted ? child.signal.reason : error; }
          finally {
            clearTimeout(idleTimer); clearTimeout(progressTimer); child.abort();
            // Do not begin a fresh route until the old body/file are closed.
            // Cleanup has its own idle limit and cannot remove a later file.
            const cleanup = new AbortController();
            const abortCleanup = () => cleanup.abort(controller.signal.reason);
            controller.signal.addEventListener('abort', abortCleanup, { once: true });
            if (controller.signal.aborted) abortCleanup();
            const cleanupTimer = setTimeout(() => cleanup.abort(updateError('更新连接清理超时，请手动重试。', 'BRCLIO_UPDATE_CLEANUP')), options.idleTimeout || 45000);
            const cancelled = Promise.resolve().then(() => reader ? reader.cancel() : response?.body?.cancel()).catch(() => {});
            const closed = resume.closing(Promise.resolve().then(async () => {try {await output?.sync();} finally {await output?.close();}}));
            closed.catch(() => {});
            try { await abortable(cancelled, cleanup.signal); }
            catch (error) { attemptError = error; }
            finally {
              try { reader?.releaseLock(); } catch (error) {
                if (attemptError?.name !== 'AbortError' && attemptError?.code !== 'ABORT_ERR') attemptError = error;
              }
              try { await abortable(closed, cleanup.signal); } catch (error) { attemptError = error; }
              clearTimeout(cleanupTimer); controller.signal.removeEventListener('abort', abortCleanup);
              controller.signal.removeEventListener('abort', abortChild);
            }
          }
          controller.signal.throwIfAborted();
          if (attemptError) {
            if (!resumableFailure(attemptError)) await resume.clear();
            else progress(await resume.preview());
            throw attemptError;
          }
          if (!reused) {
            if (count < selected.size) {
              progress(count);
              throw updateError('安装包连接提前结束。', 'BRCLIO_UPDATE_NETWORK');
            }
            if (count !== selected.size || hash.digest('hex') !== expected) throw new Error('安装包 SHA256 校验失败，请重新下载。');
            const disk = await abortable(resume.verify(expected,controller.signal),controller.signal);
            await abortable(resume.finish(destination,disk),controller.signal);
          }
          controller.signal.throwIfAborted();
          verified = { filename: destination, expected, size: selected.size };
          return change({ status: 'downloaded', progress: 100, downloadedBytes: count, resumable:false, canInstall: true, retrying: false, retryExhausted: false, message: undefined });
        }, controller.signal);
      } catch (error) {
        const finalError = controller.signal.aborted ? controller.signal.reason : error;
        controller.abort();
        if (resumableFailure(finalError)) {
          try {progress(await resume.preview());} catch {await resume.clear().catch(()=>{});progress(0,{resumable:false});}
        } else {await resume.clear().catch(()=>{});progress(0,{resumable:false});}
        return failure(finalError);
      } finally { await options.onOperation?.('download', false); }
    })();
    downloading = operation;
    operation.then(() => { if (downloading === operation) downloading = null; }, () => { if (downloading === operation) downloading = null; });
    return operation;
  }

  function install() {
    if (installing) return installing;
    if (state.installerStarted) return Promise.resolve(snapshot());
    if (!verified) return Promise.resolve(failure(new Error('请先下载并校验安装包。')));
    const selected = verified;
    const operation = (async () => {
      change({ status: 'preparing', error: null });
      try {
        const stats = await fs.stat(selected.filename);
        if (stats.size !== selected.size || await fileDigest(selected.filename) !== selected.expected) {
          verified = null; change({ canInstall: false }); throw new Error('安装包已变更，请重新下载。');
        }
        if (typeof installPackage !== 'function') throw new Error('请使用安装版 Brclio 进行在线更新。');
        const result = await installPackage({ ...selected, version: release.version });
        if (!result?.installerStarted) throw new Error('安装程序尚未准备就绪，请重试。');
        const next = change({ status: 'restarting', installerStarted: true, canInstall: false, automaticInstall: true });
        options.afterStart?.();
        return next;
      } catch (error) { return failure(error); }
    })();
    installing = operation;
    operation.finally(() => { if (installing === operation) installing = null; });
    return operation;
  }
  function restoreResult(result) {
    if (result?.status === 'installed' && result.launchAcknowledged === true) {
      return change({ status: 'installed', version: currentVersion, message: result.warning || '已完成覆盖安装，Brclio 已自动打开。', error: null });
    }
    if (result?.status === 'error') return failure(new Error(result.error || result.message || '上次安装未完成，请重试。'));
    return snapshot();
  }
  return { state: snapshot, check, download, install, restoreResult };
}

module.exports = { createUpdater, parseRelease, compareVersions, checksumFor, requestBlockMessage, API_URL };

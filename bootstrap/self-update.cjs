'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { compareVersions, checksumFor } = require('../desktop/updater.cjs');

const REPO = 'https://github.com/Brclio/Brclio/releases/download/';
const POINTER = REPO + 'downloader-stable/latest.json';
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const MAX_BYTES = 1536 * 1024 * 1024;

async function boundedText(response, limit) {
  const chunks = [];
  let size = 0;
  if (!response.body) throw new Error('下载器版本信息为空。');
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('下载器版本信息超出大小限制。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchThroughProxy(router, url, signal, allowMissing = false) {
  const response = await router.fetch(url, {signal, headers: {'User-Agent': 'Brclio-Downloader', 'Accept-Encoding': 'identity'}, cache: 'no-store'});
  if (response.status === 200) return response;
  await response.body?.cancel().catch(() => {});
  if (allowMissing && response.status === 404) return null;
  throw new Error(`下载器发布服务返回 HTTP ${response.status}。`);
}

function selfAsset(pointer, platform, arch) {
  const {version, assets} = pointer;
  if (!VERSION.test(version) || !Array.isArray(assets))
    throw new Error('下载器版本信息不匹配。');
  const suffix = platform === 'win32' && arch === 'x64' ? 'windows-x64.exe'
    : platform === 'darwin' && ['arm64', 'x64'].includes(arch) ? `mac-${arch}.dmg` : null;
  if (!suffix) throw new Error('当前平台暂无下载器安装包。');
  const name = `Brclio-Downloader-${version}-${suffix}`;
  const matches = assets.filter(asset => asset?.name === name);
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].size) || matches[0].size < 1 ||
      matches[0].size > MAX_BYTES || !/^[a-f0-9]{64}$/.test(matches[0].sha256))
    throw new Error('下载器发布文件缺失或无效。');
  const base = REPO + 'downloader-v' + version + '/';
  return {name, size:matches[0].size, digest:matches[0].sha256, url:base + name, checksumURL:base + 'SHA256SUMS.txt'};
}

async function checkSelfUpdate({router, currentVersion, directory, signal:preferenceSignal, platform = process.platform, arch = process.arch, onProgress = () => {}}) {
  await router.setBusy(true, [POINTER]);
  const timeout = AbortSignal.timeout(30000);
  const signal = preferenceSignal ? AbortSignal.any([preferenceSignal, timeout]) : timeout;
  try {
    const pointer = await fetchThroughProxy(router, POINTER, signal, true);
    if (!pointer) return null;
    const document = JSON.parse(await boundedText(pointer, 4096));
    const {version} = document;
    if (!VERSION.test(version)) throw new Error('下载器版本号无效。');
    if (compareVersions(version, currentVersion) <= 0) return null;
    const asset = selfAsset(document, platform, arch);
    const sums = await fetchThroughProxy(router, asset.checksumURL, signal);
    const expected = checksumFor(await boundedText(sums, 128 * 1024), asset.name);
    if (asset.digest !== expected) throw new Error('下载器发布摘要不一致。');

    await fs.mkdir(directory, {recursive: true, mode: 0o700});
    const stage = await fs.mkdtemp(path.join(directory, 'self-' + version + '-'));
    const filename = path.join(stage, asset.name);
    const controller = new AbortController();
    const transferSignal = preferenceSignal ? AbortSignal.any([preferenceSignal, controller.signal]) : controller.signal;
    let timer;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error('下载器安装包传输超时。')), 45000);
    };
    try {
      touch();
      const response = await fetchThroughProxy(router, asset.url, transferSignal);
      if (!response.body) throw new Error('下载器安装包为空。');
      const hash = createHash('sha256');
      let received = 0;
      onProgress(version, 0);
      const meter = new Transform({
        transform(chunk, encoding, done) {
          received += chunk.length;
          if (received > asset.size) return done(new Error('下载器安装包超过发布大小。'));
          touch();
          hash.update(chunk);
          onProgress(version, Math.floor(100 * received / asset.size));
          done(null, chunk);
        }
      });
      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(filename, {flags:'wx', mode:0o600}), {signal:transferSignal});
      if (received !== asset.size || hash.digest('hex') !== expected) throw new Error('下载器安装包校验失败。');
      return {product:'downloader', filename, expected, size:asset.size, version};
    } catch (error) {
      await fs.rm(stage, {recursive:true, force:true});
      throw transferSignal.reason || error;
    } finally { clearTimeout(timer); controller.abort(); }
  } finally { await router.setBusy(false); }
}

module.exports = {checkSelfUpdate, selfAsset, POINTER};

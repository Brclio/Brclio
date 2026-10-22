'use strict';

const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_METADATA = 4096;
const pendingCloses = new Map();
const unsafe = message => Object.assign(new Error(message), {code:'BRCLIO_UPDATE_SECURITY'});
const local = message => Object.assign(new Error(message), {code:'BRCLIO_UPDATE_LOCAL'});
const regular = stat => stat.isFile() && stat.nlink === 1;
const strongETag = value => typeof value === 'string' && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value) && value.length <= 1024 ? value : undefined;

async function statFile(filename) {
  try {
    const stat = await fs.lstat(filename);
    if (!regular(stat)) throw unsafe('更新缓存不是独立的普通文件，已停止。');
    return stat;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function openFile(filename, create = false) {
  const before = await statFile(filename);
  const flags = (create && !before ? constants.O_CREAT | constants.O_EXCL : 0) | constants.O_RDWR | (constants.O_NOFOLLOW || 0);
  const handle = await fs.open(filename, flags, 0o600);
  try {
    const actual = await handle.stat();
    if (!regular(actual) || before && (before.ino !== actual.ino || before.dev !== actual.dev)) throw unsafe('更新缓存文件已改变，已停止。');
    await handle.chmod(0o600);
    return handle;
  } catch (error) { await handle.close().catch(()=>{}); throw error; }
}
async function removeFile(filename) {
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw unsafe('更新缓存路径不是文件，已停止。');
    await fs.unlink(filename);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function createResumeStore(directory, selected) {
  const partial = path.join(directory, selected.assetName + '.part');
  const sidecar = partial + '.json';
  const identity = expectedSHA256 => ({version:1, releaseVersion:selected.version, assetName:selected.assetName,
    downloadURL:selected.downloadURL, size:selected.size, expectedSHA256});
  const matches = (metadata, expected) => metadata && Object.entries(identity(expected ?? metadata.expectedSHA256)).every(([key,value])=>metadata[key]===value) &&
    /^[a-f0-9]{64}$/.test(metadata.expectedSHA256) && (metadata.etag === undefined || strongETag(metadata.etag) === metadata.etag);
  async function readMetadata() {
    const stat = await statFile(sidecar);
    if (!stat) return null;
    if (stat.size > MAX_METADATA) throw unsafe('更新续传记录超过大小限制，已停止。');
    const handle = await openFile(sidecar);
    try {
      const buffer = Buffer.alloc(MAX_METADATA+1);
      let count = 0;
      while(count<buffer.length){const read=await handle.read(buffer,count,buffer.length-count,count);if(!read.bytesRead)break;count+=read.bytesRead;}
      if (count > MAX_METADATA) throw unsafe('更新续传记录超过大小限制，已停止。');
      try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,count))); }
      catch { return null; }
    } finally { await handle.close(); }
  }
  async function save(metadata) {
    await statFile(sidecar);
    const temporary = sidecar + '.tmp-' + crypto.randomUUID();
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    try {
      const bytes = Buffer.from(JSON.stringify(metadata) + '\n');
      if (bytes.length > MAX_METADATA) throw unsafe('更新续传记录超过大小限制，已停止。');
      await handle.writeFile(bytes); await handle.sync(); await handle.close();
      await fs.rename(temporary,sidecar);
    } catch (error) { await handle.close().catch(()=>{}); await removeFile(temporary).catch(()=>{}); throw error; }
  }
  async function clear() {
    // These exact two names belong to this asset. Never recurse or touch another release.
    await removeFile(partial); await removeFile(sidecar);
  }
  async function preview() {
    const metadata = await readMetadata();
    const stat = await statFile(partial);
    return matches(metadata,selected.digest || undefined) && stat && stat.size <= selected.size ? stat.size : 0;
  }
  async function prepare(expected, signal) {
    if (pendingCloses.has(partial)) throw local('上次更新文件仍在关闭，请稍后手动重试。');
    let metadata = await readMetadata();
    let stat = await statFile(partial);
    if (!matches(metadata,expected) || !stat || stat.size > selected.size) {
      await clear(); metadata = identity(expected); await save(metadata); stat = null;
    }
    const handle = await openFile(partial,true);
    try {
      const current = await handle.stat();
      if (current.size > selected.size) throw unsafe('更新续传文件超过发布大小，已停止。');
      const hash = crypto.createHash('sha256');
      let count = 0;
      const buffer = Buffer.alloc(128*1024);
      while (count < current.size) {
        signal?.throwIfAborted();
        const read = await handle.read(buffer,0,Math.min(buffer.length,current.size-count),count);
        if (!read.bytesRead) throw unsafe('更新续传文件在读取时已改变，已停止。');
        hash.update(buffer.subarray(0,read.bytesRead)); count += read.bytesRead;
      }
      if ((await handle.stat()).size !== count) throw unsafe('更新续传文件在读取时已改变，已停止。');
      return {handle,hash,count,metadata};
    } catch (error) { await handle.close().catch(()=>{}); throw error; }
  }
  function closing(promise) {
    pendingCloses.set(partial,promise);
    const done = () => {if(pendingCloses.get(partial)===promise)pendingCloses.delete(partial);};
    promise.then(done,done);
    return promise;
  }
  async function verify(expected, signal) {
    const handle = await openFile(partial);
    try {
      const initial = await handle.stat();
      if(initial.size!==selected.size)throw unsafe('安装包大小与发布信息不一致，已停止。');
      const hash = crypto.createHash('sha256');
      const buffer = Buffer.alloc(128*1024);
      let count = 0;
      while (count < initial.size) {
        signal?.throwIfAborted();
        const read = await handle.read(buffer,0,Math.min(buffer.length,initial.size-count),count);
        if (!read.bytesRead) throw unsafe('更新缓存文件已改变，已停止。');
        hash.update(buffer.subarray(0,read.bytesRead)); count += read.bytesRead;
      }
      const final = await handle.stat(), named = await statFile(partial);
      if (!named || initial.size!==selected.size || final.size!==initial.size || final.mtimeMs!==initial.mtimeMs || named.ino!==final.ino || named.dev!==final.dev || hash.digest('hex')!==expected)
        throw unsafe('安装包 SHA256 校验失败，请重新下载。');
      return {ino:final.ino,dev:final.dev,size:final.size,mtimeMs:final.mtimeMs};
    } finally { await handle.close(); }
  }
  async function finish(destination, verified) {
    const current = await statFile(partial);
    if (!current || Object.entries(verified).some(([key,value])=>current[key]!==value)) throw unsafe('更新缓存文件已改变，已停止。');
    await statFile(destination);
    await fs.rename(partial,destination);
    const final = await statFile(destination);
    if (!final || final.ino!==verified.ino || final.dev!==verified.dev || final.size!==verified.size) throw unsafe('更新缓存文件已改变，已停止。');
    await removeFile(sidecar);
  }
  return {partial,sidecar,preview,prepare,save,clear,finish,closing,verify};
}

function responsePlan(response, offset, selected, metadata) {
  const fail = () => {throw unsafe('服务器返回的续传范围或文件身份无效，已停止。');};
  if (response.status === 416) return {complete:offset===selected.size};
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding.trim().toLowerCase() !== 'identity' || /^multipart\/byteranges\b/i.test(response.headers.get('content-type') || '')) fail();
  const length = response.headers.get('content-length');
  const parsedLength = length === null ? null : /^\d+$/.test(length) ? Number(length) : NaN;
  if (parsedLength !== null && !Number.isSafeInteger(parsedLength)) fail();
  const etag = strongETag(response.headers.get('etag'));
  if (response.status === 206) {
    if (!offset) fail();
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') || '');
    if (!match) fail();
    const [start,end,total] = match.slice(1).map(Number);
    if (![start,end,total].every(Number.isSafeInteger) || start!==offset || total!==selected.size || end<start || end>=total || parsedLength!==null && parsedLength!==end-start+1) fail();
    if (metadata.etag && response.headers.has('etag') && response.headers.get('etag')!==metadata.etag) fail();
    return {offset,bytes:end-start+1,etag:etag || metadata.etag};
  }
  if (response.status !== 200 || response.headers.has('content-range') || parsedLength!==null && parsedLength!==selected.size) fail();
  return {offset:0,bytes:selected.size,etag,restarted:offset>0};
}

module.exports = {createResumeStore,responsePlan,strongETag};

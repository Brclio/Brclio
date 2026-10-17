'use strict';

const { execFile: execFileCallback } = require('node:child_process');
const { promisify } = require('node:util');
const { fileURLToPath } = require('node:url');
const { getWindowsSelectedPaths } = require('./windows-selection.cjs');

// Query the foreground Finder only. Filenames remain JSON data throughout;
// neither script source nor command arguments contain selected filenames.
const MAC_SELECTION_SCRIPT = String.raw`ObjC.import('AppKit');
function isFinderFrontmost() {
  return ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier) === 'com.apple.finder';
}
function run() {
  if (!isFinderFrontmost()) throw new Error('BRCLIO_NOT_FINDER');
  var selected = Application('Finder').selection();
  if (!selected.length) throw new Error('BRCLIO_NO_SELECTION');
  if (selected.length > 1000) throw new Error('BRCLIO_TOO_MANY');
  var urls = selected.map(function (item) { return item.url(); });
  if (!isFinderFrontmost()) throw new Error('BRCLIO_FOCUS_CHANGED');
  return JSON.stringify(urls);
}`;

async function getMacSelectedPaths(run = promisify(execFileCallback)) {
  let stdout;
  try {
    ({ stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_SELECTION_SCRIPT], {
      encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (error) {
    const detail = `${error.message || ''}\n${error.stderr || ''}`;
    if (detail.includes('BRCLIO_NOT_FINDER')) throw new Error('请先在 Finder 中选中文件或文件夹，再按复制快捷键。');
    if (detail.includes('BRCLIO_NO_SELECTION')) throw new Error('尚未选中项目，请在 Finder 中选中文件或文件夹后重试。');
    if (detail.includes('BRCLIO_TOO_MANY')) throw new Error('一次最多复制 1000 个项目，请减少选择后重试。');
    if (detail.includes('BRCLIO_FOCUS_CHANGED')) throw new Error('当前窗口已切换，请返回 Finder 后重试。');
    if (/-1743|not authorized|not permitted/i.test(detail)) {
      throw new Error('需要允许 Brclio 读取 Finder 选中项。请在系统设置 → 隐私与安全性 → 自动化中允许 Brclio 控制 Finder，然后重试。');
    }
    throw new Error('暂时无法读取 Finder 选中项，请确认 Finder 已打开并完成系统授权后重试。');
  }
  try {
    if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 4 * 1024 * 1024) throw new Error('Invalid output');
    const urls = JSON.parse(stdout);
    if (!Array.isArray(urls) || !urls.length || urls.length > 1000) throw new Error('Invalid selection');
    return urls.map(value => {
      if (typeof value !== 'string') throw new Error('Invalid URL');
      const url = new URL(value);
      if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost') || url.search || url.hash) throw new Error('Not a local file');
      const filename = fileURLToPath(url, { windows: false });
      if (!filename.startsWith('/') || /[\u0000-\u001f\u007f-\u009f]/.test(filename)) throw new Error('Invalid path');
      return filename;
    });
  } catch { throw new Error('Finder 未返回可复制的本地路径；虚拟项目或包含控制字符的文件名无法复制。'); }
}

async function getSelectedPaths({ platform = process.platform, run } = {}) {
  if (platform === 'darwin') return getMacSelectedPaths(run);
  if (platform === 'win32') return getWindowsSelectedPaths(run ? { execFile: run } : {});
  throw new Error('复制所选路径的快捷键仅支持 macOS 和 Windows。');
}

function createSelectionCopier({ getPaths = getSelectedPaths, copyPaths, onError }) {
  let copying = false;
  return async function copySelection() {
    if (copying) return;
    copying = true;
    try { await copyPaths(await getPaths()); }
    catch (error) { await onError(error); }
    finally { copying = false; }
  };
}

module.exports = { MAC_SELECTION_SCRIPT, getMacSelectedPaths, getSelectedPaths, createSelectionCopier };

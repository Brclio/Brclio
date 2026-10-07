'use strict';

const path = require('node:path');
const MAX_PAYLOAD_BYTES = 128 * 1024;

/** Only the Finder extension's path-copy action is accepted; no commands/files are opened. */
function getCopyPathsFromURL(value) {
  if (typeof value !== 'string' || !/^brclio:/i.test(value)) return null;
  const invalid = () => new Error('收到的 Finder 路径请求无效，请重新选中文件或文件夹。');
  if (Buffer.byteLength(value, 'utf8') > Math.ceil(MAX_PAYLOAD_BYTES * 4 / 3) + 256) throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== 'brclio:' || url.hostname !== 'copy-path' || !['', '/'].includes(url.pathname) || url.username || url.password || url.port || url.hash) throw invalid();
  const parameters = [...url.searchParams];
  if (parameters.length !== 1 || parameters[0][0] !== 'payload') throw invalid();
  const payload = parameters[0][1];
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) throw invalid();
  const bytes = Buffer.from(payload, 'base64url');
  if (bytes.length > MAX_PAYLOAD_BYTES || bytes.toString('base64url') !== payload) throw invalid();
  let paths;
  try { paths = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalid(); }
  if (!Array.isArray(paths) || !paths.length || paths.length > 1000 || paths.some(value => typeof value !== 'string' || !path.posix.isAbsolute(value) || /[\x00-\x1f\x7f-\x9f]/.test(value))) throw invalid();
  return paths;
}

function getCopyPathsFromURLs(argv) {
  for (const argument of argv) {
    const paths = getCopyPathsFromURL(argument);
    if (paths) return paths;
  }
  return null;
}

module.exports = { getCopyPathsFromURL, getCopyPathsFromURLs, MAX_PAYLOAD_BYTES };

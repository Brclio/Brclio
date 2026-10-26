'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const asar = require('@electron/asar');

const requiredXhsFiles = Object.freeze([
  'desktop/xhs/index.mjs', 'desktop/xhs/desktop/python-backend.js', 'desktop/xhs/desktop/profile-manager.js',
  'desktop/xhs/desktop/profile-browser.js', 'desktop/xhs/desktop/native-video-download.js',
  'desktop/xhs/desktop/image-clipboard.js', 'desktop/xhs/desktop/native-clipboard.js',
  'desktop/xhs/desktop/xhs-login-reset.js', 'desktop/xhs/api/parse.js', 'desktop/xhs/api/video.js',
  'desktop/xhs/lib/xhs.js', 'desktop/xhs/lib/archive.js',
  'web/xhs.js', 'web/xhs.css', 'web/xhs/lib/xhs-parser.js', 'web/xhs/lib/live-photo-maker.js',
  'web/xhs/lib/live-photo-format.js', 'web/xhs/lib/live-photo-package.js',
  'web/xhs/lib/archive.js', 'web/xhs/lib/live-photo-heic.js', 'web/xhs/lib/live-photo-heic-encoder.js',
  'web/xhs/lib/live-photo-heic-worker.js', 'web/xhs/assets/vendor/heic/heic-encoder.js',
  'web/xhs/assets/vendor/heic/heic-encoder.wasm',
]);

function verifyXhsAsar(filename) {
  const entries = new Set(asar.listPackage(filename).map(entry => entry.replaceAll('\\', '/')));
  const files = [];
  for (const relative of requiredXhsFiles) {
    assert.ok(entries.has('/' + relative), `Packaged XHS resource is missing: ${relative}`);
    const bytes = asar.extractFile(filename, path.normalize(relative));
    assert.ok(bytes.length > 0, `Packaged XHS resource is empty: ${relative}`);
    if (relative.endsWith('.wasm')) assert.equal(bytes.subarray(0, 8).toString('hex'), '0061736d01000000', 'Packaged HEIC encoder is not WASM v1.');
    files.push({ filename: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  assert.ok(![...entries].some(entry => entry === '/desktop/xhs/test' || entry.startsWith('/desktop/xhs/test/')),
    'XHS test fixtures must not be included in the installed package.');
  return { files };
}

function verifyXhsRuntime(filename) {
  const stats = fs.lstatSync(filename);
  assert.ok(stats.isFile() && !stats.isSymbolicLink() && stats.size > 0, 'Packaged Python worker must be a nonempty regular file.');
  const output = execFileSync(filename, ['--health'], { encoding: 'utf8', windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 100000 });
  const health = JSON.parse(output);
  assert.equal(health.ok, true, 'Packaged Python worker health check failed.');
  assert.equal(health.engine, 'python', 'Packaged worker is not the Python parser.');
  assert.match(health.version, /^\d+\.\d+\.\d+/);
  return { filename, bytes: stats.size, health };
}

module.exports = { verifyXhsAsar, verifyXhsRuntime, requiredXhsFiles };

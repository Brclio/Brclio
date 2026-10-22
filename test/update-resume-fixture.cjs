'use strict';

// Loopback HTTPS/VLESS fixture: interrupt a real installer response only after
// the client has reported its persisted prefix, then serve its exact tail.
const crypto = require('node:crypto');
const { startRelay } = require('./update-proxy-fixture.cjs');

async function startResumeRelay({ payload, assetName = 'Brclio-0.2.0-mac-arm64.dmg', prefixBytes = 256 * 1024 } = {}) {
  payload ||= crypto.randomBytes(2 * 1024 * 1024 + 113);
  if (!(prefixBytes > 0 && prefixBytes < payload.length)) throw Error('invalid_resume_fixture_prefix');
  const digest = crypto.createHash('sha256').update(payload).digest('hex');
  const prefix = 'https://github.com/Brclio/Brclio/releases/download/v0.2.0/';
  const release = { tag_name: 'v0.2.0', assets: [
    { name: assetName, size: payload.length, browser_download_url: prefix + assetName, digest: 'sha256:' + digest },
    { name: 'SHA256SUMS.txt', browser_download_url: prefix + 'SHA256SUMS.txt' },
  ] };
  const transfers = [];
  let pending, timer, prefixTailTimer, interrupted = false, acknowledged = false, policyViolation = false;
  const relay = await startRelay({ respond(request, response) {
    const range = request.headers.range;
    const match = typeof range === 'string' ? /^bytes=(\d+)-$/.exec(range) : null;
    const offset = match ? Number(match[1]) : null;
    const kind = request.method === 'HEAD' ? 'probe' : request.url.includes('/releases/latest') ? 'metadata'
      : request.url.endsWith('SHA256SUMS.txt') ? 'manifest' : request.url.startsWith('/verified/') ? 'installer-cdn' : 'installer-origin';
    const record = { kind, rangeOffset: offset, hasRange: range !== undefined, sentBytes: 0 }; transfers.push(record);
    if (range !== undefined && (!match || !kind.startsWith('installer'))) { policyViolation = true; response.writeHead(400); response.end(); return; }
    if (kind === 'probe') { record.status = 200; response.writeHead(200); response.end(); return; }
    if (kind === 'metadata') { record.status = 200; response.end(JSON.stringify(release)); return; }
    if (kind === 'manifest') { record.status = 200; response.end(digest + '  ' + assetName + '\n'); return; }
    if (kind === 'installer-origin') {
      record.status = 302; response.writeHead(302, { Location: 'https://release-assets.githubusercontent.com/verified/' + assetName }); response.end(); return;
    }
    if (!interrupted) {
      if (range !== undefined || pending) { policyViolation = true; response.writeHead(400); response.end(); return; }
      record.status = 200; record.sentBytes = prefixBytes;
      response.writeHead(200, { 'Content-Length': payload.length, ETag: '"resume-fixture-v1"', 'Accept-Ranges': 'bytes' });
      response.flushHeaders(); response.write(payload.subarray(0, prefixBytes - 1)); pending = response;
      // A separate final byte after the UI's progress throttle ensures that
      // the acknowledgement describes the entire persisted prefix.
      prefixTailTimer = setTimeout(() => response.write(payload.subarray(prefixBytes - 1, prefixBytes)), 200);
      // A safety bound for a broken client; this fallback cannot satisfy the
      // successful fixture because acknowledged remains false.
      timer = setTimeout(() => { interrupted = true; response.destroy(); }, 10000);
      return;
    }
    if (offset !== prefixBytes) { policyViolation = true; response.writeHead(416, { 'Content-Range': 'bytes */' + payload.length }); response.end(); return; }
    record.status = 206; record.sentBytes = payload.length - offset;
    response.writeHead(206, { 'Content-Length': record.sentBytes, 'Content-Range': `bytes ${offset}-${payload.length - 1}/${payload.length}`,
      ETag: '"resume-fixture-v1"', 'Accept-Ranges': 'bytes' });
    response.end(payload.subarray(offset));
  } });
  return { ...relay, payload, digest, assetName, prefixBytes, release, transfers,
    acknowledgePrefix(bytes) {
      if (!pending || interrupted || bytes < prefixBytes) return;
      acknowledged = true; interrupted = true; clearTimeout(timer); clearTimeout(prefixTailTimer); pending.destroy();
    },
    evidence() { return { acknowledged, interrupted, policyViolation, prefixBytes,
      installerBytesSent: transfers.filter(value => value.kind === 'installer-cdn').reduce((sum, value) => sum + value.sentBytes, 0) }; },
    async close() { clearTimeout(timer); clearTimeout(prefixTailTimer); pending?.destroy(); await relay.close(); },
  };
}

module.exports = { startResumeRelay };

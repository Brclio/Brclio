'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { startResumeRelay } = require('./update-resume-fixture.cjs');
const { createUpdateProxy, CONFIG_URL, CONFIG_FALLBACK_URL, SYSTEM_PARTITION, DIRECT_PARTITION } = require('../desktop/update-proxy.cjs');
const { electronUpdateFetch } = require('../desktop/electron-update-fetch.cjs');
const { createConnectBridge } = require('../desktop/update-connect-bridge.cjs');
const { createUpdater, API_URL } = require('../desktop/updater.cjs');

async function verifyNativeResume({ app, session, net }, root) {
  const fixture = await startResumeRelay();
  const certificate = new crypto.X509Certificate(await fs.readFile(path.join(root, 'test/fixtures/update-proxy-tls/origin.pem')));
  const directory = path.join(app.getPath('userData'), 'offline-native-resume');
  const sessions = new Set(), names = new WeakMap(), requests = [], operations = [];
  let active, targetKind, installed = false;
  const noProxy = { setProxy: async () => {}, resolveProxy: async () => 'DIRECT' };
  const router = createUpdateProxy({
    whenReady: () => app.whenReady(), defaultSession: () => noProxy,
    netFetch: () => { throw Error('unexpected_resume_direct_route'); },
    fromPartition(name, options) {
      if (name === SYSTEM_PARTITION) return noProxy;
      if (name === DIRECT_PARTITION) return { setProxy: async () => {}, fetch: async url => {
        if (![CONFIG_URL, CONFIG_FALLBACK_URL].includes(url)) throw Error('unexpected_resume_bootstrap');
        active.configurations++;
        return Response.json({ version: 1, ttlSeconds: 600, nodes: Array.from({ length: 16 }, () => ({ ...fixture.node })) });
      } };
      const actual = session.fromPartition('brclio-resume-native-' + name, { ...options, cache: false });
      actual.setCertificateVerifyProc((request, callback) => {
        try { const received = new crypto.X509Certificate(request.certificate.data);
          callback(!received.checkHost(request.hostname) ? -200 : received.fingerprint256 === certificate.fingerprint256 ? 0 : -202); }
        catch { callback(-207); }
      });
      sessions.add(actual); names.set(actual, name); return actual;
    },
    async fetchSession(value, url, init) {
      if (!sessions.has(value)) return value.fetch(url, init);
      const range = new Headers(init.headers).get('range'), match = range && /^bytes=(\d+)-$/.exec(range);
      const kind = init.method === 'HEAD' ? 'probe' : targetKind;
      const record = { operationId: active.id, kind, method: init.method || 'GET', session: names.get(value),
        rangeOffset: match ? Number(match[1]) : null, rangeHeaderValid: range === null || !!match,
        officialDestination: ['github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(new URL(url).hostname) };
      requests.push(record); const started = performance.now();
      const response = await electronUpdateFetch(options => net.request(options), value, url, init);
      Object.assign(record, { status: response.status, elapsedMs: performance.now() - started });
      if (kind === 'probe') { active.probes++; if (response.status === 200) active.probeLatencies.push({ session: names.get(value), elapsedMs: record.elapsedMs }); }
      else active.selectedSession ||= names.get(value);
      if (response.status === 206) {
        const parts = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
        record.validPartialResponse = !!parts && Number(parts[1]) === record.rangeOffset
          && Number(parts[2]) === fixture.payload.length - 1 && Number(parts[3]) === fixture.payload.length
          && Number(response.headers.get('content-length')) === fixture.payload.length - record.rangeOffset;
      }
      return response;
    },
    async createBridge(options) { active.candidates++; return createConnectBridge({ ...options, WebSocketClass: fixture.WebSocketClass }); },
  });
  const updater = createUpdater({ currentVersion: '0.1.9', directory, platform: 'darwin', architecture: 'arm64',
    fetch(url, init) { targetKind = url === API_URL ? 'metadata' : url.endsWith('SHA256SUMS.txt') ? 'manifest' : 'installer'; return router.fetch(url, init); },
    async onOperation(kind, enabled, targets) {
      if (enabled) { active = { id: operations.length + 1, kind, configurations: 0, candidates: 0, probes: 0, probeLatencies: [] }; operations.push(active); }
      await router.setBusy(enabled, targets);
    },
    onState(state) { if (state.status === 'downloading') fixture.acknowledgePrefix(state.downloadedBytes); },
    installPackage: async () => { installed = true; throw Error('installation_forbidden'); },
  });
  try {
    assert.equal((await updater.check()).status, 'available');
    const downloaded = await updater.download();
    assert.equal(downloaded.status, 'downloaded'); assert.equal(downloaded.canInstall, true); assert.equal(downloaded.retryCount, 1);
    assert.equal(downloaded.resumedBytes, fixture.prefixBytes);
    const actual = await fs.readFile(path.join(directory, fixture.assetName));
    const actualSHA256 = crypto.createHash('sha256').update(actual).digest('hex');
    assert.equal(actual.length, fixture.payload.length); assert.equal(actualSHA256, fixture.digest);
    const evidence = fixture.evidence(), installer = requests.filter(value => value.kind === 'installer');
    const ranges = requests.filter(value => value.rangeOffset !== null);
    assert.equal(evidence.acknowledged, true); assert.equal(evidence.interrupted, true); assert.equal(evidence.policyViolation, false);
    assert.equal(evidence.installerBytesSent, fixture.payload.length);
    assert.equal(installer.length, 4); assert.equal(ranges.length, 2);
    assert.ok(ranges.every(value => value.kind === 'installer' && value.rangeHeaderValid && value.rangeOffset === fixture.prefixBytes));
    assert.ok(requests.every(value => value.officialDestination && value.rangeHeaderValid));
    assert.equal(requests.filter(value => value.status === 206).length, 1);
    assert.ok(requests.filter(value => value.status === 206).every(value => value.validPartialResponse));
    assert.equal(fixture.transfers.filter(value => value.kind === 'installer-origin' && value.rangeOffset === fixture.prefixBytes).length, 1);
    assert.equal(fixture.transfers.filter(value => value.kind === 'installer-cdn' && value.rangeOffset === fixture.prefixBytes).length, 1);
    assert.equal(operations.length, 3);
    for (const operation of operations) {
      assert.equal(operation.configurations, 1); assert.equal(operation.candidates, 16); assert.equal(operation.probes, 16);
      const selected = operation.probeLatencies.find(value => value.session === operation.selectedSession);
      assert.ok(selected && selected.elapsedMs <= Math.min(...operation.probeLatencies.map(value => value.elapsedMs)) + 2);
    }
    assert.equal((await fs.readdir(directory)).filter(name => name.startsWith(fixture.assetName + '.part')).length, 0);
    assert.equal(installed, false);
    return { passed: true, actualElectron: true, externalNetworkRequests: false, networkMocked: false,
      interruptedOnce: true, persistedPrefixAcknowledged: true, rangeSurvivedOfficialRedirect: true,
      installerRequestCount: installer.length, rangeRequestCount: ranges.length, rangeOffsets: ranges.map(value => value.rangeOffset),
      resumedBytes: downloaded.resumedBytes, expectedResumedBytes: fixture.prefixBytes,
      tailBytes: fixture.payload.length - fixture.prefixBytes, installerBytesSent: evidence.installerBytesSent,
      actualBytes: actual.length, actualSHA256, fullSHA256Verified: true, canInstall: downloaded.canInstall,
      retryCount: downloaded.retryCount, configurations: operations.length, probes: operations.reduce((sum, value) => sum + value.probes, 0),
      everyAttemptFreshConfiguration: true, allNodesProbedPerAttempt: 16, fastestSuccessfulNodeSelected: true,
      nonInstallerRangeRequests: requests.filter(value => value.kind !== 'installer' && value.rangeOffset !== null).length,
      valid206: true, partialAndSidecarCleaned: true, installed: false };
  } finally {
    await router.close();
    for (const value of sessions) { await value.closeAllConnections(); value.setCertificateVerifyProc(null); }
    await fixture.close(); await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = { verifyNativeResume };

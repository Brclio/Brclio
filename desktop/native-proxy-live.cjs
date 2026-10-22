'use strict';
// Release-only live transport gate. Downloads a previous official Windows
// installer through real Electron + native VLESS, verifies it, never installs.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron: electron } = require('@playwright/test');

(async () => {
  const root = path.resolve(__dirname, '..');
  const argument = (name, fallback) => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1) || fallback;
  const fixtureVersion = argument('--current-version', '0.1.7');
  const expectedVersion = argument('--expected-release', null);
  if (![fixtureVersion, expectedVersion].filter(Boolean).every(value => /^\d+\.\d+\.\d+$/.test(value))) throw Error('invalid_version_argument');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-native-live-gate-'));
  let application;
  const report = { source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    startedAt: new Date().toISOString(), passed: false, actualElectron: true, externalNetworkRequests: true, networkMocked: false,
    systemDetectionControlled: 'DIRECT in isolated test factory only; existing OS/default session proxy unchanged',
    systemSettingsModified: false, tlsVerificationModified: false, installerInstalled: false,
    defaultTimeoutsMs: { checkAndManifest: 20000, idle: 45000, downloadTotal: 600000 }, timeoutOverrides: false };
  try {
    application = await electron.launch({ cwd: root, args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), root],
      env: { ...process.env, BRCLIO_USER_DATA: temporary } });
    // Safe numeric progress on stderr; stdout contains only the final JSON.
    application.on('console', message => { const value = message.text(); if (value.startsWith('BRCLIO_NATIVE_GATE ')) process.stderr.write(value + '\n'); });
    Object.assign(report, await application.evaluate(async ({ app, session, net }, input) => {
      const load = process.getBuiltinModule('node:module').createRequire(input.root + '/package.json');
      const fs = load('node:fs'), fsp = load('node:fs/promises'), path = load('node:path'), crypto = load('node:crypto');
      const { createUpdateProxy, CONFIG_URL, CONFIG_FALLBACK_URL, SYSTEM_PARTITION } = load('./desktop/update-proxy.cjs');
      const { electronUpdateFetch } = load('./desktop/electron-update-fetch.cjs');
      const { createConnectBridge } = load('./desktop/update-connect-bridge.cjs');
      const { createUpdater, checksumFor, requestBlockMessage } = load('./desktop/updater.cjs');
      const result = { actualAppVersion: app.getVersion(), updaterCurrentVersionFixture: input.fixtureVersion,
        requestedExpectedRelease: input.expectedVersion, fixturePlatform: 'win32', fixtureArchitecture: 'x64', requests: [], operations: [], installerInstalled: false, retryCount: 0 };
      const actualSessions = new Set(), names = new WeakMap();
      let active, lastProgress = 0;
      const safeCode = error => [...new Set([String(error?.code || ''), String(error?.message || '')].join(' ').match(/ERR_[A-Z0-9_]+/g) || [])];
      async function fetchSession(value, url, init) {
        const parsed = new URL(url), service = [new URL(CONFIG_URL).origin, new URL(CONFIG_FALLBACK_URL).origin].includes(parsed.origin);
        if (service ? parsed.pathname !== '/api/client/update-proxy' : !['github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname)) throw Error('unexpected_transport_destination');
        const kind = service ? 'configuration' : init.method === 'HEAD' ? 'probe' : parsed.hostname === 'api.github.com' ? 'metadata' : parsed.pathname.endsWith('SHA256SUMS.txt') ? 'manifest-origin' : parsed.hostname === 'github.com' ? 'installer-origin' : 'official-cdn';
        const record = { operation: active?.kind, kind, session: names.get(value), method: init.method || 'GET', range: new Headers(init.headers).has('range') };
        result.requests.push(record); const started = performance.now();
        try { const response = await electronUpdateFetch(options => net.request(options), value, url, init);
          const ray = response.headers.get('cf-ray');
          Object.assign(record, { status: response.status, headersElapsedMs: Math.round((performance.now() - started) * 1000) / 1000, cfRay: /^[a-f0-9]{16}-[A-Z]{3}$/.test(ray || '') ? ray : null });
          if (kind === 'probe') record.probeAccepted = response.status === 200 && !requestBlockMessage(response);
          if (kind === 'configuration' && response.status === 200) active.configurations++;
          if (kind === 'metadata' || kind === 'manifest-origin') active.selectedSession = names.get(value);
          return response;
        } catch (error) { Object.assign(record, { errorCodes: safeCode(error), aborted: !!init.signal?.aborted, elapsedMs: Math.round(performance.now() - started) }); throw error; }
      }
      const noProxy = { setProxy: async () => {}, resolveProxy: async () => 'DIRECT' };
      const router = createUpdateProxy({ whenReady: () => app.whenReady(), defaultSession: () => noProxy,
        fromPartition: (name, options) => { if (name === SYSTEM_PARTITION) return noProxy;
          const value = session.fromPartition('brclio-production-gate-' + name, options); actualSessions.add(value); names.set(value, name); return value; },
        fetchSession, netFetch: () => { throw Error('unexpected_direct_route'); },
        createBridge: options => { active.candidates++; active.dialAddresses.add(options.nodes[0].dialAddress); return createConnectBridge(options); } });
      const directory = path.join(app.getPath('userData'), 'transport-verification');
      const updater = createUpdater({ currentVersion: input.fixtureVersion, platform: 'win32', architecture: 'x64', directory,
        fetch: async (url, init) => { const response = await router.fetch(url, init);
          if (response.ok && url.endsWith('SHA256SUMS.txt')) result.expectedSHA256 = checksumFor(await response.clone().text(), result.assetName); return response; },
        onOperation: async (kind, enabled, targets) => { if (enabled) { active = { kind, configurations: 0, candidates: 0, dialAddresses: new Set() }; result.operations.push(active); }
          await router.setBusy(enabled, targets); if (!enabled) { active.distinctDialAddresses = active.dialAddresses.size; delete active.dialAddresses; } },
        onState: state => { result.retryCount = state.retryCount; result.lastState = { status: state.status, downloadedBytes: state.downloadedBytes, totalBytes: state.totalBytes, canInstall: state.canInstall, retryCount: state.retryCount };
          if (Date.now() - lastProgress >= 5000) { lastProgress = Date.now(); console.log('BRCLIO_NATIVE_GATE ' + JSON.stringify(result.lastState)); } },
        installPackage: async () => { result.installerInstalled = true; throw Error('installation_forbidden'); } });
      function summarizeOperations() {
        for (const operation of result.operations) { const requests = result.requests.filter(value => value.operation === operation.kind), probes = requests.filter(value => value.kind === 'probe'), successful = probes.filter(value => value.probeAccepted);
          operation.probesStarted = probes.length; operation.successfulProbes = successful.length;
          operation.selectedLatencyMs = successful.find(value => value.session === operation.selectedSession)?.headersElapsedMs ?? null;
          operation.minimumSuccessfulLatencyMs = successful.length ? Math.min(...successful.map(value => value.headersElapsedMs)) : null;
          operation.selectedMinimumWithinTwoMs = operation.selectedLatencyMs !== null && operation.selectedLatencyMs <= operation.minimumSuccessfulLatencyMs + 2;
          operation.officialRequestSessionCount = new Set(requests.filter(value => !['configuration', 'probe'].includes(value.kind)).map(value => value.session)).size;
        }
      }
      try {
        const checked = await updater.check();
        result.actualOfficialRelease = checked.version;
        if (checked.status !== 'available' || (input.expectedVersion && checked.version !== input.expectedVersion)) { result.failure = 'official_release_check_failed_or_changed'; return result; }
        result.assetName = checked.assetName; result.totalBytes = checked.totalBytes;
        const started = performance.now(), downloaded = await updater.download(); result.downloadElapsedMs = Math.round(performance.now() - started); result.retryCount = downloaded.retryCount;
        result.partialFiles = (await fsp.readdir(directory).catch(() => [])).filter(name => name.endsWith('.part')).length;
        if (downloaded.status !== 'downloaded') { result.failure = downloaded.error === '下载超时或连接中断，请重新下载。' ? 'native_download_timeout_or_interrupted' : 'native_download_failed'; return result; }
        const filename = path.join(directory, result.assetName), hash = crypto.createHash('sha256'); result.actualBytes = (await fsp.stat(filename)).size;
        for await (const bytes of fs.createReadStream(filename)) hash.update(bytes); result.actualSHA256 = hash.digest('hex');
        summarizeOperations();
        result.passed = [0, 1].includes(result.retryCount) && downloaded.canInstall && result.actualBytes === result.totalBytes && result.actualSHA256 === result.expectedSHA256 && !result.installerInstalled && result.partialFiles === 0
          && result.requests.every(value => !value.range) && result.operations.length === 2 && result.operations.every(value => value.configurations === 1 && value.candidates >= 1 && value.candidates <= 16 && value.probesStarted === value.candidates && value.selectedMinimumWithinTwoMs && value.officialRequestSessionCount === 1);
        if (!result.passed) result.failure = 'native_transport_evidence_mismatch';
        return result;
      } catch (error) { result.failure = 'native_gate_unexpected_failure'; result.errorCodes = safeCode(error); return result; }
      finally { summarizeOperations(); await router.close(); for (const value of actualSessions) await value.closeAllConnections(); }
    }, { root, fixtureVersion, expectedVersion }));
  } catch { report.passed = false; report.failure = 'electron_launch_or_evaluation_failed'; }
  finally {
    try { await application?.close(); }
    catch { report.passed = false; report.cleanupFailure = 'electron_close_failed'; try { application?.process().kill(); } catch {} }
    finally {
      try { await fs.rm(temporary, { recursive: true, force: true }); report.temporaryFilesCleaned = true; }
      catch { report.passed = false; report.cleanupFailure = 'temporary_cleanup_failed'; report.temporaryFilesCleaned = false; }
      report.finishedAt = new Date().toISOString();
    }
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n'); if (!report.passed) process.exitCode = 1;
})().catch(() => { process.stderr.write('native_proxy_live_gate_setup_failed\n'); process.exitCode = 1; });

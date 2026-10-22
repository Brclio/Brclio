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
  const interruptArgument = argument('--interrupt-after-bytes', null);
  const interruptAfterBytes = interruptArgument === null ? 0 : Number(interruptArgument);
  if (![fixtureVersion, expectedVersion].filter(Boolean).every(value => /^\d+\.\d+\.\d+$/.test(value))) throw Error('invalid_version_argument');
  if (!Number.isSafeInteger(interruptAfterBytes) || interruptAfterBytes < 0 || interruptArgument !== null && interruptAfterBytes < 1) throw Error('invalid_interrupt_offset');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-native-live-gate-'));
  let application;
  const report = { source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    startedAt: new Date().toISOString(), passed: false, actualElectron: true, externalNetworkRequests: true, networkMocked: false,
    systemDetectionControlled: 'DIRECT in isolated test factory only; existing OS/default session proxy unchanged',
    systemSettingsModified: false, tlsVerificationModified: false, installerInstalled: false,
    controlledDisconnect: interruptAfterBytes > 0, interruptAfterBytes,
    defaultTimeoutsMs: { checkAndManifest: 20000, idle: 45000, downloadTotal: null }, timeoutOverrides: false };
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
      const { createUpdater, checksumFor, requestBlockMessage, API_URL } = load('./desktop/updater.cjs');
      const result = { actualAppVersion: app.getVersion(), updaterCurrentVersionFixture: input.fixtureVersion,
        requestedExpectedRelease: input.expectedVersion, fixturePlatform: 'win32', fixtureArchitecture: 'x64', requests: [], operations: [], installerInstalled: false, retryCount: 0, retryLimit: 10,
        controlledDisconnectOccurred: false, interruptedOffset: null };
      const actualSessions = new Set(), names = new WeakMap();
      let active, lastProgress = 0;
      const safeCode = error => [...new Set([String(error?.code || ''), String(error?.message || '')].join(' ').match(/ERR_[A-Z0-9_]+/g) || [])];
      async function fetchSession(value, url, init) {
        const parsed = new URL(url), service = [new URL(CONFIG_URL).origin, new URL(CONFIG_FALLBACK_URL).origin].includes(parsed.origin);
        if (service ? parsed.pathname !== '/api/client/update-proxy' : !['github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname)) throw Error('unexpected_transport_destination');
        const kind = service ? 'configuration' : init.method === 'HEAD' ? 'probe' : parsed.hostname === 'api.github.com' ? 'metadata' : parsed.pathname.endsWith('SHA256SUMS.txt') ? 'manifest-origin' : parsed.hostname === 'github.com' ? 'installer-origin' : 'official-cdn';
        const range = new Headers(init.headers).get('range'), match = range && /^bytes=(\d+)-$/.exec(range);
        const requestKind = service ? 'configuration' : init.method === 'HEAD' ? 'probe' : active?.targetKind;
        const offset = match ? Number(match[1]) : null;
        const record = { operation: active?.kind, operationId: active?.id, kind, requestKind, session: names.get(value), method: init.method || 'GET',
          range: range !== null, rangeOffset: offset,
          rangeAllowed: range === null || requestKind === 'installer' && (init.method || 'GET') === 'GET'
            && Number.isSafeInteger(offset) && offset > 0 && offset <= result.totalBytes };
        result.requests.push(record); const started = performance.now();
        try { const response = await electronUpdateFetch(options => net.request(options), value, url, init);
          const ray = response.headers.get('cf-ray');
          Object.assign(record, { status: response.status, headersElapsedMs: Math.round((performance.now() - started) * 1000) / 1000, cfRay: /^[a-f0-9]{16}-[A-Z]{3}$/.test(ray || '') ? ray : null });
          if (response.status === 206) {
            const parts = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
            const start = parts ? Number(parts[1]) : null, end = parts ? Number(parts[2]) : null, total = parts ? Number(parts[3]) : null;
            record.partialResponse = { start, end, total };
            record.partialResponseValid = record.rangeAllowed && offset !== null && start === offset && total === result.totalBytes
              && Number.isSafeInteger(end) && end >= start && end < total
              && Number(response.headers.get('content-length')) === end - start + 1;
          } else if (response.status === 416) {
            const parts = /^bytes \*\/(\d+)$/.exec(response.headers.get('content-range') || '');
            record.partialResponseValid = record.rangeAllowed && offset === result.totalBytes && !!parts && Number(parts[1]) === result.totalBytes;
          }
          if (record.range && response.status === 200) record.resumeResponse = 'server-restarted-full-response';
          if (kind === 'probe') record.probeAccepted = response.status === 200 && !requestBlockMessage(response);
          if (kind === 'configuration' && response.status === 200) active.configurations++;
          if (kind === 'metadata' || kind === 'manifest-origin') active.selectedSession = names.get(value);
          const prefixOffset = response.status === 206 ? offset : 0;
          if (input.interruptAfterBytes > 0 && !result.controlledDisconnectOccurred && requestKind === 'installer'
              && (response.status === 200 || response.status === 206 && record.partialResponseValid) && response.body
              && Number.isSafeInteger(prefixOffset) && prefixOffset < input.interruptAfterBytes && input.interruptAfterBytes < result.totalBytes) {
            const reader = response.body.getReader(); let delivered = 0;
            const deliverLimit = input.interruptAfterBytes - prefixOffset;
            const body = new ReadableStream({
              async pull(controller) {
                if (delivered >= deliverLimit && !init.signal?.aborted) {
                  result.controlledDisconnectOccurred = true; result.interruptedOffset = prefixOffset + delivered;
                  record.controlledDisconnectOffset = result.interruptedOffset;
                  // Only this validation stream disconnects. Original server
                  // headers/status and every delivered byte are unchanged.
                  void reader.cancel().catch(() => {});
                  controller.error(Object.assign(Error('controlled_installer_disconnect'), { code: 'BRCLIO_UPDATE_NETWORK' }));
                  return;
                }
                try {
                  const item = await reader.read();
                  if (item.done) { controller.close(); return; }
                  const bytes = item.value.subarray(0, Math.min(item.value.length, deliverLimit - delivered));
                  delivered += bytes.length; controller.enqueue(bytes);
                } catch (error) { controller.error(error); }
              },
              cancel: reason => reader.cancel(reason),
            }, { highWaterMark: 0 });
            const controlled = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
            Object.defineProperty(controlled, 'url', { value: response.url });
            return controlled;
          }
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
        fetch: async (url, init) => { active.targetKind = url === API_URL ? 'metadata' : url.endsWith('SHA256SUMS.txt') ? 'manifest' : 'installer';
          const response = await router.fetch(url, init);
          if (response.ok && url.endsWith('SHA256SUMS.txt')) result.expectedSHA256 = checksumFor(await response.clone().text(), result.assetName); return response; },
        onOperation: async (kind, enabled, targets) => {
          if (active?.dialAddresses) { active.distinctDialAddresses = active.dialAddresses.size; delete active.dialAddresses; }
          if (enabled) { active = { id: result.operations.length + 1, kind, configurations: 0, candidates: 0, dialAddresses: new Set() }; result.operations.push(active); }
          await router.setBusy(enabled, targets); },
        onState: state => { result.retryCount = state.retryCount; result.lastState = { status: state.status, downloadedBytes: state.downloadedBytes, resumedBytes: state.resumedBytes || 0,
          resumable: state.resumable === true, totalBytes: state.totalBytes, canInstall: state.canInstall, retryCount: state.retryCount };
          if (active && ((active.kind === 'check' && ['available', 'up-to-date'].includes(state.status)) || (active.kind === 'download' && state.status === 'downloaded'))) active.succeeded = true;
          if (Date.now() - lastProgress >= 5000) { lastProgress = Date.now(); console.log('BRCLIO_NATIVE_GATE ' + JSON.stringify(result.lastState)); } },
        installPackage: async () => { result.installerInstalled = true; throw Error('installation_forbidden'); } });
      function summarizeOperations() {
        for (const operation of result.operations) { const requests = result.requests.filter(value => value.operationId === operation.id), probes = requests.filter(value => value.kind === 'probe'), successful = probes.filter(value => value.probeAccepted);
          if (operation.dialAddresses) { operation.distinctDialAddresses = operation.dialAddresses.size; delete operation.dialAddresses; }
          operation.probesStarted = probes.length; operation.successfulProbes = successful.length;
          operation.selectedLatencyMs = successful.find(value => value.session === operation.selectedSession)?.headersElapsedMs ?? null;
          operation.minimumSuccessfulLatencyMs = successful.length ? Math.min(...successful.map(value => value.headersElapsedMs)) : null;
          operation.selectedMinimumWithinTwoMs = operation.selectedLatencyMs !== null && operation.selectedLatencyMs <= operation.minimumSuccessfulLatencyMs + 2;
          operation.officialRequestSessionCount = new Set(requests.filter(value => !['configuration', 'probe'].includes(value.kind)).map(value => value.session)).size;
        }
      }
      try {
        const checked = await updater.check();
        result.checkRetryCount = checked.retryCount;
        result.actualOfficialRelease = checked.version;
        if (checked.status !== 'available' || (input.expectedVersion && checked.version !== input.expectedVersion)) { result.failure = 'official_release_check_failed_or_changed'; return result; }
        result.assetName = checked.assetName; result.totalBytes = checked.totalBytes;
        const started = performance.now(), downloaded = await updater.download(); result.downloadElapsedMs = Math.round(performance.now() - started); result.retryCount = downloaded.retryCount;
        result.resumedBytes = downloaded.resumedBytes || 0;
        result.rangeRequestCount = result.requests.filter(value => value.range).length;
        result.resumeOffsets = result.requests.filter(value => value.range && value.kind === 'installer-origin').map(value => value.rangeOffset);
        result.rangeRequestsAllowed = result.requests.every(value => value.rangeAllowed);
        result.partialResponsesValid = result.requests.filter(value => [206, 416].includes(value.status)).every(value => value.partialResponseValid);
        result.controlledResumeVerified = input.interruptAfterBytes === 0 || result.controlledDisconnectOccurred
          && result.interruptedOffset === input.interruptAfterBytes
          && result.requests.some(value => value.requestKind === 'installer' && value.status === 206 && value.partialResponseValid && value.rangeOffset === result.interruptedOffset);
        result.partialFiles = (await fsp.readdir(directory).catch(() => [])).filter(name => name.endsWith('.part') || name.endsWith('.part.json')).length;
        if (downloaded.status !== 'downloaded') { result.failure = downloaded.retryExhausted ? 'native_download_retries_exhausted' : 'native_download_failed'; return result; }
        const filename = path.join(directory, result.assetName), hash = crypto.createHash('sha256'); result.actualBytes = (await fsp.stat(filename)).size;
        for await (const bytes of fs.createReadStream(filename)) hash.update(bytes); result.actualSHA256 = hash.digest('hex');
        summarizeOperations();
        const successful = result.operations.filter(value => value.succeeded);
        result.passed = Number.isInteger(result.retryCount) && result.retryCount >= 0 && result.retryCount <= 10 && downloaded.canInstall && result.actualBytes === result.totalBytes && result.actualSHA256 === result.expectedSHA256 && !result.installerInstalled && result.partialFiles === 0
          && result.rangeRequestsAllowed && result.partialResponsesValid && result.controlledResumeVerified && result.operations.length === 2 + result.checkRetryCount + result.retryCount
          && ['check', 'download'].every(kind => successful.filter(value => value.kind === kind).length === 1)
          && successful.every(value => value.configurations === 1 && value.candidates >= 1 && value.candidates <= 16 && value.probesStarted === value.candidates && value.selectedMinimumWithinTwoMs && value.officialRequestSessionCount === 1)
          && result.operations.every(value => value.configurations <= 1 && value.candidates <= 16 && value.officialRequestSessionCount <= 1);
        if (!result.passed) result.failure = 'native_transport_evidence_mismatch';
        return result;
      } catch (error) { result.failure = 'native_gate_unexpected_failure'; result.errorCodes = safeCode(error); return result; }
      finally { summarizeOperations(); await router.close(); for (const value of actualSessions) await value.closeAllConnections(); }
    }, { root, fixtureVersion, expectedVersion, interruptAfterBytes }));
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

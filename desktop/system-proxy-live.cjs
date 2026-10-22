'use strict';

// Check the real system-proxy route in a disposable Electron process. This
// driver never starts Brclio, changes its installed profile, downloads an
// installer, or changes the OS/default-session proxy configuration.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron: electron } = require('@playwright/test');

(async () => {
  const root = path.resolve(__dirname, '..');
  const argument = (name, fallback) => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1) || fallback;
  const fixtureVersion = argument('--current-version', '0.1.10');
  const expectedVersion = argument('--expected-release', null);
  // The gate only reads release metadata. Select an officially shipped asset
  // independently of the runner OS; Linux is not an updater target.
  const fixturePlatform = 'win32', fixtureArchitecture = 'x64';
  if (![fixtureVersion, expectedVersion].filter(Boolean).every(value => /^\d+\.\d+\.\d+$/.test(value))) throw Error('invalid_version_argument');
  const sourceVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-system-proxy-live-'));
  const driver = path.join(temporary, 'driver.cjs');
  let application;
  const report = {
    source: null,
    sourceVersion, fixtureVersion, expectedVersion,
    actualHostPlatform: process.platform, actualHostArchitecture: process.arch,
    fixturePlatform, fixtureArchitecture,
    startedAt: new Date().toISOString(), passed: false,
    actualElectron: false, externalNetworkRequests: true, networkMocked: false,
    systemDetectionControlled: false, systemSettingsModified: false,
    defaultSessionProxyModified: false, installedUserAppTouched: false,
    installerDownloaded: false, installerInstalled: false,
    defaultCheckDeadlineMs: 20000, timeoutOverrides: false,
  };
  try {
    report.source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    await fs.writeFile(driver, `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(temporary, 'profile'))});
app.whenReady().then(()=>new BrowserWindow({show:false}));
app.on('window-all-closed',()=>{});
`);
    application = await electron.launch({ cwd: root, args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), driver] });
    report.actualElectron = true;
    Object.assign(report, await application.evaluate(async ({ app, session, net }, input) => {
      const load = process.getBuiltinModule('node:module').createRequire(input.root + '/package.json');
      const { createUpdateProxy, usesProxy, SYSTEM_PARTITION, DIRECT_PARTITION } = load('./desktop/update-proxy.cjs');
      const { electronUpdateFetch } = load('./desktop/electron-update-fetch.cjs');
      const { createUpdater, API_URL } = load('./desktop/updater.cjs');
      const allowedCodes = new Set([
        'ERR_CONNECTION_CLOSED', 'ERR_PROXY_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED',
        'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_TIMED_OUT',
        'ERR_NAME_NOT_RESOLVED', 'ERR_TIMED_OUT', 'ERR_CERT_AUTHORITY_INVALID',
        'ERR_CERT_COMMON_NAME_INVALID', 'ERR_CERT_DATE_INVALID', 'ERR_CERT_INVALID',
        'ERR_SSL_PROTOCOL_ERROR', 'ERR_SSL_VERSION_OR_CIPHER_MISMATCH', 'ERR_NETWORK_CHANGED',
        'ERR_INTERNET_DISCONNECTED', 'ERR_ABORTED', 'ERR_EMPTY_RESPONSE', 'ERR_HTTP2_PROTOCOL_ERROR',
        'ERR_HTTP_RESPONSE_CODE_FAILURE', 'ERR_BLOCKED_BY_CLIENT', 'ERR_FAILED',
        'ERR_NO_SUPPORTED_PROXIES', 'ERR_MANDATORY_PROXY_CONFIGURATION_FAILED', 'ERR_PAC_SCRIPT_FAILED',
      ]);
      const safeCodes = error => [...new Set(([String(error?.code || ''), String(error?.message || '')].join(' ').match(/ERR_[A-Z0-9_]+/g) || []).filter(value => allowedCodes.has(value)))];
      const result = { systemDetected: false, systemDetectionComplete: false, mode: 'unknown', proxyDetections: [], requests: [], routeStates: [] };
      const isolatedSessions = new Set(), actualSessions = new WeakMap(), stages = new WeakMap();
      const adapters = new Map();
      function trackedSession(actual, stage) {
        if (adapters.has(stage)) return adapters.get(stage);
        const adapter = {
          setProxy: options => {
            if (stage === 'native-default') throw Error('default_session_proxy_change_forbidden');
            return actual.setProxy(options);
          },
          resolveProxy: async url => {
            if (url !== API_URL) throw Error('unexpected_proxy_resolution_target');
            const record = { stage }; result.proxyDetections.push(record);
            try { const answer = await actual.resolveProxy(url); record.systemDetected = usesProxy(answer); return answer; }
            catch (error) { record.errorCodes = safeCodes(error); throw error; }
          },
          closeAllConnections: () => actual.closeAllConnections(),
        };
        adapters.set(stage, adapter); actualSessions.set(adapter, actual); stages.set(adapter, stage);
        return adapter;
      }
      const native = trackedSession(session.defaultSession, 'native-default');
      async function fetchSession(adapter, url, init = {}) {
        if (url !== API_URL || (init.method && init.method !== 'GET')) throw Error('unexpected_transport_target');
        const record = { stage: stages.get(adapter), method: 'GET' }; result.requests.push(record);
        const started = performance.now();
        try {
          const response = await electronUpdateFetch(options => net.request(options), actualSessions.get(adapter), url, init);
          Object.assign(record, { status: response.status, elapsedMs: Math.round(performance.now() - started) });
          if (!response.body) return response;
          const reader = response.body.getReader();
          const body = new ReadableStream({
            async pull(controller) {
              try { const item = await reader.read(); if (item.done) controller.close(); else controller.enqueue(item.value); }
              catch (error) {
                Object.assign(record, { errorCodes: safeCodes(error), aborted: !!init.signal?.aborted, elapsedMs: Math.round(performance.now() - started) });
                controller.error(error);
              }
            },
            cancel: reason => reader.cancel(reason),
          }, { highWaterMark: 0 });
          const observed = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
          Object.defineProperty(observed, 'url', { value: response.url });
          return observed;
        } catch (error) {
          Object.assign(record, { errorCodes: safeCodes(error), aborted: !!init.signal?.aborted, elapsedMs: Math.round(performance.now() - started) });
          throw error;
        }
      }
      const stateRecord = value => ({ enabled: value.enabled, supported: value.supported, route: value.route,
        busy: value.busy, fallbackFrom: value.fallbackFrom || null, errorPresent: !!value.error });
      const router = createUpdateProxy({
        whenReady: () => app.whenReady(), defaultSession: () => native,
        fromPartition: (name, options) => {
          if (![SYSTEM_PARTITION, DIRECT_PARTITION].includes(name)) throw Error('builtin_route_forbidden_in_system_gate');
          const stage = name === SYSTEM_PARTITION ? 'isolated-system' : 'isolated-direct';
          const actual = session.fromPartition('brclio-system-live-' + name, options); isolatedSessions.add(actual);
          return trackedSession(actual, stage);
        },
        fetchSession, netFetch: (url, init) => fetchSession(native, url, init),
        onState: value => { result.routeStates.push(stateRecord(value)); },
      });
      try {
        // Keep actual proxy detection while preventing the VLESS bootstrap from
        // obscuring the system/direct routes that this gate is intended to test.
        result.routerBefore = stateRecord(await router.setEnabled(false));
        const updater = createUpdater({
          currentVersion: input.fixtureVersion, platform: input.fixturePlatform, architecture: input.fixtureArchitecture,
          directory: app.getPath('userData') + '/unused-updates',
          fetch: (url, init) => router.fetch(url, init),
          onOperation: (_kind, busy, targets) => router.setBusy(busy, targets),
          installPackage: async () => { throw Error('installation_forbidden'); },
        });
        const checked = await updater.check();
        result.updaterCheck = { status: checked.status, version: checked.version, canInstall: checked.canInstall };
        result.routerAfter = stateRecord(await router.state());
        result.systemDetected = result.proxyDetections.some(value => value.systemDetected === true);
        result.systemDetectionComplete = ['native-default', 'isolated-system'].every(stage => result.proxyDetections.some(value => value.stage === stage && typeof value.systemDetected === 'boolean'));
        const systemFailed = result.requests.some(value => ['native-default', 'isolated-system'].includes(value.stage) && value.errorCodes);
        const directSucceeded = result.requests.some(value => value.stage === 'isolated-direct' && value.status === 200);
        const fallbackObserved = result.routeStates.some(value => value.fallbackFrom === 'system') || (systemFailed && directSucceeded);
        result.mode = result.systemDetected ? fallbackObserved ? 'system-fallback' : 'system' : result.systemDetectionComplete ? 'no-system' : 'detection-failed';
        result.passed = result.systemDetectionComplete && ['available', 'up-to-date'].includes(checked.status)
          && /^\d+\.\d+\.\d+$/.test(checked.version || '') && (!input.expectedVersion || checked.version === input.expectedVersion);
        if (!result.passed) result.failure = result.systemDetectionComplete ? 'update_check_failed_or_release_changed' : 'system_proxy_detection_failed';
      } catch (error) {
        result.passed = false; result.failure = 'system_proxy_gate_failed'; result.errorCodes = safeCodes(error);
      } finally {
        await router.close();
        await Promise.all([...isolatedSessions, session.defaultSession].map(value => value.closeAllConnections()));
      }
      return result;
    }, { root, fixtureVersion, expectedVersion, fixturePlatform, fixtureArchitecture }));
  } catch {
    report.passed = false; report.failure = 'isolated_electron_launch_or_evaluation_failed';
  } finally {
    try { await application?.close(); }
    catch { report.passed = false; report.cleanupFailure = 'electron_close_failed'; try { application?.process().kill(); } catch {} }
    finally {
      try { await fs.rm(temporary, { recursive: true, force: true }); report.temporaryFilesCleaned = true; }
      catch { report.passed = false; report.cleanupFailure = 'temporary_cleanup_failed'; report.temporaryFilesCleaned = false; }
      report.finishedAt = new Date().toISOString();
    }
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.passed) process.exitCode = 1;
})().catch(() => {
  process.stdout.write(JSON.stringify({ passed: false, failure: 'system_proxy_live_gate_setup_failed' }) + '\n');
  process.exitCode = 1;
});

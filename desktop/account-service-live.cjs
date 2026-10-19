'use strict';
// Release-only account gate. No window, login, email, installation, proxy or
// security-policy changes. Isolate cookies/cache and discard Chromium stderr.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function serviceOrigin(value) {
  const url = new URL(value);
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!local && url.origin !== 'https://tools.brclio.com') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('invalid_origin');
  return url.origin;
}
function metadata(response) {
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase(), ray = response.headers.get('cf-ray');
  return {status: response.status, contentType: ['application/json', 'text/html', 'text/plain'].includes(type) ? type : type ? 'other' : null,
    cfMitigated: response.headers.get('cf-mitigated')?.trim().toLowerCase() === 'challenge' ? 'challenge' : null,
    cfRay: /^[a-f0-9]{16,32}-[A-Z]{3}$/.test(ray || '') ? ray : null};
}
const expected = {session: 200, anonymous_data: 401, foreign_origin: 403, native_with_foreign_origin: 403, private_repository_read: 401};
function ready(value) {
  return value?.ok === true && Object.keys(value.results || {}).length === 5 && Object.entries(expected).every(([name, status]) =>
    value.results[name]?.status === status && value.results[name]?.contentType === 'application/json' && value.results[name]?.cfMitigated === null)
    && value.results.session.googleEnabled === true && value.results.session.emailEnabled === true;
}

async function main() {
  const { app, net, session } = require('electron');
  const directory = process.env.BRCLIO_ACCOUNT_GATE_DIRECTORY;
  if (!directory || !path.isAbsolute(directory)) { app.exit(1); return; }
  app.setPath('userData', path.join(directory, 'profile'));
  app.setName('Brclio');
  const report = {passed: false, actualElectron: true, transport: 'Electron net.request', normalClientTransport: 'Electron net.fetch',
    securitySettingsModified: false, systemSettingsModified: false, installerInstalled: false};
  try {
    const origin = serviceOrigin(process.argv.find(value => value.startsWith('--origin='))?.slice(9) || 'https://tools.brclio.com');
    await app.whenReady();
    report.electronVersion = process.versions.electron;
    // Mirror desktop/account.cjs's normal anonymous native request exactly.
    try {
      const response = await net.fetch(origin + '/api/account/session', {method: 'GET', headers: {Accept: 'application/json', 'X-Brclio-Client': 'native'},
        redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(30000)});
      report.normalClientSession = metadata(response);
      if (response.status === 200 && report.normalClientSession.contentType === 'application/json' && !report.normalClientSession.cfMitigated) {
        const text = await response.text();
        if (text.length > 16384) throw Error('response_too_large');
        const value = JSON.parse(text);
        report.normalClientSession.passed = value.user === null && value.csrf === null && value.googleEnabled === true && value.emailEnabled === true && !response.headers.get('Access-Control-Allow-Origin');
      } else { await response.body?.cancel(); report.normalClientSession.passed = false; }
    } catch { report.normalClientSession = {...report.normalClientSession, passed: false, errorEnum: 'network_or_response_failure'}; }
    const { electronAccountVerifierFetch } = require('./account-verifier-fetch.cjs');
    globalThis.fetch = (url, init) => electronAccountVerifierFetch(options => net.request(options), session.defaultSession, url, init);
    const verifier = path.resolve(__dirname, '../cloudflare/scripts/verify-account-live.mjs');
    process.argv = [process.execPath, verifier, origin, '--ready'];
    const previous = {log: console.log, error: console.error};
    const capture = value => {
      const parsed = JSON.parse(value);
      if (typeof parsed.ok !== 'boolean' || !parsed.results || typeof parsed.results !== 'object') throw Error('invalid_verifier_report');
      report.verifier = parsed;
    };
    try { console.log = capture; console.error = capture; await import(pathToFileURL(verifier).href); }
    finally { console.log = previous.log; console.error = previous.error; }
    report.passed = report.normalClientSession.passed === true && ready(report.verifier) && !process.exitCode;
  } catch { report.passed = false; report.errorEnum = 'electron_account_gate_failed'; }
  finally {
    try { await session.defaultSession.closeAllConnections(); } catch { report.passed = false; report.cleanupFailure = true; }
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report));
    app.exit(report.passed ? 0 : 1);
  }
}

async function launch() {
  const { execFile } = require('node:child_process');
  const origin = serviceOrigin(process.argv.find(value => value.startsWith('--origin='))?.slice(9) || 'https://tools.brclio.com');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-account-gate-'));
  let report = {passed: false, errorEnum: 'electron_launch_or_report_failed'};
  try {
    const env = {...process.env, BRCLIO_ACCOUNT_GATE_DIRECTORY: directory};
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    const code = await new Promise(resolve => execFile(require('electron'), [...(process.platform === 'linux' ? ['--no-sandbox'] : []), __filename, '--electron-entry', '--origin=' + origin],
      {env, timeout: 300000, maxBuffer: 262144}, error => resolve(error ? typeof error.code === 'number' ? error.code : 1 : 0)));
    report = JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8'));
    report.processExitCode = code;
    report.passed = report.passed === true && code === 0 && report.normalClientSession?.passed === true && ready(report.verifier);
  } catch {}
  finally {
    try { await fs.rm(directory, {recursive: true, force: true}); report.temporaryFilesCleaned = true; }
    catch { report.passed = false; report.temporaryFilesCleaned = false; }
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.passed) process.exitCode = 1;
}

(process.argv.includes('--electron-entry') ? main() : launch()).catch(() => {process.stderr.write('account_live_gate_setup_failed\n'); process.exitCode = 1;});

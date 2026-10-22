import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {officialTarget, publicHTTPS, redirectTarget} from '../src/protocol.js';
import {smokeResponseDiagnostic} from './smoke-segment.mjs';
import {nativeHTTPSRequest, parseProxyConfiguration, selectNativeNodes, createSelectedBridge, bootstrapFallbackOrigin} from './native-transport.mjs';

const args = process.argv.slice(2);
const requestHeaders = {'User-Agent': 'Brclio-Updater/1.0', Accept: 'application/vnd.github+json, application/octet-stream;q=0.9', 'Accept-Encoding': 'identity'};
const origin = args.find(arg => arg.startsWith('https://')) || process.env.BRCLIO_CLIENT_SERVICE_URL || process.env.BRCLIO_UPDATE_SERVICE_URL || 'https://tools.brclio.com';
const started = Date.now();
const defaultTimeoutsMs = {checkAndManifest: 20000, idle: 45000, downloadTotal: null};
const progress = {stage: 'setup', bytes: 0, segments: 0, retryCount: 0, configurationRefreshes: 0, bootstrapAttempts: 0, nodesProbed: 0, reachableNodes: 0, selectedLatencyMs: null};
let service, activeResponse, errorEnum = 'invalid_service_origin';
const emptyDiagnostic = () => ({status: null, cfRay: null, cfMitigatedEnum: null, serverEnum: 'missing', routeEnum: 'missing'});
let responseDiagnostic = emptyDiagnostic();
function clearResponse() { activeResponse = undefined; responseDiagnostic = emptyDiagnostic(); errorEnum = null; }
function stage(name) { progress.stage = name; clearResponse(); }
function inspect(response, expected = 200) { activeResponse = response; responseDiagnostic = smokeResponseDiagnostic(response); if (response.status !== expected) errorEnum = 'http_status'; }
function networkFailure(error) { return ['AbortError', 'TimeoutError'].includes(error?.name) || error?.code === 'CANCELLED' ? 'timeout_or_cancelled' : 'network_failed'; }
function publicServiceOrigin() { try { return publicHTTPS(service.origin).origin; } catch { return null; } }
async function cancel(response) { await response?.body?.cancel().catch(() => {}); }

async function boundedBytes(response, limit) {
  assert.ok(response.body, 'Response body missing');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length; assert.ok(size <= limit, 'Response exceeds size limit'); chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

async function configuration(signal) {
  stage('bootstrap');
  const origins = [service.origin];
  if (service.origin === 'https://tools.brclio.com') origins.push(bootstrapFallbackOrigin);
  for (let index = 0; index < origins.length; index++) {
    clearResponse(); progress.bootstrapAttempts++;
    const endpoint = new URL('/api/client/update-proxy', origins[index]);
    let response;
    try { response = await fetch(endpoint, {headers: requestHeaders, redirect: 'manual', credentials: 'omit', signal, cache: 'no-store'}); }
    catch (error) {
      if (!signal.aborted && index + 1 < origins.length) continue;
      errorEnum = networkFailure(error); throw error;
    }
    inspect(response);
    if (response.status === 403 && response.headers.get('cf-mitigated') === 'challenge' && index + 1 < origins.length) { await cancel(response); continue; }
    assert.equal(response.status, 200, 'Configuration HTTP status');
    assert.ok(!response.redirected && (!response.url || response.url === endpoint.href), 'Configuration redirect refused');
    assert.match(response.headers.get('content-type') || '', /^application\/json(?:;|$)/i);
    const document = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await boundedBytes(response, 32 * 1024)));
    const parsed = parseProxyConfiguration(document); progress.configurationRefreshes++;
    return parsed.nodes;
  }
  throw new Error('Configuration unavailable');
}

async function operationBridge(signal) {
  const nodes = await configuration(signal);
  stage('probe'); progress.nodesProbed += nodes.length;
  let selected;
  try { selected = await selectNativeNodes(nodes, signal); }
  catch (error) { errorEnum = 'no_healthy_nodes'; throw error; }
  progress.reachableNodes = selected.reachable; progress.selectedLatencyMs = selected.latencyMs;
  return createSelectedBridge(selected.nodes);
}

async function officialResponse(target, bridge, signal) {
  let url = officialTarget(target).href;
  for (let redirects = 0; ; redirects++) {
    clearResponse();
    let response;
    try { response = await nativeHTTPSRequest(url, {bridge, headers: requestHeaders, signal}); }
    catch (error) { errorEnum = networkFailure(error); throw error; }
    inspect(response);
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      assert.equal(response.status, 200, 'Official download HTTP status');
      assert.ok(!response.redirected, 'Unexpected automatic redirect'); return response;
    }
    const location = response.headers.get('location'); await cancel(response);
    try { assert.ok(location && redirects < 5); url = redirectTarget(location, url).href; }
    catch (error) { errorEnum = 'invalid_redirect'; throw error; }
  }
}

async function verify() {
  service = publicHTTPS(origin); errorEnum = null;
  const checkSignal = AbortSignal.timeout(20000);
  let bridge;
  let release;
  try {
    bridge = await operationBridge(checkSignal); stage('metadata');
    const response = await officialResponse('https://api.github.com/repos/Brclio/Brclio/releases/latest', bridge, checkSignal);
    release = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await boundedBytes(response, 1024 * 1024)));
  } finally { await bridge?.close(); }
  assert.match(release.tag_name, /^v?\d+\.\d+\.\d+$/); assert.equal(release.draft, false); assert.equal(release.prerelease, false);
  const version = release.tag_name.replace(/^v/, '');
  const names = new Set(['android.apk', 'mac-arm64.dmg', 'mac-x64.dmg', 'windows-x64.exe'].map(suffix => `Brclio-${version}-${suffix}`));
  const candidates = release.assets.filter(asset => names.has(asset.name) && (!args.includes('--large') || asset.size > 100 * 1024 * 1024)).sort((a, b) => a.size - b.size);
  assert.ok(candidates.length, 'No suitable official release installer');
  const asset = candidates[0]; assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= 1536 * 1024 * 1024);
  assert.match(asset.digest, /^sha256:[0-9a-f]{64}$/);
  const manifests = release.assets.filter(item => item.name === 'SHA256SUMS.txt'); assert.equal(manifests.length, 1);
  const manifest = manifests[0]; assert.ok(Number.isSafeInteger(manifest.size) && manifest.size > 0 && manifest.size <= 64 * 1024);
  assert.match(manifest.digest, /^sha256:[0-9a-f]{64}$/);
  const expectedBase = `https://github.com/Brclio/Brclio/releases/download/${release.tag_name}/`;
  assert.equal(officialTarget(asset.browser_download_url).href, expectedBase + encodeURIComponent(asset.name));
  assert.equal(officialTarget(manifest.browser_download_url).href, expectedBase + 'SHA256SUMS.txt');

  const download = new AbortController();
  let headerTimer, idleTimer, digest;
  try {
    bridge = await operationBridge(AbortSignal.any([download.signal, AbortSignal.timeout(20000)]));
    stage('manifest');
    const manifestResponse = await officialResponse(manifest.browser_download_url, bridge, AbortSignal.any([download.signal, AbortSignal.timeout(20000)]));
    const manifestBytes = await boundedBytes(manifestResponse, 64 * 1024); assert.equal(manifestBytes.length, manifest.size);
    assert.equal('sha256:' + createHash('sha256').update(manifestBytes).digest('hex'), manifest.digest);
    const lines = new TextDecoder('utf-8', {fatal: true}).decode(manifestBytes).replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
    const entries = lines.map(line => { const match = /^([0-9a-fA-F]{64})[ \t]+\*?([^\r\n]+)$/.exec(line); assert.ok(match); return {hash: match[1].toLowerCase(), name: match[2]}; });
    const selected = entries.filter(entry => entry.name === asset.name); assert.equal(selected.length, 1); assert.equal('sha256:' + selected[0].hash, asset.digest);

    stage('installer'); headerTimer = setTimeout(() => download.abort(), 20000);
    const response = await officialResponse(asset.browser_download_url, bridge, download.signal); clearTimeout(headerTimer);
    assert.equal(response.headers.get('content-length'), String(asset.size));
    assert.ok(!response.headers.has('content-encoding') || response.headers.get('content-encoding') === 'identity');
    assert.ok(response.body);
    const hash = createHash('sha256'), reader = response.body.getReader();
    const refreshIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => download.abort(), 45000); };
    refreshIdle();
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        refreshIdle(); progress.bytes += next.value.length; assert.ok(progress.bytes <= asset.size); hash.update(next.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    assert.equal(progress.bytes, asset.size); digest = hash.digest('hex');
    assert.equal('sha256:' + digest, asset.digest); assert.equal(digest, selected[0].hash); progress.segments = 1;
  } finally { clearTimeout(headerTimer); clearTimeout(idleTimer); await bridge?.close(); }
  return {ok: true, service: service.origin, release: release.tag_name, asset: asset.name, bytes: progress.bytes, sha256: digest,
    manifestVerified: true, downloadMode: 'client-native-vless-wss-stream', defaultTimeoutsMs, timeoutOverrides: false, configurationRefreshes: progress.configurationRefreshes,
    nodesProbed: progress.nodesProbed, reachableNodes: progress.reachableNodes, selectedLatencyMs: progress.selectedLatencyMs, retryCount: 0, durationMs: Date.now() - started};
}

try { console.log(JSON.stringify(await verify(), null, 2)); }
catch (error) {
  await cancel(activeResponse);
  const fallback = ['AbortError', 'TimeoutError'].includes(error?.name) || error?.code === 'CANCELLED' ? 'timeout_or_cancelled'
    : error?.name === 'SyntaxError' ? 'invalid_json' : error?.code === 'ERR_ASSERTION' ? 'validation_failed' : 'unexpected_error';
  console.log(JSON.stringify({ok: false, service: publicServiceOrigin(), ...progress, ...responseDiagnostic, defaultTimeoutsMs, timeoutOverrides: false, errorEnum: errorEnum || fallback, durationMs: Date.now() - started}, null, 2));
  process.exitCode = 1;
}

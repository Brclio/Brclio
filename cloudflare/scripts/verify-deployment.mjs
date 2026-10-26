import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {parseProxyConfiguration} from './native-transport.mjs';

const origin = 'https://tools.brclio.com';
const repository = 'https://github.com/Brclio/Brclio';
const suffixes = {'mac-arm64': 'mac-arm64.dmg', 'mac-x64': 'mac-x64.dmg', 'windows-x64': 'windows-x64.exe', android: 'android.apk'};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
class GateFailure extends Error {
  constructor(code) { super('Deployment verification failed'); this.code = code; }
}
const failure = code => new GateFailure(code);
const discard = body => { try { void body?.cancel().catch(() => {}); } catch {} };

function releaseValid(value) {
  if (!object(value) || typeof value.version !== 'string' || value.version.length > 64 || !/^\d+\.\d+\.\d+$/.test(value.version)
      || ![value.version, `v${value.version}`].includes(value.tag) || value.releaseURL !== `${repository}/releases/tag/${value.tag}`
      || typeof value.publishedAt !== 'string' || !Number.isFinite(Date.parse(value.publishedAt))
      || new Date(value.publishedAt).toISOString() !== value.publishedAt
      || !Array.isArray(value.assets) || value.assets.length < 1 || value.assets.length > 4) return false;
  const platforms = new Set(), base = `${repository}/releases/download/${value.tag}/`;
  return value.assets.every(asset => {
    if (!object(asset) || !Object.hasOwn(suffixes, asset.platform) || platforms.has(asset.platform)) return false;
    platforms.add(asset.platform);
    const name = `Brclio-${value.version}-${suffixes[asset.platform]}`;
    return asset.name === name && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= 4 * 1024 ** 3
      && asset.url === base + encodeURIComponent(name) && asset.checksumURL === base + 'SHA256SUMS.txt';
  });
}

const endpoints = [
  {label: 'homepage', path: '/', limit: 256 * 1024, html: true, valid: value => /<html(?:\s|>)/i.test(value)
    && /<title>[^<]*Brclio[^<]*<\/title>/i.test(value) && /\bid=["']download-grid["']/.test(value) && /\bid=["']release-fallback["']/.test(value)},
  {label: 'health', path: '/api/health', limit: 4096, valid: value => object(value) && value.ok === true
    && value.service === 'brclio-client-services' && value.proxyProtocol === 'vless-tls-websocket'},
  {label: 'anonymous_session', path: '/api/account/session', limit: 8192, valid: value => object(value) && value.user === null
    && value.csrf === null && value.passwordEnabled === false && typeof value.googleEnabled === 'boolean' && typeof value.emailEnabled === 'boolean'},
  {label: 'client_configuration', path: '/api/client/update-proxy', limit: 32 * 1024, valid: value => { parseProxyConfiguration(value); return true; }},
  {label: 'latest_release', path: '/api/releases/latest', limit: 64 * 1024, valid: releaseValid}
];

// Race both headers and every body read, including injected transports which do
// not implement cancellation. Never expose their exception messages or payloads.
function within(promise, signal, abortCode) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure(abortCode()));
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}
async function readBody(response, limit, signal, abortCode) {
  if (Number(response.headers.get('content-length')) > limit) throw failure('body_too_large');
  if (!response.body) throw failure('invalid_body');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', {fatal: true});
  let size = 0, text = '';
  try {
    for (;;) {
      const part = await within(reader.read(), signal, abortCode);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw failure('invalid_body');
      size += part.value.byteLength;
      if (size > limit) throw failure('body_too_large');
      try { text += decoder.decode(part.value, {stream: true}); } catch { throw failure('invalid_utf8'); }
    }
    try { return text + decoder.decode(); } catch { throw failure('invalid_utf8'); }
  } finally { try { void reader.cancel().catch(() => {}); } catch {} }
}

export async function verifyDeployment({fetchImpl = globalThis.fetch, attempts = 3, totalTimeoutMs = 60000, requestTimeoutMs = 15000, retryDelayMs = 500, signal} = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isInteger(attempts) || attempts < 1 || attempts > 3
      || !Number.isInteger(totalTimeoutMs) || totalTimeoutMs < 1 || totalTimeoutMs > 120000
      || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 30000
      || !Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 10000
      || (signal !== undefined && !(signal instanceof AbortSignal))) return {ok: false, errorEnum: 'invalid_options', checks: []};
  const overall = new AbortController(), deadline = setTimeout(() => overall.abort(), totalTimeoutMs);
  const overallCode = () => signal?.aborted ? 'cancelled' : 'deadline_exceeded';
  const overallSignal = AbortSignal.any([overall.signal, signal].filter(Boolean));
  try {
    const checks = await Promise.all(endpoints.map(async endpoint => {
      let last = {endpoint: endpoint.label, status: null, ok: false, errorEnum: 'deadline_exceeded'};
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (overallSignal.aborted) return {...last, ok: false, errorEnum: overallCode()};
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        const active = AbortSignal.any([overallSignal, controller.signal]);
        const abortCode = () => overallSignal.aborted ? overallCode() : 'request_timeout';
        let response, retry = false;
        try {
          const target = origin + endpoint.path;
          const pending = Promise.resolve().then(() => fetchImpl(target, {method: 'GET', credentials: 'omit', redirect: 'manual', cache: 'no-store', signal: active,
            headers: {'User-Agent': 'Brclio-Deployment-Gate/1.0', Accept: endpoint.html ? 'text/html' : 'application/json'}}));
          pending.then(value => { if (active.aborted) discard(value?.body); }, () => {});
          response = await within(pending, active, abortCode);
          const status = Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
          last = {endpoint: endpoint.label, status, ok: false, errorEnum: 'http_status'};
          if (status === null) throw failure('invalid_response');
          if (response.redirected || response.headers.has('location') || (response.url && response.url !== target)) throw failure('unexpected_redirect');
          if (response.headers.get('cf-mitigated') === 'challenge') throw failure('cloudflare_challenge');
          if (response.status !== 200) {
            retry = [408, 425, 429].includes(response.status) || response.status >= 500;
            throw failure('http_status');
          }
          const type = response.headers.get('content-type') || '';
          if (!(endpoint.html ? /^text\/html(?:\s*;|$)/i : /^application\/json(?:\s*;|$)/i).test(type)) throw failure('content_type');
          const text = await readBody(response, endpoint.limit, active, abortCode);
          let value = text;
          if (!endpoint.html) { try { value = JSON.parse(text); } catch { throw failure('invalid_json'); } }
          let valid; try { valid = endpoint.valid(value); } catch { valid = false; }
          if (!valid) throw failure('invalid_schema');
          if (endpoint.label === 'anonymous_session') {
            last.googleEnabled = value.googleEnabled; last.emailEnabled = value.emailEnabled;
            if (!value.googleEnabled || !value.emailEnabled) throw failure('provider_unavailable');
          }
          if (endpoint.label === 'latest_release') last.version = value.version;
          if (active.aborted) throw failure(abortCode());
          return {...last, ok: true, errorEnum: null};
        } catch (error) {
          const code = active.aborted ? abortCode() : (error instanceof GateFailure ? error.code : 'network_failed');
          last.errorEnum = code;
          retry ||= ['network_failed', 'request_timeout'].includes(code);
        } finally { clearTimeout(timer); discard(response?.body); }
        if (!retry || attempt + 1 === attempts || overallSignal.aborted) return last;
        let pause;
        try { await within(new Promise(resolve => { pause = setTimeout(resolve, retryDelayMs); }), overallSignal, overallCode); }
        catch { return {...last, errorEnum: overallCode()}; }
        finally { clearTimeout(pause); }
      }
      return last;
    }));
    return {ok: checks.every(check => check.ok), checks};
  } finally { clearTimeout(deadline); }
}

function loadWranglerTransport() {
  const require = createRequire(import.meta.url);
  return createRequire(require.resolve('wrangler/package.json'))('undici');
}

// Only the CLI reads proxy environment. Importing this module or injecting a
// fetch into verifyDeployment does not load a proxy agent or change globals.
export function createCLITransport({env = process.env, fetchImpl = globalThis.fetch, loadProxyTransport = loadWranglerTransport} = {}) {
  if (!env || typeof env !== 'object') throw failure('invalid_proxy_configuration');
  let proxy;
  for (const name of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY']) {
    const value = env[name];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string') throw failure('invalid_proxy_configuration');
    proxy = value; break;
  }
  if (!proxy) return {fetchImpl, close: async () => {}};
  let address;
  try {
    address = new URL(proxy);
    if (!['http:', 'https:'].includes(address.protocol) || !address.hostname || address.pathname !== '/' || address.search || address.hash) throw failure('invalid_proxy_configuration');
  } catch { throw failure('invalid_proxy_configuration'); }
  let dispatcher, request;
  try {
    const transport = loadProxyTransport();
    if (typeof transport.ProxyAgent !== 'function' || typeof transport.fetch !== 'function') throw failure('proxy_transport_unavailable');
    request = transport.fetch; dispatcher = new transport.ProxyAgent(address.href);
  } catch { throw failure('proxy_transport_unavailable'); }
  let closed = false;
  return {
    fetchImpl: (target, options) => request(target, {...options, dispatcher}),
    async close() {
      if (closed) return; closed = true;
      let timer;
      try {
        await Promise.race([dispatcher.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(failure('proxy_transport_failed')), 2000); })]);
      } catch {
        try { void Promise.resolve(dispatcher.destroy()).catch(() => {}); } catch {}
        throw failure('proxy_transport_failed');
      } finally { clearTimeout(timer); }
    }
  };
}

export async function runCLI({args = process.argv.slice(2), fetchImpl, env = process.env, transportFactory = createCLITransport, print = value => console.log(value)} = {}) {
  let report, transport;
  try {
    if (args.length) report = {ok: false, errorEnum: 'invalid_options', checks: []};
    else {
      if (fetchImpl === undefined) {
        transport = transportFactory({env});
        if (typeof transport?.fetchImpl !== 'function' || typeof transport?.close !== 'function') throw failure('proxy_transport_unavailable');
        fetchImpl = transport.fetchImpl;
      }
      report = await verifyDeployment({fetchImpl});
    }
  } catch (error) { report = {ok: false, errorEnum: error instanceof GateFailure ? error.code : 'verification_failed', checks: []}; }
  finally {
    try { await transport?.close(); }
    catch { report = {...report, ok: false, errorEnum: 'proxy_transport_failed'}; }
  }
  print(JSON.stringify(report));
  return report.ok ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runCLI();

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import {Readable} from 'node:stream';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {createConnectBridge, parseProxyConfiguration} = require('../../desktop/update-connect-bridge.cjs');
export {parseProxyConfiguration};
const hosts = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
export const probeURL = 'https://github.com/robots.txt';
export const bootstrapFallbackOrigin = 'https://brclio-client-services.aiyuechuang.workers.dev';

function failure(code) { const error = new Error('Native update transport failed'); error.code = code; return error; }

// A local CONNECT carries opaque TLS records only. OpenSSL authenticates the
// actual GitHub hostname; the bridge independently authenticates its WSS peer.
export function nativeHTTPSRequest(target, {bridge, signal, method = 'GET', headers = {}, testCA} = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(target), proxy = new URL(bridge.proxyRules);
    if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.username || url.password || url.hash || (url.port && url.port !== '443') ||
        proxy.protocol !== 'http:' || proxy.hostname !== '127.0.0.1' || !proxy.port || proxy.username || proxy.password || proxy.pathname !== '/') return reject(failure('INVALID_TARGET'));
    if (signal?.aborted) return reject(failure('CANCELLED'));
    const agent = new https.Agent({keepAlive: false});
    let connect, secure, request, incoming;
    const abort = () => {
      connect?.destroy(); secure?.destroy(); request?.destroy(failure('CANCELLED')); incoming?.destroy(); agent.destroy();
    };
    const cleanup = () => { signal?.removeEventListener('abort', abort); agent.destroy(); };
    signal?.addEventListener('abort', abort, {once: true});
    agent.createConnection = (_options, callback) => {
      let completed = false;
      const done = (error, socket) => { if (completed) return; completed = true; callback(error, socket); };
      connect = http.request({host: '127.0.0.1', port: Number(proxy.port), method: 'CONNECT', path: `${url.hostname}:443`, agent: false,
        headers: {Host: `${url.hostname}:443`}, signal});
      connect.once('error', () => done(failure(signal?.aborted ? 'CANCELLED' : 'CONNECT_FAILED')));
      connect.once('connect', (response, socket, head) => {
        if (response.statusCode !== 200 || head.length) { socket.destroy(); done(failure('CONNECT_FAILED')); return; }
        secure = tls.connect({socket, servername: url.hostname, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'], ...(testCA ? {ca: testCA} : {})});
        secure.once('error', () => done(failure('TLS_FAILED')));
        secure.once('secureConnect', () => {
          if (!secure.authorized) { secure.destroy(); done(failure('TLS_FAILED')); return; }
          done(null, secure);
        });
      });
      connect.end();
      return undefined;
    };
    request = https.request(url, {agent, method, headers, signal}, response => {
      incoming = response;
      incoming.once('close', cleanup);
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) {
        for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(name, item);
      }
      const noBody = method === 'HEAD' || [204, 205, 304].includes(response.statusCode);
      if (noBody) response.resume();
      const result = new Response(noBody ? null : Readable.toWeb(response), {status: response.statusCode, headers: responseHeaders});
      Object.defineProperty(result, 'url', {value: url.href});
      resolve(result);
    });
    request.once('error', () => { abort(); cleanup(); reject(failure(signal?.aborted ? 'CANCELLED' : 'HTTPS_FAILED')); });
    request.end();
  });
}

export async function selectNativeNodes(nodes, signal, {bridgeFactory = createConnectBridge, request = nativeHTTPSRequest, now = () => performance.now()} = {}) {
  const overall = AbortSignal.any([signal, AbortSignal.timeout(8000)].filter(Boolean));
  const scores = await Promise.all(nodes.map(async (node, index) => {
    let bridge;
    const started = now();
    try {
      const probeSignal = AbortSignal.any([overall, AbortSignal.timeout(4000)]);
      bridge = await bridgeFactory({nodes: [node]});
      const response = await request(probeURL, {bridge, signal: probeSignal, method: 'HEAD', headers: {'User-Agent': 'Brclio-Updater/1.0', 'Accept-Encoding': 'identity'}});
      await response.body?.cancel().catch(() => {});
      if (response.status !== 200 || response.redirected || response.headers.has('location') || response.headers.get('cf-mitigated') === 'challenge') return null;
      return {node, index, latencyMs: now() - started};
    } catch { return null; }
    finally { await bridge?.close(); }
  }));
  const healthy = scores.filter(Boolean).sort((a, b) => a.latencyMs - b.latencyMs || a.index - b.index);
  if (overall.aborted || !healthy.length) throw failure('NO_HEALTHY_NODES');
  return {nodes: healthy.map(item => item.node), candidates: nodes.length, reachable: healthy.length, latencyMs: Math.round(healthy[0].latencyMs)};
}

export async function createSelectedBridge(nodes) { return createConnectBridge({nodes}); }

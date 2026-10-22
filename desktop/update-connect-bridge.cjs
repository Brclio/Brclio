'use strict';

const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns');
const { Transform } = require('node:stream');

const TARGETS = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const TLS_PORTS = new Set([443, 2053, 2083, 2087, 2096, 8443]);
const NODE_KEYS = ['dialAddress', 'host', 'path', 'port', 'servername', 'uuid', 'wsHost'];
// VLESS carries a TCP byte stream: a peer may group many TLS records into one
// WebSocket message. Keep reassembly bounded while accepting larger batches.
const MAX_WS_MESSAGE = 8 * 1024 * 1024;
const FAILURE = '内置更新代理连接失败，可关闭内置代理或稍后重试。';
function safeError(code = 'BRCLIO_UPDATE_NETWORK') { return Object.assign(new Error(FAILURE), { code }); }
function certificateFailure(error) {
  return /^(?:ERR_CERT_|ERR_TLS_CERT_|CERT_HAS_EXPIRED$|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_VERIFY_LEAF_SIGNATURE$|UNABLE_TO_GET_ISSUER_CERT_LOCALLY$)/.test(String(error?.code || ''));
}

function publicDNS(value) {
  return typeof value === 'string' && value === value.toLowerCase() && value.length <= 253 && value.includes('.') && !net.isIP(value)
    && /^[a-z0-9.-]+$/i.test(value) && /\.[a-z]{2,63}$/i.test(value)
    && !/\.(?:local|localhost|internal|invalid|test|example|onion|lan|home)$/i.test(value) && !/(?:^|\.)home\.arpa$/.test(value)
    && value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function publicIPv4(value) {
  if (typeof value !== 'string' || net.isIP(value) !== 4) return false;
  const [a, b, c] = value.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}

function nodeLookup(node, resolve = dns.lookup) {
  return (hostname, options, callback) => {
    options ||= {};
    if (hostname !== node.host) { callback(safeError()); return; }
    // Configured preferred IPs only change TCP routing. WSS URL, Host, SNI and
    // certificate identity continue to use the authenticated DNS hostname.
    resolve(node.dialAddress, { ...options, family: 4 }, (error, address, family) => {
      if (error) { callback(safeError()); return; }
      if (options.all) {
        const allowed = address.filter(value => value.family === 4 && publicIPv4(value.address));
        if (allowed.length) callback(null, allowed); else callback(safeError());
      } else if (family === 4 && publicIPv4(address)) callback(null, address, family);
      else callback(safeError());
    });
  };
}

function parseProxyConfiguration(value) {
  if (!value || value.version !== 1 || !Number.isInteger(value.ttlSeconds) || value.ttlSeconds < 1 || value.ttlSeconds > 600
      || !Array.isArray(value.nodes) || value.nodes.length < 1 || value.nodes.length > 16) throw safeError();
  const nodes = value.nodes.map(node => {
    if (!node || Object.keys(node).sort().join(',') !== NODE_KEYS.join(',')
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(node.uuid)
        || !publicDNS(node.host) || node.host !== node.servername || node.host !== node.wsHost
        || !(publicIPv4(node.dialAddress) || publicDNS(node.dialAddress))
        || !TLS_PORTS.has(node.port) || typeof node.path !== 'string' || !node.path.startsWith('/') || node.path.startsWith('//')
        || Buffer.byteLength(node.path) > 2048 || /[^\x21-\x7e]|[\\#]|%(?![0-9a-f]{2})/i.test(node.path)) throw safeError();
    return Object.freeze({ uuid: node.uuid, host: node.host, dialAddress: node.dialAddress, port: node.port, path: node.path, servername: node.servername, wsHost: node.wsHost });
  });
  return { nodes, ttlSeconds: value.ttlSeconds };
}

function targetHost(authority) {
  const match = /^([a-z0-9.-]+):443$/i.exec(authority || '');
  return match && TARGETS.has(match[1].toLowerCase()) ? match[1].toLowerCase() : null;
}

function vlessHeader(node, hostname) {
  const host = Buffer.from(hostname, 'ascii');
  return Buffer.concat([Buffer.from([0]), Buffer.from(node.uuid.replaceAll('-', ''), 'hex'), Buffer.from([0, 1, 1, 187, 2, host.length]), host]);
}

class VlessResponse extends Transform {
  constructor() { super(); this.header = Buffer.alloc(0); this.remaining = null; this.complete = false; }
  _transform(chunk, _encoding, callback) {
    if (this.complete) { callback(null, chunk); return; }
    let offset = 0;
    if (this.header.length < 2) {
      const take = Math.min(2 - this.header.length, chunk.length);
      this.header = Buffer.concat([this.header, chunk.subarray(0, take)]); offset += take;
      if (this.header.length < 2) { callback(); return; }
      if (this.header[0] !== 0) { callback(safeError()); return; }
      this.remaining = this.header[1];
    }
    const skip = Math.min(this.remaining, chunk.length - offset); offset += skip; this.remaining -= skip;
    if (this.remaining === 0) { this.complete = true; this.header = null; callback(null, chunk.subarray(offset)); }
    else callback();
  }
  _flush(callback) { callback(this.complete ? null : safeError()); }
}

async function createConnectBridge({ nodes, WebSocketClass } = {}) {
  WebSocketClass ||= require('ws');
  // The caller already parsed the fixed public configuration; validate again so
  // this listener can never become a general-purpose local proxy accidentally.
  nodes = parseProxyConfiguration({ version: 1, ttlSeconds: 600, nodes }).nodes;
  const clients = new Set(); const tunnels = new Set(); let closed = false; let closing; let preferred = 0, failureCode;
  const server = http.createServer({ maxHeaderSize: 8192 }, (_request, response) => { response.writeHead(403); response.end(); });
  server.headersTimeout = 10000; server.requestTimeout = 10000; server.maxHeadersCount = 32;
  server.on('connection', client => {
    if (closed || clients.size >= 8) { client.destroy(); return; }
    clients.add(client); client.on('error', () => {}); client.once('close', () => clients.delete(client));
    client.setTimeout(45000, () => client.destroy());
  });
  server.on('clientError', (_error, client) => client.destroy());
  server.on('connect', async (request, client, head) => {
    failureCode = undefined;
    const hostname = targetHost(request.url);
    if (!hostname || request.headers.origin || request.headers['transfer-encoding'] || Number(request.headers['content-length'] || 0) !== 0) {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    client.pause();
    let connected;
    // Fail over only before CONNECT succeeds or any official TLS bytes flow.
    for (let attempt = 0; attempt < Math.min(nodes.length, 3) && !client.destroyed && !closed; attempt++) {
      const index = (preferred + attempt) % nodes.length, node = nodes[index];
      try {
        connected = await new Promise((resolve, reject) => {
          const ws = new WebSocketClass(`wss://${node.host}:${node.port}${node.path}`, {
            headers: { Host: node.wsHost }, servername: node.servername, rejectUnauthorized: true, minVersion: 'TLSv1.2',
            lookup: nodeLookup(node), family: 4,
            followRedirects: false, perMessageDeflate: false, handshakeTimeout: 5000, maxPayload: MAX_WS_MESSAGE, agent: false,
          });
          tunnels.add(ws);
          const abort = () => ws.terminate();
          client.once('close', abort);
          ws.once('close', () => { tunnels.delete(ws); client.removeListener('close', abort); });
          ws.on('error', () => {});
          ws.on('message', (_data, binary) => { if (!binary) ws.terminate(); });
          ws.once('unexpected-response', (_req, response) => { failureCode = [301, 302, 303, 307, 308, 403, 429].includes(response.statusCode) ? 'BRCLIO_UPDATE_ROUTE' : 'BRCLIO_UPDATE_NETWORK'; response.destroy(); ws.terminate(); reject(safeError(failureCode)); });
          ws.once('error', error => { failureCode = certificateFailure(error) ? 'BRCLIO_UPDATE_SECURITY' : failureCode || 'BRCLIO_UPDATE_NETWORK'; reject(safeError(failureCode)); });
          ws.once('close', () => reject(safeError()));
          ws.once('open', () => {
            if (client.destroyed || closed) { ws.terminate(); reject(safeError()); return; }
            preferred = index; resolve({ ws, node });
          });
        });
        break;
      } catch { /* Never include transport URLs, credentials, or remote bodies. */ }
    }
    if (!connected || client.destroyed || closed) { connected?.ws.terminate(); client.destroy(); return; }
    const { ws, node } = connected;
    const stream = WebSocketClass.createWebSocketStream(ws, { highWaterMark: 64 * 1024 });
    const decoded = new VlessResponse();
    let finished = false;
    const finish = () => { if (finished) return; finished = true; decoded.destroy(); stream.destroy(); ws.terminate(); client.destroy(); };
    stream.on('error', finish); decoded.on('error', finish); client.once('error', finish);
    stream.once('close', () => { if (!stream.readableEnded) finish(); });
    client.once('close', finish);
    stream.write(vlessHeader(node, hostname), error => {
      if (error || client.destroyed || closed) { finish(); return; }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) stream.write(head);
      client.pipe(stream);
      stream.pipe(decoded).pipe(client);
      client.resume();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  server.on('error', () => {});
  return {
    proxyRules: `http://127.0.0.1:${server.address().port}`,
    get failureCode() { return failureCode; },
    close() {
      if (closing) return closing; closed = true;
      for (const tunnel of tunnels) tunnel.terminate();
      for (const client of clients) client.destroy();
      closing = new Promise(resolve => server.close(() => resolve()));
      return closing;
    },
  };
}

module.exports = { createConnectBridge, parseProxyConfiguration, targetHost, VlessResponse, nodeLookup, publicIPv4 };

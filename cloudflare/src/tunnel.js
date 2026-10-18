import { startTls } from 'subtls/index.js';
import { rootCerts } from './roots.js';
import { ByteReader, encoder, decoder, concat, vlessHeader, readHTTPHead, httpBody } from './protocol.js';

export class TunnelError extends Error {
  constructor(stage, code, cause, detail = {}) { super('代理连接失败', {cause}); this.stage = stage; this.code = code; this.detail = detail; }
}
export function safeFailure(error) {
  if (error instanceof TunnelError) return {stage:error.stage, code:error.code, ...error.detail};
  return {stage:'relay',code:'upstream_failed'};
}
const MAX_QUEUED = 16 * 1024 * 1024;

// An exact-byte reader with peek support is required by subtls' TLS record parser.
export class SocketQueue {
  constructor(socket, {idleMs = 15000, maxQueued = MAX_QUEUED} = {}) {
    socket.binaryType = 'arraybuffer';
    this.socket = socket; this.chunks = []; this.offset = 0; this.size = 0;
    this.receivedFrames = 0; this.receivedBytes = 0;
    this.ended = false; this.error = null; this.waiter = null; this.maxQueued = maxQueued;
    this.idleMs = idleMs;
    this.refresh();
    socket.addEventListener('message', event => {
      if(this.ended)return;
      if (!(event.data instanceof ArrayBuffer) && !ArrayBuffer.isView(event.data)) return this.fail(new Error('代理返回无效二进制帧'));
      const data = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : new Uint8Array(event.data.buffer,event.data.byteOffset,event.data.byteLength);
      this.receivedFrames++; this.receivedBytes += data.length;
      if (this.size + data.length > this.maxQueued) return this.fail(new Error('代理缓冲区超限'));
      if (data.length) { this.chunks.push(data); this.size += data.length; this.refresh(); this.wake(); }
    });
    socket.addEventListener('close', () => { this.ended = true; this.wake(); clearTimeout(this.timer); });
    socket.addEventListener('error', () => this.fail(new Error('代理连接失败')));
  }
  refresh() { clearTimeout(this.timer); this.timer = setTimeout(() => this.fail(new Error('代理连接超时')), this.idleMs); }
  wake() { this.waiter?.(); this.waiter = null; }
  fail(error) { if(this.ended)return; this.error = error; this.close(); }
  close() { this.ended = true; clearTimeout(this.timer); try { this.socket.close(1000, 'Done'); } catch {} this.wake(); }
  async read(n, mode = 0) {
    while (this.size < n && !this.ended) await new Promise(resolve => { this.waiter = resolve; });
    if (this.error) throw this.error;
    if (this.size < n) return undefined;
    const out = new Uint8Array(n); let written = 0, index = 0, offset = this.offset;
    while (written < n) { const chunk = this.chunks[index++]; const take = Math.min(n - written, chunk.length - offset); out.set(chunk.subarray(offset, offset + take), written); written += take; offset = 0; }
    if (mode !== 1) {
      this.size -= n; let remaining = n;
      while (remaining) { const available = this.chunks[0].length - this.offset; if (remaining < available) { this.offset += remaining; break; } remaining -= available; this.chunks.shift(); this.offset = 0; }
    }
    return out;
  }
}

export async function openWebSocket(node, fetchImpl = fetch, signal) {
  const u = new URL(`https://${node.host}:${node.port}${node.path}`);
  const response = await fetchImpl(u, {headers: {Upgrade: 'websocket', Host: node.host}, redirect: 'manual', signal});
  const socket = response.webSocket;
  if (!socket || response.status !== 101) { await response.body?.cancel(); throw new Error('代理 WebSocket 握手失败'); }
  const queue = new SocketQueue(socket);
  socket.accept();
  return {socket, queue};
}

export async function tunnelRequest(target, node, {range, signal, openSocket = openWebSocket, handshakeMs = 4500} = {}) {
  const abort = new AbortController();
  let queue, socket, stage = 'ws', phase = 'ws_open', sentFrames = 0;
  const fail = () => { abort.abort(); queue?.fail(new Error('代理连接已取消')); };
  signal?.addEventListener('abort', fail, {once: true});
  if (signal?.aborted) { signal?.removeEventListener('abort', fail); throw new TunnelError('ws','cancelled'); }
  const timer = setTimeout(fail, handshakeMs);
  const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', fail); queue?.close(); };
  try {
    ({socket, queue} = await openSocket(node, undefined, abort.signal));
    stage = 'vless';
    const initialHeader = vlessHeader(node.uuid, target.hostname);
    let firstWrite = true;
    const networkWrite = data => {
      // VLESS WS servers may require the initial TCP payload in the first frame.
      phase = 'tls_write_started';
      socket.send(firstWrite ? concat(initialHeader,data) : data);
      sentFrames++;
      firstWrite = false;
    };
    // Strip and validate the VLESS response header before passing TLS bytes to subtls.
    let headerRead = false;
    const networkRead = async (n, mode) => {
      if (!headerRead) {
        phase = 'vless_response_wait';
        const response = await queue.read(2);
        if (!response || response[0] !== 0) throw new TunnelError('vless','invalid_response');
        if (response[1]) { if (!await queue.read(response[1])) throw new TunnelError('vless','invalid_response'); }
        headerRead = true;
      }
      phase = 'tls_read_wait';
      const bytes = await queue.read(n, mode);
      phase = 'tls_processing';
      return bytes;
    };
    stage = 'tls'; phase = 'tls_keygen';
    const tls = await startTls(target.hostname, rootCerts, networkRead, networkWrite);
    stage = 'http';
    const headers = [
      `GET ${target.pathname}${target.search} HTTP/1.1`, `Host: ${target.hostname}`,
      'User-Agent: Brclio-Updater/1.0', 'Accept: application/vnd.github+json, application/octet-stream;q=0.9, */*;q=0.8',
      'Accept-Encoding: identity', 'Connection: close'
    ];
    if (range) headers.push(`Range: ${range}`);
    await tls.write(encoder.encode(headers.join('\r\n') + '\r\n\r\n'));
    phase = 'http_header_wait';
    const reader = new ByteReader(() => tls.read());
    const head = await readHTTPHead(reader);
    clearTimeout(timer);
    return {...head, body: httpBody(reader, head.headers, cleanup), close: cleanup};
  } catch (error) { cleanup(); if (error instanceof TunnelError) throw error; throw new TunnelError(stage, abort.signal.aborted ? 'timeout_or_cancelled' : (stage === 'tls' ? 'handshake_failed' : 'upstream_failed'), error, {phase, sentFrames, receivedFrames:queue?.receivedFrames || 0, receivedBytes:queue?.receivedBytes || 0}); }
}

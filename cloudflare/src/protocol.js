import { parse } from 'yaml';

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
export function concat(...chunks) {
  const out = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const b of chunks) { out.set(b, offset); offset += b.length; }
  return out;
}

export function publicHTTPS(value) {
  const u = new URL(value);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (u.protocol !== 'https:' || u.username || u.password || u.hash || (u.port && u.port !== '443') ||
      !host.includes('.') || /^(?:localhost|.*\.localhost|.*\.local|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|::|fc|fd|fe80:)/i.test(host) ||
      /^\d+\./.test(host) || host.includes(':')) throw new Error('需要公网 HTTPS 地址');
  return u;
}

export function officialTarget(value) {
  const u = publicHTTPS(value);
  if (u.search || u.hash) throw new Error('不支持该更新地址');
  const p = u.pathname;
  if (u.hostname === 'api.github.com' && p === '/repos/Brclio/Brclio/releases/latest') return u;
  if (u.hostname === 'github.com' && /^\/Brclio\/Brclio\/releases\/download\/[^/]+\/[^/]+$/.test(p) && !/%2f|%5c|%00/i.test(p)) return u;
  throw new Error('只允许 Brclio 官方版本与安装包');
}

export function redirectTarget(value, previous) {
  const u = publicHTTPS(new URL(value, previous).href);
  if (u.hostname === 'github.com' || u.hostname === 'api.github.com') return officialTarget(u.href);
  if (new URL(previous).hostname !== 'github.com') throw new Error('下载重定向异常');
  if (u.hostname === 'release-assets.githubusercontent.com' && /^\/github-production-release-asset\/\d+\/[a-zA-Z0-9-]+$/.test(u.pathname)) return u;
  if (u.hostname === 'objects.githubusercontent.com' && /^\/github-production-release-asset-\S+$/.test(u.pathname)) return u;
  throw new Error('下载重定向异常');
}

export function parseSubscription(text) {
  if (encoder.encode(text).length > 1024 * 1024) throw new Error('订阅文件过大');
  let proxies;
  if (/^(?:dmxlc3M|vless:\/\/)/.test(text.trim())) {
    const raw = text.trim().startsWith('vless://') ? text : atob(text.trim());
    proxies = raw.split(/\r?\n/).filter(s => s.startsWith('vless://')).map(s => {
      const u = new URL(s), q = u.searchParams;
      return { type: 'vless', server: u.hostname, port: Number(u.port || 443), uuid: u.username, tls: q.get('security') === 'tls', network: q.get('type'), servername: q.get('sni'), flow: q.get('flow'), 'ws-opts': {path: q.get('path') || '/', headers: {Host: q.get('host') || q.get('sni') || u.hostname}} };
    });
  } else {
    proxies = parse(text, {maxAliasCount: 0})?.proxies;
  }
  const nodes = [];
  const seen = new Set();
  for (const p of (Array.isArray(proxies) ? proxies : []).slice(0, 128)) {
    if (p.type !== 'vless' || p.tls !== true || p.network !== 'ws' || p.flow || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.uuid || '')) continue;
    const host = p['ws-opts']?.headers?.Host || p.servername || p.server;
    const sni = p.servername || host;
    // The Workers WebSocket API authenticates the URL hostname. Never disable TLS verification,
    // and never dial an IP with an unrelated certificate or pretend Host changes TLS SNI.
    if (host !== sni || !/^[a-z0-9.-]+$/i.test(host) || !host.includes('.')) continue;
    const port = Number(p.port || 443);
    if (![443, 2053, 2083, 2087, 2096, 8443].includes(port)) continue;
    const path = p['ws-opts']?.path || '/';
    if (typeof path !== 'string' || !path.startsWith('/') || /[\r\n]/.test(path)) continue;
    const node = {uuid: p.uuid, host, port, path};
    const key = JSON.stringify(node);
    if (!seen.has(key)) { seen.add(key); nodes.push(node); }
  }
  nodes.sort((a, b) => (a.port !== 443) - (b.port !== 443));
  if (!nodes.length) throw new Error('订阅中没有兼容的 VLESS TLS WebSocket 节点');
  return nodes;
}

export function vlessHeader(uuid, hostname, port = 443) {
  const id = Uint8Array.from(uuid.replaceAll('-', '').match(/../g), s => parseInt(s, 16));
  const name = encoder.encode(hostname);
  if (id.length !== 16 || name.length > 255) throw new Error('无效的代理目标');
  // VLESS version, UUID, no addons, TCP command, port, domain address type, host length, host.
  return concat(new Uint8Array([0]), id, new Uint8Array([0, 1, port >> 8, port & 255, 2, name.length]), name);
}

export class ByteReader {
  constructor(read) { this.readNext = read; this.pending = new Uint8Array(); this.offset = 0; this.lastLineContentBytes = 0; }
  take(n) {
    const bytes = this.pending.subarray(this.offset, this.offset + n);
    this.offset += n;
    if (this.offset === this.pending.length) { this.pending = new Uint8Array(); this.offset = 0; }
    return bytes;
  }
  async fill() {
    if (this.offset < this.pending.length) return;
    const next = await this.readNext();
    if (!next?.length) throw new Error('代理连接提前结束');
    this.pending = next; this.offset = 0;
  }
  async readSome() {
    if (this.offset < this.pending.length) return this.take(this.pending.length - this.offset);
    return this.readNext();
  }
  async exact(n) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('无效的读取长度');
    if (!n) return new Uint8Array();
    await this.fill();
    if (this.pending.length - this.offset >= n) return this.take(n);
    const result = new Uint8Array(n); let written = 0;
    while (written < n) {
      await this.fill();
      const bytes = this.take(Math.min(n - written, this.pending.length - this.offset));
      result.set(bytes, written); written += bytes.length;
    }
    return result;
  }
  async line(max = 8192) {
    if (!Number.isSafeInteger(max) || max < 1) throw new Error('响应头过大');
    const parts = []; let length = 0;
    while (length < max) {
      await this.fill();
      const end = Math.min(this.pending.length, this.offset + max - length);
      const newline = this.pending.subarray(this.offset, end).indexOf(10);
      const part = this.take(newline < 0 ? end - this.offset : newline + 1);
      parts.push(part); length += part.length;
      if (newline >= 0) {
        const bytes = parts.length === 1 ? part : concat(...parts);
        if (bytes.length < 2 || bytes.at(-2) !== 13) throw new Error('无效的 HTTP 行结束');
        const content = bytes.subarray(0, bytes.length - 2);
        if (content.includes(13)) throw new Error('无效的 HTTP 行结束');
        this.lastLineContentBytes = length - 2;
        return decoder.decode(content);
      }
    }
    throw new Error('响应头过大');
  }
}

export async function readHTTPHead(reader) {
  const statusLine = await reader.line();
  const match = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(statusLine);
  if (!match) throw new Error('代理返回无效 HTTP 响应');
  const headers = new Headers(); let size = 0;
  while (true) {
    const line = await reader.line(); size += reader.lastLineContentBytes;
    if (size > 32768) throw new Error('响应头过大');
    if (!line) break;
    const colon = line.indexOf(':');
    if (colon < 1 || /^[ \t]/.test(line)) throw new Error('无效的响应头');
    headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
  }
  if (headers.has('transfer-encoding') && headers.get('transfer-encoding').toLowerCase() !== 'chunked') throw new Error('不支持的传输编码');
  if (headers.has('transfer-encoding') && headers.has('content-length')) throw new Error('响应长度冲突');
  return {status: Number(match[1]), headers};
}

export function httpBody(reader, headers, close) {
  let left = headers.has('content-length') ? Number(headers.get('content-length')) : null;
  if (left !== null && (!Number.isSafeInteger(left) || left < 0)) throw new Error('无效响应长度');
  const chunked = headers.get('transfer-encoding')?.toLowerCase() === 'chunked';
  let chunkLeft = 0, finished = false;
  return new ReadableStream({
    async pull(controller) {
      try {
        if (finished || left === 0) { controller.close(); close(); return; }
        if (chunked) {
          if (!chunkLeft) {
            const line = await reader.line();
            if (!/^[0-9a-f]+(?:;.*)?$/i.test(line)) throw new Error('无效分块长度');
            chunkLeft = parseInt(line.split(';')[0], 16);
            if (!Number.isSafeInteger(chunkLeft) || chunkLeft > 1024 * 1024 * 1024) throw new Error('无效分块长度');
            if (!chunkLeft) { let trailerSize = 0; while (true) { const s = await reader.line(); trailerSize += reader.lastLineContentBytes; if (trailerSize > 32768) throw new Error('响应尾部过大'); if (!s) break; } finished = true; controller.close(); close(); return; }
          }
          const data = await reader.exact(Math.min(chunkLeft, 16384)); chunkLeft -= data.length;
          if (!chunkLeft && decoder.decode(await reader.exact(2)) !== '\r\n') throw new Error('无效分块结束');
          controller.enqueue(data); return;
        }
        const data = await reader.readSome();
        if (!data?.length) { if (left > 0) throw new Error('下载未完成'); finished = true; controller.close(); close(); return; }
        if (left !== null) { if (data.length > left) throw new Error('响应长度超限'); left -= data.length; }
        controller.enqueue(data);
      } catch (e) { close(); controller.error(e); }
    }, cancel() { close(); }
  });
}

import { renderPage } from './page.mjs';

const ORIGIN = 'https://tools.brclio.com';
const ROOT = '/downloader/';
const GH = 'https://github.com/Brclio/Brclio/releases/download/';
const REDIRECT = new Set([301, 302, 303, 307, 308]);
const PLATFORMS = [
  {id:'mac-arm64', suffix:'mac-arm64.dmg', label:'macOS · Apple Silicon'},
  {id:'mac-x64', suffix:'mac-x64.dmg', label:'macOS · Intel'},
  {id:'windows-x64', suffix:'windows-x64.exe', label:'Windows · x64'}
];
const EDITIONS = {
  lite:{prefix:'Brclio-Downloader-Lite-', tag:'lite-v', channel:'lite-stable', limit:16 * 1024 * 1024},
  full:{prefix:'Brclio-Downloader-', tag:'downloader-v', channel:'downloader-stable', limit:512 * 1024 * 1024},
};
const responseHeaders = {
  'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer', 'X-Frame-Options':'DENY',
};
const failure = (message, status) => new Response(message, {status, headers:responseHeaders});

export function validateIndex(doc, edition) {
  const spec = EDITIONS[edition];
  if (!spec || !doc || typeof doc.version !== 'string' ||
      !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(doc.version) ||
      !Array.isArray(doc.assets) || doc.assets.length !== PLATFORMS.length) throw Error('invalid_index');
  const assets = PLATFORMS.map(platform => {
    const name = spec.prefix + doc.version + '-' + platform.suffix;
    const file = doc.assets.find(entry => entry?.name === name);
    if (!file || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > spec.limit ||
        typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) throw Error('invalid_asset');
    // URLs are derived from the edition, numeric version and local platform table.
    return {...platform, name, size:file.size, sha256:file.sha256, url:GH + spec.tag + doc.version + '/' + name};
  });
  return {version:doc.version, assets};
}

function releaseCDN(url) {
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
    (url.hostname === 'release-assets.githubusercontent.com' || url.hostname === 'objects.githubusercontent.com') &&
    /^\/github-production-release-asset(?:\/|-)/.test(url.pathname);
}
async function officialResponse(start, fetcher, signal) {
  let current = start;
  for (let i=0; i<=3; i++) {
    const res = await fetcher(current, {method:'GET', redirect:'manual', signal,
      headers:{'User-Agent':'Brclio-Downloader-Distribution','Accept':'application/octet-stream','Accept-Encoding':'identity'}});
    if (res.redirected || (res.url && res.url !== current)) { await res.body?.cancel(); throw Error('unexpected_redirect'); }
    if (res.status === 200) return res;
    const loc = res.headers.get('location');
    await res.body?.cancel();
    if (!REDIRECT.has(res.status) || !loc) throw Error('release_unavailable');
    const next = new URL(loc,current);
    if (!releaseCDN(next)) throw Error('untrusted_redirect');
    current = next.href;
  }
  throw Error('too_many_redirects');
}

async function readBounded(res, limit, exact = false) {
  const reader = res.body?.getReader();
  if (!reader) throw Error('empty_release');
  const bytes = new Uint8Array(limit);
  let offset = 0;
  try {
    const length = res.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length)>limit || (exact && Number(length)!==limit))) {
      throw Error('bad_length');
    }
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      if (offset + value.length > limit) throw Error('excess_bytes');
      bytes.set(value,offset);
      offset += value.length;
    }
    if (!offset || (exact && offset!==limit)) throw Error('missing_bytes');
    return bytes.subarray(0,offset);
  } finally { await reader.cancel().catch(() => {}); }
}

function store(cache, context, key, res) {
  if (cache) context.waitUntil(cache.put(key,res).catch(() => {}));
}
async function index(edition, cache, context, fetcher) {
  const key = new Request(ORIGIN + ROOT + '_cache/index/' + edition);
  const cached = await cache?.match(key).catch(() => undefined);
  if (cached) return validateIndex(JSON.parse(await cached.text()), edition);
  const url = GH + EDITIONS[edition].channel + '/latest.json';
  const res = await officialResponse(url, fetcher, AbortSignal.timeout(12000));
  const raw = new TextDecoder('utf-8',{fatal:true}).decode(await readBounded(res,8192));
  const result = validateIndex(JSON.parse(raw), edition);
  store(cache,context,key,new Response(raw,{headers:{'Cache-Control':'public, max-age=60'}}));
  return result;
}
// Cache hits stream without buffering. Bound concurrent cold-cache verification
// across requests sharing one isolate (Workers isolates have a fixed memory limit).
let verifyingBytes = 0;
const verificationBudget = 24 * 1024 * 1024;
const toHex = bytes => Array.from(new Uint8Array(bytes),value => value.toString(16).padStart(2,'0')).join('');

async function download(file, method, cache, ctx, fetcher) {
  const key = new Request(ORIGIN + ROOT + '_cache/file/' + file.sha256 + '/' + file.name);
  const cacheHeaders = {'Content-Type':'application/octet-stream','Content-Length':String(file.size),
    'Content-Disposition':'attachment; filename="' + file.name + '"', ETag:'"' + file.sha256 + '"',
    'X-Checksum-Sha256':file.sha256, 'X-Content-Type-Options':'nosniff','Cache-Control':'public, max-age=604800, immutable'};
  const headers = {...cacheHeaders,'Cache-Control':'public, max-age=60'};
  const cached = await cache?.match(key).catch(() => undefined);
  if (cached) {
    if (method === 'HEAD') { void cached.body?.cancel().catch(() => {}); return new Response(null,{headers}); }
    return new Response(cached.body,{headers});
  }
  if (verifyingBytes + file.size > verificationBudget) {
    return new Response('文件校验中，请稍后重试。',{status:503,headers:{...responseHeaders,'Retry-After':'3'}});
  }
  verifyingBytes += file.size;
  try {
    const upstream = await officialResponse(file.url,fetcher,AbortSignal.timeout(45000));
    const bytes = await readBounded(upstream,file.size,true);
    if (toHex(await crypto.subtle.digest('SHA-256',bytes)) !== file.sha256) throw Error('checksum_mismatch');
    store(cache,ctx,key,new Response(bytes,{headers:cacheHeaders}));
    return new Response(method === 'HEAD' ? null : bytes,{headers});
  } finally { verifyingBytes -= file.size; }
}

export async function serve(req, context, {fetcher=fetch, cache=globalThis.caches?.default} = {}) {
  const url = new URL(req.url);
  if (url.origin !== ORIGIN || !url.pathname.startsWith(ROOT)) return failure('未找到页面',404);
  if (!['GET','HEAD'].includes(req.method)) return new Response('仅支持 GET 和 HEAD',{status:405,headers:{...responseHeaders,Allow:'GET, HEAD'}});
  if (url.pathname === ROOT) {
    const data = await Promise.all(['lite','full'].map(edition => index(edition,cache,context,fetcher).catch(() => null)));
    return new Response(req.method === 'HEAD' ? null : renderPage(data[0],data[1]),{
      status:data[0] ? 200 : 503,
      headers:{...responseHeaders,'Content-Type':'text/html; charset=utf-8',
        'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        'Cache-Control':data[0] && data[1] ? 'public, max-age=60' : 'no-store'}});
  }
  const route = /^\/downloader\/(lite|full)\/(mac-arm64|mac-x64|windows-x64)$/.exec(url.pathname);
  if (!route) return failure('未找到下载文件',404);
  try {
    const doc = await index(route[1],cache,context,fetcher);
    const file = doc.assets.find(item=>item.id===route[2]);
    if (route[1] === 'full') return new Response(null,{status:302,headers:{...responseHeaders,Location:file.url}});
    return await download(file,req.method,cache,context,fetcher);
  } catch { return failure('无法获取或校验官方文件，请稍后重试。',502); }
}

export default { fetch(request, env, ctx) { return serve(request,ctx); } };

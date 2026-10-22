import { publicHTTPS, parseSubscription, decoder, encoder } from './protocol.js';
import {githubInstallationToken} from './github-app.js';

const diagnostic = (stage,code,status) => console.warn(JSON.stringify({event:'proxy_setup_failed',stage,code,...(Number.isInteger(status)?{status}:{})}));
export const CONFIG_PATH = 'config/update-proxy.json';
export const NODES_CACHE_TTL_MS = 10 * 60 * 1000;
export const VALIDATED_SUBSCRIPTION_TTL_MS = 15000;
const VALIDATED_SUBSCRIPTION_LIMIT = 16;
const configDocuments = new WeakMap();
const validatedSubscriptions = new Map(), subscriptionFlights = new Map();
let configCache;
let nodesCache;
let cacheGeneration = 0;
export function clearConfigCache() {
  cacheGeneration++;configCache = undefined;nodesCache = undefined;
  validatedSubscriptions.clear();subscriptionFlights.clear();
}

function programRepository(env) {
  const repo = env.GITHUB_PROGRAM_DATA_REPOSITORY;
  if (!repo) {diagnostic('config','missing_program_repository');throw new Error('程序资料仓库尚未配置');}
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split('/').some(part => part === '.' || part === '..')) {
    diagnostic('config','invalid_program_repository');throw new Error('程序资料仓库尚未配置');
  }
  return repo;
}
async function github(env, options = {}, fetchImpl = fetch, tokenProvider = githubInstallationToken) {
  const repo = programRepository(env);
  const endpoint = `https://api.github.com/repos/${repo}/contents/${CONFIG_PATH}`;
  try { const token = await tokenProvider(env, repo, fetchImpl);
    const response = await fetchImpl(endpoint, { ...options, headers: {
    Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Brclio-Client-Services',
    ...(options.body ? {'Content-Type': 'application/json'} : {}), ...options.headers
  }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if(response.status>=300 && response.status<400){await response.body?.cancel();diagnostic('config','github_redirect_blocked');throw new Error('数据仓库重定向已拒绝');}
    return response;
  } catch(error) {diagnostic('config',error?.name==='TimeoutError' || error?.name==='AbortError'?'github_timeout':(error?.name==='TypeError'?'github_network_or_runtime':'github_fetch_failed'));throw new Error('读取私有配置失败');}
}
export async function readConfig(env, {fresh = false, fetchImpl = fetch, tokenProvider = githubInstallationToken} = {}) {
  const repo = programRepository(env);
  if (!fresh && configCache?.repo === repo && configCache.expires > Date.now()) return configCache.value;
  const generation = cacheGeneration;
  const response = await github(env, {}, fetchImpl, tokenProvider);
  let config, document;
  if (response.status === 404) {
    await response.body?.cancel();
    let subscriptionUrl;try {subscriptionUrl=publicHTTPS(env.PROXY_SUBSCRIPTION_URL).href;}catch{diagnostic('config',env.PROXY_SUBSCRIPTION_URL?'invalid_default_subscription':'missing_default_subscription');throw new Error('默认订阅尚未正确配置');}
    config = {subscriptionUrl, sha: null, updatedAt: null};
    document = {};
  } else {
    if (!response.ok) { diagnostic('config','github_response',response.status); await response.body?.cancel(); throw Object.assign(new Error('读取私有配置失败'), [403,429].includes(response.status) ? {code:'BRCLIO_PROXY_SUBSCRIPTION_REJECTED'} : {}); }
    let file;try{file=await response.json();}catch{diagnostic('config','invalid_github_json');throw new Error('私有配置格式无效');}
    if (file.size > 16384 || file.encoding !== 'base64') {diagnostic('config','invalid_github_file');throw new Error('私有配置格式无效');}
    try{document=JSON.parse(decoder.decode(Uint8Array.from(atob(file.content.replace(/\s/g, '')), c => c.charCodeAt(0))));}catch{diagnostic('config','invalid_config_document');throw new Error('私有配置格式无效');}
    if (!document || typeof document !== 'object' || Array.isArray(document)) {diagnostic('config','invalid_config_document');throw new Error('私有配置格式无效');}
    if (Object.hasOwn(document, 'version') && document.version !== 1) {diagnostic('config','unsupported_config_version');throw new Error('私有配置版本不受支持');}
    let subscriptionUrl;try{subscriptionUrl=publicHTTPS(document.subscriptionUrl).href;}catch{diagnostic('config','invalid_saved_subscription');throw new Error('私有配置格式无效');}
    config = {subscriptionUrl, sha: file.sha, updatedAt: document.updatedAt || null};
  }
  // Keep the original private document out of administrator/client responses.
  // Weak keys retain it for an in-flight save even when another save clears caches.
  configDocuments.set(config, document);
  if (generation === cacheGeneration) configCache = {repo, expires: Date.now() + 15000, value: config};
  return config;
}
function subscriptionAwait(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason); else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}
function subscriptionFailure(code, retryDelay = null, status) {
  return Object.assign(new Error(code === 'unsupported_document' ? '订阅没有兼容节点' : '无法读取代理订阅'), {subscriptionCode: code, retryDelay, status});
}
function subscriptionRetryDelay(response) {
  if (![400, 408, 429, 500, 502, 503, 504].includes(response.status)) return null;
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter === null) return 100;
  const value = retryAfter.trim(), timestamp = Date.parse(value);
  const delay = /^\d+$/.test(value) ? Number(value) * 1000
    : Number.isFinite(timestamp) && new Date(timestamp).toUTCString() === value ? timestamp - Date.now() : NaN;
  return Number.isFinite(delay) ? Math.max(100, delay) : null;
}
export async function readSubscription(url, fetchImpl = fetch, {attempts = 2} = {}) {
  publicHTTPS(url);
  if (![1, 2].includes(attempts)) throw new Error('订阅读取次数无效');
  // Configured attempts, response bodies, cancellation and backoff share one budget.
  const controller = new AbortController(), signal = controller.signal, deadline = Date.now() + 10000;
  const timer = setTimeout(() => controller.abort(), 10000);
  const options = {headers: {'User-Agent': 'clash.meta', Accept: 'text/yaml, text/plain, */*', 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache'}, redirect: 'manual', signal};
  try {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        if (Date.now() >= deadline) controller.abort();
        signal.throwIfAborted();
        let response;
        try { response = await subscriptionAwait(fetchImpl(url, options), signal); }
        catch { throw subscriptionFailure('fetch_failed', 100); }
        if (!response.ok || Number(response.headers.get('content-length')) > 1024 * 1024) {
          const oversized = Number(response.headers.get('content-length')) > 1024 * 1024;
          await subscriptionAwait(response.body?.cancel(), signal).catch(() => {});
          throw subscriptionFailure(oversized ? 'response_too_large' : 'http_response', oversized ? null : subscriptionRetryDelay(response), response.status);
        }
        if (!response.body) throw subscriptionFailure('unsupported_document');
        const reader = response.body.getReader(), chunks = []; let length = 0;
        try {
          while (true) {
            const {done, value} = await subscriptionAwait(reader.read(), signal); if (done) break;
            length += value.length;
            if (length > 1024 * 1024) throw subscriptionFailure('response_too_large');
            chunks.push(value);
          }
        } catch (error) { throw error?.subscriptionCode ? error : subscriptionFailure('fetch_failed', 100); }
        finally { await subscriptionAwait(reader.cancel(), signal).catch(() => {}); }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
        let nodes;
        try { nodes = parseSubscription(decoder.decode(bytes)); }
        catch { throw subscriptionFailure('unsupported_document'); }
        if (Date.now() >= deadline) controller.abort();
        signal.throwIfAborted();
        return nodes;
      } catch (error) {
        const delay = error?.retryDelay;
        if (attempt + 1 < attempts && !signal.aborted && Number.isFinite(delay) && delay >= 0 && Date.now() + delay < deadline) {
          await subscriptionAwait(new Promise(resolve => setTimeout(resolve, delay)), signal).catch(() => {});
          continue;
        }
        diagnostic('subscription', error?.subscriptionCode || 'fetch_failed', error?.status);
        const failure = new Error(error?.subscriptionCode === 'unsupported_document' ? '订阅没有兼容节点' : '无法读取代理订阅');
        if (['unsupported_document', 'response_too_large'].includes(error?.subscriptionCode)) failure.code = 'BRCLIO_PROXY_SUBSCRIPTION_INVALID';
        if ([403, 429].includes(error?.status)) failure.code = 'BRCLIO_PROXY_SUBSCRIPTION_REJECTED';
        throw failure;
      }
    }
  } finally { clearTimeout(timer); }
}
async function recentlyValidatedSubscription(repo, config, fetchImpl, generation) {
  if (generation !== cacheGeneration || typeof config.sha !== 'string' || !/^[a-f0-9]{40}$/.test(config.sha)) return readSubscription(config.subscriptionUrl, fetchImpl);
  const key = JSON.stringify([repo, config.sha, config.subscriptionUrl]);
  for (const [storedKey, cached] of validatedSubscriptions) if (cached.expires <= Date.now()) validatedSubscriptions.delete(storedKey);
  const cached = validatedSubscriptions.get(key);
  if (cached) return cached.nodes;
  const pending = subscriptionFlights.get(key);
  if (pending) return pending.promise;
  // Above the bounded number of distinct keys, keep normal fresh reads rather
  // than retaining more shared work or serving an unrelated cached document.
  if (subscriptionFlights.size >= VALIDATED_SUBSCRIPTION_LIMIT) return readSubscription(config.subscriptionUrl, fetchImpl);
  const entry = {generation};
  entry.promise = (async () => {
    const nodes = await readSubscription(config.subscriptionUrl, fetchImpl);
    const immutable = Object.freeze(nodes.map(node => Object.freeze({...node})));
    if (generation === cacheGeneration && subscriptionFlights.get(key) === entry) {
      if (validatedSubscriptions.size >= VALIDATED_SUBSCRIPTION_LIMIT) validatedSubscriptions.delete(validatedSubscriptions.keys().next().value);
      validatedSubscriptions.set(key, {nodes: immutable, expires: Date.now() + VALIDATED_SUBSCRIPTION_TTL_MS});
    }
    return immutable;
  })().finally(() => {if (subscriptionFlights.get(key) === entry) subscriptionFlights.delete(key);});
  subscriptionFlights.set(key, entry);
  return entry.promise;
}
export async function getNodes(env, fetchImpl = fetch, {fresh = false, reuseValidatedSubscription = false, subscriptionAttempts = 2, tokenProvider = githubInstallationToken} = {}) {
  const generation = cacheGeneration;
  let config;
  try {config = await readConfig(env, {fetchImpl, fresh: fresh || reuseValidatedSubscription, tokenProvider});} catch (error) {
    diagnostic('config','read_failed');
    throw Object.assign(new Error('读取私有配置失败'), error?.code === 'BRCLIO_PROXY_SUBSCRIPTION_REJECTED' ? {code:error.code}
      : /私有配置(?:格式无效|版本不受支持)|默认订阅尚未正确配置|程序资料仓库尚未配置/.test(error?.message || '') ? {code:'BRCLIO_PROXY_SUBSCRIPTION_INVALID'} : {});
  }
  const repo = programRepository(env);
  if (reuseValidatedSubscription) return recentlyValidatedSubscription(repo, config, fetchImpl, generation);
  if (!fresh && nodesCache?.repo === repo && nodesCache.url === config.subscriptionUrl && nodesCache.expires > Date.now()) return nodesCache.nodes;
  const nodes = await readSubscription(config.subscriptionUrl, fetchImpl, {attempts: subscriptionAttempts});
  if (generation === cacheGeneration) nodesCache = {repo, url: config.subscriptionUrl, nodes, expires: Date.now() + NODES_CACHE_TTL_MS};
  return nodes;
}
export async function writeConfig(env, input, fetchImpl = fetch, {tokenProvider = githubInstallationToken} = {}) {
  const subscriptionUrl = publicHTTPS(input.subscriptionUrl).href;
  const current = await readConfig(env, {fresh: true, fetchImpl, tokenProvider});
  if (input.sha !== current.sha) return {conflict: true};
  const nodes = await readSubscription(subscriptionUrl, fetchImpl);
  const document = configDocuments.get(current);
  if (!document) throw new Error('私有配置格式无效');
  const data = {...document, version: 1, subscriptionUrl, updatedAt: new Date().toISOString(), updatedBy: env.ADMIN_EMAIL};
  const bytes = encoder.encode(JSON.stringify(data, null, 2) + '\n');
  if (bytes.length > 16384) throw new Error('私有配置过大');
  const content = btoa(String.fromCharCode(...bytes));
  const response = await github(env, {method: 'PUT', body: JSON.stringify({message: 'Update Brclio update proxy subscription', content, ...(current.sha ? {sha: current.sha} : {})})}, fetchImpl, tokenProvider);
  if ([409, 422].includes(response.status)) { await response.body?.cancel(); clearConfigCache(); return {conflict: true}; }
  if (!response.ok) { await response.body?.cancel(); throw new Error('保存私有配置失败'); }
  const result = await response.json();
  clearConfigCache();
  return {subscriptionUrl, sha: result.content.sha, updatedAt: data.updatedAt, compatibleNodes: nodes.length};
}

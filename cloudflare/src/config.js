import { publicHTTPS, parseSubscription, decoder, encoder } from './protocol.js';
import {githubInstallationToken} from './github-app.js';

const diagnostic = (stage,code,status) => console.warn(JSON.stringify({event:'proxy_setup_failed',stage,code,...(Number.isInteger(status)?{status}:{})}));
export const CONFIG_PATH = 'config/update-proxy.json';
export const NODES_CACHE_TTL_MS = 10 * 60 * 1000;
const configDocuments = new WeakMap();
let configCache;
let nodesCache;
export function clearConfigCache() { configCache = undefined; nodesCache = undefined; }

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
  const response = await github(env, {}, fetchImpl, tokenProvider);
  let config, document;
  if (response.status === 404) {
    await response.body?.cancel();
    let subscriptionUrl;try {subscriptionUrl=publicHTTPS(env.PROXY_SUBSCRIPTION_URL).href;}catch{diagnostic('config',env.PROXY_SUBSCRIPTION_URL?'invalid_default_subscription':'missing_default_subscription');throw new Error('默认订阅尚未正确配置');}
    config = {subscriptionUrl, sha: null, updatedAt: null};
    document = {};
  } else {
    if (!response.ok) { diagnostic('config','github_response',response.status); await response.body?.cancel(); throw new Error('读取私有配置失败'); }
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
  configCache = {repo, expires: Date.now() + 15000, value: config};
  return config;
}
export async function readSubscription(url, fetchImpl = fetch) {
  publicHTTPS(url);
  let response;
  try { response = await fetchImpl(url, {headers: {'User-Agent': 'clash.meta', Accept: 'text/yaml, text/plain, */*', 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache'}, redirect: 'manual', signal: AbortSignal.timeout(10000)}); } catch { diagnostic('subscription','fetch_failed'); throw new Error('无法读取代理订阅'); }
  if (!response.ok || Number(response.headers.get('content-length')) > 1024 * 1024) { diagnostic('subscription','http_response',response.status); await response.body?.cancel(); throw new Error('无法读取代理订阅'); }
  const reader = response.body.getReader(); const chunks = []; let length = 0;
  try {
    while (true) { const {done, value} = await reader.read(); if (done) break; length += value.length; if (length > 1024 * 1024) throw new Error('代理订阅过大'); chunks.push(value); }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length); let offset = 0; for (const b of chunks) {bytes.set(b, offset); offset += b.length;}
  try { return parseSubscription(decoder.decode(bytes)); } catch { diagnostic('subscription','unsupported_document'); throw new Error('订阅没有兼容节点'); }
}
export async function getNodes(env, fetchImpl = fetch, {fresh = false, tokenProvider = githubInstallationToken} = {}) {
  let config;
  try {config = await readConfig(env, {fetchImpl, fresh, tokenProvider});} catch {diagnostic('config','read_failed'); throw new Error('读取私有配置失败');}
  const repo = programRepository(env);
  if (!fresh && nodesCache?.repo === repo && nodesCache.url === config.subscriptionUrl && nodesCache.expires > Date.now()) return nodesCache.nodes;
  const nodes = await readSubscription(config.subscriptionUrl, fetchImpl);
  nodesCache = {repo, url: config.subscriptionUrl, nodes, expires: Date.now() + NODES_CACHE_TTL_MS};
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

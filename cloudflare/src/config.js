import { publicHTTPS, parseSubscription, decoder, encoder } from './protocol.js';

const diagnostic = (stage,code,status) => console.warn(JSON.stringify({event:'proxy_setup_failed',stage,code,...(Number.isInteger(status)?{status}:{})}));
export const CONFIG_PATH = 'config/update-proxy.json';
let configCache;
let nodesCache;
export function clearConfigCache() { configCache = undefined; nodesCache = undefined; }

function repoURL(env) {
  const repo = env.GITHUB_DATA_REPOSITORY;
  if (!repo) {diagnostic('config','missing_repository');throw new Error('数据仓库尚未配置');}
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {diagnostic('config','invalid_repository');throw new Error('数据仓库尚未配置');}
  if (!env.GITHUB_TOKEN) {diagnostic('config','missing_token');throw new Error('数据仓库凭据尚未配置');}
  return `https://api.github.com/repos/${repo}/contents/${CONFIG_PATH}`;
}
async function github(env, options = {}, fetchImpl = fetch) {
  const endpoint=repoURL(env);
  try { const response = await fetchImpl(endpoint, { ...options, headers: {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Brclio-Client-Services',
    ...(options.body ? {'Content-Type': 'application/json'} : {}), ...options.headers
  }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if(response.status>=300 && response.status<400){await response.body?.cancel();diagnostic('config','github_redirect_blocked');throw new Error('数据仓库重定向已拒绝');}
    return response;
  } catch(error) {diagnostic('config',error?.name==='TimeoutError' || error?.name==='AbortError'?'github_timeout':(error?.name==='TypeError'?'github_network_or_runtime':'github_fetch_failed'));throw new Error('读取私有配置失败');}
}
export async function readConfig(env, {fresh = false, fetchImpl = fetch} = {}) {
  if (!fresh && configCache?.repo === env.GITHUB_DATA_REPOSITORY && configCache.expires > Date.now()) return configCache.value;
  const response = await github(env, {}, fetchImpl);
  let config;
  if (response.status === 404) {
    await response.body?.cancel();
    let subscriptionUrl;try {subscriptionUrl=publicHTTPS(env.PROXY_SUBSCRIPTION_URL).href;}catch{diagnostic('config',env.PROXY_SUBSCRIPTION_URL?'invalid_default_subscription':'missing_default_subscription');throw new Error('默认订阅尚未正确配置');}
    config = {subscriptionUrl, sha: null, updatedAt: null};
  } else {
    if (!response.ok) { diagnostic('config','github_response',response.status); await response.body?.cancel(); throw new Error('读取私有配置失败'); }
    let file;try{file=await response.json();}catch{diagnostic('config','invalid_github_json');throw new Error('私有配置格式无效');}
    if (file.size > 16384 || file.encoding !== 'base64') {diagnostic('config','invalid_github_file');throw new Error('私有配置格式无效');}
    let data;try{data=JSON.parse(decoder.decode(Uint8Array.from(atob(file.content.replace(/\s/g, '')), c => c.charCodeAt(0))));}catch{diagnostic('config','invalid_config_document');throw new Error('私有配置格式无效');}
    let subscriptionUrl;try{subscriptionUrl=publicHTTPS(data.subscriptionUrl).href;}catch{diagnostic('config','invalid_saved_subscription');throw new Error('私有配置格式无效');}
    config = {subscriptionUrl, sha: file.sha, updatedAt: data.updatedAt || null};
  }
  configCache = {repo: env.GITHUB_DATA_REPOSITORY, expires: Date.now() + 15000, value: config};
  return config;
}
export async function readSubscription(url, fetchImpl = fetch) {
  publicHTTPS(url);
  let response;
  try { response = await fetchImpl(url, {headers: {'User-Agent': 'clash.meta', Accept: 'text/yaml, text/plain, */*'}, redirect: 'manual', signal: AbortSignal.timeout(10000)}); } catch { diagnostic('subscription','fetch_failed'); throw new Error('无法读取代理订阅'); }
  if (!response.ok || Number(response.headers.get('content-length')) > 1024 * 1024) { diagnostic('subscription','http_response',response.status); await response.body?.cancel(); throw new Error('无法读取代理订阅'); }
  const reader = response.body.getReader(); const chunks = []; let length = 0;
  try {
    while (true) { const {done, value} = await reader.read(); if (done) break; length += value.length; if (length > 1024 * 1024) throw new Error('代理订阅过大'); chunks.push(value); }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length); let offset = 0; for (const b of chunks) {bytes.set(b, offset); offset += b.length;}
  try { return parseSubscription(decoder.decode(bytes)); } catch { diagnostic('subscription','unsupported_document'); throw new Error('订阅没有兼容节点'); }
}
export async function getNodes(env, fetchImpl = fetch) {
  let config;
  try {config = await readConfig(env, {fetchImpl});} catch {diagnostic('config','read_failed'); throw new Error('读取私有配置失败');}
  if (nodesCache?.url === config.subscriptionUrl && nodesCache.expires > Date.now()) return nodesCache.nodes;
  const nodes = await readSubscription(config.subscriptionUrl, fetchImpl);
  nodesCache = {url: config.subscriptionUrl, nodes, expires: Date.now() + 60000};
  return nodes;
}
export async function writeConfig(env, input, fetchImpl = fetch) {
  const subscriptionUrl = publicHTTPS(input.subscriptionUrl).href;
  const current = await readConfig(env, {fresh: true, fetchImpl});
  if (input.sha !== current.sha) return {conflict: true};
  const nodes = await readSubscription(subscriptionUrl, fetchImpl);
  const data = {version: 1, subscriptionUrl, updatedAt: new Date().toISOString(), updatedBy: env.ADMIN_EMAIL};
  const content = btoa(String.fromCharCode(...encoder.encode(JSON.stringify(data, null, 2) + '\n')));
  const response = await github(env, {method: 'PUT', body: JSON.stringify({message: 'Update Brclio update proxy subscription', content, ...(current.sha ? {sha: current.sha} : {})})}, fetchImpl);
  if ([409, 422].includes(response.status)) { await response.body?.cancel(); clearConfigCache(); return {conflict: true}; }
  if (!response.ok) { await response.body?.cancel(); throw new Error('保存私有配置失败'); }
  const result = await response.json();
  clearConfigCache();
  return {subscriptionUrl, sha: result.content.sha, updatedAt: data.updatedAt, compatibleNodes: nodes.length};
}

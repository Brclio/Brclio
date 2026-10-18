import {getNodes} from './config.js';
import {validateProxyNode, encoder} from './protocol.js';
import {json, rateLimit} from './http.js';

export const CLIENT_CONFIG_VERSION = 1;
export const CLIENT_CONFIG_TTL_SECONDS = 600;
export const CLIENT_CONFIG_MAX_NODES = 16;
export const CLIENT_CONFIG_MAX_BYTES = 32 * 1024;

export function clientProxyConfiguration(nodes) {
  if (!Array.isArray(nodes) || nodes.length > 128) throw new Error('invalid_nodes');
  const selected = [], seen = new Set();
  for (const value of nodes) {
    let node;
    try { node = validateProxyNode(value); } catch { continue; }
    const key = JSON.stringify(node);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({...node, servername: node.host, wsHost: node.host});
    if (selected.length > CLIENT_CONFIG_MAX_NODES) throw new Error('too_many_supported_nodes');
  }
  if (!selected.length) throw new Error('no_supported_nodes');
  const document = {version: CLIENT_CONFIG_VERSION, ttlSeconds: CLIENT_CONFIG_TTL_SECONDS, nodes: selected};
  if (encoder.encode(JSON.stringify(document)).length > CLIENT_CONFIG_MAX_BYTES) throw new Error('configuration_too_large');
  return document;
}

export async function handleClientConfiguration(request, env, dependencies = {}) {
  if (new URL(request.url).pathname !== '/api/client/update-proxy') return null;
  if (request.method !== 'GET') return json({error: '只支持 GET 请求', code: 'method_not_allowed'}, 405, {Allow: 'GET'});
  const ip = request.headers.get('CF-Connecting-IP') || 'development';
  if (!await rateLimit(env, 'CLIENT_CONFIG_LIMITER', ip, 30)) return json({error: '配置请求过于频繁，请稍后重试', code: 'rate_limited'}, 429, {'Retry-After': '60'});
  try {
    const nodes = await (dependencies.getNodes || getNodes)(env, undefined, {fresh: true});
    return json(clientProxyConfiguration(nodes));
  } catch (error) {
    if (['too_many_supported_nodes', 'configuration_too_large', 'no_supported_nodes'].includes(error?.message)) return json({error: '代理配置超出客户端支持范围，请联系管理员调整订阅', code: 'proxy_configuration_unsupported'}, 502);
    return json({error: '暂时无法获取内置代理配置，请关闭内置代理或稍后重试', code: 'proxy_configuration_unavailable'}, 502);
  }
}

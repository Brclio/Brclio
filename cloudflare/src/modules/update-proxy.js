import {readConfig, writeConfig, getNodes} from '../config.js';
import {officialTarget} from '../protocol.js';
import {relayUpdate} from '../relay.js';
import {json, readJSON, rateLimit} from '../http.js';
import {latestReleaseURL, readReleaseResponse} from '../releases.js';

export const metadata = Object.freeze({
  id: 'update-proxy',
  name: '更新与网络',
  description: '为客户端提供版本检查、安装包下载与内置代理配置。',
  status: 'implemented',
  configPath: '/api/admin/config'
});

export async function overview(env, dependencies = {}) {
  let config;
  try {
    config = await (dependencies.readConfig || readConfig)(env, {fresh: true});
  } catch {
    config = null;
  }
  const configured = Boolean(config?.subscriptionUrl);
  return {
    configured,
    repository: 'Brclio/Brclio',
    subscriptionConfigured: configured,
    updatedAt: config?.updatedAt || null,
    configurationStatus: configured ? 'configured' : 'unavailable',
    transport: 'vless-tls-websocket'
  };
}

export async function handlePublic(request, env, dependencies = {}, ctx) {
  const url = new URL(request.url);
  const summary = url.pathname === '/api/releases/latest';
  if ((!summary && url.pathname !== '/api/update') || request.method !== 'GET') return null;
  const ip = request.headers.get('CF-Connecting-IP') || 'development';
  if (!await rateLimit(env, 'UPDATE_LIMITER', ip, 120)) return json({error: '请求过于频繁，请稍后重试'}, 429, {'Retry-After': '60'});
  if (request.headers.has('range')) return json({error: '请使用完整下载请求'}, 416);
  let target;
  try {
    target = officialTarget(summary ? latestReleaseURL : url.searchParams.get('url'));
  } catch {
    return json({error: '只允许 Brclio 官方更新地址'}, 400);
  }
  const started = Date.now();
  try {
    const nodes = await (dependencies.getNodes || getNodes)(env);
    const response = await (dependencies.relayUpdate || relayUpdate)(target.href, nodes, {
      signal: request.signal,
      headerDeadlineMs: Math.max(1, 18000 - (Date.now() - started)),
      waitUntil: ctx ? promise => ctx.waitUntil(promise) : undefined
    });
    if (summary) return json(await readReleaseResponse(response), 200, {'Cache-Control': 'public, max-age=60', 'X-Brclio-Route': 'subscription-vless'});
    return response;
  } catch {
    return json({error: summary ? '暂时无法获取官方正式版本，请稍后重试或前往 GitHub 发布页' : '内置代理暂不可用，请关闭内置代理或稍后重试'}, 502);
  }
}

// Called only after the common administrator authentication and CSRF guards.
export async function handleAdmin(request, env, session, dependencies = {}) {
  if (new URL(request.url).pathname !== '/api/admin/config') return null;
  if (request.method === 'GET') {
    try {
      return json({...await (dependencies.readConfig || readConfig)(env, {fresh: true}), csrf: session.csrf});
    } catch {
      return json({error: '读取私有配置失败，请检查部署环境变量与仓库权限'}, 502);
    }
  }
  if (request.method === 'PUT') {
    let data;
    try {
      data = await readJSON(request);
      if (typeof data.subscriptionUrl !== 'string' || data.subscriptionUrl.length > 4096 || !(data.sha === null || typeof data.sha === 'string')) throw new Error('invalid');
    } catch {
      return json({error: '请求格式无效'}, 400);
    }
    try {
      const result = await (dependencies.writeConfig || writeConfig)(env, data);
      if (result.conflict) return json({error: '配置已被更新，请刷新页面后重新保存'}, 409);
      return json(result);
    } catch {
      return json({error: '保存失败，请检查 HTTPS 订阅、节点格式与数据仓库写入权限'}, 502);
    }
  }
  return null;
}

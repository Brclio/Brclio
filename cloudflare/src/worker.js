import adminHTML from './admin.html';
import adminJS from './admin-client.txt';
import homeHTML from './home.html';
import homeJS from './home-client.txt';
import {handleAdmin} from './admin.js';
import {json, securityHeaders} from './http.js';
import {modules} from './modules/index.js';
import {service} from './service.js';
import {handleClientConfiguration} from './client-config.js';
export {rateLimit} from './http.js';

export async function handle(request, env, dependencies = {}, ctx) {
  const url = new URL(request.url), path = url.pathname;
  if (url.hostname === 'brclio-client-services.aiyuechuang.workers.dev' &&
      !(request.method === 'GET' && ['/api/client/update-proxy', '/api/health'].includes(path))) return json({error: '未找到页面'}, 404);
  if (path === '/api/health' && request.method === 'GET') {
    // Retain the transport field for clients using the original health contract.
    return json({ok: true, service: service.id, proxyProtocol: 'vless-tls-websocket'});
  }
  if ((path === '/' || path === '/admin') && request.method === 'GET') {
    return new Response(path === '/' ? homeHTML : adminHTML, {headers: {
      ...securityHeaders,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; " + (path === '/' ? "img-src 'self' data:; " : '') + "form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    }});
  }
  if (path === '/home.js' && request.method === 'GET') return new Response(homeJS, {headers: {...securityHeaders, 'Content-Type': 'text/javascript; charset=utf-8'}});
  if (path === '/admin.js' && request.method === 'GET') return new Response(adminJS, {headers: {...securityHeaders, 'Content-Type': 'text/javascript; charset=utf-8'}});
  const configuration = await handleClientConfiguration(request, env, dependencies);
  if (configuration) return configuration;
  for (const module of modules) {
    const response = await module.handlePublic(request, env, dependencies, ctx);
    if (response) return response;
  }
  return await handleAdmin(request, env, dependencies) || json({error: '未找到页面'}, 404);
}

export default {
  async fetch(request, env, ctx) {
    try { return await handle(request, env, {}, ctx); }
    catch { return json({error: '服务暂不可用，请稍后重试'}, 503); }
  }
};

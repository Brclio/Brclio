import adminHTML from './admin.html';
import adminJS from './admin-client.txt';
import {handleAdmin} from './admin.js';
import {json, securityHeaders} from './http.js';
import {modules} from './modules/index.js';
import {service} from './service.js';
export {rateLimit} from './http.js';

export async function handle(request, env, dependencies = {}, ctx) {
  const path = new URL(request.url).pathname;
  if (path === '/api/health' && request.method === 'GET') {
    // Retain the transport field for clients using the original health contract.
    return json({ok: true, service: service.id, proxyProtocol: 'vless-tls-websocket'});
  }
  if ((path === '/' || path === '/admin') && request.method === 'GET') {
    return new Response(adminHTML, {headers: {
      ...securityHeaders,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    }});
  }
  if (path === '/admin.js' && request.method === 'GET') return new Response(adminJS, {headers: {...securityHeaders, 'Content-Type': 'text/javascript; charset=utf-8'}});
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

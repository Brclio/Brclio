import {safeEqual, sameOrigin, createSession, sessionFrom, clearSessionCookie} from './auth.js';
import {json, readJSON, rateLimit} from './http.js';
import {adminOverview} from './service.js';
import {modules} from './modules/index.js';

export async function handleAdmin(request, env, dependencies = {}) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/api/admin/')) return null;
  if (!['GET', 'POST', 'PUT'].includes(request.method)) return json({error: '不支持的请求方法'}, 405);
  if (request.method !== 'GET' && !sameOrigin(request)) return json({error: '请求来源无效，请刷新后台页面'}, 403);
  const ip = request.headers.get('CF-Connecting-IP') || 'development';
  if (path === '/api/admin/login' && request.method === 'POST') {
    if (!await rateLimit(env, 'LOGIN_LIMITER', ip, 8) || !await rateLimit(env, 'LOGIN_GLOBAL_LIMITER', 'admin', 30)) return json({error: '登录尝试过多，请一分钟后重试'}, 429, {'Retry-After': '60'});
    if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD || !env.SESSION_SECRET) return json({error: '管理员环境变量尚未配置'}, 503);
    let data;
    try { data = await readJSON(request); } catch { return json({error: '请求格式无效'}, 400); }
    const emailMatch = await safeEqual(String(data.email || '').trim().toLowerCase(), env.ADMIN_EMAIL.toLowerCase());
    const passwordMatch = await safeEqual(data.password || '', env.ADMIN_PASSWORD);
    if (!emailMatch || !passwordMatch) return json({error: '邮箱或密码不正确'}, 401);
    const session = await createSession(env);
    return json({ok: true, csrf: session.csrf}, 200, {'Set-Cookie': session.cookie});
  }
  const session = await sessionFrom(request, env);
  if (!session) return json({error: '请重新登录'}, 401);
  if (request.method !== 'GET' && !await safeEqual(request.headers.get('X-CSRF-Token') || '', session.csrf)) return json({error: '页面会话已更新，请刷新后重试'}, 403);
  if (path === '/api/admin/logout' && request.method === 'POST') return json({ok: true}, 200, {'Set-Cookie': clearSessionCookie()});
  if (path === '/api/admin/overview' && request.method === 'GET') return json(await adminOverview(env, session, dependencies));
  for (const module of modules) {
    const response = await module.handleAdmin(request, env, session, dependencies);
    if (response) return response;
  }
  return json({error: '未找到接口'}, 404);
}

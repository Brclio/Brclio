'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ORIGIN = 'https://tools.brclio.com';
const MAX_BYTES = 128 * 1024;
const ROUTES = { '/api/account/session': ['GET'], '/api/account/code': ['POST'],
  '/api/account/register': ['POST'], '/api/account/login': ['POST'],
  '/api/account/logout': ['POST'], '/api/account/data': ['GET', 'PUT'],
  '/api/account/profile': ['PUT'], '/api/account/password': ['POST'] };

function validateAccountRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('账号请求格式无效。');
  const method = input.method === undefined ? 'GET' : input.method;
  if (typeof input.path !== 'string' || !ROUTES[input.path]?.includes(method)) throw new TypeError('账号请求路径或方法无效。');
  let body;
  if (input.body !== undefined) {
    if (method === 'GET' || !input.body || typeof input.body !== 'object' || Array.isArray(input.body)) throw new TypeError('账号请求数据无效。');
    body = JSON.stringify(input.body);
    if (Buffer.byteLength(body) > MAX_BYTES) throw new TypeError('账号请求数据过大。');
  }
  return { path: input.path, method, body };
}

function createAccountStore(directory) {
  const filename = path.join(directory, 'account-session.json');
  let pending = Promise.resolve();
  return {
    async read() {
      await pending;
      try {
        const value = JSON.parse(await fs.readFile(filename, 'utf8'));
        return typeof value.token === 'string' && /^[\x21-\x7e]{16,4096}$/.test(value.token) ? value.token : null;
      } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
    },
    write(token) {
      const operation = pending.then(async () => {
        if (token === null) { await fs.rm(filename, { force: true }); return; }
        if (typeof token !== 'string' || !/^[\x21-\x7e]{16,4096}$/.test(token)) throw new Error('账号会话数据无效。');
        await fs.mkdir(directory, { recursive: true });
        const temporary = `${filename}.${process.pid}.tmp`;
        try {
          await fs.writeFile(temporary, JSON.stringify({ token }), { mode: 0o600 });
          await fs.chmod(temporary, 0o600);
          await fs.rename(temporary, filename);
        } finally { await fs.rm(temporary, { force: true }); }
      });
      pending = operation.catch(() => {});
      return operation;
    },
  };
}

function abortError() { return new Error('谷歌登录已取消，请重新登录。'); }
function createAccountClient({ directory, fetch = globalThis.fetch, openExternal, store = createAccountStore(directory),
  randomBytes = crypto.randomBytes, now = Date.now, delay = (ms, signal) => new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); reject(abortError()); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  }), pollInterval = 2000, googleTimeout = 300000 } = {}) {
  let google, csrf = '', authVersion = 0;
  const controllers = new Set();
  async function requestRaw(target, method, body, outerSignal) {
    if (controllers.size >= 8) throw new Error('账号操作繁忙，请稍后重试。');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    controllers.add(controller);
    outerSignal?.addEventListener('abort', cancel, { once: true });
    if (outerSignal?.aborted) cancel();
    const timer = setTimeout(cancel, 30000);
    try {
      const token = await store.read();
      const response = await fetch(`${ORIGIN}${target}`, { method, body, redirect: 'manual', credentials: 'omit',
        headers: { Accept: 'application/json', 'X-Brclio-Client': 'native', ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, signal: controller.signal });
      if (response.status >= 300 && response.status < 400) throw new Error('账号服务跳转无效，请稍后重试。');
      if (response.headers.get('cf-mitigated') === 'challenge') throw new Error('账号请求需要完成网站安全验证，请稍后重试。');
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('账号服务暂时不可用，请稍后重试。');
      const reader = response.body?.getReader();
      const chunks = []; let size = 0;
      if (reader) {
        try { while (true) { const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > MAX_BYTES) throw new Error('账号服务响应过大。'); chunks.push(Buffer.from(value));
        } } finally { await reader.cancel().catch(() => {}); }
      }
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('账号服务响应无效。'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('账号服务响应无效。');
      if (!response.ok) {
        // Never replay server HTML, request headers, or token-bearing URLs into the UI.
        const message = typeof value.error === 'string' ? value.error : value.error?.message || value.message;
        const error = new Error(typeof message === 'string' ? message.slice(0, 500) : '账号操作失败，请稍后重试。');
        error.status = response.status;
        throw error;
      }
      return value;
    } catch (error) {
      if (controller.signal.aborted) throw outerSignal?.aborted ? abortError() : new Error('账号请求超时，请稍后重试。');
      throw error;
    } finally { clearTimeout(timer); outerSignal?.removeEventListener('abort', cancel); controllers.delete(controller); }
  }
  async function accept(value, version) {
    if (version !== authVersion) throw new Error('账号状态已变化，请重新登录。');
    if (Object.hasOwn(value, 'token')) { await store.write(value.token); delete value.token; }
    if (typeof value.csrf === 'string') csrf = value.csrf;
    return value;
  }
  function cancelGoogle() { google?.controller.abort(); return { canceled: true }; }
  async function request(input) {
    const next = validateAccountRequest(input);
    const authChange = ['/api/account/login', '/api/account/register', '/api/account/logout'].includes(next.path);
    // Settings retain the current bearer, but a pending browser login must not replace it.
    if (authChange || ['/api/account/profile', '/api/account/password'].includes(next.path)) cancelGoogle();
    const version = authChange ? ++authVersion : authVersion;
    try {
      const value = await requestRaw(next.path, next.method, next.body);
      return await accept(value, version);
    } finally {
      if (next.path === '/api/account/logout' && version === authVersion) { await store.write(null); csrf = ''; }
    }
  }
  async function googleLogin() {
    if (google) throw new Error('请先完成或取消当前谷歌登录。');
    const operation = { controller: new AbortController() }; google = operation;
    const version = ++authVersion;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; operation.controller.abort(); }, googleTimeout);
    try {
      const verifier = randomBytes(32).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      const started = now();
      const session = await requestRaw('/api/account/device/start', 'POST', JSON.stringify({ challenge }), operation.controller.signal);
      if (typeof session.id !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(session.id) || typeof session.url !== 'string') throw new Error('谷歌登录链接无效。');
      const url = new URL(session.url);
      if (url.origin !== ORIGIN || url.username || url.password || url.hash || url.pathname !== '/api/account/google/start' || url.searchParams.get('device') !== session.id) throw new Error('谷歌登录链接无效。');
      if (operation.controller.signal.aborted) throw abortError();
      await openExternal(url.href);
      while (now() - started < googleTimeout) {
        await delay(pollInterval, operation.controller.signal);
        const result = await requestRaw(`/api/account/device/poll?id=${encodeURIComponent(session.id)}&verifier=${encodeURIComponent(verifier)}`, 'GET', undefined, operation.controller.signal);
        if (operation.controller.signal.aborted) throw abortError();
        if (result.pending === true) continue;
        if (typeof result.token !== 'string' || !result.user) throw new Error('谷歌登录尚未完成，请重试。');
        return await accept(result, version);
      }
      throw new Error('谷歌登录已超时，请重新登录。');
    } catch (error) {
      if (timedOut) throw new Error('谷歌登录已超时，请重新登录。');
      throw error;
    } finally { clearTimeout(timeout); if (google === operation) google = null; }
  }
  return { request, google: googleLogin, cancelGoogle, close() { cancelGoogle(); for (const controller of controllers) controller.abort(); } };
}

module.exports = { createAccountClient, createAccountStore, validateAccountRequest, ORIGIN, MAX_BYTES };

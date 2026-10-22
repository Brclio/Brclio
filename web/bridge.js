/* One UI, three native hosts. Browser mode preserves real local preferences. */
(() => {
  'use strict';
  const STORE = 'brclio.toolbox.settings.v1';
  const pending = new Map();
  let nextId = 0;
  let accountCSRF = '';
  const isAndroid = Boolean(window.AndroidBridge?.postMessage);
  window.__brclioResolve = (id, response) => {
    const request = pending.get(String(id));
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(String(id));
    if (response.error) request.reject(new Error(typeof response.error === 'string' ? response.error : response.error.message));
    else request.resolve(response.result);
  };
  function native(method, payload = {}) {
    return new Promise((resolve, reject) => {
      const id = String(++nextId);
      const timer = method === 'downloadUpdate' ? null : setTimeout(() => { pending.delete(id); reject(new Error('系统操作尚未完成，请重试。')); }, method === 'pickPaths' ? 900000 : method === 'accountGoogle' ? 330000 : method === 'checkForUpdates' ? 90000 : 60000);
      pending.set(id, { resolve, reject, timer });
      try { window.AndroidBridge.postMessage(JSON.stringify({ id, method, payload })); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  const browser = {
    accountRequest: async ({ path, method = 'GET', body } = {}) => {
      const routes = { '/api/account/session': ['GET'], '/api/account/code': ['POST'], '/api/account/register': ['POST'], '/api/account/login': ['POST'], '/api/account/logout': ['POST'], '/api/account/data': ['GET', 'PUT'], '/api/account/profile': ['PUT'], '/api/account/password': ['POST'] };
      if (!routes[path]?.includes(method)) throw new Error('账号请求路径或方法无效。');
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      if (encoded && new TextEncoder().encode(encoded).length > 131072) throw new Error('账号请求数据过大。');
      const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store',
        headers: { Accept: 'application/json', ...(encoded ? { 'Content-Type': 'application/json' } : {}), ...(accountCSRF ? { 'X-CSRF-Token': accountCSRF } : {}) }, body: encoded,
        signal: AbortSignal.timeout(30000), redirect: 'error' });
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('账号服务暂时不可用，请稍后重试。');
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : result.error?.message || result.message || '账号操作失败。');
      if (typeof result.csrf === 'string') accountCSRF = result.csrf;
      return result;
    },
    accountGoogle: async () => { location.assign('/api/account/google/start'); return { redirecting: true }; },
    accountCancelGoogle: async () => ({ canceled: true }),
    getPlatform: async () => ({ platform: 'browser', version: '0.1.15', capabilities: { filePicker: false, folderPicker: false, systemIntegration: false, globalShortcut: false } }),
    getSettings: async () => { const saved = localStorage.getItem(STORE); return saved ? JSON.parse(saved) : {}; },
    saveSettings: async settings => { localStorage.setItem(STORE, JSON.stringify(settings)); return settings; },
    copyText: async text => {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
      const input = document.createElement('textarea');
      input.value = text; input.setAttribute('aria-label', '复制路径临时输入'); input.className = 'clipboard-fallback';
      document.body.append(input); input.select();
      const copied = document.execCommand('copy'); input.remove();
      if (!copied) throw new Error('浏览器未允许访问剪贴板，请手动选中预览文字复制。');
    },
    pickPaths: async () => { throw new Error('浏览器无法读取完整本地路径。请粘贴绝对路径，或使用客户端选择文件。'); },
    getIntegrationStatus: async () => ({ installed: false, supported: false }),
    setIntegration: async () => { throw new Error('请在桌面客户端启用系统右键菜单。'); },
    getShortcutStatus: async () => ({ supported: false, accelerator: 'Alt+P', registered: false, error: null }),
    suspendShortcut: async () => {},
    resumeShortcut: async () => ({ supported: false, accelerator: 'Alt+P', registered: false, error: null }),
    onPaths: () => () => {},
    getUpdateProxyState: async () => ({ enabled: true, supported: false, route: 'direct' }),
    setUpdateProxyEnabled: async () => { throw new Error('请在客户端中设置更新代理。'); },
    checkForUpdates: async () => ({ status: 'unsupported', currentVersion: '0.1.15' }),
    downloadUpdate: async () => { throw new Error('请在客户端中下载安装包。'); },
    installUpdate: async () => { throw new Error('请在客户端中安装更新。'); },
    onUpdateState: () => () => {},
  };
  const android = {
    accountRequest: input => native('accountRequest', input),
    accountGoogle: () => native('accountGoogle'),
    accountCancelGoogle: () => native('accountCancelGoogle'),
    getPlatform: () => native('getPlatform'),
    getUpdateProxyState: () => native('getUpdateProxyState'),
    setUpdateProxyEnabled: enabled => native('setUpdateProxyEnabled', { enabled }),
    checkForUpdates: () => native('checkForUpdates'),
    downloadUpdate: () => native('downloadUpdate'),
    installUpdate: () => native('installUpdate'),
    onUpdateState: callback => { const listener = event => callback(event.detail); window.addEventListener('brclio:update', listener); return () => window.removeEventListener('brclio:update', listener); },
    getSettings: () => native('getSettings'),
    saveSettings: settings => native('saveSettings', { settings }),
    copyText: text => native('copyText', { text }),
    pickPaths: options => native('pickPaths', options),
    getIntegrationStatus: () => native('getIntegrationStatus'),
    setIntegration: enabled => native('setIntegration', { enabled }),
    getShortcutStatus: async () => ({ supported: false, accelerator: 'Alt+P', registered: false, error: null }),
    suspendShortcut: async () => {},
    resumeShortcut: async () => ({ supported: false, accelerator: 'Alt+P', registered: false, error: null }),
    onPaths: callback => { const listener = event => callback(event.detail); window.addEventListener('brclio:paths', listener); return () => window.removeEventListener('brclio:paths', listener); },
  };
  window.BrclioHost = window.brclio || (isAndroid ? android : browser);
})();

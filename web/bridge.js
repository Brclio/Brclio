/* One UI, three native hosts. Browser mode preserves real local preferences. */
(() => {
  'use strict';
  const STORE = 'brclio.toolbox.settings.v1';
  const pending = new Map();
  let nextId = 0;
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
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('系统操作尚未完成，请重试。')); }, ['pickPaths', 'downloadUpdate'].includes(method) ? 900000 : method === 'checkForUpdates' ? 90000 : 60000);
      pending.set(id, { resolve, reject, timer });
      try { window.AndroidBridge.postMessage(JSON.stringify({ id, method, payload })); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  const browser = {
    getPlatform: async () => ({ platform: 'browser', version: '0.1.0', capabilities: { filePicker: false, folderPicker: false, systemIntegration: false } }),
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
    onPaths: () => () => {},
    checkForUpdates: async () => ({ status: 'unsupported', currentVersion: '0.1.0' }),
    downloadUpdate: async () => { throw new Error('请在客户端中下载安装包。'); },
    installUpdate: async () => { throw new Error('请在客户端中安装更新。'); },
    onUpdateState: () => () => {},
  };
  const android = {
    getPlatform: () => native('getPlatform'),
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
    onPaths: callback => { const listener = event => callback(event.detail); window.addEventListener('brclio:paths', listener); return () => window.removeEventListener('brclio:paths', listener); },
  };
  window.BrclioHost = window.brclio || (isAndroid ? android : browser);
})();

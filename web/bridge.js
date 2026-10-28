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
      const xhsAction = method === 'xhsRequest' ? payload.action : '';
      const unlimited = method === 'downloadUpdate' || ['saveImages', 'saveNote', 'exportArchive', 'saveVideo', 'copyImages', 'shareImages', 'finishGenerated'].includes(xhsAction);
      const timer = unlimited ? null : setTimeout(() => { pending.delete(id); reject(new Error('系统操作尚未完成，请重试。')); }, method === 'pickPaths' ? 900000 : method === 'accountGoogle' ? 330000 : method === 'checkForUpdates' || ['parsePython', 'fetchNote'].includes(xhsAction) ? 90000 : 60000);
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
    getPlatform: async () => ({ platform: 'browser', version: '0.2.6', capabilities: { filePicker: false, folderPicker: false, systemIntegration: false, globalShortcut: false } }),
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
    checkForUpdates: async () => ({ status: 'unsupported', currentVersion: '0.2.6' }),
    downloadUpdate: async () => { throw new Error('请在客户端中下载安装包。'); },
    installUpdate: async () => { throw new Error('请在客户端中安装更新。'); },
    onUpdateState: () => () => {},
  };
  async function androidXhs(action, input = {}) {
    if (action !== 'parse') return native('xhsRequest', { action, input });
    const parser = await import('./xhs/lib/xhs-parser.js');
    const text = String(input.text || '').trim();
    if (!text || text.length > 3000) throw new Error('请粘贴 3000 字以内的小红书链接或分享文案。');
    const url = parser.extractInputUrl(text);
    if (input.engine !== undefined && !['node', 'python'].includes(input.engine)) throw new Error('解析引擎无效。');
    const fetchLocalNote = async () => {
      const pageURL = new URL(url); pageURL.hash = '';
      const source = await native('xhsRequest', { action: 'fetchNote', input: { url: pageURL.href } });
      const noteId = parser.extractNoteId(source.finalUrl) || parser.extractNoteId(url);
      if (!noteId) throw new Error('无法识别当前笔记 ID。');
      return { ...parser.parseNoteHtml(source.html, { noteId }), noteId, sourceUrl: source.finalUrl };
    };
    if (input.engine === 'python') {
      const result = await native('xhsRequest', { action: 'parsePython', input: { text } });
      if (!result?.success) throw new Error(result?.message || 'Python 解析失败，请稍后重试。');
      const checkedUrl = (value, kind) => {
        const normalized = parser.normalizeImageUrl(String(value || ''));
        if (!(kind === 'image' ? parser.isXhsImageUrl(normalized) : parser.isXhsVideoUrl(normalized))) throw new Error('解析服务返回了不受支持的媒体地址。');
        return normalized;
      };
      const video = raw => ({ ...raw, url: checkedUrl(raw?.url, 'video'), backupUrls: (Array.isArray(raw?.backupUrls) ? raw.backupUrls : []).map(value => checkedUrl(value, 'video')) });
      if (!Array.isArray(result.images) || !Array.isArray(result.videos) || result.images.length > 50 || result.videos.length > 50) throw new Error('Python 解析服务返回了无效媒体列表。');
      const images = result.images.map((raw, index) => ({ ...raw, index: index + 1, url: checkedUrl(raw?.url, 'image'), liveVideo: raw.liveVideo ? video(raw.liveVideo) : null }));
      const videos = result.videos.map(video);
      let originalVideos = (Array.isArray(result.originalVideos) ? result.originalVideos : []).map(video);
      let originalVideoCount = Math.max(Number(result.originalVideoCount) || 0, originalVideos.length);
      const hasOriginalVideo = result.hasOriginalVideo === true || originalVideoCount > 0;
      if (hasOriginalVideo && !originalVideos.length && !parser.isDirectImageUrl(url)) {
        // The public source Python contract reports originals but hides their
        // URLs. Supplement only declared originals from the same local note;
        // a blocked page must not discard successful Python images or videos.
        try {
          const local = await fetchLocalNote();
          if (!result.noteId || local.noteId === result.noteId) {
            originalVideos = (local.originalVideos || []).map(video);
            for (let index = 0; index < images.length; index++) {
              const image = images[index];
              if (image.liveVideo || !image.livePhoto) continue;
              const token = parser.extractOriginalAssetToken(image.url);
              const paired = (local.images || []).find((candidate, ordinal) => (candidate.index ?? ordinal + 1) === image.index
                && token && parser.extractOriginalAssetToken(candidate.url) === token && candidate.liveVideo?.url);
              if (paired) images[index] = { ...image, liveVideo: video(paired.liveVideo) };
            }
          }
        } catch { /* Keep the accurate public count and report unavailable URLs. */ }
      }
      originalVideoCount = Math.max(originalVideoCount, originalVideos.length);
      if (!images.length && !videos.length && !originalVideoCount) throw new Error('未取得笔记媒体。请确认笔记公开可见。');
      return { ...result, success: true, engine: 'python', sourceUrl: result.sourceUrl || url, images, videos, originalVideos,
        count: images.length, videoCount: videos.length, originalVideoCount, hasOriginalVideo: hasOriginalVideo || originalVideos.length > 0,
        originalVideoUnavailable: (hasOriginalVideo || originalVideoCount > 0) && !originalVideos.length };
    }
    if (parser.isDirectImageUrl(url)) {
      const token = parser.extractOriginalAssetToken(url);
      if (!token || !parser.validateAssetToken(token)) throw new Error('图片资源标识无效。');
      return { success: true, engine: 'node', title: '小红书图片', content: '', sourceUrl: url, images: [{ index: 1, token, url: parser.buildNoWatermarkUrl(token) }], videos: [], originalVideos: [], hasOriginalVideo: false };
    }
    const note = await fetchLocalNote();
    if (!note.images.length && !note.videos.length && !note.originalVideos.length) throw new Error('未取得笔记媒体。请确认链接完整且当前笔记公开可见。');
    return { ...note, success: true, engine: 'node', images: note.images.map((image, index) => ({ ...image, index: index + 1 })), count: note.images.length, videoCount: note.videos.length, originalVideoCount: note.originalVideos.length, hasOriginalVideo: note.originalVideos.length > 0 };
  }
  async function saveAndroidGenerated(blob, filename, options = {}) {
    const opened = await androidXhs('beginGenerated', { filename, mime: blob.type, size: blob.size, ...(options.requestId ? { requestId: options.requestId } : {}) });
    if (opened?.cancelled) return { ok: true, cancelled: true };
    try {
      for (let offset = 0; offset < blob.size; offset += 49152) {
        const bytes = new Uint8Array(await blob.slice(offset, offset + 49152).arrayBuffer());
        let binary = ''; for (const value of bytes) binary += String.fromCharCode(value);
        const appended = await androidXhs('appendGenerated', { token: opened.token, offset, data: btoa(binary) });
        if (appended?.cancelled) return { ok: true, cancelled: true };
      }
      return await androidXhs('finishGenerated', { token: opened.token });
    } catch (error) { await androidXhs('abortGenerated', { token: opened.token }).catch(() => {}); throw error; }
  }
  const android = {
    xhsRequest: androidXhs,
    saveGenerated: saveAndroidGenerated,
    onXhsEvent: callback => { const listener = event => callback(event.detail); window.addEventListener('brclio:xhs', listener); return () => window.removeEventListener('brclio:xhs', listener); },
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

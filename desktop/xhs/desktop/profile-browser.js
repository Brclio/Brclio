import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { parseNoteHtml, extractNoteId, fetchNotePage } from '../lib/xhs.js';
import { parseProfileUrl, normalizeProfileNote, parsePostedResponse, profileError, readProfileSnapshot } from './profile-source.js';
import { readLoginSnapshot } from './login-state.js';
import { readNoteSnapshot } from './note-state.js';

const ORIGIN = 'https://www.xiaohongshu.com';
const ACCOUNT_PARTITION = 'persist:brclio-xhs';
const WINDOW_KEYS = ['profileWindow', 'detailWindow', 'accountWindow'];
const POSTED = /^\/api\/sns\/web\/v\d+\/user_posted\/?$/;
const require = createRequire(import.meta.url);

// Executed in the isolated page. Find the actual feed scroll owner as well as
// known layouts; profile pages can nest it inside an unnamed container.
export function scrollProfileList(retry = false) {
  const nodes = new Set([document.scrollingElement,
    ...document.querySelectorAll('.main-container, .user-page, .feeds-tab-container, .scroll-container')]);
  const cards = document.querySelectorAll('.feeds-tab-container .note-item, .note-item');
  for (let node = cards[cards.length - 1]?.parentElement; node; node = node.parentElement) nodes.add(node);
  const scrollable = [...nodes].filter(node => node && node.scrollHeight > node.clientHeight);
  if (retry) {
    // Crossing the bottom boundary again re-arms lazy loading after a transient
    // empty response. Reassigning the same scrollTop cannot trigger a scroll.
    for (const node of scrollable) node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - Math.max(120, node.clientHeight / 2));
    return;
  }
  for (const node of scrollable) node.scrollTop = node.scrollHeight;
  window.scrollTo(0, document.documentElement.scrollHeight);
}

function allowedNavigation(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (url.hostname === 'xiaohongshu.com' || url.hostname.endsWith('.xiaohongshu.com'));
  } catch { return false; }
}

export class XhsBrowser {
  constructor({ onStatus = () => {}, onLoginState = () => {}, onDiagnostic = () => {}, BrowserWindow, session, wait = delay, now = Date.now, fetchPage = fetchNotePage } = {}) {
    this.onStatus = onStatus;
    this.electron = BrowserWindow ? { BrowserWindow, session } : null;
    this.profileWindow = null;
    this.detailWindow = null;
    this.wait = wait;
    this.now = now;
    this.onLoginState = onLoginState;
    this.onDiagnostic = onDiagnostic;
    this.fetchPage = fetchPage;
    this.loginState = { status: 'unknown', loggedIn: false, nickname: '', userId: '' };
    this.accountWindow = null;
    this.sessionRevision = 0;
    this.resetPromise = null;
  }

  async window(kind = 'profile') {
    if (this.resetPromise) await this.resetPromise;
    if (this.closing) throw new Error('应用正在关闭。');
    this.electron ||= require('electron');
    const revision = this.sessionRevision;
    const key = kind === 'profile' ? 'profileWindow' : kind === 'account' ? 'accountWindow' : 'detailWindow';
    const assertCurrent = win => {
      if (revision !== this.sessionRevision || win.isDestroyed() || this[key] !== win) {
        throw profileError('AUTH_REQUIRED', '小红书登录状态已变更，请重新打开登录窗口。');
      }
    };
    if (this[key] && !this[key].isDestroyed()) {
      const win = this[key];
      await this[`${key}Ready`];
      assertCurrent(win);
      return win;
    }
    const browserSession = this.electron.session.fromPartition(ACCOUNT_PARTITION);
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    const win = new this.electron.BrowserWindow({
      width: 1180, height: 820, show: false, title: 'Brclio 小红书下载器 · 登录与验证',
      webPreferences: { session: browserSession, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const event of ['will-navigate', 'will-redirect']) {
      win.webContents.on(event, (e, url) => { if (!allowedNavigation(url)) e.preventDefault(); });
    }
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    for (const event of ['did-finish-load', 'did-navigate-in-page']) {
      win.webContents.on(event, () => { void this.refreshLogin(win); });
    }
    // Closing the login window hides it so a queued task keeps its page/session.
    win.on('close', event => { if (!this.closing) { event.preventDefault(); win.hide(); } });
    this[key] = win;
    // A fresh hidden window has no renderer target. Network.enable can otherwise
    // wait indefinitely before first navigation, so create a blank target first.
    this[`${key}Ready`] = win.loadURL('about:blank');
    await this[`${key}Ready`];
    assertCurrent(win);
    if (!this.loginTimer) {
      this.loginTimer = setInterval(() => {
        const target = this.accountWindow || this.profileWindow || this.detailWindow;
        if (target) void this.refreshLogin(target);
      }, 2500);
      this.loginTimer.unref?.();
    }
    return win;
  }

  async refreshLogin(win) {
    if (this.resetPromise || this.loginBusy || this.closing || win.isDestroyed() || !allowedNavigation(win.webContents.getURL())) return { ...this.loginState };
    const revision = this.sessionRevision;
    const reading = { revision };
    this.loginBusy = reading;
    try {
      const current = await this.execute(win, `(${readLoginSnapshot.toString()})()`);
      if (revision !== this.sessionRevision || win.isDestroyed()) return { ...this.loginState };
      if (current?.status === 'unknown' || !current?.status) return this.loginState;
      if (current.loggedIn && !current.nickname && current.userId === this.loginState.userId) current.nickname = this.loginState.nickname;
      if (JSON.stringify(current) !== JSON.stringify(this.loginState)) {
        this.loginState = current;
        this.onLoginState({ ...current });
      }
    } catch { /* A page in navigation is not evidence of logout. */ }
    finally { if (this.loginBusy === reading) this.loginBusy = false; }
    return { ...this.loginState };
  }

  async getLoginState() {
    if (this.resetPromise) { await this.resetPromise; return { ...this.loginState }; }
    const revision = this.sessionRevision;
    try {
      const win = await this.window('account');
      if (revision !== this.sessionRevision) return { ...this.loginState };
      if (!allowedNavigation(win.webContents.getURL())) await this.navigate(win, `${ORIGIN}/explore`);
      if (revision !== this.sessionRevision) return { ...this.loginState };
      return this.refreshLogin(win);
    } catch (error) {
      if (revision !== this.sessionRevision) return { ...this.loginState };
      throw error;
    }
  }

  clearLoginData() {
    if (this.resetPromise) return this.resetPromise;
    const pending = this._clearLoginData();
    this.resetPromise = pending;
    const finished = () => { if (this.resetPromise === pending) this.resetPromise = null; };
    void pending.then(finished, finished);
    return pending;
  }

  async _clearLoginData() {
    this.electron ||= require('electron');
    this.sessionRevision += 1;
    clearInterval(this.loginTimer);
    this.loginTimer = null;
    this.loginBusy = false;
    // Invalidate in-flight snapshots even if cleanup later fails. Unknown is
    // deliberately distinct from reporting a successful logout.
    this.loginState = { status: 'unknown', loggedIn: false, nickname: '', userId: '' };
    this.onLoginState({ ...this.loginState });
    for (const key of WINDOW_KEYS) {
      const win = this[key];
      this[key] = null;
      this[`${key}Ready`] = null;
      if (win && !win.isDestroyed()) { win.webContents.stop(); win.destroy(); }
    }
    this.blockedWindow = null;
    const browserSession = this.electron.session.fromPartition(ACCOUNT_PARTITION);
    // Stop background writers before removing all browsing data. This session
    // belongs only to XHS; the app account, job records and files live elsewhere.
    await browserSession.clearStorageData({ storages: ['serviceworkers'] });
    await browserSession.closeAllConnections();
    await browserSession.clearData();
    await browserSession.clearAuthCache();
    await browserSession.clearCodeCaches({});
    await browserSession.clearHostResolverCache();
    browserSession.flushStorageData();
    await browserSession.cookies.flushStore();
    this.loginState = { status: 'logged-out', loggedIn: false, nickname: '', userId: '' };
    this.onLoginState({ ...this.loginState });
    return { ...this.loginState };
  }

  async openLogin(value) {
    const revision = this.sessionRevision;
    const win = this.blockedWindow && !this.blockedWindow.isDestroyed()
      ? this.blockedWindow : await this.window('account');
    if (revision !== this.sessionRevision || win.isDestroyed()) {
      throw profileError('AUTH_REQUIRED', '小红书登录状态已变更，请重新打开登录窗口。');
    }
    win.show();
    win.focus();
    if (!allowedNavigation(win.webContents.getURL())) await this.navigate(win, value ? parseProfileUrl(value).url : `${ORIGIN}/explore`);
    return true;
  }

  async execute(win, script, signal) {
    signal?.throwIfAborted();
    let timer;
    let abort;
    try {
      return await Promise.race([
        win.webContents.executeJavaScript(script),
        new Promise((_, reject) => {
          abort = () => { win.webContents.stop(); reject(signal.reason || Object.assign(new Error('任务已暂停。'), { name: 'AbortError' })); };
          signal?.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => reject(profileError('DISCOVERY_INCOMPLETE', '页面读取超时，任务已暂停，请稍后继续。')), 15000);
        })
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async navigate(win, url, signal) {
    signal?.throwIfAborted();
    if (!allowedNavigation(url)) throw profileError('INVALID_URL', '不支持的页面地址。');
    const started = Date.now();
    this.diagnostic('navigation.start', { noteId: extractNoteId(url) || undefined });
    let timer;
    let domReady;
    let rejectAborted;
    const abort = () => {
      try { if (!win.isDestroyed()) win.webContents.stop(); } catch { /* A destroyed renderer is already stopped. */ }
      rejectAborted?.(signal.reason || Object.assign(new Error('任务已暂停。'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await Promise.race([
        win.loadURL(url),
        new Promise(resolve => {
          domReady = () => { if (allowedNavigation(win.webContents.getURL())) resolve(); };
          win.webContents.on('dom-ready', domReady);
        }),
        new Promise((_, reject) => { timer = setTimeout(() => { win.webContents.stop(); reject(new Error('小红书页面加载超时，请稍后继续。')); }, 45000); }),
        new Promise((_, reject) => { rejectAborted = reject; }),
      ]);
      signal?.throwIfAborted();
      this.diagnostic('navigation.ready', { noteId: extractNoteId(url) || undefined, durationMs: Date.now() - started });
    } catch (error) {
      this.diagnostic('navigation.error', { noteId: extractNoteId(url) || undefined, code: error.code || error.name, durationMs: Date.now() - started });
      throw error;
    } finally {
      clearTimeout(timer);
      win.webContents.removeListener('dom-ready', domReady);
      signal?.removeEventListener('abort', abort);
    }
  }

  block(win, code, message) {
    this.diagnostic('access.blocked', { code });
    this.blockedWindow = win;
    win.show();
    this.onStatus(message);
    throw profileError(code, message);
  }

  assertDiscoveryAccess() {
    this.discoveryAccessCheck?.();
  }

  async *discover(value, { signal, intervalSeconds = 10, jitterSeconds = 3 } = {}) {
    const profile = parseProfileUrl(value);
    const win = await this.window();
    const debuggerApi = win.webContents.debugger;
    const pending = new Map();
    const readingResponses = new Map();
    const batches = [];
    let networkError;
    const recordNetworkError = error => {
      // Once a request observes a login/challenge gate, a different page failing
      // later cannot downgrade it and reopen downloads during a yielded batch.
      if (!['AUTH_REQUIRED', 'RATE_LIMITED'].includes(networkError?.code)) networkError = error;
    };
    let active = true;
    const seen = new Map();
    let stale = 0;
    let requestSequence = 0;
    let latestResponseSequence = 0;
    let apiHasMore = null;
    const seenCursors = new Set();
    let fetchingSince = null;
    const matchesProfile = value => {
      const url = new URL(value);
      return allowedNavigation(url.href) && POSTED.test(url.pathname) && url.searchParams.get('user_id') === profile.id;
    };
    const trackRequest = id => {
      if (!pending.has(id)) pending.set(id, { sequence: ++requestSequence, startedAt: this.now() });
    };
    const checkNetwork = () => {
      if (networkError) this.block(win, networkError.code, networkError.message);
      if ([...pending.values(), ...readingResponses.values()].some(request => this.now() - request.startedAt >= 45000)) {
        throw profileError('DISCOVERY_INCOMPLETE', '主页翻页请求超过 45 秒仍未完成，已保留当前笔记，可稍后继续补全。');
      }
    };
    const accessCheck = () => {
      if (networkError && ['AUTH_REQUIRED', 'RATE_LIMITED'].includes(networkError.code)) {
        this.block(win, networkError.code, networkError.message);
      }
    };
    this.discoveryAccessCheck = accessCheck;
    const listener = async (_event, method, params) => {
      try {
        if (!active) return;
        if (method === 'Network.requestWillBeSent') {
          if (params.type !== 'Preflight' && params.request.method !== 'OPTIONS' && matchesProfile(params.request.url)) trackRequest(params.requestId);
        } else if (method === 'Network.responseReceived') {
          // CORS preflights share the API URL but have no JSON body. Their CDP
          // response cannot be read as the actual authored-note response.
          if (params.type === 'Preflight' || params.response.status === 204) return;
          if (!matchesProfile(params.response.url)) return;
          if ([401, 403, 429, 461, 471].includes(params.response.status)) {
            pending.delete(params.requestId);
            recordNetworkError(profileError(params.response.status === 429 ? 'RATE_LIMITED' : 'AUTH_REQUIRED', '小红书限制了当前访问，请在内置浏览器完成登录或验证，稍后继续。'));
          } else if (params.response.status >= 400) {
            pending.delete(params.requestId);
            recordNetworkError(profileError('DISCOVERY_INCOMPLETE', `主页列表请求失败（HTTP ${params.response.status}），尚未抓取完毕。`));
          } else trackRequest(params.requestId);
        } else if (method === 'Network.loadingFinished' && pending.has(params.requestId)) {
          const request = pending.get(params.requestId);
          pending.delete(params.requestId);
          if (params.encodedDataLength > 16 * 1024 * 1024) throw profileError('DISCOVERY_INCOMPLETE', '主页列表响应过大，已暂停。');
          readingResponses.set(params.requestId, request);
          try {
            const body = await debuggerApi.sendCommand('Network.getResponseBody', { requestId: params.requestId });
            if (!active) return;
            const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
            const batch = parsePostedResponse(JSON.parse(text), profile.id);
            if (!batch) throw profileError('DISCOVERY_INCOMPLETE', '主页列表响应缺少笔记数据，尚未确认全部抓取。');
            batches.push({ ...batch, sequence: request.sequence });
          } finally { readingResponses.delete(params.requestId); }
        } else if (method === 'Network.loadingFailed' && pending.delete(params.requestId)) {
          recordNetworkError(profileError('DISCOVERY_INCOMPLETE', '主页列表请求中断，请稍后继续。'));
        }
      } catch (error) {
        // Keep the protocol error (not request URLs/bodies/cookies) available for
        // diagnosing platform changes without falsely completing a partial list.
        if (process.env.XHS_PROFILE_DIAGNOSTICS === '1') console.warn('profile-list-capture', error.name, String(error.message).slice(0, 160));
        if (active) recordNetworkError(error.code ? error : profileError('DISCOVERY_INCOMPLETE', '无法读取完整主页列表，请重新继续任务。'));
      }
    };
    try {
      if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
      debuggerApi.on('message', listener);
      await debuggerApi.sendCommand('Network.enable', { maxResourceBufferSize: 16 * 1024 * 1024, maxTotalBufferSize: 32 * 1024 * 1024 });
      await this.navigate(win, profile.url, signal);
      // This initial wait only observes rendering; it does not issue new requests.
      await this.wait(1200, undefined, { signal });
      while (true) {
        signal?.throwIfAborted();
        checkNetwork();
        if (win.isDestroyed()) throw profileError('DISCOVERY_INCOMPLETE', '内置浏览器已关闭，请继续任务。');
        const snap = await this.execute(win, `(${readProfileSnapshot.toString()})(${JSON.stringify(profile.id)})`, signal);
        // CDP responses can arrive while executeJavaScript is awaiting the page.
        checkNetwork();
        if (snap.challenge) this.block(win, 'RATE_LIMITED', '需要安全验证，任务已暂停。请在内置浏览器完成验证后继续。');
        if (snap.login) this.block(win, 'AUTH_REQUIRED', '需要登录小红书，任务已暂停。登录后点击“继续任务”。');
        if (snap.wrongTab || new URL(win.webContents.getURL()).pathname.replace(/\/$/, '') !== `/user/profile/${profile.id}`) {
          throw profileError('DISCOVERY_INCOMPLETE', '浏览器已离开该主页的笔记列表，请继续任务重新加载。');
        }
        const incoming = batches.splice(0);
        if (snap.list.some(raw => !normalizeProfileNote(raw, profile.id))) {
          throw profileError('DISCOVERY_INCOMPLETE', '主页列表中有无法完整识别的帖子，任务已暂停，尚未确认全部抓取。');
        }
        let cursorAdvanced = false;
        for (const batch of incoming.sort((a, b) => a.sequence - b.sequence)) {
          if (batch.sequence < latestResponseSequence) continue;
          latestResponseSequence = batch.sequence;
          apiHasMore = batch.hasMore;
          if (batch.cursor && !seenCursors.has(batch.cursor)) { cursorAdvanced = true; seenCursors.add(batch.cursor); }
          this.diagnostic('discovery.page', { count: batch.notes.length, hasMore: batch.hasMore,
            sequence: batch.sequence, cursorAdvanced });
        }
        // An earlier end flag must not survive a newer page that says has_more.
        // Explicit API pagination wins over a possibly stale reactive snapshot.
        const busy = pending.size > 0 || readingResponses.size > 0 || snap.fetching === true;
        if (snap.fetching) {
          // The consumer may spend minutes saving a yielded batch. A response
          // or a new in-flight request starts a new loading observation, so that
          // consumer time is never charged to an unrelated later page.
          if (pending.size || readingResponses.size || incoming.length) fetchingSince = this.now();
          else fetchingSince ??= this.now();
          if (this.now() - fetchingSince >= 45000) throw profileError('DISCOVERY_INCOMPLETE', '主页仍在加载且超过 45 秒没有完成，已保留当前笔记，可稍后继续补全。');
        } else fetchingSince = null;
        const done = (apiHasMore === null ? snap.done : apiHasMore === false) && !busy;
        const authoredNotes = [...snap.list, ...incoming.flatMap(batch => batch.notes)];
        const authoredIds = new Set([...seen.keys(), ...authoredNotes.map(raw => normalizeProfileNote(raw, profile.id)?.id)]);
        // DOM cards may include hidden tabs or recommendations. They can enrich an
        // already-confirmed author's note with a token, but cannot introduce IDs.
        const matchingCards = snap.cards.filter(raw => authoredIds.has(normalizeProfileNote(raw, profile.id)?.id));
        const rawNotes = [...authoredNotes, ...matchingCards];
        const candidates = new Map();
        for (const raw of rawNotes) {
          const note = normalizeProfileNote(raw, profile.id);
          if (!note) continue;
          const previous = candidates.get(note.id) || seen.get(note.id);
          candidates.set(note.id, { ...note,
            url: new URL(note.url).searchParams.has('xsec_token') ? note.url : previous?.url || note.url,
            title: previous?.title || note.title });
        }
        let newCount = 0;
        const notes = [];
        for (const note of candidates.values()) {
          const prior = seen.get(note.id);
          if (!prior) newCount++;
          if (!prior || note.url !== prior.url || note.title !== prior.title) {
            notes.push(note);
            seen.set(note.id, note);
          }
        }
        this.diagnostic('discovery.snapshot', { discovered: seen.size, newCount, pending: pending.size,
          reading: readingResponses.size, fetching: Boolean(snap.fetching), done, stale });
        yield { notes, done, profileName: snap.profileName };
        if (done) return;
        stale = newCount || cursorAdvanced ? 0 : busy ? stale : stale + 1;
        if (stale >= 5) {
          if (!seen.size && /登录|扫码/.test(snap.pageText)) this.block(win, 'AUTH_REQUIRED', '主页需要登录才能加载帖子，请登录后继续。');
          throw profileError('DISCOVERY_INCOMPLETE', '列表连续多次没有加载新帖子，且未收到结束标记。任务已暂停，可稍后继续。');
        }
        const wait = Math.max(3, Number(intervalSeconds) || 10) + Math.random() * Math.max(0, Number(jitterSeconds) || 0);
        this.onStatus(`已发现 ${seen.size} 篇，${Math.ceil(wait)} 秒后加载下一页。`);
        await this.wait(wait * 1000, undefined, { signal });
        // An in-flight page is still progress. Do not issue repeated bottom
        // scrolls while it is loading; the bounded timeout above handles hangs.
        if (busy) continue;
        if (stale > 0) {
          await this.execute(win, `(${scrollProfileList.toString()})(true)`, signal);
          // Keep the recovery delay in the host so pausing cancels it before
          // another bottom crossing can trigger a late list request.
          await this.wait(150, undefined, { signal });
        }
        await this.execute(win, `(${scrollProfileList.toString()})(false)`, signal);
        await this.wait(1000, undefined, { signal });
      }
    } finally {
      active = false;
      if (this.discoveryAccessCheck === accessCheck) this.discoveryAccessCheck = null;
      debuggerApi.removeListener('message', listener);
      if (debuggerApi.isAttached()) debuggerApi.detach();
      if (!win.isDestroyed()) win.webContents.stop();
    }
  }

  async resolveNote(note, { signal, beforeRequest = async () => {} } = {}) {
    if (!note?.id || extractNoteId(note.url) !== note.id || !allowedNavigation(note.url)) throw profileError('INVALID_NOTE', '笔记地址无效。');
    const win = await this.window('detail');
    await this.navigate(win, note.url, signal);
    let noteType;
    const complete = parsed => parsed.strategy === 'exact-initial-state' && (parsed.images.length || parsed.videos.length || parsed.originalVideos?.length)
      && !parsed.images.some(image => image.livePhoto && !image.liveVideo?.url)
      && ((parsed.noteType || noteType) !== 'video' || parsed.videos.length || parsed.originalVideos?.length);
    for (let attempt = 0; attempt < 20; attempt++) {
      signal?.throwIfAborted();
      const result = await this.execute(win, `(${readNoteSnapshot.toString()})(${JSON.stringify(note.id)})`, signal);
      if (result.challenge) this.block(win, 'RATE_LIMITED', '笔记需要安全验证，完成验证后可继续。');
      if (result.login) this.block(win, 'AUTH_REQUIRED', '笔记需要登录，登录后可继续任务。');
      if (result.error) throw profileError(result.error.code, result.error.message);
      const html = `<script>window.__INITIAL_STATE__=${result.serialized.replace(/</g, '\\u003c')}</script>`;
      const parsed = parseNoteHtml(html, { noteId: note.id });
      const exactNote = JSON.parse(result.serialized || '{}').note?.noteDetailMap?.[note.id]?.note;
      noteType = exactNote?.type;
      const sourceTitle = exactNote?.title ?? exactNote?.displayTitle ?? exactNote?.display_title;
      // The shared parser supplies a generic display label when there is no
      // title. Keep its provenance so that label cannot erase a feed title.
      parsed.titleSource = typeof sourceTitle === 'string' && sourceTitle.trim() ? 'note' : 'fallback';
      // Images can hydrate before their live-photo streams, and video covers can
      // precede the video payload. Wait for complete media instead of saving early.
      const pendingLiveVideo = parsed.images.some(image => image.livePhoto && !image.liveVideo?.url);
      this.diagnostic('note.extraction', { noteId: note.id, attempt: attempt + 1, source: 'browser',
        images: parsed.images.length, videos: parsed.videos.length, originalVideos: parsed.originalVideos?.length || 0, pendingLiveVideo });
      if (complete(parsed)) return parsed;
      await this.wait(500, undefined, { signal });
    }
    // Reactive desktop stores sometimes omit streams until player hydration.
    // Reuse the exact-note mobile-page parser as a bounded, paced alternative.
    // Login/challenge gates above are never bypassed by this fallback.
    if (this.fetchPage) {
      await beforeRequest(signal);
      signal?.throwIfAborted();
      // Pacing may take several seconds. Recheck gates after that wait so a
      // newly presented verification or login page cannot trigger another route.
      const latest = await this.execute(win, `(${readNoteSnapshot.toString()})(${JSON.stringify(note.id)})`, signal);
      if (latest.challenge) this.block(win, 'RATE_LIMITED', '笔记需要安全验证，完成验证后可继续。');
      if (latest.login) this.block(win, 'AUTH_REQUIRED', '笔记需要登录，登录后可继续任务。');
      if (latest.error) throw profileError(latest.error.code, latest.error.message);
      this.diagnostic('note.fallback', { noteId: note.id, source: 'mobile-page' });
      try {
        const page = await this.fetchPage(note.url, { signal });
        signal?.throwIfAborted();
        if (page && extractNoteId(page.finalUrl) === note.id) {
          const parsed = parseNoteHtml(page.html, { noteId: note.id });
          // A prepended page title only wins when the parser did not find a
          // title in the exact note. This preserves a real generic-looking
          // title without modifying the shared source parser.
          const marker = '__brclio_missing_note_title__';
          const titleProbe = parseNoteHtml(`<meta property="og:title" content="${marker}">${page.html}`, { noteId: note.id });
          const hasPageTitle = [
            /<meta\b[^>]*(?:property|name)=["']og:title["'][^>]*content=["'](.*?)["'][^>]*>/i,
            /<meta\b[^>]*content=["'](.*?)["'][^>]*(?:property|name)=["']og:title["'][^>]*>/i,
            /<title[^>]*>(.*?)<\/title>/is,
          ].some(pattern => Boolean(page.html.match(pattern)?.[1]));
          parsed.titleSource = titleProbe.title !== marker ? 'note' : hasPageTitle ? 'page' : 'fallback';
          this.diagnostic('note.extraction', { noteId: note.id, source: 'mobile-page', images: parsed.images.length, videos: parsed.videos.length,
            originalVideos: parsed.originalVideos?.length || 0 });
          if (complete(parsed)) return parsed;
        }
      } catch (error) {
        if (signal?.aborted || error.name === 'AbortError') throw error;
        this.diagnostic('note.fallback-error', { noteId: note.id, code: error.code || error.name });
        if (['AUTH_REQUIRED', 'RATE_LIMITED'].includes(error.code)) this.block(win, error.code, '小红书限制了详情访问，请完成登录或验证后继续。');
      }
    }
    throw profileError('NOTE_INCOMPLETE', '详情媒体尚未完整加载，已保留任务和文件。请稍后重试，或打开小红书登录与验证页面检查。');
  }

  diagnostic(event, fields) {
    try { this.onDiagnostic(event, fields); } catch { /* Logging must never affect the browser. */ }
  }

  close() {
    this.closing = true;
    clearInterval(this.loginTimer);
    for (const win of [this.profileWindow, this.detailWindow, this.accountWindow]) if (win && !win.isDestroyed()) win.destroy();
  }
}

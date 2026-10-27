/* Small, independent media tool. Existing Brclio account and preferences stay owned by their modules. */
(() => {
  'use strict';
  const $ = id => document.getElementById('xhs-' + id);
  const host = window.BrclioHost;
  const native = host?.xhsRequest;
  const state = { hostPlatform: 'browser', note: null, selected: new Set(), directory: '', profile: null, videoRequest: null, archiveRequest: null, transferRequest: null, profileFilter: 'all', profileVisible: 100, profileRowsKey: '', profileDirty: new Set(), clipboardSeen: '', clipboardPending: '', clipboardChecking: false, previewController: null, fileController: null, liveBusy: false, files: [], fileInfo: null, liveResult: null, liveController: null, previewUrls: [], previewTimer: null, fileRevision: 0 };
  const labels = { idle: '尚未开始', discovering: '正在发现笔记', downloading: '正在下载', waiting: '等待下一次请求', paused: '已暂停', completed: '已完成', canceled: '已停止', cancelled: '已停止', error: '任务出错', pending: '等待中', skipped: '已跳过', failed: '失败' };
  const isNative = typeof native === 'function';
  function message(text, failed = false) { $('message').textContent = text || ''; $('message').hidden = !text; $('message').classList.toggle('error', failed); }
  async function request(action, input = {}) { if (!isNative) throw new Error('请在 Brclio 桌面客户端中使用此功能。'); const result = await native(action, input); if (result?.ok === false) throw new Error(typeof result.error === 'string' ? result.error : result.error?.message || result.message || '操作未完成，请重试。'); return result; }
  async function run(button, task) { const old = button?.disabled; if (button) button.disabled = true; try { return await task(); } catch (error) { message(error.message || '操作未完成，请重试。', true); } finally { if (button) button.disabled = old; if (button?.id?.startsWith('xhs-profile-') && state.profile) renderProfile(state.profile); if (button?.id === 'xhs-live-generate' || button?.id === 'xhs-live-preview') syncLiveControls(); if (button?.closest('#xhs-panel-note') || button?.closest('#xhs-live-result')) syncNativeBusy(); } }
  function click(id, task) { $(id).addEventListener('click', event => { void run(event.currentTarget, task); }); }
  function element(tag, className, value) { const result = document.createElement(tag); if (className) result.className = className; if (value !== undefined) result.textContent = value; return result; }
  function actionButton(text, task, requiresNative = true) { const button = element('button', 'text-button', text); button.type = 'button'; button.addEventListener('click', () => { void run(button, task); }); if (requiresNative) { button.dataset.xhsNative = ''; if (!isNative || nativeBusy()) button.disabled = true; } return button; }
  function mediaURL(url, kind = 'image') { return !isNative ? '' : state.hostPlatform === 'android' ? `https://appassets.androidplatform.net/xhs-media?url=${encodeURIComponent(url)}&kind=${kind}` : `brclio-xhs://local/api/${kind}?url=${encodeURIComponent(url)}`; }
  function videoCandidates() { const originals = (state.note?.originalVideos || []).map(video => ({ ...video, isOriginal: true })); const urls = new Set(originals.map(video => video.url)); return [...originals, ...(state.note?.videos || []).filter(video => !urls.has(video.url))]; }
  function nativeBusy() { return Boolean(state.videoRequest || state.archiveRequest || state.transferRequest); }
  function selectedImages() { return (state.note?.images || []).filter((image, i) => state.selected.has(image.index ?? i + 1)); }
  function title() { return String(state.note?.title || '小红书笔记').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120); }
  function noteText() { const note = state.note; if (!note) return ''; const heading = String(note.title || '').trim(), content = String(note.content || '').trim(); return !content ? heading : !heading || content === heading || content.startsWith(heading + '\n') ? content : heading + '\n\n' + content; }
  async function copyText(value) { if (window.BrclioHost?.copyText) await window.BrclioHost.copyText(value); else await navigator.clipboard.writeText(value); message('已复制到剪贴板。'); }
  async function download(blob, filename) {
    await platformReady;
    if (state.hostPlatform === 'android') {
      if (!host.saveGenerated) throw new Error('请更新安卓客户端以导出实况文件。');
      const result = await performTransfer('saveGenerated', {}, '正在准备生成文件并选择保存位置…', requestId => host.saveGenerated(blob, filename, { requestId }));
      message(result?.cancelled || result?.canceled ? '已取消保存。' : '文件已保存。'); return result;
    }
    return performTransfer('saveGenerated', {}, `正在准备导出 ${filename}…`, async () => {
      // Let the progress panel paint before handing the local Blob to the host.
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      const url = URL.createObjectURL(blob), anchor = document.createElement('a');
      try { anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); }
      finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
      return { ok: true, handedOff: true };
    }, false);
  }
  function setTab(name) { if (name === 'profile' && state.hostPlatform === 'android') { message('主页批量下载在 macOS 或 Windows 桌面客户端中使用。'); return; } for (const tab of document.querySelectorAll('[data-xhs-tab]')) { const active = tab.dataset.xhsTab === name; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; $('panel-' + tab.dataset.xhsTab).hidden = !active; } if (name === 'live') void loadLiveSupport(); }
  const tabs = [...document.querySelectorAll('[data-xhs-tab]')];
  for (const tab of tabs) { tab.addEventListener('click', () => setTab(tab.dataset.xhsTab)); tab.addEventListener('keydown', event => { const available = tabs.filter(item => !item.disabled), index = available.indexOf(tab); let next; if (event.key === 'ArrowRight') next = available[(index + 1) % available.length]; if (event.key === 'ArrowLeft') next = available[(index + available.length - 1) % available.length]; if (event.key === 'Home') next = available[0]; if (event.key === 'End') next = available.at(-1); if (next) { event.preventDefault(); setTab(next.dataset.xhsTab); next.focus(); } }); }
  function renderSelection() { const count = selectedImages().length, total = state.note?.images?.length || 0, blocked = nativeBusy(); $('selection-count').textContent = `${count} / ${total} 张`; $('select-all').checked = total > 0 && count === total; $('select-all').indeterminate = count > 0 && count < total; $('copy-images').disabled = !isNative || blocked || count === 0; $('share-images').hidden = state.hostPlatform !== 'android'; $('share-images').disabled = !isNative || blocked || count === 0; $('save-images').disabled = !isNative || blocked || count === 0; $('export-images').disabled = !isNative || blocked || count === 0; $('export-selected').disabled = !isNative || blocked || count === 0; $('copy-image-links').disabled = count === 0; $('save-live').hidden = !selectedImages().some(image => image.liveVideo?.url); $('export-live').hidden = $('save-live').hidden; }
  function syncNativeBusy() {
    const blocked = nativeBusy();
    for (const button of document.querySelectorAll('#xhs-panel-note [data-xhs-native]')) button.disabled = !isNative || blocked;
    for (const input of document.querySelectorAll('#xhs-image-grid input,#xhs-select-all,#xhs-engine')) input.disabled = blocked;
    for (const button of document.querySelectorAll('#xhs-live-result button')) button.disabled = blocked;
    renderSelection();
    for (const id of ['save-video','copy-video-link','open-video-link']) $(id).disabled = !isNative || blocked || !videoCandidates().length;
  }
  function showDownloadProgress(kind, description, cancellable = true) {
    message('');
    $('transfer-panel').hidden = false; $('transfer-panel').setAttribute('aria-busy', 'true'); $('transfer-dismiss').hidden = true;
    $('download-detail').textContent = '';
    for (const name of ['video', 'archive', 'transfer']) {
      const active = name === kind;
      $(name + '-status').hidden = !active; $(name + '-progress').hidden = !active;
      $(name === 'transfer' ? 'transfer-cancel' : 'cancel-' + name).hidden = !active || !cancellable;
    }
    $(kind + '-status').textContent = description; $(kind + '-progress').removeAttribute('value');
  }
  function finishDownloadProgress(kind, description, cancelled = false) {
    $(kind + '-status').textContent = description; $(kind + '-progress').hidden = cancelled;
    if (!cancelled) $(kind + '-progress').value = 100;
    $('download-detail').textContent = cancelled ? '' : '100%';
    $('transfer-panel').setAttribute('aria-busy', 'false'); $('transfer-dismiss').hidden = false;
  }
  click('transfer-dismiss', () => { if (!nativeBusy()) $('transfer-panel').hidden = true; });
  async function performTransfer(action, input, description, operation, cancellable = true) {
    if (nativeBusy()) throw new Error('已有素材正在处理，请完成或取消后重试。');
    const requestId = `transfer-${crypto.randomUUID()}`; state.transferRequest = requestId; syncNativeBusy();
    showDownloadProgress('transfer', description, cancellable);
    try {
      const result = operation ? await operation(requestId) : await request(action, { ...input, requestId });
      if (result?.ok === false) throw new Error(typeof result.error === 'string' ? result.error : result.error?.message || '素材处理失败。');
      finishDownloadProgress('transfer', result?.cancelled || result?.canceled ? '素材处理已取消。' : result?.handedOff ? '文件已交给系统下载，请在下载列表查看保存结果。' : '所选素材已处理完成。', Boolean(result?.cancelled || result?.canceled));
      return result;
    } catch (error) { finishDownloadProgress('transfer', error.message, true); throw error; }
    finally { state.transferRequest = null; $('transfer-cancel').hidden = true; syncNativeBusy(); }
  }
  click('transfer-cancel', async () => { $('transfer-status').textContent = '正在取消素材处理…'; await request('cancelTransfer', { requestId: state.transferRequest }); });
  function openOriginal(image, index) {
    if (!isNative) throw new Error('请在客户端中打开原图。');
    $('image-original').src = mediaURL(image.url); $('image-original').alt = `${state.note?.title || '笔记'} · 第 ${index} 张原图`;
    $('image-caption').textContent = `${state.note?.title || '小红书笔记'} · 第 ${index} 张原图`;
    if (!$('image-dialog').open) $('image-dialog').showModal();
  }
  $('image-close').addEventListener('click', () => $('image-dialog').close());
  $('image-dialog').addEventListener('close', () => $('image-original').removeAttribute('src'));
  function renderNote(note) {
    state.note = { ...note, images: note.images || [], videos: note.videos || [] }; state.selected = new Set(state.note.images.map((image, i) => image.index ?? i + 1));
    $('note-result').hidden = false; $('note-title').textContent = note.title || '小红书笔记'; $('note-content').textContent = note.content || '这篇笔记没有文案。';
    const liveCount = state.note.images.filter(image => image.liveVideo?.url).length;
    $('note-summary').textContent = [`${state.note.images.length} 张原图`, `${videoCandidates().length} 个视频候选`, ...(liveCount ? [`${liveCount} 张实况`] : []), state.hostPlatform === 'android' ? note.engine === 'python' ? 'Python 备用解析' : '本地解析' : note.engine ? `${note.engine === 'python' ? 'Python' : 'Node'} 解析` : ''].filter(Boolean).join(' · ');
    $('images-section').hidden = state.note.images.length === 0; $('image-grid').replaceChildren();
    state.note.images.forEach((image, i) => {
      const index = image.index ?? i + 1, card = element('article', 'xhs-image-card'), label = element('label'), checkbox = element('input', 'xhs-image-select'); checkbox.type = 'checkbox'; checkbox.checked = true; checkbox.setAttribute('aria-label', `选择第 ${index} 张图片`); label.append(checkbox, document.createTextNode(`第 ${index} 张${image.liveVideo?.url ? ' · 实况' : ''}`));
      checkbox.addEventListener('change', () => { if (checkbox.checked) state.selected.add(index); else state.selected.delete(index); renderSelection(); });
      const img = element('img'); img.src = mediaURL(image.url); img.alt = `${note.title || '笔记'} 第 ${index} 张原图`; img.loading = 'lazy';
      const actions = element('div', 'xhs-image-actions'); actions.append(actionButton('保存原图', async () => { const result = await performTransfer('saveImages', { images: [image], title: title() }, '正在保存原图…'); message(result?.cancelled || result?.canceled ? '已取消保存。' : '原图已保存。'); }), actionButton('复制原图', async () => { const result = await performTransfer('copyImages', { images: [image], title: title() }, '正在复制原图…'); message(result?.cancelled || result?.canceled ? '已取消复制。' : '原图已复制。'); }), actionButton('复制链接', () => copyText(image.url), false), actionButton('打开原图', () => openOriginal(image,index), false));
      if (image.liveVideo?.url) actions.append(actionButton('实况 MP4', () => saveVideo(image.liveVideo, `${title()}-${index}-live.mp4`, false)), actionButton('实况素材', () => saveNote('live', [image])), actionButton('实况 ZIP', () => exportArchive('live', [image])));
      card.append(label, img, actions); $('image-grid').append(card);
    });
    $('videos-section').hidden = videoCandidates().length === 0 && note.hasOriginalVideo !== true; $('video-select').replaceChildren();
    videoCandidates().forEach((video, index) => { const option = element('option', '', videoLabel(video, index)); option.value = String(index); $('video-select').append(option); });
    $('original-status').textContent = !state.note.originalVideos?.length && note.hasOriginalVideo === true ? '页面声明有原视频，但暂未取得可下载地址' : note.hasOriginalVideo === false ? '未提供原视频' : state.note.originalVideos?.length ? '含原视频候选' : '按可用清晰度保存';
    renderVideo(); renderSelection(); syncNativeBusy(); message('笔记已解析，可以选择媒体并保存。');
  }
  function videoLabel(video, index) { return [video.label || video.quality || video.name || `候选 ${index + 1}`, video.original || video.isOriginal ? '原视频' : '', video.width && video.height ? `${video.width} × ${video.height}` : '', video.size ? `${(video.size / 1048576).toFixed(1)} MB` : ''].filter(Boolean).join(' · '); }
  function renderVideo() {
    const preview = $('video-preview'), video = videoCandidates()[Number($('video-select').value || 0)];
    preview.hidden = !video; preview.pause(); preview.removeAttribute('src'); preview.removeAttribute('poster');
    if (video?.url) {
      const cover = state.note?.images?.[0]?.url;
      if (cover) preview.poster = mediaURL(cover);
      preview.src = mediaURL(video.url, 'video');
    }
    syncNativeBusy();
  }
  async function saveNote(format = 'all', images = selectedImages()) { const result = await performTransfer('saveNote', { note: state.note, images, format }, '正在保存笔记素材…'); message((result?.canceled || result?.cancelled) ? '已取消保存。' : '笔记素材已保存。'); return result; }
  async function exportArchive(format, images = selectedImages()) {
    if (nativeBusy()) throw new Error('已有素材正在处理，请完成或取消后重试。');
    const requestId = `archive-${crypto.randomUUID()}`; state.archiveRequest = requestId; syncNativeBusy(); showDownloadProgress('archive', '正在准备下载素材并打包 ZIP…');
    try { const result = await request('exportArchive', { requestId, note: state.note, images, format }); const cancelled = Boolean(result?.canceled || result?.cancelled); const description = cancelled ? 'ZIP 导出已取消。' : 'ZIP 已保存，内含所选素材与笔记文案。'; finishDownloadProgress('archive', description, cancelled); message(description); return result; }
    catch (error) { finishDownloadProgress('archive', error.message, true); throw error; }
    finally { state.archiveRequest = null; $('cancel-archive').hidden = true; syncNativeBusy(); }
  }
  async function saveVideo(video, filename, requireAudio = true) {
    if (nativeBusy()) throw new Error('已有素材正在处理，请完成或取消后重试。');
    const requestId = crypto.randomUUID(); state.videoRequest = requestId; syncNativeBusy(); showDownloadProgress('video', '准备下载，请选择保存位置…');
    try { const result = await request('saveVideo', { requestId, video, filename, requireAudio }); const cancelled = Boolean(result?.canceled || result?.cancelled); finishDownloadProgress('video', cancelled ? '已取消下载。' : '视频已下载并保存。', cancelled); message($('video-status').textContent); }
    catch (error) { finishDownloadProgress('video', error.message, true); throw error; }
    finally { state.videoRequest = null; $('cancel-video').hidden = true; syncNativeBusy(); }
  }
  $('parse-form').addEventListener('submit', event => { event.preventDefault(); void run($('parse'), async () => { const text = $('share').value.trim(); if (!text) throw new Error('请先粘贴笔记链接或分享文案。'); state.clipboardSeen = text; $('clipboard-notice').hidden = true; message('正在解析笔记…'); const result = await request('parse', { text, engine: $('engine').value }); renderNote({ ...(result.note || result), sourceUrl: (result.note || result).sourceUrl || text.match(/https?:\/\/[^\s<>]+/)?.[0] || '' }); }); });
  click('paste', async () => { const result = await request('readClipboard'); $('share').value = typeof result === 'string' ? result : result.text || ''; state.clipboardSeen = $('share').value.trim(); $('clipboard-notice').hidden = true; $('share').focus(); });
  click('copy-content', () => copyText(noteText())); click('export-content', async () => { const { makeNoteTextFileData } = await import('./xhs/lib/archive.js'); const note = state.note; if (!note) throw new Error('请先解析笔记。'); const engine = note.engine === 'python' ? 'Python' : state.hostPlatform === 'android' ? '本地 JavaScript' : 'Node.js'; return download(new Blob([makeNoteTextFileData({ ...note, engine })], { type: 'text/plain;charset=utf-8' }), `${title()}.txt`); });
  click('save-note', () => saveNote()); click('save-images', async () => { const result = await performTransfer('saveImages', { images: selectedImages(), title: title() }, '正在保存所选原图…'); message((result?.canceled || result?.cancelled) ? '已取消保存。' : '所选原图已保存。'); });
  click('export-selected', () => exportArchive('selected')); click('export-images', () => exportArchive('images')); click('export-live', () => exportArchive('live', selectedImages().filter(image => image.liveVideo?.url))); click('cancel-archive', () => request('cancelArchive', { requestId: state.archiveRequest })); click('copy-image-links', () => copyText(selectedImages().map(image => image.url).join('\n')));
  click('invert-selection', () => { state.selected = new Set((state.note?.images || []).map((image, i) => image.index ?? i + 1).filter(index => !state.selected.has(index))); for (const [i, checkbox] of [...$('image-grid').querySelectorAll('input')].entries()) checkbox.checked = state.selected.has(state.note.images[i].index ?? i + 1); renderSelection(); });
  click('share-images', async () => { const result = await performTransfer('shareImages', {images:selectedImages(),title:title()}, '正在准备原图分享…'); message(result?.cancelled || result?.canceled ? '已取消分享。' : '已打开系统分享，请选择接收应用。'); });
  click('copy-images', async () => { const result = await performTransfer('copyImages', { images: selectedImages(), title: title() }, '正在复制所选原图…'); message(result?.cancelled || result?.canceled ? '已取消复制。' : '所选原图已复制。'); }); click('save-live', () => saveNote('live', selectedImages().filter(image => image.liveVideo?.url)));
  $('select-all').addEventListener('change', event => { state.selected = new Set(event.target.checked ? state.note.images.map((image, i) => image.index ?? i + 1) : []); for (const checkbox of $('image-grid').querySelectorAll('input')) checkbox.checked = event.target.checked; renderSelection(); });
  $('video-select').addEventListener('change', renderVideo); click('save-video', () => { const video = videoCandidates()[Number($('video-select').value || 0)]; if (!video) throw new Error('没有可下载的视频。'); const family = video.isOriginal ? state.note.originalVideos || [] : state.note.videos || [], alternatives = family.filter(item => item.url !== video.url && item.hasAudio !== false); const sources = [...new Set([video.url, ...alternatives.map(item => item.url), ...(video.backupUrls || []), ...alternatives.flatMap(item => item.backupUrls || [])].filter(Boolean))].slice(0,20); return saveVideo({ ...video, backupUrls: sources.filter(url => url !== video.url) }, `${title()}${video.isOriginal ? '-原视频' : ''}.mp4`); }); click('cancel-video', () => request('cancelVideo', { requestId: state.videoRequest }));
  click('copy-video-link', () => { const video = videoCandidates()[Number($('video-select').value || 0)]; if (!video?.url) throw new Error('没有可复制的视频链接。'); return copyText(video.url); });
  click('open-video-link', () => { const video = videoCandidates()[Number($('video-select').value || 0)]; if (!video?.url) throw new Error('没有可打开的视频链接。'); return request('openVideo', { url: video.url }); });
  function renderLogin(login = {}) { $('login-status').textContent = login.loggedIn || login.status === 'logged-in' ? `已登录小红书${login.nickname ? ' · ' + login.nickname : ''}` : login.status === 'unknown' ? '暂未确认小红书会话，请打开登录窗口检查。' : '尚未登录小红书；需要时打开登录窗口。'; }
  click('login', async () => { const result = await request('login', { profileUrl: $('profile-url').value.trim() }); if (result) renderLogin(result); });
  click('clear-login', async () => { const result = await request('clearLogin'); if (result?.cancelled || result?.canceled) { message('已取消清除小红书会话。'); return; } renderLogin(result?.loginState || result); if (result?.profileState) renderProfile(result.profileState); message(result?.message || '小红书网页会话已清除。'); });
  click('choose-directory', async () => { const result = await request('chooseDirectory'); const directory = typeof result === 'string' ? result : result?.directory; if (directory) { state.directory = directory; $('directory').textContent = directory; } }); click('open-directory', () => request('openDirectory', { directory: state.directory || undefined }));
  let profileCountdownTimer;
  function updateProfileCountdown() {
    const label = $('profile-countdown'), next = Number(state.profile?.nextRequestAt);
    const active = state.profile?.status === 'waiting' && Number.isFinite(next) && next > 0 && xhsVisible();
    label.hidden = !active;
    if (active) label.textContent = next > Date.now() ? `还需等待 ${Math.ceil((next - Date.now()) / 1000)} 秒` : '即将继续下一次请求…';
    if (!active && profileCountdownTimer) { clearInterval(profileCountdownTimer); profileCountdownTimer = null; }
    if (active && !profileCountdownTimer) profileCountdownTimer = setInterval(updateProfileCountdown,1000);
  }
  function renderProfile(profile = {}) {
    state.profile = profile; updateProfileCountdown(); const desktop = isNative && state.hostPlatform !== 'android'; const active = ['discovering', 'downloading', 'waiting'].includes(profile.status);
    if (profile.directory) { state.directory = profile.directory; $('directory').textContent = profile.directory; }
    if (profile.profileUrl && !state.profileDirty.has('profile-url') && document.activeElement !== $('profile-url')) $('profile-url').value = profile.profileUrl;
    for (const [id, key] of [['interval', 'intervalSeconds'], ['jitter', 'jitterSeconds']]) if (profile[key] !== undefined && !state.profileDirty.has(id) && document.activeElement !== $(id)) $(id).value = String(profile[key]);
    $('profile-status').textContent = labels[profile.status] || profile.status || '尚未开始';
    $('profile-message').textContent = [profile.message, profile.currentTitle, profile.nextRequestAt ? `下一次请求：${new Date(profile.nextRequestAt).toLocaleTimeString('zh-CN')}` : ''].filter(Boolean).join(' · ');
    const items = profile.items || [], failed = profile.failed ?? items.filter(item => item.status === 'failed').length;
    const total = profile.discovered ?? items.length, processed = ['completed','skipped','failed'].reduce((sum, key) => sum + (profile[key] ?? items.filter(item => item.status === key).length), 0);
    $('profile-progress').hidden = !active && !total;
    if (profile.status === 'discovering' || !total) $('profile-progress').removeAttribute('value');
    else $('profile-progress').value = Math.min(profile.status === 'completed' ? 100 : 99, processed / total * 100);
    $('profile-stats').replaceChildren();
    for (const [key, label] of [['discovered', '发现'], ['completed', '完成'], ['skipped', '跳过'], ['failed', '失败']]) { const span = element('span', '', label + ' '); span.append(element('strong', '', String(profile[key] ?? (key === 'discovered' ? items.length : items.filter(item => item.status === key).length)))); $('profile-stats').append(span); }
    $('profile-start').disabled = !desktop || active; $('profile-pause').disabled = !desktop || !active; $('profile-resume').disabled = !desktop || profile.status !== 'paused'; $('profile-cancel').disabled = !desktop || !active && profile.status !== 'paused'; $('profile-retry').disabled = !desktop || active || !failed;
    $('copy-failed').disabled = !failed;
    const filtered = items.map((item,index) => ({...item, sequence:item.sequence || index + 1})).filter(item => state.profileFilter !== 'failed' || item.status === 'failed')
      .sort((a,b) => Number(b.status === 'failed') - Number(a.status === 'failed') || a.sequence - b.sequence);
    const visible = filtered.slice(0,state.profileVisible);
    $('queue-filter').value = state.profileFilter; $('queue-more').hidden = visible.length >= filtered.length;
    $('queue-more').textContent = `显示更多记录（还有 ${Math.max(0,filtered.length - visible.length)} 篇）`;
    const rowsKey = JSON.stringify([active,desktop,visible.map(({id,url,title,status,error,sequence,directoryName})=>[id,url,title,status,error,sequence,directoryName])]);
    if (rowsKey === state.profileRowsKey) return; state.profileRowsKey = rowsKey;
    const scroll = $('profile-items').scrollTop, fragment = document.createDocumentFragment();
    for (const item of visible) {
      const row = element('li'), detail = element('div', 'xhs-queue-detail'); detail.append(element('strong', '', item.title || item.id || '待解析笔记'));
      if (item.directoryName) detail.append(element('small', '', `文件夹：${item.directoryName}`)); if (item.error) detail.append(element('small', '', item.error));
      row.append(element('span', 'xhs-queue-number', String(item.sequence).padStart(3, '0')), detail, element('span', 'xhs-queue-state ' + item.status, labels[item.status] || item.status));
      if (item.status === 'failed') { const actions = element('div', 'xhs-queue-actions'), retry = actionButton('重试', async () => renderProfile(await request('retryItem', { noteId: item.id }))); retry.disabled = !desktop || active;
        actions.append(retry, actionButton('复制链接', () => copyText(failedURL(item)), false), actionButton('转单篇', () => transferToNote(failedURL(item)), false)); row.append(actions); }
      fragment.append(row);
    }
    $('profile-items').replaceChildren(fragment); $('profile-items').scrollTop = scroll;
  }
  $('queue-filter').addEventListener('change', event => { state.profileFilter = event.target.value; state.profileVisible = 100; renderProfile(state.profile || {}); });
  click('queue-more', () => { state.profileVisible += 100; renderProfile(state.profile || {}); });
  function failedURL(item) { return item.url || `https://www.xiaohongshu.com/explore/${item.id}`; }
  function transferToNote(text) { setTab('note'); $('share').value = text; $('share').focus(); $('share').scrollIntoView({ block: 'center', behavior: 'instant' }); message('链接已填入单篇下载，点击“解析笔记”继续。'); }
  click('copy-failed', () => copyText((state.profile?.items || []).filter(item => item.status === 'failed').map(failedURL).join('\n')));
  for (const id of ['profile-url', 'interval', 'jitter']) $(id).addEventListener('input', () => state.profileDirty.add(id));
  $('profile-form').addEventListener('submit', event => { event.preventDefault(); void run($('profile-start'), async () => { if (!state.directory) throw new Error('请先选择保存目录。'); const profile = await request('startProfile', { profileUrl: $('profile-url').value.trim(), directory: state.directory, intervalSeconds: Number($('interval').value), jitterSeconds: Number($('jitter').value) }); state.profileDirty.clear(); state.profileFilter = 'all'; state.profileVisible = 100; state.profileRowsKey = ''; renderProfile(profile); }); });
  for (const [id, action] of [['profile-pause', 'pauseProfile'], ['profile-resume', 'resumeProfile'], ['profile-cancel', 'cancelProfile'], ['profile-retry', 'retryFailed']]) click(id, async () => renderProfile(await request(action)));
  let liveModulePromise;
  const liveModule = () => liveModulePromise ||= import('./xhs/lib/live-photo-maker.js');
  const liveImageEdits = new WeakMap(), liveImageEditPresets = new WeakMap();
  let liveEditorModulePromise, imageEditorController;
  const imageEdits = () => state.files.map(file => liveImageEdits.get(file));
  let supportLoaded = false;
  async function loadLiveSupport() { if (supportLoaded) return; supportLoaded = true; try { const support = await (await liveModule()).checkLivePhotoSupport(); state.liveSupport = support; $('live-support').textContent = support.supported ? `支持本地制作 · ${support.heicSupported ? 'JPG / HEIC' : 'JPG'}${support.audioSupported ? ' · 支持保留声音' : ''}` : support.message; $('live-format').querySelector('[value="heic"]').disabled = !support.heicSupported; if (!support.heicSupported) $('live-format').value = 'jpeg'; syncLiveControls(); } catch (error) { supportLoaded = false; $('live-support').textContent = error.message; } }
  function clearPreview() { state.previewController?.abort(); state.previewController = null; cancelAnimationFrame(state.previewTimer); state.previewTimer = null; $('live-preview-video').pause(); $('live-preview-video').removeAttribute('src'); $('live-preview-video').hidden = true; $('live-preview-image').hidden = true; $('live-preview-canvas').hidden = true; $('live-preview-image').style.transform = ''; for (const url of state.previewUrls) URL.revokeObjectURL(url); state.previewUrls = []; $('live-preview-empty').hidden = false; }
  function objectURL(blob) { const url = URL.createObjectURL(blob); state.previewUrls.push(url); return url; }
  function invalidateLive() { state.liveResult = null; $('live-result').hidden = true; clearPreview(); $('live-status').textContent = ''; }
  function liveOptions() { return { start: state.fileInfo?.kind === 'video' ? Number($('live-start').value) : 0, duration: Number($('live-duration').value), keyPhotoTime: Number($('live-cover').value), speed: state.fileInfo?.kind === 'video' ? Number($('live-speed').value) : 1, motion: $('live-motion').value, imageEdits: imageEdits(), includeAudio: state.fileInfo?.kind === 'video' && state.liveSupport?.audioSupported === true && $('live-audio').checked && Number($('live-speed').value) === 1, photoFormat: $('live-format').value }; }
  function syncLiveControls() {
    const busy = state.liveBusy, video = state.fileInfo?.kind === 'video';
    if (state.liveSupport) $('live-format').querySelector('[value="heic"]').disabled = !state.liveSupport.heicSupported;
    $('live-start').disabled = busy || !video; $('live-speed').disabled = busy || !video; $('live-motion').disabled = busy || video;
    $('live-audio').disabled = busy || !video || state.liveSupport?.audioSupported !== true || Number($('live-speed').value) !== 1;
    $('live-generate').disabled = busy || !state.fileInfo || !state.files.length || state.liveSupport?.supported !== true;
    $('live-preview').disabled = busy || !state.fileInfo || !state.files.length;
  }
  async function editLiveImage(file) {
    if (state.liveBusy || state.fileInfo?.kind !== 'images') return;
    imageEditorController?.abort(); const controller = new AbortController(); imageEditorController = controller;
    const revision = state.fileRevision; let batchBusy = false;
    try {
      const module = await (liveEditorModulePromise ||= import('./xhs/lib/live-photo-editor.js'));
      if (controller.signal.aborted || revision !== state.fileRevision) return;
      const result = await module.openLivePhotoImageEditor({ file, edit: liveImageEdits.get(file), preset: liveImageEditPresets.get(file), signal: controller.signal });
      if (!result || controller.signal.aborted || revision !== state.fileRevision || !state.files.includes(file)) return;
      let prepared;
      if (result.all) {
        batchBusy = true; setLiveBusy(true);
        prepared = await module.prepareLivePhotoImageEdits([...state.files], result.edit, result.aspectRatio, { signal: controller.signal,
          onProgress: (index, count) => { $('live-status').textContent = `正在统一调整图片 ${index} / ${count}…`; } });
      } else prepared = [[file, result.edit]];
      if (controller.signal.aborted || revision !== state.fileRevision) return;
      const meaningful = edit => edit.crop.x !== 0 || edit.crop.y !== 0 || edit.crop.width !== 1 || edit.crop.height !== 1
        || edit.rotation !== 0 || edit.flipX || edit.flipY || edit.brightness !== 1 || edit.contrast !== 1 || edit.saturation !== 1;
      for (const [target, edit] of prepared) {
        if (meaningful(edit)) liveImageEdits.set(target, edit);
        else liveImageEdits.delete(target);
        if (result.preset && result.preset !== 'free') liveImageEditPresets.set(target, result.preset);
        else liveImageEditPresets.delete(target);
      }
      invalidateLive(); renderFiles();
      $('live-status').textContent = result.all ? `已将裁切与调整应用到全部 ${state.files.length} 张图片，原文件保留。` : `已保存 ${file.name} 的裁切与调整，原文件保留。`;
    } catch (error) {
      if (controller.signal.aborted) { if (batchBusy && revision === state.fileRevision) $('live-status').textContent = '统一调整已取消，没有保存本次修改。'; }
      else throw error;
    } finally { if (imageEditorController === controller) { imageEditorController = null; if (batchBusy && revision === state.fileRevision) setLiveBusy(false); } }
  }
  function renderFiles() {
    $('live-file-list').replaceChildren();
    state.files.forEach((file, index) => {
      const li = element('li');
      li.append(element('span', '', `${index + 1}. ${file.name} · ${(file.size / 1048576).toFixed(1)} MB${liveImageEdits.has(file) ? ' · 已编辑' : ''}`));
      if (state.fileInfo?.kind === 'images') {
        const edit = element('button', 'xhs-file-edit', '编辑'); edit.type = 'button'; edit.setAttribute('aria-label', `编辑 ${file.name}`);
        edit.disabled = state.liveBusy; edit.addEventListener('click', () => { void run(edit, () => editLiveImage(file)); }); li.append(edit);
      }
      for (const [label, shift] of [['↑', -1], ['↓', 1]]) {
        const button = element('button', '', label); button.type = 'button'; button.setAttribute('aria-label', `将 ${file.name} ${shift < 0 ? '上移' : '下移'}`);
        button.disabled = state.liveBusy || index + shift < 0 || index + shift >= state.files.length;
        button.addEventListener('click', () => { const files = [...state.files]; [files[index], files[index + shift]] = [files[index + shift], files[index]]; selectLiveFiles(files, true); }); li.append(button);
      }
      const remove = element('button', '', '移除'); remove.type = 'button'; remove.setAttribute('aria-label', `移除 ${file.name}`); remove.disabled = state.liveBusy;
      remove.addEventListener('click', () => selectLiveFiles(state.files.filter((_, position) => position !== index))); li.append(remove);
      $('live-file-list').append(li);
    });
  }
  const compressedLiveFiles = new WeakSet();
  function confirmLiveCompression(info, count, signal, limits) {
    signal.throwIfAborted();
    const dialog = $('live-compress-dialog');
    const reasons = [];
    if (info.pixels > limits.maxDecodedPixels) reasons.push(`总像素约 ${(info.pixels / 10000).toLocaleString('zh-CN', { maximumFractionDigits: 0 })} 万，超过 ${limits.maxDecodedPixels / 10000} 万`);
    if (info.bytes > limits.maxBytes) reasons.push(`总大小 ${(info.bytes / 1048576).toFixed(1)} MB，超过 ${limits.maxBytes / 1048576} MB`);
    $('live-compress-description').textContent = `所选 ${count} 张图片${reasons.join('；')}。是否压缩后继续导入？`;
    return new Promise(resolve => {
      const finish = accepted => {
        dialog.removeEventListener('close', closed); signal.removeEventListener('abort', canceled);
        $('live-compress-confirm').removeEventListener('click', confirmed); $('live-compress-cancel').removeEventListener('click', canceled);
        if (dialog.open) dialog.close();
        resolve(accepted && !signal.aborted);
      };
      const closed = () => finish(false), canceled = () => finish(false), confirmed = () => finish(true);
      dialog.addEventListener('close', closed, { once: true }); signal.addEventListener('abort', canceled, { once: true });
      $('live-compress-confirm').addEventListener('click', confirmed); $('live-compress-cancel').addEventListener('click', canceled);
      dialog.showModal();
    });
  }
  function selectLiveFiles(files, preserveOptions = false) {
    const revision = ++state.fileRevision;
    imageEditorController?.abort(); imageEditorController = null;
    state.fileController?.abort(); state.liveController?.abort();
    invalidateLive(); message(''); $('live-progress').hidden = true; state.files = []; state.fileInfo = null; renderFiles();
    if (!files.length) { $('live-source-info').textContent = '素材留在你的设备上。'; setLiveBusy(false); return; }
    const controller = new AbortController(); state.fileController = controller; setLiveBusy(true);
    $('live-source-info').textContent = '正在读取所选素材…';
    void (async () => {
      try {
        const module = await liveModule(); controller.signal.throwIfAborted();
        let info = await module.inspectLivePhotoFiles(files, { signal: controller.signal, allowOversizedImages: true });
        controller.signal.throwIfAborted();
        if (info.requiresCompression) {
          $('live-source-info').textContent = '图片较大，等待确认压缩导入。';
          const accepted = await confirmLiveCompression(info, files.length, controller.signal, module.LIVE_PHOTO_LIMITS);
          controller.signal.throwIfAborted();
          if (!accepted) { $('live-source-info').textContent = '已取消导入，可重新选择图片。'; return; }
          $('live-progress').hidden = false; $('live-progress').value = 0;
          files = await module.compressLivePhotoFiles(files, { signal: controller.signal, onProgress: progress => {
            if (revision === state.fileRevision && !controller.signal.aborted) { $('live-progress').value = progress.progress * 100; $('live-source-info').textContent = progress.message; }
          } });
          files.forEach(file => compressedLiveFiles.add(file));
          info = await module.inspectLivePhotoFiles(files, { signal: controller.signal });
        }
        if (revision !== state.fileRevision || controller.signal.aborted) return;
        if (info.kind === 'video' && info.duration < .5) throw new Error('视频至少需要 0.5 秒，请选择更长的片段。');
        state.files = files; state.fileInfo = info;
        $('live-source-info').textContent = `${info.kind === 'video' ? `视频 · ${info.duration.toFixed(2)} 秒` : `${files.length} 张图片`} · ${info.width} × ${info.height}${files.some(file => compressedLiveFiles.has(file)) ? ' · 已压缩导入，原文件保留' : ' · 原始分辨率'}`;
        if (!preserveOptions) { const duration = info.kind === 'video' ? Math.min(3, Math.floor(info.duration * 100) / 100) : 3;
          $('live-duration').value = String(duration); $('live-start').value = '0'; $('live-speed').value = '1'; $('live-cover').value = String(duration / 2);
          $('live-motion').value = 'zoom'; $('live-audio').checked = info.hasAudio !== false; }
        renderFiles(); await loadLiveSupport();
      } catch (error) {
        if (revision !== state.fileRevision) return;
        $('live-source-info').textContent = controller.signal.aborted ? '素材读取已取消，请重新选择。' : '素材读取失败，请重新选择。';
        if (!controller.signal.aborted) message(error.message, true);
      } finally {
        if (state.fileController === controller) { state.fileController = null; if (!state.files.length) $('live-files').value = ''; $('live-progress').hidden = true; setLiveBusy(false); }
      }
    })();
  }
  $('live-files').addEventListener('change', event => selectLiveFiles([...event.target.files]));
  const fileDrop = document.querySelector('[for="xhs-live-files"]');
  for (const type of ['dragenter','dragover']) fileDrop.addEventListener(type, event => { event.preventDefault(); event.stopPropagation(); });
  fileDrop.addEventListener('drop', event => { event.preventDefault(); event.stopPropagation(); if (state.liveBusy) return; $('live-files').value = ''; selectLiveFiles([...event.dataTransfer.files]); });
  for (const id of ['live-start', 'live-duration', 'live-cover', 'live-speed', 'live-motion', 'live-audio', 'live-format']) $(id).addEventListener('change', () => { invalidateLive(); if (id === 'live-duration') { const duration = Number($('live-duration').value); if (Number($('live-cover').value) >= duration) $('live-cover').value = String(duration / 2); } syncLiveControls(); });
  function assertLiveFiles() { if (!state.files.length || !state.fileInfo) throw new Error('请先选择图片或视频素材。'); }
  async function previewLive() {
    assertLiveFiles(); const module = await liveModule(), raw = liveOptions();
    const options = { ...raw, ...module.normalizeLivePhotoOptions({ ...raw, kind: state.fileInfo.kind, sourceDuration: state.fileInfo.duration }) };
    clearPreview(); const controller = new AbortController(); state.previewController = controller; $('live-preview-empty').hidden = true;
    if (state.fileInfo.kind === 'video') {
      const video = $('live-preview-video'); video.hidden = false; video.playbackRate = options.speed; video.muted = !options.includeAudio;
      const ready = await new Promise((resolve, reject) => {
        const done = value => { cleanup(); resolve(value); }, failed = () => { cleanup(); reject(new Error('无法预览此视频。')); }, aborted = () => done(false);
        const timer = setTimeout(failed,15000); const cleanup = () => { clearTimeout(timer); video.removeEventListener('loadedmetadata', loaded); video.removeEventListener('error', failed); controller.signal.removeEventListener('abort',aborted); }, loaded = () => done(true);
        video.addEventListener('loadedmetadata',loaded,{once:true}); video.addEventListener('error',failed,{once:true}); controller.signal.addEventListener('abort',aborted,{once:true}); video.src = objectURL(state.files[0]);
      });
      if (!ready || controller.signal.aborted) return;
      // Loading a new source restores the browser's default rate. Apply the
      // selected speed after metadata, immediately before playback begins.
      video.playbackRate = options.speed; video.currentTime = options.start;
      try { await video.play(); } catch (error) { if (controller.signal.aborted) return; throw error; }
      const tick = () => { if (controller.signal.aborted) return; if (video.currentTime >= options.start + options.duration * options.speed) { video.pause(); video.currentTime = options.start + options.keyPhotoTime * options.speed; } else if (!video.paused) state.previewTimer = requestAnimationFrame(tick); }; state.previewTimer = requestAnimationFrame(tick);
    } else {
      let images; try { images = await Promise.all(state.files.map(file => new Promise((resolve,reject) => {
        const image = new Image(), cleanup = () => { image.onload = image.onerror = null; controller.signal.removeEventListener('abort',aborted); };
        const aborted = () => { cleanup(); image.src = ''; reject(controller.signal.reason || new DOMException('预览已取消。','AbortError')); };
        image.onload = () => { cleanup(); resolve(image); }; image.onerror = () => { cleanup(); reject(new Error('图片预览读取失败。')); }; controller.signal.addEventListener('abort',aborted,{once:true}); image.src = objectURL(file);
      }))); } catch (error) { if (controller.signal.aborted) return; throw error; }
      if (controller.signal.aborted) return;
      const canvas = $('live-preview-canvas'), context = canvas.getContext('2d'); canvas.hidden = false;
      const begin = performance.now(), tick = () => {
        if (controller.signal.aborted) return;
        const elapsed = Math.min(options.duration, (performance.now() - begin) / 1000);
        module.drawLivePhotoImageFrame(context, images, { time: elapsed < options.duration ? elapsed : options.keyPhotoTime, duration: options.duration, motion: options.motion, imageEdits: options.imageEdits });
        if (elapsed < options.duration) state.previewTimer = requestAnimationFrame(tick);
      }; tick();
    }
    $('live-status').textContent = '正在预览所选片段；生成后可检查最终实况与封面。';
  }
  click('live-preview', previewLive);
  function setLiveBusy(busy) {
    state.liveBusy = busy;
    for (const control of document.querySelectorAll('#xhs-panel-live input,#xhs-panel-live select,#xhs-live-file-list button')) control.disabled = busy;
    $('live-cancel').hidden = !busy;
    if (!busy) renderFiles();
    syncLiveControls();
  }
  async function liveCoverPreview(result, signal) {
    signal.throwIfAborted();
    return result.photoPreviewBlob;
  }
  click('live-generate', async () => {
    assertLiveFiles(); invalidateLive();
    const controller = new AbortController(), revision = state.fileRevision, files = [...state.files], options = liveOptions();
    state.liveController = controller; setLiveBusy(true); $('live-progress').hidden = false; $('live-progress').value = 0;
    const current = () => { controller.signal.throwIfAborted(); if (revision !== state.fileRevision || state.liveController !== controller) throw new DOMException('素材已变更。', 'AbortError'); };
    try {
      const module = await liveModule(); current();
      const result = await module.createLivePhoto({ files, ...options, signal: controller.signal, onProgress: progress => { if (!controller.signal.aborted && revision === state.fileRevision) { $('live-progress').value = progress.progress * 100; $('live-status').textContent = progress.message; } } });
      current(); let cover;
      try { cover = await liveCoverPreview(result, controller.signal); }
      catch (error) { current(); /* A preview codec failure does not change the exported original. */ }
      current(); clearPreview();
      $('live-preview-empty').hidden = true; $('live-preview-video').hidden = false; $('live-preview-video').defaultPlaybackRate = 1; $('live-preview-video').playbackRate = 1; $('live-preview-video').src = objectURL(result.previewBlob);
      if (cover) { $('live-preview-image').src = objectURL(cover); $('live-preview-image').hidden = false; }
      $('live-preview-image').alt = `实况封面 · ${result.keyPhotoTime.toFixed(2)} 秒`;
      state.liveResult = result; $('live-result').hidden = false;
      $('live-result-info').textContent = `${result.duration} 秒 · ${result.photoExtension} + MOV · 照片 ${result.photoWidth} × ${result.photoHeight} · 动态 ${result.width} × ${result.height} · 高画质${result.hasAudio ? ' · 保留声音' : ''}`;
      $('live-status').textContent = '实况已生成，照片与 MOV 已写入相同配对标识。';
    } catch (error) {
      if (revision !== state.fileRevision) return;
      state.liveResult = null; $('live-result').hidden = true;
      $('live-status').textContent = controller.signal.aborted ? '制作已取消，可以修改设置后重新生成。' : error.message;
      if (!controller.signal.aborted && error.name !== 'AbortError') throw error;
    } finally { if (state.liveController === controller) { state.liveController = null; if (!state.fileController) setLiveBusy(false); } }
  });
  click('live-cancel', () => { state.liveController?.abort(); state.fileController?.abort(); imageEditorController?.abort(); });
  function resultRequired() { if (!state.liveResult) throw new Error('请先生成实况。'); return state.liveResult; }
  click('live-export-package', async () => { const { makeLivePhotoPackage } = await import('./xhs/lib/live-photo-package.js'), pack = makeLivePhotoPackage(resultRequired()); return download(pack.zip, `${pack.stem}.zip`); });
  click('live-export-pair', async () => { const result = resultRequired(), { makeZipBlob } = await import('./xhs/lib/archive.js'), stem = `Brclio-Live-${result.assetIdentifier}`; return download(makeZipBlob([{ name: `${stem}.${result.photoExtension}`, data: result.photo }, { name: `${stem}.MOV`, data: result.mov }]), `${stem}-配对文件.zip`); });
  click('live-export-photo', () => { const result = resultRequired(); return download(new Blob([result.photo], { type: result.photoMimeType }), `Brclio-Live-${result.assetIdentifier}.${result.photoExtension}`); });
  click('live-export-mov', () => { const result = resultRequired(); return download(new Blob([result.mov], { type: 'video/quicktime' }), `Brclio-Live-${result.assetIdentifier}.MOV`); });
  function nativeProgressPercent(value, batch = false) {
    let percent;
    if (Number.isFinite(value.percent)) percent = value.percent;
    else if (Number.isFinite(value.progress)) percent = value.progress <= 1 ? value.progress * 100 : value.progress;
    else if (Number.isFinite(value.totalBytes) && value.totalBytes > 0 && (!batch || !(value.total > 1))) {
      const received = value.loadedBytes ?? value.receivedBytes;
      if (Number.isFinite(received) && received >= 0) percent = received / value.totalBytes * 100;
    }
    // completed/total may describe the active item; they do not prove a batch
    // byte ratio. 100% is published only after the native operation succeeds.
    return Number.isFinite(percent) ? Math.max(0, Math.min(99, percent)) : null;
  }
  function applyNativeProgress(progress, percent) {
    if (percent === null) progress.removeAttribute('value'); else progress.value = percent;
  }
  function readableBytes(value) {
    if (value < 1024) return `${value} B`;
    if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1073741824) return `${(value / 1048576).toFixed(1)} MB`;
    return `${(value / 1073741824).toFixed(2)} GB`;
  }
  function updateDownloadProgress(kind, value, batch = false) {
    const percent = nativeProgressPercent(value, batch), parts = [];
    applyNativeProgress($(kind + '-progress'), percent);
    if (percent !== null) parts.push(`${percent.toFixed(1)}%`);
    if (value.total > 1) parts.push(`已完成 ${value.completed || 0} / ${value.total} 个素材`);
    const received = value.receivedBytes ?? value.loadedBytes;
    if (Number.isFinite(received) && received >= 0) parts.push(`已接收 ${readableBytes(received)}${value.totalBytes > 0 && !(batch && value.total > 1) ? ' / ' + readableBytes(value.totalBytes) : ''}`);
    const phase = value.phase || value.stage;
    if (phase === 'archiving') parts.push('正在打包 ZIP');
    else if (['verifying','validating','saving','saved'].includes(phase)) parts.push('正在校验并保存');
    else if (percent === null && Number.isFinite(received)) parts.push('等待总大小');
    $('download-detail').textContent = parts.join(' · ');
  }
  host?.onXhsEvent?.(event => {
    const value = event.state || event;
    if (event.type === 'profile') renderProfile(value); if (event.type === 'login') renderLogin(value);
    if (event.type === 'video' && state.videoRequest && (!value.requestId || value.requestId === state.videoRequest)) { updateDownloadProgress('video', value); const percent = nativeProgressPercent(value); $('video-status').textContent = value.message || (percent === null ? `下载中 · 已接收 ${value.receivedBytes ?? value.loadedBytes ?? 0} 字节` : `下载中 · ${percent.toFixed(1)}%`); }
    if (event.type === 'archive' && state.archiveRequest && (!value.requestId || value.requestId === state.archiveRequest)) { updateDownloadProgress('archive', value, true); $('archive-status').textContent = value.message || (value.phase === 'archiving' || value.stage === 'archiving' ? '素材已下载，正在打包 ZIP…' : '正在下载 ZIP 素材…'); }
    if (['transfer','clipboard'].includes(event.type) && state.transferRequest && (!value.requestId || value.requestId === state.transferRequest)) {
      updateDownloadProgress('transfer', value, true);
      $('transfer-status').textContent = value.message || `正在处理素材 · ${value.completed || 0} / ${value.total || 0} · ${value.receivedBytes ?? value.loadedBytes ?? 0} 字节`;
    }
  });
  const engineStore = 'brclio.xhs.parse-engine.v1';
  try { const saved = localStorage.getItem(engineStore); if (saved === 'node' || saved === 'python') $('engine').value = saved; } catch { /* Local parser preference is optional. */ }
  $('engine').addEventListener('change', () => { try { localStorage.setItem(engineStore, $('engine').value); } catch { /* Local parser preference is optional. */ } });
  const clipboardStore = 'brclio.xhs.clipboard-detection.v1';
  try { $('watch-clipboard').checked = localStorage.getItem(clipboardStore) === 'true'; } catch { /* Optional local preference. */ }
  function xhsVisible() { return !document.getElementById('view-xhs').hidden && !document.hidden; }
  async function checkClipboard() {
    if (!isNative || !xhsVisible() || !$('watch-clipboard').checked || state.clipboardChecking) return;
    state.clipboardChecking = true;
    try {
      const result = await request('readClipboard'); if (!xhsVisible() || !$('watch-clipboard').checked) return;
      const text = (typeof result === 'string' ? result : result?.text || '').trim().slice(0, 20000);
      if (!text || text === state.clipboardSeen || text === $('share').value.trim()) return;
      state.clipboardSeen = text;
      if (!/https?:\/\/(?:(?:www\.)?xiaohongshu\.com\/(?:explore|discovery\/item)\/|(?:www\.)?xhslink\.(?:com|cn)\/)/i.test(text)) return;
      state.clipboardPending = text; $('clipboard-text').textContent = text.length > 140 ? text.slice(0, 140) + '…' : text; $('clipboard-notice').hidden = false;
    } catch { /* A failed optional clipboard check must not disrupt the current task. */ }
    finally { state.clipboardChecking = false; }
  }
  $('watch-clipboard').disabled = !isNative;
  $('watch-clipboard').addEventListener('change', () => { try { localStorage.setItem(clipboardStore, String($('watch-clipboard').checked)); } catch { /* Optional local preference. */ } if ($('watch-clipboard').checked) void checkClipboard(); else { $('clipboard-notice').hidden = true; state.clipboardPending = ''; } });
  click('use-clipboard', () => { if (state.clipboardPending) transferToNote(state.clipboardPending); $('clipboard-notice').hidden = true; state.clipboardPending = ''; });
  click('dismiss-clipboard', () => { $('clipboard-notice').hidden = true; state.clipboardPending = ''; });
  window.addEventListener('focus', () => { void checkClipboard(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void checkClipboard(); updateProfileCountdown(); });
  async function refreshNativeState() { await platformReady; if (!isNative || state.hostPlatform === 'android') return; const results = await Promise.allSettled([request('loginState'), request('profileState')]); if (results[0].status === 'fulfilled') renderLogin(results[0].value); if (results[1].status === 'fulfilled') renderProfile(results[1].value); }
  window.addEventListener('brclio:view', event => { if (event.detail?.name === 'xhs') { void refreshNativeState(); void checkClipboard(); updateProfileCountdown(); } else { $('video-preview').pause(); $('live-preview-video').pause(); cancelAnimationFrame(state.previewTimer); updateProfileCountdown(); } });
  window.addEventListener('beforeunload', () => { state.liveController?.abort(); state.fileController?.abort(); imageEditorController?.abort(); clearInterval(profileCountdownTimer); clearPreview(); });
  const platformReady = Promise.resolve(host?.getPlatform?.()).then(info => {
    state.hostPlatform = info?.platform || 'browser';
    if (state.hostPlatform === 'android') {
      $('availability').hidden = false; $('availability').textContent = '安卓支持单篇下载和本地实况合成；Python 备用解析会连接公开解析服务。主页批量下载在桌面客户端中使用。';
      $('tab-profile').disabled = true; $('tab-profile').title = '请在桌面客户端使用主页批量下载';
      const python = $('engine').querySelector('[value="python"]'); python.disabled = false; python.textContent = 'Python（备用在线）'; $('engine').querySelector('[value="node"]').textContent = '本地解析'; renderSelection();
      renderProfile(state.profile || {status:'idle',items:[]});
    }
  }).catch(() => {});
  window.addEventListener('brclio:xhs-share', event => { const text = event.detail?.text; if (typeof text !== 'string' || !text.trim()) return; window.dispatchEvent(new CustomEvent('brclio:navigate', {detail:{name:'xhs'}})); transferToNote(text.trim().slice(0,20000)); });
  $('availability').hidden = isNative; if (!isNative) { for (const button of document.querySelectorAll('[data-xhs-native]')) button.disabled = true; $('login-status').textContent = '小红书网页会话在桌面客户端中管理。'; }
  renderProfile({ status: 'idle', message: '选择目录并粘贴主页链接，开始保存。', items: [] }); syncLiveControls(); syncNativeBusy();
})();

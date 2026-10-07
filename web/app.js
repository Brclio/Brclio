(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const engine = window.BrclioPath;
  const host = window.BrclioHost;
  // Wait for persisted preferences before allowing an edit or clipboard action.
  document.body.inert = true;
  const samples = {
    darwin: { path: '/Users/brclio/Documents/我的项目/项目说明.md', name: '项目说明.md', kind: 'file' },
    win32: { path: 'C:\\Users\\Brclio\\Documents\\我的项目\\项目说明.md', name: '项目说明.md', kind: 'file' },
    android: { path: '/storage/emulated/0/Documents/我的项目/项目说明.md', name: '项目说明.md', kind: 'file' },
  };
  const platformNames = { darwin: 'macOS 客户端', win32: 'Windows 客户端', android: 'Android 客户端', browser: '浏览器预览', linux: 'Linux 客户端' };
  const viewNames = { copy: '复制路径', tools: '全部工具', settings: '通用设置' };
  let settings = { ...engine.DEFAULT_SETTINGS };
  let platform = { platform: 'browser', capabilities: {} };
  let integration = { installed: false, supported: false };
  let selectedPaths = [];
  let samplePlatform = 'darwin';
  let output = '';
  let toastTimer;
  let saveQueue = Promise.resolve();
  let changes = 0;

  function toast(message, error = false) {
    clearTimeout(toastTimer);
    $('#toast span').textContent = message;
    $('#toast').classList.toggle('error', error);
    $('#toast').hidden = false;
    toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 6000 : 3000);
  }
  function setSaveStatus(message, failed = false) {
    $('#save-status span').textContent = message;
    $('#save-status').classList.toggle('error', failed);
  }
  function savePreferences() {
    const snapshot = { ...settings };
    const revision = ++changes;
    setSaveStatus('正在保存…');
    saveQueue = saveQueue.catch(() => {}).then(() => host.saveSettings(snapshot)).then(() => {
      if (revision === changes) setSaveStatus('设置已保存');
    }).catch(error => { if (revision === changes) { setSaveStatus('保存失败', true); toast(error.message, true); } });
  }
  function applyControls() {
    $$('input[name="pathMode"]').forEach(input => { input.checked = input.value === settings.pathMode; });
    $$('input[name="separator"]').forEach(input => { input.checked = input.value === settings.separator; });
    $('#base-path').value = settings.basePath;
    $('#quote-mode').value = settings.quoteMode;
    $('#join-with').value = settings.joinWith;
    $('#trailing-slash').checked = settings.trailingSlash;
    $('#launch-at-login').checked = settings.launchAtLogin;
    updatePreview();
  }
  function pathsForPreview() { return selectedPaths.length ? selectedPaths : [samples[samplePlatform]]; }
  function updatePreview() {
    $('#base-path-field').hidden = settings.pathMode !== 'relative';
    $('#path-mode-hint').textContent = settings.pathMode === 'relative' ? '从你指定的基准文件夹出发，路径更简洁。' : '无论文件在哪里，都能准确找到它。';
    const entries = pathsForPreview();
    const first = entries[0];
    $('#source-tag').textContent = selectedPaths.length ? '已选路径' : '示例路径';
    $('#sample-name').textContent = first.name || first.path.split(/[\\/]/).pop() || first.path;
    $('#sample-name').title = first.path;
    $('#sample-count').textContent = entries.length > 1 ? `${entries.length} 个项目` : first.kind === 'directory' ? '1 个文件夹' : '1 个文件';
    $('#preview-mode-tag').textContent = settings.pathMode === 'relative' ? '相对路径' : '绝对路径';
    $('#preview-quote-tag').textContent = { none: '无引号', double: '双引号', single: '单引号', auto: '自动引号' }[settings.quoteMode];
    $('#preview-separator-tag').textContent = { native: '系统分隔符', forward: '正斜线 /', backward: '反斜线 \\' }[settings.separator];
    $('#copy-preview').innerHTML = '<svg class="icon"><use href="#i-copy"/></svg>' + (selectedPaths.length ? '复制所选路径' : '复制预览路径');
    $('#preview-footnote').textContent = selectedPaths.length ? entries.some(item => item.isUri) ? '来源提供内容 URI，已保留原始地址。' : '只复制位置，不会读取或移动文件。' : '这是一条示例路径，可放心试试。';
    $('#sample-platforms').hidden = selectedPaths.length > 0;
    $('#clear-paths').hidden = selectedPaths.length === 0 && !$('#manual-paths').value;
    try {
      output = engine.formatPaths(entries, settings);
      $('#path-preview').textContent = output;
      $('#path-preview').hidden = false;
      $('#preview-error').hidden = true;
      $('#copy-preview').disabled = false;
    } catch (error) {
      output = '';
      $('#path-preview').textContent = '';
      $('#path-preview').hidden = true;
      $('#preview-error').textContent = error.message;
      $('#preview-error').hidden = false;
      $('#copy-preview').disabled = true;
    }
  }
  async function copyOutput() {
    if (!output) return;
    try { await host.copyText(output); toast(selectedPaths.length ? `已复制 ${selectedPaths.length} 条路径` : '示例路径已复制'); }
    catch (error) { toast(error.message, true); }
  }
  function acceptPaths(paths, label = '已选择') {
    if (!Array.isArray(paths) || paths.length === 0) return;
    selectedPaths = paths.filter(item => item && typeof item.path === 'string');
    $('#manual-paths').value = selectedPaths.map(item => item.path).join('\n');
    $('#selection-status').textContent = `${label} ${selectedPaths.length} 个项目，复制格式与上方设置一致。`;
    setView('copy');
    updatePreview();
  }
  async function pick(kind) {
    try {
      const paths = await host.pickPaths({ kind });
      if (!paths?.length) return;
      if (kind === 'base') {
        if (paths[0].isUri) throw new Error('此文件夹仅提供内容 URI，无法作为相对路径的基准。请选本机存储中的文件夹。');
        settings.basePath = paths[0].path;
        $('#base-path').value = settings.basePath;
        updatePreview(); savePreferences();
      } else acceptPaths(paths);
    } catch (error) { toast(error.message, true); }
  }
  function setView(name) {
    if (!viewNames[name]) name = 'copy';
    $$('.view').forEach(view => { const active = view.id === 'view-' + name; view.hidden = !active; view.classList.toggle('active', active); });
    $$('.nav-item[data-view]').forEach(item => { item.classList.toggle('active', item.dataset.view === name); if (item.dataset.view === name) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); });
    $('#breadcrumb-current').textContent = viewNames[name];
    document.title = `Brclio · ${viewNames[name]}`;
  }
  function showDialog(id) { const dialog = $('#' + id); if (!dialog.open) dialog.showModal(); }
  function refreshIntegration() {
    const available = integration.supported && platform.capabilities?.systemIntegration;
    if (available) {
      $('#integration-title').textContent = integration.installed ? '右键菜单已启用，随时复制。' : '让复制路径，出现在右键菜单里';
      $('#integration-description').textContent = integration.description || '在文件或文件夹上右键，按照你的偏好复制路径。';
      $('#integration-button').innerHTML = (integration.installed ? '停用右键菜单' : integration.stale ? '修复右键菜单' : '启用右键菜单') + '<svg class="icon"><use href="#i-arrow"/></svg>';
    } else if (platform.platform === 'android') {
      $('#integration-title').textContent = '选中文件，或从文件管理器分享进来';
      $('#integration-description').textContent = '通过“分享 → Brclio”导入路径，长按预览也可以复制。';
      $('#integration-button').innerHTML = '选择文件 <svg class="icon"><use href="#i-arrow"/></svg>';
    } else {
      $('#integration-title').textContent = '在客户端，给右键菜单加一点顺手';
      $('#integration-description').textContent = '当前为浏览器预览。你可以修改格式、粘贴路径并直接复制。';
      $('#integration-button').innerHTML = '了解系统入口 <svg class="icon"><use href="#i-arrow"/></svg>';
    }
  }
  function manualEntries() {
    const lines = $('#manual-paths').value.split(/\r?\n/).filter(line => line.length > 0);
    return lines.map(line => {
      // Pasted Explorer/Finder paths may already be wrapped in a matching quote.
      const path = /^(["']).*\1$/.test(line) ? line.slice(1, -1) : line;
      const previous = selectedPaths.find(item => item.path === path);
      return previous || { path, kind: /[\\/]$/.test(path) ? 'directory' : 'file', isUri: /^content:\/\//.test(path) };
    });
  }
  $$('[data-view]').forEach(button => button.addEventListener('click', () => { setView(button.dataset.view); }));
  $('.brand').addEventListener('click', event => { event.preventDefault(); setView('copy'); });
  $$('input[name="pathMode"],input[name="separator"]').forEach(input => input.addEventListener('change', () => { settings[input.name] = input.value; updatePreview(); savePreferences(); }));
  $('#base-path').addEventListener('input', event => { settings.basePath = event.target.value; updatePreview(); savePreferences(); });
  [['quote-mode', 'quoteMode'], ['join-with', 'joinWith']].forEach(([id, key]) => $('#' + id).addEventListener('change', event => { settings[key] = event.target.value; updatePreview(); savePreferences(); }));
  [['trailing-slash', 'trailingSlash'], ['launch-at-login', 'launchAtLogin']].forEach(([id, key]) => $('#' + id).addEventListener('change', event => { settings[key] = event.target.checked; updatePreview(); savePreferences(); }));
  $('#reset-settings').addEventListener('click', () => { settings = { ...engine.DEFAULT_SETTINGS, launchAtLogin: settings.launchAtLogin }; applyControls(); savePreferences(); toast('已恢复默认复制偏好'); });
  $$('[data-sample]').forEach(button => button.addEventListener('click', () => { samplePlatform = button.dataset.sample; $$('[data-sample]').forEach(item => item.classList.toggle('active', item === button)); updatePreview(); }));
  $('#copy-preview').addEventListener('click', copyOutput);
  $('#path-preview').addEventListener('contextmenu', event => { event.preventDefault(); clearTimeout(longPress); copyOutput(); });
  $('#pick-files').addEventListener('click', () => pick('file'));
  $('#pick-folders').addEventListener('click', () => pick('directory'));
  $('#pick-base').addEventListener('click', () => pick('base'));
  $('#manual-paths').addEventListener('input', () => {
    selectedPaths = manualEntries();
    $('#selection-status').textContent = selectedPaths.length ? `已输入 ${selectedPaths.length} 条路径。` : '路径只在本机处理，不会上传。';
    updatePreview();
  });
  $('#copy-manual').addEventListener('click', async () => {
    selectedPaths = manualEntries();
    if (!selectedPaths.length) { toast('请先选择文件或粘贴完整路径。', true); $('#manual-paths').focus(); return; }
    updatePreview();
    if (!output) { toast($('#preview-error').textContent, true); return; }
    await copyOutput();
  });
  $('#clear-paths').addEventListener('click', () => { selectedPaths = []; $('#manual-paths').value = ''; $('#selection-status').textContent = '路径只在本机处理，不会上传。'; updatePreview(); });
  $('#integration-button').addEventListener('click', async () => {
    if (platform.platform === 'android') { await pick('file'); return; }
    if (!platform.capabilities?.systemIntegration || !integration.supported) { showDialog('help-dialog'); return; }
    const button = $('#integration-button'); button.disabled = true;
    try {
      integration = await host.setIntegration(!integration.installed);
      refreshIntegration(); toast(integration.installed ? '右键入口已安装，请在 Finder 或资源管理器中查看。' : '已停用右键菜单');
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  });
  ['help-button', 'inline-help'].forEach(id => $('#' + id).addEventListener('click', () => showDialog('help-dialog')));
  $('#about-button').addEventListener('click', () => showDialog('about-dialog'));
  $('#open-search').addEventListener('click', () => { showDialog('search-dialog'); $('#global-search').focus(); });
  $$('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  $$('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } }));
  function searchMatches(value) { return !value || /复制路径|路径|复制|文件|copy|path|file/i.test(value); }
  $('#global-search').addEventListener('input', event => { const match = searchMatches(event.target.value); $('#search-copy').hidden = !match; $('#search-empty').hidden = match; });
  $('#global-search').addEventListener('keydown', event => { if (event.key === 'Enter' && !$('#search-copy').hidden) { event.preventDefault(); $('#search-copy').click(); } });
  $('#search-copy').addEventListener('click', () => { $('#search-dialog').close(); setView('copy'); });
  $('#tool-filter').addEventListener('input', event => { const match = searchMatches(event.target.value); $('#tool-results').hidden = !match; $('#no-tools').hidden = match; });
  document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); showDialog('search-dialog'); $('#global-search').focus(); } });
  const zone = $('#drop-zone');
  document.addEventListener('dragover', event => { event.preventDefault(); });
  document.addEventListener('drop', event => { event.preventDefault(); });
  zone.addEventListener('dragover', event => { event.preventDefault(); zone.classList.add('drag-active'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-active'));
  zone.addEventListener('drop', async event => {
    event.preventDefault(); zone.classList.remove('drag-active');
    try {
      if (!host.pathsFromFiles) throw new Error('浏览器无法读取拖入文件的绝对路径，请使用客户端或粘贴路径。');
      const paths = await host.pathsFromFiles([...event.dataTransfer.files]);
      if (!paths.length) throw new Error('未读取到文件路径，请通过“选择文件”重试。');
      acceptPaths(paths, '已拖入');
    } catch (error) { toast(error.message, true); }
  });
  let longPress;
  let touchStart;
  $('#path-preview').addEventListener('touchstart', event => { if (platform.platform !== 'android') return; const touch = event.touches[0]; touchStart = { x: touch.clientX, y: touch.clientY }; longPress = setTimeout(copyOutput, 650); }, { passive: true });
  $('#path-preview').addEventListener('touchmove', event => { const touch = event.touches[0]; if (touchStart && Math.hypot(touch.clientX - touchStart.x, touch.clientY - touchStart.y) > 10) clearTimeout(longPress); }, { passive: true });
  ['touchend', 'touchcancel'].forEach(name => $('#path-preview').addEventListener(name, () => clearTimeout(longPress), { passive: true }));
  let updateState = { status: 'idle' };
  function renderUpdate(state) {
    updateState = state || { status: 'error', error: '未能读取更新状态。' };
    const status = updateState.status;
    const busy = status === 'checking' || status === 'downloading';
    $('#check-update').disabled = busy;
    $('#download-update').hidden = status !== 'available';
    $('#install-update').hidden = status !== 'downloaded';
    $('#update-progress').hidden = status !== 'downloading';
    const percent = Math.max(0, Math.min(100, Number(updateState.progress) || 0));
    $('#update-progress-bar').value = percent;
    $('#update-progress-label').textContent = `${Math.round(percent)}%`;
    const version = updateState.version ? `v${updateState.version}` : '新版本';
    const titles = { idle: '保持顺手，也保持最新。', checking: '正在检查 GitHub 最新版本…', 'up-to-date': '已经是最新版本。', available: `${version} 已经准备好。`, downloading: `正在下载 ${version}…`, downloaded: '安装包已下载，校验通过。', error: '这次更新未完成，可以重试。', unsupported: '请在客户端中检查和安装更新。', installing: '请在系统安装界面中继续。' };
    $('#update-status-title').textContent = titles[status] || titles.idle;
    const details = { idle: '从 GitHub 检查新版本，下载并校验安装包。', checking: '只读取版本信息，不会自动下载安装包。', 'up-to-date': `当前版本 v${updateState.currentVersion || platform.version || '0.1.0'}。`, available: updateState.assetName || '安装包将从 Brclio/Brclio 的 GitHub Release 下载。', downloading: '下载完成后会核对 SHA-256，确保安装包完整。', downloaded: platform.platform === 'darwin' ? '打开磁盘映像后，将 Brclio 拖入 Applications，再重新打开。' : '点击下方按钮，交给系统安装程序完成更新。', unsupported: '当前为浏览器预览。三端安装包发布在 GitHub：Brclio/Brclio。', installing: '完成安装后重新打开 Brclio，即可查看新版本。' };
    $('#update-status-detail').textContent = status === 'error' ? updateState.error || '网络连接失败，请检查网络后重试。' : details[status] || details.idle;
    $('#update-notes').hidden = !updateState.notes || !['available', 'downloaded'].includes(status);
    $('#update-notes').textContent = (updateState.notes || '').slice(0, 1600);
    $('#install-update').textContent = platform.platform === 'darwin' ? '打开 DMG 安装' : '打开安装程序';
  }
  async function performUpdate(method) {
    try {
      if (method === 'checkForUpdates') renderUpdate({ status: 'checking' });
      else if (method === 'downloadUpdate') renderUpdate({ ...updateState, status: 'downloading', progress: 0 });
      const state = await host[method]();
      if (method === 'installUpdate' && state?.installerOpened) renderUpdate({ ...state, status: 'installing' });
      else if (state?.status) {
        renderUpdate(state);
        if (state.requiresPermission) $('#update-status-detail').textContent = '请在系统设置中允许 Brclio 安装应用，然后返回并再次点击安装。';
      }
      else if (method === 'installUpdate') renderUpdate({ ...updateState, status: 'installing' });
    } catch (error) { renderUpdate({ ...updateState, status: 'error', error: error.message }); }
  }
  $('#check-update').addEventListener('click', () => performUpdate('checkForUpdates'));
  $('#download-update').addEventListener('click', () => performUpdate('downloadUpdate'));
  $('#install-update').addEventListener('click', () => performUpdate('installUpdate'));
  $('#about-update').addEventListener('click', () => { $('#about-dialog').close(); setView('settings'); performUpdate('checkForUpdates'); });
  host.onUpdateState?.(renderUpdate);

  host.onPaths(paths => acceptPaths(paths, '已导入'));
  async function init() {
    try {
      const [info, saved, status] = await Promise.all([host.getPlatform(), host.getSettings(), host.getIntegrationStatus()]);
      platform = info; integration = status; settings = engine.normalizeSettings(saved);
      if (samples[platform.platform]) { samplePlatform = platform.platform; $$('[data-sample]').forEach(button => button.classList.toggle('active', button.dataset.sample === samplePlatform)); }
      $$('.version').forEach(item => { item.textContent = `v${platform.version || '0.1.0'}`; });
      $('#current-version').textContent = `v${platform.version || '0.1.0'}`;
      $('#update-platform-hint').textContent = platform.platform === 'darwin' ? 'macOS 安装包尚未公证；下载校验后打开 DMG，手动拖入 Applications。' : platform.platform === 'android' ? '首次安装更新时，需要允许 Brclio 安装应用。' : platform.platform === 'browser' ? '浏览器仅提供界面预览；在线更新在 Windows、macOS 和安卓客户端中使用。' : '安装时可能出现系统权限提示，按安装程序指引继续。';
      $('#platform-label').textContent = platformNames[platform.platform] || platform.platform;
      $('#environment-detail').textContent = `${platformNames[platform.platform] || platform.platform} · v${platform.version || '0.1.0'}`;
      if (platform.platform === 'browser' || platform.platform === 'android' || platform.packaged === false) {
        $('#launch-at-login').disabled = true;
        $('#login-hint').textContent = platform.platform === 'android' ? '安卓端无需常驻，按需打开即可。' : platform.packaged === false ? '开机启动可在安装版客户端中设置。' : '开机启动可在桌面客户端中设置。';
      }
      if (platform.platform === 'win32' || platform.platform === 'android') $('#search-shortcut').textContent = 'Ctrl K';
      applyControls(); refreshIntegration(); setSaveStatus('设置已保存');
    } catch (error) { $('#platform-label').textContent = '设置读取失败'; setSaveStatus('读取失败', true); toast(error.message, true); }
    finally { document.body.inert = false; document.body.dataset.ready = 'true'; }
  }
  applyControls();
  init();
})();

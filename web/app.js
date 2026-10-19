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
  let shortcutStatus = { supported: false, accelerator: 'Alt+P', registered: false, error: null };
  let shortcutCapture = null;
  let shortcutBusy = false;
  let shortcutPendingValue = '';
  let shortcutMessage = '';
  let shortcutFailed = false;
  let updateProxy = { enabled: true, supported: false, route: 'direct' };
  let proxyPending = false;
  let proxyError = '';
  let proxyRevision = 0;

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
  function savePreferences(shortcutCandidate) {
    const snapshot = { ...settings };
    const revision = ++changes;
    setSaveStatus('正在保存…');
    saveQueue = saveQueue.catch(() => {}).then(() => {
      // A queued format edit must use the latest successfully saved shortcut.
      return host.saveSettings({ ...snapshot, copyShortcut: shortcutCandidate ?? settings.copyShortcut });
    }).then(saved => {
      if (shortcutCandidate !== undefined) settings.copyShortcut = saved?.copyShortcut || shortcutCandidate;
      if (revision === changes) setSaveStatus('设置已保存');
      return { saved };
    }).catch(error => {
      if (revision === changes) { setSaveStatus('保存失败', true); if (shortcutCandidate === undefined) toast(error.message, true); }
      return { error };
    });
    return saveQueue;
  }
  function applyControls() {
    $$('input[name="pathMode"]').forEach(input => { input.checked = input.value === settings.pathMode; });
    $$('input[name="separator"]').forEach(input => { input.checked = input.value === settings.separator; });
    $('#base-path').value = settings.basePath;
    $('#quote-mode').value = settings.quoteMode;
    $('#join-with').value = settings.joinWith;
    $('#trailing-slash').checked = settings.trailingSlash;
    $('#launch-at-login').checked = settings.launchAtLogin;
    renderShortcut();
    updatePreview();
  }
  function shortcutSupported() {
    return Boolean(platform.capabilities?.globalShortcut && shortcutStatus.supported && host.suspendShortcut && host.resumeShortcut);
  }
  function displayShortcut(accelerator) {
    const names = platform.platform === 'darwin' ? { Alt: 'Option', Super: 'Command' } : { Super: 'Win' };
    return (accelerator || 'Alt+P').split('+').map(key => names[key] || key).join(' + ');
  }
  function renderShortcut() {
    const supported = shortcutSupported();
    const recording = Boolean(shortcutCapture);
    $('#launch-shortcut').value = recording ? shortcutCapture.ready ? '请按下快捷键…' : '正在准备录制…' : displayShortcut(shortcutPendingValue || settings.copyShortcut);
    $('#launch-shortcut').disabled = !supported;
    $('#launch-shortcut').classList.toggle('recording', recording);
    $('#record-shortcut').disabled = !supported || shortcutBusy || recording;
    $('#record-shortcut').textContent = shortcutBusy ? '请稍候…' : '修改快捷键';
    $('#reset-shortcut').disabled = !supported || shortcutBusy || recording;
    $('#cancel-shortcut').hidden = !recording;
    $('#shortcut-hint').textContent = !supported
      ? platform.platform === 'android' ? '安卓端不支持全局快捷键，可选择文件或从文件管理器分享后复制。' : '全局快捷键仅支持 macOS 和 Windows 客户端。'
      : recording ? platform.platform === 'darwin' ? '按下包含 Control、Option 或 Command 的组合键，Esc 取消。' : '按下包含 Ctrl、Alt 或 Win 的组合键，Esc 取消。'
        : platform.platform === 'darwin' ? '在 Finder 中选中文件或文件夹后按下，沿用路径格式。默认：Option+P（Windows Alt+P）。首次使用可能需允许 Brclio 控制 Finder。'
          : '在资源管理器中选中文件或文件夹后按下，沿用路径格式。默认：Windows Alt+P · Mac Option+P。';
    const status = $('#shortcut-status');
    status.textContent = shortcutMessage || (supported && !recording && !shortcutBusy && !shortcutStatus.registered ? shortcutStatus.error || '快捷键尚未生效，请重试或设置其他组合键。' : '');
    status.hidden = !status.textContent;
    status.classList.toggle('error', shortcutFailed || Boolean(!shortcutMessage && shortcutStatus.error));
    $('#retry-shortcut').hidden = !supported || recording || shortcutBusy || shortcutStatus.registered;
  }
  async function resumeShortcut() {
    try {
      const status = await host.resumeShortcut();
      shortcutStatus = status || await host.getShortcutStatus();
    } catch (error) { shortcutStatus = { ...shortcutStatus, registered: false, error: error.message }; }
  }
  async function cancelShortcutRecording() {
    const capture = shortcutCapture;
    if (!capture) return;
    shortcutCapture = null;
    shortcutBusy = true;
    shortcutMessage = '';
    shortcutFailed = false;
    renderShortcut();
    await capture.suspension.catch(() => {});
    await resumeShortcut();
    shortcutBusy = false;
    renderShortcut();
  }
  async function recordShortcut() {
    if (!shortcutSupported() || shortcutBusy || shortcutCapture) return;
    shortcutMessage = '';
    shortcutFailed = false;
    const capture = { ready: false, suspension: saveQueue.then(() => host.suspendShortcut()) };
    shortcutCapture = capture;
    renderShortcut();
    $('#cancel-shortcut').focus();
    try {
      await capture.suspension;
      if (shortcutCapture === capture) { capture.ready = true; renderShortcut(); }
    } catch (error) {
      if (shortcutCapture !== capture) return;
      await cancelShortcutRecording();
      shortcutMessage = `无法开始录制：${error.message}`;
      shortcutFailed = true;
      renderShortcut();
    }
  }
  async function saveShortcut(candidate) {
    const capture = shortcutCapture;
    shortcutCapture = null;
    shortcutBusy = true;
    shortcutPendingValue = candidate;
    shortcutMessage = '正在保存快捷键…';
    shortcutFailed = false;
    renderShortcut();
    try {
      if (capture) await capture.suspension;
      const result = await savePreferences(candidate);
      if (result.error) throw result.error;
      shortcutMessage = `已保存 ${displayShortcut(settings.copyShortcut)}`;
    } catch (error) { shortcutMessage = `未修改快捷键：${error.message}`; shortcutFailed = true; }
    finally {
      await resumeShortcut();
      shortcutBusy = false;
      shortcutPendingValue = '';
      if (!shortcutFailed && !shortcutStatus.registered) { shortcutMessage = shortcutStatus.error || '快捷键已保存，但尚未生效，请重试。'; shortcutFailed = true; }
      renderShortcut();
    }
  }
  function shortcutFromEvent(event) {
    let key;
    if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
    else if (/^Digit[0-9]$/.test(event.code)) key = event.code.slice(5);
    else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.code)) key = event.code;
    else key = { Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete', Backspace: 'Backspace', Tab: 'Tab' }[event.code];
    if (!key || !(event.ctrlKey || event.altKey || event.metaKey)) return null;
    return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Super', key].filter(Boolean).join('+');
  }
  document.addEventListener('keydown', event => {
    if (!shortcutCapture) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.code === 'Escape' || event.key === 'Escape') { void cancelShortcutRecording(); return; }
    if (!shortcutCapture.ready || event.repeat) return;
    const candidate = shortcutFromEvent(event);
    if (candidate) void saveShortcut(candidate);
    else if (!['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'].includes(event.code)) {
      shortcutMessage = '请使用 Ctrl、Option / Alt 或 Command / Win，加上字母、数字或功能键。';
      shortcutFailed = true;
      renderShortcut();
    }
  }, true);
  $('#record-shortcut').addEventListener('click', recordShortcut);
  $('#cancel-shortcut').addEventListener('click', cancelShortcutRecording);
  $('#reset-shortcut').addEventListener('click', () => { if (shortcutSupported() && !shortcutBusy && !shortcutCapture) void saveShortcut('Alt+P'); });
  $('#retry-shortcut').addEventListener('click', async () => {
    shortcutBusy = true; shortcutMessage = ''; shortcutFailed = false; renderShortcut();
    await resumeShortcut();
    shortcutBusy = false; renderShortcut();
  });
  window.addEventListener('blur', () => { void cancelShortcutRecording(); });
  window.addEventListener('pagehide', () => { void cancelShortcutRecording(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) void cancelShortcutRecording(); });
  document.addEventListener('pointerdown', event => { if (shortcutCapture && !event.target.closest('.shortcut-controls')) void cancelShortcutRecording(); }, true);
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
    if (name !== 'settings') void cancelShortcutRecording();
    $$('.view').forEach(view => { const active = view.id === 'view-' + name; view.hidden = !active; view.classList.toggle('active', active); });
    $$('.nav-item[data-view]').forEach(item => { item.classList.toggle('active', item.dataset.view === name); if (item.dataset.view === name) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); });
    $('#breadcrumb-current').textContent = viewNames[name];
    document.title = `Brclio · ${viewNames[name]}`;
    if (name === 'settings') void refreshUpdateProxy();
  }
  function showDialog(id) { void cancelShortcutRecording(); const dialog = $('#' + id); if (!dialog.open) dialog.showModal(); if (id === 'about-dialog') void refreshUpdateProxy(); }
  function refreshIntegration() {
    const available = integration.supported && platform.capabilities?.systemIntegration;
    if (available) {
      $('#integration-title').textContent = integration.installed ? '右键菜单已启用，随时复制。' : '让复制路径，出现在右键菜单里';
      $('#integration-description').textContent = integration.description || '在文件或文件夹上右键，按照你的偏好复制路径。';
      $('#integration-button').innerHTML = (integration.installed ? '停用右键菜单' : integration.awaitingApproval ? '重新启用 Finder 扩展' : integration.stale ? '修复右键菜单' : '启用右键菜单') + '<svg class="icon"><use href="#i-arrow"/></svg>';
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
  $('#reset-settings').addEventListener('click', () => { settings = { ...engine.DEFAULT_SETTINGS, launchAtLogin: settings.launchAtLogin, copyShortcut: settings.copyShortcut }; applyControls(); savePreferences(); toast('已恢复默认复制偏好'); });
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
      const enabling = !integration.installed;
      integration = await host.setIntegration(enabling);
      refreshIntegration(); toast(!enabling ? '已停用右键菜单' : integration.installed ? '右键入口已启用，请在 Finder 或资源管理器中查看。' : 'Finder 扩展已登记，请在系统设置的 Finder 扩展中允许 Brclio。');
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
  let updatePending = false;
  function renderUpdateProxy() {
    const busy = proxyPending || updatePending || ['checking', 'downloading', 'preparing', 'restarting', 'installing'].includes(updateState.status);
    const detail = proxyError || (!updateProxy.supported ? '更新代理可在客户端中使用。' : updateProxy.route === 'system'
      ? '检测到系统代理，更新沿用系统网络。'
      : updateProxy.enabled ? '检查和下载更新时使用内置代理。' : '内置代理已关闭，更新使用系统网络。');
    ['update', 'about-update'].forEach(prefix => {
      const toggle = $(`#${prefix}-proxy`);
      toggle.checked = updateProxy.enabled;
      toggle.disabled = busy || !updateProxy.supported;
      toggle.setAttribute('aria-busy', String(proxyPending));
      $(`#${prefix}-proxy-status`).textContent = detail;
      $(`#${prefix}-proxy-status`).classList.toggle('error', Boolean(proxyError));
    });
  }
  async function refreshUpdateProxy() {
    if (!host.getUpdateProxyState || proxyPending) { renderUpdateProxy(); return; }
    const revision = ++proxyRevision;
    try {
      const state = await host.getUpdateProxyState();
      if (revision !== proxyRevision || proxyPending) return;
      updateProxy = state; proxyError = state.error || '';
    }
    catch { if (revision !== proxyRevision || proxyPending) return; proxyError = '暂时无法读取代理状态，请重新打开此面板。'; }
    renderUpdateProxy();
  }
  async function setUpdateProxy(enabled) {
    if (proxyPending || updatePending || !updateProxy.supported) { renderUpdateProxy(); return; }
    ++proxyRevision;
    proxyPending = true; proxyError = ''; renderUpdate(updateState);
    try {
      updateProxy = await host.setUpdateProxyEnabled(enabled);
      proxyError = updateProxy.error || '';
      toast(proxyError || (updateProxy.enabled ? '内置更新代理已开启' : '本次运行已关闭内置更新代理，重启后恢复开启'), Boolean(proxyError));
    } catch (error) { proxyError = error.message; toast(error.message, true); }
    finally { proxyPending = false; renderUpdate(updateState); }
  }
  ['update', 'about-update'].forEach(prefix => $(`#${prefix}-proxy`).addEventListener('change', event => { void setUpdateProxy(event.target.checked); }));
  function renderUpdate(state) {
    updateState = state || { status: 'error', error: '未能读取更新状态。' };
    const status = updateState.status;
    const busy = updatePending || ['checking', 'downloading', 'preparing', 'restarting', 'installing'].includes(status);
    $('#check-update').disabled = busy || proxyPending;
    $('#check-update').textContent = status === 'checking' ? '正在检查…' : '检查更新';
    $('#download-update').hidden = status !== 'available';
    $('#download-update').disabled = busy || proxyPending;
    $('#install-update').hidden = status !== 'downloaded' && !(status === 'error' && updateState.canInstall);
    $('#install-update').disabled = busy || proxyPending;
    const percent = Math.max(0, Math.min(100, Number(updateState.progress) || 0));
    const version = updateState.version ? `v${updateState.version}` : '新版本';
    const titles = { idle: '保持顺手，也保持最新。', checking: '正在检查 GitHub 最新版本…', 'up-to-date': '已经是最新版本。', available: `${version} 已经准备好。`, downloading: `正在下载 ${version}…`, downloaded: '安装包已下载，校验通过。', preparing: '正在准备覆盖安装…', restarting: '正在更新，Brclio 即将重新打开…', installed: '更新完成，欢迎回来。', error: '这次更新未完成，可以重试。', unsupported: '请在客户端中检查和安装更新。', installing: '请在系统安装界面中继续。' };
    const details = { idle: platform.platform === 'android' ? '检查新版本后，下载安装包并确认系统安装。完成后如未自动返回，请点击系统“打开”。' : '检查新版本后，点击下载并安装。桌面端会覆盖当前安装并自动打开。', checking: '正在读取最新正式版本。', 'up-to-date': `当前版本 v${updateState.currentVersion || platform.version || '0.1.10'}。`, available: updateState.assetName || '安装包将从 Brclio/Brclio 的 GitHub Release 下载。', downloading: '下载完成并通过 SHA-256 校验后，将继续安装。', downloaded: '点击安装更新，将保留你的设置。', preparing: '正在校验安装包并准备旧版备份，请稍候。', restarting: '将关闭当前窗口、覆盖安装并自动启动新版。', installed: `当前版本 v${platform.version || updateState.currentVersion}。你的设置已保留。`, unsupported: '当前为浏览器预览。三端安装包发布在 GitHub：Brclio/Brclio。', installing: platform.platform === 'android' ? '请确认系统安装。安装完成将尝试自动打开；如未自动返回，请点击系统“打开”。' : '正在完成覆盖安装并重新打开 Brclio。' };
    const detail = updateState.requiresPermission ? '请在系统设置中允许 Brclio 安装应用，然后返回并再次点击安装。' : status === 'error' ? updateState.error || '网络连接失败，请检查网络后重试。' : updateState.message || details[status] || details.idle;
    // Both entry points reflect the same native update without changing views.
    ['update', 'about-update'].forEach(prefix => {
      $(`#${prefix}-status-title`).textContent = titles[status] || titles.idle;
      $(`#${prefix}-status-detail`).textContent = detail;
      $(`#${prefix}-progress`).hidden = status !== 'downloading';
      $(`#${prefix}-progress-bar`).value = percent;
      $(`#${prefix}-progress-label`).textContent = `${Math.round(percent)}%`;
      $(`#${prefix}-notes`).hidden = !updateState.notes || !['available', 'downloaded'].includes(status);
      $(`#${prefix}-notes`).textContent = (updateState.notes || '').slice(0, 1600);
    });
    const aboutLabels = { checking: '正在检查…', 'up-to-date': '重新检查', available: '下载并安装更新', downloading: `正在下载… ${Math.round(percent)}%`, downloaded: '安装更新', preparing: '正在准备安装…', restarting: '正在重启…', installing: '正在安装…', error: updateState.canInstall ? '重试安装' : '重新检查' };
    $('#about-update').textContent = aboutLabels[status] || '检查更新';
    $('#about-update').disabled = busy || proxyPending;
    $('#about-update').setAttribute('aria-busy', String(busy));
    $('#about-update').classList.toggle('button-primary', status === 'available' || status === 'downloaded' || (status === 'error' && updateState.canInstall));
    $('#about-update').classList.toggle('button-outline', !$('#about-update').classList.contains('button-primary'));
    $('#about-update-status').hidden = status === 'idle';
    $('#download-update').textContent = '下载并安装更新';
    $('#install-update').textContent = status === 'error' ? '重试安装' : '安装更新';
    renderUpdateProxy();
  }
  async function performUpdate(method) {
    if (proxyPending || updatePending || ['checking', 'downloading', 'preparing', 'restarting', 'installing'].includes(updateState.status)) return;
    updatePending = true;
    try {
      if (method === 'checkForUpdates') renderUpdate({ status: 'checking' });
      else if (method === 'downloadUpdate') renderUpdate({ ...updateState, status: 'downloading', progress: 0 });
      else if (method === 'installUpdate') renderUpdate({ ...updateState, status: 'preparing' });
      const state = await host[method]();
      if (method === 'downloadUpdate' && state?.status === 'downloaded') {
        renderUpdate(state);
        await saveQueue;
        renderUpdate({ ...updateState, status: 'preparing' });
        const installed = await host.installUpdate();
        renderUpdate(installed?.installerOpened ? { ...installed, status: 'installing' } : installed || { ...updateState, status: 'installing' });
      }
      else if (method === 'installUpdate' && state?.installerOpened) renderUpdate({ ...state, status: 'installing' });
      else if (state?.status) {
        renderUpdate(state);
      }
      else if (method === 'installUpdate') renderUpdate({ ...updateState, status: 'installing' });
    } catch (error) { renderUpdate({ ...updateState, status: 'error', error: error.message }); }
    finally { updatePending = false; renderUpdate(updateState); void refreshUpdateProxy(); }
  }
  $('#check-update').addEventListener('click', () => performUpdate('checkForUpdates'));
  $('#download-update').addEventListener('click', () => performUpdate('downloadUpdate'));
  $('#install-update').addEventListener('click', () => performUpdate('installUpdate'));
  $('#about-update').addEventListener('click', () => performUpdate(updateState.status === 'available' ? 'downloadUpdate' : updateState.status === 'downloaded' || (updateState.status === 'error' && updateState.canInstall) ? 'installUpdate' : 'checkForUpdates'));
  host.onUpdateState?.(state => {
    renderUpdate(state);
    if (state?.status === 'installed') host.getIntegrationStatus().then(status => { integration = status; refreshIntegration(); }).catch(() => {});
  });

  host.onPaths(paths => acceptPaths(paths, '已导入'));
  // Only portable format preferences are synced; local paths and host behavior stay local.
  const portablePreferenceKeys = ['pathMode', 'quoteMode', 'separator', 'trailingSlash', 'joinWith'];
  window.BrclioPreferences = {
    read: async () => { await saveQueue; return Object.fromEntries(portablePreferenceKeys.map(key => [key, settings[key]])); },
    apply: async preferences => {
      await saveQueue;
      const portable = Object.fromEntries(portablePreferenceKeys.filter(key => preferences?.[key] !== undefined).map(key => [key, preferences[key]]));
      settings = engine.normalizeSettings({ ...settings, ...portable });
      applyControls();
      const result = await savePreferences();
      if (result.error) throw result.error;
    },
  };
  async function init() {
    try {
      const [info, saved, status, update] = await Promise.all([host.getPlatform(), host.getSettings(), host.getIntegrationStatus(), host.getUpdateState?.()]);
      platform = info; integration = status; settings = engine.normalizeSettings(saved);
      if (platform.capabilities?.globalShortcut && host.getShortcutStatus) {
        try { shortcutStatus = await host.getShortcutStatus(); }
        catch (error) { shortcutStatus = { supported: true, accelerator: settings.copyShortcut, registered: false, error: error.message }; }
      }
      if (samples[platform.platform]) { samplePlatform = platform.platform; $$('[data-sample]').forEach(button => button.classList.toggle('active', button.dataset.sample === samplePlatform)); }
      $$('.version').forEach(item => { item.textContent = `v${platform.version || '0.1.10'}`; });
      $('#current-version').textContent = `v${platform.version || '0.1.10'}`;
      $('#about-dialog .subtle-tag').textContent = `VERSION ${platform.version || '0.1.10'}`;
      $('#update-platform-hint').textContent = platform.platform === 'darwin' ? '下载校验后自动覆盖当前安装并重新打开。尚未公证，首次运行可能需要在系统设置中允许打开。' : platform.platform === 'android' ? '需确认系统安装；系统限制自动打开时，请点击安装器的“打开”。' : platform.platform === 'browser' ? '浏览器仅提供界面预览；在线更新在 Windows、macOS 和安卓客户端中使用。' : '下载校验后覆盖当前安装并自动打开，保留设置和右键菜单。';
      $('#platform-label').textContent = platformNames[platform.platform] || platform.platform;
      $('#environment-detail').textContent = `${platformNames[platform.platform] || platform.platform} · v${platform.version || '0.1.10'}`;
      if (platform.platform === 'browser' || platform.platform === 'android' || platform.packaged === false) {
        $('#launch-at-login').disabled = true;
        $('#login-hint').textContent = platform.platform === 'android' ? '安卓端无需常驻，按需打开即可。' : platform.packaged === false ? '开机启动可在安装版客户端中设置。' : '开机启动可在桌面客户端中设置。';
      }
      if (platform.platform === 'win32' || platform.platform === 'android') $('#search-shortcut').textContent = 'Ctrl K';
      applyControls(); refreshIntegration(); setSaveStatus('设置已保存');
      renderUpdate(update || { status: 'idle' });
      void refreshUpdateProxy();
      await host.reportReady?.();
      document.body.dataset.initialized = 'true';
    } catch (error) { $('#platform-label').textContent = '设置读取失败'; setSaveStatus('读取失败', true); toast(error.message, true); }
    finally { document.body.inert = false; document.body.dataset.ready = 'true'; }
  }
  applyControls();
  init();
})();

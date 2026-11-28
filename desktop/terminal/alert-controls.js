'use strict';

(() => {
  const api = window.brclioTerminal;
  let bellEnabled = false;
  let nextBell = 0;
  let recording = false;
  let saving = false;
  function attach(terminal) {
    terminal.onBell(() => {
      if (!bellEnabled || Date.now() < nextBell) return;
      nextBell = Date.now() + 10000;
      api.ringBell().catch(() => {});
    });
  }
  window.BrclioTerminalAlerts = { attach };

  const dialog = document.getElementById('actions-dialog');
  const fieldset = document.createElement('fieldset');
  fieldset.disabled = true;
  const legend = document.createElement('legend');
  legend.textContent = '全局快捷键与通知';
  const record = document.createElement('button');
  record.id = 'terminal-hotkey-record';
  record.type = 'button';
  const clear = document.createElement('button');
  clear.id = 'terminal-hotkey-clear';
  clear.type = 'button';
  clear.textContent = '停用快捷键';
  const binding = document.createElement('span');
  binding.id = 'terminal-hotkey-binding';
  const bell = document.createElement('input');
  bell.id = 'terminal-bell-enabled';
  bell.type = 'checkbox';
  const bellLabel = document.createElement('label');
  bellLabel.append(bell, '收到终端铃时显示系统通知（每 10 秒最多一次）');
  const status = document.createElement('p');
  status.id = 'terminal-alert-status';
  status.setAttribute('role', 'status');
  fieldset.append(legend, binding, record, clear, bellLabel, status);
  dialog.append(fieldset);

  let config = { hotkey: null };
  function refresh(value) {
    config = value;
    binding.textContent = '显示或隐藏终端窗口：' + (value.hotkey || '未设置');
    record.textContent = recording ? '取消录入' : '录入快捷键';
    clear.disabled = !value.hotkey || saving;
    bell.checked = bellEnabled = value.bell;
  }
  function stop() {
    if (!recording) return;
    recording = false;
    record.textContent = '录入快捷键';
    api.recordHotkey(false).catch(() => {});
  }
  async function save(key) {
    if (saving) return;
    stop();
    saving = record.disabled = true;
    try {
      refresh(await api.setHotkey(key));
      status.textContent = key ? '快捷键已启用。' : '快捷键已停用。';
    } catch (error) { status.textContent = error.message; }
    finally { saving = record.disabled = false; refresh(config); }
  }
  record.onclick = async () => {
    if (recording) { stop(); status.textContent = ''; return; }
    try {
      await api.recordHotkey(true);
      if (!dialog.open || !document.hasFocus()) { await api.recordHotkey(false); return; }
      recording = true;
      record.textContent = '取消录入';
      status.textContent = '按下包含 Ctrl、Alt 或 Command / Win 的组合键，Esc 取消。复制路径占用 ' + config.copyShortcut + '。';
    } catch (error) { status.textContent = error.message; }
  };
  clear.onclick = () => save(null);
  api.onCapturedHotkey(key => { if (recording) void save(key); });
  window.addEventListener('keydown', event => {
    if (!recording) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat || event.isComposing) return;
    if (event.key === 'Escape') { stop(); status.textContent = ''; return; }
    let key = event.code;
    if (/^Key[A-Z]$/.test(key)) key = key.slice(3);
    else if (/^Digit[0-9]$/.test(key)) key = key.slice(5);
    else if (key.startsWith('Arrow')) key = key.slice(5);
    else if (!/^(?:F(?:[1-9]|1[0-9]|2[0-4])|Space|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown)$/.test(key)) return;
    if (!event.ctrlKey && !event.altKey && !event.metaKey) return;
    const parts = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Super', key];
    void save(parts.filter(Boolean).join('+'));
  }, true);
  window.addEventListener('blur', stop);
  dialog.addEventListener('close', stop);
  bell.onchange = async () => {
    bell.disabled = true;
    try { refresh(await api.setBell(bell.checked)); status.textContent = bellEnabled ? '已启用终端铃通知。' : '已关闭终端铃通知。'; }
    catch (error) { bell.checked = bellEnabled; status.textContent = error.message; }
    finally { bell.disabled = false; }
  };
  refresh({ hotkey: null, bell: false });
  api.getAlertSettings().then(value => {
    refresh(value);
    fieldset.disabled = false;
    status.textContent = value.error || '';
  }).catch(error => { status.textContent = error.message; });
})();

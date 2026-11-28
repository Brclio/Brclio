'use strict';

window.BrclioStatusBar = function installStatusBar(activePane) {
  const key = 'brclio.terminal.status-fields.v1';
  const defaults = ['shell', 'pid', 'cwd', 'exit'];
  const controls = [...document.querySelectorAll('[data-status-field]')];
  const status = document.getElementById('status');
  const components = document.getElementById('status-components');
  const settingResult = document.getElementById('status-setting-result');
  const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  let fields = null, timer = 0, feedbackTimer = 0;
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (Array.isArray(saved)) fields = controls.map(input => input.dataset.statusField).filter(id => saved.includes(id));
  } catch {}

  function value(id, pane) {
    switch (id) {
      case 'session': return '会话 ' + pane.tab.number + ' · ' + (pane.tab.customName || pane.title || pane.shell || 'Shell');
      case 'shell': return pane.shell;
      case 'pid': return pane.pid > 0 && 'PID ' + pane.pid;
      case 'cwd': return pane.location?.directory || (pane.initialCwd && '起始目录 ' + pane.initialCwd);
      case 'size': return pane.terminal.cols + ' × ' + pane.terminal.rows;
      case 'clock': return clock.format(new Date());
      case 'exit':
        if (pane.state === 'exited') {
          if (pane.exitSignal) return '信号 ' + pane.exitSignal;
          return Number.isInteger(pane.exitCode) && '会话退出码 ' + pane.exitCode;
        }
        return Number.isInteger(pane.commandExit) && '命令退出码 ' + pane.commandExit;
    }
  }
  function refresh(changedPane) {
    const pane = activePane();
    if (changedPane && changedPane !== pane) return;
    if (fields === null && components.hidden && !timer) return;
    // Prompts, errors and action feedback retain the original live region.
    const show = fields !== null && pane && ['running', 'exited'].includes(pane.state) &&
      !feedbackTimer && !status.classList.contains('error');
    if (show) {
      const text = fields.map(id => value(id, pane)).filter(Boolean).join(' · ');
      if (text !== components.textContent) components.textContent = components.title = text;
    }
    status.hidden = Boolean(show);
    components.hidden = !show;
    const ticking = show && fields.includes('clock') && !document.hidden;
    if (ticking && !timer) {
      timer = setTimeout(() => { timer = 0; refresh(); }, 60000 - Date.now() % 60000);
    } else if (!ticking && timer) { clearTimeout(timer); timer = 0; }
  }
  function syncControls() {
    for (const input of controls) input.checked = (fields || defaults).includes(input.dataset.statusField);
  }
  function message() {
    clearTimeout(feedbackTimer);
    feedbackTimer = 0;
    const pane = activePane();
    if (fields !== null && pane && status.textContent !== pane.detail && !status.classList.contains('error')) {
      feedbackTimer = setTimeout(() => { feedbackTimer = 0; refresh(); }, 3500);
    }
    refresh();
  }
  function save(selected) {
    try {
      if (selected === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(selected));
      fields = selected;
      settingResult.textContent = fields === null ? '已恢复默认状态栏。' : '已保存。';
    } catch { settingResult.textContent = '无法保存状态栏设置。'; }
    syncControls();
    refresh();
  }
  syncControls();
  for (const input of controls) input.onchange = () => save(controls.filter(box => box.checked).map(box => box.dataset.statusField));
  document.getElementById('status-default').onclick = () => save(null);
  document.addEventListener('visibilitychange', () => refresh());
  window.addEventListener('pagehide', () => { clearTimeout(timer); clearTimeout(feedbackTimer); }, { once: true });
  return { refresh, message };
};

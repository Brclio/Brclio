'use strict';

window.BrclioTerminalWorkspace = function installTerminalWorkspace(host, navigate) {
  const byId = id => document.getElementById(id);
  const section = byId('view-terminal');
  const surface = byId('terminal-surface');
  const launcher = document.querySelector('.nav-item[data-open-terminal]');
  const dialog = byId('search-dialog');
  let presentation;
  let lastBounds;
  let opening = false;
  launcher.dataset.view = 'terminal';

  function updateViewport() {
    let rect = null;
    if (!section.hidden && !document.querySelector('dialog[open]')) {
      const bounds = surface.getBoundingClientRect();
      const header = document.querySelector('.app-header').getBoundingClientRect();
      const x = Math.max(0, Math.ceil(bounds.left));
      const y = Math.max(0, Math.ceil(bounds.top), Math.ceil(header.bottom));
      const width = Math.min(innerWidth, Math.floor(bounds.right)) - x;
      const height = Math.min(innerHeight, Math.floor(bounds.bottom)) - y;
      if (width > 0 && height > 0) rect = { x, y, width, height };
    }
    const key = JSON.stringify(rect);
    if (lastBounds === key) return;
    lastBounds = key;
    host.setTerminalViewport(rect).catch(() => { if (lastBounds === key) lastBounds = undefined; });
  }

  function showStatus(text, retry, showWindow) {
    byId('terminal-placeholder-text').textContent = text;
    byId('terminal-return').hidden = !retry;
    byId('terminal-show').hidden = !showWindow;
  }

  function changed(mode) {
    const previous = presentation;
    presentation = mode;
    if (mode === 'inline') {
      if ((previous === 'window' || previous === undefined) && section.hidden) navigate('terminal');
      showStatus('', false, false);
    } else if (mode === 'window') {
      showStatus('终端已在独立窗口打开。', true, true);
    } else {
      showStatus('终端已关闭。', true, false);
    }
    updateViewport();
  }

  async function open(mode) {
    if (opening) return;
    opening = true;
    if (dialog.open) dialog.close();
    if (section.hidden && mode === 'inline') navigate('terminal');
    try {
      updateViewport();
      const result = await host.openTerminal(mode);
      if (result?.presentation) changed(result.presentation);
    } catch (error) {
      showStatus(error.message || '终端未能打开。', true, false);
    } finally {
      opening = false;
    }
  }

  for (const button of document.querySelectorAll('[data-open-terminal]')) {
    button.addEventListener('click', () => open('inline'));
  }
  byId('terminal-return').onclick = () => open('inline');
  byId('terminal-show').onclick = () => open('window');
  host.onTerminalPresentation(changed);
  new ResizeObserver(updateViewport).observe(surface);
  const dialogs = new MutationObserver(updateViewport);
  dialogs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
  window.addEventListener('brclio:view', updateViewport);
  window.addEventListener('resize', updateViewport);
  window.addEventListener('scroll', updateViewport, true);
};

'use strict';

window.BrclioTerminalWorkspace = {
  bind(activePane) {
    const byId = id => document.getElementById(id);
    const nav = byId('workspace-nav');
    const drawer = byId('workspace-drawer');
    const title = byId('workspace-panel-title');
    const panels = {
      hosts: { id: 'workspace-hosts', title: 'SSH 主机' },
      commands: { id: 'workspace-commands', title: '常用命令' },
      appearance: { id: 'workspace-appearance', title: '外观' },
      tools: { id: 'connection-dialog', title: '连接中心' },
    };
    const storageKey = 'brclio.terminal.workspace-panel.v1';
    let current;
    function show(panel, focus = true) {
      if (panel !== null && !Object.hasOwn(panels, panel)) return;
      if (!panel || (current === 'commands' && panel !== current)) {
        window.BrclioCommandLibrary.hide({ preserveEdit: panel !== null });
      }
      current = panel;
      drawer.hidden = !panel;
      for (const button of nav.querySelectorAll('[data-panel]')) {
        const selected = button.dataset.panel === panel;
        button.setAttribute('aria-expanded', String(selected));
        if (selected) button.setAttribute('aria-current', 'true');
        else button.removeAttribute('aria-current');
        byId(panels[button.dataset.panel].id).hidden = !selected;
      }
      try { localStorage.setItem(storageKey, panel || 'closed'); } catch {}
      if (!panel) {
        if (focus) activePane()?.terminal.focus();
        return;
      }
      title.textContent = panels[panel].title;
      drawer.scrollTop = 0;
      if (panel === 'hosts') window.BrclioWorkspaceHosts.show();
      if (panel === 'commands') window.BrclioCommandLibrary.show(focus);
      if (panel === 'appearance' && focus) byId('preset-theme').focus();
      if (panel === 'tools' && focus) byId('connection-dialog').querySelector('button').focus();
    }
    this.show = show;
    this.close = () => show(null);
    for (const button of nav.querySelectorAll('[data-panel]')) {
      button.onclick = () => show(button.dataset.panel);
    }
    byId('workspace-collapse').onclick = this.close;
    drawer.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) {
        event.preventDefault();
        this.close();
      }
    });
    let initial = 'hosts';
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved === 'closed') initial = null;
      else if (Object.hasOwn(panels, saved)) initial = saved;
    } catch {}
    show(initial, false);
  },
};

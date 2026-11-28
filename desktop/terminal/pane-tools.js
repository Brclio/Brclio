(() => {
  'use strict';
  const $ = id => document.getElementById(id);

  window.BrclioPaneTools = function createPaneTools({ tabs, getTab, selectPane, sendInput, mac }) {
    const members = new Set();
    const pasteText = new WeakMap();
    let owner, dragged, broadcasting = false, forwarding = false;
    let listKey;

    function stop() {
      for (const pane of members) delete pane.node.dataset.broadcast;
      broadcasting = false;
      members.clear();
      listKey = undefined;
    }

    function refresh() {
      const tab = getTab();
      if (dragged && !tabs.has(dragged.number)) dragged = null;
      if (owner !== tab) { stop(); owner = tab; }
      for (const pane of members) {
        if (!tab?.panes.has(pane) || pane.state !== 'running') {
          delete pane.node.dataset.broadcast;
          members.delete(pane);
        }
      }
      if (broadcasting && members.size < 2) stop();
      if (tab && tab.panes.size < 2) tab.panel.classList.remove('maximized');
      const max = Boolean(tab?.panel.classList.contains('maximized'));
      $('pane-mode-bar').hidden = !broadcasting && !max;
      $('pane-restore').hidden = !max;
      $('broadcast-status').hidden = $('broadcast-stop').hidden = !broadcasting;
      if (broadcasting) {
        $('broadcast-status').textContent = '正在向 ' + members.size + ' 个窗格广播' +
          (members.has(tab.active) ? '' : '（当前窗格未加入）');
      }
      $('pane-maximize').disabled = !tab || tab.panes.size < 2;
      $('pane-maximize').textContent = max ? '还原窗格' : '最大化窗格';
      const order = [...tabs.values()];
      const index = order.indexOf(tab);
      $('tab-move-left').disabled = index <= 0;
      $('tab-move-right').disabled = index < 0 || index === order.length - 1;
      $('broadcast-toggle').disabled = !broadcasting && members.size < 2;
      $('broadcast-toggle').textContent = broadcasting ? '停止广播' : '开启广播';
      if (!$('broadcast-options').open || !$('actions-dialog').open) return;
      const panes = [...(tab?.panes || [])];
      const key = panes.map(pane => [pane.id, pane.state, members.has(pane), broadcasting].join(':')).join('/');
      if (key === listKey) return;
      listKey = key;
      const labels = panes.map((pane, i) => {
        const label = document.createElement('label');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.value = pane.id;
        check.checked = members.has(pane);
        check.disabled = broadcasting || !pane.broadcastCapable || pane.state !== 'running';
        check.onchange = () => {
          if (check.checked) members.add(pane); else members.delete(pane);
          $('broadcast-toggle').disabled = members.size < 2;
        };
        label.append(check, (i + 1) + ' · ' + (pane.title || pane.shell || 'Shell'));
        return label;
      });
      $('broadcast-members').replaceChildren(...labels);
    }

    function toggleMax() {
      const tab = getTab();
      if (!tab || tab.panes.size < 2) return;
      tab.panel.classList.toggle('maximized');
      refresh();
      tab.active?.terminal.focus();
    }

    function moveFocus(direction) {
      const tab = getTab();
      if (!tab?.active || tab.panes.size < 2) return;
      // Measure the original split tree even if only the active pane is shown.
      // Restore the view before the next paint, without moving any emulator.
      const maximized = tab.panel.classList.contains('maximized');
      tab.panel.classList.remove('maximized');
      const horizontal = direction === 'left' || direction === 'right';
      const edge = horizontal ? ['left', 'right', 'top', 'bottom'] : ['top', 'bottom', 'left', 'right'];
      const [near, far, start, end] = edge;
      const forward = direction === 'right' || direction === 'down';
      const origin = tab.active.node.getBoundingClientRect();
      const middle = (origin[start] + origin[end]) / 2;
      let best, bestGap = Infinity, bestOffset = Infinity;
      for (const pane of tab.panes) {
        if (pane === tab.active) continue;
        const r = pane.node.getBoundingClientRect();
        const gap = forward ? r[near] - origin[far] : origin[near] - r[far];
        if (gap < -1 || r[end] <= origin[start] || r[start] >= origin[end]) continue;
        const offset = Math.abs((r[start] + r[end]) / 2 - middle);
        if (gap < bestGap || (gap === bestGap && offset < bestOffset)) {
          best = pane; bestGap = gap; bestOffset = offset;
        }
      }
      tab.panel.classList.toggle('maximized', maximized);
      if (best) selectPane(best);
    }

    function move(tab, targetIndex) {
      const list = [...tabs.values()];
      const start = list.indexOf(tab);
      if (start < 0 || targetIndex < 0 || targetIndex >= list.length || targetIndex === start) return;
      list.splice(start, 1);
      list.splice(targetIndex, 0, tab);
      const after = list[targetIndex + 1];
      $('tabs').insertBefore(tab.header, after?.header || null);
      tabs.clear();
      for (const item of list) tabs.set(item.number, item);
      refresh();
    }

    function moveCurrent(delta) {
      const tab = getTab();
      move(tab, [...tabs.values()].indexOf(tab) + delta);
      tab?.button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    function attachTab(tab) {
      tab.button.draggable = true;
      tab.button.addEventListener('dragstart', event => {
        dragged = tab;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('application/x-brclio-terminal-tab', String(tab.number));
      });
      tab.button.addEventListener('dragend', () => { dragged = null; });
      tab.header.addEventListener('dragover', event => {
        if (dragged && dragged !== tab) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }
      });
      tab.header.addEventListener('drop', event => {
        if (!dragged || dragged === tab) return;
        event.preventDefault();
        move(dragged, [...tabs.values()].indexOf(tab));
        dragged = null;
      });
    }

    function paste(pane, data) {
      pasteText.set(pane, data);
      try { pane.terminal.paste(data); } finally { pasteText.delete(pane); }
    }

    function pasteOnly(pane, data) {
      const previous = forwarding;
      forwarding = true;
      try { paste(pane, data); } finally { forwarding = previous; }
    }

    function attachInput(pane) {
      const terminal = pane.terminal;
      let fromUser = false;
      // xterm 5.5's public onData combines user input and emulator replies.
      // Its user-input event immediately precedes onData for key/IME/paste.
      // Missing internals disable fan-out instead of broadcasting PTY replies.
      const source = terminal._core?.coreService?.onUserInput?.(() => { fromUser = true; });
      pane.broadcastCapable = Boolean(source);
      const markPaste = event => {
        if (!event.isTrusted || !broadcasting || !members.has(pane)) return;
        const text = event.clipboardData?.getData('text/plain');
        if (text === undefined) return;
        pasteText.set(pane, text);
        queueMicrotask(() => pasteText.delete(pane));
      };
      const element = terminal.element;
      element.addEventListener('paste', markPaste, true);
      terminal.loadAddon({ activate() {}, dispose() {
        source?.dispose();
        element.removeEventListener('paste', markPaste, true);
      } });
      terminal.onData(data => {
        const userInput = fromUser;
        fromUser = false;
        sendInput(pane, data);
        if (!userInput || forwarding || !broadcasting || getTab() !== owner ||
            owner.active !== pane || !members.has(pane) || pane.state !== 'running') return;
        // Pointer coordinates belong to one pane. Binary X10 reports already
        // use onBinary; SGR and urxvt mouse protocols arrive through onData.
        const originalPaste = pasteText.get(pane);
        if (originalPaste === undefined && /^\x1b\[(?:<\d+|\d+);\d+;\d+[Mm]$/.test(data)) return;
        forwarding = true;
        try {
          for (const peer of members) {
            if (peer === pane || !owner.panes.has(peer) || peer.state !== 'running') continue;
            if (originalPaste === undefined) sendInput(peer, data);
            else peer.terminal.paste(originalPaste); // each PTY uses its own bracketed-paste mode
          }
        } finally { forwarding = false; }
      });
    }

    function shortcut(event) {
      const key = event.key;
      const command = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      let action;
      if (command && event.altKey && !event.shiftKey && /^Arrow(Left|Right|Up|Down)$/.test(key)) {
        action = () => moveFocus(key.slice(5).toLowerCase());
      } else if (command && event.shiftKey && !event.altKey && key === 'Enter') action = toggleMax;
      else if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && ['PageUp', 'PageDown'].includes(key)) {
        action = () => moveCurrent(key === 'PageUp' ? -1 : 1);
      }
      if (!action) return false;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) action();
      return true;
    }

    $('pane-key-hints').textContent = (mac ? '⌘⌥' : 'Ctrl+Alt+') +
      '方向键切换窗格，' + (mac ? '⌘⇧Enter' : 'Ctrl+Shift+Enter') + ' 最大化或还原。可拖动标签调整顺序。';
    $('pane-maximize').onclick = () => { $('actions-dialog').close(); toggleMax(); };
    $('pane-restore').onclick = toggleMax;
    $('tab-move-left').onclick = () => moveCurrent(-1);
    $('tab-move-right').onclick = () => moveCurrent(1);
    $('broadcast-options').addEventListener('toggle', refresh);
    $('broadcast-stop').onclick = () => { stop(); refresh(); getTab()?.active?.terminal.focus(); };
    $('broadcast-toggle').onclick = () => {
      refresh();
      if (broadcasting) stop();
      else if (members.size >= 2) {
        broadcasting = true;
        for (const pane of members) pane.node.dataset.broadcast = '';
        $('actions-dialog').close();
      }
      refresh();
    };
    $('actions-dialog').addEventListener('close', () => { $('broadcast-options').open = false; });
    return { refresh, toggleMax, attachTab, attachInput, paste, pasteOnly, shortcut };
  };
})();

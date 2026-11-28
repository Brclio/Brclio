(() => {
  'use strict';

  const byId = id => document.getElementById(id);
  const api = window.brclioTerminal;
  const tabs = new Map();
  const panes = new Map();
  const mac = api?.platform === 'darwin';
  let currentTab;
  let nextTabNumber = 1;
  let nextDirectory;
  let closing = false;

  const theme = {
    background: '#181b25', foreground: '#e3e7ef', cursor: '#f4d758',
    selectionBackground: '#415476', black: '#262b36', brightBlack: '#838b9e',
    red: '#f78487', green: '#99ce9a', yellow: '#e6c76c', blue: '#81b5ed',
    magenta: '#cba2df', cyan: '#83cbc9', white: '#dce1ea',
    brightRed: '#ffa2a5', brightGreen: '#b0eab3', brightYellow: '#ffe092',
    brightBlue: '#9ed0ff', brightMagenta: '#e7b9ff', brightCyan: '#a6ece9', brightWhite: '#fafaff',
  };
  const decorations = {
    matchBackground: '#424957', matchOverviewRuler: '#9da4b6',
    activeMatchBorder: '#f4d758', activeMatchColorOverviewRuler: '#f4d758',
  };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function message(text, error = false) {
    byId('status').textContent = text;
    byId('status').title = text;
    byId('status').classList.toggle('error', error);
    statusBar.message();
  }

  function report(error) {
    const text = error?.message || String(error);
    message(text, true);
  }

  function activePane() { return currentTab?.active; }
  const statusBar = window.BrclioStatusBar(activePane);

  function applySession(value) {
    const shell = byId('profile');
    shell.value = [...shell.options].some(option => option.value === value.shell) ? value.shell : 'default';
    nextDirectory = value.cwd || undefined;
    byId('directory-label').textContent = nextDirectory || '主目录';
    byId('directory').title = '新会话起始目录 · ' + (nextDirectory || '主目录');
    byId('shell-integration').checked = value.integration === true;
  }
  const appearance = window.BrclioTerminalProfiles({ theme, activePane, refit: fit, applySession,
    readSession: () => ({ shell: byId('profile').value, cwd: nextDirectory, integration: byId('shell-integration').checked }) });
  window.BrclioDynamicControls({ api, activePane, panes, appearance });
  const locations = window.BrclioShellLocations(appearance, panes, statusBar.refresh);
  const attachTriggers = window.BrclioTriggers({ api, panes, message,
    activate: pane => { selectTab(pane.tab); selectPane(pane); } });
  const inspector = window.BrclioPaneInspector({ panes, activePane, dialog: byId('actions-dialog'),
    activate: pane => { selectTab(pane.tab); selectPane(pane); } });

  const paneTools = window.BrclioPaneTools({ tabs, getTab: () => currentTab, selectPane, sendInput, mac });
  const tabGroups = window.BrclioTabGroups({ tabs, activeTab: () => currentTab, selectTab, clearSelection });
  function refreshTools() {
    paneTools.refresh();
    window.BrclioTerminalHistory.refresh();
    const pane = activePane();
    for (const id of ['split-right', 'split-down', 'close-pane', 'find']) byId(id).disabled = !pane;
    byId('paste').disabled = !pane || pane.state !== 'running';
    byId('copy').disabled = !pane?.terminal.hasSelection();
    byId('empty').hidden = Boolean(currentTab);
    byId('empty-recall').hidden = tabs.size === 0;
    byId('empty-message').textContent = tabs.size ? '会话在隐藏的标签中继续运行' : '所有会话已关闭';
  }

  function updateLabel(pane) {
    const name = pane.title || pane.shell || 'Shell';
    pane.caption.textContent = name;
    pane.caption.title = name;
    if (pane.tab.active === pane) {
      const label = pane.tab.number + ' · ' + (pane.tab.customName || name);
      pane.tab.name.textContent = label;
      pane.tab.button.title = label;
    }
    statusBar.refresh(pane);
  }

  function setState(pane, state, detail) {
    pane.state = state;
    pane.detail = detail;
    pane.node.dataset.state = state;
    inspector.changed();
    pane.stateLabel.textContent = state === 'running' ? '' : detail;
    pane.stateLabel.title = detail;
    pane.terminal.options.disableStdin = ['exited','error','waiting'].includes(state);
    if (pane === activePane()) {
      message(detail, state === 'error');
      refreshTools();
    } else paneTools.refresh();
  }

  function fit(pane) {
    if (!panes.has(pane.id) || pane.tab !== currentTab || !pane.host.clientHeight || !pane.host.clientWidth) return;
    const size = pane.fitter.proposeDimensions();
    if (size && Number.isFinite(size.cols) && Number.isFinite(size.rows)) {
      pane.terminal.resize(Math.min(1000, size.cols), Math.min(500, size.rows));
    }
  }

  function selectPane(pane, focus = true) {
    window.BrclioLiveView.selection(pane);
    const previous = pane.tab.active;
    if (previous && previous !== pane) previous.node.classList.remove('active');
    pane.tab.active = pane;
    pane.node.classList.add('active');
    updateLabel(pane);
    message(pane.detail, pane.state === 'error');
    refreshTools();
    if (previous !== pane && !byId('find-bar').hidden) search('previous', true);
    if (focus) pane.terminal.focus();
  }

  function selectTab(tab, focus = true) {
    tab.header.hidden = false;
    currentTab = tab;
    paneTools.refresh();
    for (const other of tabs.values()) {
      const selected = other === tab;
      other.panel.hidden = !selected;
      other.button.tabIndex = selected ? 0 : -1;
      other.button.setAttribute('aria-selected', String(selected));
    }
    tab.button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (tab.active) {
      for (const pane of tab.panes) fit(pane);
      selectPane(tab.active, focus);
      if (!byId('find-bar').hidden) search('previous', true);
    }
  }

  function sendInput(pane, data, binary = false) {
    if (!data || !['starting', 'running'].includes(pane.state)) return;
    // Preserve order across PTY startup and large bracketed pastes.
    pane.input = pane.input.then(async () => {
      await pane.ready;
      if (pane.state !== 'running' || !panes.has(pane.id)) return;
      for (let offset = 0; offset < data.length;) {
        let end = Math.min(offset + 32768, data.length);
        if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
        await api.write(pane.id, data.slice(offset, end), binary);
        offset = end;
      }
    }).catch(error => { if (panes.has(pane.id) && pane.state === 'running') report(error); });
  }

  function newPane(tab, mount, launch = {
    profile: byId('profile').value, cwd: nextDirectory || null, shellIntegration: byId('shell-integration').checked,
  }) {
    const id = crypto.randomUUID();
    const node = element('section', 'pane');
    node.dataset.id = id;
    const heading = element('div', 'pane-heading');
    const caption = element('span', 'pane-title', 'Shell');
    caption.id = 'pane-title-' + id;
    node.setAttribute('aria-labelledby', caption.id);
    const stateLabel = element('span', 'pane-message');
    heading.append(caption, stateLabel);
    const host = element('div', 'term-host');
    node.append(heading, host);
    mount.append(node);

    const terminal = new Terminal({
      ...appearance.options(), screenReaderMode: true,
      allowProposedApi: true, allowTransparency: false,
      ...(api.platform === 'win32' && { windowsPty: { backend: 'conpty' } }),
    });
    const fitter = new FitAddon.FitAddon();
    const finder = new SearchAddon.SearchAddon();
    terminal.loadAddon(fitter);
    terminal.loadAddon(finder);
    const pane = { id, tab, node, host, launch, terminal, fitter, finder, caption, stateLabel, input: Promise.resolve() };
    panes.set(id, pane);
    tab.panes.add(pane);
    terminal.open(host);
    window.BrclioSmartSelection.attach(terminal, host);
    pane.appearance = appearance.current;
    node.addEventListener('pointerenter', event => {
      if (pane.appearance.follow && event.pointerType === 'mouse' && !document.querySelector('dialog[open]')) selectPane(pane);
    });
    window.BrclioTerminalAlerts.attach(terminal);
    window.BrclioTerminalOutput.activate(terminal);
    pane.marks = BrclioCommandMarks.attach(terminal, code => {
      pane.commandExit = code;
      statusBar.refresh(pane);
    }, window.BrclioCommandLibrary?.recorder(launch.savedHost ? {profile:launch.savedHost.protocol} : launch));
    window.BrclioCommandLibrary.attach(pane);
    locations.attach(pane);
    pane.disposeTriggers = attachTriggers(pane);
    inspector.attach(pane);
    terminal.textarea?.setAttribute('aria-label', '终端输入');
    setState(pane, launch.savedHost ? 'waiting' : 'starting', launch.savedHost ? '等待手动连接' : '正在启动 Shell…');
    fit(pane);
    pane.observer = new ResizeObserver(() => fit(pane));
    pane.observer.observe(host);
    node.addEventListener('pointerdown', event => {
      if (tab.active !== pane) selectPane(pane, false);
      if (heading.contains(event.target)) terminal.focus();
    });
    node.addEventListener('focusin', () => { if (tab.active !== pane) selectPane(pane, false); });
    terminal.onResize(({cols, rows}) => {
      statusBar.refresh(pane);
      if (pane.state === 'running') api.resize(id, cols, rows).catch(error => { if (panes.has(id) && pane.state === 'running') report(error); });
    });
    paneTools.attachInput(pane);
    terminal.onBinary(data => sendInput(pane, data, true));
    terminal.onSelectionChange(() => { if (activePane() === pane) refreshTools(); });
    host.addEventListener('pointerup', () => {
      if (pane.appearance.autocopy && terminal.hasSelection()) api.copy(terminal.getSelection()).catch(report);
    });
    terminal.onTitleChange(value => {
      pane.title = value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 160);
      updateLabel(pane);
    });
    finder.onDidChangeResults(({resultIndex, resultCount}) => {
      if (activePane() === pane && pane.searchableQuery && !byId('find-bar').hidden) {
        byId('find-result').textContent = resultCount ? (resultIndex + 1) + ' / ' + resultCount : '无匹配';
      }
    });
    selectPane(pane);
    function start(options) {
      pane.launch = options;
      window.BrclioSftp.attachSession(pane,heading);
      if (pane.state !== 'starting') setState(pane,'starting','正在启动会话…');
      const initial = {id,cols:terminal.cols,rows:terminal.rows,profile:options.profile,shellIntegration:options.shellIntegration};
      if (options.cwd) initial.cwd = options.cwd;
      if (options.connection) initial.connection = options.connection;
      pane.ready = api.create(initial).then(info => {
        if (!panes.has(id)) return api.close(id).catch(() => {});
        pane.shell = info.shell.split(/[\\/]/).pop();
        pane.pid = info.pid;
        pane.initialCwd = info.cwd;
        if (Number.isInteger(info.windowsBuild)) terminal.options.windowsPty = { backend: 'conpty', buildNumber: info.windowsBuild };
        updateLabel(pane);
        if (pane.state !== 'starting') return;
        const details = [pane.shell, info.pid > 0 && 'PID ' + info.pid, info.cwd].filter(Boolean);
        setState(pane, 'running', details.join(' · '));
        if (terminal.cols !== initial.cols || terminal.rows !== initial.rows) {
          return api.resize(id, terminal.cols, terminal.rows).catch(error => { if (pane.state === 'running') report(error); });
        }
      }).catch(error => {
        if (panes.has(id)) setState(pane, 'error', error.message || '无法启动会话');
      });
    }
    if (launch.savedHost) {
      pane.savedHost = launch.savedHost;
      pane.title = launch.savedHost.name;
      updateLabel(pane);
      pane.ready = Promise.resolve();
      pane.pendingHost = window.BrclioArrangementHost.mount(pane,launch.savedHost,(options,ref) => {
        if (!panes.has(id) || pane.state !== 'waiting') return;
        pane.savedHost = ref; pane.title = ref?.name || ''; updateLabel(pane);
        pane.pendingHost.dispose(); pane.pendingHost = undefined;
        start(options); terminal.focus();
      });
    } else start(launch);
    return pane;
  }

  function newTab(customName = '', launch) {
    const number = nextTabNumber++;
    const header = element('div', 'tab');
    const button = element('button', 'tab-button');
    const name = element('span', 'tab-name', number + ' · Shell');
    button.append(name);
    button.id = 'tab-' + number;
    button.setAttribute('role', 'tab');
    const close = element('button', 'tab-close', '×');
    close.title = '关闭标签及其中的会话';
    close.setAttribute('aria-label', '关闭标签 ' + number);
    header.append(button, close);
    byId('tabs').append(header);
    const panel = element('div', 'panel');
    panel.id = 'panel-' + number;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    button.setAttribute('aria-controls', panel.id);
    byId('workspace').append(panel);
    const tab = { number, panel, header, button, name, customName, panes: new Set(), active: null };
    tabs.set(number, tab);
    paneTools.attachTab(tab);
    button.addEventListener('click', () => selectTab(tab));
    close.addEventListener('click', () => closeTab(tab));
    selectTab(tab);
    return newPane(tab, panel, launch);
  }

  function setFraction(split, value) {
    const fraction = Math.max(.1, Math.min(.9, value));
    split.firstElementChild.style.flex = fraction + ' 1 0px';
    split.lastElementChild.style.flex = (1 - fraction) + ' 1 0px';
    split.children[1].setAttribute('aria-valuenow', String(Math.round(100 * fraction)));
  }

  function splitPane(direction, pane = activePane(), launch, fraction = .5) {
    if (!pane) return;
    pane.tab.panel.classList.remove('maximized');
    const split = element('div', 'split');
    split.dataset.direction = direction;
    split.style.flex = pane.node.style.flex;
    pane.node.style.removeProperty('flex');
    pane.node.replaceWith(split);
    const handle = element('div', 'splitter');
    const horizontal = direction === 'right';
    handle.tabIndex = 0;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-label', '调整窗格大小');
    handle.setAttribute('aria-orientation', horizontal ? 'vertical' : 'horizontal');
    handle.setAttribute('aria-valuemin', '10');
    handle.setAttribute('aria-valuemax', '90');
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('dragging');
      event.preventDefault();
    });
    handle.addEventListener('pointermove', event => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      const bounds = split.getBoundingClientRect();
      setFraction(split, horizontal ? (event.clientX - bounds.left) / bounds.width : (event.clientY - bounds.top) / bounds.height);
    });
    handle.addEventListener('lostpointercapture', () => handle.classList.remove('dragging'));
    handle.addEventListener('keydown', event => {
      const keys = horizontal ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
      const index = keys.indexOf(event.key);
      if (index < 0) return;
      event.preventDefault();
      setFraction(split, Number(handle.getAttribute('aria-valuenow')) / 100 + (index ? .05 : -.05));
    });
    split.append(pane.node, handle);
    const second = newPane(pane.tab, split, launch);
    setFraction(split, fraction);
    return second;
  }

  function disposePane(pane) {
    panes.delete(pane.id);
    pane.tab.panes.delete(pane);
    pane.observer.disconnect();
    pane.pendingHost?.dispose();
    const wasRunning = pane.state === 'running' || pane.state === 'starting';
    pane.state = 'closed';
    pane.marks.dispose();
    pane.disposeTriggers();
    pane.terminal.dispose();
    if (wasRunning) api.close(pane.id).catch(error => { if (!closing) report(error); });
  }

  function clearSelection() {
    currentTab = null;
    for (const tab of tabs.values()) {
      tab.panel.hidden = true;
      tab.button.setAttribute('aria-selected', 'false');
      tab.button.tabIndex = -1;
    }
    byId('find-bar').hidden = true;
    byId('find').setAttribute('aria-expanded', 'false');
    message(tabs.size ? '当前标签已隐藏' : '当前没有会话');
    refreshTools();
    if (!byId('actions-dialog').open) byId('empty-new').focus();
  }

  function closeTab(tab) {
    const list = [...tabs.values()];
    const index = list.indexOf(tab);
    if (index < 0) return;
    for (const pane of tab.panes) disposePane(pane);
    tabs.delete(tab.number);
    tab.header.remove();
    tab.panel.remove();
    if (tab === currentTab) {
      const next = list.slice(index + 1).find(item => !item.header.hidden) ||
        list.slice(0, index).reverse().find(item => !item.header.hidden);
      if (next) selectTab(next);
      else clearSelection();
    }
    refreshTools();
  }

  function closeActive() {
    const pane = activePane();
    if (!pane) return;
    const tab = pane.tab;
    if (tab.panes.size === 1) return closeTab(tab);
    const split = pane.node.parentElement;
    const sibling = split.firstElementChild === pane.node ? split.lastElementChild : split.firstElementChild;
    disposePane(pane);
    sibling.style.flex = split.style.flex;
    split.replaceWith(sibling);
    const nearest = sibling.matches('.pane') ? sibling : sibling.querySelector('.pane');
    selectPane(panes.get(nearest.dataset.id));
  }

  function search(direction = 'next', incremental = false) {
    const pane = activePane();
    const term = byId('find-input').value;
    if (!pane) return;
    // A pending xterm refresh can report old results after a resize or PTY write.
    pane.searchableQuery = false;
    if (!term) {
      pane.finder.clearDecorations();
      pane.terminal.clearSelection();
      byId('find-result').textContent = '';
      return;
    }
    const method = direction === 'previous' ? 'findPrevious' : 'findNext';
    const regex = byId('find-regex').checked;
    if (regex) {
      try { new RegExp(term); } catch {
        pane.finder.clearDecorations();
        byId('find-result').textContent = '正则表达式无效';
        return;
      }
    }
    pane.searchableQuery = true;
    const found = pane.finder[method](term, { decorations, incremental, regex,
      caseSensitive: byId('find-case').checked, wholeWord: byId('find-word').checked });
    if (!found) byId('find-result').textContent = '无匹配';
  }

  function showSearch(open) {
    const pane = activePane();
    if (!pane) return;
    byId('find-bar').hidden = !open;
    byId('find').setAttribute('aria-expanded', String(open));
    if (open) {
      const selected = pane.terminal.getSelection();
      if (selected && selected.length <= 512 && !/[\r\n]/.test(selected)) byId('find-input').value = selected;
      byId('find-input').focus();
      byId('find-input').select();
      search('previous', true);
    } else {
      for (const item of panes.values()) item.finder.clearDecorations();
      pane.terminal.focus();
    }
  }

  async function copy() {
    const pane = activePane();
    if (pane?.terminal.hasSelection()) {
      await api.copy(pane.terminal.getSelection());
      if (activePane() === pane) pane.terminal.focus();
    }
  }

  async function paste() {
    const pane = activePane();
    if (!pane || pane.state !== 'running') return;
    const data = await api.paste();
    if (pane !== activePane() || pane.state !== 'running') return;
    pane.terminal.focus();
    window.BrclioTerminalHistory.rememberPaste(pane.terminal, data);
    paneTools.paste(pane, data);
  }

  async function chooseDirectory() {
    const value = await api.chooseDirectory();
    if (!value) return;
    nextDirectory = value;
    byId('directory-label').textContent = value;
    byId('directory').title = '新会话起始目录 · ' + value;
    activePane()?.terminal.focus();
  }

  function cycleTab(delta, focusTab = false) {
    const list = tabGroups.visibleTabs();
    if (!list.length) return;
    const next = list[(list.indexOf(currentTab) + delta + list.length) % list.length];
    selectTab(next, !focusTab);
    if (focusTab) next.button.focus();
  }

  function shortcuts(event) {
    if (document.querySelector('dialog[open]')) return;
    if (bufferKeyboard(event)) return;
    if (event.isComposing) return;
    const key = event.key.toLowerCase();
    const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && event.shiftKey && !event.metaKey;
    const form = event.target.matches('input, select, textarea:not(.xterm-helper-textarea)');
    if (!form && customKey(event)) return;
    if (!form && paneTools.shortcut(event)) return;
    let action;
    if (event.ctrlKey && !event.metaKey && !event.altKey && key === 'tab') action = () => cycleTab(event.shiftKey ? -1 : 1);
    else if (event.target.closest('[role="tab"]') && ['arrowleft', 'arrowright'].includes(key)) action = () => cycleTab(key === 'arrowleft' ? -1 : 1, true);
    else if (event.key === 'Escape' && !byId('find-bar').hidden) action = () => showSearch(false);
    else if (mod && key === 't' && !event.altKey) action = newTab;
    else if (mod && key === 'w' && !event.altKey) action = closeActive;
    else if (mod && key === 'f' && !event.altKey) action = () => showSearch(true);
    else if (!form && mod && key === 'd') {
      const down = mac ? event.shiftKey : event.altKey;
      action = () => splitPane(down ? 'down' : 'right');
    }
    else if (!form && mod && !event.altKey && key === 'c') action = () => copy().catch(report);
    else if (!form && mod && !event.altKey && key === 'v') action = () => paste().catch(report);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) action();
  }

  if (!api || !window.Terminal || !window.FitAddon || !window.SearchAddon) {
    message('终端组件未能加载，请重新打开 Brclio 终端。', true);
    for (const control of document.querySelectorAll('button, select')) control.disabled = true;
    return;
  }
  window.BrclioTerminalHistory.bind(activePane, paneTools.pasteOnly);
  window.BrclioLiveView.bind(activePane,paneTools.pasteOnly);
  const removeData = api.onData(({id, data}) => {
    const pane = panes.get(id);
    if (pane) window.BrclioLiveView.output(pane,data);
    if (pane) pane.terminal.write(data, () => { if (panes.has(id)) api.ack(id, data.length); });
  });
  const removeExit = api.onExit(({id, exitCode, signal, error}) => {
    const pane = panes.get(id);
    if (!pane) return;
    pane.exitCode = exitCode;
    pane.exitSignal = signal;
    if (error) setState(pane, 'error', error);
    else setState(pane, 'exited', '已退出 · ' + (signal ? '信号 ' + signal : '退出码 ' + exitCode));
  });
  window.addEventListener('pagehide', () => {
    closing = true;
    removeData();
    removeExit();
    for (const pane of panes.values()) disposePane(pane);
  }, { once: true });
  window.BrclioArrangements.bind({ document, storage: localStorage,
    snapshot: rememberHosts => window.BrclioArrangements.capture(tabs.values(), currentTab, node => panes.get(node.dataset.id), rememberHosts),
    open: layout => window.BrclioArrangements.restore(layout, { newTab, split: splitPane, selectTab, selectPane,
      liveCount: () => Array.from(panes.values()).filter(pane => ['running','starting','waiting'].includes(pane.state)).length }),
    rename(name) {
      if (!currentTab?.active) throw new Error('请先打开一个终端标签。');
      currentTab.customName = name;
      updateLabel(currentTab.active);
    },
  });
  byId('new-tab').onclick = byId('empty-new').onclick = () => newTab();
  api.onToolbarAction?.(id => {
    if (!document.querySelector('dialog[open]') && ['new-tab', 'split-right', 'split-down', 'find', 'terminal-actions'].includes(id)) {
      byId(id).click();
    }
  });
  byId('split-right').onclick = () => splitPane('right');
  byId('split-down').onclick = () => splitPane('down');
  byId('close-pane').onclick = closeActive;
  byId('find').onclick = () => showSearch(byId('find-bar').hidden);
  byId('find-close').onclick = () => showSearch(false);
  byId('find-next').onclick = () => search();
  byId('find-prev').onclick = () => search('previous');
  byId('find-input').oninput = () => search('previous', true);
  for (const id of ['find-case', 'find-word', 'find-regex']) byId(id).onchange = () => search('previous', true);
  byId('find-input').onkeydown = event => {
    if (event.key === 'Enter') { event.preventDefault(); search(event.shiftKey ? 'previous' : 'next'); }
  };
  byId('copy').onclick = () => copy().catch(report);
  byId('paste').onclick = () => paste().catch(report);
  byId('directory').onclick = () => chooseDirectory().catch(report);
  const actions = byId('actions-dialog');
  const customKey = window.BrclioKeymap({
    newTab: ['新建标签', newTab], close: ['关闭当前窗格', closeActive],
    nextTab: ['下一个标签', () => cycleTab(1)], prevTab: ['上一个标签', () => cycleTab(-1)],
    splitRight: ['左右分屏', () => splitPane('right')], splitDown: ['上下分屏', () => splitPane('down')],
    find: ['搜索当前窗格', () => showSearch(true)], operations: ['打开终端操作', () => byId('terminal-actions').click()],
    presentation: ['弹出或收回终端', () => byId('presentation').click()],
    mark: ['添加标记', () => activePane()?.marks.add()],
    nextMark: ['下一个标记', () => activePane()?.marks.next()], prevMark: ['上一个标记', () => activePane()?.marks.previous()],
  });
  window.BrclioAdvancedPaste({ api, activePane, actions, paste: paneTools.pasteOnly });
  const snippets = window.BrclioSnippets({ activePane, actions, paste: paneTools.pasteOnly });
  window.BrclioCommandLibrary.bind(activePane, paneTools.pasteOnly, snippets.draft, sendInput);
  const filter = byId('actions-filter');
  const actionList = byId('actions-list');
  const actionGroups = [...actionList.querySelectorAll('fieldset, details')];
  const actionLabels = new Map(actionGroups.map(group => {
    // Index the controls once. Output previews, saved hosts and search result
    // buttons can change while the dialog is open and are not action names.
    const words = [];
    for (const child of group.children) {
      if (!child.matches('legend, summary, label, button, p:not([role]), select, textarea, input')) continue;
      const label = child.cloneNode(true);
      for (const select of label.querySelectorAll('select')) select.replaceChildren();
      if (label.tagName !== 'SELECT') words.push(label.textContent);
      words.push(child.getAttribute('aria-label') || '', child.getAttribute('placeholder') || '');
    }
    for (const options of group.querySelectorAll('#transcript-format, #paste-convert, #preset-cursor, #trigger-action, #keymap-action')) {
      if (options.closest('fieldset, details') === group) words.push(options.textContent);
    }
    return [group, words.join(' ').toLowerCase()];
  }));
  const detailsState = new Map();
  function filterActions() {
    const text = filter.value.trim().toLowerCase();
    actionList.scrollTop = 0;
    const matches = actionGroups.filter(group => actionLabels.get(group).includes(text));
    for (const group of actionGroups) {
      group.hidden = Boolean(text) && !matches.some(match => match.contains(group) || group.contains(match));
      if (group.tagName !== 'DETAILS') continue;
      if (text) {
        if (!detailsState.has(group)) detailsState.set(group, group.open);
        group.open = matches.some(match => group.contains(match)) || detailsState.get(group);
      } else if (detailsState.has(group)) {
        if (actions.open || !detailsState.get(group)) group.open = detailsState.get(group);
        detailsState.delete(group);
      }
    }
    byId('actions-empty').hidden = !text || matches.length > 0;
  }
  filter.oninput = filterActions;
  actions.addEventListener('close', () => { filter.value = ''; filterActions(); });
  window.BrclioTranscript.bind(activePane, api);
  const bufferKeyboard = window.BrclioBufferTools({ panes, activePane, dialog: actions, copy: api.copy, paste: paneTools.pasteOnly, message,
    activate: pane => { selectTab(pane.tab); selectPane(pane); } });
  for (const button of actions.querySelectorAll('[data-mark]')) {
    button.onclick = () => {
      actions.close();
      const action = button.dataset.mark;
      const done = activePane()?.marks[action]();
      if (!done) message(action === 'selectOutput' ? '尚无带 Shell 集成标记的命令输出。' : '当前缓冲区没有可用标记。');
    };
  }
  byId('terminal-actions').onclick = () => { inspector.refresh(); locations.render(); tabGroups.render(); actions.showModal(); };
  window.BrclioRemoteConnections.bind(api, activePane, (kind, name, connection, startupSnippet, savedHost) => {
    actions.close();
    const pane = newTab(name, { profile: kind, connection, cwd: nextDirectory, shellIntegration: false });
    pane.savedHost = savedHost;
    if (kind === 'ssh') snippets.startup(startupSnippet, pane);
  });
  const activateConnection = pane => { selectTab(pane.tab); selectPane(pane); };
  window.BrclioSftp.bindTerminals({panes,newTab,activate:activateConnection});
  window.BrclioForwardControls.bind({ newTab, activate: activateConnection, stop(pane) { activateConnection(pane); closeActive(); } });
  window.BrclioIdentityControls.bind({ newTab, activate: activateConnection, stop(pane) { activateConnection(pane); closeActive(); } });
  window.BrclioTerminalSync.bind(api);
  window.BrclioConnectionCenter.bind({ api, newTab });
  window.BrclioVaultControls.bind(api, activePane);
  byId('actions-close').onclick = () => actions.close();
  actions.addEventListener('close', () => {
    const focused = document.activeElement;
    if (!actions.open && (focused === document.body || focused === byId('terminal-actions') || actions.contains(focused))) {
      activePane()?.terminal.focus();
    }
  });
  const displayMode = mode => {
    const control = byId('presentation');
    control.dataset.mode = mode;
    control.textContent = mode === 'window' ? '收回主窗口' : '弹出窗口';
  };
  api.onPresentation(displayMode);
  api.getPresentation().then(displayMode).catch(report);
  byId('presentation').onclick = async event => {
    const control = event.currentTarget;
    control.disabled = true;
    try {
      const result = await api.setPresentation(control.dataset.mode === 'window' ? 'inline' : 'window');
      displayMode(result.presentation);
      activePane()?.terminal.focus();
    } catch (error) { report(error); }
    finally { control.disabled = false; }
  };
  window.addEventListener('keydown', shortcuts, true);
  const modifier = mac ? '⌘' : 'Ctrl + Shift + ';
  const hints = {
    'new-tab': '新建标签 · ' + modifier + 'T', 'split-right': '左右分屏 · ' + modifier + 'D',
    'split-down': '上下分屏 · ' + modifier + (mac ? '⇧' : 'Alt + ') + 'D',
    'close-pane': '关闭当前窗格 · ' + modifier + 'W', find: '查找终端内容 · ' + modifier + 'F',
    copy: '复制所选文本 · ' + modifier + 'C', paste: '粘贴 · ' + modifier + 'V',
  };
  for (const [id, title] of Object.entries(hints)) byId(id).title = title;
  api.profiles().then(profiles => {
    if (closing) return;
    const options = profiles.map(profile => new Option(profile.label, profile.id));
    if (options.length) byId('profile').replaceChildren(...options);
    applySession(appearance.current);
  }).catch(report).finally(() => { if (!closing && !tabs.size) newTab(); });
})();

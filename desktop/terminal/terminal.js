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
  }

  function report(error) {
    const text = error?.message || String(error);
    message(text, true);
  }

  function activePane() { return currentTab?.active; }

  function refreshTools() {
    const pane = activePane();
    for (const id of ['split-right', 'split-down', 'close-pane', 'find']) byId(id).disabled = !pane;
    byId('paste').disabled = !pane || pane.state !== 'running';
    byId('copy').disabled = !pane?.terminal.hasSelection();
    byId('empty').hidden = tabs.size > 0;
  }

  function updateLabel(pane) {
    const name = pane.title || pane.shell || 'Shell';
    pane.caption.textContent = name;
    pane.caption.title = name;
    if (pane.tab.active === pane) {
      const label = pane.tab.number + ' · ' + name;
      pane.tab.name.textContent = label;
      pane.tab.button.title = label;
    }
  }

  function setState(pane, state, detail) {
    pane.state = state;
    pane.detail = detail;
    pane.node.dataset.state = state;
    pane.stateLabel.textContent = state === 'running' ? '' : detail;
    pane.stateLabel.title = detail;
    pane.terminal.options.disableStdin = state === 'exited' || state === 'error';
    if (pane === activePane()) {
      message(detail, state === 'error');
      refreshTools();
    }
  }

  function fit(pane) {
    if (!panes.has(pane.id) || pane.tab !== currentTab || !pane.host.clientHeight || !pane.host.clientWidth) return;
    const size = pane.fitter.proposeDimensions();
    if (size && Number.isFinite(size.cols) && Number.isFinite(size.rows)) {
      pane.terminal.resize(Math.min(1000, size.cols), Math.min(500, size.rows));
    }
  }

  function selectPane(pane, focus = true) {
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
    currentTab = tab;
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

  function newPane(tab, mount) {
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
      theme, fontFamily: '"SFMono-Regular", Consolas, Menlo, "Liberation Mono", monospace',
      fontSize: 14, scrollback: 10000, cursorBlink: true, screenReaderMode: true,
      allowProposedApi: true, allowTransparency: false,
      ...(api.platform === 'win32' && { windowsPty: { backend: 'conpty' } }),
    });
    const fitter = new FitAddon.FitAddon();
    const finder = new SearchAddon.SearchAddon();
    terminal.loadAddon(fitter);
    terminal.loadAddon(finder);
    const pane = { id, tab, node, host, terminal, fitter, finder, caption, stateLabel, input: Promise.resolve() };
    panes.set(id, pane);
    tab.panes.add(pane);
    terminal.open(host);
    terminal.textarea?.setAttribute('aria-label', '终端输入');
    setState(pane, 'starting', '正在启动 Shell…');
    fit(pane);
    const initial = { id, cols: terminal.cols, rows: terminal.rows, profile: byId('profile').value };
    if (nextDirectory) initial.cwd = nextDirectory;
    pane.observer = new ResizeObserver(() => fit(pane));
    pane.observer.observe(host);
    node.addEventListener('pointerdown', event => {
      if (tab.active !== pane) selectPane(pane, false);
      if (heading.contains(event.target)) terminal.focus();
    });
    node.addEventListener('focusin', () => { if (tab.active !== pane) selectPane(pane, false); });
    terminal.onResize(({cols, rows}) => {
      if (pane.state === 'running') api.resize(id, cols, rows).catch(error => { if (panes.has(id) && pane.state === 'running') report(error); });
    });
    terminal.onData(data => sendInput(pane, data));
    terminal.onBinary(data => sendInput(pane, data, true));
    terminal.onSelectionChange(() => { if (activePane() === pane) refreshTools(); });
    terminal.onTitleChange(value => {
      pane.title = value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 160);
      updateLabel(pane);
    });
    finder.onDidChangeResults(({resultIndex, resultCount}) => {
      if (activePane() === pane && !byId('find-bar').hidden && byId('find-input').value) {
        byId('find-result').textContent = resultCount ? (resultIndex + 1) + ' / ' + resultCount : '无匹配';
      }
    });
    selectPane(pane);
    pane.ready = api.create(initial).then(info => {
      if (!panes.has(id)) return api.close(id).catch(() => {});
      pane.shell = info.shell.split(/[\\/]/).pop();
      if (Number.isInteger(info.windowsBuild)) terminal.options.windowsPty = { backend: 'conpty', buildNumber: info.windowsBuild };
      updateLabel(pane);
      if (pane.state !== 'starting') return;
      setState(pane, 'running', pane.shell + ' · PID ' + info.pid + (info.cwd ? ' · ' + info.cwd : ''));
      if (terminal.cols !== initial.cols || terminal.rows !== initial.rows) {
        return api.resize(id, terminal.cols, terminal.rows).catch(error => { if (pane.state === 'running') report(error); });
      }
    }).catch(error => {
      if (panes.has(id)) setState(pane, 'error', error.message || '无法启动会话');
    });
    return pane;
  }

  function newTab() {
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
    const tab = { number, panel, header, button, name, panes: new Set(), active: null };
    tabs.set(number, tab);
    button.addEventListener('click', () => selectTab(tab));
    close.addEventListener('click', () => closeTab(tab));
    selectTab(tab);
    newPane(tab, panel);
  }

  function setFraction(split, value) {
    const fraction = Math.max(.1, Math.min(.9, value));
    split.firstElementChild.style.flex = fraction + ' 1 0px';
    split.lastElementChild.style.flex = (1 - fraction) + ' 1 0px';
    split.children[1].setAttribute('aria-valuenow', String(Math.round(100 * fraction)));
  }

  function splitPane(direction) {
    const pane = activePane();
    if (!pane) return;
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
    newPane(pane.tab, split);
    setFraction(split, .5);
  }

  function disposePane(pane) {
    panes.delete(pane.id);
    pane.tab.panes.delete(pane);
    pane.observer.disconnect();
    const wasRunning = pane.state === 'running' || pane.state === 'starting';
    pane.state = 'closed';
    pane.terminal.dispose();
    if (wasRunning) api.close(pane.id).catch(error => { if (!closing) report(error); });
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
      currentTab = null;
      const next = list[index + 1] || list[index - 1];
      if (next) selectTab(next);
      else {
        byId('find-bar').hidden = true;
        byId('find').setAttribute('aria-expanded', 'false');
        message('当前没有会话');
        byId('empty').hidden = false;
        byId('empty-new').focus();
      }
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
    if (!term) {
      pane.finder.clearDecorations();
      pane.terminal.clearSelection();
      byId('find-result').textContent = '';
      return;
    }
    const method = direction === 'previous' ? 'findPrevious' : 'findNext';
    const found = pane.finder[method](term, { decorations, incremental });
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
    pane.terminal.paste(data);
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
    const list = [...tabs.values()];
    if (!list.length) return;
    const next = list[(list.indexOf(currentTab) + delta + list.length) % list.length];
    selectTab(next, !focusTab);
    if (focusTab) next.button.focus();
  }

  function shortcuts(event) {
    if (event.isComposing) return;
    const key = event.key.toLowerCase();
    const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && event.shiftKey && !event.metaKey;
    const form = event.target.matches('input, select, textarea:not(.xterm-helper-textarea)');
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
  const removeData = api.onData(({id, data}) => {
    const pane = panes.get(id);
    if (pane) pane.terminal.write(data, () => { if (panes.has(id)) api.ack(id, data.length); });
  });
  const removeExit = api.onExit(({id, exitCode, signal}) => {
    const pane = panes.get(id);
    if (pane) setState(pane, 'exited', '已退出 · ' + (signal ? '信号 ' + signal : '退出码 ' + exitCode));
  });
  window.addEventListener('pagehide', () => {
    closing = true;
    removeData();
    removeExit();
    for (const pane of panes.values()) disposePane(pane);
  }, { once: true });
  byId('new-tab').onclick = byId('empty-new').onclick = newTab;
  byId('split-right').onclick = () => splitPane('right');
  byId('split-down').onclick = () => splitPane('down');
  byId('close-pane').onclick = closeActive;
  byId('find').onclick = () => showSearch(byId('find-bar').hidden);
  byId('find-close').onclick = () => showSearch(false);
  byId('find-next').onclick = () => search();
  byId('find-prev').onclick = () => search('previous');
  byId('find-input').oninput = () => search('previous', true);
  byId('find-input').onkeydown = event => {
    if (event.key === 'Enter') { event.preventDefault(); search(event.shiftKey ? 'previous' : 'next'); }
  };
  byId('copy').onclick = () => copy().catch(report);
  byId('paste').onclick = () => paste().catch(report);
  byId('directory').onclick = () => chooseDirectory().catch(report);
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
  }).catch(report);
  newTab();
})();

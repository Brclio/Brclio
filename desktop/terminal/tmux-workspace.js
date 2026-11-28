'use strict';

(() => {
  const api = window.brclioTerminal;
  const protocol = window.BrclioTmuxProtocol;
  const $ = id => document.getElementById('tmux-' + id);
  const dialog = $('dialog');
  const frame = $('panes');
  const status = message => { $('status').textContent = message; };
  const encode = new TextEncoder();
  const options = { fontSize: 13, fontFamily: 'Consolas, Menlo, monospace', allowProposedApi: true,
    screenReaderMode: true, theme: { background: '#181b25', foreground: '#e3e7ef' } };
  let connection;
  function detach() {
    const c = connection;
    if (!c) return;
    connection = undefined;
    clearTimeout(c.refreshTimer);
    clearTimeout(c.startupTimer);
    c.observer.disconnect();
    c.gauge.dispose();
    for (const pane of c.panes.values()) pane.terminal.dispose();
    frame.replaceChildren();
    $('tabs').replaceChildren();
    for (const id of ['new', 'right', 'down']) $(id).disabled = true;
    c.control.end();
    // Closing the client PTY detaches it. The tmux server owns every pane.
    api.close(c.id).catch(() => {});
  }
  function send(c, text, received) {
    return c.control.command(text, received).catch(error => {
      if (connection === c) status(error.message);
    });
  }
  function display(c) {
    const windows = new Map();
    for (const pane of c.panes.values()) windows.set(pane.meta.window, pane.meta.name);
    if (!windows.has(c.shown)) c.shown = windows.keys().next().value;
    const shownPanes = [...c.panes.values()].filter(pane => pane.meta.window === c.shown);
    if (!shownPanes.some(pane => pane.meta.pane === c.active)) c.active = shownPanes[0]?.meta.pane;
    $('tabs').replaceChildren(...Array.from(windows, ([id, name]) => {
      const button = document.createElement('button');
      button.textContent = name || id;
      button.classList.toggle('selected', id === c.shown);
      button.setAttribute('aria-pressed', String(id === c.shown));
      button.onclick = () => {
        c.shown = id;
        display(c);
        void send(c, 'select-window -t ' + id);
        c.panes.get(c.active)?.terminal.focus();
      };
      return button;
    }));
    for (const pane of c.panes.values()) {
      pane.host.hidden = pane.meta.window !== c.shown;
      pane.host.classList.toggle('active', pane.meta.pane === c.active);
    }
    for (const id of ['new', 'right', 'down']) $(id).disabled = !c.active;
  }
  function addPane(c, meta) {
    const host = document.createElement('section');
    host.className = 'tmux-pane';
    host.dataset.pane = meta.pane;
    host.setAttribute('aria-label', 'tmux 窗格 ' + meta.pane);
    frame.append(host);
    const terminal = new Terminal({ ...options, cols: meta.width, rows: meta.height });
    const pane = { meta, terminal, host, input: Promise.resolve(), listening: false };
    c.panes.set(meta.pane, pane);
    terminal.open(host);
    window.BrclioTerminalOutput.activate(terminal);
    terminal.options.disableStdin = true;
    function input(bytes) {
      pane.input = pane.input.then(async () => {
        for (let i = 0; i < bytes.length && connection === c && c.panes.get(meta.pane) === pane; i += 256) {
          const hex = Array.from(bytes.subarray(i, i + 256), byte => byte.toString(16).padStart(2, '0')).join(' ');
          await c.control.command('send-keys -H -t ' + meta.pane + ' ' + hex);
        }
      }).catch(error => { if (connection === c) status(error.message); });
    }
    terminal.onData(text => input(encode.encode(text)));
    terminal.onBinary(text => input(Uint8Array.from(text, ch => ch.charCodeAt(0))));
    host.addEventListener('focusin', () => {
      if (c.active !== meta.pane) {
        c.active = meta.pane;
        display(c);
        void send(c, 'select-pane -t ' + meta.pane);
      }
    });
    return pane;
  }
  function layout(c, lines) {
    if (c !== connection) return;
    const entries = protocol.rows(lines);
    const present = new Set(entries.map(meta => meta.pane));
    for (const [id, pane] of c.panes) {
      if (!present.has(id)) { pane.terminal.dispose(); pane.host.remove(); c.panes.delete(id); }
    }
    for (const meta of entries) {
      let pane = c.panes.get(meta.pane);
      if (!pane) {
        pane = addPane(c, meta);
        // Hydrate the current screen once. The guarded reply is consumed at
        // its exact stream boundary before any subsequent %output is applied.
        void send(c, 'capture-pane -ep -t ' + meta.pane, screen => {
          if (c.panes.get(meta.pane) !== pane) return;
          const view = screen.join('\r\n') + '\x1b[' + (meta.y + 1) + ';' + (meta.x + 1) + 'H';
          pane.terminal.write(Uint8Array.from(view, ch => ch.charCodeAt(0)));
          pane.listening = true;
          pane.terminal.options.disableStdin = false;
          if (meta.pane === c.active) pane.terminal.focus();
        });
      }
      pane.meta = meta;
      const rect = { left: meta.left / meta.totalWidth, top: meta.top / meta.totalHeight,
        width: meta.width / meta.totalWidth, height: meta.height / meta.totalHeight };
      for (const [key, fraction] of Object.entries(rect)) pane.host.style[key] = (fraction * 100) + '%';
      if (pane.terminal.cols !== meta.width || pane.terminal.rows !== meta.height) pane.terminal.resize(meta.width, meta.height);
    }
    display(c);
    status('tmux · ' + entries.length + ' 个窗格' + (lines.length !== entries.length ? ' · 部分窗格超过显示范围' : ''));
  }
  function refresh(c) {
    if (connection !== c || c.refreshTimer) return;
    c.refreshTimer = setTimeout(() => {
      c.refreshTimer = null;
      if (connection === c) void send(c, protocol.list, lines => layout(c, lines));
    }, 35);
  }
  function resize(c) {
    if (!c.ready || connection !== c) return;
    const size = c.fitter.proposeDimensions();
    if (!size || size.cols < 2 || size.rows < 1) return;
    const dimensions = Math.min(1000, size.cols) + ',' + Math.min(500, size.rows);
    if (dimensions !== c.size) { c.size = dimensions; void send(c, 'refresh-client -C ' + dimensions); }
  }
  $('connect').onclick = () => {
    const name = $('name').value.trim();
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$/.test(name)) {
      $('name').setCustomValidity('请输入 1 到 64 个字母、数字、下划线或连字符。');
      $('name').reportValidity();
      return;
    }
    document.getElementById('actions-dialog').close();
    detach();
    dialog.showModal();
    $('title').textContent = 'tmux · ' + name;
    status('正在连接 tmux…');
    const gaugeNode = document.createElement('div');
    gaugeNode.className = 'tmux-gauge';
    gaugeNode.setAttribute('aria-hidden', 'true');
    frame.append(gaugeNode);
    const gauge = new Terminal(options);
    const fitter = new FitAddon.FitAddon();
    gauge.loadAddon(fitter);
    gauge.open(gaugeNode);
    const c = { id: crypto.randomUUID(), panes: new Map(), gauge, fitter };
    connection = c;
    c.control = protocol.control({
      framed: api.platform !== 'win32',
      write: text => api.write(c.id, text),
      ready() {
        c.ready = true;
        clearTimeout(c.startupTimer);
        resize(c);
        refresh(c);
      },
      notify: () => refresh(c),
      output(id, bytes) {
        const pane = c.panes.get(id);
        if (pane?.listening) c.drain.push(new Promise(resolve => pane.terminal.write(bytes, resolve)));
      },
      ended(reason) { if (connection === c) { detach(); status(reason); } },
    });
    c.observer = new ResizeObserver(() => resize(c));
    c.observer.observe(frame);
    c.startupTimer = setTimeout(() => { if (connection === c) c.control.end('未收到 tmux 控制模式握手，请检查本机或 WSL 中是否已安装 tmux。'); }, 12000);
    display(c);
    api.create({ id: c.id, profile: 'tmux-control', tmuxSession: name }).then(() => {
      if (connection !== c) return api.close(c.id);
    }).catch(error => { if (connection === c) c.control.end(error.message); });
  };
  $('name').oninput = () => $('name').setCustomValidity('');
  $('new').onclick = () => { if (connection) void send(connection, 'new-window'); };
  for (const [id, flag] of [['right', '-h'], ['down', '-v']]) {
    $(id).onclick = () => { if (connection?.active) void send(connection, 'split-window ' + flag + ' -t ' + connection.active); };
  }
  $('detach').onclick = () => dialog.close();
  dialog.addEventListener('close', detach);
  api.onData(({id, data}) => {
    const c = connection;
    if (c?.id !== id) return;
    c.drain = [];
    c.control.push(data);
    Promise.all(c.drain).then(() => { if (connection === c) api.ack(id, data.length); });
  });
  api.onExit(({id, error, exitCode}) => {
    if (connection?.id !== id) return;
    connection.control.end(error || (exitCode || !connection.ready ? '未能连接 tmux，请检查本机或 WSL 中的 tmux。' : 'tmux 已分离'));
  });
  window.addEventListener('pagehide', detach, { once: true });
})();

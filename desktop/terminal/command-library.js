'use strict';

window.BrclioCommandLibrary = (() => {
  const key = 'brclio.terminal.command-history.v1', suggestKey = 'brclio.terminal.command-suggest.v1';
  const paneAccounts = new WeakMap();
  let suggestEnabled = false, candidates, accountRevision = 0;
  const storage = () => window.BrclioTerminalPartitions.storage;
  const read = () => JSON.parse(storage().getItem(key) || '{"enabled":false,"entries":[]}');
  const write = data => storage().setItem(key,JSON.stringify(data));
  let dialog, active, paste, draft, completeInShell, editCommand;
  const field = name => dialog.querySelector('#command-library-' + name);
  const eligible = launch => !launch?.profile || ['default','zsh','bash','powershell','pwsh','ssh'].includes(launch.profile);
  const builtin = ['pwd','cd','ls','dir','Get-Location','Get-ChildItem','git status','git diff','git log','whoami'];
  const safeLine = text => typeof text === 'string' && text.length > 0 && text.length <= 2048 && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(text);
  function paneAccount() {
    const partitions = window.BrclioTerminalPartitions;
    const revision = accountRevision;
    let owner = partitions.ready ? partitions.owner : undefined;
    return () => {
      if (!partitions.ready) return false;
      if (owner === undefined) {
        if (revision !== accountRevision) return false;
        owner = partitions.owner;
      }
      return owner === partitions.owner;
    };
  }
  function recorder(launch) {
    if (!eligible(launch)) return;
    const sameAccount = paneAccount();
    return {
      suggestions: () => sameAccount() && suggestEnabled,
      enabled() {
        try { return sameAccount() && read().enabled === true; } catch { return false; }
      },
      add(line) {
        // Leading-space commands can be deliberately excluded from shell history.
        if (!sameAccount() || !safeLine(line) || /^\s/.test(line)) return;
        const text = line.trimEnd();
        try {
          const state = read();
          if (!state.enabled || !text) return;
          state.entries = [text,...state.entries.filter(old => old !== text)].slice(0,200);
          write(state); candidates = undefined;
        } catch { /* A full local store must never interrupt shell output. */ }
      },
    };
  }
  function selectionChanged() {
    const selected = field('list').selectedOptions[0];
    const pane = active();
    field('insert').disabled = !selected || pane?.state !== 'running' || !paneAccounts.get(pane)?.();
    field('remember').disabled = !selected || !!selected.dataset.snippet;
    field('edit').disabled = !selected?.dataset.snippet;
  }
  function render(selectedId) {
    const state = read(), query = field('query').value.trim().toLowerCase();
    const source = field('source').value;
    field('enable').checked = state.enabled;
    field('suggest').checked = suggestEnabled;
    const model = window.BrclioSnippetModel;
    const snippets = model.read(storage()).filter(s => s.kind === 'snippet');
    const saved = source === 'all' || source === 'saved' ? model.search(snippets, query, null) : [];
    const items = new Map();
    for (const [label, text] of [
      ...(source === 'all' || source === 'history' ? state.entries.map(s => ['历史',s]) : []),
      ...(source === 'all' || source === 'builtin' ? builtin.map(s => ['命令',s]) : []),
    ]) {
      if (safeLine(text) && !items.has(text) && (label + ' ' + text).toLowerCase().includes(query)) items.set(text,label);
    }
    const list = field('list');
    const options = saved.map(item => {
      const label = model.label(item);
      const preview = item.text === label ? '' : ' · ' + item.text.replace(/\s+/g, ' ').slice(0, 100);
      const option = new Option('已收藏 · ' + label + preview, item.id);
      option.dataset.snippet = item.id;
      return option;
    });
    const savedText = new Map(snippets.filter(item => !item.template).map(item => [item.text, item.id]));
    const displayed = new Set(saved.filter(item => !item.template).map(item => item.text));
    for (const [text, label] of items) {
      if (displayed.has(text)) continue;
      const option = new Option(label + ' · ' + text, text);
      if (savedText.has(text)) option.dataset.snippet = savedText.get(text);
      options.push(option);
    }
    list.replaceChildren(...options);
    if (list.length) list.selectedIndex = Math.max(0, options.findIndex(option => selectedId && option.dataset.snippet === selectedId));
    selectionChanged();
    field('clear').disabled = !state.entries.length;
  }
  function remember() {
    const option = field('list').selectedOptions[0];
    if (!option || option.dataset.snippet || !safeLine(option.value)) return;
    const model = window.BrclioSnippetModel, text = option.value;
    try {
      const items = model.read(storage());
      let item = items.find(entry => entry.kind === 'snippet' && !entry.template && entry.text === text);
      if (!item) {
        const names = new Set(items.filter(entry => entry.kind === 'snippet' && !entry.package).map(entry => entry.name));
        const title = text.trim();
        let suffix = '', name;
        for (let n = 2; ; n++) {
          name = title.slice(0, 80 - suffix.length).replace(/[\uD800-\uDBFF]$/u, '') + suffix;
          if (!names.has(name)) break;
          suffix = ' (' + n + ')';
        }
        item = model.normalize({id:crypto.randomUUID(), kind:'snippet', name, text});
        model.store(storage(), [...items, item]);
        window.dispatchEvent(new Event('brclio-snippets-changed'));
      }
      field('query').value = '';
      field('source').value = 'saved';
      render(item.id);
      field('status').textContent = '已收藏。';
    } catch (error) { field('status').textContent = error.message; }
  }
  function attach(pane) {
    const sameAccount = paneAccount();
    paneAccounts.set(pane, sameAccount);
    if (!eligible(pane.launch)) return;
    const button = document.createElement('button');
    button.type = 'button'; button.hidden = true; button.className = 'command-completion';
    let suggestion;
    function refresh() {
      suggestion = undefined; button.hidden = true;
      if (!suggestEnabled || !sameAccount() || pane !== active() || pane.state !== 'running') return;
      const prefix = pane.marks.inputPrefix();
      if (!safeLine(prefix) || prefix.length < 2 || /^\s/.test(prefix)) return;
      if (!candidates) {
        const items = window.BrclioSnippetModel.read(storage()).filter(item => item.kind === 'snippet' && !item.text.includes('{{'));
        candidates = [...new Set([...read().entries,...items.map(i => i.text),...builtin])].filter(safeLine);
      }
      const text = candidates.find(item => item.length > prefix.length && item.startsWith(prefix));
      if (text) {
        suggestion = {prefix,text};
        button.textContent = text;
        button.title = '填入补全建议';
      } else if (/^[\w.-]+\s+\S.*$/u.test(prefix)) {
        suggestion = {prefix};
        button.textContent = '补全路径或参数';
        button.title = '在当前窗格按一次 Tab，使用此 Shell 的实时补全';
      } else return;
      button.hidden = false;
    }
    button.onmousedown = event => event.preventDefault();
    button.onclick = () => {
      const next = suggestion;
      if (next && pane === active() && pane.marks.inputPrefix() === next.prefix) {
        if (next.text) paste(pane,next.text.slice(next.prefix.length));
        else completeInShell(pane,'\t');
      }
      pane.terminal.focus();
    };
    pane.node.append(button);
    const parsed = pane.terminal.onWriteParsed(refresh);
    window.addEventListener('brclio-terminal-suggestions-changed',refresh);
    pane.terminal.loadAddon({activate() {},dispose() {
      parsed.dispose(); window.removeEventListener('brclio-terminal-suggestions-changed',refresh); button.remove();
    }});
  }

  function preferences() {
    candidates = undefined;
    try { suggestEnabled = storage().getItem(suggestKey) === 'true'; } catch { suggestEnabled = false; }
    window.dispatchEvent(new Event('brclio-terminal-suggestions-changed'));
  }
  function needsShellIntegration() {
    try { return suggestEnabled || read().enabled === true; } catch { return false; }
  }
  window.addEventListener('brclio-terminal-account-changed', () => {
    if (!window.BrclioTerminalPartitions.ready) accountRevision++;
    preferences();
  });
  window.addEventListener('brclio-snippets-changed',preferences);
  function init() {
    dialog = document.createElement('dialog');
    dialog.className = 'terminal-network-dialog'; dialog.id = 'command-library';
    dialog.setAttribute('aria-labelledby','command-library-title');
    dialog.innerHTML = `<div class="dialog-head"><h2 id="command-library-title">快捷命令</h2><button id="command-library-close">关闭</button></div>
      <div class="forward-grid"><label>搜索命令<input type="search" id="command-library-query" placeholder="命令、名称或剪藏包" autocomplete="off" spellcheck="false"></label>
      <label>来源<select id="command-library-source"><option value="all">全部</option><option value="saved">已收藏</option><option value="history">命令历史</option><option value="builtin">内置命令</option></select></label>
      <label class="forward-wide">匹配项<select size="6" id="command-library-list"></select></label></div>
      <div class="network-actions"><button class="primary" id="command-library-insert">填入当前窗格</button><button id="command-library-remember">收藏此命令</button><button id="command-library-new">新建命令</button><button id="command-library-edit">编辑收藏</button></div>
      <p id="command-library-status" role="status"></p>
      <label><input type="checkbox" id="command-library-enable">在此设备记录命令历史</label>
      <label><input type="checkbox" id="command-library-suggest">输入时显示补全建议</label>
      <p class="forward-hint">开启记录或补全后，新建本地标签即可使用支持的 Shell 集成。SSH 会话需要远端提供命令标记。历史最多保留 200 条单行命令，可能包含敏感参数，关闭记录会清空历史。收藏可在「个人剪藏同步」中开启同步。</p>
      <button id="command-library-clear">清空命令历史</button>`;
    document.body.append(dialog);
    field('close').onclick = () => dialog.close();
    field('enable').onchange = () => { write({enabled:field('enable').checked,entries:[]}); candidates = undefined; render(); };
    field('suggest').onchange = () => {
      suggestEnabled = field('suggest').checked;
      storage().setItem(suggestKey,String(suggestEnabled));
      candidates = undefined;
      window.dispatchEvent(new Event('brclio-terminal-suggestions-changed'));
    };
    field('query').oninput = field('source').onchange = () => { field('status').textContent = ''; render(); };
    field('list').onchange = selectionChanged;
    field('remember').onclick = remember;
    field('new').onclick = () => { dialog.close(); editCommand(); };
    field('edit').onclick = () => {
      const id = field('list').selectedOptions[0]?.dataset.snippet;
      if (id) { dialog.close(); editCommand(id); }
    };
    field('clear').onclick = () => { write({enabled:read().enabled,entries:[]}); candidates = undefined; render(); };
    field('insert').onclick = () => {
      const pane = active(), value = field('list').value;
      if (!paneAccounts.get(pane)?.() || pane?.state !== 'running') return;
      const id = field('list').selectedOptions[0]?.dataset.snippet;
      if (id) {
        const item = window.BrclioSnippetModel.read(storage()).find(entry => entry.id === id && entry.kind === 'snippet');
        if (!item) { render(); return; }
        dialog.close();
        if (item.template || !safeLine(item.text)) draft(item, pane);
        else { paste(pane, item.text); pane.terminal.focus(); }
        return;
      }
      if (safeLine(value)) { dialog.close(); paste(pane,value); pane.terminal.focus(); }
    };
    field('list').ondblclick = () => field('insert').click();
    field('list').onkeydown = event => {
      if (event.key === 'Enter') { event.preventDefault(); field('insert').click(); }
    };
    dialog.addEventListener('close', () => {
      if (!dialog.open) { field('query').value = ''; field('list').replaceChildren(); field('status').textContent = ''; }
    });
    window.addEventListener('brclio-terminal-account-changed', () => { if (dialog.open) dialog.close(); });
  }
  function open() {
    if (!dialog) init();
    field('query').value = ''; field('source').value = 'all'; render(); dialog.showModal(); field('query').focus();
  }
  return { recorder, attach, open, needsShellIntegration, bind(activePane, pasteOnly, openDraft, sendInput, editSnippet) {
    active = activePane; paste = pasteOnly; draft = openDraft; completeInShell = sendInput; editCommand = editSnippet; preferences();
  } };
})();

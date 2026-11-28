'use strict';

window.BrclioCommandLibrary = (() => {
  const key = 'brclio.terminal.command-history.v1', suggestKey = 'brclio.terminal.command-suggest.v1';
  let suggestEnabled = false, candidates;
  const storage = () => window.BrclioTerminalPartitions.storage;
  const read = () => JSON.parse(storage().getItem(key) || '{"enabled":false,"entries":[]}');
  const write = data => storage().setItem(key,JSON.stringify(data));
  let dialog, active, paste, draft, completeInShell;
  const field = name => dialog.querySelector('#command-library-' + name);
  const eligible = launch => !launch?.profile || ['default','zsh','bash','powershell','pwsh','ssh'].includes(launch.profile);
  const builtin = ['pwd','cd','ls','dir','Get-Location','Get-ChildItem','git status','git diff','git log','whoami'];
  const safeLine = text => typeof text === 'string' && text.length > 0 && text.length <= 2048 && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(text);
  function recorder(launch) {
    if (!eligible(launch)) return;
    return {
      suggestions: () => suggestEnabled,
      enabled() {
        try { return read().enabled === true; } catch { return false; }
      },
      add(line) {
        // Leading-space commands can be deliberately excluded from shell history.
        if (!safeLine(line) || /^\s/.test(line)) return;
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
  function render() {
    const state = read(), query = field('query').value.trim().toLowerCase();
    field('enable').checked = state.enabled;
    field('suggest').checked = suggestEnabled;
    const model = window.BrclioSnippetModel;
    const saved = model.search(model.read(storage()).filter(s => s.kind === 'snippet'), query, null);
    const items = new Map();
    for (const [label, text] of [
      ...state.entries.map(s => ['历史',s]),
      ...builtin.map(s => ['命令',s]),
    ]) {
      if (safeLine(text) && !items.has(text) && (label + ' ' + text).toLowerCase().includes(query)) items.set(text,label);
    }
    const list = field('list');
    const options = saved.map(item => {
      const option = new Option('剪藏 · ' + model.label(item) + ' · ' + item.text.replace(/\s+/g, ' ').slice(0, 100), item.id);
      option.dataset.snippet = item.id;
      return option;
    });
    list.replaceChildren(...options, ...[...items].map(([s,label]) => new Option(label + ' · ' + s, s)));
    if (list.length) list.selectedIndex = 0;
    field('insert').disabled = !list.length || active()?.state !== 'running';
    field('clear').disabled = !state.entries.length;
  }
  function attach(pane) {
    if (!eligible(pane.launch)) return;
    const button = document.createElement('button');
    button.type = 'button'; button.hidden = true; button.className = 'command-completion';
    let suggestion;
    function refresh() {
      suggestion = undefined; button.hidden = true;
      if (!suggestEnabled || pane !== active() || pane.state !== 'running') return;
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
  window.addEventListener('brclio-terminal-account-changed',preferences);
  window.addEventListener('brclio-snippets-changed',preferences);
  function init() {
    dialog = document.createElement('dialog');
    dialog.className = 'terminal-network-dialog'; dialog.id = 'command-library';
    dialog.setAttribute('aria-labelledby','command-library-title');
    dialog.innerHTML = `<div class="dialog-head"><h2 id="command-library-title">命令历史与补全</h2><button id="command-library-close">关闭</button></div>
      <label><input type="checkbox" id="command-library-suggest">在带 Shell 集成标记的提示符显示补全建议</label>
      <label><input type="checkbox" id="command-library-enable">在此设备记录命令历史</label>
      <p class="forward-hint">开启后，本账号最多保留 200 条带 Shell 集成标记的单行命令。命令参数可能包含敏感信息。关闭开关会清空历史。</p>
      <div class="forward-grid"><label class="forward-wide">搜索历史、剪藏或常用命令<input id="command-library-query" autocomplete="off" spellcheck="false"></label>
      <label class="forward-wide">匹配项<select size="6" id="command-library-list"></select></label></div>
      <div class="network-actions"><button id="command-library-insert">填入当前窗格</button><button id="command-library-clear">清空命令历史</button></div>`;
    document.body.append(dialog);
    field('close').onclick = () => dialog.close();
    field('enable').onchange = () => { write({enabled:field('enable').checked,entries:[]}); candidates = undefined; render(); };
    field('suggest').onchange = () => {
      suggestEnabled = field('suggest').checked;
      storage().setItem(suggestKey,String(suggestEnabled));
      candidates = undefined;
      window.dispatchEvent(new Event('brclio-terminal-suggestions-changed'));
    };
    field('query').oninput = render;
    field('clear').onclick = () => { write({enabled:read().enabled,entries:[]}); candidates = undefined; render(); };
    field('insert').onclick = () => {
      const pane = active(), value = field('list').value;
      const id = field('list').selectedOptions[0]?.dataset.snippet;
      if (id && pane?.state === 'running') {
        const item = window.BrclioSnippetModel.read(storage()).find(entry => entry.id === id && entry.kind === 'snippet');
        if (!item) { render(); return; }
        dialog.close();
        if (item.template || !safeLine(item.text)) draft(item, pane);
        else { paste(pane, item.text); pane.terminal.focus(); }
        return;
      }
      if (pane?.state === 'running' && safeLine(value)) { dialog.close(); paste(pane,value); pane.terminal.focus(); }
    };
    field('list').ondblclick = () => field('insert').click();
    dialog.addEventListener('close', () => { field('query').value = ''; field('list').replaceChildren(); });
    window.addEventListener('brclio-terminal-account-changed', () => { if (dialog.open) dialog.close(); });
  }
  function open() {
    if (!dialog) init();
    field('query').value = ''; render(); dialog.showModal(); field('query').focus();
  }
  return { recorder, attach, open, bind(activePane, pasteOnly, openDraft, sendInput) {
    active = activePane; paste = pasteOnly; draft = openDraft; completeInShell = sendInput; preferences();
  } };
})();

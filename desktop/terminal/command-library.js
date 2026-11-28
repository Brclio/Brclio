'use strict';

window.BrclioCommandLibrary = (() => {
  const key = 'brclio.terminal.command-history.v1', suggestKey = 'brclio.terminal.command-suggest.v1';
  const paneAccounts = new WeakMap();
  let suggestEnabled = false, candidates, accountRevision = 0;
  const storage = () => window.BrclioTerminalPartitions.storage;
  const read = () => JSON.parse(storage().getItem(key) || '{"enabled":false,"entries":[]}');
  const write = data => storage().setItem(key,JSON.stringify(data));
  let panel, active, paste, draft, completeInShell, editing, dismissDraft;
  let visible = false;
  const field = name => panel.querySelector('#command-library-' + name);
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
          if (visible && !field('browse').hidden) render(selectedOption()?.value);
        } catch { /* A full local store must never interrupt shell output. */ }
      },
    };
  }
  const selectedOption = () => field('list').querySelector('[aria-selected="true"]');
  function refreshPane() {
    if (!visible) return;
    const selected = selectedOption(), pane = active();
    const ready = window.BrclioTerminalPartitions.ready;
    field('insert').disabled = !selected || pane?.state !== 'running' || !paneAccounts.get(pane)?.();
    field('remember').disabled = !selected || !!selected.dataset.snippet || !ready;
    field('edit').disabled = !selected?.dataset.snippet;
    for (const id of ['new', 'enable', 'suggest']) field(id).disabled = !ready;
  }
  function select(option) {
    const list = field('list');
    selectedOption()?.setAttribute('aria-selected', 'false');
    if (option) {
      option.setAttribute('aria-selected', 'true');
      list.setAttribute('aria-activedescendant', option.id);
    } else list.removeAttribute('aria-activedescendant');
    refreshPane();
  }
  function row(kind, title, text, value, id) {
    const option = document.createElement('div');
    option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false');
    option.setAttribute('aria-label', kind + ' · ' + title);
    option.value = value;
    if (id) option.dataset.snippet = id;
    const name = document.createElement('span');
    name.className = 'command-name'; name.textContent = title;
    option.append(name);
    if (field('source').value === 'all') {
      const origin = document.createElement('small');
      origin.textContent = kind;
      option.append(origin);
    }
    if (text && title !== text) {
      const preview = document.createElement('code');
      preview.textContent = text.replace(/\s+/g,' ').slice(0, 100);
      option.append(preview);
    }
    return option;
  }
  function render(previous) {
    try { renderList(previous); }
    catch (error) {
      field('list').replaceChildren(); select();
      field('clear').disabled = true;
      field('status').textContent = error.message;
    }
  }
  function renderList(previous) {
    const state = read(), query = field('query').value.trim().toLowerCase();
    const source = field('source').value;
    field('enable').checked = state.enabled;
    field('suggest').checked = suggestEnabled;
    const model = window.BrclioSnippetModel;
    const snippets = model.read(storage()).filter(s => s.kind === 'snippet');
    const saved = source === 'all' || source === 'saved' ? model.search(snippets, query, null) : [];
    const rows = saved.map(item => row('已收藏', model.label(item), item.text, item.id, item.id));
    const savedText = new Map(snippets.filter(item => !item.template).map(item => [item.text, item.id]));
    const displayed = new Set(saved.filter(item => !item.template).map(item => item.text));
    const groups = [['history','历史',state.entries], ['builtin','命令',builtin]];
    for (const [group,label,commands] of groups) {
      if (source !== 'all' && source !== group) continue;
      for (const value of commands) {
        if (displayed.has(value) || !safeLine(value) || !(label + ' ' + value).toLowerCase().includes(query)) continue;
        rows.push(row(label, value, '', value, savedText.get(value)));
        displayed.add(value);
      }
    }
    rows.forEach((option, index) => { option.id = 'command-option-' + index; });
    field('list').replaceChildren(...rows);
    select(rows.find(option => option.value === previous) || rows[0]);
    field('empty').hidden = !!rows.length;
    field('empty').textContent = query ? '没有匹配的命令。' : source === 'history' ? '尚无命令历史。' : '尚无收藏命令。';
    field('clear').disabled = !state.entries.length;
  }
  function remember() {
    const option = selectedOption();
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
  window.addEventListener('brclio-snippets-changed', () => {
    preferences();
    if (visible) render(selectedOption()?.value);
  });
  function section(name) {
    for (const id of ['browse', 'editor', 'draft']) field(id).hidden = id !== name;
  }
  function resetEditor() {
    editing = undefined;
    field('editor').reset();
    field('delete-confirm').hidden = true;
    field('editor-status').textContent = '';
  }
  function edit(item) {
    resetEditor(); editing = item;
    field('editor-title').textContent = item ? '编辑收藏' : '新建命令';
    field('name').value = item?.name || '';
    field('text').value = item?.text || '';
    field('package').value = item?.package || '';
    field('template').checked = !!item?.template;
    field('remove').hidden = !item;
    section('editor'); field('name').focus();
  }
  function finishEdit(id, message) {
    resetEditor(); section('browse');
    field('source').value = 'saved'; field('query').value = '';
    field('status').textContent = message;
    render(id); field('list').focus();
  }
  function saveEdit(event) {
    event.preventDefault();
    const model = window.BrclioSnippetModel;
    try {
      const id = editing?.id || crypto.randomUUID();
      const updated = model.applyEdit(model.read(storage()), {
        id, kind:'snippet', name:field('name').value.trim(), text:field('text').value,
        package:field('package').value, template:field('template').checked,
      }, editing);
      model.store(storage(), updated);
      window.dispatchEvent(new Event('brclio-snippets-changed'));
      finishEdit(id, '已保存。');
    } catch (error) { field('editor-status').textContent = error.message; }
  }
  function removeEdit() {
    const model = window.BrclioSnippetModel;
    if (!editing) return;
    try {
      const entries = model.read(storage());
      if (JSON.stringify(entries.find(item => item.id === editing.id)) !== JSON.stringify(editing)) throw new Error('条目已更改，请重新打开。');
      model.store(storage(), entries.filter(item => item.id !== editing.id));
      window.dispatchEvent(new Event('brclio-snippets-changed'));
      finishEdit(undefined, '已删除。');
    } catch (error) { field('editor-status').textContent = error.message; }
  }
  function insert() {
    const pane = active(), option = selectedOption();
    if (!option || !paneAccounts.get(pane)?.() || pane?.state !== 'running') return;
    let text = option.value;
    if (option.dataset.snippet) {
      const item = window.BrclioSnippetModel.read(storage()).find(entry => entry.id === option.dataset.snippet && entry.kind === 'snippet');
      if (!item) { render(); return; }
      if (item.template || !safeLine(item.text)) {
        section('draft');
        dismissDraft = draft(item, pane, { mount:field('draft'), onClose() { dismissDraft = undefined; section('browse'); } });
        return;
      }
      text = item.text;
    }
    if (safeLine(text)) { paste(pane, text); pane.terminal.focus(); }
  }
  function init() {
    panel = document.getElementById('workspace-commands');
    panel.innerHTML = `<div id="command-library-browse">
      <div class="command-filter"><input type="search" aria-label="搜索命令" id="command-library-query" placeholder="搜索命令" autocomplete="off" spellcheck="false">
      <button id="command-library-new" type="button">＋ 新建</button></div>
      <select aria-label="命令来源" id="command-library-source"><option value="all">全部命令</option><option value="saved">已收藏</option><option value="history">命令历史</option><option value="builtin">内置命令</option></select>
      <div id="command-library-list" role="listbox" tabindex="0" aria-label="匹配的命令"></div><p id="command-library-empty" hidden></p>
      <div class="command-actions"><button class="primary" id="command-library-insert">填入当前窗格</button><button id="command-library-remember">收藏</button><button id="command-library-edit">编辑</button></div>
      <p id="command-library-status" role="status"></p>
      <details id="command-library-settings"><summary>历史与补全设置</summary>
        <label><input type="checkbox" id="command-library-enable">在此设备记录命令历史</label>
        <label><input type="checkbox" id="command-library-suggest">输入时显示补全建议</label>
        <p>新建的本地 Bash、Zsh 和 PowerShell 会话会自动启用 Shell 集成。SSH 需要远端提供命令标记。</p>
        <p>本账号在此设备最多保留 200 条单行命令，可能含敏感参数。关闭记录会清空历史。</p>
        <button id="command-library-clear">清空命令历史</button>
      </details></div>
      <form id="command-library-editor" hidden><h3 id="command-library-editor-title"></h3>
        <label>名称<input id="command-library-name" maxlength="80" required autocomplete="off"></label>
        <label>命令<textarea id="command-library-text" rows="4" required maxlength="32768" spellcheck="false"></textarea></label>
        <label>剪藏包<input id="command-library-package" maxlength="64" autocomplete="off"></label>
        <label><input id="command-library-template" type="checkbox">填写模板变量，如 {{目录}}</label>
        <div class="command-actions"><button class="primary" id="command-library-save" type="submit">保存</button><button id="command-library-cancel" type="button">取消</button><button id="command-library-remove" type="button">删除</button></div>
        <div id="command-library-delete-confirm" hidden><p>删除这条收藏命令？</p><button id="command-library-delete" type="button">确认删除</button><button id="command-library-keep" type="button">保留</button></div>
        <p id="command-library-editor-status" role="status"></p>
      </form><div id="command-library-draft" hidden></div>`;
    field('enable').onchange = () => { write({enabled:field('enable').checked,entries:[]}); candidates = undefined; render(); };
    field('suggest').onchange = () => {
      suggestEnabled = field('suggest').checked;
      storage().setItem(suggestKey,String(suggestEnabled));
      preferences();
    };
    field('query').oninput = field('source').onchange = () => { field('status').textContent = ''; render(); };
    const list = field('list');
    list.onclick = event => {
      const option = event.target.closest('[role=option]');
      if (option) select(option);
    };
    list.ondblclick = event => { if (event.target.closest('[role=option]')) insert(); };
    list.onkeydown = event => {
      if (event.key === 'Enter') { event.preventDefault(); insert(); return; }
      const selected = selectedOption();
      const next = {ArrowUp:selected?.previousElementSibling,ArrowDown:selected?.nextElementSibling,Home:list.firstElementChild,End:list.lastElementChild}[event.key];
      if (next) { event.preventDefault(); select(next); next.scrollIntoView({block:'nearest'}); }
    };
    field('insert').onclick = insert;
    field('remember').onclick = remember;
    field('new').onclick = () => edit();
    field('edit').onclick = () => {
      const item = window.BrclioSnippetModel.read(storage()).find(item => item.id === selectedOption()?.dataset.snippet && item.kind === 'snippet');
      if (item) edit(item);
    };
    field('clear').onclick = () => { write({enabled:read().enabled,entries:[]}); candidates = undefined; render(); };
    field('editor').onsubmit = saveEdit;
    field('cancel').onclick = () => { resetEditor(); section('browse'); field('list').focus(); };
    field('remove').onclick = () => { field('delete-confirm').hidden = false; field('keep').focus(); };
    field('keep').onclick = () => { field('delete-confirm').hidden = true; field('remove').focus(); };
    field('delete').onclick = removeEdit;
  }
  function show(focus = true) {
    if (!panel) init();
    const wasVisible = visible;
    visible = true;
    if (!wasVisible) render();
    if (focus && !field('browse').hidden) field('query').focus();
    if (focus && !field('editor').hidden) field('name').focus();
  }
  function hide({preserveEdit = false} = {}) {
    visible = false;
    if (!panel) return;
    dismissDraft?.();
    if (!preserveEdit || field('editor').hidden) { resetEditor(); section('browse'); }
    field('delete-confirm').hidden = true;
    field('query').value = ''; field('source').value = 'all'; field('settings').open = false;
    field('status').textContent = ''; field('list').replaceChildren();
  }
  window.addEventListener('brclio-terminal-account-changed', () => {
    const reopen = visible;
    hide();
    if (reopen) show(false);
  });
  function open() { window.BrclioTerminalWorkspace.show('commands'); }
  return { recorder, attach, open, show, hide, refreshPane, needsShellIntegration, bind(activePane, pasteOnly, openDraft, sendInput) {
    active = activePane; paste = pasteOnly; draft = openDraft; completeInShell = sendInput; preferences();
  } };
})();

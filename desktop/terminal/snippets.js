'use strict';

window.BrclioSnippets = function installSnippets({ activePane, actions, paste }) {
  const storage = window.BrclioTerminalPartitions?.storage || localStorage;
  const model = window.BrclioSnippetModel;
  const $ = id => document.getElementById('snippets-' + id);
  const list = $('list'), details = $('details'), query = $('query'), filter = $('package-filter');
  const name = $('name'), kind = $('kind'), text = $('text'), packageName = $('package'), template = $('template');
  const read = () => model.read(storage);
  let entries = [], loaded = false, epoch = 0;
  function selected() { return entries.find(item => item.id === list.value); }
  function buttons() {
    const item = selected();
    template.disabled = kind.value !== 'snippet';
    const saved = item && item.name === name.value.trim() && item.kind === kind.value && item.text === text.value &&
      (item.package || '') === packageName.value.trim() && !!item.template === (!template.disabled && template.checked);
    $('save').disabled = !loaded || !name.value.trim() || !text.value || saved;
    $('remove').disabled = !loaded || !item;
    $('paste').disabled = !saved;
  }
  function edit() {
    const item = selected();
    kind.value = item?.kind || 'snippet';
    name.value = item?.name || '';
    text.value = item?.text || '';
    packageName.value = item?.package || (filter.value ? filter.value.slice(2) : '');
    template.checked = item?.template === true;
    $('status').textContent = '';
    buttons();
  }
  function display(items, id) {
    entries = items;
    const packages = [...new Set(items.map(item => item.package).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const prior = filter.value;
    filter.replaceChildren(new Option('全部包', ''), new Option('未分包', 'p:'), ...packages.map(pkg => new Option(pkg, 'p:' + pkg)));
    filter.value = [...filter.options].some(opt => opt.value === prior) ? prior : '';
    $('packages').replaceChildren(...packages.map(pkg => new Option(pkg, pkg)));
    const visible = model.search(items, query.value, filter.value ? filter.value.slice(2) : null);
    list.replaceChildren(new Option('新建条目', ''), ...visible.map(item => new Option((item.kind === 'note' ? '笔记 · ' : '剪藏 · ') + model.label(item), item.id)));
    list.value = visible.some(item => item.id === id) ? id : '';
    edit();
  }
  function closeEditor() {
    loaded = false;
    query.value = filter.value = '';
    display([], '');
  }
  function store(items, id, message) {
    if (items.length > 200 || items.reduce((count, item) => count + item.text.length, 0) > 512 * 1024) {
      throw new Error('已达到剪藏与笔记的容量上限，请先缩短内容或删除条目。');
    }
    if (items.length) storage.setItem(model.key, JSON.stringify(items));
    else storage.removeItem(model.key);
    if (id && !model.search(items, query.value, filter.value ? filter.value.slice(2) : null).some(item => item.id === id)) query.value = filter.value = '';
    display(items, id);
    window.dispatchEvent(new Event('brclio-snippets-changed'));
    $('status').textContent = message;
  }
  function syncEditor() {
    if (!details.open || !actions.open) { closeEditor(); return; }
    if (loaded) return;
    try { const items = read(); loaded = true; display(items, ''); }
    catch (error) { closeEditor(); $('status').textContent = error.message; }
  }
  window.addEventListener('brclio-terminal-library-moved', () => { closeEditor(); syncEditor(); });
  details.addEventListener('toggle', syncEditor);
  details.addEventListener('focusin', syncEditor);
  actions.addEventListener('close', () => { if (!actions.open) { details.open = false; closeEditor(); } });
  list.onchange = edit;
  query.oninput = filter.onchange = () => display(entries, list.value);
  for (const input of [kind, name, text, packageName, template]) input.oninput = () => { $('status').textContent = ''; buttons(); };
  $('save').onclick = () => {
    if (!loaded || !name.value.trim() || !text.value) return;
    try {
      const items = read();
      const id = list.value || crypto.randomUUID();
      const item = model.normalize({ id, name: name.value.trim(), kind: kind.value, text: text.value, package: packageName.value, template: template.checked });
      if (items.some(other => other.id !== id && other.kind === item.kind && other.name === item.name && other.package === item.package)) throw new Error('同一包中该类型的名称已存在。');
      if (list.value && JSON.stringify(items.find(other => other.id === id)) !== JSON.stringify(selected())) throw new Error('条目已更改，请重新打开。');
      store(list.value ? items.map(other => other.id === id ? item : other) : [...items, item], id, '已保存。');
    } catch (error) { $('status').textContent = error.message; }
  };
  $('remove').onclick = () => {
    if (!loaded || !list.value) return;
    try { store(read().filter(item => item.id !== list.value), '', '已删除。'); }
    catch (error) { $('status').textContent = error.message; }
  };

  const dialog = document.createElement('dialog');
  dialog.className = 'terminal-network-dialog'; dialog.id = 'snippet-draft';
  dialog.setAttribute('aria-labelledby', 'snippet-draft-title');
  dialog.innerHTML = `<div class="dialog-head"><h2 id="snippet-draft-title">剪藏草稿</h2><button type="button" data-cancel>关闭</button></div>
    <p data-target></p><div class="forward-grid" data-vars></div><button type="button" data-fill>生成草稿</button>
    <div class="forward-grid"><label class="forward-wide">确认要粘贴的内容<textarea data-preview rows="5" maxlength="32768" spellcheck="false"></textarea></label></div>
    <p class="forward-hint">请先完成登录并确认窗格已显示命令提示符。多行内容粘贴时可能立即执行。</p>
    <div class="network-actions"><button data-send type="button">粘贴到此窗格</button></div><p data-status role="status"></p>`;
  document.body.append(dialog);
  const part = attr => dialog.querySelector('[data-' + attr + ']');
  let destination, rendered = false;
  const pending = new Set();
  function resetDraft() {
    destination = null; rendered = false;
    part('vars').replaceChildren(); part('target').textContent = part('status').textContent = part('preview').value = '';
  }
  function controls() { part('send').disabled = !rendered || !part('preview').value; }
  function draft(item, pane) {
    if (!item || !pane?.node.isConnected || pane.state !== 'running') return;
    resetDraft();
    destination = { pane, item, epoch };
    const target = pane.launch?.profile === 'ssh' ? window.BrclioConnection.format(pane.launch.connection) : pane.tab.name.textContent;
    part('target').textContent = model.label(item) + ' → ' + target;
    const vars = item.template ? model.variables(item.text) : [];
    for (const variable of vars) {
      const label = document.createElement('label'), input = document.createElement('input');
      label.textContent = input.name = variable; input.maxLength = 2048; input.autocomplete = 'off'; input.spellcheck = false;
      label.append(input); part('vars').append(label);
    }
    rendered = !vars.length;
    part('fill').hidden = rendered;
    part('preview').value = item.text;
    controls();
    if (!dialog.open) dialog.showModal();
    (part('vars').querySelector('input') || part('preview')).focus();
  }
  part('vars').oninput = () => { rendered = false; controls(); };
  part('preview').oninput = controls;
  part('fill').onclick = () => {
    if (!destination) return;
    const inputs = [...part('vars').querySelectorAll('input')];
    const blank = inputs.find(input => !input.value);
    if (blank) { part('status').textContent = '请填写变量 ' + blank.name; blank.focus(); return; }
    try {
      part('preview').value = model.fill(destination.item.text, new Map(inputs.map(input => [input.name, input.value])));
      rendered = true; controls(); part('status').textContent = ''; part('preview').focus();
    } catch (error) { part('status').textContent = error.message; }
  };
  part('send').onclick = () => {
    if (!rendered || !part('preview').value || !destination) return;
    const { pane } = destination;
    if (epoch !== destination.epoch || !pane.node.isConnected || pane !== activePane() || pane.state !== 'running') {
      part('status').textContent = '目标窗格已切换或关闭。请关闭草稿并重新选择。'; return;
    }
    paste(pane, part('preview').value); dialog.close(); pane.terminal.focus();
  };
  part('cancel').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { if (!dialog.open) resetDraft(); });
  $('paste').onclick = () => {
    const item = selected(), pane = activePane();
    if (!item) return;
    if (!pane || pane.state !== 'running') { $('status').textContent = '当前没有运行中的窗格。'; return; }
    actions.close();
    if (item.template) draft(item, pane);
    else paste(pane, item.text);
  };
  function startup(id, pane) {
    if (!id || !pane) return;
    const generation = epoch;
    pane.ready.then(() => {
      if (generation !== epoch || !pane.node.isConnected || pane.state !== 'running') return;
      const item = read().find(entry => entry.id === id && entry.kind === 'snippet');
      if (!item) return;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'startup-snippet';
      button.textContent = '启动剪藏'; button.title = model.label(item);
      button.onclick = () => {
        if (generation !== epoch) return;
        const current = read().find(entry => entry.id === id && entry.kind === 'snippet');
        if (current) draft(current, pane); else button.remove();
      };
      pane.caption.parentElement.append(button); pending.add(button);
      pane.terminal.loadAddon({ activate() {}, dispose() { pending.delete(button); button.remove(); } });
    }).catch(() => { /* Invalid local data cannot interrupt an SSH login. */ });
  }
  window.addEventListener('brclio-terminal-account-changed', () => {
    epoch++; details.open = false; closeEditor(); if (dialog.open) dialog.close(); resetDraft();
    for (const button of pending) button.remove(); pending.clear();
  });
  return { draft, startup };
};

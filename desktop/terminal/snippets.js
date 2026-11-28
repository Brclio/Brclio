'use strict';

window.BrclioSnippets = function installSnippets({ activePane, actions, paste }) {
  const storage = window.BrclioTerminalPartitions?.storage || localStorage;
  const key = 'brclio.terminal.snippets.v1';
  const $ = id => document.getElementById('snippets-' + id);
  const list = $('list'), details = $('details');
  const name = $('name'), kind = $('kind'), text = $('text');
  let entries = [];
  let loaded = false;

  function read() {
    const stored = storage.getItem(key);
    const items = stored === null ? [] : JSON.parse(stored);
    const ids = new Set();
    if (!Array.isArray(items) || items.length > 200 || !items.every(item => {
      if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) ||
          !['snippet', 'note'].includes(item.kind) || typeof item.name !== 'string' ||
          !item.name.trim() || item.name.length > 80 || typeof item.text !== 'string' ||
          !item.text || item.text.length > 32768) return false;
      ids.add(item.id);
      return true;
    })) throw new Error('无法读取已保存的剪藏与笔记。');
    return items;
  }

  function selected() { return entries.find(item => item.id === list.value); }
  function buttons() {
    const item = selected();
    const saved = item && item.name === name.value.trim() && item.kind === kind.value && item.text === text.value;
    $('save').disabled = !loaded || !name.value.trim() || !text.value || saved;
    $('remove').disabled = !loaded || !item;
    $('paste').disabled = !saved;
  }
  function edit() {
    const item = selected();
    kind.value = item?.kind || 'snippet';
    name.value = item?.name || '';
    text.value = item?.text || '';
    $('status').textContent = '';
    buttons();
  }
  function display(items, id) {
    entries = items;
    list.replaceChildren(new Option('新建条目', ''), ...items.map(item =>
      new Option((item.kind === 'note' ? '笔记 · ' : '剪藏 · ') + item.name, item.id)));
    list.value = id || '';
    edit();
  }
  function closeEditor() {
    loaded = false;
    display([], '');
  }
  function store(items, id, message) {
    if (items.length > 200 || items.reduce((count, item) => count + item.text.length, 0) > 512 * 1024) {
      throw new Error('已达到剪藏与笔记的容量上限，请先缩短内容或删除条目。');
    }
    if (items.length) storage.setItem(key, JSON.stringify(items));
    else storage.removeItem(key);
    display(items, id);
    $('status').textContent = message;
  }
  function syncEditor() {
    if (!details.open || !actions.open) { closeEditor(); return; }
    if (loaded) return;
    try { const items = read(); loaded = true; display(items, ''); }
    catch (error) { closeEditor(); $('status').textContent = error.message; }
  }
  window.addEventListener('brclio-terminal-account-changed', () => { details.open = false; closeEditor(); });
  window.addEventListener('brclio-terminal-library-moved', () => { closeEditor(); syncEditor(); });
  details.addEventListener('toggle', syncEditor);
  details.addEventListener('focusin', syncEditor);
  actions.addEventListener('close', () => { if (!actions.open) { details.open = false; closeEditor(); } });
  list.onchange = edit;
  for (const input of [kind, name, text]) input.oninput = () => { $('status').textContent = ''; buttons(); };
  $('save').onclick = () => {
    if (!loaded || !name.value.trim() || !text.value) return;
    try {
      const items = read();
      const id = list.value || crypto.randomUUID();
      const item = { id, name: name.value.trim(), kind: kind.value, text: text.value };
      if (items.some(other => other.id !== id && other.kind === item.kind && other.name === item.name)) {
        throw new Error('同类型已有这个名称。');
      }
      if (list.value && !items.some(other => other.id === id)) throw new Error('这个条目已删除，请重新打开。');
      store(list.value ? items.map(other => other.id === id ? item : other) : [...items, item], id, '已保存。');
    } catch (error) { $('status').textContent = error.message; }
  };
  $('remove').onclick = () => {
    if (!loaded || !list.value) return;
    try { store(read().filter(item => item.id !== list.value), '', '已删除。'); }
    catch (error) { $('status').textContent = error.message; }
  };
  $('paste').onclick = () => {
    const item = selected(), pane = activePane();
    if (!item) return;
    if (!pane || pane.state !== 'running') { $('status').textContent = '当前没有运行中的窗格。'; return; }
    paste(pane, item.text);
    actions.close();
  };
};

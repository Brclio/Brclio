'use strict';

window.BrclioKeymap = function installKeymap(actions) {
  const key = 'brclio.terminal.keymap.v1';
  const select = document.getElementById('keymap-action');
  const recorder = document.getElementById('keymap-record');
  const status = document.getElementById('keymap-status');
  const rows = document.getElementById('keymap-list');
  const bindings = new Map();
  let listening = false;
  const allowed = /^(?:(?:Ctrl|Alt|Shift|Meta)\+)*(?:Key[A-Z]|Digit\d|F(?:[1-9]|1\d|2[0-4])|Arrow(?:Up|Down|Left|Right)|Space|BracketLeft|BracketRight|Backquote|Semicolon|Comma|Period|Slash|Minus|Equal)$/;
  try {
    const stored = JSON.parse(localStorage.getItem(key));
    if (Array.isArray(stored)) for (const [combo, action] of stored.slice(0, 60)) {
      if (allowed.test(combo) && Object.hasOwn(actions, action)) bindings.set(combo, action);
    }
  } catch {}
  for (const [id,[label]] of Object.entries(actions)) select.add(new Option(label,id));

  function combo(event) {
    const bits = [];
    if (event.ctrlKey) bits.push('Ctrl');
    if (event.altKey) bits.push('Alt');
    if (event.shiftKey) bits.push('Shift');
    if (event.metaKey) bits.push('Meta');
    bits.push(event.code);
    return bits.join('+');
  }
  function label(combo) { return combo.replaceAll('Meta+', '⌘ / Win + ').replace('Key','').replace('Digit',''); }
  function render() {
    rows.replaceChildren(...[...bindings].map(([combo, id]) => {
      const row = document.createElement('div');
      row.textContent = label(combo) + ' · ' + actions[id][0] + ' ';
      const remove = document.createElement('button');
      remove.textContent = '移除';
      remove.onclick = () => { bindings.delete(combo); persist(); };
      row.append(remove); return row;
    }));
  }
  function persist() {
    try { localStorage.setItem(key, JSON.stringify([...bindings])); } catch (error) { status.textContent = error.message; }
    render();
  }
  recorder.onclick = () => {
    listening = true;
    status.textContent = '按下带修饰键的组合或功能键，Esc 取消。';
    recorder.focus();
  };
  recorder.addEventListener('blur', () => { listening = false; });
  recorder.addEventListener('keydown', event => {
    if (!listening) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') { listening = false; status.textContent = ''; return; }
    const value = combo(event);
    if (!allowed.test(value) || (!event.ctrlKey && !event.metaKey && !event.altKey && !/^F\d+$/.test(event.code))) return;
    if (bindings.size >= 60 && !bindings.has(value)) { status.textContent = '最多可录入 60 个组合。'; return; }
    bindings.set(value, select.value); listening = false;
    status.textContent = '已保存 ' + label(value);
    persist();
  });
  render();
  return event => {
    const id = bindings.get(combo(event));
    if (!id || event.isComposing) return false;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!event.repeat) actions[id][1]();
    return true;
  };
};

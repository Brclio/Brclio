'use strict';

window.BrclioPaneInspector = function installInspector({ panes, activePane, activate, dialog }) {
  const $ = key => document.getElementById('inspect-' + key);
  const records = new WeakMap();
  function badge(pane) {
    const state = records.get(pane);
    if (!state) return '';
    const fields = { host: pane.location?.hostname || '', dir: pane.location?.directory || '',
      shell: pane.shell || '', tab: pane.tab.name.textContent };
    state.badge.textContent = state.template.replace(/\{(host|dir|shell|tab)\}/g, (_, key) => fields[key]);
    return state.badge.textContent;
  }
  function button(parent, text, click) {
    const node = document.createElement('button');
    node.textContent = text; node.onclick = click; parent.append(node);
  }
  function paneList() {
    const filter = $('filter').value.toLowerCase();
    $('panes').replaceChildren();
    for (const pane of panes.values()) {
      const label = [pane.tab.name.textContent, pane.caption.textContent, pane.location?.hostname,
        pane.location?.directory, badge(pane)].filter(Boolean).join(' · ');
      if (label.toLowerCase().includes(filter)) button($('panes'), label, () => { dialog.close(); activate(pane); });
    }
  }
  function refresh() {
    paneList();
    const pane = activePane(), state = records.get(pane);
    $('badge').value = state?.template || '';
    $('times').checked = Boolean(state?.times);
    $('notes').replaceChildren();
    if (!state) return;
    for (const note of state.notes) {
      const row = document.createElement('div');
      button(row, note.text, () => { if (!note.mark.isDisposed) { dialog.close(); pane.terminal.scrollToLine(note.mark.line); } });
      button(row, '移除', () => { note.mark.dispose(); refresh(); });
      $('notes').append(row);
    }
  }
  $('filter').oninput = paneList;
  $('badge-set').onclick = () => {
    const pane = activePane(), state = records.get(pane);
    if (state) { state.template = $('badge').value; badge(pane); paneList(); }
  };
  $('times').onchange = () => {
    const state = records.get(activePane());
    if (!state) return;
    state.times = $('times').checked;
    if (!state.times) { state.clock.textContent = ''; for (const item of state.stamps) item.mark.dispose(); state.stamps.length = 0; }
  };
  $('add').onclick = () => {
    const pane = activePane(), state = records.get(pane);
    const text = $('note').value.trim();
    if (!state || !text) return;
    const term = pane.terminal, buffer = term.buffer.active;
    if (buffer.type !== 'normal') { $('status').textContent = '请在普通滚动缓冲区添加批注。'; return; }
    const row = term.getSelectionPosition()?.start.y ?? (buffer.baseY + buffer.cursorY);
    const mark = term.registerMarker(row - buffer.baseY - buffer.cursorY);
    if (!mark) return;
    const note = { mark, text };
    if (state.notes.size >= 128) state.notes.values().next().value.mark.dispose();
    state.notes.add(note);
    mark.onDispose(() => state.notes.delete(note));
    const decoration = term.registerDecoration({ marker: mark, width: 1 });
    decoration?.onRender(el => { el.title = text; el.style.borderBottom = '2px dotted #f4d758'; });
    $('note').value = ''; refresh();
  };
  function attach(pane) {
    const term = pane.terminal;
    const overlay = document.createElement('span'), clock = document.createElement('span');
    overlay.className = 'session-badge'; clock.className = 'row-clock';
    pane.node.append(overlay); pane.caption.after(clock);
    const state = { badge: overlay, clock, notes: new Set(), template: '', times: false, stamps: [] };
    records.set(pane, state);
    function stamp(row) {
      if (!state.times || row < 0 || term.buffer.active.type !== 'normal') return;
      const buffer = term.buffer.active;
      const text = buffer.getLine(row)?.translateToString(true);
      if (!text) return;
      const prior = state.stamps.findLast(item => !item.mark.isDisposed && item.mark.line === row);
      if (prior) {
        if (prior.text !== text) { prior.text = text; prior.time = new Date(); }
      } else {
        const mark = term.registerMarker(row - buffer.baseY - buffer.cursorY);
        if (mark) {
          state.stamps.push({ mark, text, time: new Date() });
          if (state.stamps.length > 1000) state.stamps.shift().mark.dispose();
        }
      }
    }
    term.onLineFeed(() => { if (state.times) stamp(term.buffer.active.baseY + term.buffer.active.cursorY - 1); });
    term.onWriteParsed(() => {
      if (state.times) stamp(term.buffer.active.baseY + term.buffer.active.cursorY);
      if (state.template) badge(pane);
    });
    const screen = pane.host.querySelector('.xterm-screen');
    screen.addEventListener('pointermove', event => {
      if (!state.times || term.buffer.active.type !== 'normal') return;
      const bounds = screen.getBoundingClientRect();
      const row = term.buffer.active.viewportY + Math.floor((event.clientY - bounds.top) * term.rows / bounds.height);
      const item = state.stamps.findLast(stamp => !stamp.mark.isDisposed && stamp.mark.line === row);
      state.clock.textContent = item ? item.time.toLocaleTimeString() : '';
    });
    screen.addEventListener('pointerleave', () => { state.clock.textContent = ''; });
  }
  return { attach, refresh };
};

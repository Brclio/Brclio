'use strict';

window.BrclioBufferTools = function installBufferTools({ panes, activePane, activate, dialog, copy, message }) {
  const byId = id => document.getElementById(id);
  const results = byId('buffer-results');
  const status = text => { byId('buffer-status').textContent = text; };
  let generation = 0;
  let selection;

  function words(line) { return line.match(/[\p{L}\p{N}_./:@~-]+/gu) || []; }

  function option(label, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.onclick = action;
    results.append(button);
  }

  async function scan(complete) {
    const ticket = ++generation;
    const pane = activePane();
    if (!pane) return;
    const buffer = pane.terminal.buffer.active;
    const before = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(false, 0, buffer.cursorX) || '';
    const prefix = complete ? before.match(/[\p{L}\p{N}_./:@~-]+$/u)?.[0] : byId('buffer-query').value;
    results.replaceChildren();
    if (!prefix) return status(complete ? '先在终端输入要补全的词首。' : '输入要搜索的文字。');
    const candidates = new Set();
    let count = 0, scanned = 0;
    status('正在搜索…');
    for (const item of complete ? [pane] : panes.values()) {
      const source = item.terminal.buffer.active;
      for (let row = source.length - 1; row >= 0;) {
        let start = row;
        while (start && source.getLine(start)?.isWrapped) start--;
        let line = '';
        for (let part = start; part <= row; part++) line += source.getLine(part)?.translateToString(part === row) || '';
        row = start - 1;
        if (complete) {
          for (const word of words(line)) {
            if (!word.startsWith(prefix) || word === prefix || candidates.has(word)) continue;
            candidates.add(word);
            option(word, () => {
              dialog.close();
              if (panes.has(pane.id) && pane.state === 'running') {
                // Terminal contents may have changed while the chooser was open.
                const live = pane.terminal.buffer.active;
                const current = live.getLine(live.baseY + live.cursorY)?.translateToString(false, 0, live.cursorX) || '';
                if (!current.endsWith(prefix)) return message('输入位置已改变，请重新补全。');
                pane.terminal.paste(word.slice(prefix.length));
                pane.terminal.focus();
              }
            });
            if (++count === 50) break;
          }
        } else {
          const index = line.toLowerCase().indexOf(prefix.toLowerCase());
          if (index >= 0) {
            const snippet = line.slice(Math.max(0, index - 28), index + prefix.length + 70);
            const marker = source.type === 'normal' ? item.terminal.registerMarker(start - source.baseY - source.cursorY) : null;
            if (marker) markers.push(marker);
            option(item.tab.name.textContent + ' · ' + snippet, () => {
              const target = marker && !marker.isDisposed ? marker.line : start;
              const stale = marker?.isDisposed || !panes.has(item.id) || item.terminal.buffer.active !== source;
              dialog.close();
              if (stale) return message('这段输出已移出滚动记录。');
              activate(item);
              item.terminal.scrollToLine(target);
            });
            count++;
          }
        }
        if (count >= 50) break;
        if (++scanned % 240 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
          if (ticket !== generation || !dialog.open) return;
        }
      }
      if (count >= 50) break;
    }
    status(count === 50 ? '显示前 50 个结果' : count ? count + ' 个结果' : '无匹配');
  }
  const markers = [];
  function reset() {
    generation++;
    for (const mark of markers.splice(0)) mark.dispose();
    results.replaceChildren();
    status('');
  }
  function start(complete) { reset(); void scan(complete); }
  byId('buffer-search').onclick = () => start(false);
  byId('buffer-query').onkeydown = event => {
    if (event.key === 'Enter') { event.preventDefault(); start(false); }
  };
  byId('buffer-complete').onclick = () => start(true);
  dialog.addEventListener('close', reset);

  function startCopy() {
    const pane = activePane();
    if (!pane) return;
    dialog.close();
    const buffer = pane.terminal.buffer.active;
    const cursor = (buffer.baseY + buffer.cursorY) * pane.terminal.cols + Math.min(buffer.cursorX, pane.terminal.cols - 1);
    selection = { pane, cursor, anchor: cursor, cols: pane.terminal.cols };
    pane.terminal.select(cursor % pane.terminal.cols, Math.floor(cursor / pane.terminal.cols), 1);
    pane.terminal.focus();
    message('键盘选择：方向键移动，Shift 扩选，Enter 复制，Esc 退出。');
  }
  byId('buffer-copy-mode').onclick = startCopy;
  return function keyboard(event) {
    if (!selection) return false;
    const { pane } = selection;
    if (pane !== activePane() || !panes.has(pane.id) || selection.cols !== pane.terminal.cols ||
        !event.target.closest('.term-host')) { selection = undefined; return false; }
    event.preventDefault();
    event.stopImmediatePropagation();
    const term = pane.terminal;
    const key = event.key;
    if (key === 'Enter' || key === 'Escape') {
      selection = undefined;
      if (key === 'Enter') Promise.resolve(copy(term.getSelection())).catch(e => message(e.message, true));
      else term.clearSelection();
      message(key === 'Enter' ? '已退出键盘选择' : pane.detail);
      return true;
    }
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -term.cols, ArrowDown: term.cols,
      PageUp: -term.rows * term.cols, PageDown: term.rows * term.cols };
    if (!Object.hasOwn(moves, key)) return true;
    const limit = term.buffer.active.length * term.cols - 1;
    selection.cursor = Math.max(0, Math.min(limit, selection.cursor + moves[key]));
    if (!event.shiftKey) selection.anchor = selection.cursor;
    const first = Math.min(selection.anchor, selection.cursor);
    term.select(first % term.cols, Math.floor(first / term.cols), Math.abs(selection.anchor - selection.cursor) + 1);
    const row = Math.floor(selection.cursor / term.cols);
    const top = term.buffer.active.viewportY;
    if (row < top || row >= top + term.rows) term.scrollToLine(row < top ? row : row - term.rows + 1);
    return true;
  };
};

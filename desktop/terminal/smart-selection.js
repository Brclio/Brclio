'use strict';

(() => {
  const patterns = [
    /https?:\/\/[^\s<>"']+/giu,
    /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu,
    /"[^"\r\n]+"|'[^'\r\n]+'/gu,
    /(?:[A-Za-z]:[\\/]|~?\/|\.\.?\/)[^\s<>"'|]+/gu,
    /[\p{L}\p{N}_][\p{L}\p{N}_.:@-]*/gu,
  ];

  function select(term, column, clickedRow) {
    const buffer = term.buffer.active;
    let first = clickedRow, last = clickedRow;
    while (first > 0 && clickedRow - first < 32 && buffer.getLine(first)?.isWrapped) first--;
    while (last - clickedRow < 32 && buffer.getLine(last + 1)?.isWrapped) last++;
    let text = '', clicked = -1;
    const cells = [];
    for (let y = first; y <= last; y++) {
      const line = buffer.getLine(y);
      if (!line) return false;
      for (let x = 0; x < term.cols; x++) {
        const cell = line.getCell(x);
        const width = cell?.getWidth();
        if (!width) continue;
        const chars = cell.getChars() || ' ';
        if (y === clickedRow && column >= x && column < x + width) clicked = text.length;
        const index = (y - first) * term.cols + x;
        cells.push({ offset: text.length, index, end: index + width });
        text += chars;
      }
    }
    if (clicked < 0) return false;
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        let token = match[0];
        if (/^https?:/i.test(token)) token = token.replace(/[.,;!?。，；！？]+$/u, '');
        const end = match.index + token.length;
        if (clicked < match.index || clicked >= end) continue;
        const from = cells.findLast(c => c.offset <= match.index);
        const to = cells.findLast(c => c.offset < end);
        term.select(from.index % term.cols, first + Math.floor(from.index / term.cols), to.end - from.index);
        return true;
      }
    }
    return false;
  }

  function attach(term, host) {
    const screen = host.querySelector('.xterm-screen');
    screen.addEventListener('mousedown', event => {
      if (event.button !== 0 || (event.detail !== 4 && !(event.detail === 2 && event.altKey))) return;
      if (term.modes.mouseTrackingMode !== 'none') return;
      const bounds = screen.getBoundingClientRect();
      const column = Math.floor((event.clientX - bounds.left) * term.cols / bounds.width);
      const row = Math.floor((event.clientY - bounds.top) * term.rows / bounds.height);
      if (column < 0 || column >= term.cols || row < 0 || row >= term.rows) return;
      if (select(term, column, term.buffer.active.viewportY + row)) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    }, true);
  }
  window.BrclioSmartSelection = Object.freeze({ attach, select });
})();

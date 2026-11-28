'use strict';

(() => {
  // Each pane owns its markers. xterm moves or disposes them when scrollback
  // reflows, is trimmed, or is cleared. Command recall is separately opt-in.
  function attach(terminal, commandFinished, commandHistory) {
    const history = [];
    let command;
    let navigated;
    let navigationTop;
    const normal = () => terminal.buffer.active.type === 'normal';

    function forget(record) {
      if (command === record) command = undefined;
      if (navigated === record) navigated = undefined;
      record.mark.dispose();
      record.inputStart?.mark?.dispose();
      record.start?.mark.dispose();
      record.end?.mark.dispose();
    }

    function mark(kind, offset = 0) {
      if (!normal()) return;
      const marker = terminal.registerMarker(offset);
      if (!marker) return;
      const record = { kind, mark: marker };
      history.push(record);
      if (history.length > 512) forget(history.shift());
      const decoration = terminal.registerDecoration({ marker, width: 1, layer: 'top' });
      decoration?.onRender(node => {
        node.style.borderInlineStart = '2px solid ' + (kind === 'manual' ? '#e7b75b' : '#81b5ed');
        node.style.pointerEvents = 'none';
      });
      return record;
    }

    // Anchor positions to the first row of a wrapped logical line so that
    // changing the pane width does not leave an obsolete physical column.
    function wrappedWidth(row) {
      const buffer = terminal.buffer.normal;
      const last = buffer.getLine(row)?.getCell(terminal.cols - 1);
      // xterm leaves a padding cell when a wide glyph won't fit.
      if (last?.getWidth() === 1 && !last.getChars() && buffer.getLine(row + 1)?.getCell(0)?.getWidth() === 2) {
        return terminal.cols - 1;
      }
      return terminal.cols;
    }

    function position() {
      const buffer = terminal.buffer.normal;
      const row = buffer.baseY + buffer.cursorY;
      let first = row;
      let offset = buffer.cursorX;
      while (first > 0 && buffer.getLine(first)?.isWrapped) offset += wrappedWidth(--first);
      return { mark: terminal.registerMarker(first - row), offset };
    }

    function resolve(point) {
      if (!point?.mark || point.mark.isDisposed) return;
      let row = point.mark.line;
      let column = point.offset;
      while (terminal.buffer.normal.getLine(row + 1)?.isWrapped) {
        const width = wrappedWidth(row);
        if (column < width) break;
        column -= width;
        row++;
      }
      if (column > terminal.cols) return;
      return { row, column };
    }

    function cancelPrompt() {
      if (!command) return;
      history.splice(history.indexOf(command), 1);
      forget(command);
    }

    function readInput(input, cursor) {
      const start = resolve(input), end = resolve(cursor);
      if (!start || !end || start.row > end.row || end.row - start.row > 32) return;
      const parts = [];
      for (let row = start.row; row <= end.row; row++) {
        const line = terminal.buffer.normal.getLine(row);
        if (!line) return;
        // Enter moves the cursor to the next row before many shells send OSC C.
        if (row === end.row && row > start.row && end.column === 0) break;
        if (row > start.row && !line.isWrapped) return;
        parts.push(line.translateToString(row === end.row || !terminal.buffer.normal.getLine(row + 1)?.isWrapped, row === start.row ? start.column : 0, row === end.row ? end.column : terminal.cols));
      }
      return parts.join('');
    }

    function onCommand(data) {
      // Parameters are optional. Consume only plain FinalTerm A/B/C/D.
      const separator = data.indexOf(';');
      const code = separator < 0 ? data : data.slice(0, separator);
      if (!['A', 'B', 'C', 'D'].includes(code)) return false;
      if (!normal()) return true;
      if (code === 'D' && commandFinished) {
        const value = data.match(/^D;(-?\d{1,10})(?:;|$)/);
        commandFinished(value ? Number(value[1]) : undefined);
      }
      if (code === 'A') {
        // Shells may redraw a prompt repeatedly, including after Ctrl-C.
        const buffer = terminal.buffer.normal;
        if (command && !command.start && command.mark.line === buffer.baseY + buffer.cursorY) cancelPrompt();
        command = mark('prompt');
      } else if (code === 'B' && command) {
        command.input = true;
        command.inputStart?.mark?.dispose();
        command.inputStart = commandHistory?.enabled() || commandHistory?.suggestions?.() ? position() : undefined;
      } else if (code === 'C') {
        if (!command) command = mark('prompt');
        if (command && !command.start) {
          command.start = position();
          if (command.inputStart && commandHistory?.enabled()) {
            const input = readInput(command.inputStart,command.start);
            if (input !== undefined) commandHistory.add(input);
          }
          command.inputStart?.mark?.dispose();
          command.inputStart = undefined;
        }
      } else if (code === 'D' && command) {
        if (command.start) {
          command.end = position();
          command = undefined;
        } else if (command.input) cancelPrompt();
      }
      return true;
    }

    const handlers = [
      terminal.parser.registerOscHandler(133, onCommand),
      terminal.parser.registerOscHandler(1337, data => {
        if (data !== 'SetMark') return false;
        mark('manual');
        return true;
      }),
    ];

    function navigate(backward) {
      if (!normal()) return false;
      const buffer = terminal.buffer.normal;
      const visible = history.filter(record => !record.mark.isDisposed);
      const index = navigationTop === buffer.viewportY ? visible.indexOf(navigated) : -1;
      let chosen;
      if (index >= 0) chosen = visible[index + (backward ? -1 : 1)];
      else if (backward && buffer.viewportY === buffer.baseY) chosen = visible.at(-1);
      else if (backward) chosen = visible.findLast(record => record.mark.line < buffer.viewportY);
      else chosen = visible.find(record => record.mark.line >= buffer.viewportY);
      if (!chosen) return false;
      terminal.scrollToLine(chosen.mark.line);
      navigated = chosen;
      navigationTop = buffer.viewportY;
      return true;
    }

    function selectOutput() {
      if (!normal()) return false;
      const chosen = navigated?.end && navigationTop === terminal.buffer.normal.viewportY
        ? navigated : history.findLast(record => record.end);
      const start = resolve(chosen?.start);
      const end = resolve(chosen?.end);
      if (!start || !end) return false;
      const length = (end.row - start.row) * terminal.cols + end.column - start.column;
      if (length <= 0) return false;
      terminal.select(start.column, start.row, length);
      terminal.scrollToLine(start.row);
      return true;
    }

    return {
      add: () => Boolean(mark('manual')),
      addAt: row => Boolean(mark('manual', row - terminal.buffer.normal.baseY - terminal.buffer.normal.cursorY)),
      previous: () => navigate(true),
      next: () => navigate(false),
      selectOutput,
      inputPrefix() {
        if (!normal() || !command?.inputStart || command.start) return;
        const buffer = terminal.buffer.normal, row = buffer.baseY + buffer.cursorY;
        if (buffer.getLine(row)?.translateToString(true,buffer.cursorX) || buffer.getLine(row + 1)?.isWrapped) return;
        const cursor = position();
        try { return readInput(command.inputStart,cursor); } finally { cursor.mark?.dispose(); }
      },
      dispose() {
        for (const handler of handlers) handler.dispose();
        for (const record of history.splice(0)) forget(record);
      },
    };
  }

  if (typeof module === 'object' && module.exports) module.exports = { attach };
  else globalThis.BrclioCommandMarks = Object.freeze({ attach });
})();

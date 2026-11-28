'use strict';

(() => {
  function decodeBytes(text) {
    const data = new Uint8Array(text.length);
    let count = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\\' && /^[0-7]{3}$/.test(text.slice(i + 1, i + 4))) {
        data[count++] = parseInt(text.slice(i + 1, i + 4), 8);
        i += 3;
      } else data[count++] = text.charCodeAt(i);
    }
    return data.subarray(0, count);
  }

  function control({ write, ready, notify, output, ended, framed = true }) {
    let pending = '', block, started = !framed, initialized = false, closed = false, active;
    const queue = [];
    const max = 4 * 1024 * 1024;

    function end(reason = 'tmux 已分离') {
      if (closed) return;
      closed = true;
      clearTimeout(active?.timer);
      const error = new Error(reason);
      for (const item of [active, ...queue]) item?.reject(error);
      active = block = undefined;
      pending = '';
      queue.length = 0;
      ended(reason);
    }

    function pump() {
      if (!initialized || closed || active || !queue.length) return;
      active = queue.shift();
      active.timer = setTimeout(() => end('tmux 响应超时，连接已分离。'), 12000);
      active.timer.unref?.();
      Promise.resolve().then(() => { if (!closed) return write(active.text + '\n'); })
        .catch(error => end(error.message));
    }

    function command(text, received) {
      if (closed || queue.length >= 256 || !text || /[\r\n]/.test(text)) return Promise.reject(new Error('tmux 命令不可用'));
      return new Promise((resolve, reject) => { queue.push({ text, received, resolve, reject }); pump(); });
    }

    function line(text) {
      if (block) {
        const success = text === '%end ' + block.guard;
        if (!success && text !== '%error ' + block.guard) {
          block.length += text.length + 1;
          if (block.length > max) return end('tmux 响应过长');
          block.lines.push(text);
          return;
        }
        const reply = block;
        block = undefined;
        if (!initialized) {
          if (!success) return end(reply.lines.join(' ').slice(0, 200) || 'tmux 连接失败');
          initialized = true;
          ready();
        } else if (active && (reply.flags & 1)) {
          const request = active;
          active = undefined;
          clearTimeout(request.timer);
          if (success) {
            try { request.received?.(reply.lines); request.resolve(reply.lines); }
            catch (error) { request.reject(error); }
          }
          else request.reject(new Error(reply.lines.join(' ').slice(0, 200) || 'tmux 命令失败'));
        }
        pump();
        return;
      }
      const guard = /^%begin (\d+ \d+ (\d+))$/.exec(text);
      if (guard) { block = { guard: guard[1], flags: Number(guard[2]), lines: [], length: 0 }; return; }
      const data = /^%output (%\d+) (.*)$/.exec(text) || /^%extended-output (%\d+) \d+(?: [^:]*)? : (.*)$/.exec(text);
      if (data) output(data[1], decodeBytes(data[2]));
      else if (/^%exit(?: |$)/.test(text)) end('tmux 已分离');
      else if (/^%(?:window-add|window-close|window-renamed|layout-change|session-changed|session-window-changed|unlinked-window-add|unlinked-window-close)(?: |$)/.test(text)) notify();
    }

    function push(chunk) {
      if (closed) return;
      pending += chunk;
      if (!started) {
        const pos = pending.indexOf('\x1bP1000p');
        if (pos < 0) { pending = pending.slice(-6); return; }
        pending = pending.slice(pos + 7);
        started = true;
      }
      let offset = 0;
      while (!closed) {
        const pos = pending.indexOf('\n', offset);
        if (pos < 0) break;
        if (pos - offset > max) { end('tmux 消息过长'); break; }
        line(pending.slice(offset, pos).replace(/\r$/, ''));
        offset = pos + 1;
      }
      if (!closed) pending = pending.slice(offset);
      if (pending.length > max) end('tmux 消息过长');
    }
    return { push, command, end };
  }

  function rows(lines) {
    const result = [];
    let cells = 0;
    for (const line of lines) {
      const m = /^(@\d+) (%\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (.*)$/.exec(line);
      if (!m) continue;
      const [left, top, width, height, totalWidth, totalHeight, x, y] = m.slice(3, 11).map(Number);
      if (![left, top, width, height, totalWidth, totalHeight, x, y].every(Number.isSafeInteger) ||
          !width || !height || width > 1000 || height > 500 || !totalWidth || !totalHeight ||
          left + width > totalWidth || top + height > totalHeight || result.length >= 64 || cells + width * height > 1500000) continue;
      cells += width * height;
      const name = new TextDecoder().decode(Uint8Array.from(m[11], ch => ch.charCodeAt(0)))
        .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 100);
      result.push({ window: m[1], pane: m[2], left, top, width, height, totalWidth, totalHeight, x, y, name });
    }
    return result;
  }
  const list = "list-panes -s -F '#{window_id} #{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height} #{window_width} #{window_height} #{cursor_x} #{cursor_y} #{window_name}'";
  const exported = { control, decodeBytes, rows, list };
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else window.BrclioTmuxProtocol = Object.freeze(exported);
})();

'use strict';

window.BrclioTriggers = function installTriggers({ api, panes, message, activate }) {
  const byId = id => document.getElementById('trigger-' + id);
  const key = 'brclio.terminal.triggers.v1';
  const actions = { highlight: '高亮行', mark: '添加标记', bell: '响铃提醒', capture: '捕获输出' };
  let rules = [], worker, next = 0, timer, busy = false;
  const queue = [];
  const decorations = new Map();
  const captured = [];
  function showCaptured() {
    byId('captures').replaceChildren(...captured.filter(item => panes.has(item.pane.id) && !item.marker.isDisposed)
      .slice().reverse().map(item => {
        const button = document.createElement('button');
        button.textContent = item.pane.tab.name.textContent + ' · ' + item.line.slice(0, 220);
        button.onclick = () => {
          if (!panes.has(item.pane.id) || item.marker.isDisposed) return showCaptured();
          byId('captures').closest('dialog').close();
          activate(item.pane);
          item.pane.terminal.scrollToLine(item.marker.line);
        };
        return button;
      }));
  }
  byId('captures-show').onclick = showCaptured;
  byId('captures-clear').onclick = () => { for (const item of captured.splice(0)) item.marker.dispose(); showCaptured(); };
  function validate(rule) {
    if (!rule || !Object.hasOwn(actions, rule.action) || typeof rule.pattern !== 'string' || !rule.pattern || rule.pattern.length > 240) return false;
    try { new RegExp(rule.pattern, 'u'); return true; } catch { return false; }
  }
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (Array.isArray(saved)) rules = saved.filter(validate).slice(0, 24);
  } catch {}
  function render() {
    byId('rules').replaceChildren(...rules.map((rule, index) => {
      const row = document.createElement('div');
      row.textContent = rule.pattern + ' → ' + actions[rule.action] + ' ';
      const remove = document.createElement('button');
      remove.textContent = '移除';
      remove.onclick = () => { rules.splice(index, 1); changed(); };
      row.append(remove); return row;
    }));
  }
  function release(item) { if (item && !item.marker.isDisposed) item.marker.dispose(); }
  function stop(reason) {
    clearTimeout(timer);
    busy = false;
    worker?.terminate();
    worker = undefined;
    while (queue.length) release(queue.shift());
    if (reason) { byId('status').textContent = reason; message(reason, true); }
  }
  function pump() {
    if (!worker || busy || !queue.length) return;
    busy = true;
    const { sequence, line } = queue[0];
    worker.postMessage({ sequence, line });
    timer = setTimeout(() => stop('触发器匹配超时，已暂停。可编辑规则后重新启用。'), 1000);
  }
  function start() {
    stop();
    if (!rules.length) return;
    try {
      worker = new Worker('trigger-worker.js');
      worker.onerror = () => stop('触发器暂不可用，请重新启用。');
      worker.onmessage = ({ data }) => {
        clearTimeout(timer); busy = false;
        const item = queue.shift();
        if (!item || item.sequence !== data.sequence) { release(item); return pump(); }
        if (panes.has(item.pane.id) && !item.marker.isDisposed && data.hits.length) {
          const pane = item.pane;
          if (data.hits.some(hit => hit.action === 'bell')) api.ringBell().catch(() => {});
          const highlight = data.hits.some(hit => hit.action === 'highlight');
          const mark = data.hits.some(hit => hit.action === 'mark');
          if (mark) pane.marks.addAt(item.marker.line);
          if (data.hits.some(hit => hit.action === 'capture')) {
            const buffer = pane.terminal.buffer.normal;
            const marker = pane.terminal.registerMarker(item.marker.line - buffer.baseY - buffer.cursorY);
            if (marker) {
              captured.push({ pane, marker, line: item.line });
              if (captured.length > 200) captured.shift().marker.dispose();
            }
          }
          if (highlight) {
            pane.terminal.registerDecoration({ marker: item.marker, backgroundColor: '#60522d', width: pane.terminal.cols });
            const list = decorations.get(pane.id);
            if (list) {
              list.push(item.marker);
              if (list.length > 256) list.shift().dispose();
            }
          } else release(item);
        } else release(item);
        pump();
      };
      worker.postMessage({ rules });
    } catch { stop('无法载入本机触发器。'); }
  }
  function changed() {
    try { localStorage.setItem(key, JSON.stringify(rules)); } catch {}
    byId('status').textContent = '';
    render(); start();
  }
  byId('add').onclick = () => {
    const rule = { pattern: byId('pattern').value, action: byId('action').value };
    if (!validate(rule)) { byId('status').textContent = '请输入有效的正则表达式（最多 240 个字符）。'; return; }
    if (rules.length >= 24) { byId('status').textContent = '最多可添加 24 条规则。'; return; }
    rules.push(rule); changed();
  };
  byId('enable').onclick = start;
  render(); start();
  return function attach(pane) {
    const term = pane.terminal;
    const tracked = [];
    decorations.set(pane.id, tracked);
    const subscription = term.onLineFeed(() => {
      if (!worker || queue.length >= 128 || term.buffer.active.type !== 'normal') return;
      const b = term.buffer.active;
      const row = b.baseY + b.cursorY - 1;
      if (row < 0 || b.getLine(row + 1)?.isWrapped) return;
      let line = b.getLine(row)?.translateToString(true) || '';
      for (let start = row; start > 0 && b.getLine(start)?.isWrapped && line.length < 4096; start--) {
        line = (b.getLine(start - 1)?.translateToString(false) || '') + line;
      }
      const marker = term.registerMarker(-1);
      if (marker) { queue.push({ pane, marker, sequence: ++next, line: line.slice(0, 4096) }); pump(); }
    });
    return () => {
      subscription.dispose();
      decorations.delete(pane.id);
      for (const marker of tracked) marker.dispose();
      for (let i = captured.length - 1; i >= 0; i--) {
        if (captured[i].pane === pane) captured.splice(i, 1)[0].marker.dispose();
      }
    };
  };
};

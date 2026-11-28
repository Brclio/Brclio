'use strict';

window.BrclioLocalLogs = (() => {
  const api = window.brclioTerminal;
  const el = (tag, text, props = {}) => Object.assign(document.createElement(tag), { textContent: text }, props);
  const button = (text, fn) => {
    const control = el('button', text, { type: 'button' });
    control.onclick = fn;
    return control;
  };
  let dialog, indicator, timer;
  function showRecording(active) {
    if (!indicator) {
      indicator = button('正在记录 · 会话日志', () => open());
      indicator.className = 'log-indicator';
      document.getElementById('status-components').after(indicator);
    }
    indicator.hidden = !active;
    clearInterval(timer);
    if (active) timer = setInterval(async () => {
      try {
        const status = await api.localLogs('status');
        if (!status.active) showRecording(false);
      } catch { showRecording(false); }
    }, 3000);
  }
  window.addEventListener('brclio-terminal-account-changed', () => {
    if (indicator) showRecording(false);
    dialog?.close();
  });

  function open() {
    if (dialog) { dialog.focus(); return; }
    const view = dialog = el('dialog', '', { className: 'local-logs', ariaLabel: '本机会话日志' });
    const side = el('section', ''), content = el('section', '');
    const heading = el('div', '', { className: 'log-row' });
    heading.append(el('h2', '本机会话日志'), button('关闭', () => view.close()));
    const note = el('p', '手动记录当前窗格此后的输出。回显的命令和敏感文字也会写入。每份最多 256 KiB，每个账号最多 16 份，仅保存于本机。');
    const grid = el('div', '', { className: 'log-grid' });
    grid.append(side, content);
    const status = el('p', '');
    status.setAttribute('role', 'status');
    const list = el('select', '', { size: 6, ariaLabel: '日志列表' });
    const hostFilter = el('select', '', {ariaLabel:'按主机筛选日志'});
    const retention = el('select', '', {ariaLabel:'本机日志保留期限'});
    retention.replaceChildren(...[0,1,7,30,90,365].map(days => new Option(days ? days + ' 天' : '手动清理',String(days))));
    const name = el('input', '', { placeholder: '日志名称', ariaLabel: '日志名称', maxLength: 80 });
    const activePane = () => document.querySelector('#workspace .panel:not([hidden]) .pane.active')?.dataset.id;
    const pane = activePane();
    name.value = '终端 · ' + new Date().toLocaleString();
    const mark = el('input', '', { placeholder: '书签名称', ariaLabel: '书签名称', maxLength: 64 });
    const bookmarks = el('select', '', { ariaLabel: '日志书签' });
    const output = el('textarea', '', { readOnly: true, ariaLabel: '日志内容', spellcheck: false });
    let chosen = null, state = {}, busy = false;
    const start = button('开始记录当前窗格', () => act(async () => {
      await api.localLogs('start', { pane, name: name.value });
      await refresh();
    }));
    const stop = button('停止记录', () => act(async () => { await api.localLogs('stop'); await refresh(); }));
    const reload = button('刷新', () => act(refresh));
    const add = button('添加书签', () => act(async () => {
      if (!chosen) return;
      // A selection marks its start. With no selection a live bookmark marks the latest output.
      await api.localLogs('bookmark', { id: chosen, label: mark.value,
        offset: chosen === state.active && output.selectionStart === output.selectionEnd ? undefined : output.selectionStart });
      mark.value = '';
      await refresh(chosen);
    }));
    const confirmation = el('section', '', { hidden: true, className: 'log-row' });
    const question = el('span', '');
    let deletion;
    const cancel = button('取消', () => { confirmation.hidden = true; });
    const confirm = button('确认删除', () => act(async () => {
      if (!deletion) return;
      await api.localLogs(deletion.op, deletion.args);
      confirmation.hidden = true;
      await refresh();
    }));
    confirmation.append(question, cancel, confirm);
    const ask = (op, args, text) => {
      deletion = { op, args };
      question.textContent = text;
      confirmation.hidden = false;
      cancel.focus();
    };
    const remove = button('删除所选日志', () => ask('delete', { id: chosen }, '永久删除所选日志？'));
    const clear = button('清空本账号日志', () => ask('clear', {}, '永久删除此账号在本机的全部日志？'));
    const saveRetention = button('应用保留期限', () => {
      const days = Number(retention.value);
      if (days === state.days) return;
      ask('retention', {days}, days ? '应用 ' + days + ' 天期限并清理本机已过期的无书签日志？含书签的日志会保留。' : '改为手动清理本机日志？');
    });
    hostFilter.onchange = () => act(() => refresh());
    function controls() {
      start.disabled = busy || !pane || !!state.active || !state.logs;
      stop.disabled = busy || !state.active;
      list.disabled = reload.disabled = busy;
      add.disabled = busy || !chosen;
      remove.disabled = busy || !chosen || chosen === state.active;
      clear.disabled = busy || !state.logs?.length || !!state.active;
      confirm.disabled = busy;
    }
    function display(record) {
      output.value = record?.text || '';
      bookmarks.replaceChildren(new Option('跳到书签', ''), ...(record?.bookmarks || []).map(item => new Option(item.label, String(item.offset))));
      bookmarks.disabled = !record?.bookmarks.length;
      if (record?.full) status.textContent = '已达到单份日志容量上限，录制已停止。';
    }
    async function refresh(prefer) {
      const next = await api.localLogs('list');
      if (dialog !== view) return;
      state = next;
      retention.value = String(next.days || 0);
      const filter = hostFilter.value;
      const hosts = [...new Set(next.logs.map(log => log.host).filter(Boolean))].sort();
      hostFilter.replaceChildren(new Option('全部主机',''),...hosts.map(host => new Option(host,host)),
        new Option('本地或未记录主机','@local'));
      hostFilter.value = filter === '@local' || hosts.includes(filter) ? filter : '';
      const matching = next.logs.filter(log => !hostFilter.value ||
        (hostFilter.value === '@local' ? !log.host : log.host === hostFilter.value));
      const previous = typeof prefer === 'string' ? prefer : chosen || next.active;
      chosen = matching.some(log => log.id === previous) ? previous : matching[0]?.id || null;
      list.replaceChildren(...matching.map(log => new Option((log.id === next.active ? '● ' : '') + log.name, log.id)));
      list.value = chosen || '';
      showRecording(next.active);
      display(chosen ? await api.localLogs('read', { id: chosen }) : null);
      if (next.error) status.textContent = next.error;
    }
    async function act(fn) {
      if (busy || dialog !== view) return;
      busy = true;
      controls();
      status.textContent = '';
      try { await fn(); } catch (error) {
        status.textContent = String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '');
      } finally { busy = false; controls(); }
    }
    list.onchange = () => act(async () => {
      confirmation.hidden = true;
      chosen = list.value || null;
      display(chosen ? await api.localLogs('read', { id: chosen }) : null);
    });
    bookmarks.onchange = () => {
      if (bookmarks.value === '') return;
      output.focus();
      const pos = Math.min(Number(bookmarks.value), output.value.length);
      output.setSelectionRange(pos, Math.min(pos + 1, output.value.length));
      const line = output.value.slice(0, pos).split('\n').length - 1;
      output.scrollTop = line * parseFloat(getComputedStyle(output).lineHeight);
    };
    const row = (...nodes) => { const r = el('div', '', { className: 'log-row' }); r.append(...nodes); return r; };
    side.append(name, row(start, stop), hostFilter, list, row(reload, remove, clear), row(retention, saveRetention));
    content.append(output, row(mark, add, bookmarks));
    view.append(heading, note, grid, confirmation, status);
    view.addEventListener('close', () => { if (dialog === view) dialog = null; view.remove(); }, { once: true });
    document.body.append(view);
    view.showModal();
    void act(refresh);
  }
  return { open };
})();

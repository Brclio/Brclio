'use strict';

window.BrclioSftp = (() => {
  let active;
  const node = (tag, text, props = {}) => Object.assign(document.createElement(tag), { textContent: text }, props);
  function button(text, action) {
    const b = node('button', text, { type: 'button' });
    b.onclick = action;
    return b;
  }
  function size(value) {
    if (value == null) return '';
    if (value < 1024) return value + ' B';
    if (value < 1048576) return (value / 1024).toFixed(1) + ' KiB';
    return (value / 1048576).toFixed(1) + ' MiB';
  }
  function open(value) {
    if (active) { active.focus(); return; }
    const target = window.BrclioConnection.endpoint(value);
    const api = window.brclioTerminal;
    const id = crypto.randomUUID();
    const call = (op, args = {}) => api.sftp(op, { ...args, id });
    const dialog = node('dialog', '', { className: 'sftp-browser', ariaLabel: 'SFTP 文件管理' });
    active = dialog;
    const main = node('div', '', { className: 'sftp-panes' });
    const status = node('p', '', { className: 'sftp-status' });
    status.setAttribute('role', 'status');
    const head = node('div', '', { className: 'sftp-heading' });
    const title = node('h2', 'SFTP 文件管理');
    const close = button('关闭', () => dialog.close());
    head.append(title, node('span', (target.user ? target.user + '@' : '') + target.host + (target.port ? ':' + target.port : '')), close);
    const controls = node('div', '', { className: 'sftp-bottom' });
    const cancel = button('取消传输', () => { void call('cancel').catch(() => {}); });
    cancel.hidden = true;
    controls.append(status, cancel);
    dialog.append(head, main, controls);
    const panes = {};
    let busy = false;
    let connected = false;
    let progressTimer;
    let editing;
    let transferInProgress = false;
    function refreshControls() {
      for (const [side, pane] of Object.entries(panes)) {
        const entry = pane.data?.entries.find(item => item.name === pane.selected);
        pane.select.disabled = busy || !pane.data;
        pane.choose && (pane.choose.disabled = busy || !connected);
        pane.up.disabled = busy || !pane.data?.parent;
        pane.refresh.disabled = busy || !pane.data;
        pane.transfer.disabled = busy || entry?.kind !== 'file' || !panes.local.data;
        pane.enter.disabled = busy || !['directory', 'link'].includes(entry?.kind);
        if (side === 'remote') {
          pane.mkdir.disabled = busy || !connected;
          pane.rename.disabled = pane.remove.disabled = busy || !entry;
        }
      }
      close.disabled = transferInProgress;
    }
    function paint(side, data) {
      if (!data) return;
      const pane = panes[side];
      const chosen = pane.data?.dir === data.dir ? pane.selected : '';
      pane.data = data;
      pane.path.textContent = data.dir;
      pane.path.title = data.dir;
      const items = data.entries.map(item => {
        const label = item.kind === 'directory' ? '目录' : item.kind === 'link' ? '链接' : item.kind === 'file' ? '文件' : '其他';
        const option = new Option(label + '　' + item.name + (item.kind === 'file' && item.size != null ? '　' + size(item.size) : ''), item.name);
        return option;
      });
      pane.select.replaceChildren(...items);
      pane.select.value = chosen || '';
      pane.selected = pane.select.value;
      pane.empty.hidden = !!items.length;
      pane.empty.textContent = '此目录为空';
    }
    async function run(fn) {
      if (busy || editing) return;
      busy = true;
      status.textContent = '正在处理…';
      refreshControls();
      try {
        const message = await fn();
        status.textContent = message || '';
      } catch (error) {
        status.textContent = String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '');
      } finally { busy = false; refreshControls(); }
    }
    function listOp(side, op, extra = {}) {
      return run(async () => { paint(side, await call(op, { side, ...extra })); });
    }
    function edit(side, op) {
      if (editing || busy) return;
      const pane = panes[side];
      editing = node('form', '', { className: 'sftp-edit' });
      const label = node('label', op === 'mkdir' ? '新文件夹名称' : op === 'rename' ? '新名称' : '删除远端项目「' + pane.selected + '」？');
      const input = node('input', '', { value: op === 'rename' ? pane.selected : '' });
      if (op !== 'remove') { input.required = true; label.append(input); }
      const confirm = node('button', op === 'remove' ? '删除' : '确定', { type: 'submit' });
      const dismiss = () => { editing?.remove(); editing = null; pane.select.focus(); };
      const back = button('取消', dismiss);
      editing.append(label, back, confirm);
      dialog.insertBefore(editing, controls);
      const selected = pane.selected;
      editing.onsubmit = event => {
        event.preventDefault();
        const text = input.value;
        dismiss();
        void listOp(side, op, { name: op === 'mkdir' ? text : selected, newName: text });
      };
      if (op !== 'remove') { input.focus(); input.select(); } else back.focus();
    }
    function makePane(side) {
      const local = side === 'local';
      const box = node('section', '', { className: 'sftp-pane' });
      const title = node('h3', local ? '本机' : '远端');
      const path = node('p', local ? '尚未选择文件夹' : '正在连接…', { className: 'sftp-path' });
      const select = node('select', '', { size: 12, ariaLabel: local ? '本地文件列表' : '远端文件列表' });
      const empty = node('small', '', { hidden: true });
      const pane = panes[side] = { path, select, empty, data: null, selected: '' };
      const toolbar = node('div', '', { className: 'sftp-tools' });
      if (local) {
        pane.choose = button('选择目录', () => listOp(side, 'choose'));
        toolbar.append(pane.choose);
      }
      pane.up = button('上一级', () => listOp(side, 'parent'));
      pane.refresh = button('刷新', () => listOp(side, 'list'));
      toolbar.append(pane.up, pane.refresh);
      pane.enter = button('打开目录', () => listOp(side, 'enter', { name: pane.selected }));
      toolbar.append(pane.enter);
      select.onchange = () => { pane.selected = select.value; refreshControls(); };
      select.ondblclick = () => { if (!pane.enter.disabled) pane.enter.click(); };
      select.onkeydown = e => {
        if (e.key === 'Enter' && !pane.enter.disabled) { e.preventDefault(); pane.enter.click(); }
      };
      const actions = node('div', '', { className: 'sftp-tools' });
      pane.transfer = button(local ? '上传到远端 →' : '← 下载到本机', () => run(async () => {
        transferInProgress = true;
        cancel.hidden = false;
        refreshControls();
        const label = local ? '上传' : '下载';
        let checking = false;
        progressTimer = setInterval(async () => {
          if (checking) return;
          checking = true;
          try {
            const state = await call('progress');
            if (state && transferInProgress) status.textContent = '正在' + label + '　' + size(state.bytes) + (state.size == null ? '' : ' / ' + size(state.size));
          } catch { /* The pending transfer reports the connection error. */ }
          finally { checking = false; }
        }, 300);
        try {
          paint(local ? 'remote' : 'local', await call('transfer', { side, name: pane.selected }));
          return label + '完成。';
        } finally { transferInProgress = false; clearInterval(progressTimer); cancel.hidden = true; }
      }));
      actions.append(pane.transfer);
      if (!local) {
        for (const [op, label] of [['mkdir', '新建目录'], ['rename', '重命名'], ['remove', '删除']]) {
          pane[op] = button(label, () => edit(side, op));
          actions.append(pane[op]);
        }
      }
      box.append(title, path, toolbar, select, empty, actions);
      main.append(box);
    }
    makePane('local');
    makePane('remote');
    document.body.append(dialog);
    dialog.addEventListener('cancel', event => { if (transferInProgress) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      active = null;
      clearInterval(progressTimer);
      void call('close').catch(() => {});
      dialog.remove();
    }, { once: true });
    dialog.showModal();
    void run(async () => {
      paint('remote', await call('open', { target }));
      connected = true;
      return '已连接。选择本地目录即可传输文件。';
    });
  }
  return { open };
})();

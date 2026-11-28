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
    let dragFrom = null;
    let draftPoll = null;
    const library = window.BrclioConnection;
    const partition = window.BrclioTerminalPartitions;
    const owner = partition?.owner;
    const bookmarksKey = 'brclio.terminal.sftp-bookmarks.v1';
    const sideOf = side => side === 'local' ? 'remote' : 'local';
    function bookmarkStorage() {
      if (partition && owner !== partition.owner) throw new Error('账号已更改，请重新打开 SFTP。');
      return partition?.storage || localStorage;
    }
    function savedBookmarks() {
      const list = JSON.parse(bookmarkStorage().getItem(bookmarksKey) || '[]');
      if (!Array.isArray(list)) throw new Error('目录收藏格式无效。');
      return list;
    }
    function updateBookmarks(side) {
      const pane = panes[side];
      const list = savedBookmarks().filter(item => item.endpoint === pane.scope);
      pane.bookmarks.replaceChildren(new Option('收藏的目录…', ''), ...list.map(item => new Option(item.path, item.path)));
      pane.star.textContent = list.some(item => item.path === pane.data?.dir) ? '取消收藏' : '收藏当前目录';
      pane.bookmarks.disabled = busy || !list.length;
    }
    function toggleBookmark(side) {
      return run(async () => {
        const pane = panes[side], list = savedBookmarks();
        const at = list.findIndex(item => item.endpoint === pane.scope && item.path === pane.data.dir);
        if (at >= 0) list.splice(at, 1);
        else {
          if (list.length >= 512) throw new Error('最多可收藏 512 个目录。');
          list.push({ endpoint: pane.scope, path: pane.data.dir });
        }
        bookmarkStorage().setItem(bookmarksKey, JSON.stringify(list));
      });
    }
    async function chooseLocal(side) {
      const data = await call('choose', { side });
      if (!data) return;
      const pane = panes[side];
      pane.target = null;
      pane.scope = JSON.stringify(['local', data.dir]);
      pane.data = null;
      paint(side, data);
    }
    function editLocation(side, mode) {
      if (editing || busy) return;
      const pane = panes[side];
      const form = editing = node('form', '', { className: 'sftp-edit' });
      const remote = mode === 'endpoint';
      const label = node('label', remote ? 'SFTP 地址' : '完整目录路径');
      const input = node('input', '', { required: true, value: remote ? '' : pane.data.dir });
      if (remote) input.placeholder = '[用户@]主机[:端口]';
      label.append(input);
      form.append(label);
      let saved = [];
      let hosts;
      const dismiss = () => { form.remove(); editing = null; pane.switch.focus(); };
      if (remote) {
        try { saved = library.store(bookmarkStorage()).all(); }
        catch (e) { status.textContent = e.message; }
        hosts = node('select', '', { ariaLabel: '已保存的主机' });
        hosts.append(new Option('手动输入地址', ''));
        for (let i = 0; i < saved.length; i++) hosts.add(new Option(saved[i].name, String(i)));
        hosts.onchange = () => {
          input.disabled = hosts.value !== '';
          input.value = input.disabled ? library.format(saved[Number(hosts.value)]) : '';
        };
        form.prepend(hosts);
        form.append(button('使用本机目录', () => { dismiss(); void run(() => chooseLocal(side)); }));
      }
      form.append(button('取消', dismiss), node('button', remote ? '连接' : '前往', { type: 'submit' }));
      form.onsubmit = event => {
        event.preventDefault();
        dismiss();
        void run(async () => {
          if (!remote) return paint(side, await call('goto', { side, path: input.value }));
          const dest = library.endpoint(hosts.value !== '' ? saved[Number(hosts.value)] : library.quick(input.value));
          const data = await call('connect', { side, target: dest });
          pane.target = dest;
          pane.scope = JSON.stringify(['sftp', dest]);
          pane.data = null;
          paint(side, data);
        });
      };
      dialog.insertBefore(form, controls);
      input.focus(); input.select();
    }
    function refreshControls() {
      for (const [side, pane] of Object.entries(panes)) {
        const entry = pane.data?.entries.find(item => item.name === pane.selected);
        pane.select.disabled = busy || !pane.data;
        pane.choose && (pane.choose.disabled = busy || !connected);
        pane.up.disabled = busy || !pane.data?.parent;
        pane.refresh.disabled = busy || !pane.data;
        pane.transfer.disabled = busy || !['file', 'directory'].includes(entry?.kind) || !panes[sideOf(side)]?.data;
        pane.enter.disabled = busy || !['directory', 'link'].includes(entry?.kind);
        pane.switch.disabled = busy || !connected;
        pane.goto.disabled = pane.star.disabled = busy || !pane.data;
        pane.hiddenToggle.disabled = busy || !pane.data;
        pane.title.textContent = pane.target ? library.format(pane.target) : '本机';
        const fromLocal = !pane.target, toLocal = !panes[sideOf(side)]?.target;
        const label = fromLocal && !toLocal ? '上传到远端' : !fromLocal && toLocal ? '下载到本机' : '复制到' + (side === 'local' ? '右侧' : '左侧');
        pane.transfer.textContent = side === 'local' ? label + ' →' : '← ' + label;
        pane.transfer.draggable = !pane.transfer.disabled;
        pane.select.draggable = !pane.transfer.disabled;
        for (const op of ['editFile', 'editWith', 'mkdir', 'rename', 'remove']) pane[op].hidden = !pane.target;
        pane.editFile.disabled = pane.editWith.disabled = busy || entry?.kind !== 'file';
        pane.mkdir.disabled = busy || !pane.data;
        pane.rename.disabled = pane.remove.disabled = busy || !entry;
        if (pane.data) {
          try { updateBookmarks(side); } catch (error) { status.textContent = error.message; }
        } else pane.bookmarks.disabled = true;
      }
      close.disabled = transferInProgress || !!draftPoll;
    }
    function paint(side, data) {
      if (!data) return;
      const pane = panes[side];
      const chosen = pane.data?.dir === data.dir ? pane.selected : '';
      pane.data = data;
      pane.path.textContent = data.dir;
      pane.path.title = data.dir;
      const items = data.entries.filter(item => pane.showHidden || !item.name.startsWith('.')).map(item => {
        const label = item.kind === 'directory' ? '目录' : item.kind === 'link' ? '链接' : item.kind === 'file' ? '文件' : '其他';
        const option = new Option(label + '　' + item.name + (item.kind === 'file' && item.size != null ? '　' + size(item.size) : ''), item.name);
        return option;
      });
      pane.select.replaceChildren(...items);
      pane.select.value = chosen || '';
      pane.selected = pane.select.value;
      pane.empty.hidden = !!items.length;
      pane.empty.textContent = data.entries.length ? '仅包含隐藏项目' : '此目录为空';
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
    function editFile(side, choose) {
      return run(async () => {
        const pane = panes[side], name = pane.selected;
        if (!await call('edit-file', { side, name, choose })) return;
        const panel = node('div', '', { className: 'sftp-edit' });
        const message = node('span', '正在外部编辑「' + name + '」');
        const back = button('结束编辑', () => finish('edit-discard'));
        const upload = button('上传已保存的修改', () => finish('edit-save'));
        let submitting = false, notified = false;
        async function finish(op) {
          if (submitting) return;
          submitting = true;
          back.disabled = upload.disabled = true;
          try {
            const saved = await call(op);
            clearInterval(draftPoll);
            draftPoll = null;
            panel.remove();
            editing = null;
            main.inert = false;
            status.textContent = saved ? '远端文件已更新。' : '已结束编辑。';
            paint(side, await call('list', { side }));
          } catch (error) { notified = true; message.textContent = String(error.message || error); }
          finally {
            submitting = false;
            back.disabled = upload.disabled = false;
            refreshControls();
          }
        }
        editing = panel;
        main.inert = true;
        panel.append(message, upload, back);
        dialog.insertBefore(panel, controls);
        let checking = false;
        draftPoll = setInterval(async () => {
          if (checking || submitting) return;
          checking = true;
          try {
            if (!notified && await call('edit-status')) {
              notified = true;
              message.textContent = '检测到本地编辑副本已保存：' + name;
            }
          } catch { /* An editor may replace its local file while saving. */ }
          finally { checking = false; }
        }, 1000);
        return '编辑器保存后，可上传修改或结束编辑。';
      });
    }
    function makePane(side) {
      const local = side === 'local';
      const box = node('section', '', { className: 'sftp-pane' });
      const title = node('h3', local ? '本机' : '远端');
      const path = node('p', local ? '尚未选择文件夹' : '正在连接…', { className: 'sftp-path' });
      const select = node('select', '', { size: 12, ariaLabel: local ? '本地文件列表' : '远端文件列表' });
      const empty = node('small', '', { hidden: true });
      const pane = panes[side] = { title, path, select, empty, data: null, selected: '', showHidden: false,
        target: local ? null : target, scope: local ? '' : JSON.stringify(['sftp', target]) };
      const toolbar = node('div', '', { className: 'sftp-tools' });
      if (local) {
        pane.choose = button('选择目录', () => run(() => chooseLocal(side)));
        toolbar.append(pane.choose);
      }
      pane.switch = button('切换位置', () => editLocation(side, 'endpoint'));
      toolbar.append(pane.switch);
      pane.up = button('上一级', () => listOp(side, 'parent'));
      pane.refresh = button('刷新', () => listOp(side, 'list'));
      toolbar.append(pane.up, pane.refresh);
      pane.enter = button('打开目录', () => listOp(side, 'enter', { name: pane.selected }));
      pane.goto = button('前往路径', () => editLocation(side, 'path'));
      pane.hiddenToggle = button('显示隐藏项目', () => {
        pane.showHidden = !pane.showHidden;
        pane.hiddenToggle.textContent = pane.showHidden ? '隐藏点文件' : '显示隐藏项目';
        pane.hiddenToggle.setAttribute('aria-pressed', String(pane.showHidden));
        paint(side, pane.data);
        refreshControls();
      });
      pane.star = button('收藏当前目录', () => toggleBookmark(side));
      pane.bookmarks = node('select', '', { className: 'sftp-bookmarks', ariaLabel: '收藏的目录' });
      pane.bookmarks.onchange = () => {
        if (pane.bookmarks.value) void listOp(side, 'goto', { path: pane.bookmarks.value });
      };
      toolbar.append(pane.enter, pane.goto, pane.hiddenToggle, pane.star, pane.bookmarks);
      select.onchange = () => { pane.selected = select.value; refreshControls(); };
      select.ondblclick = () => { if (!pane.enter.disabled) pane.enter.click(); else if (pane.target && !pane.editFile.disabled) pane.editFile.click(); };
      select.onkeydown = e => {
        if (e.key === 'Enter' && !pane.enter.disabled) { e.preventDefault(); pane.enter.click(); }
      };
      const actions = node('div', '', { className: 'sftp-tools' });
      pane.transfer = button(local ? '上传到远端 →' : '← 下载到本机', () => run(async () => {
        transferInProgress = true;
        cancel.hidden = false;
        refreshControls();
        const label = !pane.target && panes[sideOf(side)].target ? '上传' : pane.target && !panes[sideOf(side)].target ? '下载' : '复制';
        let checking = false;
        progressTimer = setInterval(async () => {
          if (checking) return;
          checking = true;
          try {
            const state = await call('progress');
            if (state && transferInProgress) status.textContent = '正在' + label + '　' + size(state.bytes) + (state.size == null ? '' : ' / ' + size(state.size)) + (state.current ? '　' + state.current : '');
          } catch { /* The pending transfer reports the connection error. */ }
          finally { checking = false; }
        }, 300);
        try {
          paint(local ? 'remote' : 'local', await call('transfer', { side, name: pane.selected }));
          return label + '完成。';
        } finally { transferInProgress = false; clearInterval(progressTimer); cancel.hidden = true; }
      }));
      pane.editFile = button('编辑文件', () => editFile(side, false));
      pane.editWith = button('选择编辑器…', () => editFile(side, true));
      actions.append(pane.transfer, pane.editFile, pane.editWith);
      for (const source of [select, pane.transfer]) {
        source.ondragstart = event => {
          if (pane.transfer.disabled) { event.preventDefault(); return; }
          dragFrom = side;
          event.dataTransfer.effectAllowed = 'copy';
          event.dataTransfer.setData('text/plain', pane.selected);
        };
        source.ondragend = () => { dragFrom = null; };
      }
      box.ondragover = event => {
        if (dragFrom === sideOf(side) && pane.data && !busy) event.preventDefault();
      };
      box.ondrop = event => {
        if (dragFrom !== sideOf(side) || !pane.data || busy) return;
        event.preventDefault(); dragFrom = null;
        panes[sideOf(side)].transfer.click();
      };
      {
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
    dialog.addEventListener('cancel', event => { if (transferInProgress || draftPoll) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      active = null;
      clearInterval(draftPoll);
      clearInterval(progressTimer);
      void call('close').catch(() => {});
      dialog.remove();
    }, { once: true });
    dialog.showModal();
    void run(async () => {
      paint('remote', await call('open', { target }));
      connected = true;
      return '已连接。可选择本机目录，或切换位置连接另一台主机。';
    });
  }
  return { open };
})();

'use strict';

window.BrclioSftp = (() => {
  let active, closing;
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
  async function open(value) {
    if (active && !active.open) {
      const previous = active;
      await new Promise(resolve => previous.addEventListener('close',resolve,{once:true}));
    }
    if (closing) await closing;
    if (active) { active.focus(); return; }
    const target = value ? window.BrclioConnection.endpoint(value) : null;
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
    head.append(title, node('span', target ? window.BrclioConnection.format(target) : '本机'), close);
    const controls = node('div', '', { className: 'sftp-bottom' });
    let canceled = false;
    const cancel = button('取消传输', () => { canceled = true; void call('cancel').catch(() => {}); });
    cancel.hidden = true;
    const editors = button('编辑器关联', () => run(async () => {
      const list = node('select', '', { ariaLabel:'按文件类型保存的编辑器' });
      const panel = node('div', '', { className:'sftp-edit' });
      function display(items) {
        list.replaceChildren(...items.map(item => new Option((item.extension || '无扩展名') + '　' + item.application,item.extension)));
        remove.disabled = !items.length;
      }
      const note = node('span','使用“选择编辑器”后保存文件类型关联。');
      const remove = button('恢复默认编辑器', async () => {
        remove.disabled = true;
        try { display(await call('editor-forget', {extension:list.value})); }
        catch (e) { note.textContent=String(e.message || e); remove.disabled=false; }
      });
      const done = button('完成', () => { panel.remove(); editing=null; main.inert=false; refreshControls(); editors.focus(); });
      display(await call('editor-list'));
      editing=panel; main.inert=true;
      panel.append(note,list,remove,done); dialog.insertBefore(panel,controls); done.focus();
    }));
    controls.append(status, editors, cancel);
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
    const remoteScope = record => JSON.stringify(['sftp-route', record.host, record.user || '', record.port || null,
      record.jump || '', record.proxy || '', record.proxyUser || '']);
    function savedBookmarks() {
      const list = JSON.parse(bookmarkStorage().getItem(bookmarksKey) || '[]');
      if (!Array.isArray(list)) throw new Error('目录收藏格式无效。');
      let changed = false;
      for (const entry of list) {
        try {
          const [type, old] = JSON.parse(entry.endpoint);
          if (type === 'sftp' && typeof old?.host === 'string') {
            entry.endpoint = remoteScope(old); changed = true;
          }
        } catch { /* Unknown bookmarks remain stored for their original reader. */ }
      }
      if (changed) bookmarkStorage().setItem(bookmarksKey, JSON.stringify(list));
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
      let hosts, bank;
      const dismiss = () => { form.remove(); editing = null; pane.switch.focus(); };
      if (remote) {
        try { bank = library.store(bookmarkStorage()); saved = bank.all(); }
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
          const dest = hosts.value !== '' ? bank.resolve(saved[Number(hosts.value)]) : library.endpoint(library.quick(input.value));
          const data = await call('connect', { side, target: dest });
          pane.target = dest;
          pane.scope = remoteScope(dest);
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
      editors.disabled = busy || !connected || !!editing;
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
              back.textContent = '放弃本地修改';
            }
          } catch { /* An editor may replace its local file while saving. */ }
          finally { checking = false; }
        }, 1000);
        return '编辑器保存后，可上传修改或结束编辑。';
      });
    }
    function transfer(label, operation) {
      return run(async () => {
        transferInProgress = true;
        canceled = false;
        cancel.hidden = false;
        refreshControls();
        let checking = false;
        progressTimer = setInterval(async () => {
          if (checking) return;
          checking = true;
          try {
            const state = await call('progress');
            if (state && transferInProgress) status.textContent = '正在' + label + '　' + size(state.bytes) +
              (state.size == null ? '' : ' / ' + size(state.size)) + (state.current ? '　' + state.current : '');
          } catch { /* The pending transfer reports the connection error. */ }
          finally { checking = false; }
        }, 300);
        try { await operation(); return label + '完成。'; }
        finally { transferInProgress = false; clearInterval(progressTimer); cancel.hidden = true; }
      });
    }
    function makePane(side) {
      const local = side === 'local';
      const box = node('section', '', { className: 'sftp-pane' });
      const title = node('h3', local ? '本机' : '远端');
      const path = node('p', local || !target ? '尚未选择文件夹' : '正在连接…', { className: 'sftp-path' });
      const select = node('select', '', { size: 12, ariaLabel: local ? '本地文件列表' : '远端文件列表' });
      const empty = node('small', '', { hidden: true });
      const pane = panes[side] = { title, path, select, empty, data: null, selected: '', showHidden: false,
        target: local ? null : target, scope: local || !target ? '' : remoteScope(target) };
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
      pane.transfer = button(local ? '上传到远端 →' : '← 下载到本机', () => {
        const label = !pane.target && panes[sideOf(side)].target ? '上传' : pane.target && !panes[sideOf(side)].target ? '下载' : '复制';
        return transfer(label, async () => paint(sideOf(side), await call('transfer', { side, name: pane.selected })));
      });
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
        if (!busy && pane.data && (dragFrom === sideOf(side) || (api.sftpDrop && event.dataTransfer.types.includes('Files')))) {
          event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
        }
      };
      box.ondrop = event => {
        event.preventDefault();
        if (!pane.data || busy || editing) return;
        if (dragFrom === sideOf(side)) {
          dragFrom = null; panes[sideOf(side)].transfer.click(); return;
        }
        const files = Array.from(event.dataTransfer.files);
        if (!api.sftpDrop || !files.length) return;
        void transfer(pane.target ? '上传' : '复制', async () => {
          for (const file of files) {
            if (canceled) throw new Error('已取消剩余项目。');
            paint(side, await api.sftpDrop(id, side, file));
          }
        });
      };
      select.oncontextmenu = event => {
        event.preventDefault();
        if (busy || editing) return;
        if (event.target.tagName === 'OPTION') { select.value = event.target.value; pane.selected = select.value; refreshControls(); }
        if (!pane.selected) return;
        const menu = node('div', '', { className: 'sftp-tools', role: 'menu' });
        const dismiss = () => menu.remove();
        for (const [label, control] of [['复制到目标目录', pane.transfer], ['打开目录', pane.enter], ['编辑文件', pane.editFile],
          ['选择编辑器…', pane.editWith], ['重命名', pane.rename], ['删除', pane.remove]]) {
          if (!control || control.disabled || control.hidden) continue;
          const cmd = button(label, () => { dismiss(); control.click(); });
          cmd.setAttribute('role', 'menuitem'); menu.append(cmd);
        }
        if (!menu.childElementCount) return;
        menu.onkeydown = key => { if (key.key === 'Escape') { key.preventDefault(); dismiss(); select.focus(); } };
        menu.onfocusout = change => { if (!menu.contains(change.relatedTarget)) dismiss(); };
        select.after(menu); menu.firstChild.focus();
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
      closing = call('close').catch(() => {});
      dialog.remove();
    }, { once: true });
    dialog.showModal();
    void run(async () => {
      if (!target) {
        await call('start-local');
        connected = true;
        await chooseLocal('local');
        return '可为另一侧选择本机目录或远端主机。';
      }
      paint('remote', await call('open', { target }));
      connected = true;
      return '已连接。可选择本机目录，或切换位置连接另一台主机。';
    });
  }
  return { open };
})();

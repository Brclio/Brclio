'use strict';

window.BrclioWorkspaceHosts = (() => {
  let showPanel;

  function bind() {
    if (showPanel) return;
    const panel = document.getElementById('workspace-hosts');
    const remote = window.BrclioRemoteConnections;
    const library = window.BrclioConnection;
    const store = library.store(localStorage);
    const partitions = window.BrclioTerminalPartitions;
    panel.innerHTML = `
      <div data-host="browse">
        <form data-host="quick-form" class="ws-host-quick">
          <label for="ws-host-quick">快速连接</label>
          <div><input id="ws-host-quick" data-host="quick" placeholder="用户名@主机:端口" maxlength="512" autocomplete="off" autocapitalize="none" spellcheck="false" required>
            <button type="submit" class="ws-host-primary">连接</button></div>
        </form>
        <input data-host="search" type="search" placeholder="搜索主机" aria-label="搜索主机名称、地址或标签" autocomplete="off">
        <div class="ws-host-filters" role="group" aria-label="主机筛选">
          <button type="button" data-view="all">全部</button><button type="button" data-view="favorite">收藏</button><button type="button" data-view="recent">最近</button>
        </div>
        <div class="ws-host-tools">
          <button type="button" data-host="new">＋ 新建主机</button>
          <button type="button" data-host="advanced-library">完整主机库</button>
        </div>
        <div data-host="list" class="ws-host-list" role="list" aria-label="匹配的主机"></div>
      </div>
      <form data-host="editor" class="ws-host-editor" hidden>
        <h3 data-host="editor-title"></h3>
        <label>名称<input name="name" maxlength="64" required autocomplete="off"></label>
        <label>主机地址<input name="host" maxlength="255" required placeholder="IP、域名或 SSH 别名" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
        <div class="ws-host-pair">
          <label>用户名<input name="user" maxlength="128" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
          <label>端口<input name="port" type="number" min="1" max="65535" placeholder="默认"></label>
        </div>
        <label class="ws-host-favorite"><input type="checkbox" name="favorite"> 收藏主机</label>
        <div class="ws-host-edit-actions">
          <button type="submit" class="ws-host-primary">保存主机</button><button type="button" data-host="cancel">取消</button>
        </div>
        <button type="button" data-host="advanced">更多选项…</button>
      </form>
      <p data-host="status" role="status"></p>`;
    const field = key => panel.querySelector('[data-host="' + key + '"]');
    const editor = field('editor');
    const fields = editor.elements;
    const search = field('search');
    const status = field('status');
    const filters = panel.querySelectorAll('[data-view]');
    let view = 'all', chooseDefault = true, generation = 0;
    let source = null, editingSaved = false;

    async function perform(action, control) {
      const epoch = generation;
      if (control?.disabled) return;
      if (control) control.disabled = true;
      status.textContent = '';
      try {
        const message = await action();
        if (epoch === generation && typeof message === 'string') status.textContent = message;
      } catch (error) {
        if (epoch === generation) status.textContent = error.message;
      } finally {
        if (control && epoch === generation) control.disabled = false;
      }
    }

    function switchToList() {
      source = null;
      editingSaved = false;
      editor.reset();
      editor.hidden = true;
      field('browse').hidden = false;
    }

    function edit(item, saved) {
      source = item;
      editingSaved = saved;
      field('browse').hidden = true;
      editor.hidden = false;
      field('editor-title').textContent = saved ? '编辑主机' : '新建主机';
      for (const key of ['name', 'host', 'user', 'port']) fields[key].value = item?.[key] ?? '';
      if (!saved && item && !fields.name.value) fields.name.value = item.host.slice(0, 64);
      fields.favorite.checked = Boolean(item?.favorite);
      status.textContent = '';
      fields.name.focus();
    }

    function draft() {
      return { ...Object.fromEntries(['name', 'host', 'user', 'port'].map(key => [key, fields[key].value.trim()])),
        favorite: fields.favorite.checked };
    }

    function hostRow(item, configs) {
      const recent = view === 'recent';
      const saved = Boolean(item.name);
      const endpoint = library.format(library.resolve(item, configs));
      const row = document.createElement('div');
      row.className = 'ws-host-row';
      row.setAttribute('role', 'listitem');
      const launch = document.createElement('button');
      launch.type = 'button';
      launch.className = 'ws-host-launch';
      const title = document.createElement('strong');
      title.textContent = (item.favorite ? '★ ' : '') + (item.name || item.host);
      const address = document.createElement('small');
      address.textContent = recent ? remote.kindLabels[item.kind] + ' · ' + endpoint : endpoint;
      launch.append(title, address);
      const time = remote.lastOpened(item);
      if (recent && time) {
        const stamp = document.createElement('time');
        stamp.dateTime = new Date(item.openedAt).toISOString();
        stamp.textContent = time;
        launch.append(stamp);
      }
      const action = (recent ? '重新打开 ' + remote.kindLabels[item.kind] : '连接 SSH') + ' ' + (item.name || endpoint);
      launch.setAttribute('aria-label', action);
      launch.title = action + (item.name ? ' · ' + endpoint : '');
      launch.onclick = () => perform(() => recent ? remote.reconnectRecent(item) : remote.connectHost(item), launch);
      const editButton = document.createElement('button');
      editButton.type = 'button';
      editButton.className = 'ws-host-edit';
      editButton.textContent = saved ? '编辑' : '保存';
      editButton.setAttribute('aria-label', editButton.textContent + '主机 ' + (item.name || endpoint));
      editButton.onclick = () => perform(() => {
        const record = saved ? store.all().find(entry => entry.name === item.name) : item;
        if (!record) throw new Error('此主机已更新，请重新选择。');
        edit(record, saved);
      });
      row.append(launch, editButton);
      return row;
    }

    function render() {
      const ready = partitions.ready;
      if (chooseDefault && ready) {
        view = store.recents().length ? 'recent' : 'all';
        chooseDefault = false;
      }
      for (const button of filters) button.setAttribute('aria-pressed', String(button.dataset.view === view));
      for (const control of [field('new'), field('advanced-library'), field('quick'), field('quick-form').querySelector('button')]) control.disabled = !ready;
      const list = field('list');
      const items = ready ? remote.listItems(view, search.value) : [];
      if (items.length) {
        const configs = store.groupConfigs();
        list.replaceChildren(...items.map(item => hostRow(item, configs)));
      } else {
        const empty = document.createElement('p');
        empty.textContent = !ready ? '正在载入主机…' : search.value.trim() ? '没有匹配的主机。' :
          ({ all: '还没有保存的主机。', favorite: '还没有收藏的主机。', recent: '还没有最近连接。' })[view];
        list.replaceChildren(empty);
      }
    }

    showPanel = () => perform(render);
    for (const button of filters) button.onclick = () => { view = button.dataset.view; chooseDefault = false; showPanel(); };
    search.oninput = showPanel;
    field('quick-form').onsubmit = event => {
      event.preventDefault();
      const address = field('quick');
      const epoch = generation;
      void perform(async () => {
        const requested = address.value;
        await remote.quickConnect(requested);
        if (generation === epoch && address.value === requested) {
          address.value = search.value = '';
          view = 'recent';
          chooseDefault = false;
          render();
        }
      }, event.submitter);
    };
    field('new').onclick = () => edit(null, false);
    field('advanced-library').onclick = () => perform(() => remote.open());
    field('cancel').onclick = () => {
      switchToList();
      status.textContent = '';
      field('new').focus();
    };
    field('advanced').onclick = () => perform(() => {
      remote.editAdvanced(source, editingSaved, draft());
      switchToList();
    });
    editor.onsubmit = event => {
      event.preventDefault();
      void perform(() => {
        const saved = remote.saveBasic(source, editingSaved, draft());
        switchToList();
        search.value = '';
        view = 'all';
        chooseDefault = false;
        render();
        return '已保存 ' + saved.name;
      });
    };
    const refresh = () => { if (!panel.hidden) showPanel(); };
    for (const event of ['brclio-terminal-library-changed', 'brclio-terminal-library-applied', 'brclio-terminal-recents-changed']) {
      window.addEventListener(event, refresh);
    }
    window.addEventListener('brclio-terminal-account-changed', () => {
      generation++;
      search.value = field('quick').value = '';
      chooseDefault = true;
      switchToList();
      field('list').replaceChildren();
      status.textContent = '';
      refresh();
    });
  }

  return { bind, show() { bind(); return showPanel(); } };
})();

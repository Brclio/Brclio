'use strict';

window.BrclioRemoteConnections = {
  bind(api, activePane, launch) {
    const byId = name => document.getElementById('remote-' + name);
    document.body.append(byId('library-template').content.cloneNode(true));
    const library = window.BrclioConnection;
    const storage = library.store(localStorage);
    const dialog = byId('library');
    const fields = ['name', 'host', 'user', 'port', 'group', 'tags', 'jump', 'identityFile'];
    const kindLabels = { ssh: 'SSH', sftp: 'SFTP 命令行', files: '文件浏览' };
    let selected = '';
    let activeRecent = null;
    let accountGeneration = 0;
    let available = {};
    const status = value => { byId('status').textContent = value; };
    const form = () => ({
      ...Object.fromEntries(fields.map(field => [field, byId(field).value.trim()])),
      favorite: byId('favorite').checked,
    });

    function showItem(item, name = '') {
      selected = name;
      for (const field of fields) {
        const value = item?.[field];
        byId(field).value = Array.isArray(value) ? value.join(', ') : value ?? '';
      }
      byId('favorite').checked = !!item?.favorite;
      byId('advanced').open = !!(item?.jump || item?.identityFile);
      byId('editor-title').textContent = selected || '新建主机';
      byId('remove').disabled = byId('duplicate').disabled = !selected;
      byId('delete-check').hidden = true;
      window.dispatchEvent(new Event('brclio-terminal-host-editor-changed'));
    }

    function render() {
      const records = storage.all();
      const paths = library.groups(records);
      const filter = byId('group-filter');
      const group = filter.value;
      filter.replaceChildren(new Option('全部分组', ''), ...paths.map(path => new Option(path, path)));
      filter.value = paths.includes(group) ? group : '';
      byId('groups').replaceChildren(...paths.map(path => new Option(path, path)));

      const recents = byId('view').value === 'recent';
      const search = byId('search').value.trim();
      filter.disabled = recents;
      byId('clear-recent').hidden = !recents;
      const list = byId('list');
      list.replaceChildren();
      const items = recents ? storage.recents().filter(item => {
        const text = [item.name, library.format(item), kindLabels[item.kind]].join(' ').toLowerCase();
        return search.toLowerCase().split(/\s+/).every(word => text.includes(word));
      }) : library.select(records, { search, group: filter.value, favorites: byId('view').value === 'favorite' });
      if (!items.length) {
        const empty = document.createElement('p');
        empty.textContent = recents && !search ? '还没有最近打开的连接。' : records.length || search ? '没有匹配的主机。' : '还没有保存的主机。';
        list.append(empty);
      }
      for (const item of items) {
        const row = document.createElement('button');
        row.type = 'button';
        const sameRecent = activeRecent && activeRecent.kind === item.kind &&
          JSON.stringify(library.endpoint(activeRecent)) === JSON.stringify(library.endpoint(item));
        row.setAttribute('aria-pressed', String(recents ? !!sameRecent : item.name === selected));
        const title = document.createElement('span');
        const subtitle = document.createElement('small');
        title.textContent = (item.favorite ? '★ ' : '') + (item.name || item.host);
        subtitle.textContent = [recents ? kindLabels[item.kind] : item.group, library.format(item), ...(item.tags || [])].filter(Boolean).join(' · ');
        row.append(title, subtitle);
        row.onclick = () => {
          guarded(() => {
            const saved = records.find(record => record.name === item.name);
            activeRecent = recents ? item : null;
            showItem(saved || item, saved?.name);
            for (const button of list.children) button.setAttribute('aria-pressed', String(button === row));
            status('');
          });
        };
        list.append(row);
      }
    }

    function guarded(action) {
      try {
        const result = action();
        if (result && typeof result.catch === 'function') result.catch(error => status(error.message));
      } catch (error) { status(error.message); }
    }

    function updateCompanion() {
      const source = activePane()?.launch;
      const kind = source?.profile === 'ssh' ? 'sftp' : 'ssh';
      const companion = byId('companion');
      companion.hidden = !source?.connection?.host || !['ssh', 'sftp'].includes(source.profile);
      companion.disabled = !available[kind];
      companion.textContent = '为当前主机打开 ' + kindLabels[kind];
    }

    async function clients() {
      available = await api.remoteClients();
      for (const kind of ['ssh', 'sftp']) byId(kind).disabled = !available[kind];
      byId('files').disabled = !available.ssh;
      updateCompanion();
      const missing = ['ssh', 'sftp'].filter(kind => !available[kind]);
      if (missing.length) status('未找到 ' + missing.join('、') + '，请安装系统 OpenSSH 客户端。');
    }

    async function connect(kind, value, name = '') {
      const epoch = accountGeneration;
      const target = library.endpoint(value);
      const program = kind === 'files' ? 'ssh' : kind;
      if (!available[program]) throw new Error('未找到 ' + program + '，请安装系统 OpenSSH 客户端。');
      if (kind === 'files') {
        if (!window.BrclioSftp?.open) throw new Error('文件浏览器尚未就绪。');
        await window.BrclioSftp.open(target);
      } else {
        launch(kind, kindLabels[kind] + ' · ' + (value.name || target.host).slice(0, 64), target);
      }
      if (epoch !== accountGeneration) return;
      dialog.close();
      const saved = storage.all().find(item => item.name === name);
      // A connection can use unsaved edits. Keep that exact destination in its history.
      const matches = saved && JSON.stringify(library.endpoint(saved)) === JSON.stringify(target);
      storage.recordUse(kind, target, matches ? saved.name : '');
    }

    function open(mode) {
      const actions = document.getElementById('actions-dialog');
      if (actions.open) actions.close();
      if (!dialog.open) dialog.showModal();
      status('');
      guarded(render);
      byId('files').classList.toggle('host-files-primary', mode === 'files');
      if (mode === 'files') status('选择或填写主机后，点击「浏览文件」。');
      guarded(clients);
      byId('search').focus();
    }
    window.addEventListener('brclio-terminal-account-changed', () => {
      accountGeneration++;
      if (dialog.open) dialog.close();
      activeRecent = null;
      showItem();
      byId('quick').value = byId('search').value = '';
      byId('view').value = 'all';
      guarded(render);
      status('');
    });
    window.addEventListener('brclio-terminal-library-applied', () => {
      if (!dialog.open) return;
      guarded(() => {
        if (selected && !storage.all().some(record => record.name === selected)) showItem();
        render();
      });
    });
    window.BrclioRemoteConnections.open = open;
    byId('open').onclick = open;
    byId('close').onclick = () => dialog.close();
    dialog.addEventListener('close', () => {
      byId('delete-check').hidden = true;
      if (!document.querySelector('dialog[open]')) activePane()?.terminal?.focus();
    });
    byId('connections').addEventListener('toggle', () => {
      if (byId('connections').open) guarded(clients);
    });
    document.getElementById('terminal-actions').addEventListener('click', updateCompanion);
    byId('companion').onclick = () => guarded(() => {
      const source = activePane()?.launch;
      if (!source?.connection?.host || !['ssh', 'sftp'].includes(source.profile)) return;
      return connect(source.profile === 'ssh' ? 'sftp' : 'ssh', source.connection);
    });

    byId('group-filter').onchange = byId('view').onchange = () => guarded(render);
    byId('search').oninput = () => guarded(render);
    byId('new').onclick = () => guarded(() => {
      activeRecent = null;
      showItem();
      render();
      status('');
      byId('name').focus();
    });
    byId('duplicate').onclick = () => guarded(() => {
      if (!selected) return;
      const record = form();
      const names = new Set(storage.all().map(item => item.name));
      const base = (record.name || selected).slice(0, 53) + ' 副本';
      let name = base;
      for (let i = 2; names.has(name); i++) name = base + ' ' + i;
      activeRecent = null;
      showItem({ ...record, name });
      render();
      status('可编辑副本，再保存为新主机。');
      byId('name').focus();
    });
    byId('form').onsubmit = event => {
      event.preventDefault();
      guarded(() => {
        const saved = storage.save(form(), selected || null);
        activeRecent = null;
        showItem(saved, saved.name);
        render();
        status('已保存 ' + saved.name);
      });
    };
    byId('remove').onclick = () => {
      byId('delete-label').textContent = '删除“' + selected + '”？';
      byId('delete-check').hidden = false;
      byId('delete-cancel').focus();
    };
    byId('delete-cancel').onclick = () => { byId('delete-check').hidden = true; };
    byId('delete-confirm').onclick = () => guarded(() => {
      if (!selected) return;
      storage.remove(selected);
      activeRecent = null;
      showItem();
      render();
      status('主机已删除。');
    });
    byId('clear-recent').onclick = () => guarded(() => {
      storage.clearRecent();
      activeRecent = null;
      render();
      status('最近记录已清空。');
    });
    byId('quick-form').onsubmit = event => {
      event.preventDefault();
      guarded(() => {
        const target = library.quick(byId('quick').value);
        return connect(target.protocol, target);
      });
    };
    for (const kind of ['ssh', 'sftp', 'files']) byId(kind).onclick = () => guarded(() => connect(kind, form(), selected));
  },
};

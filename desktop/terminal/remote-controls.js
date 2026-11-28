'use strict';

window.BrclioRemoteConnections = {
  bind(api, activePane, launch) {
    const byId = name => document.getElementById('remote-' + name);
    document.body.append(byId('library-template').content.cloneNode(true));
    const library = window.BrclioConnection;
    const storage = library.store(localStorage);
    const dialog = byId('library');
    const fields = ['name', 'host', 'user', 'port', 'group', 'tags', 'jump', 'identityFile', 'certificateFile'];
    const kindLabels = { ssh: 'SSH', sftp: 'SFTP 命令行', files: '文件浏览' };
    let selected = '';
    let original = null;
    const authFields = ['host', 'user', 'port', 'jump'];
    const addressDraft = () => {
      const parts = Object.fromEntries(authFields.map(field => [field, byId(field).value.trim()]));
      const group = byId('group').value.trim(), inheritGroup = byId('inherit').checked;
      try { return library.routing(storage.resolve({ ...parts, group, inheritGroup })); }
      catch { return JSON.stringify([parts, group, inheritGroup]); }
    };
    let authAddress = addressDraft();
    let activeRecent = null;
    let accountGeneration = 0;
    let available = {};
    const status = value => { byId('status').textContent = value; };
    const form = () => ({
      ...Object.fromEntries(fields.map(field => [field, byId(field).value.trim()])),
      inheritGroup: byId('inherit').checked,
      environment: byId('environment').value,
      favorite: byId('favorite').checked,
      agentForwarding: byId('agent-forwarding').checked,
    });

    const envText = items => typeof items === 'string' ? items : (items || []).map(item => item.name + '=' + item.value).join('\n');
    function inheritedPreview() {
      const group = byId('group').value.trim();
      let text = '';
      if (group && byId('inherit').checked) {
        try {
          const values = storage.resolve({ host: 'preview', group, inheritGroup: true });
          text = [values.user && '用户 ' + values.user, values.port && '端口 ' + values.port,
            values.jump && '跳板 ' + values.jump, values.environment?.map(item => item.name).join(', ')].filter(Boolean).join(' · ');
        } catch { /* Incomplete group paths have no defaults to show yet. */ }
      }
      byId('inherited').textContent = text ? '分组默认值　' + text : '';
    }

    function showGroup(path) {
      const config = storage.groupConfigs().find(entry => entry.group === path);
      byId('config-path').value = path;
      for (const field of ['user', 'port', 'jump']) byId('config-' + field).value = config?.[field] ?? '';
      byId('config-environment').value = envText(config?.environment);
      byId('config-remove').disabled = !config;
    }

    function showItem(item, name = '') {
      selected = name;
      original = name ? item : null;
      for (const field of fields) {
        const value = item?.[field];
        byId(field).value = Array.isArray(value) ? value.join(', ') : value ?? '';
      }
      byId('favorite').checked = !!item?.favorite;
      byId('agent-forwarding').checked = item?.agentForwarding === true;
      byId('environment').value = envText(item?.environment);
      byId('inherit').checked = item ? item.inheritGroup === true : true;
      authAddress = addressDraft();
      inheritedPreview();
      byId('advanced').open = !!(item?.jump || item?.identityFile || item?.certificateFile || item?.agentForwarding || item?.environment?.length);
      byId('editor-title').textContent = selected || '新建主机';
      byId('remove').disabled = byId('duplicate').disabled = !selected;
      byId('delete-check').hidden = true;
      window.dispatchEvent(new Event('brclio-terminal-host-editor-changed'));
    }

    function render() {
      const records = storage.all();
      const configs = storage.groupConfigs();
      const paths = library.groups([...records, ...configs]);
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
        subtitle.textContent = [recents ? kindLabels[item.kind] : item.group, library.format(library.resolve(item, configs)), ...(item.tags || [])].filter(Boolean).join(' · ');
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
      const target = storage.resolve(value);
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
      const matches = saved && JSON.stringify(storage.resolve(saved)) === JSON.stringify(target);
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
      showGroup('');
      byId('group-editor').open = false;
      byId('quick').value = byId('search').value = '';
      byId('view').value = 'all';
      guarded(render);
      status('');
    });
    window.addEventListener('brclio-terminal-library-applied', () => {
      if (!dialog.open) return;
      guarded(() => {
        if (selected) {
          const current = storage.all().find(record => record.name === selected);
          if (JSON.stringify(current) !== JSON.stringify(original)) {
            let pristine = false;
            try { pristine = JSON.stringify(library.named(form())) === JSON.stringify(original); } catch { /* Unfinished edits stay in the form. */ }
            if (pristine) showItem(current, current?.name);
            else status('此主机的已保存配置已更新。可将当前编辑复制为新主机，或重新选择列表中的主机。');
          }
        }
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

    function checkAddress() {
      const changed = authAddress !== addressDraft();
      authAddress = addressDraft();
      if (changed && (byId('agent-forwarding').checked || byId('certificateFile').value || byId('environment').value || byId('identityFile').value)) {
        byId('agent-forwarding').checked = false;
        for (const field of ['identityFile', 'certificateFile', 'environment']) byId(field).value = '';
        window.dispatchEvent(new Event('brclio-terminal-host-editor-changed'));
        status('SSH 目标已变更，请为新目标重新选择身份、代理转发和环境变量。');
      }
      inheritedPreview();
    }
    for (const key of [...authFields, 'group', 'inherit']) byId(key).addEventListener('input', checkAddress);
    byId('config-path').addEventListener('input', () => guarded(() => showGroup(byId('config-path').value)));
    byId('group-editor').querySelector('summary').addEventListener('click', () => {
      if (!byId('group-editor').open) guarded(() => showGroup(byId('group').value.trim() || byId('group-filter').value));
    });
    function editGroup(remove) {
      const group = library.groupPath(byId('config-path').value);
      const prior = selected && storage.all().find(item => item.name === selected);
      if (remove) storage.removeGroup(group);
      else storage.saveGroup({ group, ...Object.fromEntries(['user', 'port', 'jump', 'environment'].map(field =>
        [field, byId('config-' + field).value])) });
      if (selected && JSON.stringify(original) === JSON.stringify(prior)) original = storage.all().find(item => item.name === selected);
      showGroup(group);
      render();
      status(remove ? '已清除本级分组设置。' : '已保存分组设置。');
      checkAddress();
    }
    byId('config-remove').onclick = () => guarded(() => editGroup(true));
    byId('config-save').onclick = () => guarded(() => editGroup(false));
    byId('choose-certificate').onclick = () => guarded(async () => {
      const generation = accountGeneration;
      const target = selected;
      const result = await api.chooseIdentity('certificate');
      if (result && generation === accountGeneration && target === selected && dialog.open) byId('certificateFile').value = result.path;
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
        checkAddress();
        if (original && JSON.stringify(storage.all().find(item => item.name === selected)) !== JSON.stringify(original)) {
          throw new Error('此主机的已保存配置已更新。请重新选择，或复制为新主机以保留当前编辑。');
        }
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
    for (const kind of ['ssh', 'sftp', 'files']) byId(kind).onclick = () => guarded(() => {
      checkAddress();
      return connect(kind, form(), selected);
    });
  },
};

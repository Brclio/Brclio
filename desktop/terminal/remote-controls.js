'use strict';

window.BrclioRemoteConnections = {
  bind(api, launch) {
    const byId = name => document.getElementById('remote-' + name);
    const storage = window.BrclioConnection.store(localStorage);
    const list = byId('list');
    const status = byId('status');
    const details = byId('connections');
    const fields = ['name', 'host', 'user', 'port'];
    const form = () => Object.fromEntries(fields.map(field => [field, byId(field).value.trim()]));
    const clear = () => { for (const field of fields) byId(field).value = ''; };
    function populate(selected = '') {
      list.replaceChildren(new Option('新连接', ''), ...storage.all().map(item => new Option(item.name, item.name)));
      list.value = selected;
      byId('remove').disabled = !selected;
    }
    details.addEventListener('toggle', async () => {
      if (!details.open) return;
      try {
        populate(list.value);
        const clients = await api.remoteClients();
        for (const kind of ['ssh', 'sftp']) byId(kind).disabled = !clients[kind];
        const missing = ['ssh', 'sftp'].filter(kind => !clients[kind]);
        status.textContent = missing.length ? '未找到 ' + missing.join('、') + '。请安装系统 OpenSSH 客户端。' : '';
      } catch (error) { status.textContent = error.message; }
    });
    list.onchange = () => {
      try {
        const item = storage.all().find(value => value.name === list.value);
        for (const field of fields) byId(field).value = item?.[field] ?? '';
        byId('remove').disabled = !item;
        status.textContent = '';
      } catch (error) { status.textContent = error.message; }
    };
    byId('save').onclick = () => {
      try {
        const saved = storage.save(form());
        populate(saved.name);
        status.textContent = '已保存 ' + saved.name;
      } catch (error) { status.textContent = error.message; }
    };
    byId('remove').onclick = () => {
      try {
        storage.remove(list.value);
        clear();
        populate();
        status.textContent = '已删除连接。';
      } catch (error) { status.textContent = error.message; }
    };
    for (const kind of ['ssh', 'sftp']) byId(kind).onclick = () => {
      try {
        const value = form();
        const target = window.BrclioConnection.endpoint(value);
        launch(kind, kind.toUpperCase() + ' · ' + (value.name || target.host).slice(0, 64), target);
      } catch (error) { status.textContent = error.message; }
    };
  },
};

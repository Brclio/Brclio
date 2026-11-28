'use strict';

(() => {
  const key = 'brclio.terminal.local-identities.v1';
  const node = typeof module === 'object' && module.exports;
  const { endpoint } = node ? require('./connection.js') : window.BrclioConnection;

  function record(value) {
    const name = typeof value?.name === 'string' ? value.name.trim() : '';
    if (!name || name.length > 64 || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(name)) throw new Error('请输入 1 到 64 字的身份名称。');
    const { user, identityFile } = endpoint({ host: 'local', user: value.user, identityFile: value.path });
    if (!identityFile) throw new Error('请选择私钥文件。');
    return { name, user, path: identityFile };
  }

  function store(storage) {
    if (!node && storage === window.localStorage) storage = window.BrclioTerminalPartitions?.storage || storage;
    function all() {
      const items = JSON.parse(storage.getItem(key) || '[]');
      if (!Array.isArray(items) || items.length > 128) throw new Error('本机 SSH 身份列表格式无效。');
      return items.map(record);
    }
    function write(items) {
      storage.setItem(key, JSON.stringify(items));
      if (!node) window.dispatchEvent(new Event('brclio-identities-changed'));
    }
    return { all,
      save(value, previous = '') {
        const item = record(value);
        const items = all();
        if (items.some(entry => entry.name === item.name && item.name !== previous)) throw new Error('已有同名身份。');
        const next = items.filter(entry => entry.name !== previous);
        if (next.length >= 128) throw new Error('最多可保存 128 个本机身份。');
        write([...next, item]);
        return item;
      },
      remove(name) { write(all().filter(entry => entry.name !== name)); },
    };
  }

  const api = { record, store };
  if (node) module.exports = api;
  else window.BrclioIdentities = api;
})();

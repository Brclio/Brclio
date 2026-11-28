'use strict';

(() => {
  const node = typeof module === 'object' && module.exports;
  const connection = node ? require('./connection.js') : window.BrclioConnection;
  const key = 'brclio.terminal.port-forwards.v1';

  function port(value) {
    if (!/^\d+$/.test(String(value)) || !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 65535) {
      throw new Error('请输入 1 到 65535 之间的端口。');
    }
    return Number(value);
  }

  function rule(value) {
    const type = value?.type;
    if (!['local', 'remote', 'dynamic'].includes(type)) throw new Error('请选择转发类型。');
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    if (!name || name.length > 64 || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(name)) throw new Error('请输入 1 到 64 字的规则名称。');
    const listenHost = connection.endpoint({ host: value.listenHost || '127.0.0.1' }).host;
    const result = { name, type, connection: connection.endpoint(value.connection), listenHost, listenPort: port(value.listenPort) };
    if (type !== 'dynamic') {
      result.destinationHost = connection.endpoint({ host: value.destinationHost }).host;
      result.destinationPort = port(value.destinationPort);
    }
    return result;
  }

  function address(host, port) {
    return (host.includes(':') ? '[' + host + ']' : host) + ':' + port;
  }

  function argumentsFor(value) {
    const item = rule(value);
    let specification = address(item.listenHost, item.listenPort);
    if (item.type !== 'dynamic') specification += ':' + address(item.destinationHost, item.destinationPort);
    // A multiplexed or forked client could keep listening after its Brclio tab closes.
    const args = ['-N', '-T', '-S', 'none', '-o', 'ControlMaster=no',
      '-o', 'IgnoreUnknown=ForkAfterAuthentication', '-o', 'ForkAfterAuthentication=no',
      '-o', 'ExitOnForwardFailure=yes', { local: '-L', remote: '-R', dynamic: '-D' }[item.type], specification];
    return [...args, ...require('./remote-launch.cjs').argumentsFor('ssh', item.connection, false)];
  }

  function store(storage) {
    if (!node && storage === window.localStorage) storage = window.BrclioTerminalPartitions?.storage || storage;
    function all() {
      const entries = JSON.parse(storage.getItem(key) || '[]');
      if (!Array.isArray(entries) || entries.length > 128) throw new Error('端口转发规则格式无效。');
      return entries.map(rule);
    }
    function notify() { if (!node) window.dispatchEvent(new Event('brclio-terminal-library-changed')); }
    return {
      all,
      replace(items) {
        if (!Array.isArray(items) || items.length > 128) throw new Error('端口转发规则格式无效。');
        const entries = items.map(rule);
        if (new Set(entries.map(entry => entry.name)).size !== entries.length) throw new Error('转发规则名称重复。');
        storage.setItem(key, JSON.stringify(entries));
      },
      save(value, previousName = '') {
        const item = rule(value);
        const items = all();
        if (item.name !== previousName && items.some(entry => entry.name === item.name)) throw new Error('已有同名规则。');
        const next = items.filter(entry => entry.name !== previousName);
        if (next.length >= 128) throw new Error('最多可保存 128 条转发规则。');
        storage.setItem(key, JSON.stringify([...next, item]));
        notify();
        return item;
      },
      remove(name) { storage.setItem(key, JSON.stringify(all().filter(entry => entry.name !== name))); notify(); },
    };
  }

  const api = { rule, address, store };
  if (node) module.exports = { ...api, argumentsFor };
  else window.BrclioForwardModel = api;
})();

'use strict';

(() => {
  function endpoint(value) {
    const host = typeof value?.host === 'string' ? value.host.trim().replace(/^\[([^\]]+)\]$/, '$1') : '';
    const user = value?.user == null ? '' : value.user;
    const port = value?.port == null || value.port === '' ? null : Number(value.port);
    const ipv6 = host.includes(':');
    if (host.length > 255 || !(ipv6 ? /^[\da-f:.]+(?:%[a-z\d_.-]+)?$/i : /^[a-z\d_][a-z\d._-]*$/i).test(host)) {
      throw new Error('请输入主机名、SSH 配置别名或 IP 地址。');
    }
    if (ipv6) {
      try { new URL('http://[' + host.split('%')[0] + ']/'); }
      catch { throw new Error('IPv6 主机地址无效。'); }
    }
    if (typeof user !== 'string' || user.length > 128 || (user && !/^[a-z\d_][a-z\d.@_-]*$/i.test(user))) {
      throw new Error('用户名包含不支持的字符。');
    }
    if (port !== null && (!/^\d+$/.test(String(value.port)) || !Number.isInteger(port) || port < 1 || port > 65535)) {
      throw new Error('端口应为 1 到 65535 的整数，或留空以使用 SSH 配置。');
    }
    return { host, user, port };
  }

  const key = 'brclio.terminal.connections.v1';
  function named(record) {
    if (typeof record?.name !== 'string' || !record.name.trim() || record.name.length > 64 ||
        /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(record.name)) throw new Error('请输入 1 到 64 字的连接名称。');
    return { name: record.name.trim(), ...endpoint(record) };
  }
  function store(storage) {
    function all() {
      const records = JSON.parse(storage.getItem(key) || '[]');
      if (!Array.isArray(records) || records.length > 128) throw new Error('已保存的连接格式无效。');
      return records.map(named);
    }
    return {
      all,
      save(value) {
        const record = named(value);
        const list = all().filter(item => item.name !== record.name);
        if (list.length >= 128) throw new Error('最多可保存 128 个连接。');
        storage.setItem(key, JSON.stringify([...list, record]));
        return record;
      },
      remove(name) { storage.setItem(key, JSON.stringify(all().filter(item => item.name !== name))); },
    };
  }
  const api = { endpoint, store };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.BrclioConnection = api;
})();

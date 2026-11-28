'use strict';

(() => {
  const legacyKey = 'brclio.terminal.connections.v1';
  const libraryKey = 'brclio.terminal.host-library.v2';
  const invisible = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u;

  function address(value) {
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

  function parseAddress(text) {
    if (!text || /[\/\\\s?#]/.test(text)) throw new Error('连接地址格式为 [用户名@]主机[:端口]。');
    const at = text.lastIndexOf('@');
    const user = at < 0 ? '' : text.slice(0, at);
    let host = text.slice(at + 1);
    if (at >= 0 && !user) throw new Error('请输入 @ 前面的用户名。');
    let port = null;
    const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(host);
    if (bracket) {
      if (!bracket[1].includes(':')) throw new Error('方括号只用于 IPv6 地址。');
      host = bracket[1];
      port = bracket[2];
    } else if (host.indexOf(':') >= 0 && host.indexOf(':') === host.lastIndexOf(':')) {
      [host, port] = host.split(':');
      if (!port) throw new Error('请输入冒号后面的端口。');
    }
    return address({ host, user, port });
  }

  function format(value) {
    const host = value.host.includes(':') ? '[' + value.host + ']' : value.host;
    return (value.user ? value.user + '@' : '') + host + (value.port ? ':' + value.port : '');
  }

  function quick(value) {
    if (typeof value !== 'string' || value.length > 512) throw new Error('连接地址过长。');
    const match = /^(?:(ssh|sftp):\/\/)?(.+)$/i.exec(value.trim());
    if (!match) throw new Error('请输入连接地址。');
    const protocol = match[1]?.toLowerCase() || 'ssh';
    const raw = match[1] ? match[2].replace(/\/$/, '').replace(/%25(?=[a-z\d_.-]+\])/i, '%') : match[2];
    return { protocol, ...parseAddress(raw) };
  }

  function endpoint(value) {
    const result = address(value);
    if (value.jump != null && value.jump !== '') {
      if (typeof value.jump !== 'string' || value.jump.length > 2048) throw new Error('跳板地址格式无效。');
      const hops = value.jump.split(',');
      if (hops.length > 8) throw new Error('一条连接最多使用 8 个跳板。');
      result.jump = hops.map(hop => format(parseAddress(hop.trim()))).join(',');
    }
    for (const field of ['identityFile', 'certificateFile']) {
      const file = value[field];
      if (file == null || file === '') continue;
      if (typeof file !== 'string' || file.length > 1024 || invisible.test(file) ||
          !/^(?:\/(?!\/)|~\/|[a-z]:[\\/])/i.test(file)) {
        throw new Error((field === 'identityFile' ? '私钥' : '证书') + '文件请填写本机绝对路径，或以 ~/ 开头的路径。');
      }
      if (field === 'certificateFile' && file.includes('${')) throw new Error('证书路径包含 OpenSSH 环境变量占位符，请选择其他文件名。');
      result[field] = file;
    }
    if (value.agentForwarding != null && typeof value.agentForwarding !== 'boolean') throw new Error('代理转发开关格式无效。');
    if (value.agentForwarding === true) result.agentForwarding = true;
    return result;
  }

  function label(value, limit, hint) {
    if (typeof value !== 'string' || !value.trim() || value.length > limit || invisible.test(value)) {
      throw new Error(hint);
    }
    return value.trim();
  }

  function named(record) {
    const name = label(record?.name, 64, '请输入 1 到 64 字的主机名称。');
    const result = { name, ...endpoint(record) };
    if (record.group) {
      const path = label(record.group, 120, '分组名称过长或含不可显示的字符。');
      const parts = path.split('/').map(s => s.trim());
      if (parts.some(part => !part)) throw new Error('分组路径中的每一级都需要名称。');
      result.group = parts.join('/');
    }
    if (record.tags != null && record.tags !== '') {
      const tags = Array.isArray(record.tags) ? record.tags : typeof record.tags === 'string' ? record.tags.split(/[,，]/) : null;
      if (!tags || tags.length > 16) throw new Error('每台主机最多可以添加 16 个标签。');
      const cleaned = [...new Set(tags.map(tag => label(tag, 40, '每个标签需要 1 到 40 个可显示的字符。')))];
      if (cleaned.length) result.tags = cleaned;
    }
    if (record.favorite === true) result.favorite = true;
    return result;
  }

  function recent(value) {
    if (!['ssh', 'sftp', 'files'].includes(value?.kind)) throw new Error('最近连接的协议无效。');
    const result = { kind: value.kind, ...endpoint(value) };
    if (value.name) result.name = label(value.name, 64, '最近连接的主机名称无效。');
    return result;
  }

  function store(storage) {
    if (typeof window === 'object' && storage === window.localStorage) storage = window.BrclioTerminalPartitions?.storage || storage;
    function read() {
      const raw = storage.getItem(libraryKey);
      const library = raw == null ? { hosts: JSON.parse(storage.getItem(legacyKey) || '[]'), recent: [] } : JSON.parse(raw);
      if (!Array.isArray(library?.hosts) || library.hosts.length > 2048 ||
          !Array.isArray(library.recent) || library.recent.length > 24) throw new Error('已保存的主机库格式无效。');
      return { hosts: library.hosts.map(named), recent: library.recent.map(recent) };
    }
    const write = library => storage.setItem(libraryKey, JSON.stringify(library));
    const notify = () => { if (typeof window === 'object') window.dispatchEvent(new Event('brclio-terminal-library-changed')); };
    return {
      all: () => read().hosts,
      recents: () => read().recent,
      replace(items) {
        if (!Array.isArray(items) || items.length > 2048) throw new Error('主机库格式无效。');
        const hosts = items.map(named);
        const names = new Set(hosts.map(item => item.name));
        if (hosts.length !== names.size) throw new Error('主机名称重复。');
        const library = read();
        library.hosts = hosts;
        library.recent = library.recent.filter(item => !item.name || names.has(item.name));
        write(library);
      },
      save(value, previous = value?.name?.trim()) {
        const item = named(value);
        const library = read();
        if (item.name !== previous && library.hosts.some(host => host.name === item.name)) throw new Error('这个主机名称已被使用。');
        const index = library.hosts.findIndex(host => host.name === previous);
        if (index < 0) {
          if (library.hosts.length >= 2048) throw new Error('最多可保存 2048 台主机。');
          library.hosts.push(item);
        } else {
          library.hosts[index] = item;
          library.recent = library.recent.map(entry => entry.name === previous ? recent({ ...item, kind: entry.kind }) : entry);
        }
        write(library);
        notify();
        return item;
      },
      remove(name) {
        const library = read();
        library.hosts = library.hosts.filter(host => host.name !== name);
        library.recent = library.recent.filter(entry => entry.name !== name);
        write(library);
        notify();
      },
      recordUse(kind, target, name) {
        const library = read();
        const item = recent({ ...target, kind, name });
        const signature = value => JSON.stringify([value.kind, value.host, value.user, value.port, value.jump, value.identityFile, value.certificateFile, value.agentForwarding]);
        library.recent = [item, ...library.recent.filter(entry => signature(entry) !== signature(item))].slice(0, 24);
        write(library);
      },
      clearRecent() {
        const library = read();
        library.recent = [];
        write(library);
      },
    };
  }

  function groups(records) {
    const paths = new Set();
    for (const item of records) {
      if (!item.group) continue;
      const parts = item.group.split('/');
      for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join('/'));
    }
    return [...paths].sort((a, b) => a.localeCompare(b));
  }

  function select(records, { search = '', group = '', favorites = false } = {}) {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    return records.filter(item => {
      if (favorites && !item.favorite) return false;
      if (group && item.group !== group && !item.group?.startsWith(group + '/')) return false;
      const haystack = [item.name, format(item), item.group, ...(item.tags || [])].join(' ').toLowerCase();
      return words.every(word => haystack.includes(word));
    }).sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || a.name.localeCompare(b.name));
  }

  const api = { endpoint, quick, format, named, store, groups, select };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.BrclioConnection = api;
})();

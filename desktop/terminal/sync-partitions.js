'use strict';

(() => {
  const legacy = 'brclio.terminal.connections.v1';
  const hostKey = 'brclio.terminal.host-library.v2';
  const forwardKey = 'brclio.terminal.port-forwards.v1';
  const identityKey = 'brclio.terminal.local-identities.v1';
  const snippets = 'brclio.terminal.snippets.v1';
  const arrangements = 'brclio.terminal.arrangements.v1';
  const dynamic = 'brclio.terminal.dynamic-import.v1';
  const rules = 'brclio.terminal.profile-rules.v1';
  const extras = [snippets, arrangements, dynamic, rules];
  const keys = [legacy, hostKey, forwardKey, identityKey, ...extras];

  function combined(existing, imported, maximum) {
    const names = new Map(existing.map(item => [item.name, item]));
    const mapped = new Map();
    for (const item of imported) {
      let name = item.name;
      for (let i = 1; names.has(name); i++) {
        if (JSON.stringify(names.get(name)) === JSON.stringify({ ...item, name })) break;
        name = item.name.slice(0, 48) + ' (本机 ' + i + ')';
      }
      names.set(name, { ...item, name });
      mapped.set(item.name, name);
    }
    if (names.size > maximum) throw new Error('移入后配置数量超过本机上限。');
    return { items: [...names.values()], mapped };
  }

  function combineExtras(key, existing, imported) {
    if (!Array.isArray(existing) || !Array.isArray(imported)) throw new Error('本机终端资料格式无效。');
    if (key === arrangements) return combined(existing, imported, Infinity).items;
    const merged = [...existing];
    for (const item of imported) {
      if (key === rules) {
        if (!merged.some(rule => rule.host === item.host && rule.path === item.path && rule.profile === item.profile)) merged.push(item);
      } else if (key === dynamic) {
        const match = merged.find(entry => entry.guid === item.guid);
        if (!match) merged.push(item);
        else if (JSON.stringify(match) !== JSON.stringify(item)) merged.push({ ...item, guid: crypto.randomUUID() });
      } else {
        let name = item.name;
        let duplicate = false;
        for (let n = 1; ; n++) {
          const match = merged.find(entry => entry.kind === item.kind && entry.name === name);
          if (!match) break;
          if (match.text === item.text) { duplicate = true; break; }
          name = item.name.slice(0, 64) + ' (本机 ' + n + ')';
        }
        if (duplicate) continue;
        const id = merged.some(entry => entry.id === item.id) ? crypto.randomUUID() : item.id;
        merged.push({ ...item, name, id });
      }
    }
    const max = key === dynamic ? 64 : key === rules ? 32 : 200;
    if (merged.length > max || (key === snippets && merged.reduce((sum,item) => sum + item.text.length, 0) > 512 * 1024)) {
      throw new Error('移入后终端资料超过当前容量，请先整理后重试。');
    }
    return merged;
  }

  function create(raw) {
    let ready = false;
    let owner = null;
    const resolve = key => !ready ? null : owner ? 'brclio.terminal.account.v1.' + encodeURIComponent(owner) + '/' + key : key;
    const storage = {
      getItem(key) {
        const actual = resolve(key);
        return actual === null ? null : raw.getItem(actual);
      },
      setItem(key, value) {
        const actual = resolve(key);
        if (actual === null) throw new Error('正在确认本机账号，请稍后再试。');
        raw.setItem(actual, value);
      },
      removeItem(key) {
        const actual = resolve(key);
        if (actual === null) throw new Error('正在确认本机账号，请稍后再试。');
        raw.removeItem(actual);
      },
    };
    const parse = (source, key, fallback) => JSON.parse(source.getItem(key) || JSON.stringify(fallback));
    const hosts = source => parse(source, hostKey, { hosts: parse(source, legacy, []), recent: [] });
    return {
      storage,
      get ready() { return ready; },
      get owner() { return owner; },
      lock() { ready = false; owner = null; },
      activate(id) {
        if (id != null && (typeof id !== 'string' || !id || id.length > 256 || /[\x00-\x20\x7f]/.test(id))) throw new Error('Brclio 账号标识无效。');
        ready = true;
        owner = id || null;
      },
      hasUnbound() {
        const library = hosts(raw);
        return !!(library.hosts.length || library.recent.length || parse(raw, forwardKey, []).length || parse(raw, identityKey, []).length ||
          extras.some(key => { const value = raw.getItem(key); return value !== null && value !== '[]'; }));
      },
      moveUnbound() {
        if (!ready || !owner) throw new Error('请先确认移入资料的 Brclio 账号。');
        const source = hosts(raw), destination = hosts(storage);
        const merged = combined(destination.hosts, source.hosts, 2048);
        const recent = [...destination.recent, ...source.recent.map(item =>
          item.name && merged.mapped.has(item.name) ? { ...item, name: merged.mapped.get(item.name) } : item)];
        const values = [
          [hostKey, { hosts: merged.items, recent: [...new Map(recent.map(item => [JSON.stringify(item), item])).values()].slice(0, 24) }],
          [forwardKey, combined(parse(storage, forwardKey, []), parse(raw, forwardKey, []), 128).items],
          [identityKey, combined(parse(storage, identityKey, []), parse(raw, identityKey, []), 128).items],
        ];
        for (const key of extras) {
          if (raw.getItem(key) !== null) values.push([key, combineExtras(key, parse(storage, key, []), parse(raw, key, []))]);
        }
        const before = values.map(([key]) => storage.getItem(key));
        try {
          values.forEach(([key, data]) => storage.setItem(key, JSON.stringify(data)));
        } catch (error) {
          values.forEach(([key], i) => {
            if (storage.getItem(key) === before[i]) return;
            if (before[i] == null) storage.removeItem(key); else storage.setItem(key, before[i]);
          });
          throw error;
        }
        // Account data never uses raw keys. Only a confirmed move consumes the
        // unassociated library; logging in or enabling cloud sync cannot do so.
        for (const key of keys) raw.removeItem(key);
      },
    };
  }

  if (typeof module === 'object' && module.exports) module.exports = { create };
  else window.BrclioTerminalPartitions = create(localStorage);
})();

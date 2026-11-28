'use strict';

(() => {
  const node = typeof module === 'object' && module.exports;
  const hosts = node ? require('./connection.js') : window.BrclioConnection;
  const forwards = node ? require('./forward-model.js') : window.BrclioForwardModel;
  const collections = ['hosts', 'forwards'];
  const localCredentials = ['identityFile', 'certificateFile', 'agentForwarding'];
  const empty = () => ({ hosts: [], forwards: [] });
  const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const sort = items => items.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  function portable(raw) {
    const result = empty();
    for (const key of collections) {
      if (!Array.isArray(raw?.[key]) || raw[key].length > (key === 'hosts' ? 2048 : 128)) throw new Error('终端同步数据格式无效。');
      const names = new Set();
      for (const record of raw[key]) {
        const item = key === 'hosts' ? hosts.named(record) : forwards.rule(record);
        // Reconstruct from each feature's allowlisted schema. Device paths, secrets,
        // recent connections, transcripts and active processes never enter the payload.
        const target = key === 'hosts' ? item : item.connection;
        for (const field of localCredentials) delete target[field];
        if (names.has(item.name)) throw new Error('同步配置包含重复名称。');
        names.add(item.name);
        result[key].push(item);
      }
      sort(result[key]);
    }
    return result;
  }

  function fitsUpload(data) {
    return new TextEncoder().encode(JSON.stringify(data)).length <= 112 * 1024;
  }

  function merge(base, local, cloud, choices = {}) {
    const result = empty();
    const conflicts = [];
    for (const key of collections) {
      const [before, here, there] = [base, local, cloud].map(snapshot => new Map(snapshot[key].map(record => [record.name, record])));
      const names = new Set([...before.keys(), ...here.keys(), ...there.keys()]);
      for (const name of names) {
        const old = before.get(name), device = here.get(name), remote = there.get(name);
        let selected;
        if (equal(device, remote) || equal(remote, old)) selected = device;
        else if (equal(device, old)) selected = remote;
        else {
          const id = JSON.stringify([key, name]);
          if (choices[id] === 'device') selected = device;
          else if (choices[id] === 'cloud') selected = remote;
          else { conflicts.push({ id, key, name, device, cloud: remote }); continue; }
        }
        if (selected) result[key].push(selected);
      }
      sort(result[key]);
    }
    return { data: result, conflicts };
  }

  function localLibraries(storage) {
    const libraries = { hosts: hosts.store(storage), forwards: forwards.store(storage) };
    const read = () => ({ hosts: libraries.hosts.all(), forwards: libraries.forwards.all() });
    return {
      read: () => portable(read()),
      apply(incoming) {
        const next = portable(incoming);
        const old = read();
        const current = portable(old);
        if (equal(next, current)) return;
        for (const key of collections) {
          const records = new Map(old[key].map(record => [record.name, record]));
          for (const record of next[key]) {
            const prior = records.get(record.name);
            const previous = key === 'hosts' ? prior : prior?.connection;
            const target = key === 'hosts' ? record : record.connection;
            if (!previous) continue;
            const previousAddress = hosts.endpoint(previous);
            for (const field of localCredentials) delete previousAddress[field];
            if (equal(previousAddress, hosts.endpoint(target))) {
              for (const field of localCredentials) if (previous[field]) target[field] = previous[field];
            }
          }
        }
        // Both writes are synchronous. Roll back the first if the platform denies
        // the second (for example when its storage quota is reached).
        const keys = ['brclio.terminal.host-library.v2', 'brclio.terminal.port-forwards.v1'];
        const originals = keys.map(key => storage.getItem(key));
        try {
          libraries.hosts.replace(next.hosts);
          libraries.forwards.replace(next.forwards);
        } catch (error) {
          for (const [i, key] of keys.entries()) {
            if (storage.getItem(key) === originals[i]) continue;
            if (originals[i] == null) storage.removeItem(key);
            else storage.setItem(key, originals[i]);
          }
          throw error;
        }
      },
    };
  }

  const api = { empty, equal, portable, fitsUpload, merge, localLibraries };
  if (node) module.exports = api;
  else window.BrclioTerminalSyncModel = api;
})();

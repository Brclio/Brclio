'use strict';

(() => {
  const model = typeof module === 'object' ? require('./snippet-model.js') : window.BrclioSnippetModel;
  const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  function normalize(items) {
    if (!Array.isArray(items) || items.length > 200) throw new Error('剪藏数量超过上限。');
    const seen = new Set();
    return items.map(raw => {
      const item = model.normalize(raw);
      if (item.kind !== 'snippet' || seen.has(item.id)) throw new Error('云端剪藏格式无效。');
      seen.add(item.id); return item;
    }).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }
  function merge(base, local, remote, choice) {
    const [before,here,there] = [base,local,remote].map(items => new Map(normalize(items).map(item => [item.id,item])));
    const items = [], conflicts = [];
    for (const id of new Set([...before.keys(),...here.keys(),...there.keys()])) {
      const old = before.get(id), device = here.get(id), cloud = there.get(id);
      let item;
      if (same(device,cloud) || same(old,cloud)) item = device;
      else if (same(old,device)) item = cloud;
      else if (choice) item = choice === 'local' ? device : cloud;
      else { conflicts.push((device || cloud).name); continue; }
      if (item) items.push(item);
    }
    return {items:normalize(items),conflicts};
  }
  const api = {normalize,merge,same};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.BrclioSnippetSyncModel = api;
})();

'use strict';

(() => {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function variables(value) {
    // Inventory may contain SSH passwords, keys, executable plugins or Jinja.
    // Only literal connection fields can reach the host preview.
    const result = {};
    if (object(value)) {
      for (const key of ['ansible_host','ansible_user','ansible_port','ansible_connection']) {
        if (Object.hasOwn(value,key)) result[key] = value[key];
      }
    }
    return result;
  }

  function read(text, add, warn) {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('请选择有效的 Ansible inventory JSON 文件。'); }
    if (!object(data)) throw new Error('请选择 Ansible inventory JSON 对象。');
    const groups = new Map(), hosts = new Map();
    const definitions = Object.entries(data).filter(([name]) => name !== '_meta');
    let recognized = false, edges = 0, memberships = 0;
    function group(name) {
      if (typeof name !== 'string' || !name.trim() || name.length > 120) throw new Error('Ansible 组名无效。');
      if (!groups.has(name)) groups.set(name,{name,parents:new Set(),vars:{}});
      if (groups.size > 512) throw new Error('Ansible 清单最多支持 512 个分组。');
      return groups.get(name);
    }
    function host(name) {
      if (typeof name !== 'string' || !name.trim()) throw new Error('Ansible 主机别名无效。');
      if (!hosts.has(name)) hosts.set(name,{groups:new Set(),vars:{}});
      if (hosts.size > 2048) throw new Error('一次最多导入 2048 台主机。');
      return hosts.get(name);
    }
    function hostVars(item, value) {
      Object.assign(item.vars,variables(value));
      // The Brclio inventory exporter stores its original label/group as host metadata.
      if (object(value)) for (const field of ['brclio_label','brclio_group']) {
        if (typeof value[field] === 'string') item[field] = value[field];
      }
    }
    function entries(list) {
      if (list == null) return [];
      if (Array.isArray(list)) return list.map(name => [name,null]);
      if (object(list)) return Object.entries(list);
      throw new Error('Ansible 清单中的 hosts 或 children 应为列表或对象。');
    }

    for (let i=0; i<definitions.length; i++) {
      const [name, def] = definitions[i], current = group(name);
      if (def == null) continue;
      if (!object(def)) throw new Error('所选文件含无效的 Ansible 分组。');
      if (['hosts','children','vars'].some(key => Object.hasOwn(def,key))) recognized = true;
      Object.assign(current.vars,variables(def.vars));
      for (const [alias, vars] of entries(def.hosts)) {
        if (++memberships > 8192) throw new Error('Ansible 主机与分组的关联过多。');
        const saved = host(alias);
        saved.groups.add(name);
        hostVars(saved,vars);
      }
      for (const [child, definition] of entries(def.children)) {
        if (++edges > 4096) throw new Error('Ansible 子组关联过多。');
        group(child).parents.add(name);
        if (definition != null) definitions.push([child,definition]);
      }
    }
    if (object(data._meta?.hostvars)) {
      recognized = true;
      for (const [alias, vars] of Object.entries(data._meta.hostvars)) hostVars(host(alias),vars);
    }
    if (!recognized) throw new Error('未找到 Ansible hosts、children 或 _meta.hostvars。');

    // Resolve each group once. A cycle makes inherited routing ambiguous.
    const resolving = new Set(), resolved = new Map();
    function lineage(current, depth = 0) {
      if (resolved.has(current)) return resolved.get(current);
      if (resolving.has(current)) throw new Error('Ansible 分组包含循环引用，请修正清单后重试。');
      if (depth > 32) throw new Error('Ansible 分组嵌套超过 32 层。');
      resolving.add(current);
      const parents = [...current.parents].map(name => lineage(groups.get(name),depth+1));
      const level = parents.reduce((n,p) => Math.max(n,p.level+1),0);
      if (level > 32) throw new Error('Ansible 分组嵌套超过 32 层。');
      const prefix = parents.map(parent => parent.path).filter(Boolean).sort()[0];
      const path = ['all','ungrouped'].includes(current.name) ? '' : [prefix,current.name].filter(Boolean).join('/');
      const ancestors = new Set(parents.flatMap(p => [...p.ancestors]));
      ancestors.add(current);
      const state = {path,level,ancestors};
      resolving.delete(current); resolved.set(current,state);
      return state;
    }
    for (const current of groups.values()) lineage(current);
    const order = [...groups.values()].sort((a,b) => lineage(a).level-lineage(b).level || (a.name<b.name ? -1 : a.name>b.name ? 1 : 0));
    for (const [name, item] of hosts) {
      const direct = [...item.groups].filter(key => !['all','ungrouped'].includes(key)).sort();
      const parents = new Set([...item.groups].flatMap(key => [...lineage(groups.get(key)).ancestors]));
      const fields = {...groups.get('all')?.vars};
      for (const g of order) if (g.name !== 'all' && parents.has(g)) Object.assign(fields,g.vars);
      Object.assign(fields,item.vars);
      if (fields.ansible_connection !== undefined && fields.ansible_connection !== 'ssh') { warn('已略过非 SSH 或动态连接类型。'); continue; }
      if (Object.values(fields).some(value => typeof value === 'string' && /\{\{|\{%|\{#/.test(value))) { warn('已略过含未展开模板的连接字段。'); continue; }
      const tags = direct.slice(1).filter(tag => tag.length <= 40).slice(0,16);
      if (tags.length < direct.length - 1) warn('部分额外组名超过标签长度或数量上限。');
      add({name:item.brclio_label || name,host:fields.ansible_host ?? name,user:fields.ansible_user,port:fields.ansible_port,
        group:direct.length ? lineage(groups.get(direct[0])).path : item.brclio_group || '',tags},name);
    }
  }
  if (typeof module === 'object' && module.exports) module.exports = read;
  else window.BrclioAnsibleImport = read;
})();

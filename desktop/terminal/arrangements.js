'use strict';

(() => {
  const key = 'brclio.terminal.arrangements.v1';

  function label(value, required = true) {
    if (typeof value !== 'string') throw new Error('请输入有效的名称。');
    const name = value.trim();
    if ((required && !name) || name.length > 80 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name)) {
      throw new Error('名称长度应在 1 到 80 个字符之间，并使用可显示的文字。');
    }
    return name;
  }

  function hostReference(value) {
    if (!value || !['ssh','sftp'].includes(value.protocol) || !/^[0-9a-f]{64}$/.test(value.fingerprint) ||
        typeof value.name !== 'string' || value.name.length > 64) throw new Error('布局主机引用无效。');
    return {name:label(value.name),protocol:value.protocol,fingerprint:value.fingerprint};
  }
  async function reference(name, protocol, connection) {
    // Persist a fingerprint of routing and local identity references. Exclude
    // passwords, private key bytes, environment values and startup commands.
    const fields = ['host','user','port','jump','proxy','proxyUser','identityFile','certificateFile','agentForwarding','identityId'];
    const bytes = new TextEncoder().encode(JSON.stringify(fields.map(key => connection[key] ?? null)));
    const hash = await crypto.subtle.digest('SHA-256',bytes);
    const fingerprint = Array.from(new Uint8Array(hash),v => v.toString(16).padStart(2,'0')).join('');
    return hostReference({name,protocol,fingerprint});
  }
  function layout(value) {
    if (!value || !Array.isArray(value.tabs) || !value.tabs.length || value.tabs.length > 32) {
      throw new Error('窗口布局应包含 1 到 32 个标签。');
    }
    let total = 0;
    function tree(node, depth) {
      if (!node || depth > 32) throw new Error('窗口布局结构无效。');
      if (node.direction !== undefined) {
        if (!['right', 'down'].includes(node.direction) || !Number.isFinite(node.fraction) || node.fraction < .1 || node.fraction > .9) {
          throw new Error('分屏方向或比例无效。');
        }
        return { direction: node.direction, fraction: node.fraction, first: tree(node.first, depth + 1), second: tree(node.second, depth + 1) };
      }
      if (++total > 32) throw new Error('一个布局最多包含 32 个窗格。');
      if (node.savedHost) return {profile:'default',cwd:null,shellIntegration:false,savedHost:hostReference(node.savedHost)};
      if (typeof node.profile !== 'string' || !/^[\w.-]{1,128}$/.test(node.profile) ||
          (node.cwd != null && (typeof node.cwd !== 'string' || node.cwd.includes('\0') || node.cwd.length > 32767))) {
        throw new Error('窗格的 Shell 或起始目录无效。');
      }
      // Record the requested launch settings only. Dynamic OSC titles, output
      // buffers, typed commands and process IDs never enter local storage.
      const remote = ['ssh', 'sftp', 'ssh-forward', 'ssh-keygen', 'telnet', 'serial', 'mosh'].includes(node.profile);
      return { profile: remote ? 'default' : node.profile, cwd: node.cwd || null, shellIntegration: !remote && node.shellIntegration === true };
    }
    const tabs = value.tabs.map(tab => {
      const before = total;
      const root = tree(tab.root, 0);
      return { name: label(tab.name || '', false), root,
        activePane: Number.isInteger(tab.activePane) && tab.activePane >= 0 && tab.activePane < total - before ? tab.activePane : 0 };
    });
    return { tabs, activeTab: Number.isInteger(value.activeTab) && value.activeTab >= 0 && value.activeTab < tabs.length ? value.activeTab : 0 };
  }

  function store(storage) {
    if (typeof window === 'object' && storage === window.localStorage) storage = window.BrclioTerminalPartitions?.storage || storage;
    function entries() {
      const data = storage.getItem(key);
      if (!data) return [];
      const saved = JSON.parse(data);
      if (!Array.isArray(saved)) throw new Error('保存的布局格式无效。');
      return saved.map(item => ({ name: label(item.name), layout: layout(item.layout) }));
    }
    function get(name) {
      const item = entries().find(entry => entry.name === name);
      if (!item) throw new Error('请先选择已保存的布局。');
      return item.layout;
    }
    return {
      names: () => entries().map(entry => entry.name),
      get,
      save(name, value) {
        name = label(name);
        const list = entries();
        if (list.some(entry => entry.name === name)) throw new Error('这个布局名称已被使用，请换一个名称。');
        list.push({ name, layout: layout(value) });
        storage.setItem(key, JSON.stringify(list));
        return name;
      },
      remove(name) {
        const list = entries();
        if (!list.some(entry => entry.name === name)) throw new Error('请先选择已保存的布局。');
        storage.setItem(key, JSON.stringify(list.filter(entry => entry.name !== name)));
      },
    };
  }

  function capture(tabs, current, paneForNode, rememberHosts = false) {
    const list = Array.from(tabs);
    return layout({ tabs: list.map(tab => {
      const leaves = [];
      function node(element) {
        if (element.classList.contains('pane')) {
          const pane = paneForNode(element);
          leaves.push(pane);
          if (rememberHosts && pane.savedHost) return {savedHost:pane.savedHost};
          const {profile, cwd, shellIntegration} = pane.launch;
          return {profile,cwd,shellIntegration};
        }
        return { direction: element.dataset.direction, fraction: Number(element.firstElementChild.style.flexGrow),
          first: node(element.firstElementChild), second: node(element.lastElementChild) };
      }
      const root = node(tab.panel.firstElementChild);
      return { name: tab.customName, root, activePane: leaves.indexOf(tab.active) };
    }), activeTab: list.indexOf(current) });
  }

  function restore(value, controls) {
    const saved = layout(value);
    function firstLeaf(node) { while (node.direction) node = node.first; return node; }
    function count(node) { return node.direction ? count(node.first) + count(node.second) : 1; }
    const needed = saved.tabs.reduce((sum, tab) => sum + count(tab.root), 0);
    if (controls.liveCount() + needed > 32) throw new Error('打开布局后会超过 32 个运行会话，请先关闭部分窗格。');
    // Always append new tabs. Existing PTYs and their buffers remain attached.
    const added = saved.tabs.map(tab => {
      const first = controls.newTab(tab.name, firstLeaf(tab.root));
      const leaves = [];
      function expand(node, pane) {
        if (!node.direction) { leaves.push(pane); return; }
        const second = controls.split(node.direction, pane, firstLeaf(node.second), node.fraction);
        expand(node.first, pane);
        expand(node.second, second);
      }
      expand(tab.root, first);
      controls.selectPane(leaves[tab.activePane]);
      return first.tab;
    });
    controls.selectTab(added[saved.activeTab]);
    return added.length;
  }

  function bind({ document, storage, snapshot, open, rename }) {
    const byId = id => document.getElementById(id);
    const bank = store(storage);
    const list = byId('arrangement-list');
    const status = byId('arrangement-status');
    function refresh(selected) {
      const names = bank.names();
      list.replaceChildren(...names.map(name => new Option(name, name)));
      if (selected && names.includes(selected)) list.value = selected;
      byId('arrangement-delete').disabled = byId('arrangement-restore').disabled = names.length === 0;
    }
    function action(id, operation) {
      byId(id).addEventListener('click', () => {
        try { status.textContent = operation(); }
        catch (error) { status.textContent = error.message; }
      });
    }
    action('arrangement-save', () => {
      const name = bank.save(byId('arrangement-name').value, snapshot(byId('arrangement-hosts').checked));
      refresh(name);
      return '已保存布局「' + name + '」。';
    });
    action('arrangement-restore', () => '已在 ' + open(bank.get(list.value)) + ' 个新标签中打开布局。');
    action('arrangement-delete', () => {
      const name = list.value;
      bank.remove(name);
      refresh();
      return '已删除布局「' + name + '」。';
    });
    action('tab-rename', () => {
      const name = label(byId('tab-label').value, false);
      rename(name);
      return name ? '当前标签已命名为「' + name + '」。' : '当前标签已恢复自动标题。';
    });
    function reset() {
      list.replaceChildren();
      byId('arrangement-name').value = '';
      byId('arrangement-hosts').checked = false;
      byId('tab-label').value = '';
      status.textContent = '';
      try { refresh(); } catch (error) { status.textContent = error.message; }
    }
    window.addEventListener('brclio-terminal-account-changed', reset);
    window.addEventListener('brclio-terminal-library-moved', reset);
    reset();
  }

  const api = { store, capture, restore, bind, reference };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.BrclioArrangements = api;
})();

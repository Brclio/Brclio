'use strict';

window.BrclioForwardControls = (() => {
  let open;
  function bind({ newTab, activate, stop }) {
    const dialog = document.createElement('dialog');
    dialog.className = 'terminal-network-dialog';
    dialog.id = 'forward-dialog';
    dialog.setAttribute('aria-labelledby', 'forward-title');
    dialog.innerHTML = `
      <div class="dialog-head"><h2 id="forward-title">端口转发</h2><button type="button" data-action="close">关闭</button></div>
      <div class="forward-grid">
        <label class="forward-wide">已保存规则<select id="forward-list"></select></label>
        <label>名称<input id="forward-name" maxlength="64" placeholder="例如 本地数据库"></label>
        <label>类型<select id="forward-type"><option value="local">本地转发</option><option value="remote">远程转发</option><option value="dynamic">动态转发 · SOCKS</option></select></label>
        <label class="forward-wide">使用已保存的 SSH 主机<select id="forward-host-list"></select></label>
        <label class="forward-wide">SSH 主机或配置别名<input id="forward-host" maxlength="255" autocomplete="off" spellcheck="false"></label>
        <label>SSH 用户名<input id="forward-user" maxlength="128" placeholder="使用 SSH 配置" autocomplete="off" spellcheck="false"></label>
        <label>SSH 端口<input id="forward-port" type="number" min="1" max="65535" placeholder="使用 SSH 配置"></label>
        <label><span id="forward-listen-label"></span><input id="forward-listenHost" maxlength="255" spellcheck="false"></label>
        <label>监听端口<input id="forward-listenPort" type="number" min="1" max="65535"></label>
        <label data-destination><span id="forward-destination-label"></span><input id="forward-destinationHost" maxlength="255" spellcheck="false"></label>
        <label data-destination>目标端口<input id="forward-destinationPort" type="number" min="1" max="65535"></label>
      </div>
      <p class="forward-hint" id="forward-hint"></p>
      <div class="network-actions"><button type="button" data-action="save">保存</button><button type="button" data-action="start" class="primary">保存并启动</button><button type="button" data-action="show">查看转发标签</button><button type="button" data-action="stop">停止转发</button><button type="button" data-action="remove">删除规则</button></div>
      <p id="forward-status" role="status"></p>`;
    document.body.append(dialog);
    const field = key => dialog.querySelector('#forward-' + key);
    const action = key => dialog.querySelector('[data-action="' + key + '"]');
    const status = field('status');
    const model = window.BrclioForwardModel;
    const bank = model.store(localStorage);
    const hosts = window.BrclioConnection.store(localStorage);
    const live = new Map();
    let identity = {};
    let groupKeyHost = '', kexHostName = '';
    let selected = '';
    let observer;

    function active() {
      const pane = live.get(selected);
      return pane && ['starting', 'running'].includes(pane.state) ? pane : null;
    }
    function buttons() {
      observer?.disconnect();
      const pane = active();
      if (pane) {
        observer = new MutationObserver(buttons);
        observer.observe(pane.node, { attributes: true, attributeFilter: ['data-state'] });
      }
      action('show').hidden = action('stop').hidden = !pane;
      action('start').disabled = action('save').disabled = Boolean(pane);
      action('remove').disabled = !selected || Boolean(pane);
      for (const input of dialog.querySelectorAll('input, select:not(#forward-list)')) input.disabled = Boolean(pane);
      if (pane) status.textContent = '转发进程已启动。认证提示和连接错误显示在转发标签中。';
      else if (live.has(selected)) status.textContent = '转发进程已结束。';
    }
    function direction() {
      const type = field('type').value;
      const remote = type === 'remote';
      field('listen-label').textContent = remote ? '远端监听地址' : '本地监听地址';
      field('destination-label').textContent = remote ? '本地目标地址' : '远端目标地址';
      for (const label of dialog.querySelectorAll('[data-destination]')) label.hidden = type === 'dynamic';
      field('hint').textContent = type === 'dynamic' ? '在应用的 SOCKS 代理设置中填写本地监听地址和端口。' :
        remote ? '远端 SSH 服务器接收连接，再通过隧道访问本地网络的目标。' : '本机接收连接，再通过 SSH 服务器访问远端网络的目标。';
    }
    function setHost(target = {}, source = '', kexHost = '') {
      kexHostName = kexHost;
      groupKeyHost = source || target.groupKeySource || '';
      identity = { requirePostQuantum:target.requirePostQuantum, jump: target.jump, proxy: target.proxy, proxyUser: target.proxyUser, identityFile: groupKeyHost ? undefined : target.identityFile };
      for (const key of ['host', 'user', 'port']) field(key).value = target[key] ?? '';
    }
    function select(name, target) {
      selected = name;
      const rules = bank.all();
      for (const [label, pane] of live) {
        if (['starting', 'running'].includes(pane.state) && !rules.some(rule => rule.name === label)) rules.push(pane.forwardTemplate);
      }
      const item = active()?.forwardTemplate || rules.find(entry => entry.name === name);
      if (!item) selected = '';
      const list = field('list');
      list.replaceChildren(new Option('新建规则', ''), ...rules.map(entry => new Option(entry.name, entry.name)));
      list.value = selected;
      const source = target || item?.connection;
      const saved = hosts.all();
      const hostList = field('host-list');
      hostList.replaceChildren(new Option('手动填写', ''), ...saved.map(entry => new Option(entry.name, entry.name)));
      const configs = hosts.groupConfigs();
      const equivalent = entry => {
        const host = window.BrclioConnection.resolve(entry, configs);
        return source && ['host', 'user', 'port', 'jump', 'identityFile'].every(k => (host[k] || '') === (source[k] || ''));
      };
      hostList.value = item?.kexHostName || item?.groupKeyHost || saved.find(equivalent)?.name || '';
      setHost(source, item?.groupKeyHost,item?.kexHostName);
      for (const key of ['name', 'listenPort', 'destinationPort']) field(key).value = item?.[key] ?? '';
      field('listenHost').value = item?.listenHost || '127.0.0.1';
      field('destinationHost').value = item?.destinationHost || '127.0.0.1';
      field('type').value = item?.type || 'local';
      direction();
      status.textContent = '';
      buttons();
    }
    function value() {
      const item = {};
      for (const key of ['name','type','listenHost','listenPort','destinationHost','destinationPort']) item[key] = field(key).value;
      item.connection = { ...identity };
      if (kexHostName) item.kexHostName = kexHostName;
      if (groupKeyHost) item.groupKeyHost = groupKeyHost;
      for (const key of ['host','user','port']) item.connection[key] = field(key).value;
      return item;
    }
    function guard(fn) {
      return () => { try { fn(); } catch (error) { status.textContent = error.message; } };
    }

    field('list').onchange = guard(() => select(field('list').value));
    field('type').onchange = direction;
    field('host-list').onchange = guard(() => {
      const saved = hosts.all().find(entry => entry.name === field('host-list').value);
      setHost(saved ? hosts.resolve(saved) : undefined, '', saved?.name);
    });
    for (const key of ['host','user','port']) field(key).oninput = () => {
      field('host-list').value = '';
      groupKeyHost = ''; kexHostName = '';
      identity = {};
    };
    action('close').onclick = () => dialog.close();
    action('save').onclick = guard(() => {
      const item = bank.save(value(), selected);
      select(item.name);
      status.textContent = '已保存规则。';
    });
    action('start').onclick = guard(() => {
      if (active()) return;
      const item = bank.save(value(), selected);
      selected = item.name;
      const pane = newTab('转发 · ' + item.name, { profile: 'ssh-forward', connection: model.forLaunch(item, hosts), shellIntegration: false });
      pane.forwardTemplate = item;
      live.set(item.name, pane);
      dialog.close();
      activate(pane);
    });
    action('show').onclick = guard(() => {
      const pane = active();
      if (pane) { dialog.close(); activate(pane); }
    });
    action('stop').onclick = guard(() => {
      const pane = active();
      if (!pane) return;
      stop(pane);
      live.delete(selected);
      buttons();
      status.textContent = '已停止转发。';
    });
    action('remove').onclick = guard(() => {
      bank.remove(selected);
      live.delete(selected);
      select('');
      status.textContent = '已删除规则。';
    });
    dialog.onclose = () => observer?.disconnect();
    window.addEventListener('brclio-terminal-account-changed', () => {
      if (dialog.open) dialog.close();
      for (const pane of live.values()) if (pane.node.isConnected) stop(pane);
      live.clear();
      selected = '';
      identity = {};
      select('');
    });
    open = target => {
      if (!dialog.open) dialog.showModal();
      try {
        for (const [name, pane] of live) if (pane.state === 'closed') live.delete(name);
        select(target ? '' : selected, target);
      } catch (error) { status.textContent = error.message; }
    };
  }
  return { bind, open: target => open?.(target) };
})();

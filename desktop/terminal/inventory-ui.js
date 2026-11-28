'use strict';

(() => {
  const library = window.BrclioConnection, api = window.brclioTerminal;
  const store = () => library.store(localStorage);
  const project = record => ({ansible_host:record.host,...(record.user && {ansible_user:record.user}),...(record.port && {ansible_port:record.port})});
  function inventory(records) {
    const names = Object.create(null);
    for (const row of records) {
      // Inventory aliases are identifiers; preserve the original label as ordinary data.
      const base = row.name.replace(/[^\p{L}\p{N}_.-]/gu,'_');
      let alias = base, suffix = 1;
      while (Object.hasOwn(names,alias) || ['all','ungrouped','localhost','__proto__','constructor','prototype'].includes(alias)) alias = base + '_' + (++suffix);
      names[alias] = {...project(row),brclio_label:row.name,...(row.group && {brclio_group:row.group})};
    }
    return {all:{hosts:names}};
  }
  const only = (obj,keys) => obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).every(k => keys.includes(k));
  function operation({op,name,body}) {
    const bank = store(), rows = bank.all();
    if (op === 'inventory') return {status:200,data:inventory(rows.map(h => ({...h,...bank.resolve(h)})))};
    if (op === 'create-group') {
      if (!only(body,['vault']) || (body.vault && body.vault !== 'personal')) throw new Error('unsupported group fields');
      if (bank.groupConfigs().some(g => g.group === name)) return {status:409,data:{error:'group exists'}};
      bank.saveGroup({group:name});
    } else if (op === 'create-host') {
      if (!only(body,['vault','address','label','group','tags','ssh']) || !only(body.ssh || {},['port','credentials']) ||
          !only(body.ssh?.credentials || {},['username']) || (body.vault && body.vault !== 'personal')) throw new Error('unsupported host fields');
      const host = library.named({name:body.label || name,host:body.address,group:body.group,tags:body.tags,
        port:body.ssh?.port,user:body.ssh?.credentials?.username});
      if (rows.some(h => h.name === host.name)) return {status:409,data:{error:'host exists'}};
      bank.save(host,null);
    } else if (op === 'remove-host') {
      if (!rows.some(h => h.name === name)) return {status:404,data:{error:'unknown host'}};
      bank.remove(name);
    } else throw new Error('unknown operation');
    window.dispatchEvent(new Event('brclio-terminal-library-applied'));
    return {status:op === 'remove-host' ? 200 : 201,data:{ok:true}};
  }

  let dialog, live = false;
  api.onInventoryRequest(async message => {
    let result;
    try { result = live && dialog?.open ? operation(message) : {status:409,data:{error:'not active'}}; }
    catch { result = {status:400,data:{error:'invalid resource or fields'}}; }
    try { await api.inventoryBridge('reply',{id:message.id,...result}); } catch { /* Closed or expired request. */ }
  });
  function init() {
    dialog = document.createElement('dialog'); dialog.className = 'terminal-network-dialog'; dialog.id = 'inventory-bridge';
    dialog.setAttribute('aria-labelledby','inventory-title');
    dialog.innerHTML = `<div class="dialog-head"><h2 id="inventory-title">本机主机 API 与 Ansible</h2><button id="inventory-close">关闭</button></div>
      <p class="forward-hint">启用后，持本次令牌的本机程序可创建分组、增删当前账号的主机、读取连接地址。关闭此窗口或经过 15 分钟会停止服务。</p>
      <div class="network-actions"><button id="inventory-enable">启用本机 API</button><button id="inventory-stop" disabled>停止</button>
      <button id="inventory-export">复制 Ansible 静态清单</button></div><p id="inventory-status" role="status"></p>
      <label id="inventory-token-label" hidden>本次访问令牌<input readonly type="password" id="inventory-token"><button id="inventory-copy">复制令牌</button></label>
      <p class="forward-hint">使用 Bearer 令牌。GET /v1/inventory 读取清单。POST /v1/host/名称、DELETE /v1/host/名称 创建或删除主机，POST /v1/group/名称 创建分组。</p>`;
    document.body.append(dialog);
    const field = id => dialog.querySelector('#inventory-' + id);
    function state(value) {
      live = !!value && dialog.open;
      field('enable').disabled = live; field('stop').disabled = !live;
      field('token-label').hidden = !live; field('token').value = live ? value.token : '';
      field('status').textContent = live ? value.url : '';
    }
    async function act(fn) { try { await fn(); } catch (error) { field('status').textContent = error.message; } }
    field('close').onclick = () => dialog.close();
    field('enable').onclick = () => act(async () => state(await api.inventoryBridge('start')));
    field('stop').onclick = () => act(async () => state(await api.inventoryBridge('stop')));
    field('copy').onclick = () => act(async () => { const s = await api.inventoryBridge('status'); state(s); if (s) await api.copy(s.token); });
    field('export').onclick = () => act(async () => {
      const bank = store();
      await api.copy(JSON.stringify(inventory(bank.all().map(h => ({...h,...bank.resolve(h)}))),null,2));
      field('status').textContent = '已复制清单，可保存为 inventory.yml。';
    });
    const stop = () => { state(null); void api.inventoryBridge('stop').catch(() => {}); };
    dialog.addEventListener('close',stop);
    window.addEventListener('brclio-terminal-account-changed', () => { if (dialog.open) dialog.close(); stop(); });
  }
  window.BrclioInventoryBridge = {open() { if (!dialog) init(); dialog.showModal(); }};
})();

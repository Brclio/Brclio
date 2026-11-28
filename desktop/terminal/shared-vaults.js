'use strict';

(() => {
  const roleNames = {owner:'所有者', editor:'可编辑', reader:'只读'};
  const el = (tag, text) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const dialog = el('dialog');
  dialog.id = 'shared-vault-dialog';
  dialog.className = 'connection-sheet';
  dialog.setAttribute('aria-labelledby','shared-vault-title');
  const head = el('div'), title = el('h2','共享主机库'), close = el('button','关闭');
  head.className = 'dialog-head';
  title.id = 'shared-vault-title';
  close.onclick = () => dialog.close();
  head.append(title,close);
  const content = el('div'), message = el('p');
  message.setAttribute('role','status');
  dialog.append(head, content, message);
  document.body.append(dialog);

  let epoch = 0, busy = false;
  function reset() {
    epoch++; busy = false; content.inert = false;
    content.replaceChildren(); message.textContent = ''; title.textContent = '共享主机库';
  }
  dialog.addEventListener('close',reset);
  window.addEventListener('brclio-terminal-account-changed', () => {
    if (dialog.open) dialog.close();
    reset();
  });
  function button(text, action) {
    const node = el('button',text);
    node.type = 'button';
    node.onclick = () => perform(action);
    return node;
  }
  function row(...nodes) {
    const line = el('div');
    line.className = 'shared-row'; line.append(...nodes); return line;
  }
  function input(label, length) {
    const field = el('input');
    field.setAttribute('aria-label',label); field.placeholder = label;
    field.maxLength = length; field.autocomplete = 'off';
    return field;
  }
  function roleSelect(current = 'reader') {
    const field = el('select');
    field.setAttribute('aria-label','成员权限');
    for (const key of ['reader','editor']) field.add(new Option(roleNames[key],key));
    field.value = current;
    return field;
  }
  function confirmAction(label, action) {
    const area = el('span');
    const start = button(label, () => {
      area.replaceChildren(button('确认' + label, action),button('取消',() => area.replaceChildren(start)));
    });
    area.append(start); return area;
  }
  async function perform(action) {
    if (busy || !dialog.open) return;
    const current = epoch;
    busy = true; content.inert = true; message.textContent = '';
    try { await action(); }
    catch (error) { if (epoch === current) message.textContent = error.message; }
    finally { if (epoch === current) { busy = false; content.inert = false; } }
  }
  async function request(action, fields = {}) {
    const current = epoch;
    let response;
    try { response = await window.brclioTerminal.sharedVault(action,fields); }
    catch (error) {
      if (dialog.open && current === epoch) {
        title.textContent = '共享主机库';
        content.replaceChildren(button('重新读取主机库',list));
      }
      throw error;
    }
    if (!dialog.open || current !== epoch) throw new Error('共享主机库已关闭。');
    return response;
  }
  const reference = vault => ({ownerId:vault.ownerId, vaultId:vault.vaultId});
  function localPartition(id) {
    const partition = window.BrclioTerminalPartitions;
    if (!partition?.ready || partition.owner !== id) throw new Error('本机终端账号已变化，请重新打开。');
    return partition.storage;
  }
  const localLibrary = id => {
    localPartition(id);
    return window.BrclioConnection.store(localStorage);
  };
  async function list() {
    content.replaceChildren(button('刷新主机库', list));
    title.textContent = '共享主机库';
    const {vaults} = await request('list');
    const name = input('主机库名称',64);
    let draftId = crypto.randomUUID();
    name.oninput = () => { draftId = crypto.randomUUID(); };
    content.replaceChildren(row(name, button('创建主机库', async () => {
      if (!name.value.trim()) throw new Error('请输入主机库名称。');
      const result = await request('create',{name:name.value.trim(),vaultId:draftId});
      render(result);
    }), button('刷新',list)));
    for (const vault of vaults) {
      const status = vault.state === 'invited' ? '待接受邀请' : roleNames[vault.role];
      content.append(row(el('span',vault.name + ' · ' + vault.ownerName + ' · ' + status), button('查看',() => openVault(vault))));
    }
    if (!vaults.length) content.append(el('p','当前账号还没有共享主机库或邀请。'));
  }
  async function openVault(ref) {
    content.replaceChildren(button('返回主机库',list),button('刷新',() => openVault(ref)));
    render(await request('open',reference(ref)));
  }
  function render({userId, vault}) {
    title.textContent = vault.name;
    content.replaceChildren(row(button('返回主机库',list),button('刷新',() => openVault(vault))),
      el('p','所有者 ' + vault.ownerName + ' · ' + roleNames[vault.role]));
    const update = async (action, fields = {}) => {
      const result = await request(action,{...reference(vault),revision:vault.revision,...fields});
      if (result.removed) await list(); else render(result);
    };
    if (vault.state === 'invited') {
      content.append(el('p','接受邀请后即可查看库中的主机连接资料与团队剪藏。'),row(button('接受邀请',() => update('accept')),
        button('拒绝邀请',() => update('decline'))));
      return;
    }

    const canWrite = vault.role !== 'reader';
    const form = canWrite && editor(vault, userId, update);
    content.append(el('h3','主机'));
    for (const host of vault.hosts) {
      const copy = button('存入本机主机库',async () => {
        const current = await request('open',reference(vault));
        if (current.vault.revision !== vault.revision) { render(current); throw new Error('主机资料已更新，请核对后重试。'); }
        const library = localLibrary(current.userId);
        library.save(host, null);
        message.textContent = '已存入当前账号的本机主机库。';
      });
      const line = row(el('span',host.name + ' · ' + window.BrclioConnection.format(host)), copy);
      if (canWrite) line.append(button('编辑',() => form.edit(host)),
        confirmAction('移除主机',() => update('set-hosts',{hosts:vault.hosts.filter(h => h.name !== host.name)})));
      content.append(line);
    }
    if (!vault.hosts.length) content.append(el('p','尚未添加共享主机。'));
    if (canWrite) content.append(form.node);
    content.append(teamSnippets(vault, userId, update, canWrite));

    if (vault.role === 'owner') {
      const domains = input('允许邀请的已验证邮箱域名',1024);
      domains.value = (vault.inviteDomains || []).join(', ');
      domains.placeholder = '留空允许所有域名';
      content.append(el('h3','邀请域名规则'),row(domains,button('保存域名规则',() => update('invite-domains',
        {domains:domains.value.toLowerCase().split(/[,，\s]+/).filter(Boolean)}))),
        el('small','适用于新邀请及待接受的邀请。已加入成员可在下方移除。'));
      const audit = el('details');
      audit.append(el('summary','最近管理记录'));
      const labels = {invite:'发送邀请',accept:'接受邀请',decline:'拒绝邀请',role:'修改权限',revoke:'撤销访问',
        leave:'退出主机库','set-hosts':'更新共享主机','invite-domains':'设置邀请域名','set-snippet':'共享或更新剪藏','remove-snippet':'移除共享剪藏'};
      for (const entry of [...(vault.audit || [])].reverse()) audit.append(el('p',
        new Date(entry.at).toLocaleString() + ' · ' + entry.actor + ' · ' + (labels[entry.action] || entry.action) + (entry.subject ? ' · ' + entry.subject : '')));
      content.append(audit);
      const username = input('Brclio 用户名',32), role = roleSelect();
      content.append(el('h3','成员与邀请'),row(username,role,button('发送邀请',() =>
        update('invite',{username:username.value.trim().normalize('NFKC'),role:role.value}))));
      for (const member of vault.members) {
        const select = roleSelect(member.role);
        content.append(row(el('span',member.username + (member.state === 'invited' ? ' · 待接受' : '')),select,
          button('保存权限',() => update('role',{memberId:member.id,role:select.value})),
          confirmAction(member.state === 'invited' ? '撤回邀请' : '移除成员',() => update('revoke',{memberId:member.id}))));
      }
      content.append(confirmAction('删除主机库',() => update('delete')));
    } else content.append(confirmAction('退出主机库',() => update('leave')));
  }
  function teamSnippets(vault, userId, update, canWrite) {
    const model = window.BrclioSnippetModel;
    const area = el('section'), items = vault.snippets || [];
    area.append(el('h3','团队剪藏'));
    const groups = new Map();
    for (const item of items) {
      const key = item.package || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    async function readCurrent(id) {
      const current = await request('read-snippet',{...reference(vault),revision:vault.revision,snippetId:id});
      localPartition(userId);
      if (current.userId !== userId || current.snippet?.id !== id || current.snippet.kind !== 'snippet') throw new Error('无法读取所选团队剪藏。');
      return model.normalize(current.snippet);
    }
    for (const [name, entries] of groups) {
      area.append(el('h4',name || '未分包'));
      for (const item of entries) {
        const detail = el('div');
        const line = row(el('span',item.name + (item.template ? ' · 模板' : '')), button('查看正文', async () => {
          const current = await readCurrent(item.id);
          detail.replaceChildren(el('pre',current.text),button('收起正文',() => detail.replaceChildren()));
        }),button('存入个人剪藏',async () => {
          const current = await readCurrent(item.id);
          const copy = model.addCopy(localPartition(userId),current);
          window.dispatchEvent(new Event('brclio-snippets-changed'));
          message.textContent = '已存入个人剪藏「' + model.label(copy) + '」。如已启用个人剪藏同步，该副本也会同步。';
        }));
        if (canWrite) line.append(confirmAction('移除团队剪藏',() => update('remove-snippet',{snippetId:item.id})));
        area.append(line,detail);
      }
    }
    if (!items.length) area.append(el('p','尚未共享剪藏。'));
    if (!canWrite) return area;
    const picker = el('select'), preview = el('div');
    picker.setAttribute('aria-label','选择要共享的个人剪藏');
    const choices = () => model.read(localPartition(userId)).filter(item => item.kind === 'snippet');
    const refresh = () => {
      const previous = picker.value;
      picker.replaceChildren(new Option('选择要共享的个人剪藏',''), ...choices().map(item => new Option(model.label(item),item.id)));
      picker.value = [...picker.options].some(option => option.value === previous) ? previous : '';
      if (!picker.value) preview.replaceChildren();
    };
    picker.add(new Option('选择要共享的个人剪藏',''));
    picker.onfocus = () => { try { refresh(); } catch (error) { message.textContent = error.message; } };
    picker.onchange = () => {
      preview.replaceChildren();
      try {
        const chosen = choices().find(item => item.id === picker.value);
        if (!chosen) return;
        const match = items.find(item => item.name === chosen.name && (item.package || '') === (chosen.package || ''));
        const id = match?.id || crypto.randomUUID();
        preview.append(el('strong',model.label(chosen) + (chosen.template ? ' · 模板' : '')),el('pre',chosen.text),
          el('p','只有选中的这一条会共享。当前可读成员：' + (vault.audience || [vault.ownerName]).join('、') + '。以后接受邀请的成员也可读取。包名、名称、正文和模板标记将以明文存入私有 GitHub 仓库 BrclioData/BrclioUserData，有仓库读取权限的人可以查看 Git 历史。移除共享后，成员已保存的副本仍会保留。'),
          button(match ? '确认替换团队剪藏' : '确认共享此剪藏',async () => {
            const current = choices().find(item => item.id === picker.value);
            if (JSON.stringify(current) !== JSON.stringify(chosen)) {
              preview.replaceChildren(); picker.value = ''; throw new Error('个人剪藏已更改，请重新选择并核对。');
            }
            await update('set-snippet',{snippet:{...chosen,id}});
          }));
      } catch (error) { message.textContent = error.message; }
    };
    area.append(row(picker), preview);
    return area;
  }
  function editor(vault, userId, update) {
    const box = el('fieldset'), legend = el('legend','添加主机'), name = input('名称',64);
    const host = input('主机地址',255), user = input('SSH 用户名（可选）',128), port = input('端口（可选）',5);
    let previous = null;
    function fill(value) {
      name.value = value.name; host.value = value.host; user.value = value.user || ''; port.value = value.port || '';
    }
    const picker = el('select');
    picker.setAttribute('aria-label','从本机主机库填入');
    picker.add(new Option('从本机选择（可选）',''));
    const addOptions = () => {
      const hosts = localLibrary(userId).all();
      picker.length = 1;
      for (const item of hosts) picker.add(new Option(item.name,item.name));
    };
    picker.onfocus = () => { try { addOptions(); } catch (error) { message.textContent = error.message; } };
    picker.onchange = () => {
      try {
        const selected = localLibrary(userId).all().find(item => item.name === picker.value);
        if (selected) fill(selected);
      } catch (error) { message.textContent = error.message; }
    };
    box.append(legend, el('p','保存后，已接受邀请的成员可查看下列四项。'), picker,row(name,host,user,port),
      button('保存到共享主机库', async () => {
        const value = window.BrclioConnection.endpoint({host:host.value,user:user.value,port:port.value});
        const shared = {name:name.value.trim(), ...value};
        if (!shared.name || vault.hosts.some(h => h.name === shared.name && h.name !== previous))
          throw new Error('请输入未被占用的主机名称。');
        const hosts = previous === null ? [...vault.hosts,shared] : vault.hosts.map(h => h.name === previous ? shared : h);
        await update('set-hosts',{hosts});
      }));
    return {node:box, edit(value) { previous = value.name; legend.textContent = '编辑主机'; fill(value); name.focus(); }};
  }
  window.BrclioSharedVaults = {open() {
    if (!dialog.open) dialog.showModal();
    perform(list);
  }};
})();

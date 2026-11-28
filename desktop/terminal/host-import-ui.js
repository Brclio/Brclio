'use strict';

window.BrclioHostImportDialog = (() => {
  const model = window.BrclioHostImport;
  let dialog, generation = 0;
  const el = id => dialog.querySelector('#import-' + id);
  const bank = () => window.BrclioConnection.store(localStorage);
  let selected = new Map();
  function reset() {
    generation++;
    selected.clear();
    el('apply').disabled = true;
    el('preview').replaceChildren();
    el('status').textContent = '';
    el('file').value = '';
  }
  async function preview() {
    const file = el('file').files[0], format = el('format').value, ticket = ++generation;
    selected.clear();
    el('apply').disabled = true;
    el('preview').replaceChildren();
    el('status').textContent = '';
    const cloud = ['aws','azure','digitalocean'].includes(format);
    const putty = ['putty-files','putty-registry'].includes(format);
    if (!cloud && !putty && !file) return;
    try {
      let result;
      if (cloud || putty) {
        el('status').textContent = putty ? '正在读取选定的 PuTTY 会话…' : '正在读取云主机清单…';
        result = putty ? await window.brclioTerminal.puttyDiscovery(format === 'putty-files' ? 'files' : 'registry') :
          await window.brclioTerminal.cloudInventory(format);
        if (ticket !== generation) return;
        if (!result) { el('status').textContent = ''; return; }
      } else {
        if (file.size > model.limit) throw new Error('文件超过 1 MiB。');
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (ticket !== generation) return;
        const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
        let text;
        try { text = new TextDecoder(encoding, {fatal:true}).decode(bytes); }
        catch (error) {
          if (format !== 'mobaxterm' || encoding !== 'utf-8') throw error;
          text = new TextDecoder('windows-1252').decode(bytes);
        }
        result = model.parse(format, text, file.name);
      }
      const existing = new Set(bank().all().map(h => h.name));
      const rows = document.createDocumentFragment();
      let duplicates = 0;
      for (const item of result.hosts) {
        const label = document.createElement('label'), checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.disabled = existing.has(item.name);
        checkbox.checked = !checkbox.disabled && !putty;
        if (checkbox.checked) selected.set(item.name,item);
        if (checkbox.disabled) duplicates++;
        checkbox.onchange = () => {
          if (checkbox.checked) selected.set(item.name,item); else selected.delete(item.name);
          el('apply').disabled = !selected.size;
        };
        label.append(checkbox, document.createTextNode(' ' + item.name + ' · ' + window.BrclioConnection.format(item) + (item.group ? ' · ' + item.group : '') + (checkbox.disabled ? '（已存在）' : '')));
        rows.append(label);
      }
      el('preview').append(rows);
      el('status').textContent = ['识别 ' + result.hosts.length + ' 台，已有同名 ' + duplicates + ' 台，无效或重复 ' + result.skipped + ' 条。', ...result.notices].join(' ');
      el('apply').disabled = !selected.size;
    } catch (error) { if (ticket === generation) el('status').textContent = error.message; }
  }
  function init() {
    dialog = document.createElement('dialog');
    dialog.className = 'terminal-network-dialog';
    dialog.id = 'host-import-dialog';
    dialog.setAttribute('aria-labelledby','import-title');
    dialog.innerHTML = `
      <div class="dialog-head"><h2 id="import-title">导入主机</h2><button id="import-close" type="button">关闭</button></div>
      <div class="forward-grid"><label>来源<select id="import-format"><option value="openssh">OpenSSH config</option><option value="csv">CSV 主机表</option><option value="putty">PuTTY 注册表导出 (.reg)</option><option value="securecrt">SecureCRT 设置 XML / 会话 INI</option><option value="mobaxterm">MobaXterm 书签 (.mxtsessions / .moba / INI)</option><option value="aws">AWS EC2</option><option value="azure">Microsoft Azure</option><option value="digitalocean">DigitalOcean</option></select></label>
      <label id="import-file-label">配置文件<input id="import-file" type="file"></label><button type="button" id="import-cloud" hidden>读取当前云账号清单</button></div>
      <p class="forward-hint">选中的连接资料将加入当前主机库。已开启账号同步的主机会随个人配置同步。密码和私钥文件内容不参与导入。</p>
      <div id="import-preview"></div><p id="import-status" role="status"></p>
      <div class="network-actions"><button id="import-apply" type="button" disabled>导入所选主机</button></div>`;
    document.body.append(dialog);
    const registryExport = el('format').querySelector('option[value="putty"]');
    registryExport.after(new Option('PuTTY 会话文件','putty-files'));
    if (window.brclioTerminal.platform === 'win32') registryExport.after(new Option('当前 Windows 用户的 PuTTY 会话','putty-registry'));
    el('close').onclick = () => dialog.close();
    el('format').onchange = () => {
      reset();
      const format = el('format').value;
      const external = ['aws','azure','digitalocean','putty-files','putty-registry'].includes(format);
      el('file-label').hidden = external; el('cloud').hidden = !external;
      el('cloud').textContent = format === 'putty-files' ? '选择 PuTTY 会话文件' : format === 'putty-registry' ? '从本机读取 PuTTY 会话' : '读取当前云账号清单';
    };
    el('cloud').onclick = preview;
    el('file').onchange = preview;
    el('apply').onclick = () => {
      try {
        // Another window or account sync may have added records after this preview.
        const storage = bank(), existing = storage.all(), names = new Set(existing.map(h => h.name));
        const added = [...selected.values()].filter(item => !names.has(item.name));
        if (added.length) {
          storage.replace(existing.concat(added));
          window.dispatchEvent(new Event('brclio-terminal-library-applied'));
          window.dispatchEvent(new Event('brclio-terminal-library-changed'));
        }
        reset();
        el('status').textContent = '已导入 ' + added.length + ' 台主机。';
      } catch (error) { el('status').textContent = error.message; }
    };
    dialog.addEventListener('close',reset);
    window.addEventListener('brclio-terminal-account-changed', () => { if (dialog.open) dialog.close(); reset(); });
  }
  return { open() { if (!dialog) init(); reset(); dialog.showModal(); } };
})();

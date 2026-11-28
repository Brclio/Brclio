'use strict';

window.BrclioKnownHosts = (() => {
  let dialog;
  let query;
  let generation = 0;
  const api = window.brclioTerminal;
  const field = name => dialog.querySelector('#known-' + name);

  function init() {
    dialog = document.createElement('dialog');
    dialog.className = 'terminal-network-dialog';
    dialog.setAttribute('aria-labelledby', 'known-title');
    dialog.id = 'known-hosts-dialog';
    dialog.innerHTML = `
      <div class="dialog-head"><h2 id="known-title">已知主机指纹</h2><button id="known-close" type="button">关闭</button></div>
      <div class="forward-grid"><label>服务器主机名 / IP<input id="known-host" autocomplete="off" maxlength="255" spellcheck="false"></label>
      <label>SSH 端口<input id="known-port" type="number" min="1" max="65535" placeholder="22"></label></div>
      <p class="forward-hint">按实际服务器地址查询本机 OpenSSH 的 ~/.ssh/known_hosts。</p>
      <div class="network-actions"><button id="known-search" type="button">查询指纹</button></div>
      <p id="known-status" role="status"></p><div id="known-records"></div>`;
    document.body.append(dialog);
    field('close').onclick = () => dialog.close();
    const reset = () => {
      generation++;
      field('records').replaceChildren();
      field('status').textContent = '';
      field('search').disabled = false;
    };
    dialog.addEventListener('close', reset);
    window.addEventListener('brclio-terminal-account-changed', () => { if (dialog.open) dialog.close(); reset(); });
    field('host').oninput = field('port').oninput = reset;
    query = async () => {
      const token = ++generation;
      const status = field('status');
      const target = { host: field('host').value, port: field('port').value };
      field('records').replaceChildren();
      field('search').disabled = true;
      try {
        const records = await api.knownHosts(target);
        if (generation !== token) return;
        for (const item of records) {
          const row = document.createElement('div');
          row.className = 'known-record';
          const type = document.createElement('strong');
          type.textContent = [item.marker, item.type].filter(Boolean).join(' ');
          const code = document.createElement('code');
          code.textContent = item.fingerprint;
          row.append(type, code);
          if (item.removable) {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = '移除此记录';
            remove.onclick = async () => {
              remove.disabled = true;
              try {
                const changed = await api.forgetKnownHost(target, item.id);
                if (changed && generation === token) await query();
              } catch (error) { if (generation === token) status.textContent = error.message; }
              finally { remove.disabled = false; }
            };
            row.append(remove);
          }
          field('records').append(row);
        }
        status.textContent = records.length ? records.length + ' 项匹配的主机密钥。' : '没有此服务器的记录。';
      } catch (error) { if (generation === token) status.textContent = error.message; }
      finally { if (generation === token) field('search').disabled = false; }
    };
    field('search').onclick = query;
    for (const input of [field('host'), field('port')]) input.onkeydown = event => {
      if (event.key === 'Enter' && !event.isComposing) query();
    };
  }
  return { open(target) {
    if (!dialog) init();
    generation++;
    field('host').value = target?.host || '';
    field('port').value = target?.port || '';
    field('records').replaceChildren();
    field('status').textContent = '';
    field('search').disabled = false;
    if (!dialog.open) dialog.showModal();
    field('host').focus();
  } };
})();

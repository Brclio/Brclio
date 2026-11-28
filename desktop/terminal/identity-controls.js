'use strict';

window.BrclioIdentityControls = (() => {
  let open;
  function bind({ newTab, activate, stop }) {
    const bank = window.BrclioIdentities.store(localStorage);
    const api = window.brclioTerminal;
    const dialog = document.createElement('dialog');
    dialog.id = 'identity-dialog';
    dialog.className = 'terminal-network-dialog';
    dialog.setAttribute('aria-labelledby', 'identity-title');
    dialog.innerHTML = `
      <div class="dialog-head"><h2 id="identity-title">SSH 身份</h2><button type="button" data-id-action="close">关闭</button></div>
      <div class="forward-grid">
        <label class="forward-wide">本机身份<select id="identity-list"></select></label>
        <label>身份名称<input id="identity-name" maxlength="64"></label>
        <label>SSH 用户名<input id="identity-user" maxlength="128" autocomplete="off" spellcheck="false"></label>
        <label class="forward-wide">新密钥类型<select id="identity-algorithm"><option value="ed25519">Ed25519</option><option value="rsa">RSA 4096</option><option value="ecdsa">ECDSA P-521</option><option value="ecdsa-sk">FIDO2 安全密钥 · ECDSA</option><option value="ed25519-sk">FIDO2 安全密钥 · Ed25519</option></select></label>
        <label class="forward-wide">私钥文件路径<input id="identity-path" readonly></label>
      </div>
      <p class="forward-hint">私钥保存在你选择的位置。生成新密钥时，在 OpenSSH 标签中输入并确认保护口令。使用 FIDO2 时，请插入支持所选算法的安全密钥，按 OpenSSH 提示操作。</p>
      <button type="button" data-id-action="probe">检查本机 FIDO2 算法支持</button><span id="identity-support" role="status"></span>
      <div class="network-actions"><button type="button" data-id-action="choose">选择已有私钥</button><button type="button" data-id-action="generate">生成密钥</button><button type="button" data-id-action="save">保存身份</button><button type="button" data-id-action="public">查看公钥</button><button type="button" data-id-action="copy" hidden>复制公钥</button><button type="button" data-id-action="remove">移除身份引用</button></div>
      <p id="identity-status" role="status"></p><p id="identity-fingerprint"></p>`;
    document.body.append(dialog);
    const field = name => dialog.querySelector('#identity-' + name);
    const action = name => dialog.querySelector('[data-id-action="' + name + '"]');
    const status = field('status');
    const pending = new Map();
    let account = 0, version = 0, selected = '', notice = '', publicKey = '';
    function clearPublic() {
      publicKey = '';
      field('fingerprint').textContent = '';
      action('copy').hidden = true;
    }
    function select(name) {
      const items = bank.all();
      const item = items.find(entry => entry.name === name);
      selected = item?.name || '';
      field('list').replaceChildren(new Option('新身份', ''), ...items.map(entry => new Option(entry.name, entry.name)));
      field('list').value = selected;
      for (const key of ['name','user','path']) field(key).value = item?.[key] || '';
      action('remove').disabled = !item;
      clearPublic();
      status.textContent = '';
      version++;
    }
    function guard(fn) {
      return async () => {
        const current = account;
        try { await fn(); } catch (error) { if (current === account) status.textContent = error.message; }
      };
    }
    field('list').onchange = guard(() => select(field('list').value));
    action('close').onclick = () => dialog.close();
    action('probe').onclick = guard(async () => {
      const generation = account;
      const supported = await api.securityKeyAlgorithms();
      if (generation !== account || !dialog.open) return;
      const select = field('algorithm');
      for (const option of select.options) if (option.value.endsWith('-sk')) option.disabled = !supported.includes(option.value);
      if (select.selectedOptions[0]?.disabled) select.value = 'ed25519';
      field('support').textContent = supported.length ? 'OpenSSH 支持 ' + supported.join('、') + '。生成时将验证设备。' : '本机 OpenSSH 未列出 FIDO2 密钥算法。';
    });
    dialog.addEventListener('close', () => { version++; clearPublic(); });
    action('choose').onclick = guard(async () => {
      const token = version;
      const item = await api.chooseIdentity('existing');
      if (!item || token !== version) return;
      field('path').value = item.path;
      clearPublic();
      status.textContent = '已选择文件。保存身份后可在主机设置中选用。';
    });
    action('save').onclick = guard(() => {
      const item = bank.save({ name: field('name').value, user: field('user').value, path: field('path').value }, selected);
      select(item.name);
      status.textContent = '已保存身份。';
    });
    action('public').onclick = guard(async () => {
      const token = version, file = field('path').value;
      if (!file) throw new Error('请先选择密钥文件。');
      const result = await api.identityPublic(file);
      if (token !== version || file !== field('path').value) return;
      publicKey = result.text;
      field('fingerprint').textContent = result.fingerprint;
      action('copy').hidden = false;
      status.textContent = '已读取同名 .pub 文件。';
    });
    action('copy').onclick = guard(async () => {
      if (publicKey) { await api.copy(publicKey); status.textContent = '已复制 OpenSSH 公钥。'; }
    });
    action('remove').onclick = guard(() => { bank.remove(selected); select(''); status.textContent = '已移除本机身份引用。'; });
    action('generate').onclick = guard(async () => {
      const token = version;
      const prototype = window.BrclioIdentities.record({ name: field('name').value, user: field('user').value, path: '/generated' });
      if (bank.all().some(item => item.name === prototype.name) || [...pending.values()].some(item => item.record.name === prototype.name)) throw new Error('请为新身份使用不同的名称。');
      const target = await api.chooseIdentity({ action: 'generate', algorithm: field('algorithm').value });
      if (!target || token !== version) return;
      const record = { ...prototype, path: target.path };
      const pane = newTab('生成密钥 · ' + record.name, { profile: 'ssh-keygen', connection: { token: target.token }, shellIntegration: false });
      pending.set(pane.id, { pane, record, account });
      dialog.close();
      activate(pane);
      pane.ready.then(() => { if (pane.state === 'error') pending.delete(pane.id); });
    });
    api.onExit(async ({ id, exitCode }) => {
      const task = pending.get(id);
      if (!task) return;
      pending.delete(id);
      if (exitCode !== 0 || task.account !== account) return;
      try {
        await api.identityPublic(task.record.path);
        if (task.account !== account) return;
        bank.save(task.record);
        notice = '已生成并保存身份「' + task.record.name + '」。';
      } catch (error) { if (task.account === account) notice = error.message; }
      if (dialog.open && task.account === account) { select(task.record.name); status.textContent = notice; notice = ''; }
    });

    const preset = document.getElementById('remote-identity-preset');
    function populatePresets() {
      if (!preset) return;
      const file = document.getElementById('remote-identityFile').value;
      const items = bank.all();
      preset.replaceChildren(new Option('手动 / 本机密钥', ''), ...items.map(item => new Option(item.name, item.name)));
      preset.value = items.find(item => item.path === file)?.name || '';
    }
    if (preset) {
      preset.onfocus = populatePresets;
      preset.onchange = () => {
        const item = bank.all().find(entry => entry.name === preset.value);
        if (!item) return;
        for (const [key, value] of [['remote-user', item.user], ['remote-identityFile', item.path]]) {
          if (!value) continue;
          const input = document.getElementById(key);
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      };
      window.addEventListener('brclio-identities-changed', populatePresets);
      window.addEventListener('brclio-terminal-host-editor-changed', populatePresets);
    }
    window.addEventListener('brclio-terminal-account-changed', () => {
      account++;
      version++;
      if (dialog.open) dialog.close();
      for (const { pane } of pending.values()) if (pane.node.isConnected) stop?.(pane);
      pending.clear();
      notice = '';
      select('');
      if (preset) populatePresets();
    });
    open = () => {
      for (const [id, item] of pending) if (!item.pane.node.isConnected) pending.delete(id);
      if (!dialog.open) dialog.showModal();
      try { select(selected); status.textContent = notice; notice = ''; }
      catch (error) { status.textContent = error.message; }
    };
  }
  return { bind, open: () => open?.() };
})();

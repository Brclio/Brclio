'use strict';

window.BrclioVaultControls = {
  bind(api, activePane) {
    const byId = name => document.getElementById('vault-' + name);
    const dialog = document.getElementById('actions-dialog');
    const details = byId('controls');
    const entries = byId('list');
    const secret = byId('secret');
    const status = byId('status');
    let available = false, busy = false;
    function buttons() {
      byId('unlock').disabled = busy || available;
      byId('add').disabled = busy || !available;
      byId('fill').disabled = busy || !available || !entries.value || activePane()?.state !== 'running';
      byId('remove').disabled = busy || !available || !entries.value;
      byId('update').disabled = busy || !available || !entries.value;
    }
    async function list(selected) {
      const rows = await api.listPasswords();
      if (!dialog.open || !details.open) return;
      entries.replaceChildren(...rows.map(item => new Option(item.name, item.id)));
      if (selected) entries.value = selected;
      available = true;
    }
    async function perform(action) {
      if (busy) return;
      busy = true;
      buttons();
      try { await action(); }
      catch (error) { status.textContent = error.message; }
      finally { busy = false; buttons(); }
    }
    details.addEventListener('toggle', () => {
      if (!details.open) { available = false; secret.value = ''; entries.replaceChildren(); buttons(); }
    });
    byId('unlock').onclick = () => perform(async () => { await list(); status.textContent = '密码库已解锁。'; });
    dialog.addEventListener('close', () => {
      details.open = false;
      available = false;
      secret.value = '';
      byId('name').value = '';
      entries.replaceChildren();
      status.textContent = '';
      buttons();
    });
    entries.onchange = buttons;
    byId('add').onclick = () => perform(async () => {
      const storing = api.addPassword(byId('name').value, secret.value);
      secret.value = '';
      const item = await storing;
      byId('name').value = '';
      await list(item.id);
      status.textContent = '已保存新条目。';
    });
    byId('remove').onclick = () => perform(async () => {
      await api.removePassword(entries.value);
      await list();
      status.textContent = '已删除条目。';
    });
    byId('update').onclick = () => perform(async () => {
      const id = entries.value;
      const updating = api.updatePassword(id, byId('name').value, secret.value);
      secret.value = '';
      await updating;
      byId('name').value = '';
      await list(id);
      status.textContent = '已更新所选条目。';
    });
    byId('fill').onclick = () => perform(async () => {
      const pane = activePane();
      if (!pane || pane.state !== 'running') return;
      const result = await api.fillPassword(entries.value, pane.id);
      status.textContent = result.filled ? '已填入当前窗格。' : '已取消。';
      if (result.filled) dialog.close();
    });
  },
};

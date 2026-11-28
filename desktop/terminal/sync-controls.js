'use strict';

window.BrclioTerminalSync = {
  bind(api) {
    const model = window.BrclioTerminalSyncModel;
    const partitions = window.BrclioTerminalPartitions;
    const local = partitions.storage;
    const libraries = model.localLibraries(local);
    const key = 'brclio.terminal.sync-settings.v1';
    const dialog = document.createElement('dialog');
    dialog.id = 'terminal-sync';
    dialog.setAttribute('aria-labelledby', 'terminal-sync-title');
    dialog.innerHTML = `
      <div class="sync-heading"><h2 id="terminal-sync-title">终端云同步</h2><button data-sync="close" type="button">关闭窗口</button></div>
      <p>将主机、分组、标签、收藏、跳板配置和转发模板同步到当前 Brclio 账号。不同 Brclio 账号各自保存本机配置。密码、私钥、身份文件路径、最近记录和终端输出仅保留在本机。</p>
      <p data-sync="account"></p>
      <div class="sync-actions"><button type="button" data-sync="enable">开启自动同步</button><button type="button" data-sync="disable" hidden>关闭自动同步</button><button type="button" data-sync="refresh" hidden>立即检查</button></div>
      <section data-sync="migration" hidden><details><summary>移入未关联的本机配置</summary><p>把未关联的主机、最近记录、身份路径、转发模板、笔记与剪藏、布局、动态配置和主机或目录规则移入当前账号。同名且内容不同的配置会另存。开启同步后仅上传主机与转发模板。</p><button data-sync="move" type="button">移入当前账号…</button></details></section>
      <section data-sync="conflicts" hidden><h3>选择保留的配置</h3><p>以下配置在本机和云端都有修改。</p><div data-sync="items"></div><button data-sync="resolve" type="button">应用选择</button></section>
      <p role="status" aria-live="polite" data-sync="status"></p>`;
    document.body.append(dialog);
    const field = name => dialog.querySelector('[data-sync="' + name + '"]');
    let settings = { enabled: false, owner: '', base: model.empty() };
    let account = null;
    let generation = 0;
    let timer;
    let running = false;
    let queued = false;
    const pollInterval = 5 * 60 * 1000;
    const foreground = () => document.visibilityState === 'visible' && document.hasFocus();
    let sizeBlocked = false;
    let guestAvailable = false;
    let guestCheck = 0;
    let conflict = null;
    let resolution = null;
    const status = message => { field('status').textContent = message; };
    function loadSettings() {
      settings = { enabled: false, owner: '', base: model.empty() };
      if (!partitions.owner) return;
      try {
        const saved = JSON.parse(local.getItem(key) || 'null');
        if (saved?.owner === partitions.owner) {
          settings = { owner: saved.owner, enabled: saved.enabled === true, base: model.portable(saved.base) };
        }
      } catch { status('本机同步状态无法读取，自动同步已暂停。'); }
    }

    const persist = next => { local.setItem(key, JSON.stringify(next)); settings = next; };
    function render() {
      field('enable').hidden = settings.enabled;
      field('disable').hidden = field('refresh').hidden = !settings.enabled;
      field('account').textContent = account ? '当前账号 · ' + (account.email || account.id) : '当前未登录 Brclio';
      field('conflicts').hidden = !conflict;
      field('migration').hidden = !account || !partitions.ready || !guestAvailable;
    }
    async function checkGuest() {
      const id = account?.id;
      const epoch = generation;
      const check = ++guestCheck;
      if (!id || !dialog.open || !api.unboundTransfer || partitions.owner !== id) return;
      const result = await api.unboundTransfer('available', id);
      if (epoch !== generation || check !== guestCheck || account?.id !== id) return;
      guestAvailable = result.available === true;
      render();
    }
    function clearConflict() { conflict = resolution = null; field('items').replaceChildren(); render(); }
    function showConflicts(entries, revision, snapshot) {
      const signature = JSON.stringify([revision, snapshot]);
      if (conflict?.signature === signature) return;
      conflict = { signature, entries };
      resolution = null;
      field('items').replaceChildren();
      for (const item of entries) {
        const group = document.createElement('fieldset');
        const legend = document.createElement('legend');
        legend.textContent = (item.key === 'hosts' ? '主机 · ' : '转发 · ') + item.name;
        const choice = document.createElement('select');
        choice.setAttribute('aria-label', legend.textContent + '的保留版本');
        choice.append(new Option('请选择', ''), new Option('保留本机版本', 'device'), new Option('保留云端版本', 'cloud'));
        group.append(legend);
        for (const [label, value] of [['本机', item.device], ['云端', item.cloud]]) {
          const details = document.createElement('details');
          const summary = document.createElement('summary');
          const content = document.createElement('pre');
          summary.textContent = label;
          content.textContent = value ? JSON.stringify(value, null, 2) : '已删除';
          details.append(summary, content);
          group.append(details);
        }
        group.append(choice);
        field('items').append(group);
      }
      status('有 ' + entries.length + ' 项修改需要确认。');
      render();
    }

    function schedule(delay = 0) {
      clearTimeout(timer);
      if (!settings.enabled || sizeBlocked || !foreground()) return;
      timer = setTimeout(() => {
        if (!foreground()) return;
        if (running) queued = true; else void sync();
      }, delay);
    }
    function invalidateAccount() {
      generation++;
      clearTimeout(timer);
      account = null;
      settings = { enabled: false, owner: '', base: model.empty() };
      sizeBlocked = false;
      guestAvailable = false;
      guestCheck++;
      partitions.lock();
      clearConflict();
      status('');
      window.dispatchEvent(new Event('brclio-terminal-account-changed'));
    }
    async function refreshAccount(lock = false) {
      if (lock) invalidateAccount();
      const epoch = generation;
      const device = await api.syncTerminal('local-session');
      const session = device.known ? device : await api.syncTerminal('session');
      if (epoch !== generation) return;
      if (session?.temporary) {
        if (partitions.ready || account) invalidateAccount();
        status('暂时无法确认登录身份。可以使用本地 Shell；联网后重新打开终端即可访问保存的资料。');
        return;
      }
      const next = session?.user || null;
      if (!partitions.ready || partitions.owner !== (next?.id || null)) {
        if (partitions.ready) invalidateAccount();
        else generation++;
        partitions.activate(next?.id || null);
        loadSettings();
        window.dispatchEvent(new Event('brclio-terminal-account-changed'));
      }
      account = next;
      render();
      if (settings.enabled) schedule();
    }

    async function sync() {
      if (!settings.enabled || running) return;
      running = true;
      queued = false;
      const epoch = generation;
      const owner = settings.owner;
      const valid = () => epoch === generation && settings.enabled && settings.owner === owner;
      try {
        // This endpoint authenticates the current bearer and binds the response to this account.
        const cloud = await api.syncTerminal('read', { expectedUserId: owner });
        if (!valid()) return;
        if (cloud?.userId !== owner) throw new Error('云端账号已变更，同步暂停。');
        const remote = model.portable(cloud.data);
        const local = libraries.read();
        const signature = JSON.stringify([cloud.revision, local]);
        const choices = resolution?.signature === signature ? resolution.choices : {};
        const merged = model.merge(settings.base, local, remote, choices);
        if (merged.conflicts.length) { showConflicts(merged.conflicts, cloud.revision, local); return; }
        if (!model.equal(merged.data, remote)) {
          if (!model.fitsUpload(merged.data)) {
            sizeBlocked = true;
            status('主机和转发模板超过 112 KiB，上传已暂停。精简配置后会自动重试。');
            return;
          }
          const result = await api.syncTerminal('write', { expectedUserId: owner, revision: cloud.revision, data: merged.data });
          if (!valid()) return;
          if (result?.userId !== owner || !model.equal(model.portable(result.data), merged.data)) throw new Error('云端保存结果与请求不一致。');
        }
        // A user may edit another host while the network request is in flight.
        // Reconcile again from the original base before replacing any local data.
        const current = libraries.read();
        let next = merged.data;
        if (!model.equal(local, current)) {
          queued = true;
          const edits = model.merge(local, current, merged.data);
          if (edits.conflicts.length) return;
          next = edits.data;
        }
        libraries.apply(next);
        if (!model.equal(settings.base, merged.data)) persist({ enabled: true, owner, base: merged.data });
        if (!model.equal(current, next)) window.dispatchEvent(new Event('brclio-terminal-library-applied'));
        clearConflict();
        status('已同步 · ' + new Date().toLocaleTimeString() + ' · ' + merged.data.hosts.length + ' 台主机，' + merged.data.forwards.length + ' 条转发');
      } catch (error) {
        if (valid()) status('同步待重试 · ' + error.message);
      } finally {
        running = false;
        if (settings.enabled) schedule(queued || generation !== epoch ? 0 : pollInterval);
      }
    }

    async function enable() {
      const epoch = generation;
      const session = await api.syncTerminal('session');
      if (epoch !== generation) return;
      account = session?.user || null;
      render();
      if (!account?.id) { status('请先在 Brclio 主窗口登录，再开启同步。'); return; }
      if (!partitions.ready || partitions.owner !== account.id) {
        await refreshAccount(true);
        status('账号已变更，请核对当前账号，再开启同步。');
        return;
      }
      persist({ enabled: true, owner: account.id, base: settings.owner === account.id ? settings.base : model.empty() });
      generation++;
      clearConflict();
      status('正在同步…');
      sizeBlocked = false;
      schedule();
    }
    function guard(action) { return () => Promise.resolve().then(action).catch(error => status(error.message)); }
    field('enable').onclick = guard(enable);
    field('move').onclick = guard(async () => {
      const device = await api.syncTerminal('local-session');
      const session = device.known ? device : await api.syncTerminal('session');
      if (!session?.user?.id || !partitions.ready || partitions.owner !== session.user.id || account?.id !== session.user.id) {
        await refreshAccount(true);
        status('账号已变更，请重新确认移入。');
        return;
      }
      const epoch = generation;
      const result = await api.unboundTransfer('move', account.id);
      if (epoch !== generation || !result.moved) return;
      guestAvailable = false;
      window.dispatchEvent(new Event('brclio-terminal-library-moved'));
      window.dispatchEvent(new Event('brclio-terminal-library-applied'));
      window.dispatchEvent(new Event('brclio-terminal-library-changed'));
      render();
      status('本机资料已移入当前账号。');
    });
    field('disable').onclick = guard(() => {
      generation++;
      clearTimeout(timer);
      persist({ ...settings, enabled: false });
      clearConflict();
      status('自动同步已关闭。');
    });
    field('refresh').onclick = () => { sizeBlocked = false; schedule(); };
    field('resolve').onclick = () => {
      if (!conflict) return;
      const selects = [...field('items').querySelectorAll('select')];
      if (selects.some(select => !select.value)) { status('请为每一项选择要保留的版本。'); return; }
      resolution = { signature: conflict.signature, choices: Object.fromEntries(conflict.entries.map((item, i) => [item.id, selects[i].value])) };
      schedule();
    };
    field('close').onclick = () => dialog.close();
    window.BrclioTerminalSync.open = () => {
      if (!dialog.open) dialog.showModal();
      render();
      refreshAccount().then(checkGuest).catch(error => status(error.message));
    };
    api.onSyncAccountChanged?.(() => { refreshAccount(true).then(checkGuest).catch(error => status(error.message)); });
    window.addEventListener('brclio-terminal-library-changed', () => { sizeBlocked = false; schedule(350); });
    function activityChanged() {
      if (foreground()) schedule();
      else clearTimeout(timer);
    }
    document.addEventListener('visibilitychange', activityChanged);
    window.addEventListener('focus', activityChanged);
    window.addEventListener('blur', () => clearTimeout(timer));
    window.addEventListener('online', () => schedule());
    render();
    window.BrclioTerminalSync.ready = refreshAccount().catch(error => status(error.message));
  },
};

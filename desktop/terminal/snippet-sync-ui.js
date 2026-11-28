'use strict';

window.BrclioSnippetSync = (() => {
  const key = 'brclio.terminal.snippet-sync.v1', model = window.BrclioSnippetSyncModel;
  const snippets = window.BrclioSnippetModel, partitions = window.BrclioTerminalPartitions;
  let dialog, timer, epoch = 0, active = false, dirty = false, conflict, message = '';
  const field = name => dialog?.querySelector('#snippet-sync-' + name);
  const settings = () => JSON.parse(partitions.storage.getItem(key) || '{"enabled":false,"base":[]}');
  const save = state => partitions.storage.setItem(key,JSON.stringify(state));
  const local = () => model.normalize(snippets.read(partitions.storage).filter(s => s.kind === 'snippet'));
  function paint() {
    if (!dialog?.open) return;
    field('enable').checked = !!partitions.owner && settings().enabled;
    field('enable').disabled = !partitions.owner;
    field('now').disabled = active || !field('enable').checked;
    field('choice').hidden = !conflict;
    field('status').textContent = partitions.owner ? message : '请先登录 Brclio。';
  }
  function schedule(delay = 700) {
    clearTimeout(timer);
    if (!partitions.ready || !partitions.owner || !settings().enabled || document.hidden || conflict) return;
    if (active) {dirty = true; return;}
    timer = setTimeout(() => sync(),delay);
  }
  async function sync(choice) {
    if (!partitions.owner || !settings().enabled || active) return;
    const original = epoch, owner = partitions.owner;
    const valid = () => original === epoch && partitions.owner === owner && settings().enabled;
    active = true; dirty = false; paint();
    try {
      const cloud = await window.brclioTerminal.snippetSync('read');
      if (!valid()) return;
      const here = local(), remote = model.normalize(cloud.data);
      const signature = JSON.stringify([cloud.revision,here]);
      const result = model.merge(settings().base,here,remote,conflict?.signature === signature ? choice : undefined);
      if (result.conflicts.length) {
        conflict = {signature};
        message = '两台设备都改动了这些剪藏：' + result.conflicts.join('、');
        return;
      }
      const notes = snippets.read(partitions.storage).filter(s => s.kind === 'note');
      if (notes.length + result.items.length > 200 || result.items.some(s => notes.some(n => n.id === s.id))) throw new Error('与本地笔记的标识或数量限制冲突，请先整理剪藏。');
      if (new TextEncoder().encode(JSON.stringify(result.items)).length > 112*1024) throw new Error('剪藏超过 112 KiB 同步上限。');
      if (!model.same(remote,result.items)) await window.brclioTerminal.snippetSync('write',{revision:cloud.revision,data:result.items});
      if (!valid()) return;
      const latest = local();
      const rebased = model.merge(here,latest,result.items);
      if (rebased.conflicts.length) {
        // This device edited an item that changed remotely during the upload.
        // The snapshot taken before the request is their common ancestor.
        save({enabled:true,base:here});
        dirty = true; conflict = null; message = '检测到新的本地编辑，正在核对。';
        return;
      }
      if (!model.same(latest,rebased.items)) {
        const currentNotes = snippets.read(partitions.storage).filter(s => s.kind === 'note');
        if (currentNotes.length + rebased.items.length > 200 || rebased.items.some(s => currentNotes.some(n => n.id === s.id))) throw new Error('本机笔记已变更，请重新同步。');
        partitions.storage.setItem(snippets.key,JSON.stringify([...currentNotes,...rebased.items]));
        window.dispatchEvent(new Event('brclio-snippets-changed'));
      }
      save({enabled:true,base:result.items});
      dirty = !model.same(result.items,rebased.items);
      conflict = null; message = '剪藏已同步。';
    } catch (error) { if (valid()) message = error.message; }
    finally { if (original === epoch) { active = false; paint(); schedule(dirty ? 700 : 300000); } }
  }
  function reset() {
    epoch++; active = false; dirty = false; clearTimeout(timer); conflict = null; message = '';
    if (dialog?.open) dialog.close();
    schedule();
  }
  function init() {
    dialog = document.createElement('dialog'); dialog.className = 'terminal-network-dialog'; dialog.id = 'snippet-sync';
    dialog.setAttribute('aria-labelledby','snippet-sync-title');
    dialog.innerHTML = `<div class="dialog-head"><h2 id="snippet-sync-title">个人剪藏同步</h2><button id="snippet-sync-close">关闭</button></div>
      <label><input type="checkbox" id="snippet-sync-enable">同步本账号的剪藏与剪藏包</label>
      <p class="forward-hint">开启后，剪藏正文和包名会以明文保存至本账号的私有 GitHub 数据目录。笔记留在本机。关闭开关会停止本设备同步。</p>
      <div class="network-actions"><button id="snippet-sync-now">立即同步</button></div><p id="snippet-sync-status" role="status"></p>
      <div id="snippet-sync-choice" hidden><button id="snippet-sync-local">冲突项保留本机版</button><button id="snippet-sync-cloud">冲突项保留云端版</button></div>`;
    document.body.append(dialog);
    field('enable').onchange = () => {
      const state = settings(); state.enabled = field('enable').checked; save(state);
      epoch++; active = false; conflict = null; message = ''; paint(); schedule(0);
    };
    field('now').onclick = () => sync();
    field('local').onclick = () => sync('local');
    field('cloud').onclick = () => sync('cloud');
    field('close').onclick = () => dialog.close();
  }
  window.addEventListener('brclio-terminal-account-changed',reset);
  window.addEventListener('brclio-snippets-changed',() => schedule());
  document.addEventListener('visibilitychange',() => schedule());
  window.addEventListener('focus',() => schedule());
  return {open() { if (!dialog) init(); dialog.showModal(); paint(); }};
})();

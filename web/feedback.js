(() => {
  'use strict';
  const host = window.BrclioHost;
  const el = id => document.getElementById('feedback-' + id);
  const form = el('form');
  let snapshot, owner, retry, busy = false, loading = false, sequence = 0, accountRevision = 0;
  const account = (path, method = 'GET', body) => host.accountRequest({path, method, ...(body && {body})});
  function message(text, error = false) {
    el('status').textContent = text;
    el('status').classList.toggle('feedback-error', error);
  }
  function controls() {
    el('login').hidden = Boolean(owner);
    el('submit').disabled = busy || !owner || (el('attach').checked && (!snapshot || loading));
    el('copy').disabled = !snapshot?.entryCount || busy || loading;
    el('refresh').disabled = busy || loading;
    for (const id of ['category','title','description','attach']) el(id).disabled = busy;
  }
  function setOwner(value) {
    if (owner !== value) { retry = null; message(value ? '' : '登录后可提交反馈，复制本机日志无需登录。'); }
    owner = value;
    controls();
  }
  window.addEventListener('brclio:account-state', event => { accountRevision++; setOwner(event.detail.userId); });
  async function readLogs() {
    const current = ++sequence;
    loading = true; controls();
    try {
      const result = await host.getSoftwareLogs();
      if (current !== sequence) return;
      snapshot = result;
      el('preview').textContent = result.text || '这台设备暂时没有诊断记录。';
      el('log-info').textContent = '最近 7 天，共 ' + result.entryCount + ' 条。复制或提交前可以先查看。';
    } catch {
      if (current !== sequence) return;
      snapshot = null; el('preview').textContent = '';
      el('log-info').textContent = '读取日志失败。请刷新重试，或取消附加日志后单独提交问题。';
    } finally { if (current === sequence) { loading = false; controls(); } }
  }
  window.addEventListener('brclio:view', async event => {
    if (event.detail.name !== 'feedback' || busy) return;
    void readLogs();
    const revision = accountRevision;
    try {
      const session = await account('/api/account/session');
      if (revision === accountRevision) setOwner(session.user?.id || null);
    } catch { if (revision === accountRevision) { setOwner(null); message('账号服务暂时不可用。可以先复制日志，稍后再提交。', true); } }
  });
  document.getElementById('xhs-report-error').addEventListener('click', () => {
    if (!el('title').value) { el('category').value = 'download'; el('title').value = '小红书工具报错'; }
  });
  el('back').addEventListener('click', () => window.dispatchEvent(new CustomEvent('brclio:navigate', {detail:{name:'settings'}})));
  el('attach').addEventListener('change', controls);
  el('refresh').addEventListener('click', readLogs);
  el('login').addEventListener('click', () => document.getElementById('account-button').click());
  el('copy').addEventListener('click', async () => {
    try { await host.copyText(snapshot.text); message('已复制预览中的 ' + snapshot.entryCount + ' 条日志。'); }
    catch { message('复制失败，请在日志预览中选择文字复制。', true); }
  });
  form.addEventListener('input', () => { retry = null; if (owner) message(''); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !owner) return;
    const userId = owner;
    busy = true; controls(); message('正在确认账号…');
    try {
      const session = await account('/api/account/session');
      if (owner !== userId || session.user?.id !== userId) {
        setOwner(session.user?.id || null);
        throw new Error('登录账号已变化，请确认后重新提交。');
      }
      if (!retry) {
        const title = el('title').value.trim(), description = el('description').value.trim();
        if (!title || !description) throw new Error('请填写问题标题和详细描述。');
        if (el('attach').checked && !snapshot) throw new Error('请刷新日志或取消附加日志。');
        const platform = await host.getPlatform();
        retry = {requestId: crypto.randomUUID(), category: el('category').value, title, description,
          appVersion: platform.version, platform: platform.platform, logs: el('attach').checked ? snapshot.logs : []};
      }
      // Refreshing diagnostic data after a timeout must reuse the submission ID.
      retry.logs = el('attach').checked ? snapshot.logs : [];
      message('正在提交反馈…');
      const result = await account('/api/account/feedback', 'POST', retry);
      if (owner === userId) {
        form.reset(); retry = null;
        message('已提交。反馈编号 ' + result.id + '。');
      }
    } catch (error) { message(String(error.message || '提交失败，可重试。').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''), true); }
    finally { busy = false; controls(); }
  });
  controls();
})();

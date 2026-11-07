'use strict';
const byId = id => document.getElementById(id);
function networkLabel({route, phase, latencyMs}) {
  if (route === 'system') return phase === 'error' ? '系统代理 · 连接失败' : '正在使用系统代理';
  if (route !== 'builtin') return phase === 'error' ? '系统代理检测失败' : '正在检测系统代理';
  const phases = {refreshing:'正在刷新订阅', probing:'正在测速选线', ready:'已选用最低延迟节点', error:'连接失败'};
  return ['内置代理', phases[phase], phase === 'ready' && Number.isFinite(latencyMs) && latencyMs + ' ms'].filter(Boolean).join(' · ');
}
function render(state) {
  byId('title').textContent = state.title;
  byId('detail').textContent = state.detail;
  byId('version').textContent = state.version;
  const bar = byId('bar');
  if (Number.isFinite(state.progress)) bar.value = state.progress;
  else bar.removeAttribute('value');
  byId('network').textContent = networkLabel(state);
  byId('warning').hidden = !state.warning;
  byId('warning').textContent = state.warning || '';
  byId('autoSelf').checked = state.autoSelf;
  byId('autoSelf').disabled = Boolean(state.installing);
  byId('download').disabled = state.busy;
  byId('upgrade').disabled = state.busy;
  byId('retry').hidden = !state.retry;
  byId('retry').disabled = state.busy;
}
let received = false;
window.downloader.subscribe(state => { received = true; render(state); });
window.downloader.read().then(state => { if (state && !received) render(state); });
byId('retry').addEventListener('click', () => window.downloader.retry());
byId('download').addEventListener('click', () => window.downloader.start('brclio'));
byId('upgrade').addEventListener('click', () => window.downloader.start('self'));

byId('autoSelf').addEventListener('change', async event => {
  const input = event.target;
  const errorBox = byId('preferenceError');
  errorBox.hidden = true;
  try { await window.downloader.setAutoSelf(input.checked); }
  catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; render(await window.downloader.read()); }
});

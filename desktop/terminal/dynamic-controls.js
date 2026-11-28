'use strict';

window.BrclioDynamicControls = function dynamicControls({ api, activePane, panes, appearance }) {
  const $ = key => document.getElementById('dynamic-' + key);
  const storageKey = 'brclio.terminal.dynamic-import.v1';
  const applied = new WeakMap();
  let imported = new Map(), serial = 0, selectedFile = false, watching = false;
  function populate(profiles) {
    const previous = $('list').value;
    imported = new Map(profiles.map(profile => [profile.guid, profile]));
    $('list').replaceChildren(...Array.from(imported.values(), profile => {
      const option = new Option(profile.name + ' · ' + profile.tags, profile.guid);
      option.title = profile.guid;
      return option;
    }));
    if (imported.has(previous)) $('list').value = previous;
    $('list').disabled = $('apply').disabled = !imported.size;
  }
  function apply(pane, profile) {
    const value = appearance.applyImported(pane, profile);
    applied.set(pane, { guid: profile.guid, value });
  }
  function received(data) {
    if (!data || data.serial <= serial) return;
    serial = data.serial;
    selectedFile = true;
    $('watch').checked = watching = data.watching;
    if (data.error) { $('status').textContent = data.error; return; }
    populate(data.profiles);
    for (const pane of panes.values()) {
      const bound = applied.get(pane);
      if (!bound) continue;
      if (pane.appearance !== bound.value || !imported.has(bound.guid)) applied.delete(pane);
      else apply(pane, imported.get(bound.guid));
    }
    $('status').textContent = data.source + ' · ' + imported.size + ' 个配置' + (watching ? ' · 正在跟踪' : '');
    try { localStorage.setItem(storageKey, JSON.stringify(data.profiles)); }
    catch { $('status').textContent += ' · 本次导入仅在当前窗口可用'; }
  }
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey)) || [];
    populate(Array.isArray(saved) ? saved.slice(0, 64).filter(v => v && typeof v.guid === 'string' && typeof v.name === 'string') : []);
  } catch { populate([]); }
  $('import').onclick = async () => {
    $('import').disabled = true;
    try { received(await api.chooseDynamic($('watch').checked)); }
    catch (error) { $('status').textContent = error.message; }
    finally { $('import').disabled = false; }
  };
  $('watch').onchange = async () => {
    if (!selectedFile) { $('status').textContent = $('watch').checked ? '选择文件后开始跟踪。' : ''; return; }
    $('watch').disabled = true;
    try { received(await api.trackDynamic($('watch').checked)); }
    catch (error) { $('watch').checked = watching; $('status').textContent = error.message; }
    finally { $('watch').disabled = false; }
  };
  $('apply').onclick = () => {
    const pane = activePane(), profile = imported.get($('list').value);
    if (pane && profile) { apply(pane, profile); $('status').textContent = '已应用 ' + profile.name; }
  };
  api.onDynamicChanged(received);
};

'use strict';

window.BrclioShellLocations = function shellLocations(profiles, panes, locationChanged) {
  const key = 'brclio.terminal.profile-rules.v1';
  const $ = id => document.getElementById('location-' + id);
  let rules = [];
  function valid(value) {
    return value && typeof value.host === 'string' && value.host.length <= 255 &&
      typeof value.path === 'string' && value.path.length <= 1024 && (value.host || value.path) &&
      typeof value.profile === 'string' && value.profile.length > 0 && value.profile.length <= 64;
  }
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (Array.isArray(saved)) rules = saved.filter(valid).slice(0, 32);
  } catch {}
  function apply(pane) {
    const { hostname, directory } = pane.location;
    const rule = rules.find(rule => (!rule.host || rule.host.toLowerCase() === hostname.toLowerCase()) &&
      (!rule.path || directory === rule.path || directory.startsWith(rule.path.endsWith('/') ? rule.path : rule.path + '/')));
    const next = rule && profiles.names().includes(rule.profile) ? rule.profile : '';
    if (next === pane.locationProfile) return;
    if (next) {
      if (!pane.locationProfile) pane.beforeLocationProfile = pane.appearance;
      profiles.applyNamed(pane, next);
    } else if (pane.beforeLocationProfile) {
      profiles.applyAppearance(pane, pane.beforeLocationProfile);
      pane.beforeLocationProfile = null;
    }
    pane.locationProfile = next;
  }
  function render() {
    const select = $('profile');
    const selected = select.value;
    select.replaceChildren(...profiles.names().map(name => new Option(name, name)));
    if (profiles.names().includes(selected)) select.value = selected;
    $('rules').replaceChildren(...rules.map((rule, index) => {
      const row = document.createElement('div');
      row.textContent = [rule.host, rule.path].filter(Boolean).join(' · ') + ' → ' + rule.profile + ' ';
      const del = document.createElement('button');
      del.type = 'button'; del.textContent = '移除';
      del.onclick = () => {
        rules.splice(index, 1);
        save();
      };
      row.append(del);
      return row;
    }));
  }
  function save() {
    try {
      localStorage.setItem(key, JSON.stringify(rules));
      $('status').textContent = '已保存，使用第一个匹配的规则。';
    } catch (error) { $('status').textContent = error.message; }
    render();
    for (const pane of panes.values()) if (pane.location) apply(pane);
  }
  $('add').onclick = () => {
    const rule = { host: $('host').value.trim(), path: $('path').value.trim().replaceAll('\\','/'), profile: $('profile').value };
    if (!valid(rule) || !profiles.names().includes(rule.profile)) {
      $('status').textContent = '请先保存一个命名配置，并输入主机或目录前缀。'; return;
    }
    if (rules.length >= 32) { $('status').textContent = '最多可添加 32 个规则。'; return; }
    rules.push(rule); save();
  };
  return { render, attach(pane) {
    pane.location = { hostname: '', directory: '' };
    function update(host, directory) {
      if (typeof directory !== 'string' || directory.length > 4096 || host.length > 255 || /[\x00-\x1f\x7f]/.test(host + directory)) return;
      pane.location = { hostname: host, directory: directory.replaceAll('\\', '/') };
      apply(pane);
      locationChanged(pane);
    }
    // Metadata from the shell only selects a local visual preset, never a command.
    pane.terminal.parser.registerOscHandler(7, data => {
      try {
        const url = new URL(data);
        if (url.protocol !== 'file:' || url.username || url.password) return false;
        const name = decodeURIComponent(url.pathname);
        update(url.hostname, /^\/[A-Za-z]:\//.test(name) ? name.slice(1) : name);
        return true;
      } catch { return false; }
    });
    pane.terminal.parser.registerOscHandler(1337, data => {
      if (data.startsWith('CurrentDir=')) { update(pane.location.hostname, data.slice(11)); return true; }
      if (data.startsWith('RemoteHost=')) {
        const host = data.slice(11).split('@').at(-1);
        update(host, pane.location.directory); return true;
      }
      return false;
    });
  }};
};

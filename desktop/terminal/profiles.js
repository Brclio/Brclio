'use strict';

window.BrclioTerminalProfiles = function profiles({ theme, activePane, applySession, readSession, refit }) {
  const $ = key => document.getElementById('preset-' + key);
  const status = text => { $('status').textContent = text; };
  const key = 'brclio.terminal.profiles.v1';
  const defaults = { name: '默认', tags: '', font: '"SFMono-Regular", Consolas, Menlo, "Liberation Mono", monospace',
    size: 14, scrollback: 10000, cursor: 'block', blink: true, contrast: 1, autocopy: false, follow: false, colors: {} };
  const integers = { size: [8, 40], scrollback: [100, 50000] };
  const palette = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
  const colors = { 'Background Color': 'background', 'Foreground Color': 'foreground', 'Cursor Color': 'cursor',
    'Cursor Text Color': 'cursorAccent', 'Selection Color': 'selectionBackground', 'Selected Text Color': 'selectionForeground' };
  palette.forEach((name, i) => { colors['Ansi ' + i + ' Color'] = name; });
  const allowedColors = new Set(Object.values(colors));
  const presets = new Map();
  let current = defaults;
  let editColors = {};
  function normalize(input = {}) {
    const value = { ...defaults, colors: {} };
    for (const [field, max] of [['name', 64], ['tags', 180], ['font', 200]]) {
      if (typeof input[field] === 'string' && input[field].trim()) value[field] = input[field].trim().slice(0, max);
    }
    for (const [field, [min, max]] of Object.entries(integers)) {
      if (Number.isInteger(input[field]) && input[field] >= min && input[field] <= max) value[field] = input[field];
    }
    if (Number.isFinite(input.contrast) && input.contrast >= 1 && input.contrast <= 21) value.contrast = input.contrast;
    if (['block','bar','underline'].includes(input.cursor)) value.cursor = input.cursor;
    for (const field of ['blink','autocopy','follow']) if (typeof input[field] === 'boolean') value[field] = input[field];
    for (const [field, color] of Object.entries(input.colors || {})) {
      if (allowedColors.has(field) && /^#[\da-f]{6}$/i.test(color)) value.colors[field] = color;
    }
    if (typeof input.shell === 'string' && /^(default|zsh|bash|powershell|pwsh|cmd)$/.test(input.shell)) value.shell = input.shell;
    if (typeof input.cwd === 'string' && input.cwd.length < 8192) value.cwd = input.cwd;
    value.integration = input.integration === true;
    return value;
  }
  try {
    const data = JSON.parse(localStorage.getItem(key));
    if (Array.isArray(data?.presets)) {
      for (const item of data.presets.slice(0,64)) { const value = normalize(item); presets.set(value.name, value); }
      current = presets.get(data.active) || defaults;
    }
  } catch { /* Invalid or obsolete settings fall back to the built-in profile. */ }
  function persist() {
    localStorage.setItem(key, JSON.stringify({ active: current.name, presets: [...presets.values()] }));
  }
  function refreshList(selected) {
    const filter = $('filter').value.toLowerCase();
    const list = [...presets.values()].filter(item => (item.name + ' ' + item.tags).toLowerCase().includes(filter));
    $('list').replaceChildren(...list.map(item => new Option(item.name, item.name)));
    if (list.some(item => item.name === selected)) $('list').value = selected;
    $('load').disabled = $('delete').disabled = list.length === 0;
  }
  function edit(value) {
    for (const field of ['name','tags','font','size','scrollback','cursor','contrast']) $(field).value = value[field];
    for (const field of ['blink','autocopy','follow']) $(field).checked = value[field];
    editColors = { ...value.colors };
    $('colors').value = '';
  }
  function fromForm() {
    const value = { colors: editColors, ...readSession() };
    for (const field of ['name','tags','font','cursor']) value[field] = $(field).value;
    for (const field of ['size','scrollback','contrast']) {
      if (!$(field).value || !$(field).reportValidity()) throw new Error('请填写有效的数值。');
      value[field] = Number($(field).value);
    }
    for (const field of ['blink','autocopy','follow']) value[field] = $(field).checked;
    return normalize(value);
  }
  function options(value = current) {
    return { theme: { ...theme, ...value.colors }, fontSize: value.size, fontFamily: value.font, scrollback: value.scrollback,
      cursorStyle: value.cursor, cursorBlink: value.blink, minimumContrastRatio: value.contrast };
  }
  function apply(pane, value) {
    if (!pane) return;
    Object.assign(pane.terminal.options, options(value));
    pane.appearance = value;
    refit(pane);
  }
  function update(save) {
    try {
      const value = fromForm();
      if (save) {
        if (presets.size >= 64 && !presets.has(value.name)) throw new Error('最多可保存 64 个配置。');
        presets.set(value.name, value);
        current = value;
        persist();
        refreshList(value.name);
      }
      apply(activePane(), value);
      status(save ? '已保存，新会话将使用此配置。' : '已应用到当前窗格。');
    } catch (error) { status(error.message); }
  }
  $('apply').onclick = () => update(false);
  $('save').onclick = () => update(true);
  $('filter').oninput = () => refreshList($('list').value);
  $('load').onclick = () => {
    const value = presets.get($('list').value);
    if (!value) return;
    edit(value);
    applySession(value);
    apply(activePane(), value);
    status('已载入 ' + value.name);
  };
  $('delete').onclick = () => {
    const name = $('list').value;
    presets.delete(name);
    if (name === current.name) current = defaults;
    try { persist(); refreshList(); status('已删除 ' + name); } catch (error) { status(error.message); }
  };
  $('colors').onchange = async () => {
    const file = $('colors').files[0];
    if (!file) return;
    try {
      if (file.size > 256 * 1024) throw new Error('配色文件过大。');
      const xml = new DOMParser().parseFromString(await file.text(), 'application/xml');
      const dict = xml.querySelector('plist > dict');
      if (!dict || xml.querySelector('parsererror')) throw new Error('请选择 XML 格式的 .itermcolors 配色。');
      const imported = {};
      for (const name of dict.children) {
        const field = name.tagName === 'key' && colors[name.textContent];
        const entry = name.nextElementSibling;
        if (!allowedColors.has(field) || entry?.tagName !== 'dict') continue;
        const channels = new Map();
        for (const k of entry.children) {
          if (k.tagName === 'key' && ['real','integer'].includes(k.nextElementSibling?.tagName))
            channels.set(k.textContent, Number(k.nextElementSibling.textContent));
        }
        const rgb = ['Red Component','Green Component','Blue Component'].map(k => channels.get(k));
        if (rgb.every(v => Number.isFinite(v) && v >= 0 && v <= 1))
          imported[field] = '#' + rgb.map(v => Math.round(v * 255).toString(16).padStart(2,'0')).join('');
      }
      if (!Object.keys(imported).length) throw new Error('配色文件未包含可识别的 RGB 颜色。');
      editColors = imported;
      status('已读取配色，点击应用或保存。');
    } catch (error) { status(error.message); }
  };
  refreshList(current.name);
  edit(current);
  return { options, get current() { return current; },
    names: () => [...presets.keys()], applyAppearance: apply,
    applyNamed(pane, name) {
      const value = presets.get(name);
      if (value) apply(pane, value);
      return Boolean(value);
    },
  };
};

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const maxBytes = 256 * 1024;
const colors = { 'Foreground Color': 'foreground', 'Background Color': 'background', 'Cursor Color': 'cursor',
  'Cursor Text Color': 'cursorAccent', 'Selection Color': 'selectionBackground', 'Selected Text Color': 'selectionForeground' };
const palette = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
palette.forEach((name, i) => { colors['Ansi ' + i + ' Color'] = name; });

function label(value, max, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new Error('动态配置的 ' + field + ' 无效。');
  }
  return value.trim();
}

function parse(text) {
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('动态配置不是有效的 UTF-8 JSON。'); }
  if (!Array.isArray(data?.Profiles) || data.Profiles.length > 64) throw new Error('Profiles 应为不超过 64 项的数组。');
  const guids = new Set();
  return data.Profiles.map(raw => {
    const guid = label(raw?.Guid, 128, 'Guid');
    const name = label(raw.Name, 64, 'Name');
    if (guids.has(guid)) throw new Error('文件中含有重复的 Guid。');
    guids.add(guid);
    const tags = raw.Tags ?? [];
    if (!Array.isArray(tags) || tags.length > 32) throw new Error('Tags 应为不超过 32 项的数组。');
    const result = { guid, name, tags: [...new Set(['Dynamic', ...tags.map(tag => label(tag, 48, 'Tags'))])].join(', '), colors: {} };
    if (raw['Normal Font'] !== undefined) {
      const font = /^([\p{L}\p{N} _.-]{1,120})\s+(\d+(?:\.\d+)?)$/u.exec(raw['Normal Font']);
      if (!font || Number(font[2]) < 8 || Number(font[2]) > 40) throw new Error('Normal Font 需要字体名称及 8 至 40 的字号。');
      result.font = '"' + font[1].trim() + '", monospace';
      result.size = Math.round(Number(font[2]));
    }
    const lines = raw['Scrollback Lines'];
    if (lines !== undefined) {
      if (!Number.isInteger(lines) || lines < 100 || lines > 50000) throw new Error('Scrollback Lines 超出范围。');
      result.scrollback = lines;
    }
    if (raw['Blinking Cursor'] !== undefined) {
      if (typeof raw['Blinking Cursor'] !== 'boolean') throw new Error('Blinking Cursor 需要布尔值。');
      result.blink = raw['Blinking Cursor'];
    }
    for (const [key, field] of Object.entries(colors)) {
      if (raw[key] === undefined) continue;
      const rgb = ['Red Component', 'Green Component', 'Blue Component'].map(ch => raw[key]?.[ch]);
      if (!rgb.every(v => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error(key + ' 需要 0 到 1 之间的 RGB 通道。');
      result.colors[field] = '#' + rgb.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
    }
    return result;
  });
}

async function readFile(file) {
  if (await fs.promises.realpath(file) !== file) throw new Error('动态配置文件路径已改变。');
  const before = await fs.promises.lstat(file);
  if (!before.isFile() || before.size > maxBytes) throw new Error('请选择 256 KiB 以内的普通 JSON 文件。');
  const fileHandle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const st = await fileHandle.stat();
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino || st.size > maxBytes) throw new Error('配置文件已变更，请重试。');
    const bytes = Buffer.alloc(st.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await fileHandle.read(bytes, count, bytes.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count !== st.size) throw new Error('配置文件正在更新。');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)); }
    catch { throw new Error('动态配置不是有效的 UTF-8 JSON。'); }
    return parse(text);
  } finally { await fileHandle.close(); }
}

function dynamicSource(publish, interval = 900) {
  let current, ticket = 0, serial = 0;
  function stop() {
    ++ticket;
    if (current) {
      fs.unwatchFile(current.file, current.onChange);
      current = undefined;
    }
  }
  function event(state, error) {
    return { serial: ++serial, source: path.basename(state.file), watching: state.watching, profiles: state.profiles, error: error || '' };
  }
  function watch(state, enabled) {
    if (state.watching) fs.unwatchFile(state.file, state.onChange);
    state.watching = enabled;
    ++state.revision;
    if (enabled) fs.watchFile(state.file, { persistent: false, interval }, state.onChange);
  }
  async function update(state) {
    const revision = ++state.revision;
    try {
      const profiles = await readFile(state.file);
      if (state !== current || revision !== state.revision) return;
      state.profiles = profiles;
      publish(event(state));
    } catch (err) {
      if (state === current && revision === state.revision) publish(event(state, '未能更新文件，保留上次配置。' + (err.code || err.message)));
    }
  }
  async function choose(select, enabled) {
    const request = ++ticket;
    const chosen = await select();
    if (!chosen || request !== ticket) return null;
    if (!path.isAbsolute(chosen) || /^[/\\]{2}/.test(chosen) || path.extname(chosen).toLowerCase() !== '.json') {
      throw new Error('请选择本地 .json 文件。');
    }
    const parent = await fs.promises.realpath(path.dirname(chosen));
    const file = path.join(parent, path.basename(chosen));
    const profiles = await readFile(file);
    if (request !== ticket) return null;
    stop();
    const state = { file, profiles, revision: 0, watching: false };
    state.onChange = () => update(state);
    current = state;
    watch(state, enabled === true);
    if (state.watching) void update(state);
    return event(state);
  }
  function track(enabled) {
    if (!current || typeof enabled !== 'boolean') throw new Error('请先选择本地动态配置文件。');
    const state = current;
    watch(state, enabled);
    if (enabled) void update(state);
    return event(state);
  }
  return { choose, track, stop };
}

module.exports = { parse, dynamicSource };

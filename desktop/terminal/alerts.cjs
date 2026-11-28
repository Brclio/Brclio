'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { normalizeShortcut } = require('../shortcuts.cjs');

function preferenceFile(directory) {
  const file = path.join(directory, 'terminal-preferences.json');
  return {
    async read() {
      try { return JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; return {}; }
    },
    async write(value) {
      await fs.mkdir(directory, { recursive: true });
      const temporary = file + '.' + randomUUID() + '.tmp';
      try {
        await fs.writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }); }
    },
  };
}

function createTerminalAlerts({ storage, globalShortcut, copyShortcut, onHotkey, notify, serialize, now = Date.now }) {
  let saved = { hotkey: null, bell: false };
  let active;
  let error = null;
  let nextBell = 0;
  let ready;
  let disposed = false;
  const owned = new Set();

  function status() {
    return { ...saved, registered: Boolean(active && globalShortcut.isRegistered(active)), error, copyShortcut: copyShortcut() };
  }
  function register(key) {
    if (key === copyShortcut()) throw new Error('这个组合已用于 Brclio 复制路径，请换一个快捷键。');
    if (globalShortcut.isRegistered(key) || !globalShortcut.register(key, () => {
      if (active === key) Promise.resolve(onHotkey(key)).catch(() => {});
    })) throw new Error('这个快捷键已被系统或其他应用占用，请换一个组合。');
    owned.add(key);
  }
  function release(key) {
    if (owned.delete(key)) globalShortcut.unregister(key);
  }
  async function restore() {
    try {
      const value = await storage.read();
      if (!value || typeof value !== 'object') throw new Error('终端偏好文件格式无效。');
      await serialize(() => {
        if (disposed) return;
        saved = { hotkey: value.hotkey == null ? null : normalizeShortcut(value.hotkey), bell: value.bell === true };
        if (saved.hotkey) { register(saved.hotkey); active = saved.hotkey; }
      });
    } catch (failure) { error = failure.message; }
    return status();
  }
  function initialize() { return ready ??= restore(); }
  async function setHotkey(value) {
    await initialize();
    return serialize(async () => {
      const key = value === null ? null : normalizeShortcut(value);
      if ((!key && !saved.hotkey) || (key && key === active && globalShortcut.isRegistered(key))) return status();
      const previous = active;
      if (key) register(key);
      try {
        const next = { ...saved, hotkey: key };
        await storage.write(next);
        saved = next;
        active = key;
        error = null;
        if (previous !== key) release(previous);
        return status();
      } catch (failure) { release(key); throw failure; }
    });
  }
  async function setBell(enabled) {
    await initialize();
    return serialize(async () => {
      if (typeof enabled !== 'boolean') throw new Error('终端铃设置无效。');
      if (saved.bell !== enabled) {
        const next = { ...saved, bell: enabled };
        await storage.write(next);
        saved = next;
      }
      return status();
    });
  }
  function bell() {
    if (!saved.bell) return false;
    const time = now();
    if (time < nextBell) return false;
    nextBell = time + 10000;
    return notify();
  }
  return { initialize, status, setHotkey, setBell, bell,
    dispose() { disposed = true; for (const key of owned) release(key); active = undefined; } };
}

module.exports = { createTerminalAlerts, preferenceFile };

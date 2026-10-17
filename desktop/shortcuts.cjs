'use strict';

const DEFAULT_SHORTCUT = 'Alt+P';
const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Super'];
const SPECIAL_KEYS = ['Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Up', 'Down', 'Left', 'Right'];

function normalizeShortcut(value) {
  if (typeof value !== 'string' || value.length > 64) throw new Error('快捷键格式无效，请重新录入。');
  const parts = value.split('+');
  const key = parts.pop();
  if (!parts.length || parts.some(part => !MODIFIERS.includes(part)) || new Set(parts).size !== parts.length
      || !parts.some(part => ['Ctrl', 'Alt', 'Super'].includes(part))
      || !(/^[A-Z0-9]$/.test(key) || /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key) || SPECIAL_KEYS.includes(key))) {
    throw new Error('请使用 Control、Option / Alt 或 Command / Win 加一个字母、数字或功能键。');
  }
  return [...MODIFIERS.filter(part => parts.includes(part)), key].join('+');
}

/** Keep the previous binding until both OS registration and persistence succeed. */
function createShortcutManager({ globalShortcut, platform = process.platform, onActivate }) {
  const supported = ['darwin', 'win32'].includes(platform);
  let accelerator = DEFAULT_SHORTCUT;
  let active = null;
  let suspended = false;
  let error = null;

  function status() {
    return { supported, accelerator, registered: Boolean(active && globalShortcut.isRegistered(active)), error };
  }
  function register(value) {
    if (!globalShortcut.register(value, onActivate)) throw new Error('这个快捷键已被系统或其他应用占用，请换一个组合。');
  }
  function resume() {
    suspended = false;
    if (!supported) return status();
    try {
      const value = normalizeShortcut(accelerator);
      if (!active || !globalShortcut.isRegistered(active)) { register(value); active = value; }
      error = null;
    } catch (failure) { error = failure.message; }
    return status();
  }
  function initialize(value) {
    accelerator = value;
    return resume();
  }
  function suspend() {
    suspended = true;
    if (active) globalShortcut.unregister(active);
    active = null;
    return status();
  }
  async function save(value, commit) {
    const next = normalizeShortcut(value);
    if (!supported) {
      if (next !== accelerator) throw new Error('全局快捷键仅支持 macOS 和 Windows 客户端。');
      return commit();
    }
    // A busy system shortcut must not block unrelated path/login preferences.
    // Recording explicitly suspends first, so confirming a recorded key still
    // requires a successful registration even when the combination is unchanged.
    if (next === accelerator && !suspended) return commit();
    const previous = accelerator;
    const previousActive = active;
    let candidateRegistered = false;
    try {
      if (next !== active || !globalShortcut.isRegistered(next)) { register(next); candidateRegistered = true; }
      const result = await commit();
      if (previousActive && previousActive !== next) globalShortcut.unregister(previousActive);
      accelerator = next;
      active = next;
      suspended = false;
      error = null;
      return result;
    } catch (failure) {
      if (candidateRegistered) globalShortcut.unregister(next);
      accelerator = previous;
      active = previousActive;
      // Recording may have released the old key. Always restore it on failure.
      const restored = resume();
      if (!restored.registered) throw new Error(`${failure.message} 原快捷键暂时无法恢复，请重新设置。`);
      throw failure;
    }
  }
  function dispose() {
    if (active) globalShortcut.unregister(active);
    active = null;
    suspended = false;
  }
  return { initialize, status, suspend, resume, save, dispose, isSuspended: () => suspended };
}

module.exports = { DEFAULT_SHORTCUT, normalizeShortcut, createShortcutManager };

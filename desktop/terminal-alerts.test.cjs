'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTerminalAlerts, preferenceFile } = require('./terminal/alerts.cjs');

function fixture(initial = {}, options = {}) {
  const callbacks = new Map();
  const occupied = new Set();
  const data = { saved: initial, calls: 0 };
  const events = [];
  let time = 0;
  const settings = {
    storage: {
      read: options.read || (async () => data.saved),
      async write(value) { if (data.fail) throw new Error('disk full'); data.calls++; data.saved = value; },
    },
    globalShortcut: {
      isRegistered: key => callbacks.has(key),
      register(key, action) { if (occupied.has(key)) return false; callbacks.set(key, action); return true; },
      unregister(key) { callbacks.delete(key); },
    },
    now: () => time, copyShortcut: () => 'Alt+P', onHotkey: key => events.push(key),
    notify: () => { events.push('bell'); return true; },
    serialize: action => action(),
  };
  return { alerts: createTerminalAlerts(settings), callbacks, occupied, data, events, tick: value => { time += value; } };
}

test('global hotkey is opt-in, reserves the copy shortcut and commits rebindings atomically', async () => {
  const { alerts, callbacks, occupied, data, events } = fixture();
  callbacks.set('Ctrl+X', () => events.push('other'));
  await alerts.initialize();
  assert.equal(alerts.status().registered, false);
  assert.equal(data.calls, 0);
  await assert.rejects(alerts.setHotkey('Alt+P'), /复制路径/); // Reserved even while copy shortcut is temporarily suspended.
  await assert.rejects(alerts.setHotkey('Ctrl+X'), /占用/);
  await alerts.setHotkey('Shift+Alt+Y');
  assert.equal(alerts.status().hotkey, 'Alt+Shift+Y');
  const first = callbacks.get('Alt+Shift+Y');
  first();
  occupied.add('Ctrl+K');
  await assert.rejects(alerts.setHotkey('Ctrl+K'), /占用/);
  data.fail = true;
  await assert.rejects(alerts.setHotkey('Ctrl+J'), /disk full/);
  assert.equal(callbacks.get('Alt+Shift+Y'), first);
  assert.deepEqual(data.saved, { hotkey: 'Alt+Shift+Y', bell: false });
  assert.equal(callbacks.has('Ctrl+J'), false);
  data.fail = false;
  await alerts.setHotkey('Ctrl+J');
  assert.equal(callbacks.has('Alt+Shift+Y'), false);
  first(); // A queued activation of a retired key must not show a window.
  callbacks.get('Ctrl+J')();
  await alerts.setHotkey(null);
  assert.equal(alerts.status().registered, false);
  assert.equal(alerts.status().hotkey, null);
  alerts.dispose();
  callbacks.get('Ctrl+X')();
  assert.deepEqual(events, ['Alt+Shift+Y', 'Ctrl+J', 'other']);
});

test('a stored shortcut re-registers on launch; bell notifications are opt-in and throttled across all panes', async () => {
  const { alerts, callbacks, events, data, tick } = fixture({ hotkey: 'Ctrl+Alt+Y', bell: false });
  await alerts.initialize();
  assert.equal(callbacks.has('Ctrl+Alt+Y'), true);
  assert.equal(alerts.bell(), false);
  await alerts.setBell(true);
  assert.equal(alerts.bell(), true);
  assert.equal(alerts.bell(), false);
  tick(9999);
  assert.equal(alerts.bell(), false);
  tick(1);
  assert.equal(alerts.bell(), true);
  await alerts.setBell(false);
  tick(20000);
  assert.equal(alerts.bell(), false);
  assert.deepEqual(data.saved, { hotkey: 'Ctrl+Alt+Y', bell: false });
  assert.deepEqual(events, ['bell', 'bell']);
  alerts.dispose();
  assert.equal(callbacks.size, 0);
});

test('terminal preferences persist independently of toolbox settings', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-terminal-prefs-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const existing = '{"copyShortcut":"Alt+P"}';
  await fs.writeFile(path.join(dir, 'settings.json'), existing);
  const file = preferenceFile(dir);
  assert.deepEqual(await file.read(), {});
  const terminal = { hotkey: 'Ctrl+J', bell: true };
  await file.write(terminal);
  assert.deepEqual(await preferenceFile(dir).read(), terminal);
  assert.equal(await fs.readFile(path.join(dir, 'settings.json'), 'utf8'), existing);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['settings.json', 'terminal-preferences.json']);
});

test('a slow preferences read holds only terminal changes and cannot restore a key after quit', async () => {
  const { promise, resolve } = Promise.withResolvers();
  const { alerts, callbacks } = fixture({}, { read: () => promise });
  const pending = alerts.initialize();
  assert.equal(alerts.status().registered, false);
  const change = alerts.setBell(true);
  resolve({ hotkey: 'Ctrl+J', bell: false });
  await Promise.all([pending, change]);
  assert.equal(callbacks.has('Ctrl+J'), true);
  assert.equal(alerts.status().bell, true);
  const stopped = fixture({ hotkey: 'Ctrl+J', bell: true });
  const quitting = stopped.alerts.initialize();
  stopped.alerts.dispose();
  await quitting;
  assert.equal(stopped.callbacks.size, 0);
});

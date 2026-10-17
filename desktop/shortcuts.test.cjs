'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SHORTCUT, normalizeShortcut, createShortcutManager } = require('./shortcuts.cjs');

function fixture(platform = 'darwin') {
  const bindings = new Map();
  const occupied = new Set();
  let activations = 0;
  const manager = createShortcutManager({ platform, onActivate: () => { activations++; }, globalShortcut: {
    register: (key, callback) => {
      if (occupied.has(key) || bindings.has(key)) return false;
      bindings.set(key, callback); return true;
    },
    unregister: key => bindings.delete(key),
    isRegistered: key => bindings.has(key),
  } });
  return { manager, bindings, occupied, activations: () => activations };
}

test('default accelerator maps to Option+P on macOS and Alt+P on Windows', () => {
  assert.equal(DEFAULT_SHORTCUT, 'Alt+P');
  for (const platform of ['darwin', 'win32']) {
    const f = fixture(platform);
    assert.deepEqual(f.manager.initialize(DEFAULT_SHORTCUT), { supported: true, accelerator: 'Alt+P', registered: true, error: null });
    f.bindings.get('Alt+P')();
    assert.equal(f.activations(), 1);
    f.manager.dispose();
    assert.equal(f.bindings.size, 0);
  }
});

test('only supported key combinations with a non-Shift modifier are accepted', () => {
  assert.equal(normalizeShortcut('Shift+Alt+Ctrl+P'), 'Ctrl+Alt+Shift+P');
  for (const value of ['Alt+F24', 'Super+Space', 'Ctrl+0', 'Alt+PageUp', 'Ctrl+Shift+Left']) assert.equal(normalizeShortcut(value), value);
  for (const value of ['', null, {}, 'P', 'Shift+P', 'Alt', 'Alt+', 'Alt+Alt+P', 'Alt+P+Q', 'Alt+F25', 'Alt+Escape', 'Alt+é', 'Alt+\nP', 'CommandOrControl+P']) {
    assert.throws(() => normalizeShortcut(value), /快捷键|Control/);
  }
});

test('startup conflict is visible and can be retried without losing preferences', () => {
  const f = fixture(); f.occupied.add('Alt+P');
  assert.match(f.manager.initialize('Alt+P').error, /占用/);
  assert.equal(f.manager.status().registered, false);
  f.occupied.clear();
  assert.equal(f.manager.resume().registered, true);
  assert.equal(f.manager.status().error, null);
});

test('startup invalid settings do not crash or bind a different shortcut', () => {
  const f = fixture();
  assert.match(f.manager.initialize('Alt+P+Q').error, /Control/);
  assert.equal(f.bindings.size, 0);
});

test('occupied startup chord does not block saving unrelated preferences', async () => {
  const f = fixture(); f.occupied.add('Alt+P'); f.manager.initialize('Alt+P');
  assert.equal(await f.manager.save('Alt+P', async () => 'format saved'), 'format saved');
  assert.equal(f.manager.status().registered, false);
  assert.match(f.manager.status().error, /占用/);
  f.manager.suspend();
  await assert.rejects(f.manager.save('Alt+P', () => assert.fail('recorded key must register')), /占用/);
});

test('replacement keeps previous key until persistence succeeds, then releases it', async () => {
  const f = fixture(); f.manager.initialize('Alt+P');
  const result = await f.manager.save('Shift+Alt+P', async () => {
    assert.equal(f.bindings.has('Alt+P'), true);
    assert.equal(f.bindings.has('Alt+Shift+P'), true);
    return 'saved';
  });
  assert.equal(result, 'saved');
  assert.deepEqual([...f.bindings.keys()], ['Alt+Shift+P']);
  assert.equal(f.manager.status().accelerator, 'Alt+Shift+P');
});

test('conflicting replacement preserves previous binding and never persists', async () => {
  const f = fixture(); f.manager.initialize('Alt+P'); f.occupied.add('Ctrl+P');
  await assert.rejects(f.manager.save('Ctrl+P', () => assert.fail('must not persist')), /占用/);
  assert.deepEqual([...f.bindings.keys()], ['Alt+P']);
  assert.equal(f.manager.status().accelerator, 'Alt+P');
});

test('failed disk write rolls the OS binding back to the saved setting', async () => {
  const f = fixture(); f.manager.initialize('Alt+P');
  await assert.rejects(f.manager.save('Ctrl+P', async () => { throw new Error('disk full'); }), /disk full/);
  assert.deepEqual([...f.bindings.keys()], ['Alt+P']);
  assert.equal(f.manager.status().accelerator, 'Alt+P');
});

test('recording releases existing chord; cancel restores it and saving same chord works', async () => {
  const f = fixture(); f.manager.initialize('Alt+P');
  assert.equal(f.manager.suspend().registered, false);
  assert.equal(f.bindings.size, 0);
  assert.equal(f.manager.isSuspended(), true);
  assert.equal(f.manager.resume().registered, true);
  assert.equal(f.manager.isSuspended(), false);
  f.manager.suspend();
  await f.manager.save('Alt+P', async () => 'saved');
  assert.equal(f.manager.status().registered, true);
});

test('failed recording replacement restores the temporarily released shortcut', async () => {
  const f = fixture(); f.manager.initialize('Alt+P'); f.manager.suspend();
  f.occupied.add('Ctrl+P');
  await assert.rejects(f.manager.save('Ctrl+P', () => assert.fail('must not persist')), /占用/);
  assert.deepEqual([...f.bindings.keys()], ['Alt+P']);
  assert.equal(f.manager.isSuspended(), false);
});

test('failure to reacquire old chord is reported instead of claiming it is active', async () => {
  const f = fixture(); f.manager.initialize('Alt+P'); f.manager.suspend();
  f.occupied.add('Ctrl+P'); f.occupied.add('Alt+P');
  await assert.rejects(f.manager.save('Ctrl+P', () => assert.fail('must not persist')), /原快捷键暂时无法恢复/);
  assert.equal(f.manager.status().registered, false);
  assert.match(f.manager.status().error, /占用/);
});

test('unsupported platforms never call OS registration but can save other preferences', async () => {
  const f = fixture('linux');
  assert.equal(f.manager.initialize('Alt+P').supported, false);
  assert.equal(await f.manager.save('Alt+P', async () => 'saved'), 'saved');
  await assert.rejects(f.manager.save('Ctrl+P', () => assert.fail('must not persist')), /仅支持/);
  assert.equal(f.bindings.size, 0);
});

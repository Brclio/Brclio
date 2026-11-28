'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { registerUnboundTransfer } = require('./terminal/unbound-transfer.cjs');
const { create } = require('./terminal/sync-partitions.js');
const { store } = require('./terminal/connection.js');
const reader = fs.readFileSync(path.join(__dirname, 'terminal', 'unbound-reader.js'), 'utf8');

function memory() {
  const records = new Map();
  return { getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value), removeItem: key => records.delete(key) };
}
function fixture() {
  const raw = memory();
  store(raw).save({ name: 'guest', host: 'old' });
  raw.setItem('outside', 'preserve');
  const state = { owner: 'A', imported: 0 };
  const locals = new Map();
  const guest = { localStorage: raw, window: { BrclioTerminalPartitions: create(raw) } };
  vm.runInNewContext(reader, guest);
  function select(id) {
    state.owner = id;
    if (!locals.has(id)) {
      const part = create(memory());
      part.activate(id);
      locals.set(id, part);
    }
    const scope = { window: { BrclioTerminalPartitions: locals.get(id) } };
    state.origin = { webContents: {
      session: 'partition-' + id, isDestroyed: () => false,
      async executeJavaScript(code) {
        const result = vm.runInNewContext(code, scope);
        state.imported++;
        state.afterCopy?.();
        return result;
      },
    } };
  }
  select('A');
  class GuestView {
    constructor(options) {
      assert.equal(options.webPreferences.partition, 'persist:brclio-terminal');
      this.webContents = {
        session: 'guest', setWindowOpenHandler() {}, on() {}, async loadFile() {}, close() {}, isDestroyed: () => false,
        async executeJavaScript(code) { return vm.runInNewContext(code, guest); },
      };
    }
  }
  registerUnboundTransfer({
    handle(channel, fn) { assert.equal(channel, 'unbound-transfer'); state.request = fn; },
    WebContentsView: GuestView, getOwner: () => null, getView: () => state.origin, viewUserId: () => state.owner,
    localUser: async () => ({ id: state.owner }),
    dialog: { async showMessageBox() { state.whileConfirming?.(); return { response: 1 }; } },
  });
  return { state, raw, select, hosts: id => store(locals.get(id).storage).all() };
}

test('switching during confirmation aborts before any guest data reaches the account', async () => {
  const { state, select, raw, hosts } = fixture();
  state.whileConfirming = () => select('B');
  await assert.rejects(state.request('move', 'A'), /账号已变化/);
  assert.equal(state.imported, 0);
  assert.deepEqual(hosts('B'), []);
  assert.equal(store(raw).all().length, 1);
});

test('switch after destination commit reserves guest data to intended recipient, and retry consumes it exactly once', async () => {
  const { state, select, raw, hosts } = fixture();
  state.afterCopy = () => { state.afterCopy = null; select('B'); };
  await assert.rejects(state.request('move', 'A'), /账号已变化/);
  assert.equal((await state.request('available', 'B')).available, false);
  assert.deepEqual(hosts('B'), []);
  assert.equal(hosts('A').length, 1);
  select('A');
  assert.deepEqual(await state.request('move', 'A'), { moved: true });
  assert.equal(hosts('A').length, 1);
  assert.equal(store(raw).all().length, 0);
  assert.equal(raw.getItem('outside'), 'preserve');
});

test('source change during copy leaves all guest keys intact', async () => {
  const { state, raw, hosts } = fixture();
  state.afterCopy = () => { state.afterCopy = null; store(raw).save({ name: 'later', host: 'new' }); };
  await assert.rejects(state.request('move', 'A'), /迁移期间发生变化/);
  assert.deepEqual(store(raw).all().map(item => item.name), ['guest', 'later']);
  assert.deepEqual(hosts('A').map(item => item.name), ['guest']);
  await state.request('move', 'A');
  assert.deepEqual(hosts('A').map(item => item.name), ['guest', 'later']);
  assert.deepEqual(store(raw).all(), []);
});

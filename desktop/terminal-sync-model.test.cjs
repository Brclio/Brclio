'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('./terminal/sync-partitions.js');
const models = require('./terminal/sync-model.js');
const { store } = require('./terminal/connection.js');
const forwards = require('./terminal/forward-model.js');

function memory() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
const host = (name, address = name) => ({ name, host: address, user: 'test', port: null });
const data = (...records) => models.portable({ hosts: records, forwards: [] });

test('three-way sync merges independent edits and deletions, then asks before resolving same-name edits or delete versus edit', () => {
  const base = data(host('remove'), host('shared'), host('gone'));
  const local = data(host('mine'), host('shared', 'local'), host('gone', 'edited'));
  const cloud = data(host('theirs'), host('shared', 'remote'), host('remove'));
  const pending = models.merge(base, local, cloud);
  assert.deepEqual(pending.conflicts.map(x => x.name).sort(), ['gone', 'shared']);
  assert.deepEqual(pending.data.hosts.map(x => x.name), ['mine', 'theirs']);
  const choices = Object.fromEntries(pending.conflicts.map(x => [x.id, x.name === 'gone' ? 'cloud' : 'device']));
  const resolved = models.merge(base, local, cloud, choices);
  assert.deepEqual(resolved.conflicts, []);
  assert.deepEqual(resolved.data, data(host('mine'), host('shared', 'local'), host('theirs')));
});

test('cloud snapshot omits secret fields, session history and local identity paths; applying never reassigns an identity to another endpoint', () => {
  const raw = memory(), hosts = store(raw), rules = forwards.store(raw);
  hosts.save({ ...host('fixture'), jump: 'gate', identityFile: '/fixture/key', certificateFile: '/fixture/test.pub', agentForwarding: true, key: 'secret', password: 'secret', favorite: true });
  hosts.recordUse('ssh', host('history'));
  rules.save({ name: 'proxy', type: 'dynamic', listenHost: '127.0.0.1', listenPort: 8765,
    connection: { host: 'gate', identityFile: '~/.ssh/test', secret: 'hidden' } });
  const lib = models.localLibraries(raw);
  const snapshot = lib.read();
  assert.doesNotMatch(JSON.stringify(snapshot), /key|~\/|secret|history|hidden|certificateFile|agentForwarding/);
  assert.equal(snapshot.hosts[0].jump, 'gate');
  snapshot.hosts[0].group = 'test';
  lib.apply(snapshot);
  assert.equal(hosts.all()[0].identityFile, '/fixture/key');
  assert.equal(hosts.all()[0].certificateFile, '/fixture/test.pub');
  assert.equal(hosts.all()[0].agentForwarding, true);
  assert.equal(rules.all()[0].connection.identityFile, '~/.ssh/test');
  snapshot.hosts[0].host = 'other';
  lib.apply(snapshot);
  assert.equal(hosts.all()[0].identityFile, undefined);
  assert.equal(hosts.all()[0].certificateFile, undefined);
  assert.equal(hosts.all()[0].agentForwarding, undefined);
  assert.equal(hosts.recents()[0].host, 'history');
});

test('local-only account partitions isolate saved/unsaved recent endpoints, colliding host names, identities and forward templates across login, logout, reload', () => {
  const raw = memory();
  const partition = create(raw), a = store(partition.storage);
  assert.deepEqual(a.all(), []);
  assert.throws(() => a.save(host('pending')));
  partition.activate(null);
  a.save(host('guest'));
  partition.activate('Alice');
  assert.deepEqual(a.all(), []);
  a.save(host('same', 'alice-server'));
  a.recordUse('ssh', host('same', 'alice-server'), 'same');
  a.recordUse('ssh', host('alice-unnamed'));
  partition.storage.setItem('brclio.terminal.local-identities.v1', '[{"name":"Alice"}]');
  partition.storage.setItem('brclio.terminal.port-forwards.v1', '[{"name":"Alice"}]');
  partition.lock();
  assert.deepEqual(a.recents(), []);
  partition.activate('Bob');
  assert.deepEqual(a.all(), []);
  a.save(host('same', 'bob-server'));
  assert.deepEqual(a.recents(), []);
  assert.equal(partition.storage.getItem('brclio.terminal.local-identities.v1'), null);
  assert.equal(partition.storage.getItem('brclio.terminal.port-forwards.v1'), null);
  partition.activate(null);
  assert.deepEqual(a.all(), [host('guest')]);
  const later = create(raw);
  assert.equal(later.storage.getItem('brclio.terminal.host-library.v2'), null);
  later.activate('Alice');
  assert.deepEqual(store(later.storage).all(), [host('same', 'alice-server')]);
  assert.equal(store(later.storage).recents().length, 2);
});

test('unassociated data moves expressly to current user, preserving account-side duplicates and both recent histories', () => {
  const raw = memory(), p = create(raw), records = store(p.storage);
  p.activate(null);
  records.save(host('shared', 'guest'));
  records.recordUse('ssh', host('shared', 'guest'), 'shared');
  p.activate('A');
  records.save(host('shared', 'private'));
  records.recordUse('ssh', host('A-history'));
  assert.equal(p.hasUnbound(), true);
  assert.deepEqual(records.all(), [host('shared', 'private')]);
  p.moveUnbound();
  assert.deepEqual(records.all(), [host('shared', 'private'), host('shared (本机 1)', 'guest')]);
  assert.deepEqual(records.recents().map(r => r.name || r.host), ['A-history', 'shared (本机 1)']);
  assert.equal(p.hasUnbound(), false);
  p.activate('B');
  assert.equal(records.all().length, 0);
  assert.equal(records.recents().length, 0);
  p.activate(null);
  assert.equal(records.all().length, 0);
  assert.throws(() => p.moveUnbound());
});

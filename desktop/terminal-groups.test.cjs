'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const connections = require('./terminal/connection.js');
const { create } = require('./terminal/sync-partitions.js');
const sync = require('./terminal/sync-model.js');
const ssh = require('./terminal/remote-launch.cjs');

function fixture() {
  const map = new Map();
  const partitions = create({ getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) });
  partitions.activate(null);
  return { partitions, bank: connections.store(partitions.storage), sync: sync.localLibraries(partitions.storage) };
}

const savedHost = { name: 'web', host: 'server.invalid', group: 'Work/Test', inheritGroup: true };

test('nearest group and explicit host fields win; old hosts and quick connects retain their SSH defaults', () => {
  const { bank } = fixture();
  bank.saveGroup({ group: 'Work', user: 'parent', port: 2200, jump: 'bastion', environment: 'FIRST=top\nLEVEL=work', identityFile: '/private/fixture', agentForwarding: true });
  bank.saveGroup({ group: 'Work/Test', user: 'child', environment: 'LEVEL=subgroup\nEMPTY=' });
  bank.save({ ...savedHost, port: 2222, environment: 'LEVEL=host' });
  assert.deepEqual(bank.resolve(bank.all()[0]), { host: 'server.invalid', user: 'child', port: 2222, jump: 'bastion',
    environment: connections.environment('FIRST=top\nLEVEL=host\nEMPTY=') });
  assert.deepEqual(ssh.argumentsFor('sftp', bank.resolve(bank.all()[0])), ['-J', 'bastion', '-P', '2222', '-o', 'User=child', '--', 'server.invalid']);
  for (const value of [{ ...savedHost, inheritGroup: false }, { host: savedHost.host }]) {
    assert.deepEqual(bank.resolve(value), { host: savedHost.host, user: '', port: null });
  }
  bank.removeGroup('Work/Test');
  assert.equal(bank.resolve(bank.all()[0]).user, 'parent');
  assert.deepEqual(bank.groupConfigs().map(x => x.group), ['Work']);
  assert.throws(() => bank.saveGroup({ group: 'a//b' }));
});

test('group route changes clear host-bound credentials; imports and account switching never attach another account’s settings', () => {
  const { partitions, bank, sync: libraries } = fixture();
  partitions.activate('A');
  bank.saveGroup({ group: 'Work', user: 'first', environment: 'GROUP_SECRET=local' });
  bank.save({ ...savedHost, identityFile: '/key', certificateFile: '/cert', agentForwarding: true, environment: 'HOST_SECRET=local' });
  bank.recordUse('ssh', bank.resolve(bank.all()[0]), 'web');
  assert.equal(bank.recents()[0].environment, undefined);
  assert.doesNotMatch(JSON.stringify(libraries.read()), /SECRET|inheritGroup|identityFile|certificateFile|agentForwarding/);
  libraries.apply({ hosts: [{ ...savedHost, host: 'server.invalid', tags: ['edited'] }], forwards: [] });
  assert.equal(bank.resolve(bank.all()[0]).user, 'first');
  assert.equal(bank.all()[0].agentForwarding, true);
  bank.saveGroup({ group: 'Work', user: 'second' });
  for (const key of ['identityFile','certificateFile','agentForwarding','environment']) assert.equal(bank.all()[0][key], undefined);
  assert.deepEqual(bank.recents(), []);
  libraries.apply({ hosts: [{ ...savedHost, host: 'other.invalid' }], forwards: [] });
  assert.equal(bank.resolve(bank.all()[0]).user, '');
  partitions.activate('B');
  assert.deepEqual(bank.groupConfigs(), []);
  assert.deepEqual(bank.all(), []);
});

test('moving guest data keeps colliding group trees and their routes separate, including empty groups', () => {
  const { bank, partitions } = fixture();
  bank.saveGroup({ group: 'Work', port: 1000 });
  assert.equal(partitions.hasUnbound(), true);
  bank.save(savedHost);
  partitions.activate('A');
  bank.saveGroup({ group: 'Work', port: 2000 });
  bank.save({ ...savedHost, name: 'account' });
  partitions.moveUnbound();
  assert.deepEqual(bank.all().map(host => [host.name, bank.resolve(host).port]), [['account', 2000], ['web', 1000]]);
  assert.equal(bank.groupConfigs().length, 2);
  assert.equal(partitions.hasUnbound(), false);
});

test('native OpenSSH parses literal SSH variables and keeps the local process environment intact', t => {
  const file = ssh.program('ssh');
  if (!file) return t.skip('No system OpenSSH');
  const env = { ...process.env };
  const before = { ...env };
  const literal = 'with spaces, 中文, "quotes", slash \\ # $HOME ${HOME} %h; $(echo TEXT)';
  const target = { host: 'fixture.invalid', environment: [{ name: 'BRCLIO_FIXTURE', value: literal }, { name: 'PATH', value: 'only remote' }] };
  const args = ssh.argumentsFor('ssh', target, true, { file, env });
  const check = spawnSync(file, ['-G', '-F', 'none', ...args], { env, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(check.status, 0, check.stderr);
  assert.ok(check.stdout.includes('BRCLIO_FIXTURE=' + literal), check.stdout.split('\n').filter(line => line.includes('BRCLIO_FIXTURE')).join('\n'));
  assert.ok(check.stdout.includes('PATH=only remote'));
  // Unlike process.env on Windows, the plain object passed to the child keeps
  // the original key casing (commonly "Path"). Check every original key.
  for (const [name, value] of Object.entries(before)) assert.equal(env[name], value, name);
  assert.deepEqual(Object.keys(env).filter(name => !Object.hasOwn(before, name) && name !== 'BRCLIO_SSH_LITERAL_DOLLAR'), []);
  assert.equal(ssh.argumentsFor('ssh', target, false).includes('-o'), false);
  assert.equal(ssh.argumentsFor('sftp', target).includes('-o'), false);
  for (const invalid of ['EMPTY', '=one', 'A=1\nA=2', 'X=y\rBad', 'X-Y=z', 'A=\0x']) assert.throws(() => connections.environment(invalid));
});

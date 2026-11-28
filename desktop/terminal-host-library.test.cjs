'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { endpoint, quick, format, store, select, groups } = require('./terminal/connection.js');
const { argumentsFor } = require('./terminal/remote-launch.cjs');

function storageFixture(records = []) {
  const saved = new Map([['brclio.terminal.connections.v1', JSON.stringify(records)]]);
  return { saved, ...store({ getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) }) };
}

test('quick connect handles shell aliases, SSH/SFTP URLs, IPv6 zone IDs and explicit ports', () => {
  assert.deepEqual(quick('dev'), { protocol: 'ssh', host: 'dev', user: '', port: null });
  assert.deepEqual(quick('sftp://worker@[fe80::1%25en0]:2224/'),
    { protocol: 'sftp', host: 'fe80::1%en0', user: 'worker', port: 2224 });
  assert.equal(format(quick('user@example.org@build.local:2400')), 'user@example.org@build.local:2400');
  assert.equal(quick('::1').host, '::1');
  for (const target of ['ssh://me:pw@host', 'sftp://host/file', 'ftp://host', 'host:65536', '-oProxyCommand=id',
    'user@host;noop', '@host', 'host:', 'user@[::1]:', 'ssh://host?password=x', 'a\nb']) assert.throws(() => quick(target), target);
});

test('multi-hop jump chains and named identities are passed as validated native arguments for both system clients', () => {
  const target = { host: 'prod', jump: 'alice@host:2200, [::1]:2222', identityFile: '/Users/demo/my key' };
  for (const kind of ['ssh', 'sftp']) {
    assert.deepEqual(argumentsFor(kind, target), ['-J', 'alice@host:2200,[::1]:2222', '-i', '/Users/demo/my key', ...(kind === 'ssh' ? ['-a'] : []), '--', 'prod']);
  }
  assert.equal(endpoint({ host: 'alias', identityFile: 'C:\\work\\my key' }).identityFile, 'C:\\work\\my key');
  for (const jump of ['-oProxyCommand=x', 'host,,other', 'host:22;noop', 'a,b,c,d,e,f,g,h,i']) {
    assert.throws(() => endpoint({ host: 'alias', jump }));
  }
  for (const identityFile of ['-p 2222', 'relative/path', '/file\nother', '\\\\remote\\share\\file']) {
    assert.throws(() => endpoint({ host: 'alias', identityFile }));
  }
});

test('interactive SSH permits per-host agent forwarding and a separately selected certificate', () => {
  const value = { host: 'example', certificateFile: 'C:\\user keys\\example-cert.pub', agentForwarding: true };
  const cert = 'CertificateFile="C:/user keys/example-cert.pub"';
  assert.deepEqual(argumentsFor('ssh', value), ['-A', '-o', cert, '--', 'example']);
  assert.deepEqual(argumentsFor('ssh', { ...value, agentForwarding: false }), ['-a', '-o', cert, '--', 'example']);
  assert.deepEqual(argumentsFor('ssh', value, false), ['-a', '--', 'example']);
  assert.deepEqual(argumentsFor('sftp', value), ['--', 'example']);
  for (const certificateFile of ['relative/name', 'C:\\key\nother', '/keys/${HOME}', '-o Option=yes']) {
    assert.throws(() => endpoint({ ...value, certificateFile }));
  }
  assert.throws(() => endpoint({ ...value, agentForwarding: 'yes' }));
});

test('legacy hosts survive their first edit; rename and removal update related recent records and reject collisions', () => {
  const data = storageFixture([{ name: 'old', host: 'legacy' }]);
  assert.deepEqual(data.all(), [{ name: 'old', host: 'legacy', port: null, user: '' }]);
  data.recordUse('ssh', data.all()[0], 'old');
  const time = data.recents()[0].openedAt;
  const updated = data.save({ ...data.all()[0], name: 'new', group: 'work / prod', tags: 'API，build', favorite: true }, 'old');
  assert.deepEqual(data.all(), [updated]);
  assert.deepEqual(data.recents(), [{ kind: 'ssh', name: 'new', host: 'legacy', user: '', port: null, openedAt: time }]);
  assert.equal(updated.group, 'work/prod');
  data.save({ name: 'other', host: 'other' }, null);
  assert.throws(() => data.save({ ...updated, name: 'other' }, 'new'));
  assert.throws(() => data.save(updated, null));
  assert.equal(data.all().length, 2);
  data.remove('new');
  assert.equal(data.all()[0].name, 'other');
  assert.equal(data.recents().length, 0);
  assert.ok(data.saved.has('brclio.terminal.connections.v1'));
});

test('search is case-insensitive across fields, filters include nested groups, and favorites sort first', () => {
  const data = storageFixture();
  data.save({ name: 'Web', host: 'example', group: 'Work/Prod', tags: ['API', 'API', 'Remote'] });
  data.save({ name: 'Web 2', host: 'other', group: 'Work', favorite: true });
  data.save({ name: 'Home', host: 'home', group: 'Homework' });
  assert.deepEqual(groups(data.all()), ['Homework', 'Work', 'Work/Prod']);
  assert.deepEqual(select(data.all(), { group: 'Work' }).map(x => x.name), ['Web 2', 'Web']);
  assert.deepEqual(select(data.all(), { search: 'API example' }).map(x => x.tags), [['API', 'Remote']]);
  assert.deepEqual(select(data.all(), { favorites: true }).map(x => x.name), ['Web 2']);
});

test('recent launches deduplicate and stay bounded, unused fields and credentials never enter storage', () => {
  const data = storageFixture();
  for (let i = 0; i < 25; i++) data.recordUse('ssh', { host: 'host-' + i, password: 'SECRET', command: 'SECRET' });
  data.recordUse('ssh', { host: 'host-3' });
  data.recordUse('sftp', { host: 'host-3' });
  assert.equal(data.recents().length, 24);
  assert.equal(data.recents()[0].kind, 'sftp');
  assert.equal(data.recents()[1].host, 'host-3');
  assert.ok(!data.recents().some(x => x.host === 'host-0'));
  assert.doesNotMatch([...data.saved.values()].join(' '), /SECRET/);
  data.clearRecent();
  assert.deepEqual(data.recents(), []);
});

test('recent launch times survive reopening and renaming, old records retain unknown times, and replacing the destination drops its history', () => {
  const data = storageFixture();
  const key = 'brclio.terminal.host-library.v2';
  const host = { name: 'dev', host: 'dev.example', user: 'dev', port: 2201 };
  data.saved.set(key, JSON.stringify({ hosts: [host], recent: [{ ...host, kind: 'ssh' }] }));
  assert.equal(data.recents()[0].openedAt, undefined);
  const before = Date.now();
  data.recordUse('ssh', host, host.name);
  const recorded = data.recents()[0].openedAt;
  assert.ok(recorded >= before && recorded <= Date.now());
  const renamed = data.save({ ...host, name: 'new name' }, host.name);
  assert.equal(store({ getItem: k => data.saved.get(k) }).recents()[0].openedAt, recorded);
  const edited = data.save({ ...renamed, host: 'edit.example' });
  assert.deepEqual(data.recents(), []);
  data.recordUse('ssh', edited, edited.name);
  data.replace([{ ...edited, host: 'new.example' }]);
  assert.deepEqual(data.recents(), []);
});

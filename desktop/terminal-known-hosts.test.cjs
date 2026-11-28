'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, createHmac, randomBytes, generateKeyPairSync } = require('node:crypto');
const { createKnownHosts, lookupName } = require('./terminal/known-hosts.cjs');

function publicKey() {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const type = Buffer.from('ssh-ed25519');
  const size = n => { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(n); return buffer; };
  const key = Buffer.concat([size(type.length), type, size(raw.length), raw]);
  return { field: 'ssh-ed25519 ' + key.toString('base64'),
    fingerprint: 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '') };
}

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(),'brclio-known-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home,'.ssh'));
  return { home, file: path.join(home, '.ssh', 'known_hosts') };
}

test('explicit known-host lookup resolves exact, hashed, wildcard and marked public keys for the requested host', async t => {
  const { home, file } = await fixture(t);
  const known = createKnownHosts({ home, confirm: async () => true });
  const target = { host: 'build.example' };
  assert.deepEqual(await known.list(target), []);
  const key = publicKey(), other = publicKey();
  const salt = randomBytes(20);
  const hashed = '|1|' + salt.toString('base64') + '|' + createHmac('sha1',salt).update('build.example').digest('base64');
  const lines = [
    '# own notes', 'BUILD.example ' + key.field, hashed + ' ' + key.field, '@cert-authority *.example ' + key.field,
    '@revoked build.example ' + key.field, 'build.example,shared.example ' + key.field, 'staging.example ' + other.field,
    '*.example,!build.example ' + other.field, '[build.example]:2222 ' + other.field,
  ];
  await fs.writeFile(file, lines.join('\r\n') + '\r\n', { mode: 0o600 });
  const results = await known.list(target);
  assert.equal(results.length, 5);
  assert.ok(results.every(item => item.fingerprint === key.fingerprint));
  assert.deepEqual(results.map(item => item.removable), [true, true, false, false, false]);
  assert.deepEqual((await known.list({ host: 'build.example', port: 2222 })).map(item => item.fingerprint), [other.fingerprint]);
  assert.equal(lookupName({host:'[::1]',port:22}), '::1');
  assert.equal(lookupName({host:'[::1]',port:4444}), '[::1]:4444');
  await assert.rejects(known.remove(target, results[2].id));
  assert.equal(await known.remove(target, results[1].id), true);
  assert.equal(await fs.readFile(file,'utf8'), lines.filter(line => !line.startsWith('|1|')).join('\r\n') + '\r\n');
});

test('known-host removal requires confirmation, re-reads changed data and keeps concurrent unrelated records', async t => {
  const { home, file } = await fixture(t);
  const key = publicKey(), target = { host: 'one.test' };
  const line = 'one.test ' + key.field + '\n';
  const extra = 'other.test ' + publicKey().field + '\n';
  await fs.writeFile(file, line);
  let consent = false, called = 0;
  const known = createKnownHosts({ home, confirm: async () => { called++; if (consent) await fs.appendFile(file, extra); return consent; } });
  const [{ id }] = await known.list(target);
  assert.equal(await known.remove(target, id), false);
  assert.equal(await fs.readFile(file,'utf8'), line);
  consent = true;
  assert.equal(await known.remove(target, id), true);
  assert.equal(await fs.readFile(file,'utf8'), extra);
  await assert.rejects(known.remove(target,id));
  assert.equal(called, 2);
});

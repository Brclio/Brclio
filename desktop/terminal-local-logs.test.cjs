'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { registerLogs } = require('./terminal/local-logs.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-log-fixture-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), bytes]);
    },
    decryptString(bytes) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0,12));
      decipher.setAuthTag(bytes.subarray(12,28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString();
    },
  };
  let user = 'alice', action;
  const create = () => registerLogs({ handle: (_, fn) => { action = fn; }, owner: async () => user,
    directory, storage, target: pane => pane === 'present' ? { profile: 'ssh' } : null });
  let logs = create();
  t.after(() => logs.reset());
  return { directory, storage, run: (...args) => action(...args),
    switch(userId) { logs.reset(); user = userId; }, observe: (...args) => logs.observe(...args),
    restart() { logs.reset(); logs = create(); }, reset: () => logs.reset() };
}

test('manual recording captures only selected pane output, persists bookmarks and isolates owners', async t => {
  const f = await fixture(t);
  f.observe('data', { id: 'present', data: 'before opt in' });
  assert.deepEqual((await f.run('list')).logs, []);
  await assert.rejects(f.run('start', { name: 'test', pane: 'gone' }), /窗格/);
  const { active: id } = await f.run('start', { pane: 'present', name: 'fixture session' });
  f.observe('data', { id: 'other', data: 'other output' });
  f.observe('input', { id: 'present', data: 'typed-secret' });
  f.observe('data', { id: 'present', data: '\x1b[31mHEL' });
  f.observe('data', { id: 'present', data: 'LO\x1b[0m\r\n' });
  await f.run('bookmark', { id, label: 'checkpoint' });
  f.observe('data', { id: 'present', data: '第二行' });
  f.observe('exit', { id: 'present' });
  assert.equal((await f.run('status')).active, null);
  f.restart();
  const stored = await f.run('read', { id });
  assert.equal(stored.text, 'HELLO\n第二行');
  assert.deepEqual(stored.bookmarks, [{ label: 'checkpoint', offset: 6 }]);
  const subdir = (await fs.readdir(path.join(f.directory, 'terminal-logs')))[0];
  assert.ok(!(await fs.readFile(path.join(f.directory, 'terminal-logs', subdir, id))).includes(Buffer.from('HELLO')));
  f.switch('bob');
  assert.deepEqual((await f.run('list')).logs, []);
  await assert.rejects(f.run('read', { id }));
  await f.run('clear');
  f.switch('alice');
  assert.equal((await f.run('list')).logs.length, 1);
  f.switch(null);
  await assert.rejects(f.run('list'), /登录/);
});

test('limits disk use, refuses unencrypted logs and invalidates stale account operations', async t => {
  const f = await fixture(t);
  f.storage.isEncryptionAvailable = () => false;
  await assert.rejects(f.run('start', { pane: 'present', name: 'quota' }), /加密/);
  f.storage.isEncryptionAvailable = () => true;
  const { active: id } = await f.run('start', { pane: 'present', name: 'quota' });
  f.observe('data', { id: 'present', data: '汉'.repeat(110000) });
  const full = await f.run('read', { id });
  assert.ok(full.full); assert.ok(Buffer.byteLength(full.text) <= 256 * 1024);
  assert.ok(!full.text.includes('\ufffd'));
  assert.equal((await f.run('status')).active, null);
  for (let i = 0; i < 15; i++) {
    await f.run('start', { pane: 'present', name: String(i) });
    await f.run('stop');
  }
  await assert.rejects(f.run('start', { pane: 'present', name: 'over' }), /16/);
  const stale = f.run('clear');
  f.switch('bob');
  await assert.rejects(stale, /切换/);
  f.switch('alice');
  assert.equal((await f.run('list')).logs.length, 16);
  await f.run('delete', { id });
  await f.run('clear');
  assert.deepEqual((await f.run('list')).logs, []);
});

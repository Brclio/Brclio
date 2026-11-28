'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { createTerminalVault } = require('./terminal/vault.cjs');

function mockStorage() {
  const key = randomBytes(32);
  const counts = { unlock: 0, decrypt: 0 };
  return { counts,
    async isAsyncEncryptionAvailable() { counts.unlock++; return true; },
    async encryptStringAsync(text) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    async decryptStringAsync(buffer) {
      counts.decrypt++;
      const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
      decipher.setAuthTag(buffer.subarray(12, 28));
      return { result: Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8') };
    },
  };
}

test('terminal vault unlocks on user action and releases only one confirmed synthetic entry to its recipient', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-vault-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const storage = mockStorage();
  const create = () => createTerminalVault({ platform: 'darwin', directory, storage });
  const vault = create();
  assert.equal(storage.counts.unlock, 0);
  assert.deepEqual(await fs.readdir(directory), []);
  assert.deepEqual(await vault.list(), []);
  assert.deepEqual(await fs.readdir(directory), []);
  const username = 'Synthetic fixture name';
  const generated = randomBytes(24).toString('hex');
  const item = await vault.add(username, generated);
  assert.deepEqual(Object.keys(item).sort(), ['id', 'name']);
  const filename = path.join(directory, 'terminal-passwords.v1.json');
  const file = await fs.readFile(filename, 'utf8');
  assert.ok(!file.includes(generated) && !file.includes(username));
  if (process.platform !== 'win32') assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  assert.deepEqual(await create().list(), [item]);
  const before = storage.counts.decrypt;
  assert.deepEqual(await vault.fill(item.id, () => false, () => assert.fail()), { filled: false });
  assert.equal(storage.counts.decrypt, before + 1, 'cancel decrypts only the display label');
  const received = [];
  assert.deepEqual(await vault.fill(item.id, name => name === username, value => { received.push(value); }), { filled: true });
  assert.deepEqual(received, [generated]);
  await vault.update(item.id, 'Updated fixture', '');
  assert.deepEqual(await vault.list(), [{ id: item.id, name: 'Updated fixture' }]);
  await vault.fill(item.id, () => true, value => assert.equal(value, generated));
  const replacement = randomBytes(24).toString('hex');
  await vault.update(item.id, '', replacement);
  await vault.fill(item.id, () => true, value => assert.equal(value, replacement));
  await assert.rejects(vault.add('name', 'fixture\rnew-command'), /单行/);
  await assert.rejects(vault.add('name', 'fixture\u001b'), /单行/);
  await vault.remove(item.id);
  assert.deepEqual(await vault.list(), []);
  await assert.rejects(vault.fill(item.id, () => true, () => assert.fail()), /选择/);
});

test('unavailable OS protection or a damaged vault never falls back to plaintext storage', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-vault-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const platform of ['linux', 'win32']) {
    const storage = { isAsyncEncryptionAvailable: async () => false, encryptStringAsync: () => assert.fail() };
    const vault = createTerminalVault({ platform, directory, storage });
    await assert.rejects(vault.add('synthetic', 'generated'), /不可用/);
    assert.deepEqual(await fs.readdir(directory), []);
  }
  const file = path.join(directory, 'terminal-passwords.v1.json');
  await fs.writeFile(file, '{broken');
  const vault = createTerminalVault({ platform: 'darwin', directory, storage: mockStorage() });
  await assert.rejects(vault.add('synthetic', 'generated'), /原文件/);
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});

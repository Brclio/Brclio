'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const { store } = require('./terminal/identity-model.js');
const { register, keygen, publicPart } = require('./terminal/identity-host.cjs');
const { createPtySessions } = require('./terminal/pty.cjs');
const run = promisify(execFile);

test('local SSH identity presets persist only name, user and path, and reject accidental replacement', () => {
  const data = new Map();
  const presets = store({ getItem: key => data.get(key), setItem: (key, value) => data.set(key,value) });
  const value = { name: 'workspace', user: 'dev', path: '~/.ssh/id_ed25519', key: 'discard', passphrase: 'discard' };
  presets.save(value);
  assert.deepEqual(presets.all(), [{ name: 'workspace', user: 'dev', path: '~/.ssh/id_ed25519' }]);
  assert.throws(() => presets.save(value));
  assert.throws(() => presets.save({ ...value, path: 'relative-key' }, value.name));
  presets.save({ ...value, name: 'renamed' }, value.name);
  presets.remove('renamed');
  assert.deepEqual(presets.all(), []);
});

test('native save picker issues one-use grants, refuses existing files and does not accept renderer-selected write paths', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(),'brclio-identity-grant-'));
  t.after(() => fs.rm(home,{ recursive: true, force: true }));
  const file = path.join(home,'new key');
  const handlers = new Map();
  const original = { id:'original', profile:'default' };
  const host = register({ handle: (name, handler) => handlers.set(name, handler), getOwner: () => null, home,
    dialog: { showSaveDialog: async () => ({ canceled:false,filePath:file }), showOpenDialog: async () => ({ canceled:true }) } });
  assert.equal(host.prepare(original),original);
  assert.equal(await handlers.get('identity-choose')('existing'), null);
  assert.throws(() => host.prepare({ profile:'ssh-keygen', connection: { keyPath:file } }));
  const grant = await handlers.get('identity-choose')('generate');
  const input = { profile:'ssh-keygen', connection: { token:grant.token, keyPath:'other' } };
  assert.deepEqual(host.prepare(input).connection, { keyPath:file });
  assert.throws(() => host.prepare(input));
  await fs.writeFile(file + '.pub','existing');
  await assert.rejects(handlers.get('identity-choose')('generate'));
  await assert.rejects(publicPart(file), /公钥/);
});

test('system ssh-keygen in a real PTY generates a protected Ed25519 key and identity metadata exposes only its public companion', { timeout: 20000 }, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(),'brclio-identity-keygen-'));
  t.after(() => fs.rm(home,{ recursive: true, force: true }));
  const file = path.join(home,'key with spaces');
  let binary;
  try { binary = keygen({ keyPath:file },process.platform,process.env).file; }
  catch (error) { if (/未找到/.test(error.message)) return t.skip('OpenSSH keygen unavailable'); throw error; }
  const id = randomUUID(), passphrase = 'test-only-' + randomUUID();
  let stage = 0, output = '', onExit;
  const exited = new Promise(resolve => { onExit = resolve; });
  const sessions = createPtySessions({ home, env: { ...process.env, LC_ALL:'C', LANG:'C' }, send(kind,payload) {
    if (kind === 'exit') return onExit(payload);
    output += payload.data;
    sessions.ack(id,payload.data.length);
    const text = output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
    const ask = stage === 0 ? /enter passphrase/i : /enter same passphrase/i;
    if (stage < 2 && ask.test(text)) {
      stage++;
      output = '';
      sessions.write(id,passphrase + '\r');
    }
  } });
  t.after(() => sessions.closeAll());
  sessions.create({ id, profile:'ssh-keygen', connection:{ keyPath:file } });
  const result = await exited;
  assert.equal(result.exitCode,0);
  assert.equal(stage,2);
  assert.doesNotMatch(output, new RegExp(passphrase));
  const pub = await publicPart(file);
  const decoded = Buffer.from(pub.text.split(' ')[1],'base64');
  assert.equal(pub.fingerprint,'SHA256:' + createHash('sha256').update(decoded).digest('base64').replace(/=+$/,''));
  const derived = await run(binary, ['-y','-P',passphrase,'-f',file], { timeout: 5000, windowsHide: true });
  assert.ok(derived.stdout.startsWith(pub.text));
  await assert.rejects(run(binary,['-y','-P','wrong','-f',file], { timeout: 5000, windowsHide: true }));
  assert.throws(() => keygen({ keyPath:file },process.platform,process.env), /已存在/);
});

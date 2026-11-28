'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {localIdentity, syncAccount} = require('./terminal/sync-account.cjs');

test('offline identity belongs to the exact verified login and expires locally at logout or token replacement', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-binding-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  let token = null;
  const store = { read: async () => token };
  const binding = localIdentity(dir,store);
  assert.deepEqual(await binding.current(), {known:true,user:null});
  token = 'synthetic-token-alice';
  assert.equal((await binding.current()).known,false);
  const user = {id:'uid-a',email:'alice@example.test'};
  await binding.verify(async () => ({user}));
  assert.deepEqual(await localIdentity(dir,store).current(),{known:true,user});
  assert.equal((await fs.readFile(path.join(dir,'terminal-account-binding.json'),'utf8')).includes(token),false);
  token = 'synthetic-token-bob';
  assert.equal((await binding.current()).known,false);
  await assert.rejects(binding.verify(async () => { token = null; return {user}; }), /账号已变化/);
  assert.deepEqual(await binding.current(),{known:true,user:null});
});

test('terminal IPC cannot read a record for a different account or invoke a caller-provided route', async () => {
  await assert.rejects(syncAccount(async () => ({userId:'uid-b'}),'read',{expectedUserId:'uid-a'}),/账号已变化/);
  await assert.rejects(syncAccount(async () => assert.fail(),'/api/account/login',{expectedUserId:'uid-a'}),/未知/);
  await assert.rejects(syncAccount(async () => assert.fail(),'read',{expectedUserId:'../test'}),/确认/);
});

'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {terminalLock} = require('./terminal/terminal-lock.cjs');
const active = () => true;
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'brclio-pin-'));
  t.after(() => fs.rm(directory,{force:true,recursive:true}));
  const secureStorage = () => ({isAsyncEncryptionAvailable:async () => true,
    encryptStringAsync:async text => Buffer.from(text), decryptStringAsync:async blob => ({result:blob.toString()})});
  let time = 100000;
  const create = (biometrics = () => ({available:() => false})) => terminalLock({directory,secureStorage,biometrics,now:() => time});
  return {create,directory,advance:ms => {time += ms;}};
}
test('optional local PIN persists over restart, requires current PIN to disable and stores no PIN',async t => {
  const {create,directory} = await fixture(t);
  let lock = create(); await lock.initialize(); assert.equal(lock.enabled,false); assert.equal(lock.locked,false);
  await assert.rejects(lock.enable('123',false,active),/PIN/);
  await lock.enable('931725',false,active); assert.equal(lock.locked,false);
  assert.doesNotMatch(await fs.readFile(path.join(directory,'terminal-lock.v1.json'),'utf8'),/931725/);
  lock = create(); await lock.initialize(); assert.ok(lock.enabled && lock.locked);
  await assert.rejects(lock.unlock('pin','371823',active),/不正确/);
  await lock.unlock('pin','931725',active);
  await assert.rejects(lock.disable('371823',active),/不正确/);
  await lock.disable('931725',active);
  lock = create(); await lock.initialize(); assert.equal(lock.enabled,false);
});
test('PIN retries serialize, lockout survives restart and corrupt lock records fail closed',async t => {
  const {create,directory,advance} = await fixture(t);
  let lock = create(); await lock.initialize(); await lock.enable('246813',false,active); lock.lock();
  await Promise.all(Array.from({length:5},() => assert.rejects(lock.unlock('pin','888888',active),/不正确/)));
  lock = create(); await lock.initialize();
  await assert.rejects(lock.unlock('pin','246813',active),/频繁/);
  advance(1200); await lock.unlock('pin','246813',active);
  await fs.writeFile(path.join(directory,'terminal-lock.v1.json'),'{}');
  lock = create(); await assert.rejects(lock.initialize(),/无法读取/); assert.equal(lock.locked,true);
});
test('Touch ID is optional, rejects canceled prompts and binds delayed verification to the original scope',async t => {
  const {create} = await fixture(t);
  let authorize = async () => {throw new Error('canceled');};
  const hardware = () => ({available:() => true,authenticate:() => authorize()});
  const lock = create(hardware); await lock.initialize(); await lock.enable('135792',true,active); lock.lock();
  assert.equal(await lock.offeredBiometric(),true);
  await assert.rejects(lock.unlock('biometric',null,active),/canceled/);
  authorize = async () => {lock.lock();};
  await assert.rejects(lock.unlock('biometric',null,active),/变化/);
  assert.equal(lock.locked,true);
  authorize = async () => {};
  await lock.unlock('biometric',null,active); assert.equal(lock.locked,false);
  await lock.disable('135792',active); await lock.enable('135792',false,active); lock.lock();
  assert.equal(await lock.offeredBiometric(),false);
  await assert.rejects(lock.unlock('biometric',null,active),/未开启/);
});

test('Windows Hello uses the current Electron-owned HWND and accepts only an explicit verified result', async t => {
  const { provider } = require('./terminal/biometrics.cjs');
  const handle = Buffer.alloc(8, 1), calls = [];
  const owner = { isFocused: () => true, isDestroyed: () => false, getNativeWindowHandle: () => handle };
  let outcome = false, registered = false;
  const device = provider({ platform:'win32', getOwner:() => owner, packaged:true, resources:'fixture', load(file) {
    assert.equal(path.basename(file),'brclio_hello.node');
    return { available: async () => registered, verify: async buffer => { calls.push(buffer); return outcome; } };
  } });
  const { create } = await fixture(t);
  const lock = create(() => device); await lock.initialize();
  assert.equal((await lock.status()).biometricAvailable, false);
  await assert.rejects(lock.enable('246813', true, active), /暂时无法/);
  registered = true; await lock.enable('246813', true, active); lock.lock();
  for (outcome of [false, null, 0, 'verified']) {
    await assert.rejects(lock.unlock('biometric',null,active), /未完成/);
    assert.equal(lock.locked,true); assert.strictEqual(calls.at(-1),handle);
  }
  outcome = true; await lock.unlock('biometric',null,active); assert.equal(lock.locked,false);
  lock.lock(); registered = false; await assert.rejects(lock.unlock('biometric',null,active), /未开启/);
  await lock.unlock('pin','246813',active);
  const missing = provider({platform:'win32',resources:'fixture',packaged:true,load:()=>{throw new Error('missing');}});
  assert.equal(await missing.available(), false);
});

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {randomBytes, randomUUID, scrypt, timingSafeEqual} = require('node:crypto');
const derive = require('node:util').promisify(scrypt);
const validPin = value => typeof value === 'string' && /^\d{6,12}$/.test(value);

function terminalLock({directory, secureStorage, biometrics, now = Date.now}) {
  const file = path.join(directory,'terminal-lock.v1.json');
  let record, locked = true, loaded, queue = Promise.resolve(), generation = 0;
  function initialize() {
    return loaded ??= (async () => {
      try {
        if ((await fs.stat(file)).size > 16384) throw new Error();
        const parsed = JSON.parse(await fs.readFile(file,'utf8'));
        if (parsed.version !== 1 || typeof parsed.protected !== 'string' || !/^[\da-z+/=]+$/i.test(parsed.protected) ||
            !Number.isSafeInteger(parsed.until) || parsed.until < 0 || !Number.isSafeInteger(parsed.failures) ||
            parsed.failures < 0) throw new Error();
        record = parsed; locked = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('无法读取终端锁设置。');
        locked = false;
      }
    })();
  }
  function transact(fn) {
    const result = queue.then(async () => {await initialize(); return fn();});
    queue = result.catch(() => {});
    return result;
  }
  function capability() {
    try {return biometrics().available();} catch {return false;}
  }
  function status() {
    return {enabled:Boolean(record),locked,biometricAvailable:capability()};
  }
  function lock() {
    generation++;
    if (record) locked = true;
    return locked;
  }
  async function persist(next) {
    await fs.mkdir(directory,{recursive:true});
    const temp = file + '.' + randomUUID();
    try {
      await fs.writeFile(temp,JSON.stringify(next),{flag:'wx',mode:0o600});
      await fs.rename(temp,file);
      record = next;
    } finally {await fs.rm(temp,{force:true});}
  }
  async function protectedFields() {
    try {
      const result = await secureStorage().decryptStringAsync(Buffer.from(record.protected,'base64'));
      const value = JSON.parse(result.result);
      if (!/^[a-f\d]{32}$/i.test(value.salt) || !/^[a-f\d]{64}$/i.test(value.digest) || typeof value.biometric !== 'boolean') throw new Error();
      return value;
    } catch {throw new Error('系统无法打开终端锁设置，请检查本机密钥存储。');}
  }
  async function verify(pin, fields) {
    if (!validPin(pin)) throw new Error('请输入 6 至 12 位数字 PIN。');
    if (now() < record.until) throw new Error('尝试过于频繁，请稍后重试。');
    const calculated = await derive(pin,Buffer.from(fields.salt,'hex'),32);
    if (timingSafeEqual(calculated,Buffer.from(fields.digest,'hex'))) return;
    const failures = Math.min(16,record.failures + 1);
    const delay = failures < 5 ? 0 : Math.min(300000,1000 * 2 ** (failures - 5));
    await persist({...record,failures,until:now()+delay});
    throw new Error('PIN 不正确。');
  }
  function requireSame(generationAtStart, active) {
    if (generationAtStart !== generation || !active()) throw new Error('终端窗口已变化，请重试。');
  }
  return {
    initialize, status, lock, get locked() {return locked;}, get enabled() {return Boolean(record);}, get generation() {return generation;},
    enable(pin, biometric, active) {
      const start = generation;
      return transact(async () => {
        if (record || !validPin(pin) || typeof biometric !== 'boolean') throw new Error('请输入 6 至 12 位数字 PIN。');
        if (biometric && !capability()) throw new Error('此设备无法使用 Touch ID。');
        const salt = randomBytes(16), digest = await derive(pin,salt,32);
        const storage = secureStorage();
        if (!await storage.isAsyncEncryptionAvailable()) throw new Error('系统密钥存储暂不可用。');
        const protectedValue = await storage.encryptStringAsync(JSON.stringify({salt:salt.toString('hex'),digest:digest.toString('hex'),biometric}));
        requireSame(start,active);
        await persist({version:1, protected:protectedValue.toString('base64'),failures:0,until:0});
        locked = start !== generation || !active();
        return status();
      });
    },
    disable(pin, active) {
      const start = generation;
      return transact(async () => {
        if (!record || locked) throw new Error('请先解锁终端。');
        await verify(pin,await protectedFields());
        requireSame(start,active);
        await fs.unlink(file);
        record = undefined; locked = false;
        return status();
      });
    },
    unlock(method, pin, active) {
      const start = generation;
      return transact(async () => {
        if (!locked || !record) throw new Error('终端锁状态已变化。');
        const fields = await protectedFields();
        if (method === 'pin') await verify(pin,fields);
        else if (method === 'biometric' && fields.biometric && capability())
          await biometrics().authenticate();
        else throw new Error('此终端未开启 Touch ID 解锁，请输入 PIN。');
        requireSame(start,active);
        if (record.failures) await persist({...record,failures:0,until:0});
        requireSame(start,active);
        locked = false;
      });
    },
    async offeredBiometric() {
      await initialize();
      return Boolean(record && capability() && (await protectedFields()).biometric);
    },
  };
}
module.exports = {terminalLock};

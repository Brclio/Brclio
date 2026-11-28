'use strict';

const { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } = require('node:crypto');
const { deflateRaw, inflateRaw } = require('node:zlib');
const { promisify } = require('node:util');
const keyFor = promisify(scrypt), compress = promisify(deflateRaw), expand = promisify(inflateRaw);
const route = '/api/account/apps/terminal/log-copies';
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const associated = (scope, authorId, id, name, host) => Buffer.from(JSON.stringify(['brclio-log-v1',scope?.ownerId || authorId,scope?.vaultId || '',authorId,id,name,host || '']));
async function key(password, salt) {
  if (typeof password !== 'string' || [...password].length < 12 || [...password].length > 128 || Buffer.byteLength(password) > 512) throw new Error('请输入 12 到 128 字的独立日志口令。');
  return keyFor(password, salt, 32, { N:32768, r:8, p:1, maxmem:64*1024*1024 });
}
async function seal(record, password, aad) {
  const salt = randomBytes(16), iv = randomBytes(12), secret = await key(password,salt);
  try {
    const cipher = createCipheriv('aes-256-gcm',secret,iv); cipher.setAAD(aad);
    const zipped = await compress(Buffer.from(JSON.stringify(record)));
    const data = Buffer.concat([cipher.update(zipped),cipher.final()]);
    if (data.length > 393216) throw new Error('日志副本过大。');
    return {version:1, salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')};
  } finally { secret.fill(0); }
}
async function unseal(blob, password, aad) {
  if (blob?.version !== 1 || typeof blob.data !== 'string' || blob.data.length > 524288) throw new Error('不支持此日志格式。');
  const secret = await key(password,Buffer.from(blob.salt,'base64'));
  try {
    const decipher = createDecipheriv('aes-256-gcm',secret,Buffer.from(blob.iv,'base64'));
    decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(blob.tag,'base64'));
    const bytes = await expand(Buffer.concat([decipher.update(Buffer.from(blob.data,'base64')),decipher.final()]),{maxOutputLength:2*1024*1024});
    const record = JSON.parse(bytes);
    if (!uuid(record?.id) || typeof record.text !== 'string' || Buffer.byteLength(record.text) > 256*1024 + 8 ||
        !Array.isArray(record.bookmarks) || record.bookmarks.length > 32 ||
        record.bookmarks.some(mark => !mark || typeof mark.label !== 'string' || !mark.label.length || mark.label.length > 64 ||
          !Number.isSafeInteger(mark.offset) || mark.offset < 0 || mark.offset > record.text.length)) throw new Error();
    return record;
  } catch { throw new Error('口令不正确或云端副本已损坏。'); }
  finally { secret.fill(0); }
}
function registerCloudLogs({handle,accountRequest,localUser,scope,readStopped,confirm}) {
  handle('log-cloud', async (action,p = {}) => {
    const view = scope(), actor = view?.userId;
    async function check() {
      if (!actor || view?.temporary || scope() !== view || (await localUser())?.id !== actor || scope() !== view) throw new Error('请在已登录的终端中重新打开日志。');
    }
    await check();
    const dest = p.scope == null ? null : {ownerId:p.scope.ownerId,vaultId:p.scope.vaultId};
    if (dest && (!uuid(dest.vaultId) || typeof dest.ownerId !== 'string' || !/^[a-z\d-]{1,128}$/i.test(dest.ownerId))) throw new Error('请选择共享主机库。');
    async function request(op,fields = {}) {
      await check();
      const result = await accountRequest({path:route,method:'POST',body:{action:op,expectedUserId:actor,scope:dest,...fields}});
      await check();
      if (result.userId !== actor) throw new Error('账号已切换。');
      return result;
    }
    if (action === 'list') return request(action);
    if (dest && action === 'audit') return request(action);
    if (dest && action === 'policy') return request(action,{revision:p.revision,days:p.days});
    if (action === 'remove') return request(action,{id:p.id,revision:p.revision});
    if (action === 'read') {
      const {blob,entry} = await request(action,{id:p.id});
      const result = await unseal(blob,p.password,associated(dest,entry.authorId,entry.id,entry.name,entry.host));
      await check();
      return {entry,record:result};
    }
    if (action !== 'publish' || !uuid(p.localId) || ![1,7,30,90,365].includes(p.days)) throw new Error('云端日志操作无效。');
    const record = await readStopped(actor,p.localId);
    if (/-----BEGIN [^\r\n-]*PRIVATE KEY(?: BLOCK)?-----|PuTTY-User-Key-File-\d+:/i.test(record.text)) throw new Error('日志含有私钥区段，请保留在本机。');
    let destination = '个人账号 ' + actor;
    if (dest) {
      const result = await accountRequest({path:'/api/account/apps/terminal/shared-vaults',method:'POST',body:{
        action:'open',expectedUserId:actor,...dest}});
      await check();
      if (result.userId !== actor || result.vault?.state !== 'active' || !['owner','editor'].includes(result.vault.role) ||
          !result.vault.hosts?.some(host => host.host === record.host)) throw new Error('请选择包含此主机且有写入权限的共享主机库。');
      destination = '共享主机库「' + result.vault.name + '」的当前及之后获准加入的成员';
    }
    const target = await request('list');
    if (dest && p.days > (target.maximumDays ?? 365)) throw new Error('新副本的期限超过主机库留存上限。');
    if (target.revision !== p.revision) throw new Error('云端清单已变化，请刷新后重试。');
    if (!await confirm({name:record.name,host:record.host || '本机',destination,days:p.days})) return {canceled:true};
    await check();
    // Read again after confirmation. A log deleted or changed during the prompt must be reviewed again.
    const latest = await readStopped(actor,p.localId);
    if (JSON.stringify(latest) !== JSON.stringify(record)) throw new Error('日志已变化，请重新预览。');
    const id = randomUUID(), host = record.host || '';
    const blob = await seal(record,p.password,associated(dest,actor,id,record.name,host));
    return request(action,{id,revision:p.revision,name:record.name,host,days:p.days,blob});
  });
}
module.exports = {registerCloudLogs,seal,unseal,associated};

import {appDataPath, userPath} from './account-store.js';
import {activeSession} from './account-links.js';
import {sharedVaultPath} from './terminal-shared-vaults.js';
import {json, readJSON} from './http.js';

export const logCloudRoute = '/api/account/apps/terminal/log-copies';
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const account = v => typeof v === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(v);
const clean = (v,limit) => typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= limit && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(v);
const fields = (obj,keys) => obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).every(key => keys.includes(key));
const b64 = (v, bytes) => typeof v === 'string' && v.length === Math.ceil(bytes/3)*4 && /^[A-Za-z0-9+/]+={0,2}$/.test(v);
function validBlob(value) {
  return fields(value,['version','salt','iv','tag','data']) && value.version === 1 && b64(value.salt,16) &&
    b64(value.iv,12) && b64(value.tag,16) && typeof value.data === 'string' && value.data.length > 0 &&
    value.data.length <= 524288 && value.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value.data);
}
function valid(input) {
  const ops = {list:[],read:['id'],publish:['id','revision','days','name','host','blob'],remove:['id','revision']};
  if (!input || typeof input.action !== 'string' || !Object.hasOwn(ops,input.action) || !fields(input,['action','expectedUserId','scope',...ops[input.action]])) return false;
  if (input.scope !== null && !(fields(input.scope,['ownerId','vaultId']) && account(input.scope.ownerId) && uuid(input.scope.vaultId))) return false;
  if (input.action !== 'list' && !uuid(input.id)) return false;
  if (['publish','remove'].includes(input.action) && (!Number.isSafeInteger(input.revision) || input.revision < 0)) return false;
  return input.action !== 'publish' || (clean(input.name,80) && (input.host === '' || clean(input.host,255)) &&
    [1,7,30,90,365].includes(input.days) && validBlob(input.blob));
}

export async function terminalLogCloud(request, session, store) {
  if (request.method !== 'POST') return json({error:'请使用日志副本操作接口。'},405);
  let input;
  try { input = await readJSON(request,560*1024); }
  catch (e) { return json({error:'日志请求格式或大小无效。'},e instanceof RangeError ? 413 : 400); }
  if (!valid(input)) return json({error:'日志副本参数无效。'},400);
  if (input.expectedUserId !== session.id) return json({error:'登录账号已切换。'},409);
  const error = (status,message) => ({status,error:message});
  const hidden = () => error(404,'找不到此日志，或当前账号没有访问权限。');
  const result = await store.transaction(async tx => {
    const actor = session.id, {scope,action,id} = input;
    if (!activeSession(await tx.read(userPath(actor,'credentials')), session)) return error(401,'登录已失效。');
    let role = 'owner', vault;
    if (scope) {
      vault = await tx.read(sharedVaultPath(scope.ownerId,scope.vaultId));
      if (!vault || vault.deleted || vault.ownerId !== scope.ownerId || vault.vaultId !== scope.vaultId || !Array.isArray(vault.members)) return hidden();
      role = actor === vault.ownerId ? 'owner' : vault.members.find(m => m.id === actor && m.state === 'active')?.role;
      if (!['owner','reader','editor'].includes(role)) return hidden();
    }
    const owner = scope?.ownerId || actor;
    const indexPath = appDataPath(owner, scope ? 'tlog-index-' + scope.vaultId.replaceAll('-','') : 'tlog-personal');
    const blobPath = key => appDataPath(owner, 'tlog-data-' + key.replaceAll('-',''));
    const index = await tx.read(indexPath,{version:1,revision:0,entries:[]});
    if (index.version !== 1 || !Number.isSafeInteger(index.revision) || !Array.isArray(index.entries) || index.entries.length > 32)
      throw new Error('Invalid terminal log index');
    const now = Date.now(), live = entry => entry.expiresAt > now;
    const visible = () => index.entries.filter(live);
    const entry = index.entries.find(row => row.id === id);
    if (action === 'list') {
      // Bounded on-access cleanup keeps each transaction within the free Worker subrequest limit.
      const expired = index.entries.filter(item => !live(item)).slice(0,4);
      if (expired.length) {
        const dead = new Set(expired.map(item => item.id));
        for (const item of expired) tx.write(blobPath(item.id), {version:1,deleted:true});
        index.entries = index.entries.filter(item => !dead.has(item.id));
        index.revision++;
        tx.write(indexPath,index);
      }
      return {revision:index.revision,role,entries:visible()};
    }
    if (action === 'read') {
      if (!entry || !live(entry)) return hidden();
      const payload = await tx.read(blobPath(id));
      if (!payload || payload.deleted || !validBlob(payload.blob)) return hidden();
      return {entry,blob:payload.blob};
    }
    if (input.revision !== index.revision || index.revision === Number.MAX_SAFE_INTEGER) return error(409,'日志清单已变化，请刷新。');
    if (action === 'remove') {
      if (!entry) return hidden();
      if (role !== 'owner' && actor !== entry.authorId) return error(403,'只能删除自己分享的日志。');
      index.entries = index.entries.filter(item => item.id !== id);
      tx.write(blobPath(id),{version:1,deleted:true});
    } else {
      if (role === 'reader') return error(403,'当前主机库是只读权限。');
      if (scope && !vault.hosts.some(item => item.host === input.host)) return error(400,'该日志主机未加入共享主机库。');
      if (index.entries.length >= 32) return error(409,'最多保留 32 份云端副本。');
      if (entry || await tx.read(blobPath(id))) return error(409,'日志编号已使用，请重新选择。');
      index.entries.unshift({id,name:input.name,host:input.host,authorId:actor,authorName:session.profile.username,
        publishedAt:now,expiresAt:now + input.days * 86400000});
      tx.write(blobPath(id), {version:1,blob:input.blob});
    }
    index.revision++; tx.write(indexPath,index);
    return {revision:index.revision,role,entries:visible()};
  });
  return result.error ? json({error:result.error},result.status) : json({userId:session.id,...result});
}

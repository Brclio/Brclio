import {appDataPath, userPath} from './account-store.js';
import {activeSession} from './account-links.js';
import {sharedVaultPath} from './terminal-shared-vaults.js';
import {json, readJSON} from './http.js';

export const logCloudRoute = '/api/account/apps/terminal/log-copies';
const retentionDays = [1,7,30,90,365];
const auditLimit = 64;
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
  const ops = {list:[],audit:[],policy:['revision','days'],read:['id'],publish:['id','revision','days','name','host','blob'],remove:['id','revision']};
  if (!input || typeof input.action !== 'string' || !Object.hasOwn(ops,input.action) || !fields(input,['action','expectedUserId','scope',...ops[input.action]])) return false;
  if (input.scope !== null && !(fields(input.scope,['ownerId','vaultId']) && account(input.scope.ownerId) && uuid(input.scope.vaultId))) return false;
  if (['read','publish','remove'].includes(input.action) && !uuid(input.id)) return false;
  if (['policy','audit'].includes(input.action) && !input.scope) return false;
  if (input.action === 'policy' && !retentionDays.includes(input.days)) return false;
  if (['publish','remove','policy'].includes(input.action) && (!Number.isSafeInteger(input.revision) || input.revision < 0)) return false;
  return input.action !== 'publish' || (clean(input.name,80) && (input.host === '' || clean(input.host,255)) &&
    retentionDays.includes(input.days) && validBlob(input.blob));
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
  let attempts = 0;
  const result = await store.transaction(async tx => {
    // The record store retries ref conflicts against fresh commits. Limit this endpoint to
    // two full attempts so even a contended authenticated read fits a free Worker request.
    if (++attempts > 2) return error(409,'日志操作遇到并发更新，请重试。');
    const actor = session.id, {scope,action,id} = input;
    if (!activeSession(await tx.read(userPath(actor,'credentials')), session)) return error(401,'登录已失效。');
    let role = 'owner', vault;
    if (scope) {
      vault = await tx.read(sharedVaultPath(scope.ownerId,scope.vaultId));
      if (!vault || vault.deleted || vault.ownerId !== scope.ownerId || vault.vaultId !== scope.vaultId || !Array.isArray(vault.members)) return hidden();
      role = actor === vault.ownerId ? 'owner' : vault.members.find(m => m.id === actor && m.state === 'active')?.role;
      if (!['owner','reader','editor'].includes(role)) return hidden();
    }
    if (['policy','audit'].includes(action) && role !== 'owner') return error(403,'仅共享主机库所有者可管理日志策略及审计。');
    const owner = scope?.ownerId || actor;
    const indexPath = appDataPath(owner, scope ? 'tlog-index-' + scope.vaultId.replaceAll('-','') : 'tlog-personal');
    const blobPath = key => appDataPath(owner, 'tlog-data-' + key.replaceAll('-',''));
    const index = await tx.read(indexPath,{version:1,revision:0,entries:[]});
    if (index.version !== 1 || !Number.isSafeInteger(index.revision) || !Array.isArray(index.entries) || index.entries.length > 32)
      throw new Error('Invalid terminal log index');
    const now = Date.now(), live = entry => entry.expiresAt > now;
    const maximumDays = index.maximumDays ?? 365;
    if (!retentionDays.includes(maximumDays) || (index.audit !== undefined &&
        (!Array.isArray(index.audit) || index.audit.length > auditLimit))) throw new Error('Invalid team log policy');
    const listing = () => ({revision:index.revision,role,entries:index.entries.filter(live),...(scope && {maximumDays})});
    if (action === 'audit') return {events:(index.audit || []).map(({actor,event,id,time}) => ({actor,event,id,time}))};
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
      return listing();
    }
    if (action === 'read') {
      if (!entry || !live(entry)) return hidden();
      const payload = await tx.read(blobPath(id));
      if (!payload || payload.deleted || !validBlob(payload.blob)) return hidden();
      if (scope) {
        // Ref publication is the release gate. A failed or revoked attempt cannot obtain the blob.
        index.audit = [{actor,event:'read-copy',id,time:now},...(index.audit || [])].slice(0,auditLimit);
        tx.write(indexPath,index);
      }
      return {entry,blob:payload.blob};
    }
    if (input.revision !== index.revision || index.revision === Number.MAX_SAFE_INTEGER) return error(409,'日志清单已变化，请刷新。');
    if (action === 'policy') {
      if (input.days === maximumDays) return listing();
      index.maximumDays = input.days;
    } else if (action === 'remove') {
      if (!entry) return hidden();
      if (role !== 'owner' && actor !== entry.authorId) return error(403,'只能删除自己分享的日志。');
      index.entries = index.entries.filter(item => item.id !== id);
      tx.write(blobPath(id),{version:1,deleted:true});
    } else {
      if (role === 'reader') return error(403,'当前主机库是只读权限。');
      if (scope && input.days > maximumDays) return error(400,'新副本的期限超过主机库上限 ' + maximumDays + ' 天。');
      if (scope && !vault.hosts.some(item => item.host === input.host)) return error(400,'该日志主机未加入共享主机库。');
      if (index.entries.length >= 32) return error(409,'最多保留 32 份云端副本。');
      if (entry || await tx.read(blobPath(id))) return error(409,'日志编号已使用，请重新选择。');
      index.entries.unshift({id,name:input.name,host:input.host,authorId:actor,authorName:session.profile.username,
        publishedAt:now,expiresAt:now + input.days * 86400000});
      tx.write(blobPath(id), {version:1,blob:input.blob});
    }
    index.revision++; tx.write(indexPath,index);
    return listing();
  });
  return result.error ? json({error:result.error},result.status) : json({userId:session.id,...result});
}

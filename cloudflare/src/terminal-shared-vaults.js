import {appDataPath, userPath} from './account-store.js';
import {json, readJSON} from './http.js';
import {validTerminalData} from './terminal-data.js';

export const sharedVaultRoute = '/api/account/apps/terminal/shared-vaults';
const maxRequest = 100 * 1024;
const accountId = value => typeof value === 'string' && /^[\da-z-]{1,128}$/i.test(value);
const vaultId = value => typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
const title = value => typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 64 &&
  !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(value);
const roleValue = role => role === 'editor' || role === 'reader';
const referencePath = id => appDataPath(id, 'terminal-vault-list');
const vaultPath = (owner, id) => appDataPath(owner, 'terminal-vault-' + id.replaceAll('-', ''));
const denied = () => ({status:404, error:'共享主机库不存在或当前账号没有访问权限。'});
const invalid = () => ({status:400, error:'共享主机库请求格式无效。'});
const conflict = () => ({status:409, error:'共享主机库已发生变化，请刷新后重试。'});

const actionFields = {
  list: [], create: ['name','vaultId'], open: [], 'set-hosts': ['hosts'], invite: ['username','role'],
  accept: [], decline: [], leave: [], revoke: ['memberId'], role: ['memberId','role'], delete: [],
};
function validInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.action !== 'string' || !Object.hasOwn(actionFields, input.action)) return false;
  const fields = ['expectedUserId', 'action', ...actionFields[input.action]];
  if (!['list','create'].includes(input.action)) {
    if (!accountId(input.ownerId) || !vaultId(input.vaultId)) return false;
    fields.push('ownerId','vaultId');
    if (input.action !== 'open') {
      if (!Number.isSafeInteger(input.revision) || input.revision < 1) return false;
      fields.push('revision');
    }
  }
  if (Object.keys(input).some(k => !fields.includes(k))) return false;
  switch (input.action) {
    case 'create': return title(input.name) && vaultId(input.vaultId);
    case 'invite': return typeof input.username === 'string' && /^[\p{L}\p{N}][\p{L}\p{N}_.-]{2,31}$/u.test(input.username) && roleValue(input.role);
    case 'role': return accountId(input.memberId) && roleValue(input.role);
    case 'revoke': return accountId(input.memberId);
    case 'set-hosts': return Array.isArray(input.hosts) && input.hosts.length <= 256 &&
      validTerminalData({hosts:input.hosts, forwards:[]}) &&
      input.hosts.every(host => Object.keys(host).every(key => ['name','host','user','port'].includes(key)));
    default: return true;
  }
}
async function refs(tx, user) {
  const result = await tx.read(referencePath(user), {version:1, vaults:[]});
  if (result.version !== 1 || !Array.isArray(result.vaults) || result.vaults.length > 64) throw new Error('Invalid terminal vault index');
  return result;
}
function summary(vault, member) {
  return {ownerId:vault.ownerId, vaultId:vault.vaultId, ownerName:vault.ownerName, name:vault.name, role:member.role, state:member.state};
}
function detail(vault, actor) {
  const member = actor === vault.ownerId ? {role:'owner', state:'active'} : vault.members.find(entry => entry.id === actor);
  const result = {...summary(vault, member), revision:vault.revision};
  if (member.state === 'active') result.hosts = vault.hosts;
  if (member.role === 'owner') result.members = vault.members;
  return result;
}
async function updateRef(tx, user, vault, member) {
  const index = await refs(tx, user);
  index.vaults = index.vaults.filter(v => v.vaultId !== vault.vaultId || v.ownerId !== vault.ownerId);
  if (member) {
    if (index.vaults.length >= 64) return false;
    index.vaults.push(summary(vault, member));
  }
  tx.write(referencePath(user), index);
  return true;
}

async function run(tx, session, input) {
  const {action} = input, actor = session.id;
  const grant = (await tx.read(userPath(actor,'credentials')))?.sessions?.[session.sessionKey];
  if (!grant || grant.exp !== session.exp || grant.mode !== session.mode || grant.exp <= Date.now()/1000)
    return {status:401, error:'请重新登录。'};

  if (action === 'list') return {vaults:(await refs(tx,actor)).vaults};
  if (action === 'create') {
    const existing = await tx.read(vaultPath(actor,input.vaultId));
    if (existing) return existing.ownerId === actor && existing.name === input.name && existing.vaultId === input.vaultId
      ? {vault:detail(existing,actor)} : conflict();
    const vault = {version:1, ownerId:actor, ownerName:session.profile.username, vaultId:input.vaultId,
      name:input.name, revision:1, members:[], hosts:[]};
    if (!await updateRef(tx, actor, vault, {role:'owner', state:'active'})) return {status:409, error:'每个账号最多保留 64 个共享主机库和邀请。'};
    tx.write(vaultPath(actor,vault.vaultId), vault);
    return {vault:detail(vault, actor)};
  }
  const path = vaultPath(input.ownerId,input.vaultId);
  const vault = await tx.read(path);
  if (!vault || vault.deleted) return denied();
  if (vault.version !== 1 || vault.ownerId !== input.ownerId || vault.vaultId !== input.vaultId ||
      !Array.isArray(vault.members) || !Number.isSafeInteger(vault.revision)) throw new Error('Invalid terminal vault');
  const owner = actor === vault.ownerId;
  const member = vault.members.find(entry => entry.id === actor);
  if (!owner && !member) return denied();
  if (action === 'open') return {vault:detail(vault,actor)};
  if (!owner) {
    const permitted = member.state === 'invited' ? ['accept','decline'] :
      member.role === 'editor' ? ['set-hosts','leave'] : ['leave'];
    if (!permitted.includes(action)) return {status:403, error:'此操作超出当前成员权限。'};
  } else if (['leave','accept','decline'].includes(action)) return invalid();
  if (input.revision !== vault.revision || vault.revision === Number.MAX_SAFE_INTEGER) return conflict();

  if (action === 'delete') {
    for (const id of [actor,...vault.members.map(entry => entry.id)]) await updateRef(tx,id,vault,null);
    tx.write(path,{version:1,deleted:true});
    return {removed:true};
  }
  if (action === 'invite') {
    if (vault.members.length >= 8) return {status:409, error:'每个共享主机库最多邀请 8 名成员。'};
    const index = await tx.read('users/_index.json');
    const key = input.username.toLowerCase();
    const id = index?.usernames && Object.hasOwn(index.usernames,key) ? index.usernames[key] : null;
    if (!accountId(id)) return {status:404, error:'找不到该 Brclio 用户名。'};
    if (id === actor || vault.members.some(entry => entry.id === id)) return {status:409, error:'该用户已在主机库或邀请列表中。'};
    const profile = await tx.read(userPath(id,'profile'));
    if (!profile || profile.id !== id || profile.username.toLowerCase() !== key) return conflict();
    const invited = {id, username:profile.username, role:input.role, state:'invited'};
    if (!await updateRef(tx,id,vault,invited)) return {status:409, error:'对方的共享主机库和邀请已达上限。'};
    vault.members.push(invited);
  }
  if (action === 'set-hosts') vault.hosts = input.hosts;
  if (action === 'accept') {
    member.state = 'active';
    await updateRef(tx,actor,vault,member);
  }
  if (['role','revoke','leave','decline'].includes(action)) {
    const id = ['role','revoke'].includes(action) ? input.memberId : actor;
    const target = vault.members.find(entry => entry.id === id);
    if (!target) return denied();
    if (action === 'role') {
      target.role = input.role;
      await updateRef(tx,id,vault,target);
    } else {
      vault.members = vault.members.filter(entry => entry.id !== id);
      await updateRef(tx,id,vault,null);
    }
  }
  vault.revision++;
  tx.write(path,vault);
  return ['decline','leave'].includes(action) ? {removed:true} : {vault:detail(vault,actor)};
}

export async function terminalSharedVaults(request, session, store) {
  if (request.method !== 'POST') return json({error:'请使用共享主机库操作接口。'},405);
  let input;
  try { input = await readJSON(request,maxRequest); }
  catch (error) { return json({error:'请求格式无效或超过容量。'},error instanceof RangeError ? 413 : 400); }
  if (!validInput(input)) return json({error:invalid().error},400);
  if (input.expectedUserId !== session.id) return json({error:'登录账号已变化，请重新打开终端。'},409);
  // A pinned snapshot covers membership, invitations and active grants. Conflicting
  // Git commits rerun the entire authorization decision before any write.
  const result = await store.transaction(tx => run(tx,session,input));
  return result.error ? json({error:result.error},result.status) : json({userId:session.id,...result});
}

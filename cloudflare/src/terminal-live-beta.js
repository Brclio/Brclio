import {digest,decode64} from './accounts-crypto.js';
import {json,readJSON,rateLimit} from './http.js';
export {TerminalLiveRoom} from './terminal-live-room.js';

const userId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value);
const codeValue = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{32}$/.test(value);
const stubFor = (env,ref) => env.TERMINAL_LIVE_ROOMS.get(env.TERMINAL_LIVE_ROOMS.idFromName(ref.ownerId + '/' + ref.vaultId));
const accountOrigin = 'https://tools.brclio.com';

export async function accountRequest(request,env) {
  if (!await rateLimit(env,'ACCOUNT_LIMITER',request.headers.get('CF-Connecting-IP') || 'local',60)) return json({error:'请求过于频繁。'},429);
  const authorization = request.headers.get('Authorization') || '';
  if (request.headers.has('Origin') || request.headers.get('X-Brclio-Client') !== 'native' ||
      authorization.length > 4103 || !/^Bearer [a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(authorization)) return json({error:'请先登录 Brclio。'},401);
  let input;
  try {input = await readJSON(request,1536);} catch {return json({error:'观看请求格式无效。'},400);}
  if (!input || typeof input !== 'object') return json({error:'账号或邀请格式无效。'},400);
  const {action,ownerId,vaultId,expectedUserId:id} = input, ref = {ownerId,vaultId};
  if (!userId(id) || !userId(ownerId) || !uuid(vaultId) || !['create','join','renew'].includes(action)) return json({error:'观看邀请格式无效。'},400);
  const viewerId = id === ownerId ? input.viewerId : id;
  if (!userId(viewerId) || viewerId === ownerId || (action === 'create' && id !== ownerId) ||
      (action === 'join' && (id === ownerId || !codeValue(input.code))) ||
      (action === 'renew' && !codeValue(input.challenge))) return json({error:'当前账号无法使用这份邀请。'},403);
  const headers = {Authorization:authorization,'X-Brclio-Client':'native','Content-Type':'application/json'};
  if (action !== 'renew') {
    const session = await env.BRCLIO_ACCOUNTS.fetch(new Request(accountOrigin + '/api/account/session',{headers,redirect:'manual'}));
    if (!session.ok || (await session.json()).user?.id !== id) return json({error:'登录已失效。'},401);
  }
  // Only the existing account service receives the bearer. Its authenticated
  // response binds the claimed account and current ACL to one pinned vault.
  const response = await env.BRCLIO_ACCOUNTS.fetch(new Request(accountOrigin + '/api/account/apps/terminal/shared-vaults',{
    method:'POST',headers,redirect:'manual',body:JSON.stringify({action:'open',expectedUserId:id,...ref})}));
  if (!response.ok) return json({error:'共享主机库授权无法验证。'},[401,403,404,409].includes(response.status) ? 403 : 503);
  const result = await response.json(), vault = result.vault;
  if (result.userId !== id || vault?.ownerId !== ownerId || vault.vaultId !== vaultId || vault.state !== 'active' ||
      (id === ownerId ? vault.role !== 'owner' || !vault.members?.some(m => m.state === 'active' && m.id === viewerId) :
        !['editor','reader'].includes(vault.role))) return json({error:'须先接受共享主机库邀请。'},403);
  // Read only expiration from the just-verified native token. Never extend a
  // lease past the account service's original session expiry.
  let exp;
  try {exp = JSON.parse(new TextDecoder().decode(decode64(authorization.slice(7).split('.')[0]))).exp;}
  catch {return json({error:'登录已失效。'},401);}
  const until = Math.min(Date.now()+15000,exp*1000);
  if (!Number.isSafeInteger(exp) || until <= Date.now()) return json({error:'登录已过期。'},401);
  const grant = {id,proof:await digest(authorization),until};
  // The room never receives account tokens, private profiles or hosts from the vault.
  const roomResponse = await stubFor(env,ref).fetch('https://room.internal/' + action,{method:'POST',
    body:JSON.stringify({ref,viewerId,grant,code:input.code,challenge:input.challenge})});
  if (!roomResponse.ok) return roomResponse;
  return json({userId:id,...ref,...await roomResponse.json()});
}
export default {
  async fetch(request,env) {
    const path = new URL(request.url).pathname;
    if (path === '/api/account/apps/terminal/live-view' && request.method === 'POST') {
      try {return await accountRequest(request,env);}
      catch {return json({error:'观看验证服务暂不可用。'},503);}
    }
    const match = /^\/terminal-live-socket\/([\da-z-]+)\/([\da-f-]+)$/i.exec(path);
    if (!match || !userId(match[1]) || !uuid(match[2]) || request.method !== 'GET' || request.headers.has('Origin') ||
        request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({error:'未知的临时观看接口。'},404);
    return stubFor(env,{ownerId:match[1],vaultId:match[2]}).fetch(new Request('https://room.internal/socket',request));
  },
};

import {decode64,digest} from './accounts-crypto.js';
import {eligible,liveAccountStore} from './terminal-live-room.js';
import {json,readJSON,rateLimit} from './http.js';
export {TerminalLiveRoom} from './terminal-live-room.js';

const userId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value);
const codeValue = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{32}$/.test(value);
const stubFor = (env,ref) => env.TERMINAL_LIVE_ROOMS.get(env.TERMINAL_LIVE_ROOMS.idFromName(ref.ownerId + '/' + ref.vaultId));
export async function terminalLiveView(request, session, store, env) {
  let input;
  try {input = await readJSON(request,1536);} catch {return json({error:'观看请求格式无效。'},400);}
  if (!input || input.expectedUserId !== session.id) return json({error:'登录账号已变化。'},409);
  const {action,ownerId,vaultId} = input, ref = {ownerId,vaultId};
  if (!userId(ownerId) || !uuid(vaultId) || !['create','join'].includes(action)) return json({error:'观看邀请格式无效。'},400);
  const viewerId = action === 'create' ? input.viewerId : session.id;
  if (!userId(viewerId) || viewerId === ownerId || (action === 'create' && ownerId !== session.id) ||
      (action === 'join' && !codeValue(input.code))) return json({error:'当前账号无法使用这份邀请。'},403);
  const grant = {id:session.id,mode:session.mode,exp:session.exp,sessionKey:session.sessionKey};
  if (!await eligible(store,ref,[grant],viewerId)) return json({error:'须先接受共享主机库邀请。'},403);
  const response = await stubFor(env,ref).fetch('https://room.internal/' + action,{method:'POST',
    body:JSON.stringify({ref,viewerId,grant,code:input.code})});
  if (!response.ok) return response;
  return json({userId:session.id,...ref,...await response.json()});
}
export async function accountRequest(request,env,store = liveAccountStore(env)) {
  if (!await rateLimit(env,'ACCOUNT_LIMITER',request.headers.get('CF-Connecting-IP') || 'local',30)) return json({error:'请求过于频繁。'},429);
  const authorization = request.headers.get('Authorization') || '';
  if (request.headers.has('Origin') || request.headers.get('X-Brclio-Client') !== 'native' ||
      authorization.length > 4103 || !/^Bearer [a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(authorization)) return json({error:'请先登录 Brclio。'},401);
  // The existing account service verifies the original native token. The beta
  // relay never needs the account signing key and never sends a bearer to a peer.
  const response = await env.BRCLIO_ACCOUNTS.fetch(new Request('https://tools.brclio.com/api/account/session',{
    headers:{Authorization:authorization,'X-Brclio-Client':'native'},redirect:'manual'}));
  if (!response.ok) return json({error:'无法验证账号。'},503);
  const id = (await response.json()).user?.id;
  if (!userId(id)) return json({error:'登录已失效。'},401);
  let claims;
  try {claims = JSON.parse(new TextDecoder().decode(decode64(authorization.slice(7).split('.')[0])));}
  catch {return json({error:'登录已失效。'},401);}
  if (claims?.typ !== 'account' || claims.id !== id || claims.mode !== 'native' || typeof claims.sid !== 'string' ||
      !Number.isSafeInteger(claims.exp) || claims.exp <= Date.now()/1000) return json({error:'登录已失效。'},401);
  return terminalLiveView(request,{id,mode:claims.mode,exp:claims.exp,sessionKey:await digest(claims.sid)},store,env);
}
export default {
  async fetch(request,env) {
    const path = new URL(request.url).pathname;
    if (path === '/api/account/apps/terminal/live-view' && request.method === 'POST') {
      return accountRequest(request,env);
    }
    const match = /^\/terminal-live-socket\/([\da-z-]+)\/([\da-f-]+)$/i.exec(path);
    if (!match || !userId(match[1]) || !uuid(match[2]) || request.method !== 'GET' || request.headers.has('Origin') ||
        request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({error:'未知的临时观看接口。'},404);
    return stubFor(env,{ownerId:match[1],vaultId:match[2]}).fetch(new Request('https://room.internal/socket',request));
  },
};

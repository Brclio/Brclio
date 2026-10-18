import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const built=await build({entryPoints:[fileURLToPath(new URL('../src/worker.js',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node',banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"},loader:{'.html':'text','.txt':'text'}});
const dir=await mkdtemp(join(tmpdir(),'brclio-worker-test-'));const filename=join(dir,'worker.mjs');await writeFile(filename,built.outputFiles[0].contents);const {handle}=await import(pathToFileURL(filename));after(()=>rm(dir,{recursive:true,force:true}));
const origin='https://updates.example';
const env={ADMIN_EMAIL:'admin@example.com',ADMIN_PASSWORD:'test-password',SESSION_SECRET:'test-session-secret-at-least-32-characters'};
function request(path,{method='GET',body,headers={}}={}){return new Request(origin+path,{method,headers:{origin,'CF-Connecting-IP':'test-worker-ip','Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});}
async function login(){const r=await handle(request('/api/admin/login',{method:'POST',body:{email:env.ADMIN_EMAIL,password:env.ADMIN_PASSWORD}}),env);assert.equal(r.status,200);return {cookie:r.headers.get('set-cookie').split(';')[0],...(await r.json())};}
test('public health and admin shell disclose no credential or subscription values',async()=>{
  const r=await handle(request('/api/health'),env);assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true,service:'brclio-client-services',proxyProtocol:'vless-tls-websocket'});
  const html=await handle(request('/admin'),env);assert.match(html.headers.get('content-security-policy'),/frame-ancestors 'none'/);const text=await html.text();assert.ok(!text.includes(env.ADMIN_PASSWORD));assert.ok(!text.includes(env.ADMIN_EMAIL));assert.match(text,/autocomplete="current-password"/);
});
test('admin login and mutations enforce origin, cookie, CSRF and stale-SHA conflict',async()=>{
  const noOrigin=await handle(request('/api/admin/login',{method:'POST',body:{email:env.ADMIN_EMAIL,password:env.ADMIN_PASSWORD},headers:{origin:'https://attacker.example'}}),env);assert.equal(noOrigin.status,403);
  const unauth=await handle(request('/api/admin/config'),env);assert.equal(unauth.status,401);
  const session=await login();let calls=0;
  const read=await handle(request('/api/admin/config',{headers:{cookie:session.cookie}}),env,{readConfig:async()=>({subscriptionUrl:'https://subscription.example/sub',sha:'old',updatedAt:null})});
  assert.equal(read.status,200);assert.equal((await read.json()).csrf,session.csrf);assert.equal(read.headers.get('access-control-allow-origin'),null);
  const noCSRF=await handle(request('/api/admin/config',{method:'PUT',headers:{cookie:session.cookie},body:{subscriptionUrl:'https://subscription.example/new',sha:'old'}}),env,{writeConfig:async()=>{calls++;}});assert.equal(noCSRF.status,403);assert.equal(calls,0);
  const conflict=await handle(request('/api/admin/config',{method:'PUT',headers:{cookie:session.cookie,'X-CSRF-Token':session.csrf},body:{subscriptionUrl:'https://subscription.example/new',sha:'old'}}),env,{writeConfig:async()=>{calls++;return {conflict:true};}});assert.equal(conflict.status,409);assert.equal(calls,1);
  const logout=await handle(request('/api/admin/logout',{method:'POST',headers:{cookie:session.cookie,'X-CSRF-Token':session.csrf}}),env);assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
});
test('public relay rejects arbitrary target before loading private config, sanitizes upstream failure',async()=>{
  let calls=0;
  const bad=await handle(request('/api/update?url='+encodeURIComponent('https://evil.example/any')) ,env,{getNodes:async()=>{calls++;}});assert.equal(bad.status,400);assert.equal(calls,0);
  const result=await handle(request('/api/update?url='+encodeURIComponent('https://api.github.com/repos/Brclio/Brclio/releases/latest')),env,{getNodes:async()=>{throw new Error('secret-subscription-token');}});
  assert.equal(result.status,502);assert.ok(!(await result.text()).includes('secret-subscription-token'));
});
test('deployed login limiter is used and returns Retry-After',async()=>{
  const limited=await handle(request('/api/admin/login',{method:'POST',body:{email:env.ADMIN_EMAIL,password:env.ADMIN_PASSWORD}}),{...env,LOGIN_LIMITER:{limit:async({key})=>{assert.equal(key,'test-worker-ip');return {success:false};}}});
  assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'60');
});
test('general admin overview lists only the implemented module and excludes private subscription values',async()=>{
  let reads=0;
  const unauth=await handle(request('/api/admin/overview'),env,{readConfig:async()=>{reads++;}});
  assert.equal(unauth.status,401);assert.equal(reads,0);
  const session=await login();
  const result=await handle(request('/api/admin/overview',{headers:{cookie:session.cookie}}),env,{readConfig:async()=>{reads++;return {subscriptionUrl:'https://subscription.example/sub?token=private-overview-token',sha:'private-config-sha',updatedAt:'2026-10-18T00:00:00.000Z'};}});
  assert.equal(result.status,200);const overview=await result.json();
  assert.deepEqual(overview.service,{id:'brclio-client-services',name:'Brclio客户端服务'});
  assert.deepEqual(overview.account,{email:env.ADMIN_EMAIL});
  assert.deepEqual(overview.modules.map(module=>module.id),['update-proxy']);
  assert.equal(overview.modules[0].status,'implemented');
  assert.deepEqual(overview.updates,{configured:true,repository:'Brclio/Brclio',subscriptionConfigured:true,updatedAt:'2026-10-18T00:00:00.000Z',configurationStatus:'configured',transport:'vless-tls-websocket'});
  assert.equal(overview.csrf,session.csrf);assert.ok(!JSON.stringify(overview).includes('private-overview-token'));assert.ok(!JSON.stringify(overview).includes('private-config-sha'));
});
test('overview keeps the general admin shell available when private configuration cannot be read',async()=>{
  const session=await login();
  const result=await handle(request('/api/admin/overview',{headers:{cookie:session.cookie}}),env,{readConfig:async()=>{throw new Error('private-token-must-not-escape');}});
  assert.equal(result.status,200);const overview=await result.json();
  assert.equal(overview.updates.configurationStatus,'unavailable');assert.equal(overview.updates.configured,false);assert.equal(overview.updates.subscriptionConfigured,false);assert.equal(overview.updates.updatedAt,null);
  assert.ok(!JSON.stringify(overview).includes('private-token-must-not-escape'));
});

import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {readConfig,writeConfig,getNodes,clearConfigCache} from '../src/config.js';
const built=await build({entryPoints:[fileURLToPath(new URL('../src/worker.js',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node',external:['cloudflare:sockets'],banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"},loader:{'.html':'text','.txt':'text'}});
const dir=await mkdtemp(join(tmpdir(),'brclio-worker-test-'));const filename=join(dir,'worker.mjs');await writeFile(filename,built.outputFiles[0].contents);const {handle}=await import(pathToFileURL(filename));after(()=>rm(dir,{recursive:true,force:true}));
const origin='https://updates.example';
const env={ADMIN_EMAIL:'admin@example.com',ADMIN_PASSWORD:'test-password',SESSION_SECRET:'test-session-secret-at-least-32-characters'};
function request(path,{method='GET',body,headers={}}={}){return new Request(origin+path,{method,headers:{origin,'CF-Connecting-IP':'test-worker-ip','Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});}
async function login(){const r=await handle(request('/api/admin/login',{method:'POST',body:{email:env.ADMIN_EMAIL,password:env.ADMIN_PASSWORD}}),env);assert.equal(r.status,200);return {cookie:r.headers.get('set-cookie').split(';')[0],...(await r.json())};}
test('public health and admin shell disclose no credential or subscription values',async()=>{
  const r=await handle(request('/api/health'),env);assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true,service:'brclio-client-services',proxyProtocol:'vless-tls-websocket'});
  const html=await handle(request('/admin'),env);assert.match(html.headers.get('content-security-policy'),/frame-ancestors 'none'/);const text=await html.text();assert.ok(!text.includes(env.ADMIN_PASSWORD));assert.ok(!text.includes(env.ADMIN_EMAIL));assert.match(text,/autocomplete="current-password"/);
});
test('migration maintenance blocks account and config writers before storage while health stays readable',async()=>{
  const frozen={...env,DATA_MIGRATION_READ_ONLY:'true'};
  for(const [path,method] of [['/api/account/login','POST'],['/api/account/register','POST'],['/api/account/data','PUT'],['/api/account/apps/miniapp/data','PUT'],['/api/account/google/callback?code=unused','GET'],['/api/account/device/poll?id=unused','GET'],['/api/admin/config','PUT']]) {
    const response=await handle(request(path,{method,...(method!=='GET'?{body:{}}:{})}),frozen);
    assert.equal(response.status,503);assert.equal((await response.json()).code,'DATA_MIGRATION_READ_ONLY');assert.equal(response.headers.get('retry-after'),'120');
  }
  assert.equal((await handle(request('/api/health'),frozen)).status,200);
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
test('authenticated admin config and public client configuration use only the explicit program repository',async()=>{
  clearConfigCache();
  const scoped={...env,GITHUB_DATA_REPOSITORY:'fixture/worker-users',GITHUB_PROGRAM_DATA_REPOSITORY:'fixture/worker-program'};
  const endpoint='https://api.github.com/repos/fixture/worker-program/contents/config/update-proxy.json';
  const subscriptionUrl='https://subscription.example/program';
  const subscription={proxies:[{type:'vless',uuid:'00112233-4455-6677-8899-aabbccddeeff',tls:true,network:'ws',servername:'vpn.example.com',port:443,'ws-opts':{path:'/tunnel',headers:{Host:'vpn.example.com'}}}]};
  let sha='before';const privateCalls=[],tokenScopes=[];
  const tokenProvider=async(_env,repository)=>{tokenScopes.push(repository);assert.equal(repository,scoped.GITHUB_PROGRAM_DATA_REPOSITORY);return 'program-only-fixture-token';};
  const fetchImpl=async(url,options)=>{
    if(url===subscriptionUrl){assert.equal(options.headers.Authorization,undefined);return Response.json(subscription);}
    assert.equal(url,endpoint);assert.equal(options.headers.Authorization,'Bearer program-only-fixture-token');privateCalls.push(options.method||'GET');
    if(options.method==='PUT'){
      const stored=JSON.parse(Buffer.from(JSON.parse(options.body).content,'base64').toString());
      assert.deepEqual(stored.future,{nested:'private-program-extension'});sha='after';return Response.json({content:{sha}});
    }
    const data=JSON.stringify({version:1,subscriptionUrl,future:{nested:'private-program-extension'}});return Response.json({sha,size:Buffer.byteLength(data),encoding:'base64',content:Buffer.from(data).toString('base64')});
  };
  const dependencies={readConfig:(received,options)=>readConfig(received,{...options,fetchImpl,tokenProvider}),
    writeConfig:(received,input)=>writeConfig(received,input,fetchImpl,{tokenProvider}),
    getNodes:(received,_fetch,options)=>getNodes(received,fetchImpl,{...options,tokenProvider})};
  try{
    const session=await login();
    const read=await handle(request('/api/admin/config',{headers:{cookie:session.cookie}}),scoped,dependencies);
    assert.equal(read.status,200);const visible=await read.json();assert.equal(visible.sha,'before');
    assert.deepEqual(Object.keys(visible).sort(),['csrf','sha','subscriptionUrl','updatedAt']);
    assert.ok(!JSON.stringify(visible).includes('private-program-extension'));
    const saved=await handle(request('/api/admin/config',{method:'PUT',headers:{cookie:session.cookie,'X-CSRF-Token':session.csrf},body:{subscriptionUrl,sha:'before'}}),scoped,dependencies);
    assert.equal(saved.status,200);assert.equal((await saved.json()).sha,'after');
    const client=await handle(request('/api/client/update-proxy'),scoped,dependencies);
    assert.equal(client.status,200);assert.equal((await client.json()).nodes.length,1);
    assert.deepEqual(privateCalls,['GET','GET','PUT','GET']);assert.equal(tokenScopes.length,4);
    const missing={...scoped,GITHUB_PROGRAM_DATA_REPOSITORY:undefined};
    assert.equal((await handle(request('/api/admin/config',{headers:{cookie:session.cookie}}),missing,dependencies)).status,502);
    assert.equal((await handle(request('/api/client/update-proxy'),missing,dependencies)).status,502);
    assert.equal(privateCalls.length,4);assert.equal(tokenScopes.length,4);
  }finally{clearConfigCache();}
});
test('public relay rejects arbitrary target before loading private config, sanitizes upstream failure',async()=>{
  let calls=0;
  const bad=await handle(request('/api/update?url='+encodeURIComponent('https://evil.example/any')) ,env,{getNodes:async()=>{calls++;}});assert.equal(bad.status,400);assert.equal(calls,0);
  const result=await handle(request('/api/update?url='+encodeURIComponent('https://api.github.com/repos/Brclio/Brclio/releases/latest')),env,{getOfficialRelease:async()=>{throw new Error('secret-subscription-token');}});
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

test('public homepage is distinct from the protected administration shell',async()=>{
  const home=await handle(request('/'),env);assert.equal(home.status,200);assert.match(home.headers.get('content-security-policy'),/img-src 'self' data:/);assert.match(home.headers.get('content-type'),/text\/html/);const html=await home.text();
  assert.match(html,/src=["']\/home\.js["']/);assert.ok(!html.includes('autocomplete="current-password"'));assert.ok(!html.includes(env.ADMIN_PASSWORD));assert.ok(!html.includes(env.ADMIN_EMAIL));
  const admin=await handle(request('/admin'),env);assert.match(await admin.text(),/autocomplete="current-password"/);
  const script=await handle(request('/home.js'),env);assert.equal(script.status,200);assert.match(script.headers.get('content-type'),/javascript/);assert.match(await script.text(),/\/api\/releases\/latest/);
  const missing=await handle(request('/unregistered-page'),env);assert.equal(missing.status,404);
});
test('public release metadata uses only the fixed native HTTPS loader and never loads proxy nodes',async()=>{
  let calls=0;const summary={version:'0.1.8',assets:[{platform:'android'}]};
  const dependencies={getNodes:async()=>assert.fail('metadata must not load subscription'),getOfficialRelease:async()=>{calls++;return{summary,metadata:{tag_name:'v0.1.8'}};}};
  const response=await handle(request('/api/releases/latest'),env,dependencies);assert.equal(response.status,200);assert.equal(response.headers.get('x-brclio-route'),'github-metadata');assert.deepEqual(await response.json(),summary);
  const legacy=await handle(request('/api/update?url='+encodeURIComponent('https://api.github.com/repos/Brclio/Brclio/releases/latest')),env,dependencies);assert.equal(legacy.status,200);assert.deepEqual(await legacy.json(),{tag_name:'v0.1.8'});assert.equal(calls,2);
  const limited=await handle(request('/api/releases/latest'),{...env,UPDATE_LIMITER:{limit:async()=>({success:false})}},dependencies);assert.equal(limited.status,429);
  const unavailable=await handle(request('/api/releases/latest'),env,{getOfficialRelease:async()=>{throw new Error('private-credential');}});assert.equal(unavailable.status,502);assert.ok(!(await unavailable.text()).includes('private-credential'));
});
test('every legacy installer and checksum request returns410 before private config or transfer',async()=>{
  const base='https://github.com/Brclio/Brclio/releases/download/v0.1.9/';let loads=0;
  const dependencies={getNodes:async()=>{loads++;assert.fail('must not load nodes');},relayChunk:async()=>assert.fail('must not transfer installer'),relayUpdate:async()=>assert.fail('must not relay'),getOfficialRelease:async()=>assert.fail('must not read metadata')};
  for(const filename of ['Brclio-0.1.9-android.apk','Brclio-0.1.9-windows-x64.exe','SHA256SUMS.txt','unknown.bin'])for(const headers of [{},{range:'bytes=0-131071'},{range:'bytes=0-1,4-5'}]){
    const response=await handle(request('/api/update?url='+encodeURIComponent(base+filename),{headers}),env,dependencies);assert.equal(response.status,410);assert.equal((await response.json()).code,'client_upgrade_required');
  }
  const metadataRange=await handle(request('/api/update?url='+encodeURIComponent('https://api.github.com/repos/Brclio/Brclio/releases/latest'),{headers:{range:'bytes=0-1'}}),env,dependencies);assert.equal(metadataRange.status,416);assert.equal(loads,0);
});
test('workers.dev bootstrap alias serves only GET configuration and health',async()=>{
  const alias='https://brclio-client-services.aiyuechuang.workers.dev',nodes=[{uuid:'00112233-4455-6677-8899-aabbccddeeff',host:'vpn.example.com',port:443,path:'/tunnel',dialAddress:'104.17.1.1'}];let calls=0;
  const dependencies={getNodes:async()=>{calls++;return nodes;}};
  assert.equal((await handle(new Request(alias+'/api/health'),env,dependencies)).status,200);
  const configuration=await handle(new Request(alias+'/api/client/update-proxy'),env,dependencies);assert.equal(configuration.status,200);assert.equal((await configuration.json()).nodes.length,1);
  for(const path of ['/','/admin','/admin.js','/home.js','/api/admin/login','/api/admin/config','/api/releases/latest','/api/update'])assert.equal((await handle(new Request(alias+path),env,dependencies)).status,404);
  assert.equal((await handle(new Request(alias+'/api/client/update-proxy',{method:'POST'}),env,dependencies)).status,404);assert.equal(calls,1);
});

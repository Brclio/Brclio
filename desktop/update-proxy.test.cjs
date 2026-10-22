'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createUpdateProxy, usesProxy, SERVICE_ORIGIN, PROBE_URL, CONFIG_URL, CONFIG_FALLBACK_URL, SYSTEM_PARTITION, DIRECT_PARTITION, BUILTIN_PARTITION } = require('./update-proxy.cjs');
const { createUpdater, API_URL } = require('./updater.cjs');
const downloadURL = 'https://github.com/Brclio/Brclio/releases/download/v0.2.0/Brclio-0.2.0-mac-arm64.dmg';
const checksumURL = 'https://github.com/Brclio/Brclio/releases/download/v0.2.0/SHA256SUMS.txt';
const configuration = () => ({ version: 1, ttlSeconds: 600, nodes: [{uuid:'12345678-1234-1234-1234-123456789abc',host:'relay.example.com',dialAddress:'1.1.1.1',port:443,path:'/tunnel',servername:'relay.example.com',wsHost:'relay.example.com'}] });
function fixture(overrides = {}) {
  const calls = [], configurations = [], states = [], resolved = [], bridges = [], probes = [];
  const resolve = async (kind, url) => { resolved.push([kind,url]); return overrides.resolve ? overrides.resolve(kind,url) : 'DIRECT'; };
  const fetch = (kind, sessionId) => async (url, init) => {
    if (init.method === 'HEAD' && url === PROBE_URL) { probes.push({kind,url,init,sessionId}); return overrides.probe ? overrides.probe(url,init,sessionId) : new Response(null,{status:200}); }
    calls.push({kind,url,init,sessionId});
    if (url === CONFIG_URL || url === CONFIG_FALLBACK_URL) return overrides.configFetch ? overrides.configFetch(url,init) : new Response(JSON.stringify(configuration()));
    return overrides.fetch ? overrides.fetch(kind,url,init) : new Response(kind);
  };
  const sessions = {
    [SYSTEM_PARTITION]: {setProxy:async config=>configurations.push(['system',config]),resolveProxy:url=>resolve('system',url),fetch:fetch('system')},
    [DIRECT_PARTITION]: {setProxy:async config=>configurations.push(['direct',config]),fetch:(url,init)=>fetch([CONFIG_URL,CONFIG_FALLBACK_URL].includes(url)?'config':'direct')(url,init)},
    [BUILTIN_PARTITION]: {setProxy:async config=>configurations.push(['builtin',config]),closeAllConnections:async()=>{},fetch:fetch('builtin')},
  };
  const router = createUpdateProxy({whenReady:async()=>{},defaultSession:()=>({resolveProxy:url=>resolve('native',url),setProxy:()=>{throw Error('Default session proxy must not change');}}),
    fromPartition:(name,options)=>{assert.equal(options.cache,false);assert.ok(!name.startsWith('persist:'));return sessions[name] || (name.startsWith(BUILTIN_PARTITION + '-') ? {...sessions[BUILTIN_PARTITION],fetch:fetch('builtin',name)} : undefined);},
    netFetch:fetch('native'),onState:s=>states.push(s),createBridge:async options=>{
      const bridge={proxyRules:'http://127.0.0.1:12345',closed:false,close:async()=>{bridge.closed=true;}};
      bridges.push({bridge,options});return bridge;
    }});
  return {router,calls,configurations,states,resolved,bridges,probes};
}
test('PAC first choice is respected and malformed answers fail closed',()=>{
  assert.equal(usesProxy('DIRECT; PROXY fallback:80'),false);
  for(const answer of ['PROXY localhost:7890; DIRECT','SOCKS5 localhost:1080','HTTPS localhost:443']) assert.equal(usesProxy(answer),true);
  assert.throws(()=>usesProxy(''),/无法读取/);
});
test('built-in fetch bootstraps only small config, then requests original GitHub URL in an isolated proxied session',async()=>{
  const {router,calls,configurations,bridges}=fixture();
  assert.equal(SERVICE_ORIGIN,'https://tools.brclio.com');
  assert.equal((await router.state()).route,'builtin');
  const response=await router.fetch(API_URL,{headers:{'User-Agent':'Brclio/0.1.9'}});
  assert.equal(response.url,API_URL);assert.equal(await response.text(),'builtin');
  assert.deepEqual(calls.map(c=>[c.kind,c.url]),[['config',CONFIG_URL],['builtin',API_URL]]);
  assert.ok(calls.every(c=>c.init.redirect==='manual'&&c.init.credentials==='omit'));
  assert.equal(new Headers(calls[0].init.headers).get('user-agent'),'Brclio/0.1.9');
  assert.deepEqual(configurations,[['system',{mode:'system'}],['direct',{mode:'direct'}],['builtin',{mode:'fixed_servers',proxyRules:'http://127.0.0.1:12345',proxyBypassRules:'<-loopback>'}]]);
  assert.equal(bridges[0].bridge.closed,true);
});
test('system/CLI proxy wins and disables bootstrap without modifying OS settings',async()=>{
  for(const native of [true,false]){
    const {router,calls,bridges,configurations}=fixture({resolve:kind=>kind===(native?'native':'system')?'SOCKS5 localhost:1080':'DIRECT'});
    const state=await router.state();assert.equal(state.route,'system');assert.equal(Object.hasOwn(state,'fallbackFrom'),false);
    assert.equal(await(await router.fetch(API_URL)).text(),native?'native':'system');
    assert.equal(calls.length,1);assert.equal(calls[0].url,API_URL);assert.equal(bridges.length,0);
    assert.deepEqual(configurations,[['system',{mode:'system'}],['direct',{mode:'direct'}]]);
  }
});
test('native connection failures retry once through isolated DIRECT and pin the remaining official operation',async()=>{
  const cdn='https://release-assets.githubusercontent.com/release?signature=public';
  for(const native of [true,false])for(const code of ['ERR_CONNECTION_CLOSED','ERR_PROXY_CONNECTION_FAILED']){
    const controller=new AbortController();
    const {router,calls,bridges,probes,configurations}=fixture({resolve:kind=>kind===(native?'native':'system')?'PROXY localhost:7890':'DIRECT',fetch:async(kind,url,init)=>{
      assert.equal(init.signal,controller.signal);
      if(kind!=='direct')throw Error('net::'+code);
      return url===downloadURL?new Response(null,{status:302,headers:{location:cdn}}):new Response('ok');
    }});
    router.setBusy(true,[API_URL,checksumURL,downloadURL]);
    assert.equal(await(await router.fetch(API_URL,{signal:controller.signal})).text(),'ok');
    const state=await router.state();assert.equal(state.route,'direct');assert.equal(state.fallbackFrom,'system');
    await(await router.fetch(checksumURL,{signal:controller.signal})).text();
    const download=await router.fetch(downloadURL,{signal:controller.signal});assert.equal(download.url,cdn);await download.text();
    assert.deepEqual(calls.map(value=>[value.kind,value.url]),[[native?'native':'system',API_URL],['direct',API_URL],['direct',checksumURL],['direct',downloadURL],['direct',cdn]]);
    assert.ok(calls.every(value=>value.init.redirect==='manual'&&value.init.credentials==='omit'));
    assert.equal(bridges.length,0);assert.equal(probes.length,0);
    assert.deepEqual(configurations,[['system',{mode:'system'}],['direct',{mode:'direct'}]]);
    await router.setBusy(false);
    for(let refresh=0;refresh<2;refresh++){
      const completed=await router.state();assert.equal(completed.route,'direct');assert.equal(completed.fallbackFrom,'system');
    }
  }
});
test('HEAD can fail over using an explicit native code and a failed DIRECT attempt never loops',async()=>{
  for(const fails of [false,true]){
    const {router,calls,bridges}=fixture({resolve:()=> 'PROXY localhost:7890',fetch:async kind=>{
      if(kind!=='direct'||fails)throw Object.assign(Error('Native connection failed'),{code:'ERR_PROXY_CONNECTION_FAILED'});
      return new Response(null,{status:200});
    }});
    if(fails)await assert.rejects(router.fetch(API_URL,{method:'HEAD'}),/更新服务连接失败/);
    else assert.equal((await router.fetch(API_URL,{method:'HEAD'})).status,200);
    assert.deepEqual(calls.map(value=>value.kind),['native','direct']);assert.equal(bridges.length,0);
  }
});
test('fallback state resets for new operations, standalone selections and toggle changes',async()=>{
  let failures=0;
  const {router,states}=fixture({resolve:()=> 'PROXY localhost:7890',fetch:async kind=>{
    if(kind==='native'&&failures++<3)throw Error('net::ERR_CONNECTION_CLOSED');
    return new Response('ok');
  }});
  await(await router.fetch(API_URL)).text();assert.equal(states.at(-1).fallbackFrom,'system');
  const completed=await router.state();assert.equal(completed.route,'direct');assert.equal(completed.fallbackFrom,'system');
  router.setBusy(true,[API_URL]);assert.equal(Object.hasOwn(await router.state(),'fallbackFrom'),false);
  await(await router.fetch(API_URL)).text();assert.equal(states.at(-1).fallbackFrom,'system');
  await router.setBusy(false);
  assert.equal(Object.hasOwn(await router.setEnabled(false),'fallbackFrom'),false);
  await(await router.fetch(API_URL)).text();assert.equal(states.at(-1).fallbackFrom,'system');
  await(await router.fetch(API_URL)).text();assert.equal(states.at(-1).route,'system');assert.equal(Object.hasOwn(states.at(-1),'fallbackFrom'),false);
});
test('aborts, certificate failures, unknown failures and requests with a body never fall back',async()=>{
  const failures=[
    ()=>Error('net::ERR_CERT_AUTHORITY_INVALID'),
    ()=>Object.assign(Error('net::ERR_CONNECTION_CLOSED'),{code:'ERR_CERT_DATE_INVALID'}),
    ()=>Error('net::ERR_CONNECTION_CLOSED net::ERR_CERT_COMMON_NAME_INVALID'),
    ()=>Error('Unknown native failure'),
    ()=>Error('Unknown failure mentioning ERR_CONNECTION_CLOSED'),
    ()=>Object.assign(Error('net::ERR_CONNECTION_CLOSED'),{name:'AbortError'}),
    ()=>Object.assign(Error('net::ERR_CONNECTION_CLOSED'),{name:'TimeoutError'}),
    ()=>Error('net::ERR_ABORTED'),
  ];
  for(const failure of failures){
    const {router,calls}=fixture({resolve:()=> 'PROXY localhost:7890',fetch:async()=>{throw failure();}});
    await assert.rejects(router.fetch(API_URL));assert.deepEqual(calls.map(value=>value.kind),['native']);
  }
  for(const init of [{method:'POST'},{method:'GET',body:'payload'},{method:'HEAD',body:'payload'}]){
    const {router,calls}=fixture({resolve:()=> 'PROXY localhost:7890',fetch:async()=>{throw Error('net::ERR_CONNECTION_CLOSED');}});
    await assert.rejects(router.fetch(API_URL,init));assert.deepEqual(calls.map(value=>value.kind),['native']);
  }
  const controller=new AbortController();
  const cancelled=fixture({resolve:()=> 'PROXY localhost:7890',fetch:async()=>{controller.abort();throw Error('net::ERR_CONNECTION_CLOSED');}});
  await assert.rejects(cancelled.router.fetch(API_URL,{signal:controller.signal}),{name:'AbortError'});
  assert.deepEqual(cancelled.calls.map(value=>value.kind),['native']);
});
test('DIRECT fallback shares the original cancellation deadline and never replays a returned body',async()=>{
  const controller=new AbortController();let directStarted;
  const started=new Promise(resolve=>{directStarted=resolve;});
  const {router,calls}=fixture({resolve:()=> 'PROXY localhost:7890',fetch:async(kind,_url,init)=>{
    assert.equal(init.signal,controller.signal);
    if(kind==='native')throw Error('net::ERR_CONNECTION_CLOSED');
    directStarted();return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(Object.assign(Error('Cancelled'),{name:'AbortError'})),{once:true}));
  }});
  const pending=router.fetch(API_URL,{signal:controller.signal});await started;controller.abort();
  await assert.rejects(pending,{name:'AbortError'});assert.deepEqual(calls.map(value=>value.kind),['native','direct']);
  const broken=fixture({resolve:()=> 'PROXY localhost:7890',fetch:async()=>new Response(new ReadableStream({start(value){value.error(Error('net::ERR_CONNECTION_CLOSED'));}}))});
  const response=await broken.router.fetch(API_URL);await assert.rejects(response.text(),/更新服务连接失败/);
  assert.deepEqual(broken.calls.map(value=>value.kind),['native']);
});
test('HTTP responses and redirect/security rejections never trigger system-to-DIRECT fallback',async()=>{
  for(const status of [403,407,429,500]){
    const {router,calls}=fixture({resolve:()=> 'PROXY localhost:7890',fetch:async()=>new Response(null,{status})});
    assert.equal((await router.fetch(API_URL)).status,status);assert.deepEqual(calls.map(value=>value.kind),['native']);
  }
  for(const response of [new Response(null,{status:403,headers:{'cf-mitigated':'challenge'}}),new Response(null,{status:302,headers:{location:'https://foreign.invalid/private'}}),Object.defineProperty(new Response('ok'),'redirected',{value:true})]){
    const {router,calls}=fixture({resolve:()=> 'PROXY localhost:7890',fetch:async()=>response});
    await assert.rejects(router.fetch(API_URL),/Cloudflare|非官方/);assert.deepEqual(calls.map(value=>value.kind),['native']);
  }
});
test('OFF is session-only, new process defaults ON, and busy switches are rejected',async()=>{
  const {router,calls}=fixture();await router.setEnabled(false);
  await(await router.fetch(API_URL)).text();assert.equal(calls[0].kind,'native');
  assert.equal((await fixture().router.state()).enabled,true);
  await assert.rejects(router.setEnabled('false'),/开启或关闭/);
  router.setBusy(true,[API_URL]);await assert.rejects(router.setEnabled(true),/检查或下载/);
  assert.equal((await router.state()).busy,true);await router.setBusy(false);
});
test('download operation inspects all initial PAC targets and locks system family through redirects',async()=>{
  const cdn='https://objects.githubusercontent.com/package?signature=public';
  const {router,calls}=fixture({resolve:(_kind,url)=>url===downloadURL?'PROXY localhost:7890':'DIRECT',
    fetch:async(_kind,url)=>url===downloadURL?new Response(null,{status:302,headers:{location:cdn}}):new Response('ok')});
  router.setBusy(true,[checksumURL,downloadURL]);
  await(await router.fetch(checksumURL)).text();await(await router.fetch(downloadURL)).text();await router.setBusy(false);
  assert.deepEqual(calls.map(c=>[c.kind,c.url]),[['native',checksumURL],['native',downloadURL],['native',cdn]]);
});
test('built-in operation reuses one local bridge for manifest, continuous installer and validated redirects',async()=>{
  const cdn='https://release-assets.githubusercontent.com/release?signature=public';
  const {router,calls,bridges}=fixture({fetch:async(_kind,url)=>url===downloadURL?new Response(null,{status:302,headers:{location:cdn}}):new Response('payload')});
  router.setBusy(true,[checksumURL,downloadURL]);
  await(await router.fetch(checksumURL)).text();assert.equal(bridges[0].bridge.closed,false);
  const response=await router.fetch(downloadURL);assert.equal(response.url,cdn);assert.equal(await response.text(),'payload');
  assert.equal(bridges.length,1);assert.ok(calls.every(c=>!new Headers(c.init.headers).has('range')));
  await router.setBusy(false);assert.equal(bridges[0].bridge.closed,true);
});
test('every operation refreshes configuration and closes its selected probe bridge afterwards',async()=>{
  const {router,calls,bridges}=fixture();
  await(await router.fetch(API_URL)).text();await(await router.fetch(API_URL)).text();
  assert.equal(calls.filter(c=>c.url===CONFIG_URL).length,2);assert.equal(bridges.length,2);assert.ok(bridges.every(x=>x.bridge.closed));
  await router.close();
});
test('all 16 candidates receive native HTTPS HEAD probes concurrently and the fastest successful node stays fixed',async()=>{
  const nodes=Array.from({length:16},(_,i)=>({...configuration().nodes[0],dialAddress:`1.1.1.${i+1}`}));
  let active=0,maximum=0;
  const {router,calls,probes,bridges}=fixture({configFetch:async()=>new Response(JSON.stringify({...configuration(),nodes})),probe:async(url,init,sessionId)=>{
    assert.equal(url,'https://github.com/robots.txt');assert.equal(init.method,'HEAD');assert.equal(init.redirect,'manual');assert.equal(init.cache,'no-store');
    active++;maximum=Math.max(maximum,active);const index=Number(sessionId.split('-').at(-1));
    await new Promise(resolve=>setTimeout(resolve,index===7?2:20));active--;
    return new Response(null,{status:index===1?403:200});
  }});
  router.setBusy(true,[checksumURL,downloadURL]);await(await router.fetch(checksumURL)).text();await(await router.fetch(downloadURL)).text();
  assert.equal(probes.length,16);assert.equal(maximum,16);assert.equal(calls[1].sessionId,`${BUILTIN_PARTITION}-7`);assert.equal(calls[2].sessionId,calls[1].sessionId);
  assert.equal(new Set(bridges.map(value=>value.options.nodes[0].dialAddress)).size,16);
  assert.equal(bridges.filter(x=>!x.bridge.closed).length,1);await router.setBusy(false);assert.ok(bridges.every(x=>x.bridge.closed));
});
test('aborted or unsuccessful probe batches close every bridge and never request metadata or installers',async()=>{
  for(const aborted of [true,false]){
    const controller=new AbortController();let began;
    const started=new Promise(resolve=>{began=resolve;});
    const {router,calls,bridges}=fixture({probe:async(_url,init)=>{
      began();if(!aborted)return new Response(null,{status:200,headers:{'cf-mitigated':'challenge'}});
      return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(Object.assign(Error('private node URL'),{name:'AbortError'})),{once:true}));
    }});
    const pending=router.fetch(API_URL,{signal:controller.signal});await started;if(aborted)controller.abort();
    await assert.rejects(pending,error=>aborted?error.name==='AbortError':/内置更新代理连接失败/.test(error.message));
    assert.equal(calls.length,1);assert.ok(bridges.every(x=>x.bridge.closed));
  }
});
test('bootstrap fallback is fixed and limited to a network failure or an explicit primary challenge',async()=>{
  for(const network of [true,false]){
    let cancelled=0;
    const {router,calls}=fixture({configFetch:async(url)=>{
      if(url===CONFIG_FALLBACK_URL)return new Response(JSON.stringify(configuration()));
      if(network)throw Error('private transport URL');
      return new Response(new ReadableStream({cancel(){cancelled++;}},{highWaterMark:0}),{status:403,headers:{'cf-mitigated':'challenge'}});
    }});
    await(await router.fetch(API_URL)).text();assert.deepEqual(calls.map(c=>c.url),[CONFIG_URL,CONFIG_FALLBACK_URL,API_URL]);assert.equal(cancelled,network?0:1);
  }
  for(const status of [429,502]){const {router,calls}=fixture({configFetch:async()=>new Response(null,{status})});await assert.rejects(router.fetch(API_URL));assert.equal(calls.length,1);}
});
test('bootstrap access blocks are safely identified, unread bodies cancelled, and never retried',async()=>{
  for(const [status,headers,message] of [[403,{},/内置更新服务拒绝/],[429,{},/内置更新服务暂时限制/],[403,{'cf-mitigated':'challenge'},/Cloudflare 安全验证/],[503,{},/内置更新代理连接失败/]]){
    let cancelled=0,read=0;
    const {router,calls,states,bridges}=fixture({configFetch:async()=>new Response(new ReadableStream({pull(){read++;throw Error('private URL/HTML');},cancel(){cancelled++;}},{highWaterMark:0}),{status,headers})});
    await assert.rejects(router.fetch(API_URL),message);assert.equal(cancelled,headers['cf-mitigated'] ? 2 : 1);assert.equal(read,0);assert.equal(calls.length,headers['cf-mitigated'] ? 2 : 1);assert.equal(bridges.length,0);
    assert.ok(states.every(s=>!/private|HTML/.test(JSON.stringify(s))));
  }
});
test('bootstrap rejects redirects, excessive bytes, malformed configs and unsupported TLS settings without leaking details',async()=>{
  const invalid=configuration();invalid.nodes[0].rejectUnauthorized=false;
  for(const response of [new Response(null,{status:302,headers:{location:'https://evil.invalid/secret'}}),Object.defineProperty(new Response('{}'),'url',{value:'https://evil.invalid/'}),new Response('x'.repeat(32769)),new Response('{private-token=secret}'),new Response(JSON.stringify(invalid))]){
    const {router,calls}=fixture({configFetch:async()=>response});
    await assert.rejects(router.fetch(API_URL),error=>!/secret|evil|private-token/.test(error.message));assert.equal(calls.length,1);
  }
});
test('native official errors retain GitHub limits; any challenged official response is accurately identified',async()=>{
  for(const enabled of [true,false])for(const challenge of [true,false]){
    const {router}=fixture({fetch:async()=>new Response(null,{status:403,headers:challenge?{'cf-mitigated':'challenge'}:{}})});
    if(!enabled)await router.setEnabled(false);
    const updater=createUpdater({currentVersion:'0.1.0',directory:'/unused-check-only',fetch:router.fetch,onOperation:(_kind,active,targets)=>router.setBusy(active,targets)});
    assert.match((await updater.check()).error,challenge?/Cloudflare 安全验证/:/GitHub 暂时限制/);
  }
});
test('all network routes manually validate redirect hosts and never issue unchecked followups',async()=>{
  for(const builtin of [true,false])for(const location of ['https://evil.invalid/x','http://github.com/x','https://user:password@github.com/x']){
    const {router,calls}=fixture({fetch:async()=>new Response(null,{status:302,headers:{location}})});if(!builtin)await router.setEnabled(false);
    await assert.rejects(router.fetch(downloadURL),/非官方/);assert.equal(calls.filter(c=>c.url!==CONFIG_URL).length,1);
  }
  const {router,calls}=fixture();await assert.rejects(router.fetch('https://api.github.com/user'),/官方/);assert.equal(calls.length,0);
});
test('abort interrupts PAC lookup and does not leave unhandled initialization rejections',async()=>{
  const {router}=fixture({resolve:()=>new Promise(()=>{})});const controller=new AbortController();const pending=router.fetch(API_URL,{signal:controller.signal});controller.abort();await assert.rejects(pending,{name:'AbortError'});
  let rejectReady;const early=createUpdateProxy({whenReady:()=>new Promise((_resolve,reject)=>{rejectReady=reject;})});const pre=new AbortController();pre.abort();await assert.rejects(early.fetch(API_URL,{signal:pre.signal}),{name:'AbortError'});rejectReady(Error('private late failure'));await new Promise(resolve=>setImmediate(resolve));
});
test('continuous download retains full SHA, failure cleanup and bridge cleanup without any range or Worker relay request',async t=>{
  const bytes=crypto.randomBytes(2*1024*1024+37),digest=crypto.createHash('sha256').update(bytes).digest('hex'),assetName='Brclio-0.2.0-mac-arm64.dmg';
  for(const corrupt of [true,false]){
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'brclio-native-proxy-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    const {router,calls,bridges}=fixture({fetch:async(_kind,url)=>{
      if(url===API_URL)return new Response(JSON.stringify({tag_name:'v0.2.0',assets:[{name:assetName,size:bytes.length,browser_download_url:downloadURL,digest:`sha256:${digest}`},{name:'SHA256SUMS.txt',browser_download_url:checksumURL}]}));
      if(url===checksumURL)return new Response(`${digest}  ${assetName}`);
      return new Response(corrupt?Buffer.alloc(bytes.length):bytes);
    }});
    const updater=createUpdater({currentVersion:'0.1.0',directory,platform:'darwin',architecture:'arm64',fetch:router.fetch,onOperation:(_kind,active,targets)=>router.setBusy(active,targets)});
    await updater.check();const result=await updater.download();assert.equal(result.status,corrupt?'error':'downloaded');
    if(corrupt){assert.match(result.error,/SHA256/);assert.deepEqual(await fs.readdir(directory),[]);}else assert.deepEqual(await fs.readFile(path.join(directory,assetName)),bytes);
    assert.equal(calls.filter(c=>c.url===downloadURL).length,1);assert.ok(calls.every(c=>!new Headers(c.init.headers).has('range')&&!c.url.includes('/api/update?')));
    assert.ok(bridges.every(x=>x.bridge.closed));assert.equal((await router.state()).busy,false);
  }
});
test('body cancellation closes a standalone bridge and sanitizes streamed transport failures',async()=>{
  let cancelled=0;const {router,bridges}=fixture({fetch:async()=>new Response(new ReadableStream({cancel(){cancelled++;}},{highWaterMark:0}))});
  const response=await router.fetch(downloadURL);await response.body.cancel();assert.equal(cancelled,1);assert.equal(bridges[0].bridge.closed,true);
  const broken=fixture({fetch:async()=>new Response(new ReadableStream({start(c){c.error(Error('private.invalid/?uuid=secret'));}}))});
  const stream=await broken.router.fetch(API_URL);await assert.rejects(stream.text(),error=>/内置更新代理连接失败/.test(error.message)&&!/secret|uuid|private/.test(error.message));assert.equal(broken.bridges[0].bridge.closed,true);
});

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
    netFetch:fetch('native'),onState:s=>states.push(s),now:overrides.now,createBridge:async options=>{
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
test('every attempt stays on the detected system proxy after connection failures with either builtin setting',async()=>{
  for(const native of [true,false])for(const enabled of [true,false]){
    const {router,calls,bridges,probes,resolved}=fixture({resolve:kind=>kind===(native?'native':'system')?'PROXY localhost:7890':'DIRECT',fetch:async()=>{throw Error('net::ERR_CONNECTION_CLOSED');}});
    await router.setEnabled(enabled);
    for(let attempt=0;attempt<3;attempt++){
      await router.setBusy(true,[API_URL]);
      await assert.rejects(router.fetch(API_URL),error=>error.code==='BRCLIO_UPDATE_NETWORK'&&!/localhost/.test(error.message));
    }
    assert.deepEqual(calls.map(value=>value.kind),Array(3).fill(native?'native':'system'));
    assert.equal((await router.state()).route,'system');assert.ok(resolved.length>=8);
    assert.equal(bridges.length,0);assert.equal(probes.length,0);await router.setBusy(false);
  }
});
test('transport failures are retryable, certificate failures permanent, and cancellation stays AbortError',async()=>{
  for(const failure of [Error('net::ERR_CONNECTION_CLOSED'),Error('Unknown private transport URL'),Object.assign(Error('closed'),{name:'TimeoutError'})]){
    const {router,calls}=fixture({resolve:()=> 'PROXY localhost:7890',fetch:async()=>{throw failure;}});
    await assert.rejects(router.fetch(API_URL),error=>error.code==='BRCLIO_UPDATE_NETWORK'&&!/private/.test(error.message));
    assert.deepEqual(calls.map(value=>value.kind),['native']);
  }
  for(const failure of [Error('net::ERR_CERT_AUTHORITY_INVALID'),Object.assign(Error('private peer'),{code:'ERR_CERT_DATE_INVALID'}),Error('net::ERR_SSL_PROTOCOL_ERROR')]){
    const {router}=fixture({resolve:()=> 'PROXY localhost:7890',fetch:async()=>{throw failure;}});
    await assert.rejects(router.fetch(API_URL),error=>error.code==='BRCLIO_UPDATE_SECURITY'&&!/private/.test(error.message));
  }
  const controller=new AbortController();
  const {router,calls}=fixture({resolve:()=> 'PROXY localhost:7890',fetch:async()=>{controller.abort();throw Error('net::ERR_CONNECTION_CLOSED');}});
  await assert.rejects(router.fetch(API_URL,{signal:controller.signal}),{name:'AbortError'});
  assert.deepEqual(calls.map(value=>value.kind),['native']);
});
test('replacing an active attempt keeps busy locked and awaits disposal before a fresh subscription and node probe',async()=>{
  let documents=0,release;
  const {router,calls,bridges,probes}=fixture({configFetch:async()=>new Response(JSON.stringify({...configuration(),nodes:[{...configuration().nodes[0],dialAddress:`1.1.1.${++documents}`}]}))});
  await router.setBusy(true,[API_URL]);await(await router.fetch(API_URL)).text();
  const old=bridges[0].bridge,gate=new Promise(resolve=>{release=resolve;});old.close=async()=>{await gate;old.closed=true;};
  let disposed=false;const replacement=router.setBusy(true,[API_URL]).then(()=>{disposed=true;});
  assert.equal((await router.state()).busy,true);assert.equal(disposed,false);assert.equal(documents,1);
  await assert.rejects(router.setEnabled(false),/检查或下载/);release();await replacement;assert.equal(old.closed,true);
  await(await router.fetch(API_URL)).text();
  assert.equal(documents,2);assert.equal(probes.length,2);assert.equal(calls.filter(value=>value.url===CONFIG_URL).length,2);
  assert.deepEqual(bridges.map(value=>value.options.nodes[0].dialAddress),['1.1.1.1','1.1.1.2']);await router.setBusy(false);
});
test('a failed builtin attempt never reuses its subscription, selection or bridge on the next attempt',async()=>{
  let documents=0,official=0;
  const {router,bridges,probes}=fixture({configFetch:async()=>new Response(JSON.stringify({...configuration(),nodes:[{...configuration().nodes[0],dialAddress:`1.1.1.${++documents}`}]})),fetch:async()=>{if(official++===0)throw Error('net::ERR_CONNECTION_RESET');return new Response('ok');}});
  await router.setBusy(true,[API_URL]);await assert.rejects(router.fetch(API_URL),{code:'BRCLIO_UPDATE_NETWORK'});
  await router.setBusy(true,[API_URL]);assert.equal(bridges[0].bridge.closed,true);
  assert.equal(await(await router.fetch(API_URL)).text(),'ok');assert.equal(documents,2);assert.equal(probes.length,2);
  assert.deepEqual(bridges.map(value=>value.options.nodes[0].dialAddress),['1.1.1.1','1.1.1.2']);await router.setBusy(false);
});
test('system HTTP responses are never rerouted and permanent address blocks retain their code',async()=>{
  for(const status of [403,407,429,500]){
    const {router,calls}=fixture({resolve:()=> 'PROXY localhost:7890',fetch:async()=>new Response(null,{status})});
    assert.equal((await router.fetch(API_URL)).status,status);assert.deepEqual(calls.map(value=>value.kind),['native']);
  }
  for(const response of [new Response(null,{status:403,headers:{'cf-mitigated':'challenge'}}),new Response(null,{status:302,headers:{location:'https://foreign.invalid/private'}})]){
    const {router,calls}=fixture({resolve:()=> 'PROXY localhost:7890',fetch:async()=>response});
    await assert.rejects(router.fetch(API_URL),{code:'BRCLIO_UPDATE_ROUTE'});assert.deepEqual(calls.map(value=>value.kind),['native']);
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
  let active=0,maximum=0,clock=0;const releases=new Map();
  const {router,calls,probes,bridges}=fixture({now:()=>clock,configFetch:async()=>new Response(JSON.stringify({...configuration(),nodes})),probe:async(url,init,sessionId)=>{
    assert.equal(url,'https://github.com/robots.txt');assert.equal(init.method,'HEAD');assert.equal(init.redirect,'manual');assert.equal(init.cache,'no-store');
    active++;maximum=Math.max(maximum,active);const index=Number(sessionId.split('-').at(-1));
    await new Promise(resolve=>{
      releases.set(index,resolve);
      if(releases.size===16)setImmediate(async()=>{
        clock=2;releases.get(7)();
        // Flush the actual measured probe completion at logical t=2 before
        // advancing the clock and completing every other candidate at t=20.
        await new Promise(setImmediate);clock=20;
        for(const [candidate,release]of releases)if(candidate!==7)release();
      });
    });active--;
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
test('fixed bootstrap alias runs only on the next outer attempt after primary network failure or explicit challenge',async()=>{
  for(const challenge of [false,true]){
    const {router,calls}=fixture({configFetch:async url=>{if(url===CONFIG_URL){if(challenge)return new Response(null,{status:403,headers:{'cf-mitigated':'challenge'}});throw Error('private transport URL');}return new Response(JSON.stringify(configuration()));}});
    await router.setBusy(true,[API_URL]);await assert.rejects(router.fetch(API_URL),{code:'BRCLIO_UPDATE_NETWORK'});
    assert.deepEqual(calls.map(c=>c.url),[CONFIG_URL]);
    await router.setBusy(true,[API_URL]);await(await router.fetch(API_URL)).text();
    assert.deepEqual(calls.map(c=>c.url),[CONFIG_URL,CONFIG_FALLBACK_URL,API_URL]);await router.setBusy(false);
    await router.setBusy(true,[API_URL]);await assert.rejects(router.fetch(API_URL),{code:'BRCLIO_UPDATE_NETWORK'});
    assert.equal(calls.at(-1).url,CONFIG_URL);await router.setBusy(false);
  }
  for(const status of [403,429,502]){
    const {router,calls}=fixture({configFetch:async()=>new Response(null,{status})});
    await assert.rejects(router.fetch(API_URL),error=>error.code===(status===502?'BRCLIO_UPDATE_NETWORK':'BRCLIO_UPDATE_ROUTE'));assert.equal(calls.length,1);
  }
  const certificate=fixture({configFetch:async()=>{throw Error('net::ERR_CERT_AUTHORITY_INVALID');}});
  await assert.rejects(certificate.router.fetch(API_URL),{code:'BRCLIO_UPDATE_SECURITY'});assert.equal(certificate.calls.length,1);
});
test('bootstrap access blocks are safely identified, unread bodies cancelled, and never retried',async()=>{
  for(const [status,headers,message] of [[403,{},/内置更新服务拒绝/],[429,{},/内置更新服务暂时限制/],[403,{'cf-mitigated':'challenge'},/内置更新代理连接失败/],[503,{},/内置更新代理连接失败/]]){
    let cancelled=0,read=0;
    const {router,calls,states,bridges}=fixture({configFetch:async()=>new Response(new ReadableStream({pull(){read++;throw Error('private URL/HTML');},cancel(){cancelled++;}},{highWaterMark:0}),{status,headers})});
    await assert.rejects(router.fetch(API_URL),message);assert.equal(cancelled,1);assert.equal(read,0);assert.equal(calls.length,1);assert.equal(bridges.length,0);
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

test('probe batches retain healthy alternatives, retry mixed network failures, and stop all-security failures',async()=>{
  for(const mode of ['healthy-alternative','mixed-network','all-security']){
    const nodes=[1,2].map(value=>({...configuration().nodes[0],dialAddress:`1.1.1.${value}`}));
    const f=fixture({configFetch:async()=>Response.json({...configuration(),nodes}),probe:async(_url,_init,sessionId)=>{
      const index=Number(sessionId.split('-').at(-1))-1;
      if(index===1&&mode==='healthy-alternative')return new Response(null,{status:200});
      f.bridges[index].bridge.failureCode=index===0||mode==='all-security'?'BRCLIO_UPDATE_SECURITY':'BRCLIO_UPDATE_NETWORK';
      throw Error('net::ERR_CONNECTION_CLOSED');
    }});
    if(mode==='healthy-alternative')assert.equal(await(await f.router.fetch(API_URL)).text(),'builtin');
    else await assert.rejects(f.router.fetch(API_URL),{code:mode==='all-security'?'BRCLIO_UPDATE_SECURITY':'BRCLIO_UPDATE_NETWORK'});
    assert.equal(f.probes.length,2);assert.ok(f.bridges.every(value=>value.bridge.closed));
  }
});

test('the updater owns exactly eleven failing system attempts and never bootstraps or switches routes',async()=>{
  const f=fixture({resolve:()=> 'PROXY localhost:7890',fetch:async()=>{throw Error('net::ERR_CONNECTION_CLOSED');}});
  const updater=createUpdater({currentVersion:'0.1.0',directory:'/unused-check-only',platform:'win32',architecture:'x64',retryDelay:0,
    fetch:f.router.fetch,onOperation:(_kind,busy,targets)=>f.router.setBusy(busy,targets)});
  const result=await updater.check();assert.equal(result.status,'error');assert.equal(result.retryExhausted,true);assert.equal(result.retryCount,10);
  assert.equal(f.calls.length,11);assert.ok(f.calls.every(value=>value.kind==='native'&&value.url===API_URL));
  assert.equal(f.bridges.length,0);assert.equal(f.probes.length,0);assert.equal((await f.router.state()).route,'system');assert.equal((await f.router.state()).busy,false);
});
test('known blocked headers or invalid config never wait for a stalled cancellation before permanent rejection',async()=>{
  for(const response of [new Response(new ReadableStream({cancel:()=>new Promise(()=>{})}),{status:403}),new Response(new ReadableStream({cancel:()=>new Promise(()=>{})}),{status:302,headers:{location:'https://foreign.invalid/private'}})]){
    const {router}=fixture({resolve:()=> 'PROXY localhost:7890',fetch:async()=>response});
    if(response.status===403)assert.equal((await router.fetch(API_URL)).status,403);
    else await assert.rejects(router.fetch(API_URL),{code:'BRCLIO_UPDATE_ROUTE'});
  }
  const invalid=fixture({configFetch:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{invalid'));controller.close();},cancel:()=>new Promise(()=>{})}))});
  await assert.rejects(invalid.router.fetch(API_URL),{code:'BRCLIO_UPDATE_ROUTE'});
});

test('fixed unsupported-configuration enum stops after one bootstrap while ordinary502 uses the single retry budget',async()=>{
  for(const [status,code,attempts]of [[502,'proxy_configuration_unsupported',1],[502,'proxy_configuration_unavailable',11],[403,'rate_limited',1],[429,'rate_limited',1]]){
    const f=fixture({configFetch:async()=>Response.json({code,error:'private-subscription-must-not-leak'},{status})});
    const updater=createUpdater({currentVersion:'0.1.0',directory:'/unused-check-only',platform:'win32',architecture:'x64',retryDelay:0,
      fetch:f.router.fetch,onOperation:(_kind,busy,targets)=>f.router.setBusy(busy,targets)});
    const result=await updater.check();assert.equal(result.status,'error');assert.equal(f.calls.length,attempts);
    assert.equal(result.retryExhausted,attempts===11);assert.equal(result.retryCount,attempts-1);
    assert.equal(f.probes.length,0);assert.ok(!JSON.stringify(result).includes('private-subscription'));
  }
  const oversized=fixture({configFetch:async()=>Response.json({padding:'x'.repeat(32768),code:'proxy_configuration_unsupported'},{status:502})});
  await assert.rejects(oversized.router.fetch(API_URL),error=>error.code==='BRCLIO_UPDATE_NETWORK'&&!/padding|unsupported/.test(error.message));
});

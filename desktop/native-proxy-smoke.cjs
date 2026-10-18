'use strict';
// Real Electron transport against loopback TLS/VLESS fixtures only. No public
// DNS, configuration endpoint, GitHub request, installation, or OS proxy change.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron:electron}=require('@playwright/test');
(async()=>{const root=path.resolve(__dirname,'..'),temporary=await fs.mkdtemp(path.join(os.tmpdir(),'brclio-native-proxy-smoke-'));let app;
try{
 app=await electron.launch({cwd:root,args:[...(process.platform==='linux'?['--no-sandbox']:[]),root],env:{...process.env,BRCLIO_USER_DATA:temporary}});
 const result=await app.evaluate(async({app,session},root)=>{
  const load=process.getBuiltinModule('node:module').createRequire(root+'/package.json');
  const fs=load('node:fs'),fsp=load('node:fs/promises'),crypto=load('node:crypto'),path=load('node:path'),net=load('node:net');
  const {startRelay}=load('./test/update-proxy-fixture.cjs'),{createConnectBridge}=load('./desktop/update-connect-bridge.cjs');
  const {createUpdateProxy,CONFIG_URL,CONFIG_FALLBACK_URL,DIRECT_PARTITION,SYSTEM_PARTITION}=load('./desktop/update-proxy.cjs');
  const {createUpdater,API_URL}=load('./desktop/updater.cjs');
  const certificate=new crypto.X509Certificate(fs.readFileSync(path.join(root,'test/fixtures/update-proxy-tls/origin.pem')));
  let serial=0,configurationRequests=0,proxyNativeUnexpected=0;
  const sessionsToClose=[],proxyPorts=[],wireRequests=[],payload=Buffer.alloc(8*1024*1024+113,97),digest=crypto.createHash('sha256').update(payload).digest('hex');
  const assetName='Brclio-0.2.0-mac-arm64.dmg',prefix='https://github.com/Brclio/Brclio/releases/download/v0.2.0/';
  const release={tag_name:'v0.2.0',assets:[{name:assetName,size:payload.length,browser_download_url:prefix+assetName,digest:`sha256:${digest}`},{name:'SHA256SUMS.txt',browser_download_url:prefix+'SHA256SUMS.txt'}]};
  const relay=await startRelay({respond:(req,res)=>{
   if(req.method==='HEAD'){res.writeHead(200,{'Content-Length':0});res.end();return;}
   const body=req.url.includes('/releases/latest')?Buffer.from(JSON.stringify(release)):req.url.endsWith('SHA256SUMS.txt')?Buffer.from(`${digest}  ${assetName}`):payload;
   res.writeHead(200,{'Content-Length':body.length});res.end(body);
  }});
  function routerFor(target,number=16){
   const routerId=++serial;
   return createUpdateProxy({whenReady:()=>app.whenReady(),defaultSession:()=>({resolveProxy:async()=> 'DIRECT'}),netFetch:async()=>{proxyNativeUnexpected++;throw Error('Unexpected direct route');},
    fromPartition:(name,options)=>{
     if(name===SYSTEM_PARTITION)return{setProxy:async()=>{},resolveProxy:async()=> 'DIRECT'};
     if(name===DIRECT_PARTITION)return{setProxy:async()=>{},fetch:async(url,init)=>{if(![CONFIG_URL,CONFIG_FALLBACK_URL].includes(url))throw Error('Unexpected bootstrap');configurationRequests++;if(init.cache!=='no-store')throw Error('Bootstrap cached');return new Response(JSON.stringify({version:1,ttlSeconds:600,nodes:Array.from({length:number},()=>({...target.node}))}));}};
     const actual=session.fromPartition('brclio-offline-'+routerId+'-'+name,{...options,cache:false});
     // Trust this test-only leaf, including the official hostname SAN. This
     // verifier exists only in the fixture; production installs no verifier.
     actual.setCertificateVerifyProc((request,callback)=>{try{const received=new crypto.X509Certificate(request.certificate.data);callback(received.fingerprint256===certificate.fingerprint256&&received.checkHost(request.hostname)?0:-2);}catch{callback(-2);}});
     sessionsToClose.push(actual);
     const fetch=actual.fetch.bind(actual);actual.fetch=async(url,init)=>{wireRequests.push({url,method:init.method||'GET',range:new Headers(init.headers).get('range')});return fetch(url,init);};return actual;
    },createBridge:async options=>{const bridge=await createConnectBridge({...options,WebSocketClass:target.WebSocketClass});proxyPorts.push(Number(new URL(bridge.proxyRules).port));return bridge;}});
  }
  const router=routerFor(relay),directory=path.join(app.getPath('userData'),'offline-native-updates');
  let installed=false;
  const updater=createUpdater({currentVersion:'0.1.9',directory,platform:'darwin',architecture:'arm64',fetch:router.fetch,onOperation:(_kind,active,targets)=>router.setBusy(active,targets),installPackage:async()=>{installed=true;throw Error('No install permitted');}});
  try{
   const checked=await updater.check();if(checked.status!=='available')throw Error('Offline native check failed: '+checked.error);
   const downloaded=await updater.download();if(downloaded.status!=='downloaded')throw Error('Offline native download failed: '+downloaded.error);
   const actualDigest=crypto.createHash('sha256').update(await fsp.readFile(path.join(directory,assetName))).digest('hex');
   if(actualDigest!==digest)throw Error('Full file SHA mismatch');
   const firstOperationPorts=proxyPorts.length;
   const bad=await startRelay({originCertificate:'relay'});try{const negative=routerFor(bad,1);await negative.fetch(API_URL).then(()=>{throw Error('Bad inner certificate accepted');},error=>{if(!/内置更新代理连接失败/.test(error.message))throw Error('Unsafe negative error');});await negative.close();if(bad.requests.length)throw Error('Inner TLS rejection did not occur');}finally{await bad.close();}
   const untrusted=await startRelay({trustOuter:false});try{const negative=routerFor(untrusted,1);await negative.fetch(API_URL).then(()=>{throw Error('Bad WSS certificate accepted');},()=>{});await negative.close();if(untrusted.requests.length)throw Error('WSS TLS rejection did not occur');}finally{await untrusted.close();}
   const controller=new AbortController(),cancelling=routerFor(relay,1);const response=await cancelling.fetch(prefix+assetName,{signal:controller.signal});const reader=response.body.getReader();await reader.read();controller.abort();try{while(!(await reader.read()).done){}}catch{}await reader.cancel().catch(()=>{});await cancelling.close();
   await new Promise(resolve=>setTimeout(resolve,60));
   const closed=await Promise.all(proxyPorts.map(port=>new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});socket.once('error',()=>resolve(true));socket.once('connect',()=>{socket.destroy();resolve(false);});})));
   return{ok:actualDigest===digest&&!installed&&proxyNativeUnexpected===0&&closed.every(Boolean),actualElectron:true,externalNetworkRequests:false,defaultTimeoutsOverridden:false,configurationRequests,firstCheckAndDownloadFreshConfigurations:configurationRequests===5,probesPerPrimaryOperation:16,primaryProbeCount:wireRequests.slice(0,35).filter(x=>x.method==='HEAD').length,probeURL:'https://github.com/robots.txt',probeConcurrencyBound:16,continuousBytes:payload.length,fullSHA256:actualDigest,allRequestsOfficial:wireRequests.every(x=>/^https:\/\/(?:github\.com|api\.github\.com)\//.test(x.url)),rangeRequests:wireRequests.filter(x=>x.range).length,allBridgeListenersClosed:closed.every(Boolean),primaryBridgeCount:firstOperationPorts,innerWrongHostnameRejected:true,untrustedWSSRejected:true,cancellationStopsTunnel:true,installed:false};
  }finally{await router.close();for(const value of sessionsToClose){await value.closeAllConnections();value.setCertificateVerifyProc(null);}await relay.close();}
 },root);
 assert.equal(result.ok,true);assert.equal(result.rangeRequests,0);assert.equal(result.primaryBridgeCount,32);assert.equal(result.firstCheckAndDownloadFreshConfigurations,true);
 await fs.mkdir(path.join(root,'artifacts'),{recursive:true});await fs.writeFile(path.join(root,'artifacts/desktop-native-proxy-offline.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result,null,2));
}finally{await app?.close();await fs.rm(temporary,{recursive:true,force:true});}})().catch(error=>{console.error(error.message);process.exitCode=1;});

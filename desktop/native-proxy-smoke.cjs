'use strict';
// Real Electron transport against loopback TLS/VLESS fixtures only. No public
// DNS, configuration endpoint, GitHub request, installation, or OS proxy change.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron:electron}=require('@playwright/test');
(async()=>{const root=path.resolve(__dirname,'..'),temporary=await fs.mkdtemp(path.join(os.tmpdir(),'brclio-native-proxy-smoke-'));let app;
try{
 const driver=path.join(temporary,'driver.cjs');
 await fs.writeFile(driver,`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(temporary,'profile'))});app.whenReady().then(()=>new BrowserWindow({show:false}));app.on('window-all-closed',()=>{});`);
 app=await electron.launch({cwd:root,args:[...(process.platform==='linux'?['--no-sandbox']:[]),driver]});
 const result=await app.evaluate(async({app,session,net:electronNet},root)=>{
  const load=process.getBuiltinModule('node:module').createRequire(root+'/package.json');
  const fs=load('node:fs'),fsp=load('node:fs/promises'),crypto=load('node:crypto'),path=load('node:path'),net=load('node:net');
  const {startRelay}=load('./test/update-proxy-fixture.cjs'),{createConnectBridge}=load('./desktop/update-connect-bridge.cjs');
  const {createUpdateProxy,CONFIG_URL,CONFIG_FALLBACK_URL,DIRECT_PARTITION,SYSTEM_PARTITION}=load('./desktop/update-proxy.cjs');
  const {electronUpdateFetch}=load('./desktop/electron-update-fetch.cjs');
  const {createUpdater,API_URL}=load('./desktop/updater.cjs');
  const certificate=new crypto.X509Certificate(fs.readFileSync(path.join(root,'test/fixtures/update-proxy-tls/origin.pem')));
  let serial=0,configurationRequests=0,proxyNativeUnexpected=0;
  const sessionsToClose=[],proxyPorts=[],wireRequests=[],payload=Buffer.alloc(8*1024*1024+113,97),digest=crypto.createHash('sha256').update(payload).digest('hex');
  const assetName='Brclio-0.2.0-mac-arm64.dmg',prefix='https://github.com/Brclio/Brclio/releases/download/v0.2.0/';
  const release={tag_name:'v0.2.0',assets:[{name:assetName,size:payload.length,browser_download_url:prefix+assetName,digest:`sha256:${digest}`},{name:'SHA256SUMS.txt',browser_download_url:prefix+'SHA256SUMS.txt'}]};
  const relay=await startRelay({http2:true,respond:(req,res)=>{
   if(req.method==='HEAD'){res.writeHead(200,{'Content-Length':0});res.end();return;}
   if(req.url.startsWith('/Brclio/Brclio/releases/download/')){res.writeHead(302,{Location:'https://release-assets.githubusercontent.com/verified/'+req.url.split('/').pop()});res.end();return;}
   const body=req.url.includes('/releases/latest')?Buffer.from(JSON.stringify(release)):req.url.endsWith('SHA256SUMS.txt')?Buffer.from(`${digest}  ${assetName}`):payload;
   res.writeHead(200,{'Content-Length':body.length});res.end(body);
  }});
  function routerFor(target,number=16){
   const routerId=++serial;
   return createUpdateProxy({whenReady:()=>app.whenReady(),defaultSession:()=>({resolveProxy:async()=> 'DIRECT'}),netFetch:async()=>{proxyNativeUnexpected++;throw Error('Unexpected direct route');},
    fetchSession:(value,url,init)=>{if(!sessionsToClose.includes(value))return value.fetch(url,init);wireRequests.push({url,method:init.method||'GET',range:new Headers(init.headers).get('range')});return electronUpdateFetch(options=>electronNet.request(options),value,url,init);},
    fromPartition:(name,options)=>{
     if(name===SYSTEM_PARTITION)return{setProxy:async()=>{},resolveProxy:async()=> 'DIRECT'};
     if(name===DIRECT_PARTITION)return{setProxy:async()=>{},fetch:async(url,init)=>{if(![CONFIG_URL,CONFIG_FALLBACK_URL].includes(url))throw Error('Unexpected bootstrap');configurationRequests++;if(init.cache!=='no-store')throw Error('Bootstrap cached');return new Response(JSON.stringify({version:1,ttlSeconds:600,nodes:Array.from({length:number},()=>({...target.node}))}));}};
     const actual=session.fromPartition('brclio-offline-'+routerId+'-'+name,{...options,cache:false});
     // Trust this test-only leaf, including the official hostname SAN. This
     // verifier exists only in the fixture; production installs no verifier.
     // Return Chromium's actual certificate errors (-200/-202/-207), rather
     // than generic FAILED (-2), so retry classification receives the TLS cause.
     actual.setCertificateVerifyProc((request,callback)=>{try{const received=new crypto.X509Certificate(request.certificate.data);callback(!received.checkHost(request.hostname)?-200:received.fingerprint256===certificate.fingerprint256?0:-202);}catch{callback(-207);}});
     sessionsToClose.push(actual);
     return actual;
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
   const h1=await startRelay({respond:(req,res)=>{if(req.method==='HEAD'){res.writeHead(200);res.end();return;}if(req.url.endsWith('SHA256SUMS.txt')){res.writeHead(302,{Location:'https://objects.githubusercontent.com/verified-checksum'});res.end();return;}res.end(`${digest}  ${assetName}`);}});
   try{
    const manual=session.fromPartition('brclio-offline-manual-redirect',{cache:false});sessionsToClose.push(manual);
    manual.setCertificateVerifyProc((request,callback)=>{try{const received=new crypto.X509Certificate(request.certificate.data);callback(!received.checkHost(request.hostname)?-200:received.fingerprint256===certificate.fingerprint256?0:-202);}catch{callback(-207);}});
    const bridge=await createConnectBridge({nodes:[h1.node],WebSocketClass:h1.WebSocketClass});proxyPorts.push(Number(new URL(bridge.proxyRules).port));
    try{await manual.setProxy({mode:'fixed_servers',proxyRules:bridge.proxyRules,proxyBypassRules:'<-loopback>'});const first=await electronUpdateFetch(options=>electronNet.request(options),manual,prefix+'SHA256SUMS.txt');if(first.status!==302||h1.requests.length!==1)throw Error('Native redirect followed before validation');}finally{await manual.closeAllConnections();await bridge.close();}
    const redirected=routerFor(h1,1);const value=await redirected.fetch(prefix+'SHA256SUMS.txt');if(!(await value.text()).includes(digest))throw Error('HTTP1 redirect failed');await redirected.close();if(!h1.requests.every(value=>value.httpVersion==='1.1'))throw Error('HTTP1 fixture unused');
   }finally{await h1.close();}
   const evil=await startRelay({respond:(req,res)=>{if(req.method==='HEAD'){res.writeHead(200);res.end();return;}res.writeHead(302,{Location:'https://evil.invalid/forbidden'});res.end();}});
   try{const redirected=routerFor(evil,1);await redirected.fetch(prefix+'SHA256SUMS.txt').then(()=>{throw Error('Unsafe redirect accepted');},error=>{if(!/非官方地址/.test(error.message))throw error;});await redirected.close();if(evil.requests.length!==2)throw Error('Unsafe redirect reached destination');}finally{await evil.close();}
   const truncated=await startRelay({respond:(req,res)=>{if(req.method==='HEAD'){res.writeHead(200);res.end();return;}res.writeHead(200,{'Content-Length':10000});res.write(Buffer.alloc(100));setTimeout(()=>res.destroy(),15);}});
   try{const broken=routerFor(truncated,1);try{const response=await broken.fetch(prefix+assetName);await response.text();throw Error('Truncated response accepted');}catch(error){if(!/内置更新代理连接失败/.test(error.message))throw error;}finally{await broken.close();}}finally{await truncated.close();}
   const bad=await startRelay({originCertificate:'relay'});try{const negative=routerFor(bad,1);await negative.fetch(API_URL).then(()=>{throw Error('Bad inner certificate accepted');},error=>{if(error.code!=='BRCLIO_UPDATE_SECURITY'||!/证书验证失败/.test(error.message))throw Error('Unsafe negative error');});await negative.close();if(bad.requests.length)throw Error('Inner TLS rejection did not occur');}finally{await bad.close();}
   const untrusted=await startRelay({trustOuter:false});try{const negative=routerFor(untrusted,1);await negative.fetch(API_URL).then(()=>{throw Error('Bad WSS certificate accepted');},error=>{if(error.code!=='BRCLIO_UPDATE_SECURITY')throw Error('Outer TLS failure must stop automatic retries');});await negative.close();if(untrusted.requests.length)throw Error('WSS TLS rejection did not occur');}finally{await untrusted.close();}
   const controller=new AbortController(),cancelling=routerFor(relay,1);const response=await cancelling.fetch(prefix+assetName,{signal:controller.signal});const reader=response.body.getReader();await reader.read();controller.abort();try{while(!(await reader.read()).done){}}catch{}await reader.cancel().catch(()=>{});await cancelling.close();
   await new Promise(resolve=>setTimeout(resolve,60));
   const closed=await Promise.all(proxyPorts.map(port=>new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});socket.once('error',()=>resolve(true));socket.once('connect',()=>{socket.destroy();resolve(false);});})));
   return{ok:actualDigest===digest&&!installed&&proxyNativeUnexpected===0&&closed.every(Boolean),actualElectron:true,externalNetworkRequests:false,defaultTimeoutsOverridden:false,configurationRequests,firstCheckAndDownloadFreshConfigurations:configurationRequests===8,probesPerPrimaryOperation:16,primaryProbeCount:wireRequests.slice(0,37).filter(x=>x.method==='HEAD').length,probeURL:'https://github.com/robots.txt',probeConcurrencyBound:16,continuousBytes:payload.length,fullSHA256:actualDigest,allRequestsOfficial:wireRequests.every(x=>/^https:\/\/(?:github\.com|api\.github\.com|release-assets\.githubusercontent\.com|objects\.githubusercontent\.com)\//.test(x.url)),rangeRequests:wireRequests.filter(x=>x.range).length,allBridgeListenersClosed:closed.every(Boolean),primaryBridgeCount:firstOperationPorts,http2Used:relay.requests.some(value=>value.httpVersion==='2.0'),http1RedirectVerified:true,http2ChecksumAndInstallerRedirectsVerified:true,nativeRedirectReturnedBeforeFollow:true,unsafeRedirectNeverFollowed:true,truncatedBodyRejected:true,innerWrongHostnameRejected:true,untrustedWSSRejected:true,cancellationStopsTunnel:true,installed:false};
  }finally{await router.close();for(const value of sessionsToClose){await value.closeAllConnections();value.setCertificateVerifyProc(null);}await relay.close();}
 },root);
 Object.assign(result,await app.evaluate(async(electron,root)=>{
  const load=process.getBuiltinModule('node:module').createRequire(root+'/package.json');
  return{resume:await load('./test/native-resume-verifier.cjs').verifyNativeResume(electron,root)};
 },root));
 // Exercise the exact release-install fixture in real Electron. Its original
 // net.fetch delegates dynamically to net.request, which a VM stub cannot model.
 Object.assign(result,await app.evaluate(async({app,net,session},root)=>{
  const load=process.getBuiltinModule('node:module').createRequire(root+'/package.json'),fs=load('node:fs/promises'),path=load('node:path'),crypto=load('node:crypto'),vm=load('node:vm'),{pathToFileURL}=load('node:url');
  const {electronUpdateFetch}=load('./desktop/electron-update-fetch.cjs');
  const source=await fs.readFile(path.join(root,'desktop/mac-installer-smoke.cjs'),'utf8'),marker='await application.evaluate(({ net, session }, fixture) => {',start=source.indexOf(marker),end=source.indexOf('\n    }, { version: targetVersion',start);
  if(start<0||end<=start)throw Error('Missing native-install fixture callback');
  const inject=vm.runInThisContext('('+source.slice(start+'await application.evaluate('.length,end)+'\n})');
  const filename=path.join(app.getPath('userData'),"真实 DMG & ' space.dmg"),body=crypto.randomBytes(2*1024*1024+37),digest=crypto.createHash('sha256').update(body).digest('hex');
  await fs.writeFile(filename,body);let nativeFileRequests=0;
  try{
   inject({net,session},{version:'0.2.0',architecture:'arm64',fileURL:pathToFileURL(filename).href,size:body.length,expected:digest});
   const request=net.request;net.request=options=>{if(new URL(options.url).protocol==='file:')nativeFileRequests++;return request(options);};
   const response=await electronUpdateFetch(options=>net.request(options),session.defaultSession,'https://github.com/Brclio/Brclio/releases/download/v0.2.0/Brclio-0.2.0-mac-arm64.dmg');
   const actual=Buffer.from(await response.arrayBuffer());
   if(actual.length!==body.length||crypto.createHash('sha256').update(actual).digest('hex')!==digest||nativeFileRequests!==0)throw Error('Real local DMG fixture bytes were not preserved independently of network mocks');
   return{macInstallerFixtureRealFileBytes:actual.length,macInstallerFixtureSHA256:digest,macInstallerFixtureNativeFileRequests:nativeFileRequests,macInstallerFixtureReadVerified:true};
  }finally{await fs.rm(filename,{force:true});}
 },root));
 assert.equal(result.ok,true);assert.equal(result.rangeRequests,0);assert.equal(result.primaryBridgeCount,32);assert.equal(result.firstCheckAndDownloadFreshConfigurations,true);assert.equal(result.resume.passed,true);
 await fs.mkdir(path.join(root,'artifacts'),{recursive:true});await fs.writeFile(path.join(root,'artifacts/desktop-native-proxy-offline.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result,null,2));
}finally{await app?.close();await fs.rm(temporary,{recursive:true,force:true});}})().catch(error=>{console.error(error.message);process.exitCode=1;});

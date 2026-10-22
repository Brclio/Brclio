import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import {officialTarget, publicHTTPS, redirectTarget} from '../src/protocol.js';
import {smokeResponseDiagnostic} from '../scripts/smoke-segment.mjs';
import {parseProxyConfiguration, bootstrapFallbackOrigin} from '../scripts/native-transport.mjs';

const source=(await readFile(new URL('../scripts/verify-live.mjs',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
const block=new Uint8Array(128*1024);
function zeroDigest(size){const hash=createHash('sha256');for(let left=size;left>0;left-=block.length)hash.update(block.subarray(0,Math.min(left,block.length)));return hash.digest('hex');}
const base='https://github.com/Brclio/Brclio/releases/download/v0.1.8/';
const installers=[{name:'Brclio-0.1.8-android.apk',size:3},{name:'Brclio-0.1.8-windows-x64.exe',size:100*1024*1024+1}].map(asset=>({...asset,browser_download_url:base+asset.name,digest:'sha256:'+zeroDigest(asset.size)}));
const manifest=new TextEncoder().encode(installers.map(asset=>asset.digest.slice(7)+'  '+asset.name+'\n').join(''));
const release={tag_name:'v0.1.8',draft:false,prerelease:false,assets:[...installers,{name:'SHA256SUMS.txt',size:manifest.length,browser_download_url:base+'SHA256SUMS.txt',digest:'sha256:'+createHash('sha256').update(manifest).digest('hex')}]};
const node={uuid:'00112233-4455-6677-8899-aabbccddeeff',host:'vpn.example.com',port:443,path:'/tunnel',servername:'vpn.example.com',wsHost:'vpn.example.com',dialAddress:'104.17.1.1'};
const configuration={version:1,ttlSeconds:600,nodes:[node]};

function clockFixture(){
  let now=0,nextId=0;const timers=new Map(),delays=[];
  return{get now(){return now;},get pending(){return timers.size;},delays,
    setTimeout(callback,delay){const id=++nextId;timers.set(id,{callback,at:now+delay});delays.push(delay);return id;},
    clearTimeout(id){timers.delete(id);},
    advance(milliseconds){const end=now+milliseconds;for(;;){const due=[...timers].filter(([,value])=>value.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;now=due[1].at;timers.delete(due[0]);due[1].callback();}now=end;},
  };
}

async function run({large=false,failStage,challenge=false,badRedirect=false,rawError=false,clock,chunkDelayMs=0,headerDelayMs=0}={}){
  const processFixture={argv:['node','verify-live.mjs',...(large?['--large']:[])],env:{}};
  const selected=installers[large?1:0],calls=[];let report,closed=0;
  const fetchImpl=async(url,options)=>{
    assert.equal(new URL(url).pathname,'/api/client/update-proxy');assert.equal(options.headers['User-Agent'],'Brclio-Updater/1.0');assert.equal(options.redirect,'manual');assert.equal(options.cache,'no-store');calls.push({kind:'configuration',host:new URL(url).hostname});
    if(failStage==='bootstrap')return new Response('secret-html-body 203.0.113.77',{status:403,headers:{'cf-mitigated':challenge?'challenge':'private-value','cf-ray':'a4c8dae1ad56b8f0-ORD',server:'cloudflare'}});
    return Response.json(configuration);
  };
  const nativeHTTPSRequest=async(url,options)=>{
    assert.equal(options.headers['User-Agent'],'Brclio-Updater/1.0');assert.equal(options.headers.Range,undefined);assert.ok(options.bridge.native);assert.ok(options.signal instanceof AbortSignal);calls.push({kind:'native',url});
    const current=url.includes('api.github.com')?'metadata':url.endsWith('SHA256SUMS.txt')?'manifest':'installer';
    if(current===failStage){
      if(rawError)throw Error('https://private.example/secret 203.0.113.77');
      return new Response('secret-html-body 203.0.113.77',{status:403,headers:{'cf-mitigated':'challenge','cf-ray':'a4c8dae1ad56b8f0-ORD',server:'https://private.example/server',location:'https://private.example/location'}});
    }
    if(badRedirect&&current==='installer')return new Response(null,{status:302,headers:{location:'https://private.example/redirect?secret=value'}});
    if(current==='metadata')return Response.json(release);
    if(current==='manifest')return new Response(manifest);
    assert.equal(url,selected.browser_download_url);let remaining=selected.size;
    const checkCancelled=()=>{if(options.signal.aborted)throw Object.assign(Error('fixture request cancelled'),{name:'AbortError'});};
    clock?.advance(headerDelayMs);checkCancelled();
    return new Response(new ReadableStream({pull(controller){if(!remaining){controller.close();return;}clock?.advance(chunkDelayMs);checkCancelled();const size=Math.min(remaining,block.length);remaining-=size;controller.enqueue(block.subarray(0,size));}},{highWaterMark:0}),{headers:{'Content-Length':String(selected.size)}});
  };
  await vm.runInNewContext(`(async()=>{${source}\n})()`,{assert,createHash,officialTarget,publicHTTPS,redirectTarget,smokeResponseDiagnostic,parseProxyConfiguration,bootstrapFallbackOrigin,fetch:fetchImpl,nativeHTTPSRequest,
    selectNativeNodes:async(nodes,signal)=>{assert.equal(nodes.length,1);assert.ok(signal instanceof AbortSignal);return{nodes,candidates:1,reachable:1,latencyMs:7};},
    createSelectedBridge:async()=>({native:true,close:async()=>{closed++;}}),process:processFixture,URL,Headers,AbortSignal,AbortController,Uint8Array,TextDecoder,
    Date:clock?{now:()=>clock.now}:Date,setTimeout:clock?clock.setTimeout:setTimeout,clearTimeout:clock?clock.clearTimeout:clearTimeout,console:{log:value=>{report=JSON.parse(value);}}});
  return{report,calls,closed,exitCode:processFixture.exitCode};
}

for(const large of [false,true])test(`native smoke ${large?'large':'standard'} refreshes each operation and validates complete GitHub metadata, manifest and installer SHA`,async()=>{
  const result=await run({large});assert.equal(result.exitCode,undefined);assert.equal(result.report.ok,true);assert.equal(result.report.asset,installers[large?1:0].name);assert.equal(result.report.bytes,installers[large?1:0].size);assert.equal(result.report.configurationRefreshes,2);assert.equal(result.report.retryCount,0);assert.equal(result.report.downloadMode,'client-native-vless-wss-stream');assert.equal(result.report.manifestVerified,true);
  assert.equal(result.calls.filter(item=>item.kind==='configuration').length,2);assert.equal(result.calls.filter(item=>item.kind==='native').length,3);assert.equal(result.closed,2);assert.ok(!result.calls.some(item=>item.url?.includes('/api/update?')));
});

test('native smoke completes a continuously progressing download beyond ten minutes with its full SHA and no total deadline',async()=>{
  const clock=clockFixture(),result=await run({large:true,clock,chunkDelayMs:1000});
  assert.equal(result.report.ok,true);assert.equal(result.exitCode,undefined);assert.ok(result.report.durationMs>10*60*1000);
  assert.equal(result.report.bytes,installers[1].size);assert.equal(result.report.sha256,installers[1].digest.slice(7));assert.equal(result.report.manifestVerified,true);
  assert.deepEqual(result.report.defaultTimeoutsMs,{checkAndManifest:20000,idle:45000,downloadTotal:null});assert.equal(result.report.timeoutOverrides,false);
  assert.ok(clock.delays.includes(20000)&&clock.delays.includes(45000));assert.ok(clock.delays.every(delay=>[20000,45000].includes(delay)));
  assert.equal(clock.pending,0);assert.equal(result.closed,2);
});

for(const stalled of ['headers','body'])test(`native smoke retains the installer ${stalled==='headers'?'20-second connection':'45-second idle'} timeout without a total deadline`,async()=>{
  const clock=clockFixture(),result=await run({clock,headerDelayMs:stalled==='headers'?20001:0,chunkDelayMs:stalled==='body'?45001:0});
  assert.equal(result.exitCode,1);assert.equal(result.report.ok,false);assert.equal(result.report.stage,'installer');assert.equal(result.report.errorEnum,'timeout_or_cancelled');assert.equal(result.report.bytes,0);
  assert.equal(result.report.defaultTimeoutsMs.downloadTotal,null);assert.equal(clock.pending,0);assert.equal(result.closed,2);
});

for(const failStage of ['bootstrap','metadata','manifest','installer'])test(`native smoke preserves safe structured ${failStage} HTTP failure evidence`,async()=>{
  const {report,exitCode}=await run({failStage,challenge:true});assert.equal(exitCode,1);assert.equal(report.stage,failStage);assert.equal(report.status,403);assert.equal(report.cfMitigatedEnum,'challenge');assert.equal(report.errorEnum,'http_status');assert.equal(report.bytes,0);assert.equal(report.retryCount,0);
  for(const forbidden of ['secret-html-body','203.0.113.77','private.example','api.github.com'])assert.ok(!JSON.stringify(report).includes(forbidden));
});
test('native smoke rejects a private redirect and hides raw transport exception messages',async()=>{
  const redirected=await run({badRedirect:true});assert.equal(redirected.exitCode,1);assert.equal(redirected.report.stage,'installer');assert.equal(redirected.report.errorEnum,'invalid_redirect');assert.ok(!JSON.stringify(redirected.report).includes('private.example'));
  const failed=await run({failStage:'metadata',rawError:true});assert.equal(failed.report.errorEnum,'network_failed');assert.equal(failed.report.status,null);assert.ok(!JSON.stringify(failed.report).includes('private.example'));assert.ok(!JSON.stringify(failed.report).includes('203.0.113.77'));
});
test('actual executable emits nonempty failure JSON and exits1 for bootstrap403 challenge without logging nodes or HTML',()=>{
  const preload='globalThis.fetch=async()=>new Response("<html>203.0.113.77 private-fixture https://private.example/secret</html>",{status:403,headers:{"cf-ray":"a4c8dae1ad56b8f0-ORD","cf-mitigated":"challenge",server:"cloudflare"}});';
  const result=spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preload),new URL('../scripts/verify-live.mjs',import.meta.url).pathname],{encoding:'utf8',timeout:5000});
  assert.equal(result.error,undefined);assert.equal(result.status,1);assert.equal(result.stderr,'');const report=JSON.parse(result.stdout);assert.equal(report.stage,'bootstrap');assert.equal(report.status,403);assert.equal(report.bootstrapAttempts,2);assert.equal(report.cfMitigatedEnum,'challenge');assert.equal(report.service,'https://tools.brclio.com');
  for(const forbidden of ['private.example','203.0.113.77','private-fixture','<html>','api.github.com'])assert.ok(!result.stdout.includes(forbidden));
});

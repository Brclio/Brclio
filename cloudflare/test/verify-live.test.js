import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import {officialTarget, publicHTTPS} from '../src/protocol.js';
import {smokeSegment, smokeResponseDiagnostic} from '../scripts/smoke-segment.mjs';

const source=(await readFile(new URL('../scripts/verify-live.mjs',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
const block=new Uint8Array(128*1024);
function zeroDigest(size){const hash=createHash('sha256');for(let left=size;left>0;left-=block.length)hash.update(block.subarray(0,Math.min(left,block.length)));return hash.digest('hex');}
const base='https://github.com/Brclio/Brclio/releases/download/v0.1.8/';
const installers=[{name:'Brclio-0.1.8-android.apk',size:3},{name:'Brclio-0.1.8-windows-x64.exe',size:100*1024*1024+1}].map(asset=>({...asset,browser_download_url:base+asset.name,digest:'sha256:'+zeroDigest(asset.size)}));
const manifest=new TextEncoder().encode(installers.map(asset=>asset.digest.slice(7)+'  '+asset.name+'\n').join(''));
const release={tag_name:'v0.1.8',assets:[...installers,{name:'SHA256SUMS.txt',size:manifest.length,browser_download_url:base+'SHA256SUMS.txt',digest:'sha256:'+createHash('sha256').update(manifest).digest('hex')}]};

for(const large of [false,true])test(`live smoke ${large?'large':'standard'} sends the updater User-Agent for metadata, manifest, every range and503 recovery`,async()=>{
  const selected=installers[large?1:0];const calls=[];let recovered=false,report;
  const fetchImpl=async(url,options)=>{
    const headers=new Headers(options.headers),target=new URL(url).searchParams.get('url');
    assert.equal(headers.get('user-agent'),'Brclio-Updater/1.0');
    assert.ok(options.signal instanceof AbortSignal);calls.push({target,range:headers.get('range'),ifRange:headers.get('if-range')});
    if(target==='https://api.github.com/repos/Brclio/Brclio/releases/latest')return Response.json(release,{headers:{'X-Brclio-Route':'subscription-vless'}});
    if(target===base+'SHA256SUMS.txt')return new Response(manifest,{headers:{'X-Brclio-Route':'subscription-vless'}});
    assert.equal(target,selected.browser_download_url);
    const match=/^bytes=(\d+)-(\d+)$/.exec(headers.get('range'));assert.ok(match);
    const start=Number(match[1]),end=Number(match[2]);
    if(start)assert.equal(headers.get('if-range'),'"fixture"');
    if(!recovered){recovered=true;return new Response('<title>Service Unavailable</title>',{status:503});}
    return new Response(block.subarray(0,end-start+1),{status:206,headers:{'X-Brclio-Route':'subscription-vless','Content-Range':`bytes ${start}-${end}/${selected.size}`,'Content-Length':String(end-start+1),ETag:'"fixture"'}});
  };
  await vm.runInNewContext(`(async()=>{${source}\n})()`,{assert,createHash,officialTarget,publicHTTPS,smokeResponseDiagnostic,smokeSegment:(url,options)=>smokeSegment(url,{...options,fetchImpl,delay:async ms=>assert.equal(ms,500)}),fetch:fetchImpl,process:{argv:['node','verify-live.mjs',...(large?['--large']:[])],env:{}},URL,Headers,AbortSignal,Uint8Array,TextDecoder,Date,console:{log:value=>{report=JSON.parse(value);}}});
  assert.equal(report.ok,true);assert.equal(report.asset,selected.name);assert.equal(report.bytes,selected.size);assert.equal(report.retryCount,1);
  assert.equal(calls.length,report.segments+3);assert.equal(calls[0].range,null);assert.equal(calls[1].range,null);
  assert.deepEqual(calls[2],calls[3]);
});

test('actual smoke executable emits safe nonempty JSON and exits nonzero for metadata403 challenge',()=>{
  const privateURL='https://private.example/redirect?token=fixture-secret';
  const html=`<html><title>Check ${privateURL}</title>203.0.113.77 secret-html-body</html>`;
  const preload='globalThis.fetch=async(url,options)=>{if(new Headers(options.headers).get("user-agent")!=="Brclio-Updater/1.0")throw Error("missing UA");return new Response('+JSON.stringify(html)+',{status:403,headers:{"cf-ray":"a4c8dae1ad56b8f0-ORD","cf-mitigated":"challenge",server:"cloudflare",location:'+JSON.stringify(privateURL)+'}});};';
  const result=spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preload),new URL('../scripts/verify-live.mjs',import.meta.url).pathname,'https://tools.brclio.com/path?private-fixture'],{encoding:'utf8',timeout:5000});
  assert.equal(result.error,undefined);assert.equal(result.status,1);assert.equal(result.stderr,'');assert.ok(result.stdout.trim());
  const report=JSON.parse(result.stdout);
  assert.equal(report.ok,false);assert.equal(report.stage,'metadata');assert.equal(report.status,403);assert.equal(report.cfRay,'a4c8dae1ad56b8f0-ORD');assert.equal(report.cfMitigatedEnum,'challenge');assert.equal(report.serverEnum,'cloudflare');assert.equal(report.routeEnum,'missing');assert.equal(report.errorEnum,'http_status');assert.equal(report.service,'https://tools.brclio.com');
  assert.equal(report.bytes,0);assert.equal(report.segments,0);assert.equal(report.retryCount,0);assert.ok(Number.isFinite(report.durationMs));
  for(const forbidden of ['secret-html-body','203.0.113.77','private.example','fixture-secret','api.github.com','location','private-fixture','<html>'])assert.ok(!result.stdout.includes(forbidden),forbidden);
});

for(const failingStage of ['manifest','chunk'])test(`smoke reports safe headers and counters for ${failingStage} HTTP failures`,async()=>{
  let calls=0,report;const processFixture={argv:['node','verify-live.mjs'],env:{}};
  const fetchImpl=async(url)=>{
    calls++;const target=new URL(url).searchParams.get('url');
    if(target==='https://api.github.com/repos/Brclio/Brclio/releases/latest')return Response.json(release,{headers:{'X-Brclio-Route':'subscription-vless'}});
    if(target===base+'SHA256SUMS.txt'&&failingStage!=='manifest')return new Response(manifest,{headers:{'X-Brclio-Route':'subscription-vless'}});
    return new Response('203.0.113.77 secret-html-body',{status:403,headers:{'cf-ray':'a4c8dae1ad56b8f0-LHR','cf-mitigated':'challenge',server:'https://private.example/server','x-brclio-route':'https://private.example/route','location':'https://private.example/redirect'}});
  };
  await vm.runInNewContext(`(async()=>{${source}\n})()`,{assert,createHash,officialTarget,publicHTTPS,smokeResponseDiagnostic,smokeSegment:(url,options)=>smokeSegment(url,{...options,fetchImpl}),fetch:fetchImpl,process:processFixture,URL,Headers,AbortSignal,Uint8Array,TextDecoder,Date,console:{log:value=>{report=JSON.parse(value);}}});
  assert.equal(processFixture.exitCode,1);assert.equal(report.stage,failingStage);assert.equal(report.status,403);assert.equal(report.cfMitigatedEnum,'challenge');assert.equal(report.serverEnum,'other');assert.equal(report.routeEnum,'other');assert.equal(report.errorEnum,'http_status');assert.equal(report.retryCount,0);assert.equal(calls,failingStage==='manifest'?2:3);assert.ok(!JSON.stringify(report).includes('private.example'));assert.ok(!JSON.stringify(report).includes('203.0.113.77'));
});

for(const failure of ['persistent503','invalidETag'])test(`smoke keeps bounded recovery and safe failure JSON for ${failure}`,async()=>{
  let chunkCalls=0,report;const processFixture={argv:['node','verify-live.mjs'],env:{}};
  const fetchImpl=async(url)=>{
    const target=new URL(url).searchParams.get('url');
    if(target==='https://api.github.com/repos/Brclio/Brclio/releases/latest')return Response.json(release,{headers:{'X-Brclio-Route':'subscription-vless'}});
    if(target===base+'SHA256SUMS.txt')return new Response(manifest,{headers:{'X-Brclio-Route':'subscription-vless'}});
    chunkCalls++;
    if(failure==='persistent503')return new Response('<title>Worker exceeded resource limits</title>203.0.113.77 secret-html-body',{status:503,headers:{'cf-ray':'a4c8dae1ad56b8f0-AMS','cf-mitigated':'challenge',server:'cloudflare','content-type':'text/html'}});
    return new Response(new Uint8Array(3),{status:206,headers:{'X-Brclio-Route':'subscription-vless','Content-Range':'bytes 0-2/3','Content-Length':'3',ETag:'https://private.example/secret'}});
  };
  await vm.runInNewContext(`(async()=>{${source}\n})()`,{assert,createHash,officialTarget,publicHTTPS,smokeResponseDiagnostic,smokeSegment:(url,options)=>smokeSegment(url,{...options,fetchImpl,delay:async ms=>assert.equal(ms,500)}),fetch:fetchImpl,process:processFixture,URL,Headers,AbortSignal,Uint8Array,TextDecoder,Date,console:{log:value=>{report=JSON.parse(value);}}});
  assert.equal(processFixture.exitCode,1);assert.equal(report.stage,'chunk');assert.equal(report.bytes,0);assert.equal(report.segments,0);
  assert.equal(report.retryCount,failure==='persistent503'?1:0);assert.equal(chunkCalls,failure==='persistent503'?2:1);assert.equal(report.status,failure==='persistent503'?503:206);assert.equal(report.errorEnum,failure==='persistent503'?'http_status':'validation_failed');
  assert.equal(report.http503Diagnostics.length,failure==='persistent503'?2:0);
  if(failure==='persistent503'){assert.equal(report.http503Diagnostics[0].title,'Worker exceeded resource limits');assert.equal(report.http503Diagnostics[1].attempt,2);}
  for(const forbidden of ['private.example','secret-html-body','203.0.113.77','<title>'])assert.ok(!JSON.stringify(report).includes(forbidden));
});

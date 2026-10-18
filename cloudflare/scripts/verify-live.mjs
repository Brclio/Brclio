import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {officialTarget, publicHTTPS} from '../src/protocol.js';
import {smokeSegment, smokeResponseDiagnostic} from './smoke-segment.mjs';
const args=process.argv.slice(2);
const requestHeaders={'User-Agent':'Brclio-Updater/1.0'};
const origin=args.find(arg=>arg.startsWith('https://'))||process.env.BRCLIO_CLIENT_SERVICE_URL||process.env.BRCLIO_UPDATE_SERVICE_URL||'https://tools.brclio.com';
const started=Date.now();
let service,activeResponse;
const progress={stage:'setup',bytes:0,segments:0,retryCount:0,maxSegmentMs:0};
const http503Diagnostics=[],redirectCacheCounts={hit:0,miss:0,refreshed:0,unknown:0};
const emptyDiagnostic=()=>({status:null,cfRay:null,cfMitigatedEnum:null,serverEnum:'missing',routeEnum:'missing'});
let responseDiagnostic=emptyDiagnostic(),errorEnum='invalid_service_origin';
function stage(name){progress.stage=name;activeResponse=undefined;responseDiagnostic=emptyDiagnostic();errorEnum=null;}
function inspectResponse(response,expectedStatus){activeResponse=response;responseDiagnostic=smokeResponseDiagnostic(response);if(response.status!==expectedStatus)errorEnum='http_status';}
function networkFailure(error){return ['AbortError','TimeoutError'].includes(error?.name)?'timeout_or_cancelled':'network_failed';}
function publicServiceOrigin(){try{return publicHTTPS(service.origin).origin;}catch{return null;}}
const through=target=>{officialTarget(target);const url=new URL('/api/update',service);url.searchParams.set('url',target);return url;};
async function proxied(target){
  let response;
  try{response=await fetch(through(target),{signal:AbortSignal.timeout(20000),headers:requestHeaders});}catch(error){errorEnum=networkFailure(error);throw error;}
  inspectResponse(response,200);
  assert.equal(response.status,200,'Proxy request returned an unexpected HTTP status');
  assert.equal(response.headers.get('x-brclio-route'),'subscription-vless');return response;
}
async function boundedBytes(response,limit){
  const reader=response.body.getReader();const chunks=[];let size=0;
  try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;assert.ok(size<=limit,'Checksum manifest exceeds allowed size');chunks.push(next.value);}}finally{await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
async function verify(){
assert.ok(origin,'Pass the confirmed custom-domain origin or set BRCLIO_CLIENT_SERVICE_URL');
service=new URL(origin);assert.equal(service.protocol,'https:');errorEnum=null;
stage('metadata');
const release=await (await proxied('https://api.github.com/repos/Brclio/Brclio/releases/latest')).json();
assert.match(release.tag_name,/^v?\d+\.\d+\.\d+/);
const candidates=release.assets.filter(asset=>asset.name!=='SHA256SUMS.txt'&&(!args.includes('--large')||asset.size>100*1024*1024)).sort((a,b)=>a.size-b.size);
assert.ok(candidates.length,'No suitable official release installer');
const asset=candidates[0];assert.match(asset.digest,/^sha256:[0-9a-f]{64}$/);
const manifests=release.assets.filter(asset=>asset.name==='SHA256SUMS.txt');assert.equal(manifests.length,1,'Expected exactly one official checksum manifest');
const manifest=manifests[0];assert.ok(Number.isSafeInteger(manifest.size)&&manifest.size>0&&manifest.size<=64*1024,'Invalid checksum manifest size');
assert.match(manifest.digest,/^sha256:[0-9a-f]{64}$/);
stage('manifest');
const manifestResponse=await proxied(manifest.browser_download_url);
const manifestBytes=await boundedBytes(manifestResponse,64*1024);assert.equal(manifestBytes.length,manifest.size);
assert.equal('sha256:'+createHash('sha256').update(manifestBytes).digest('hex'),manifest.digest,'Checksum manifest differs from GitHub metadata');
const lines=new TextDecoder('utf-8',{fatal:true}).decode(manifestBytes).replace(/^\uFEFF/,'').split(/\r?\n/).filter(Boolean);
const entries=lines.map(line=>{const match=/^([0-9a-fA-F]{64})[ \t]+\*?([^\r\n]+)$/.exec(line);assert.ok(match,'Invalid checksum manifest line');return {hash:match[1].toLowerCase(),name:match[2]};});
const selected=entries.filter(entry=>entry.name===asset.name);assert.equal(selected.length,1,'Expected exactly one checksum line for selected installer');
assert.equal('sha256:'+selected[0].hash,asset.digest,'Installer metadata and checksum manifest disagree');
const hash=createHash('sha256');let etag;const chunkBytes=128*1024;
while(progress.bytes<asset.size){
  stage('chunk');
  const start=progress.bytes,end=Math.min(asset.size-1,start+chunkBytes-1),segmentStarted=Date.now();
  let fetched;
  try{fetched=await smokeSegment(through(asset.browser_download_url),{signal:AbortSignal.timeout(20000),headers:{...requestHeaders,Range:`bytes=${start}-${end}`,...(etag?{'If-Range':etag}:{})}});}
  catch(error){progress.retryCount+=error.segmentRetryCount||0;http503Diagnostics.push(...(error.http503Diagnostics||[]).map(item=>({...item,start,end})));errorEnum=networkFailure(error);throw error;}
  const response=fetched.response;progress.retryCount+=fetched.retryCount;http503Diagnostics.push(...fetched.diagnostics.map(item=>({...item,start,end})));inspectResponse(response,206);
  assert.equal(response.status,206,'Installer segment returned an unexpected HTTP status');assert.equal(response.headers.get('x-brclio-route'),'subscription-vless');
  const cache=response.headers.get('x-brclio-redirect-cache');redirectCacheCounts[Object.hasOwn(redirectCacheCounts,cache)?cache:'unknown']++;
  assert.equal(response.headers.get('content-range'),`bytes ${start}-${end}/${asset.size}`);assert.equal(response.headers.get('content-length'),String(end-start+1));
  const currentETag=response.headers.get('etag');assert.match(currentETag||'',/^"[\x21\x23-\x7e]{1,256}"$/);assert.ok(!response.headers.has('content-encoding')||response.headers.get('content-encoding')==='identity');
  if(etag)assert.equal(currentETag,etag);else etag=currentETag;
  const chunk=await boundedBytes(response,end-start+1);assert.equal(chunk.length,end-start+1);progress.bytes+=chunk.length;hash.update(chunk);progress.segments++;progress.maxSegmentMs=Math.max(progress.maxSegmentMs,Date.now()-segmentStarted);
}
assert.equal(progress.bytes,asset.size);const digest=hash.digest('hex');assert.equal(`sha256:${digest}`,asset.digest);assert.equal(digest,selected[0].hash);
return {ok:true,service:publicServiceOrigin(),release:release.tag_name,asset:asset.name,bytes:progress.bytes,sha256:digest,manifestVerified:true,downloadMode:'serial-verified-128KiB-ranges',segments:progress.segments,strongETagVerified:true,maxSegmentMs:progress.maxSegmentMs,retryCount:progress.retryCount,http503Diagnostics,redirectCacheCounts,durationMs:Date.now()-started};
}
try{console.log(JSON.stringify(await verify(),null,2));}
catch(error){
  await activeResponse?.body?.cancel().catch(()=>{});
  const fallback=['AbortError','TimeoutError'].includes(error?.name)?'timeout_or_cancelled':error?.name==='SyntaxError'?'invalid_json':error?.code==='ERR_ASSERTION'?'validation_failed':'unexpected_error';
  console.log(JSON.stringify({ok:false,service:publicServiceOrigin(),...progress,...responseDiagnostic,errorEnum:errorEnum||fallback,http503Diagnostics,redirectCacheCounts,durationMs:Date.now()-started},null,2));
  process.exitCode=1;
}

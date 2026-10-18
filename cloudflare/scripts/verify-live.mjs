import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {officialTarget} from '../src/protocol.js';
import {smokeSegment} from './smoke-segment.mjs';
const args=process.argv.slice(2);
const origin=args.find(arg=>arg.startsWith('https://'))||process.env.BRCLIO_CLIENT_SERVICE_URL||process.env.BRCLIO_UPDATE_SERVICE_URL||'https://tools.brclio.com';
assert.ok(origin,'Pass the confirmed custom-domain origin or set BRCLIO_CLIENT_SERVICE_URL');
const service=new URL(origin);
assert.equal(service.protocol,'https:');
const through=target=>{officialTarget(target);const url=new URL('/api/update',service);url.searchParams.set('url',target);return url;};
async function proxied(target){const response=await fetch(through(target),{signal:AbortSignal.timeout(20000)});assert.equal(response.status,200,`Proxy request failed with HTTP ${response.status}`);assert.equal(response.headers.get('x-brclio-route'),'subscription-vless');return response;}
async function boundedBytes(response,limit){
  const reader=response.body.getReader();const chunks=[];let size=0;
  try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;assert.ok(size<=limit,'Checksum manifest exceeds allowed size');chunks.push(next.value);}}finally{await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
const started=Date.now();
const release=await (await proxied('https://api.github.com/repos/Brclio/Brclio/releases/latest')).json();
assert.match(release.tag_name,/^v?\d+\.\d+\.\d+/);
const candidates=release.assets.filter(asset=>asset.name!=='SHA256SUMS.txt'&&(!args.includes('--large')||asset.size>100*1024*1024)).sort((a,b)=>a.size-b.size);
assert.ok(candidates.length,'No suitable official release installer');
const asset=candidates[0];assert.match(asset.digest,/^sha256:[0-9a-f]{64}$/);
const manifests=release.assets.filter(asset=>asset.name==='SHA256SUMS.txt');assert.equal(manifests.length,1,'Expected exactly one official checksum manifest');
const manifest=manifests[0];assert.ok(Number.isSafeInteger(manifest.size)&&manifest.size>0&&manifest.size<=64*1024,'Invalid checksum manifest size');
assert.match(manifest.digest,/^sha256:[0-9a-f]{64}$/);
const manifestResponse=await proxied(manifest.browser_download_url);
const manifestBytes=await boundedBytes(manifestResponse,64*1024);assert.equal(manifestBytes.length,manifest.size);
assert.equal('sha256:'+createHash('sha256').update(manifestBytes).digest('hex'),manifest.digest,'Checksum manifest differs from GitHub metadata');
const lines=new TextDecoder('utf-8',{fatal:true}).decode(manifestBytes).replace(/^\uFEFF/,'').split(/\r?\n/).filter(Boolean);
const entries=lines.map(line=>{const match=/^([0-9a-fA-F]{64})[ \t]+\*?([^\r\n]+)$/.exec(line);assert.ok(match,'Invalid checksum manifest line');return {hash:match[1].toLowerCase(),name:match[2]};});
const selected=entries.filter(entry=>entry.name===asset.name);assert.equal(selected.length,1,'Expected exactly one checksum line for selected installer');
assert.equal('sha256:'+selected[0].hash,asset.digest,'Installer metadata and checksum manifest disagree');
const hash=createHash('sha256');let bytes=0,segments=0,etag,maxSegmentMs=0,retryCount=0;const chunkBytes=1024*1024,http503Diagnostics=[];
try{while(bytes<asset.size){
  const start=bytes,end=Math.min(asset.size-1,start+chunkBytes-1),segmentStarted=Date.now();
  const fetched=await smokeSegment(through(asset.browser_download_url),{signal:AbortSignal.timeout(20000),headers:{Range:`bytes=${start}-${end}`,...(etag?{'If-Range':etag}:{})}});
  const response=fetched.response;retryCount+=fetched.retryCount;http503Diagnostics.push(...fetched.diagnostics.map(item=>({...item,start,end})));
  assert.equal(response.status,206,`Installer segment failed with HTTP ${response.status}`);assert.equal(response.headers.get('x-brclio-route'),'subscription-vless');
  assert.equal(response.headers.get('content-range'),`bytes ${start}-${end}/${asset.size}`);assert.equal(response.headers.get('content-length'),String(end-start+1));
  const currentETag=response.headers.get('etag');assert.match(currentETag||'',/^"[\x21\x23-\x7e]{1,256}"$/);assert.ok(!response.headers.has('content-encoding')||response.headers.get('content-encoding')==='identity');
  if(etag)assert.equal(currentETag,etag);else etag=currentETag;
  const chunk=await boundedBytes(response,end-start+1);assert.equal(chunk.length,end-start+1);bytes+=chunk.length;hash.update(chunk);segments++;maxSegmentMs=Math.max(maxSegmentMs,Date.now()-segmentStarted);
}}catch(error){error.segmentRetryCount=retryCount+(error.segmentRetryCount||0);error.http503Diagnostics=[...http503Diagnostics,...(error.http503Diagnostics||[])];throw error;}
assert.equal(bytes,asset.size);const digest=hash.digest('hex');assert.equal(`sha256:${digest}`,asset.digest);assert.equal(digest,selected[0].hash);
console.log(JSON.stringify({ok:true,service:service.origin,release:release.tag_name,asset:asset.name,bytes,sha256:digest,manifestVerified:true,downloadMode:'serial-verified-1MiB-ranges',segments,strongETagVerified:true,maxSegmentMs,retryCount,http503Diagnostics,durationMs:Date.now()-started},null,2));

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {officialTarget} from '../src/protocol.js';
const args=process.argv.slice(2);
const origin=args.find(arg=>arg.startsWith('https://'))||process.env.BRCLIO_CLIENT_SERVICE_URL||process.env.BRCLIO_UPDATE_SERVICE_URL||'https://client.brclio.com';
assert.ok(origin,'Pass the confirmed custom-domain origin or set BRCLIO_CLIENT_SERVICE_URL');
const service=new URL(origin);
assert.equal(service.protocol,'https:');
const through=target=>{officialTarget(target);const url=new URL('/api/update',service);url.searchParams.set('url',target);return url;};
async function proxied(target){const response=await fetch(through(target));assert.equal(response.status,200,`Proxy request failed with HTTP ${response.status}`);assert.equal(response.headers.get('x-brclio-route'),'subscription-vless');return response;}
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
const response=await proxied(asset.browser_download_url);assert.equal(Number(response.headers.get('content-length')),asset.size);
const hash=createHash('sha256');let bytes=0;const reader=response.body.getReader();
while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;assert.ok(bytes<=asset.size,'Unexpected installer length');hash.update(chunk.value);}
assert.equal(bytes,asset.size);const digest=hash.digest('hex');assert.equal(`sha256:${digest}`,asset.digest);assert.equal(digest,selected[0].hash);
console.log(JSON.stringify({ok:true,service:service.origin,release:release.tag_name,asset:asset.name,bytes,sha256:digest,manifestVerified:true,durationMs:Date.now()-started},null,2));

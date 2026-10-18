import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {officialTarget} from '../src/protocol.js';
import {smokeSegment} from '../scripts/smoke-segment.mjs';

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
  await vm.runInNewContext(`(async()=>{${source}\n})()`,{assert,createHash,officialTarget,smokeSegment:(url,options)=>smokeSegment(url,{...options,fetchImpl,delay:async ms=>assert.equal(ms,500)}),fetch:fetchImpl,process:{argv:['node','verify-live.mjs',...(large?['--large']:[])],env:{}},URL,Headers,AbortSignal,Uint8Array,TextDecoder,Date,console:{log:value=>{report=JSON.parse(value);}}});
  assert.equal(report.ok,true);assert.equal(report.asset,selected.name);assert.equal(report.bytes,selected.size);assert.equal(report.retryCount,1);
  assert.equal(calls.length,report.segments+3);assert.equal(calls[0].range,null);assert.equal(calls[1].range,null);
  assert.deepEqual(calls[2],calls[3]);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {relayUpdate,requestWithFailover,SEGMENT_BYTES} from '../src/relay.js';
const nodes=[{name:'one'},{name:'two'},{name:'three'},{name:'four'}];
const official='https://github.com/Brclio/Brclio/releases/download/v0.1.9/Brclio.dmg';
const signed='https://release-assets.githubusercontent.com/github-production-release-asset/123/abcdef?signature=test';
function response(body,status=200,headers={}){const r=new Response(body,{status,headers});return {body:r.body,status:r.status,headers:r.headers,close(){}};}
test('relay retries at most three subscribed nodes and never falls back to fetch',async()=>{
  const seen=[];await assert.rejects(()=>requestWithFailover(new URL(official),nodes,{transport:async(target,node)=>{seen.push(node.name);throw new Error('failed');}}),/内置代理/);assert.deepEqual(seen,['one','two','three']);
});
test('relay follows only a validated official redirect and serves complete range stream',async()=>{
  const total=SEGMENT_BYTES*2+37;const calls=[];
  const output=await relayUpdate(official,nodes,{transport:async(target,node,{range})=>{
    calls.push({target:target.href,range});
    if(target.hostname==='github.com')return response('',302,{location:signed});
    const match=/bytes=(\d+)-(\d+)/.exec(range);const start=+match[1],end=Math.min(+match[2],total-1);return response(new Uint8Array(end-start+1).fill(Math.floor(start/SEGMENT_BYTES)+1),206,{'content-range':`bytes ${start}-${end}/${total}`,'content-length':String(end-start+1),etag:'same','content-type':'application/octet-stream'});
  }});
  assert.equal(output.status,200);assert.equal(output.headers.get('content-length'),String(total));assert.equal(output.headers.get('content-range'),null);assert.equal(output.headers.get('x-brclio-route'),'subscription-vless');
  const data=new Uint8Array(await output.arrayBuffer());assert.equal(data.length,total);assert.equal(data[0],1);assert.equal(data[SEGMENT_BYTES],2);assert.equal(data.at(-1),3);assert.equal(calls.length,4);
});
test('range stream rejects changed artifact before delivering mismatched bytes',async()=>{
  let rangeNumber=0;
  const output=await relayUpdate(official,nodes,{transport:async(target,node,{range})=>{
    if(target.hostname==='github.com')return response('',302,{location:signed});
    const start=Number(/bytes=(\d+)/.exec(range)[1]),total=SEGMENT_BYTES+1,end=Math.min(start+SEGMENT_BYTES-1,total-1);
    return response(new Uint8Array(end-start+1),206,{'content-range':`bytes ${start}-${end}/${total}`,'content-length':String(end-start+1),etag:++rangeNumber===1?'original':'changed'});
  }});
  await assert.rejects(()=>output.arrayBuffer(),/发生变化/);
});
test('relay rejects hostile redirect before requesting it',async()=>{
  let calls=0;await assert.rejects(()=>relayUpdate(official,nodes,{transport:async()=>{calls++;return response('',302,{location:'https://evil.example/a'});}}),/重定向/);assert.equal(calls,1);
});
test('metadata remains JSON and bounded in size',async()=>{
  const result=await relayUpdate('https://api.github.com/repos/Brclio/Brclio/releases/latest',nodes,{transport:async()=>response('{"tag_name":"v0.1.9"}',200,{'content-type':'application/json'})});
  assert.deepEqual(await result.json(),{tag_name:'v0.1.9'});
});
test('canceling a segmented response aborts the active transport signal',async()=>{
  let transportSignal;
  const result=await relayUpdate(official,nodes,{transport:async(target,node,{signal})=>{
    transportSignal=signal;
    if(target.hostname==='github.com')return response('',302,{location:signed});
    return response(new Uint8Array(SEGMENT_BYTES),206,{'content-range':`bytes 0-${SEGMENT_BYTES-1}/${SEGMENT_BYTES+1}`,'content-length':String(SEGMENT_BYTES)});
  }});
  await result.body.cancel();assert.equal(transportSignal.aborted,true);
});
test('an already canceled relay makes no node attempts',async()=>{
  let calls=0;const abort=new AbortController();abort.abort();
  await assert.rejects(()=>relayUpdate(official,nodes,{signal:abort.signal,transport:async()=>{calls++;throw new Error('should not run');}}));assert.equal(calls,0);
});

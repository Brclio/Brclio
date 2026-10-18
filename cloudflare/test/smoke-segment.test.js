import {test} from 'node:test';
import assert from 'node:assert/strict';
import {smokeSegment} from '../scripts/smoke-segment.mjs';
test('smoke retries only one503 after500ms and records bounded safe diagnostics',async()=>{
  let calls=0;const delays=[];const signal=AbortSignal.timeout(1000),headers={'User-Agent':'Brclio-Updater/1.0',Range:'bytes=0-1'};
  const result=await smokeSegment('https://service.example/segment',{headers,signal,delay:async ms=>delays.push(ms),fetchImpl:async(_url,options)=>{calls++;assert.equal(options.signal,signal);assert.equal(options.headers,headers);assert.equal(new Headers(options.headers).get('user-agent'),'Brclio-Updater/1.0');return calls===1?new Response('<title>Worker exceeded resource limits</title>Error1102\n'+ '203.0.113.9'.repeat(1000),{status:503,headers:{'CF-Ray':'test-ray','Content-Type':'text/html','Server':'cloudflare','Content-Length':'9000'}}):new Response(new Uint8Array([1,2]),{status:206});}});
  assert.equal(result.response.status,206);assert.equal(calls,2);assert.deepEqual(delays,[500]);assert.equal(result.retryCount,1);assert.equal(result.diagnostics[0].sampledBytes,2048);assert.equal(result.diagnostics[0].errorCode,'1102');assert.equal(result.diagnostics[0].title,'Worker exceeded resource limits');assert.ok(!JSON.stringify(result.diagnostics).includes('203.0.113.9'));
});
test('persistent503 remains failed after two total attempts; other statuses never retry',async()=>{
  let calls=0;const result=await smokeSegment('https://service.example/segment',{delay:async()=>{},fetchImpl:async()=>{calls++;return new Response('<title>Service Unavailable</title>',{status:503});}});assert.equal(result.response.status,503);assert.equal(calls,2);assert.equal(result.retryCount,1);assert.equal(result.diagnostics.length,2);
  for(const status of[200,206,429,502]){let count=0;const output=await smokeSegment('https://service.example/segment',{fetchImpl:async()=>{count++;return new Response('',{status});},delay:async()=>assert.fail('must not delay')});assert.equal(count,1);assert.equal(output.retryCount,0);assert.equal(output.response.status,status);await output.response.body.cancel();}
});
test('aborted503 recovery opens no second request',async()=>{
  let calls=0;const controller=new AbortController();await assert.rejects(()=>smokeSegment('https://service.example/segment',{signal:controller.signal,fetchImpl:async()=>{calls++;return new Response('',{status:503});},delay:async()=>controller.abort()}));assert.equal(calls,1);
});

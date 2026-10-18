import {test} from 'node:test';import assert from 'node:assert/strict';
import {readSubscription} from '../src/config.js';
const subscription='proxies:\n  - type: vless\n    uuid: 00000000-0000-4000-8000-000000000001\n    server: route.example.com\n    servername: route.example.com\n    port: 443\n    tls: true\n    network: ws\n';
function delayedResponse(delay) {
 return async(_url,{signal})=>new Promise((resolve,reject)=>{
  const canceled=()=>{clearTimeout(timer);reject(signal.reason);};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',canceled);resolve(new Response(subscription));},delay);
  signal.addEventListener('abort',canceled,{once:true});if(signal.aborted)canceled();
 });
}
test('a cold subscription taking longer than five seconds can finish within its ten-second setup budget',async()=>{
 const started=Date.now();const nodes=await readSubscription('https://subscription.example/sub?token=private-test-marker',delayedResponse(5500));
 assert.equal(nodes.length,1);assert.ok(Date.now()-started>=5400);assert.ok(Date.now()-started<10000);
});
test('subscription setup times out at ten seconds and never exposes its private URL',async()=>{
 const started=Date.now();let failure;
 try{await readSubscription('https://subscription.example/sub?token=private-test-marker',delayedResponse(30000));}catch(error){failure=error;}
 assert.ok(failure);assert.match(failure.message,/无法读取代理订阅/);assert.ok(!failure.message.includes('private-test-marker'));assert.ok(!failure.message.includes('subscription.example'));
 const elapsed=Date.now()-started;assert.ok(elapsed>=9800);assert.ok(elapsed<12500);
});
